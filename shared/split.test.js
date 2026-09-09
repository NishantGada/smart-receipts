'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { splitItem, computeReceipt, toCents } = require('./split');

const A = 1, B = 2, C = 3;
const MEMBERS = [{ id: A, name: 'A' }, { id: B, name: 'B' }, { id: C, name: 'C' }];
const all = (v = 1) => [{ member_id: A, value: v }, { member_id: B, value: v }, { member_id: C, value: v }];
const amounts = (r) => r.splits.map((s) => s.amount_cents);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('equal split that divides cleanly', () => {
  const r = splitItem({ name: 'Item', total_price_cents: 900, mode: 'equal', entries: all() });
  assert.deepEqual(amounts(r), [300, 300, 300]);
  assert.deepEqual(r.errors, []);
});

test('equal split that does not divide cleanly still sums to the item price', () => {
  const r = splitItem({ name: 'Item', total_price_cents: 1000, mode: 'equal', entries: all() });
  assert.equal(sum(amounts(r)), 1000, 'no cent may be lost or invented');
  assert.deepEqual(amounts(r), [334, 333, 333]);
});

test('shares split — A takes 2 shares, B and C take 1 each', () => {
  const r = splitItem({
    name: 'Whole Milk', total_price_cents: 900, mode: 'shares',
    entries: [{ member_id: A, value: 2 }, { member_id: B, value: 1 }, { member_id: C, value: 1 }],
  });
  assert.deepEqual(amounts(r), [450, 225, 225]);
});

test('percent split 50/25/25 on an amount that cannot divide evenly', () => {
  const r = splitItem({
    name: 'Paneer', total_price_cents: 1798, mode: 'percent',
    entries: [{ member_id: A, value: 50 }, { member_id: B, value: 25 }, { member_id: C, value: 25 }],
  });
  assert.equal(sum(amounts(r)), 1798);
  assert.deepEqual(amounts(r), [899, 450, 449]);
});

test('percent split rejects percentages that do not total 100', () => {
  const r = splitItem({
    name: 'Tea', total_price_cents: 1598, mode: 'percent',
    entries: [{ member_id: A, value: 50 }, { member_id: B, value: 20 }, { member_id: C, value: 20 }],
  });
  assert.match(r.errors[0], /sum to 90\.00%, must be 100%/);
});

test('exact split accepts amounts that reconcile to the cent', () => {
  const r = splitItem({
    name: 'Dal', total_price_cents: 929, mode: 'exact',
    entries: [{ member_id: A, value: 4.29 }, { member_id: B, value: 2.5 }, { member_id: C, value: 2.5 }],
  });
  assert.deepEqual(amounts(r), [429, 250, 250]);
  assert.deepEqual(r.errors, []);
});

test('exact split reports the shortfall when amounts do not reconcile', () => {
  const r = splitItem({
    name: 'Dal', total_price_cents: 929, mode: 'exact',
    entries: [{ member_id: A, value: 4.0 }, { member_id: B, value: 2.5 }, { member_id: C, value: 2.5 }],
  });
  assert.match(r.errors[0], /sum to \$9\.00 but the item is \$9\.29 \(off by -\$0\.29\)/);
});

test('complimentary item costs nobody anything', () => {
  const r = splitItem({
    name: 'Vijay Peanut Spice Powder 175 g', total_price_cents: 0,
    status: 'complimentary', mode: 'equal', entries: all(),
  });
  assert.deepEqual(amounts(r), [0, 0, 0]);
  assert.equal(r.excluded, true);
  assert.deepEqual(r.errors, []);
});

test('refunded item costs nobody anything even when it had a price', () => {
  const r = splitItem({
    name: 'Returned Ghee', total_price_cents: 1249,
    status: 'refunded', mode: 'equal', entries: all(),
  });
  assert.deepEqual(amounts(r), [0, 0, 0]);
  assert.equal(r.excluded, true);
});

test('a $0 item left billable is flagged, not silently split', () => {
  const r = splitItem({ name: 'Mystery', total_price_cents: 0, mode: 'equal', entries: all() });
  assert.match(r.errors.join(' '), /priced \$0\.00 but marked billable/);
});

test('an item with nobody assigned is flagged', () => {
  const r = splitItem({ name: 'Orphan', total_price_cents: 500, mode: 'equal', entries: [] });
  assert.match(r.errors[0], /nobody assigned/);
});

// ---------------------------------------------------------------------------
// The real receipt from the session: 16 items, $113.03, tax 0, tip 0.
// ---------------------------------------------------------------------------
const REAL_ITEMS = [
  ['Laxmi Toor Dal, Split Pigeon Peas 4 lb', 9.29],
  ["Haldiram's Aloo Paratha Frozen Value Pack 1500 g", 12.99],
  ['Palak (Spinach 1 bunch)', 2.49],
  ['Bhindi (Indian Okra 0.9-1.1 lb)', 5.76],
  ['Lemon 1 Bag 2 lb', 2.99],
  ['Fresh Peeled Garlic 1 lb', 4.79],
  ['Brio 100% Sunflower Oil 33.8 fl.oz', 9.98],
  ['Maggi Masala Instant Noodles 9.8 oz', 3.29],
  ['Curry Leaves 0.25 oz', 0.99],
  ['Taj Mahal Tea 500 g', 15.98],
  ['Deep Mendu Vada 8pcs, Frozen 8.2 oz', 8.98],
  ['Dhaniya (Cilantro 1 bunch)', 6.45],
  ["Haldiram's Fresh Paneer (Indian Cheese) Frozen 360 g", 17.98],
  ['Vijay Idli and Dosa Batter 32 oz', 4.88],
  ['Laxmi Cashew Pieces 400 g', 6.19],
  ['Vijay Peanut Spice Powder 175 g', 0.0],
];

const realReceipt = (overrides = {}) => ({
  members: MEMBERS,
  printed: { subtotal_cents: 11303, total_cents: 11303, tax_cents: 0, tip_cents: 0 },
  items: REAL_ITEMS.map(([name, price], i) => ({
    position: i,
    name,
    total_price_cents: toCents(price),
    // the $0 line is the complimentary one
    status: price === 0 ? 'complimentary' : 'billable',
    mode: 'equal',
    entries: all(),
    ...(overrides[i] || {}),
  })),
});

test('real 16-item receipt splits three ways with no lost cents', () => {
  const r = computeReceipt(realReceipt());
  assert.deepEqual(r.errors, [], 'no errors expected');
  assert.deepEqual(r.warnings, [], 'should reconcile against the printed subtotal');
  assert.equal(r.totals.billable_items_cents, 11303);
  assert.equal(r.totals.billable_total_cents, 11303);
  assert.equal(r.totals.ocr_discrepancy_cents, 0);
  assert.equal(sum(r.perPerson.map((p) => p.total_cents)), 11303);
  assert.equal(r.perPerson.length, 3);
  // 11303 / 3 = 3767.67, so people land within a couple of cents of each other
  const spread = Math.max(...r.perPerson.map((p) => p.total_cents)) -
                 Math.min(...r.perPerson.map((p) => p.total_cents));
  assert.ok(spread <= 3, `spread was ${spread} cents`);
});

test('refunding a line drops it from the billable total but keeps the printed one', () => {
  // pretend the cashew pieces ($6.19) were returned
  const r = computeReceipt(realReceipt({ 14: { status: 'refunded' } }));
  assert.equal(r.totals.printed_subtotal_cents, 11303, 'paper total is untouched');
  assert.equal(r.totals.refunded_cents, 619);
  assert.equal(r.totals.billable_items_cents, 11303 - 619);
  assert.equal(r.totals.billable_total_cents, 10684);
  assert.equal(sum(r.perPerson.map((p) => p.total_cents)), 10684, 'nobody pays for the return');
  assert.deepEqual(r.errors, []);
});

test('mixed modes across one receipt still reconcile exactly', () => {
  const r = computeReceipt(realReceipt({
    9: { mode: 'shares', entries: [{ member_id: A, value: 2 }, { member_id: B, value: 1 }, { member_id: C, value: 1 }] },
    12: { mode: 'percent', entries: [{ member_id: A, value: 50 }, { member_id: B, value: 30 }, { member_id: C, value: 20 }] },
    1: { mode: 'exact', entries: [{ member_id: A, value: 5.0 }, { member_id: B, value: 4.99 }, { member_id: C, value: 3.0 }] },
    2: { mode: 'equal', entries: [{ member_id: B, value: 1 }] },
  }));
  assert.deepEqual(r.errors, []);
  assert.equal(sum(r.perPerson.map((p) => p.total_cents)), 11303);
});

test('tax and tip prorate by billable share and lose no cents', () => {
  const r = computeReceipt({
    members: MEMBERS,
    printed: { subtotal_cents: 3000, total_cents: 3457, tax_cents: 257, tip_cents: 200 },
    items: [
      { position: 0, name: 'Shared', total_price_cents: 2000, status: 'billable', mode: 'equal', entries: all() },
      { position: 1, name: 'A only', total_price_cents: 1000, status: 'billable', mode: 'equal', entries: [{ member_id: A, value: 1 }] },
    ],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.totals.billable_total_cents, 3457);
  assert.equal(sum(r.perPerson.map((p) => p.total_cents)), 3457);
  assert.equal(sum(r.perPerson.map((p) => p.tax_tip_cents)), 457, 'all tax+tip distributed');
  const a = r.perPerson.find((p) => p.member_id === A);
  assert.equal(a.subtotal_cents, 1667, 'A: 2000/3 + 1000');
});

test('OCR mismatch surfaces as a warning rather than silently passing', () => {
  const r = computeReceipt({
    members: MEMBERS,
    printed: { subtotal_cents: 11303, total_cents: 11303, tax_cents: 0, tip_cents: 0 },
    items: [{ position: 0, name: 'Only line OCR found', total_price_cents: 929, status: 'billable', mode: 'equal', entries: all() }],
  });
  assert.match(r.warnings.join(' '), /items sum to \$9\.29 but the receipt printed \$113\.03/);
});
