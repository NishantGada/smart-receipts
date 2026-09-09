'use strict';

const express = require('express');
const cors = require('cors');
const { query, tx, nameKeyExpr } = require('./db');
const { computeReceipt, toCents, toDollars, MODES, STATUSES } = require('../shared/split');

const app = express();
// receipts carry OCR JSON, not images, so this is generous but not huge
app.use(express.json({ limit: '8mb' }));
app.use(cors());

const PORT = Number(process.env.PORT || 8004);

// --- helpers ---------------------------------------------------------------

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

/** Uniform view of a member's money, in both cents and dollars, for the UI. */
const money = (cents) => ({ cents, dollars: toDollars(cents) });

// --- groups ----------------------------------------------------------------

app.get('/health', wrap(async (_req, res) => {
  const { rows } = await query('SELECT now() AS now');
  res.json({ ok: true, db: rows[0].now });
}));

app.get('/groups', wrap(async (_req, res) => {
  const { rows } = await query(`
    SELECT g.id, g.name, g.created_at,
           COALESCE(m.n, 0)::int AS member_count,
           COALESCE(r.n, 0)::int AS receipt_count
      FROM groups g
      LEFT JOIN (SELECT group_id, count(*) n FROM members  GROUP BY group_id) m ON m.group_id = g.id
      LEFT JOIN (SELECT group_id, count(*) n FROM receipts GROUP BY group_id) r ON r.group_id = g.id
     ORDER BY g.created_at
  `);
  res.json(rows);
}));

app.post('/groups', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'name is required');
  try {
    const { rows } = await query(
      'INSERT INTO groups (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );
    res.status(201).json({ ...rows[0], member_count: 0, receipt_count: 0 });
  } catch (err) {
    if (err.code === '23505') return bad(res, `a group named "${name}" already exists`, 409);
    if (err.code === '23514') return bad(res, 'group name cannot be blank');
    throw err;
  }
}));

app.delete('/groups/:id', wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM groups WHERE id = $1', [req.params.id]);
  if (!rowCount) return bad(res, 'group not found', 404);
  res.status(204).end();
}));

// --- members ---------------------------------------------------------------

app.get('/groups/:id/members', wrap(async (req, res) => {
  const { rows } = await query(
    'SELECT id, name, created_at FROM members WHERE group_id = $1 ORDER BY created_at, id',
    [req.params.id]
  );
  res.json(rows);
}));

app.post('/groups/:id/members', wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'name is required');
  const { rows: g } = await query('SELECT id FROM groups WHERE id = $1', [req.params.id]);
  if (!g.length) return bad(res, 'group not found', 404);
  try {
    const { rows } = await query(
      'INSERT INTO members (group_id, name) VALUES ($1, $2) RETURNING id, name, created_at',
      [req.params.id, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return bad(res, `"${name}" is already in this group`, 409);
    throw err;
  }
}));

app.delete('/members/:id', wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM members WHERE id = $1', [req.params.id]);
  if (!rowCount) return bad(res, 'member not found', 404);
  res.status(204).end();
}));

// --- receipts --------------------------------------------------------------

/**
 * Create a receipt from a Gemini OCR payload and hand back every item already
 * prefilled from this group's split memory. That prefill is the whole point:
 * a grocery run you have done before should arrive pre-answered.
 */
app.post('/groups/:id/receipts', wrap(async (req, res) => {
  const groupId = req.params.id;
  const ocr = req.body?.ocr;
  if (!ocr || !Array.isArray(ocr.items)) return bad(res, 'ocr.items is required');

  const { rows: members } = await query(
    'SELECT id, name FROM members WHERE group_id = $1 ORDER BY created_at, id',
    [groupId]
  );
  if (!members.length) return bad(res, 'add members to this group before uploading a receipt');

  const receipt = await tx(async (c) => {
    const { rows: r } = await c.query(
      `INSERT INTO receipts (group_id, label, currency, image_count,
                             printed_subtotal_cents, printed_tax_cents,
                             printed_tip_cents, printed_total_cents, ocr_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [
        groupId,
        req.body?.label || null,
        ocr.currency || 'USD',
        Number(req.body?.image_count || 0),
        toCents(ocr.subtotal),
        toCents(ocr.tax),
        toCents(ocr.tip),
        toCents(ocr.total),
        ocr,
      ]
    );
    const receiptId = r[0].id;

    const items = [];
    for (let i = 0; i < ocr.items.length; i++) {
      const it = ocr.items[i] || {};
      const name = String(it.name || `item ${i + 1}`).trim();
      const totalCents = toCents(it.totalPrice);
      // A $0 line defaults to complimentary — that is what it almost always is,
      // and the user can flip it to refunded or billable per item.
      const defaultStatus = totalCents === 0 ? 'complimentary' : 'billable';

      const { rows: ins } = await c.query(
        `INSERT INTO receipt_items
           (receipt_id, position, name, quantity, unit_price_cents, total_price_cents, status, mode)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, position, name, name_key, quantity, unit_price_cents, total_price_cents, status, mode`,
        [
          receiptId, i, name,
          Number(it.quantity) > 0 ? Number(it.quantity) : 1,
          toCents(it.unitPrice), totalCents,
          defaultStatus, null,
        ]
      );
      items.push(ins[0]);
    }
    return { id: receiptId, created_at: r[0].created_at, items };
  });

  const prefilled = [];
  for (const item of receipt.items) {
    prefilled.push(await withSuggestion(groupId, item, members));
  }

  res.status(201).json({
    receipt_id: receipt.id,
    created_at: receipt.created_at,
    members,
    printed: {
      subtotal: Number(ocr.subtotal || 0),
      tax: Number(ocr.tax || 0),
      tip: Number(ocr.tip || 0),
      total: Number(ocr.total || 0),
      currency: ocr.currency || 'USD',
    },
    items: prefilled,
  });
}));

/**
 * Add a line the OCR missed. Same shape as an extracted item, so the split
 * screen treats it identically — including memory prefill, since a hand-typed
 * "Whole Milk" should inherit however this group normally splits whole milk.
 */
app.post('/receipts/:id/items', wrap(async (req, res) => {
  const ctx = await loadReceiptContext(req.params.id);
  // Same wording and status as the delete path, so a client holding a stale
  // session gets one consistent message whatever it tries to do.
  if (!ctx) return bad(res, 'This receipt is no longer on the server. Scan it again to continue.', 410);

  const name = String(req.body?.name || '').trim();
  if (!name) return bad(res, 'name is required');

  const totalPrice = Number(req.body?.total_price);
  if (!Number.isFinite(totalPrice) || totalPrice < 0) {
    return bad(res, 'total_price must be a number of 0 or more');
  }
  const quantity = Number(req.body?.quantity) > 0 ? Number(req.body.quantity) : 1;
  const totalCents = toCents(totalPrice);
  const unitCents =
    req.body?.unit_price != null ? toCents(req.body.unit_price) : Math.round(totalCents / quantity);

  // Append after the last line. Positions need not be contiguous — deleting a
  // duplicate leaves a gap and nothing depends on them being dense.
  const nextPosition = ctx.items.reduce((max, i) => Math.max(max, i.position), -1) + 1;

  const { rows } = await query(
    `INSERT INTO receipt_items
       (receipt_id, position, name, quantity, unit_price_cents, total_price_cents, status, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)
     RETURNING id, position, name, name_key, quantity, unit_price_cents, total_price_cents, status, mode`,
    [
      ctx.id, nextPosition, name, quantity, unitCents, totalCents,
      totalCents === 0 ? 'complimentary' : 'billable',
    ]
  );

  const item = await withSuggestion(ctx.group_id, rows[0], ctx.members);
  res.status(201).json({ item: { ...item, manual: true } });
}));

/**
 * Drop a line — an OCR duplicate from overlapping photos, or a misread. Its
 * splits go with it via ON DELETE CASCADE. The receipt's printed_* totals are
 * left alone on purpose: they are what the paper said, and the reconciliation
 * warning comparing them to the remaining items is what surfaces the duplicate
 * in the first place.
 */
app.delete('/receipts/:receiptId/items/:itemId', wrap(async (req, res) => {
  // Distinguish "the whole receipt is gone" from "this line is already gone".
  // The first means the client is holding a dead session and needs to say so
  // plainly; the second is simply the outcome the caller asked for.
  const { rows: receipt } = await query('SELECT id FROM receipts WHERE id = $1', [
    req.params.receiptId,
  ]);
  if (!receipt.length) {
    return bad(res, 'This receipt is no longer on the server. Scan it again to continue.', 410);
  }

  const { rows } = await query(
    'SELECT id FROM receipt_items WHERE id = $1 AND receipt_id = $2',
    [req.params.itemId, req.params.receiptId]
  );
  // Already deleted: the end state the caller wanted already holds, so this is
  // a success, not an error. Removing an item should never fail twice.
  if (!rows.length) return res.status(204).end();

  const { rows: remaining } = await query(
    'SELECT count(*)::int AS n FROM receipt_items WHERE receipt_id = $1',
    [req.params.receiptId]
  );
  if (remaining[0].n <= 1) return bad(res, 'a receipt needs at least one item');

  await query('DELETE FROM receipt_items WHERE id = $1', [req.params.itemId]);
  res.status(204).end();
}));

/**
 * Preview a split without saving. Same engine as the save path, so what the
 * user sees on screen is exactly what gets written.
 */
app.post('/receipts/:id/preview', wrap(async (req, res) => {
  const ctx = await loadReceiptContext(req.params.id);
  if (!ctx) return bad(res, 'receipt not found', 404);
  const result = runSplit(ctx, req.body?.items);
  if (result.error) return bad(res, result.error);
  res.json(shapeSummary(result.computed, ctx));
}));

/**
 * Save the split. Writes item statuses/modes and per-person amounts, then
 * upserts this group's split memory so the same items arrive pre-answered next
 * time. Refunded and complimentary decisions are remembered too.
 */
app.put('/receipts/:id/splits', wrap(async (req, res) => {
  const ctx = await loadReceiptContext(req.params.id);
  if (!ctx) return bad(res, 'receipt not found', 404);

  const result = runSplit(ctx, req.body?.items);
  if (result.error) return bad(res, result.error);
  const { computed, byPosition } = result;

  if (!computed.valid && !req.body?.allow_invalid) {
    return res.status(422).json({
      error: 'split does not reconcile',
      errors: computed.errors,
      warnings: computed.warnings,
    });
  }

  await tx(async (c) => {
    for (const item of ctx.items) {
      const input = byPosition.get(item.position);
      if (!input) continue;

      await c.query('UPDATE receipt_items SET status = $1, mode = $2 WHERE id = $3', [
        input.status,
        input.status === 'billable' ? input.mode : null,
        item.id,
      ]);

      await c.query('DELETE FROM item_splits WHERE receipt_item_id = $1', [item.id]);

      const line = computed.perItem.find((p) => p.position === item.position);
      for (const s of line?.splits || []) {
        await c.query(
          `INSERT INTO item_splits (receipt_item_id, member_id, raw_value, amount_cents)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (receipt_item_id, member_id)
           DO UPDATE SET raw_value = EXCLUDED.raw_value, amount_cents = EXCLUDED.amount_cents`,
          [item.id, s.member_id, s.raw_value, s.amount_cents]
        );
      }

      // Only a real billable split teaches the memory anything. Refunding or
      // comping an item is something that happened on *this* trip, not how the
      // item is normally shared — writing it would wipe the useful split (buy
      // cashews 50/30/20 twice, return them once, and you would lose 50/30/20).
      // Statuses are still saved on the receipt itself, just above.
      if (input.status !== 'billable' || !(input.entries || []).length) continue;

      // Keyed on (group, item spelling) and simply overwritten: latest wins.
      await c.query(
        `INSERT INTO split_memory (group_id, display_name, mode, status, config)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (group_id, name_key) DO UPDATE
            SET mode         = EXCLUDED.mode,
                status       = EXCLUDED.status,
                config       = EXCLUDED.config,
                display_name = EXCLUDED.display_name,
                times_used   = split_memory.times_used + 1,
                updated_at   = now()`,
        [
          ctx.group_id,
          item.name,
          input.status === 'billable' ? input.mode : 'equal',
          input.status,
          JSON.stringify(
            (input.entries || []).map((e) => ({
              member_id: Number(e.member_id),
              value: Number(e.value),
            }))
          ),
        ]
      );
    }
  });

  res.json(shapeSummary(computed, ctx));
}));

app.get('/groups/:id/receipts', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.label, r.created_at, r.image_count, r.currency,
            r.printed_total_cents,
            COALESCE(SUM(s.amount_cents), 0)::bigint AS billable_cents,
            COUNT(DISTINCT ri.id)::int AS item_count,
            COUNT(DISTINCT ri.id) FILTER (WHERE ri.status = 'refunded')::int      AS refunded_count,
            COUNT(DISTINCT ri.id) FILTER (WHERE ri.status = 'complimentary')::int AS complimentary_count
       FROM receipts r
       LEFT JOIN receipt_items ri ON ri.receipt_id = r.id
       LEFT JOIN item_splits   s  ON s.receipt_item_id = ri.id
      WHERE r.group_id = $1
      GROUP BY r.id
      ORDER BY r.created_at DESC`,
    [req.params.id]
  );
  res.json(
    rows.map((r) => ({
      ...r,
      printed_total: toDollars(Number(r.printed_total_cents)),
      billable_total: toDollars(Number(r.billable_cents)),
    }))
  );
}));

app.get('/receipts/:id', wrap(async (req, res) => {
  const ctx = await loadReceiptContext(req.params.id);
  if (!ctx) return bad(res, 'receipt not found', 404);

  const { rows: splits } = await query(
    `SELECT s.receipt_item_id, s.member_id, s.raw_value, s.amount_cents, m.name
       FROM item_splits s
       JOIN members m ON m.id = s.member_id
       JOIN receipt_items ri ON ri.id = s.receipt_item_id
      WHERE ri.receipt_id = $1`,
    [req.params.id]
  );

  const byItem = new Map();
  for (const s of splits) {
    if (!byItem.has(String(s.receipt_item_id))) byItem.set(String(s.receipt_item_id), []);
    byItem.get(String(s.receipt_item_id)).push({
      member_id: s.member_id,
      name: s.name,
      raw_value: Number(s.raw_value),
      ...money(Number(s.amount_cents)),
    });
  }

  const perPerson = new Map();
  for (const s of splits) {
    const cur = perPerson.get(String(s.member_id)) || { member_id: s.member_id, name: s.name, cents: 0 };
    cur.cents += Number(s.amount_cents);
    perPerson.set(String(s.member_id), cur);
  }

  res.json({
    id: ctx.id,
    group_id: ctx.group_id,
    label: ctx.label,
    created_at: ctx.created_at,
    currency: ctx.currency,
    printed: {
      subtotal: toDollars(Number(ctx.printed_subtotal_cents)),
      tax: toDollars(Number(ctx.printed_tax_cents)),
      tip: toDollars(Number(ctx.printed_tip_cents)),
      total: toDollars(Number(ctx.printed_total_cents)),
    },
    members: ctx.members,
    items: ctx.items.map((i) => ({
      id: i.id,
      position: i.position,
      name: i.name,
      quantity: Number(i.quantity),
      total_price: toDollars(Number(i.total_price_cents)),
      status: i.status,
      mode: i.mode,
      splits: byItem.get(String(i.id)) || [],
    })),
    per_person: [...perPerson.values()]
      .map((p) => ({ member_id: p.member_id, name: p.name, ...money(p.cents) }))
      .sort((a, b) => b.cents - a.cents),
  });
}));

/** What this group remembers, so the user can audit and clear it. */
app.get('/groups/:id/memory', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT sm.id, sm.display_name, sm.name_key, sm.mode, sm.status,
            sm.config, sm.times_used, sm.updated_at
       FROM split_memory sm
      WHERE sm.group_id = $1
      ORDER BY sm.updated_at DESC`,
    [req.params.id]
  );
  res.json(rows);
}));

app.delete('/memory/:id', wrap(async (req, res) => {
  const { rowCount } = await query('DELETE FROM split_memory WHERE id = $1', [req.params.id]);
  if (!rowCount) return bad(res, 'memory entry not found', 404);
  res.status(204).end();
}));

// --- shared plumbing -------------------------------------------------------

/**
 * Attach this group's remembered split to an item, falling back to an equal
 * split across everyone. Used by both receipt upload and manual item entry so
 * the two paths cannot drift.
 */
async function withSuggestion(groupId, item, members) {
  const { rows: mem } = await query(
    `SELECT mode, status, config, times_used, updated_at
       FROM split_memory
      WHERE group_id = $1 AND name_key = ${nameKeyExpr('$2')}`,
    [groupId, item.name]
  );

  let suggestion = null;
  if (mem.length) {
    // Drop remembered members who have since left the group.
    const live = new Set(members.map((m) => String(m.id)));
    const entries = (mem[0].config || []).filter((e) => live.has(String(e.member_id)));
    if (entries.length) {
      suggestion = {
        mode: mem[0].mode,
        status: item.status === 'complimentary' ? item.status : mem[0].status,
        entries,
        source: 'memory',
        remembered_at: mem[0].updated_at,
        times_used: mem[0].times_used,
      };
    }
  }
  if (!suggestion) {
    suggestion = {
      mode: 'equal',
      status: item.status,
      entries: members.map((m) => ({ member_id: m.id, value: 1 })),
      source: 'default',
    };
  }

  return {
    ...item,
    total_price: toDollars(Number(item.total_price_cents)),
    unit_price: toDollars(Number(item.unit_price_cents)),
    suggested: suggestion,
  };
}

async function loadReceiptContext(receiptId) {
  const { rows: r } = await query('SELECT * FROM receipts WHERE id = $1', [receiptId]);
  if (!r.length) return null;
  const { rows: items } = await query(
    'SELECT * FROM receipt_items WHERE receipt_id = $1 ORDER BY position',
    [receiptId]
  );
  const { rows: members } = await query(
    'SELECT id, name FROM members WHERE group_id = $1 ORDER BY created_at, id',
    [r[0].group_id]
  );
  return { ...r[0], items, members };
}

/**
 * Validate the client payload and run the engine. Prices always come from the
 * DB, never from the request, so a client cannot restate what an item cost.
 */
function runSplit(ctx, rawItems) {
  if (!Array.isArray(rawItems)) return { error: 'items array is required' };

  const byPosition = new Map();
  const validMembers = new Set(ctx.members.map((m) => String(m.id)));

  for (const raw of rawItems) {
    const position = Number(raw?.position);
    if (!Number.isInteger(position)) return { error: 'each item needs an integer position' };

    const status = raw.status || 'billable';
    if (!STATUSES.includes(status)) return { error: `invalid status "${status}"` };

    const mode = raw.mode || 'equal';
    if (status === 'billable' && !MODES.includes(mode)) {
      return { error: `invalid split mode "${mode}"` };
    }

    for (const e of raw.entries || []) {
      if (!validMembers.has(String(e.member_id))) {
        return { error: `member ${e.member_id} is not in this group` };
      }
      if (Number(e.value) < 0) return { error: 'split values cannot be negative' };
    }
    byPosition.set(position, { status, mode, entries: raw.entries || [] });
  }

  const missing = ctx.items.filter((i) => !byPosition.has(i.position));
  if (missing.length) {
    return {
      error: `every item needs a decision — missing ${missing.length}: ` +
        missing.slice(0, 3).map((m) => `"${m.name}"`).join(', ') +
        (missing.length > 3 ? '…' : ''),
    };
  }

  const computed = computeReceipt({
    members: ctx.members,
    printed: {
      subtotal_cents: Number(ctx.printed_subtotal_cents),
      tax_cents: Number(ctx.printed_tax_cents),
      tip_cents: Number(ctx.printed_tip_cents),
      total_cents: Number(ctx.printed_total_cents),
    },
    items: ctx.items.map((i) => {
      const input = byPosition.get(i.position);
      return {
        position: i.position,
        name: i.name,
        total_price_cents: Number(i.total_price_cents),
        status: input.status,
        mode: input.mode,
        entries: input.entries,
      };
    }),
  });

  return { computed, byPosition };
}

function shapeSummary(computed, ctx) {
  const t = computed.totals;
  return {
    receipt_id: ctx.id,
    valid: computed.valid,
    errors: computed.errors,
    warnings: computed.warnings,
    totals: {
      printed_total: toDollars(t.printed_total_cents),
      printed_subtotal: toDollars(t.printed_subtotal_cents),
      tax: toDollars(t.tax_cents),
      tip: toDollars(t.tip_cents),
      billable_items: toDollars(t.billable_items_cents),
      refunded: toDollars(t.refunded_cents),
      complimentary: toDollars(t.complimentary_cents),
      billable_total: toDollars(t.billable_total_cents),
      ocr_discrepancy: toDollars(t.ocr_discrepancy_cents),
    },
    per_person: computed.perPerson.map((p) => ({
      member_id: p.member_id,
      name: p.name,
      subtotal: toDollars(p.subtotal_cents),
      tax_tip: toDollars(p.tax_tip_cents),
      total: toDollars(p.total_cents),
    })),
    per_item: computed.perItem.map((i) => ({
      position: i.position,
      name: i.name,
      status: i.status,
      mode: i.mode,
      total_price: toDollars(i.total_price_cents),
      splits: i.splits.map((s) => ({
        member_id: s.member_id,
        raw_value: s.raw_value,
        amount: toDollars(s.amount_cents),
      })),
    })),
  };
}

// --- error handling --------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('[smart-receipt]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`smart-receipt API on http://0.0.0.0:${PORT}`);
  });
}

module.exports = app;
