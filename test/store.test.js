import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../supabase/functions/solo-dnd/core/store.js';

// Fake PostgREST that behaves like Supabase: 201 + empty body for return=minimal inserts,
// PATCH honours id/rev filters and returns the matched rows for return=representation.
function fakePostgrest() {
  const rows = new Map();
  const events = [];
  const calls = [];
  const filter = (u, key) => u.searchParams.get(key)?.replace(/^eq\./, '');
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, headers: init.headers });
    if (u.pathname.endsWith('/app_config')) return new Response(JSON.stringify([{ value: 'k'.repeat(64) }]), { status: 200 });
    const id = filter(u, 'id');
    if (u.pathname.endsWith('/rpc/commit_campaign')) {
      // Same semantics as the SQL function: compare-and-set rev, append events, bump last_seq.
      const b = JSON.parse(init.body);
      const row = rows.get(b.p_id);
      if (!row || row.rev !== b.p_expected_rev) return new Response('null', { status: 200 });
      const evs = b.p_events ?? [];
      let seq = row.last_seq;
      for (const e of evs) events.push({ campaign_id: b.p_id, seq: ++seq, at: e.at, type: e.type, summary: e.summary, data: e.data });
      rows.set(b.p_id, { ...row, name: b.p_name, data: { ...b.p_data, rev: row.rev + 1, lastSeq: seq }, rev: row.rev + 1, last_seq: seq });
      return new Response(JSON.stringify({ rev: row.rev + 1, lastSeq: seq }), { status: 200 });
    }
    if (u.pathname.endsWith('/events')) {
      const after = Number(u.searchParams.get('seq').replace(/^gt\./, ''));
      const list = events.filter((e) => e.campaign_id === filter(u, 'campaign_id') && e.seq > after);
      return new Response(JSON.stringify(list), { status: 200 });
    }
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      if (rows.has(body.id)) return new Response('{"code":"23505"}', { status: 409 });
      rows.set(body.id, body);
      return new Response('', { status: 201 });
    }
    if (init.method === 'DELETE') {
      rows.delete(id);
      return new Response(null, { status: 204 });
    }
    const list = id ? [rows.get(id)].filter(Boolean) : [...rows.values()];
    return new Response(JSON.stringify(list.map((r) => ({ data: r.data, rev: r.rev, last_seq: r.last_seq }))), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('SupabaseStore round-trips through a PostgREST-like API', async () => {
  const { fetchImpl, calls } = fakePostgrest();
  const store = new SupabaseStore({ url: 'https://x.supabase.co/', serviceKey: 'sb_secret_abc', fetchImpl });
  const c = { id: 'cmp_1', name: 'T', updatedAt: new Date().toISOString(), hp: 3 };
  await store.create(c);
  const loaded = await store.get('cmp_1');
  assert.equal(loaded.rev, 0);
  assert.equal(loaded.hp, 3);
  const saved = await store.put({ ...loaded, hp: 5 }, loaded.rev, [{ type: 'hp', summary: 'ouch' }, { type: 'roll', summary: 'd20' }]);
  assert.deepEqual(saved, { rev: 1, lastSeq: 2 });
  const again = await store.get('cmp_1');
  assert.equal(again.hp, 5);
  assert.equal(again.rev, 1);
  assert.equal(again.lastSeq, 2);
  const evs = await store.getEvents('cmp_1');
  assert.deepEqual(evs.map((e) => [e.seq, e.type]), [[1, 'hp'], [2, 'roll']]);
  assert.equal((await store.list()).length, 1);
  await store.delete('cmp_1');
  assert.equal(await store.get('cmp_1'), null);
  assert.equal(await store.getAccessKey(), 'k'.repeat(64));
  assert.equal(calls[0].headers.apikey, 'sb_secret_abc');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('a save based on a stale revision is rejected, not applied', async () => {
  const { fetchImpl } = fakePostgrest();
  const store = new SupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'sb_secret_abc', fetchImpl });
  await store.create({ id: 'cmp_2', name: 'T', updatedAt: 'x', gold: 0 });
  const a = await store.get('cmp_2');
  const b = await store.get('cmp_2');
  await store.put({ ...a, gold: 10 }, a.rev);
  await assert.rejects(() => store.put({ ...b, gold: 99 }, b.rev), (e) => e.conflict === true);
  assert.equal((await store.get('cmp_2')).gold, 10);
});

test('legacy JWT service keys are also sent as Bearer', async () => {
  const { fetchImpl, calls } = fakePostgrest();
  const store = new SupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'eyJhbGciOi.test', fetchImpl });
  await store.list();
  assert.equal(calls[0].headers.authorization, 'Bearer eyJhbGciOi.test');
});
