// Business books for campaigns that run companies: money accounts, recurring lines, equity holdings and a fleet register.
// Pure functions on the campaign object; tools.js wraps them as MCP tools. Currencies are never converted.
import { bad, text, HttpError } from './game.js';

const KINDS = ['cash', 'term', 'reserve', 'receivable', 'liability', 'inventory', 'other'];

export function books(c) {
  c.finances = c.finances ?? { accounts: [], recurring: [], qualifications: [], asOf: null };
  c.holdings = c.holdings ?? [];
  c.fleet = c.fleet ?? [];
  return c;
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const key = (s) => String(s ?? '').trim().toLowerCase();

export function findAccount(c, id) {
  const k = key(id);
  const a = books(c).finances.accounts.find((x) => x.id === id || key(x.name) === k);
  if (!a) throw new HttpError(404, `No account "${id}". Accounts: ${c.finances.accounts.map((x) => x.id).join(', ') || 'none'}.`);
  return a;
}

function amountOf(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw bad(`"${name}" must be a number.`);
  return round(v);
}

/** Move money: a single-account posting, or a same-currency transfer between two accounts. */
export function postTransaction(c, a) {
  const reason = text(a.reason, 'reason', { required: true, max: 500 });
  const amount = amountOf(a.amount, 'amount');
  if (amount === 0) throw bad('"amount" cannot be 0.');
  const from = a.fromAccount ? findAccount(c, a.fromAccount) : null;
  const to = a.toAccount ? findAccount(c, a.toAccount) : null;
  const acct = a.account ? findAccount(c, a.account) : null;
  const changes = [];
  const apply = (x, delta) => {
    const before = x.balance;
    const after = round(before + delta);
    if (after < 0 && ['cash', 'term', 'reserve', 'inventory'].includes(x.kind) && !a.allowNegative) {
      throw bad(`${x.name} would go negative (${before} ${x.currency} ${delta >= 0 ? '+' : ''}${delta}). Check the amount or pass allowNegative.`);
    }
    x.balance = after;
    x.updatedAt = new Date().toISOString();
    changes.push({ account: x.id, name: x.name, currency: x.currency, before, after, delta });
  };
  if (acct) {
    if (from || to) throw bad('Use either "account" (single posting) or "fromAccount"/"toAccount" (transfer), not both.');
    apply(acct, amount);
  } else if (from && to) {
    if (amount < 0) throw bad('Transfer amounts are positive.');
    if (from.currency !== to.currency) throw bad(`Cross-currency transfer (${from.currency} → ${to.currency}) needs an agreed rate: post each side separately with the actual amounts, both with this reason.`);
    apply(from, -amount);
    apply(to, amount);
  } else {
    throw bad('Give "account", or both "fromAccount" and "toAccount".');
  }
  return { reason, changes };
}

export function upsertAccount(c, a) {
  books(c);
  const name = text(a.name, 'name', { max: 120 });
  const id = text(a.id, 'id', { max: 60 }) ?? (name ? key(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : undefined);
  if (!id) throw bad('Give "id" or "name".');
  let acct = c.finances.accounts.find((x) => x.id === id);
  const before = acct ? { ...acct } : null;
  if (!acct) {
    if (!name || !a.currency || a.balance === undefined) throw bad('A new account needs name, currency and balance.');
    acct = { id, name, owner: null, currency: null, kind: 'cash', balance: 0, status: 'reference', notes: null };
    c.finances.accounts.push(acct);
  }
  if (name) acct.name = name;
  if (a.owner !== undefined) acct.owner = text(a.owner, 'owner', { max: 120 }) ?? null;
  if (a.currency !== undefined) acct.currency = text(a.currency, 'currency', { required: true, max: 20 });
  if (a.kind !== undefined) {
    if (!KINDS.includes(a.kind)) throw bad(`"kind" must be one of ${KINDS.join(', ')}.`);
    acct.kind = a.kind;
  }
  if (a.balance !== undefined) acct.balance = amountOf(a.balance, 'balance');
  if (a.status !== undefined) acct.status = text(a.status, 'status', { max: 60 });
  if (a.notes !== undefined) acct.notes = text(a.notes, 'notes', { max: 1000 }) ?? null;
  acct.updatedAt = new Date().toISOString();
  return { before, after: acct };
}

export function setHolding(c, a) {
  books(c);
  const entity = text(a.entity, 'entity', { required: true, max: 160 });
  let h = c.holdings.find((x) => key(x.entity) === key(entity));
  const before = h ? structuredClone(h) : null;
  if (!h) {
    h = { entity, type: null, owners: [], notes: null };
    c.holdings.push(h);
  }
  if (a.type !== undefined) h.type = text(a.type, 'type', { max: 120 }) ?? null;
  if (a.owners !== undefined) {
    if (!Array.isArray(a.owners)) throw bad('"owners" must be a list of {owner, pct}.');
    const owners = a.owners.map((o, i) => {
      const pct = o.pct === null || o.pct === undefined ? null : amountOf(o.pct, `owners[${i}].pct`);
      if (pct !== null && (pct < 0 || pct > 100)) throw bad(`owners[${i}].pct must be 0-100.`);
      return { owner: text(o.owner, `owners[${i}].owner`, { required: true, max: 160 }), pct, basis: text(o.basis, `owners[${i}].basis`, { max: 300 }) ?? null };
    });
    const total = owners.reduce((s, o) => s + (o.pct ?? 0), 0);
    if (total > 100.0001) throw bad(`Ownership adds up to ${total}%, more than 100%.`);
    h.owners = owners;
  }
  if (a.notes !== undefined) h.notes = text(a.notes, 'notes', { max: 1500 }) ?? null;
  return { before, after: h };
}

const SHIP_FIELDS = { name: 100, owner: 160, relationship: 120, status: 120, role: 200, location: 200, notes: 1500 };

export function findShip(c, id) {
  const k = key(id);
  return books(c).fleet.find((s) => key(s.designation) === k || key(s.name) === k);
}

export function updateShip(c, a) {
  const designation = text(a.designation, 'designation', { required: true, max: 60 });
  let s = findShip(c, designation);
  const before = s ? { ...s } : null;
  if (!s) {
    if (!a.create) throw new HttpError(404, `No ship "${designation}". Pass create: true to register a new hull.`);
    s = { designation, name: null, owner: null, relationship: null, status: null, role: null, location: null, notes: null };
    c.fleet.push(s);
  }
  for (const [k, max] of Object.entries(SHIP_FIELDS)) if (a[k] !== undefined) s[k] = text(a[k], k, { max }) ?? null;
  for (const k of ['crew', 'marines']) {
    if (a[k] !== undefined) {
      if (a[k] !== null && (!Number.isInteger(a[k]) || a[k] < 0)) throw bad(`"${k}" must be a whole number.`);
      s[k] = a[k];
    }
  }
  return { before, after: s };
}

/** Totals per currency and kind, without any conversion. */
export function totals(c) {
  const out = {};
  for (const a of books(c).finances.accounts) {
    out[a.currency] = out[a.currency] ?? {};
    out[a.currency][a.kind] = round((out[a.currency][a.kind] ?? 0) + a.balance);
  }
  return out;
}

export function fleetSummary(c) {
  const fleet = books(c).fleet;
  const by = (f) => fleet.reduce((m, s) => ((m[f(s) ?? 'unrecorded'] = (m[f(s) ?? 'unrecorded'] ?? 0) + 1), m), {});
  return { ships: fleet.length, byOwner: by((s) => s.owner), byStatus: by((s) => s.status) };
}

export function financeView(c, { full = true } = {}) {
  const f = books(c).finances;
  return {
    asOf: f.asOf,
    basis: f.basis ?? null,
    accounts: f.accounts.map((a) => ({ id: a.id, name: a.name, owner: a.owner, currency: a.currency, kind: a.kind, balance: a.balance, status: a.status, ...(full && a.notes ? { notes: a.notes } : {}) })),
    totalsByCurrency: totals(c),
    ...(full ? { recurring: f.recurring, qualifications: f.qualifications, holdings: c.holdings } : { holdings: c.holdings.length }),
  };
}

// ---------- markdown for the GitHub mirror ----------
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US', { maximumFractionDigits: 6 }) : String(n ?? ''));
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ');

export function renderFinances(c) {
  const f = books(c).finances;
  if (!f.accounts.length && !c.holdings.length) return null;
  const lines = [`# Finances and equity — ${c.name}`, '', `Live from the server. As of: ${f.asOf ?? 'unrecorded'}. ${f.basis ?? ''}`, '', '## Accounts', '',
    '| Account | Owner | Kind | Balance | Currency | Status |', '|---|---|---|---:|---|---|',
    ...f.accounts.map((a) => `| ${cell(a.name)} | ${cell(a.owner)} | ${a.kind} | ${fmt(a.balance)} | ${cell(a.currency)} | ${cell(a.status)} |`), ''];
  if (f.recurring?.length) lines.push('## Recurring lines (per cycle; posted only at closes)', '', ...f.recurring.map((r) => `- ${cell(r.name)}: ${fmt(r.amount)} ${cell(r.currency)} ${cell(r.per ?? '')}${r.note ? ` — ${cell(r.note)}` : ''}`), '');
  if (c.holdings.length) {
    lines.push('## Equity and ownership', '');
    for (const h of c.holdings) {
      lines.push(`- **${cell(h.entity)}**${h.type ? ` (${cell(h.type)})` : ''}: ${h.owners.map((o) => `${cell(o.owner)}${o.pct === null ? '' : ` ${fmt(o.pct)}%`}${o.basis ? ` [${cell(o.basis)}]` : ''}`).join('; ') || 'owners unrecorded'}${h.notes ? ` — ${cell(h.notes)}` : ''}`);
    }
    lines.push('');
  }
  if (f.qualifications?.length) lines.push('## Audit qualifications', '', ...f.qualifications.map((q) => `- ${cell(q)}`), '');
  return lines.join('\n');
}

export function renderFleet(c) {
  const fleet = books(c).fleet;
  if (!fleet.length) return null;
  const s = fleetSummary(c);
  return [`# Fleet register — ${c.name}`, '', `Live from the server: ${s.ships} entries.`, '',
    '| Designation | Name | Owner | Status | Role | Crew | Marines | Notes |', '|---|---|---|---|---|---:|---:|---|',
    ...fleet.map((x) => `| ${cell(x.designation)} | ${cell(x.name)} | ${cell(x.owner)} | ${cell(x.status)} | ${cell(x.role)} | ${x.crew ?? ''} | ${x.marines ?? ''} | ${cell(x.notes)} |`), ''].join('\n');
}
