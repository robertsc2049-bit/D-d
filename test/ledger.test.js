import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../supabase/functions/solo-dnd/core/tools.js';
import { MemoryStore } from '../supabase/functions/solo-dnd/core/store.js';
import { GitHub, syncCampaign } from '../supabase/functions/solo-dnd/core/mirror.js';
import { withDice, startServer, KEY } from './helpers.js';

/** Fake GitHub Git Data API that records commits and enforces fast-forward ref updates. */
function fakeGitHub() {
  let head = 'c0';
  const commits = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const p = u.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    const ok = (o) => new Response(JSON.stringify(o), { status: 200 });
    assert.match(init.headers.authorization, /^Bearer gh_test$/);
    if (init.method === 'GET' && p.endsWith('/git/ref/heads/main')) return ok({ object: { sha: head } });
    if (init.method === 'GET' && p.includes('/git/commits/')) return ok({ tree: { sha: `tree-of-${p.split('/').pop()}` } });
    if (init.method === 'POST' && p.endsWith('/git/trees')) return ok({ sha: `t${++n}`, files: body.tree });
    if (init.method === 'POST' && p.endsWith('/git/commits')) {
      const sha = `c${++n}`;
      commits.push({ sha, message: body.message, parents: body.parents, tree: body.tree });
      return ok({ sha });
    }
    if (init.method === 'PATCH' && p.endsWith('/git/refs/heads/main')) {
      const c = commits.find((x) => x.sha === body.sha);
      if (body.force !== false || c.parents[0] !== head) return new Response('{"message":"not fast forward"}', { status: 422 });
      head = body.sha;
      return ok({ object: { sha: head } });
    }
    return new Response('{}', { status: 404 });
  };
  const trees = [];
  const wrapped = async (url, init) => {
    if (init.method === 'POST' && url.endsWith('/git/trees')) trees.push(JSON.parse(init.body).tree);
    return fetchImpl(url, init);
  };
  return { github: new GitHub({ token: 'gh_test', fetchImpl: wrapped }), commits, trees, head: () => head };
}

async function setup({ mirror = false } = {}) {
  const store = new MemoryStore();
  const gh = fakeGitHub();
  const ctx = { store, github: gh.github };
  const ok = async (name, args) => {
    const r = await callTool(name, args, ctx);
    assert.ok(r.ok, `${name}: ${r.error}`);
    return r.data;
  };
  const camp = await ok('createCampaign', { name: 'Ledger Test' });
  if (mirror) {
    const c = await store.get(camp.id);
    c.mirror = { repo: 'me/dungeons', branch: 'main', path: 'campaigns/st/live' };
    await store.put(c, c.rev);
  }
  await ok('createCharacter', { campaignId: camp.id, name: 'Elias', class: 'rogue', level: 18, abilityScores: { str: 8, dex: 20, con: 12, int: 12, wis: 10, cha: 20 }, expertise: ['insight'] });
  return { store, ctx, ok, id: camp.id, gh };
}

test('every state change is written to the ledger as it happens, numbered without gaps', async () => {
  const { store, ok, id } = await setup();
  await withDice(15, () => ok('makeCheck', { campaignId: id, kind: 'skill', skill: 'insight', dc: 20, reason: 'read the councillor' }));
  await ok('changeHp', { campaignId: id, type: 'damage', amount: 7, reason: 'disruptor graze' });
  await ok('manageInventory', { campaignId: id, action: 'add', name: 'Orthell data rod' });
  await ok('awardXp', { campaignId: id, amount: 1500, reason: 'convoy located' });
  const r = await ok('recordEvent', { campaignId: id, type: 'deal', summary: 'Orthell council authorises the 1.8bn offer; unsigned', amount: 1800000000, currency: 'SOC', unresolved: true, participants: ['Elias', 'Lysa'] });
  assert.match(r.ledger, /^recorded #\d+$/);

  const { events } = await ok('getLedger', { campaignId: id });
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  const types = events.map((e) => e.type);
  assert.deepEqual(types.slice(-5), ['check', 'hp', 'item', 'xp', 'deal']);
  assert.match(events.at(-5).summary, /Elias insight \(wis\) check \(read the councillor\): d20\(15\) \+\d+ = \d+ vs DC 20: success/);
  assert.match(events.at(-4).summary, /takes 7 \(disruptor graze\): HP \d+\/\d+/);
  assert.equal(events.at(-1).data.amount, 1800000000);
  assert.deepEqual(events.at(-1).data.participants, ['Elias', 'Lysa']);

  // A failed action writes nothing.
  const before = (await store.get(id)).lastSeq;
  const bad = await callTool('makeCheck', { campaignId: id, kind: 'skill', skill: 'juggling' }, { store });
  assert.equal(bad.ok, false);
  assert.equal((await store.get(id)).lastSeq, before);

  // Filtering finds what an XP audit needs.
  const xp = await ok('getLedger', { campaignId: id, types: ['xp', 'deal'] });
  assert.equal(xp.count, 2);
});

test('simultaneous actions produce exactly one ledger entry each (retries never duplicate)', async () => {
  const { store, ok, id } = await setup();
  const start = (await store.get(id)).lastSeq;
  await Promise.all(Array.from({ length: 6 }, (_, i) => ok('rollDice', { campaignId: id, expression: '1d20', reason: `roll ${i}` })));
  const { events } = await ok('getLedger', { campaignId: id, afterSeq: start });
  assert.equal(events.length, 6);
  assert.deepEqual(events.map((e) => e.summary.split(':')[0]).sort(), ['roll 0', 'roll 1', 'roll 2', 'roll 3', 'roll 4', 'roll 5']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6].map((x) => x + start));
});

test('time only moves through the clock tools, and every change is recorded', async () => {
  const { ok, ctx, id } = await setup();
  let h = await ok('getHandoff', { campaignId: id });
  assert.equal(h.campaign.clock, null);
  const noClock = await callTool('advanceTime', { campaignId: id, days: 1, reason: 'x' }, ctx);
  assert.match(noClock.error, /no clock/);
  await ok('setClock', { campaignId: id, day: 1, cycleLength: 28, verified: false, reason: 'seeded from repo: Day 1/28 ordered 2026-11-16, later play uncertified' });
  h = await ok('getHandoff', { campaignId: id });
  assert.match(h.clockWarning, /UNVERIFIED/);
  await ok('setClock', { campaignId: id, day: 3, reason: 'player confirmed Day 3/28' });
  const t = await ok('advanceTime', { campaignId: id, days: 2, hours: 18, reason: 'travel to Anubis' });
  assert.equal(t.clock.day, 5);
  const t2 = await ok('advanceTime', { campaignId: id, hours: 12, reason: 'escrow review' });
  assert.equal(t2.clock.day, 6);
  assert.equal(t2.clock.hour, 6);
  h = await ok('getHandoff', { campaignId: id });
  assert.equal(h.clockWarning, undefined);
  assert.equal(h.campaign.clock.label, 'Day 6/28 +6h');
  const timeEvents = (await ok('getLedger', { campaignId: id, types: ['time'] })).events;
  assert.equal(timeEvents.length, 4);
  assert.match(timeEvents.at(-1).summary, /escrow review\): Day 5\/28 \+18h → Day 6\/28 \+6h/);
});

test('advancing past the cycle close is refused unless explicitly allowed', async () => {
  const { ok, ctx, id } = await setup();
  await ok('setClock', { campaignId: id, day: 27, cycleLength: 28, reason: 'test' });
  const r = await callTool('advanceTime', { campaignId: id, days: 3, reason: 'voyage' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /cycle close/);
  const allowed = await ok('advanceTime', { campaignId: id, days: 3, reason: 'voyage', allowPastClose: true });
  assert.equal(allowed.clock.day, 30);
  assert.equal(allowed.closeDue, true);
});

test('handoff gives the exact live state for a new conversation', async () => {
  const { ok, id } = await setup();
  await ok('createCharacter', { campaignId: id, partyMember: true, name: 'Lysa Renn', class: 'rogue', level: 17, abilityScores: { str: 8, dex: 20, con: 14, int: 12, wis: 16, cha: 12 }, maxHp: 122 });
  await ok('changeHp', { campaignId: id, characterId: 'lysa-renn', type: 'damage', amount: 20 });
  await ok('checkpoint', { campaignId: id, summary: 'Council session ends; offer authorised, unsigned.', scene: 'Aboard Cruelty in orbit of Anubis; Lysa checking escrow.', location: 'Cruelty, Anubis orbit' });
  const h = await ok('getHandoff', { campaignId: id, recentEvents: 3 });
  assert.equal(h.campaign.scene, 'Aboard Cruelty in orbit of Anubis; Lysa checking escrow.');
  assert.equal(h.characters.find((c) => c.id === 'lysa-renn').hp, 102);
  assert.equal(h.recentEvents.length, 3);
  assert.equal(h.recentEvents.at(-1).type, 'checkpoint');
  assert.equal(h.mirror, null);
});

test('checkpoint mirrors state + ledger to GitHub in one fast-forward commit, and only new events', async () => {
  const { ok, id, gh, store, ctx } = await setup({ mirror: true });
  await ok('recordEvent', { campaignId: id, type: 'decision', summary: 'Elias delegates the judicial follow-up to Rusk and Dast.' });
  const cp = await ok('checkpoint', { campaignId: id, summary: 'Scene ends.', scene: 'Cruelty, Anubis orbit.' });
  assert.ok(cp.mirror.committed, JSON.stringify(cp.mirror));
  assert.equal(gh.commits.length, 1);
  assert.equal(gh.head(), cp.mirror.committed);
  const paths = gh.trees[0].map((f) => f.path).sort();
  const month = new Date().toISOString().slice(0, 7);
  assert.deepEqual(paths, [
    'campaigns/st/live/HANDOFF_LIVE.md', 'campaigns/st/live/README.md', 'campaigns/st/live/STATE.json', `campaigns/st/live/ledger/${month}.md`,
  ].sort());
  const ledgerFile = gh.trees[0].find((f) => f.path.endsWith(`${month}.md`)).content;
  assert.match(ledgerFile, /\*\*#\d+\*\* .* `decision` Elias delegates the judicial follow-up/);
  assert.match(ledgerFile, /`checkpoint` Scene ends\./);
  const state = JSON.parse(gh.trees[0].find((f) => f.path.endsWith('STATE.json')).content);
  assert.equal(state.mirror, undefined); // mirror config itself is not published
  assert.equal(state.scene, 'Cruelty, Anubis orbit.');

  // Nothing new → no commit.
  const again = await syncCampaign(store, id, ctx.github);
  assert.equal(again.upToDate, true);
  assert.equal(gh.commits.length, 1);

  // New events → second commit on top of the first.
  await ok('rollDice', { campaignId: id, expression: '2d6', reason: 'escrow audit' });
  const second = await syncCampaign(store, id, ctx.github);
  assert.ok(second.committed);
  assert.equal(gh.commits[1].parents[0], gh.commits[0].sha);
  const ms = await store.getMirrorState(id);
  assert.equal(ms.lastSeq, (await store.get(id)).lastSeq);
  assert.equal(ms.lastError, null);
});

test('a GitHub failure is recorded and retried later, never lost', async () => {
  const { ok, id, store } = await setup({ mirror: true });
  const broken = new GitHub({ token: 'x', fetchImpl: async () => new Response('{"message":"Bad credentials"}', { status: 401 }) });
  await ok('recordEvent', { campaignId: id, type: 'fact', summary: 'A fact.' });
  const r = await syncCampaign(store, id, broken);
  assert.match(r.error, /401/);
  const ms = await store.getMirrorState(id);
  assert.equal(ms.lastSeq, 0);
  assert.match(ms.lastError, /Bad credentials/);
});

test('the sync endpoint is hidden behind the key and pushes mirrored campaigns', async () => {
  const srv = await startServer();
  try {
    const wrong = await fetch(`${srv.base}/functions/v1/solo-dnd/sync/${'z'.repeat(64)}`, { method: 'POST' });
    assert.equal(wrong.status, 404);
    const res = await fetch(`${srv.base}/functions/v1/solo-dnd/sync/${KEY}`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).results, []);
  } finally {
    srv.server.close();
  }
});
