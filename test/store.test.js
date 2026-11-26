import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore } from '../supabase/functions/solo-dnd/core/store.js';

// Fake PostgREST: answers like Supabase does (201 + empty body for return=minimal writes).
function fakePostgrest() {
  const rows = new Map();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    calls.push({ method: init.method, path: u.pathname, headers: init.headers });
    const idEq = u.searchParams.get('id')?.replace(/^eq\./, '');
    if (u.pathname.endsWith('/app_config')) return new Response(JSON.stringify([{ value: 'k'.repeat(64) }]), { status: 200 });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      rows.set(body.id, body);
      return new Response('', { status: 201 });
    }
    if (init.method === 'DELETE') {
      rows.delete(idEq);
      return new Response(null, { status: 204 });
    }
    const list = idEq ? [rows.get(idEq)].filter(Boolean) : [...rows.values()];
    return new Response(JSON.stringify(list.map((r) => ({ data: r.data }))), { status: 200 });
  };
  return { fetchImpl, calls };
}

test('SupabaseStore round-trips through a PostgREST-like API', async () => {
  const { fetchImpl, calls } = fakePostgrest();
  const store = new SupabaseStore({ url: 'https://x.supabase.co/', serviceKey: 'sb_secret_abc', fetchImpl });
  const c = { id: 'cmp_1', name: 'T', updatedAt: new Date().toISOString(), hp: 3 };
  await store.put(c);
  assert.deepEqual(await store.get('cmp_1'), c);
  assert.equal((await store.list()).length, 1);
  await store.delete('cmp_1');
  assert.equal(await store.get('cmp_1'), null);
  assert.equal(await store.getAccessKey(), 'k'.repeat(64));
  assert.equal(calls[0].headers.apikey, 'sb_secret_abc');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('legacy JWT service keys are also sent as Bearer', async () => {
  const { fetchImpl, calls } = fakePostgrest();
  const store = new SupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'eyJhbGciOi.test', fetchImpl });
  await store.list();
  assert.equal(calls[0].headers.authorization, 'Bearer eyJhbGciOi.test');
});
