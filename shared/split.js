'use strict';

// Split engine. Pure functions, no DB, no I/O — so it can be tested directly.
//
// Every amount in and out of this module is integer cents. Dollars only exist
// at the UI edge. The old float math in App.js could drift a cent on a 5-way
// split; largest-remainder allocation here cannot: the per-person amounts for
// an item always sum to exactly the item's price.

const MODES = ['equal', 'shares', 'percent', 'exact'];
const STATUSES = ['billable', 'complimentary', 'refunded'];

const toCents = (dollars) => Math.round(Number(dollars || 0) * 100);
const toDollars = (cents) => Math.round(cents) / 100;

/**
 * Split `totalCents` across `weights` so the parts sum to exactly totalCents.
 * Largest-remainder method: floor everything, then hand the leftover cents to
 * the largest fractional remainders.
 *
 * `rotate` breaks ties. Without it, an even split of an odd amount always hands
 * the spare cent to whoever is first in the list — so across a 16-item grocery
 * receipt the same person quietly overpays every time. Callers pass the item's
 * position, which rotates the spare cent between people item by item. Ties are
 * the only thing rotated, so the largest-remainder result is unaffected and the
 * output stays deterministic for a given input.
 */
function allocateByWeights(totalCents, weights, rotate = 0) {
  const totalWeight = weights.reduce((s, w) => s + w.weight, 0);
  if (totalWeight <= 0) return weights.map((w) => ({ ...w, amount_cents: 0 }));

  const n = weights.length;
  const exact = weights.map((w, i) => {
    const ideal = (totalCents * w.weight) / totalWeight;
    const floor = Math.floor(ideal);
    // tie rank, rotated so the spare cent moves between people across items
    const rank = (((i - rotate) % n) + n) % n;
    return { ...w, i, rank, floor, remainder: ideal - floor };
  });

  let assigned = exact.reduce((s, e) => s + e.floor, 0);
  let leftover = totalCents - assigned;

  // Negative totals (a refund expressed as a negative line) floor away from
  // zero, so leftover can be negative. Walk the smallest remainders instead.
  const order = [...exact].sort((a, b) =>
    leftover >= 0 ? b.remainder - a.remainder || a.rank - b.rank
                  : a.remainder - b.remainder || a.rank - b.rank
  );
  const step = leftover >= 0 ? 1 : -1;
  for (let k = 0; leftover !== 0 && k < order.length * 2; k++) {
    order[k % order.length].floor += step;
    leftover -= step;
  }

  return exact
    .sort((a, b) => a.i - b.i)
    .map(({ i, rank, floor, remainder, ...rest }) => ({ ...rest, amount_cents: floor }));
}

/**
 * Resolve one item's split.
 *
 * item:    { name, total_price_cents, status, mode, entries: [{member_id, value}] }
 * Returns: { splits: [{member_id, raw_value, amount_cents}], errors: [], excluded }
 *
 * `value` means different things per mode, which is the whole point of having
 * four of them: share count, percent of the item, or exact dollars entered.
 */
function splitItem(item) {
  const errors = [];
  const rotate = Number(item.position) || 0;
  const status = item.status || 'billable';

  if (!STATUSES.includes(status)) {
    errors.push(`"${item.name}": unknown status "${status}"`);
    return { splits: [], errors, excluded: true };
  }

  // Refunded and complimentary items never cost anyone anything. They still
  // get stored, so history shows they were on the receipt and deliberately
  // zeroed rather than forgotten.
  if (status === 'refunded' || status === 'complimentary') {
    return {
      splits: (item.entries || []).map((e) => ({
        member_id: e.member_id,
        raw_value: 0,
        amount_cents: 0,
      })),
      errors,
      excluded: true,
    };
  }

  const total = Math.round(item.total_price_cents || 0);
  const mode = item.mode || 'equal';
  if (!MODES.includes(mode)) {
    errors.push(`"${item.name}": unknown split mode "${mode}"`);
    return { splits: [], errors, excluded: false };
  }

  // A billable $0 line is almost always a comped item the user has not
  // classified yet. Flag it rather than silently splitting nothing.
  if (total === 0) {
    errors.push(
      `"${item.name}": priced $0.00 but marked billable — mark it complimentary or refunded`
    );
  }

  const entries = (item.entries || []).filter(
    (e) => e && e.member_id != null && Number(e.value) > 0
  );

  if (entries.length === 0) {
    errors.push(`"${item.name}": nobody assigned`);
    return { splits: [], errors, excluded: false };
  }

  let splits;

  if (mode === 'exact') {
    // Entered in dollars per person; must reconcile to the item exactly.
    const cents = entries.map((e) => ({
      member_id: e.member_id,
      raw_value: Number(e.value),
      amount_cents: toCents(e.value),
    }));
    const sum = cents.reduce((s, c) => s + c.amount_cents, 0);
    if (sum !== total) {
      const delta = toDollars(sum - total);
      // keep the sign — "$0.29 short" and "$0.29 over" need to read differently
      const signed = `${delta < 0 ? '-' : '+'}$${Math.abs(delta).toFixed(2)}`;
      errors.push(
        `"${item.name}": exact amounts sum to $${toDollars(sum).toFixed(2)} but the item is ` +
          `$${toDollars(total).toFixed(2)} (off by ${signed})`
      );
    }
    splits = cents;
  } else if (mode === 'percent') {
    const sumPct = entries.reduce((s, e) => s + Number(e.value), 0);
    // Tolerate a hair of float noise from the UI, nothing more.
    if (Math.abs(sumPct - 100) > 0.01) {
      errors.push(
        `"${item.name}": percentages sum to ${sumPct.toFixed(2)}%, must be 100%`
      );
    }
    splits = allocateByWeights(
      total,
      entries.map((e) => ({ member_id: e.member_id, raw_value: Number(e.value), weight: Number(e.value) })),
      rotate
    );
  } else if (mode === 'shares') {
    splits = allocateByWeights(
      total,
      entries.map((e) => ({ member_id: e.member_id, raw_value: Number(e.value), weight: Number(e.value) })),
      rotate
    );
  } else {
    // equal — every listed member counts once, whatever value they were sent with
    splits = allocateByWeights(
      total,
      entries.map((e) => ({ member_id: e.member_id, raw_value: 1, weight: 1 })),
      rotate
    );
  }

  return { splits, errors, excluded: false };
}

/**
 * Resolve a whole receipt.
 *
 * Tax and tip are prorated across people by their share of the *billable*
 * subtotal, so a refunded item does not drag tax onto whoever would have had it.
 */
function computeReceipt({ items = [], members = [], printed = {} }) {
  const errors = [];
  const warnings = [];
  const perItem = [];
  const subtotalByMember = new Map();

  let billableCents = 0;
  let refundedCents = 0;
  let complimentaryCents = 0;

  for (const item of items) {
    const { splits, errors: itemErrors, excluded } = splitItem(item);
    errors.push(...itemErrors);

    const status = item.status || 'billable';
    const total = Math.round(item.total_price_cents || 0);
    if (status === 'refunded') refundedCents += total;
    else if (status === 'complimentary') complimentaryCents += total;
    else if (!excluded) billableCents += total;

    for (const s of splits) {
      subtotalByMember.set(
        s.member_id,
        (subtotalByMember.get(s.member_id) || 0) + s.amount_cents
      );
    }

    perItem.push({
      position: item.position,
      name: item.name,
      status,
      mode: status === 'billable' ? item.mode || 'equal' : null,
      total_price_cents: total,
      splits,
    });
  }

  const taxCents = Math.round(printed.tax_cents || 0);
  const tipCents = Math.round(printed.tip_cents || 0);
  const extraCents = taxCents + tipCents;

  const assignedSubtotal = [...subtotalByMember.values()].reduce((s, v) => s + v, 0);

  let extraByMember = new Map();
  if (extraCents !== 0 && assignedSubtotal > 0) {
    const alloc = allocateByWeights(
      extraCents,
      [...subtotalByMember.entries()].map(([member_id, cents]) => ({
        member_id,
        weight: cents,
      }))
    );
    extraByMember = new Map(alloc.map((a) => [a.member_id, a.amount_cents]));
  } else if (extraCents !== 0) {
    warnings.push(
      `$${toDollars(extraCents).toFixed(2)} of tax/tip could not be distributed — no billable items are assigned`
    );
  }

  const nameOf = new Map(members.map((m) => [String(m.id), m.name]));
  const perPerson = [...subtotalByMember.entries()]
    .map(([member_id, subtotal_cents]) => {
      const extra = extraByMember.get(member_id) || 0;
      return {
        member_id,
        name: nameOf.get(String(member_id)) || `member ${member_id}`,
        subtotal_cents,
        tax_tip_cents: extra,
        total_cents: subtotal_cents + extra,
      };
    })
    .sort((a, b) => b.total_cents - a.total_cents);

  const billableTotalCents = billableCents + extraCents;
  const perPersonSum = perPerson.reduce((s, p) => s + p.total_cents, 0);

  // Self-check: the split must account for every billable cent. If this ever
  // fires the bug is in this module, not in the user's data.
  if (perPersonSum !== billableTotalCents && errors.length === 0) {
    errors.push(
      `internal: per-person total $${toDollars(perPersonSum).toFixed(2)} != billable ` +
        `$${toDollars(billableTotalCents).toFixed(2)}`
    );
  }

  // Reconcile against the paper. Items + refunds + comps should equal what the
  // receipt printed as its subtotal; a gap means OCR dropped or invented a line.
  const printedSubtotal = Math.round(printed.subtotal_cents || 0);
  const accountedSubtotal = billableCents + refundedCents + complimentaryCents;
  const ocrDiscrepancyCents = accountedSubtotal - printedSubtotal;
  if (printedSubtotal > 0 && ocrDiscrepancyCents !== 0) {
    warnings.push(
      `items sum to $${toDollars(accountedSubtotal).toFixed(2)} but the receipt printed ` +
        `$${toDollars(printedSubtotal).toFixed(2)} as its subtotal ` +
        `(off by ${ocrDiscrepancyCents > 0 ? '+' : '-'}$${Math.abs(toDollars(ocrDiscrepancyCents)).toFixed(2)})`
    );
  }

  // Cross-check the total the user typed in against the one the model read.
  // These are two independent readings of the same number, so a disagreement
  // means the OCR misread something — which is exactly why both are stored.
  const statedTotalCents =
    printed.stated_total_cents == null ? null : Math.round(printed.stated_total_cents);
  const printedTotalCents = Math.round(printed.total_cents || 0);
  let statedDiscrepancyCents = null;
  if (statedTotalCents != null && printedTotalCents > 0) {
    statedDiscrepancyCents = printedTotalCents - statedTotalCents;
    if (statedDiscrepancyCents !== 0) {
      const sign = statedDiscrepancyCents > 0 ? '+' : '-';
      warnings.push(
        `you entered $${toDollars(statedTotalCents).toFixed(2)} as the total but the scan read ` +
          `$${toDollars(printedTotalCents).toFixed(2)} ` +
          `(off by ${sign}$${Math.abs(toDollars(statedDiscrepancyCents)).toFixed(2)}) — ` +
          `check the scanned lines`
      );
    }
  }

  return {
    perItem,
    perPerson,
    totals: {
      printed_subtotal_cents: printedSubtotal,
      printed_total_cents: printedTotalCents,
      stated_total_cents: statedTotalCents,
      stated_discrepancy_cents: statedDiscrepancyCents,
      tax_cents: taxCents,
      tip_cents: tipCents,
      billable_items_cents: billableCents,
      refunded_cents: refundedCents,
      complimentary_cents: complimentaryCents,
      billable_total_cents: billableTotalCents,
      ocr_discrepancy_cents: ocrDiscrepancyCents,
    },
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

module.exports = {
  MODES,
  STATUSES,
  toCents,
  toDollars,
  allocateByWeights,
  splitItem,
  computeReceipt,
};
