import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';
import { setDieRoller } from '../src/dice.js';

const KEY = 'test-key';
let server;
let base;

before(async () => {
  const app = createApp({ store: new Store(null), apiKey: KEY });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function call(method, path, body, { auth = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${KEY}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const withDice = async (value, fn) => {
  const restore = setDieRoller(typeof value === 'function' ? value : () => value);
  try {
    return await fn();
  } finally {
    restore();
  }
};

async function newCampaignWithHero() {
  const c = await call('POST', '/campaigns', { name: 'The Sunken Crown', tone: 'heroic' });
  assert.equal(c.status, 201);
  const ch = await call('PUT', `/campaigns/${c.body.id}/character`, {
    name: 'Mira',
    race: 'Half-Elf',
    class: 'Rogue',
    abilityScores: { str: 10, dex: 16, con: 14, int: 12, wis: 13, cha: 10 },
    armorClass: 14,
    skillProficiencies: ['Stealth', 'perception', 'sleight of hand'],
    expertise: ['stealth'],
    inventory: [{ name: 'Shortsword', notes: '1d6 piercing, finesse', equipped: true }],
    gold: 15,
  });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  return { id: c.body.id, character: ch.body };
}

test('public routes and auth', async () => {
  assert.equal((await call('GET', '/health', undefined, { auth: false })).status, 200);
  const spec = await call('GET', '/openapi.json', undefined, { auth: false });
  assert.equal(spec.status, 200);
  assert.equal((await call('GET', '/campaigns', undefined, { auth: false })).status, 401);
  assert.equal((await call('GET', '/campaigns')).status, 200);
});

test('openapi spec fits Custom GPT limits and matches routes', async () => {
  const { body: spec } = await call('GET', '/openapi.json', undefined, { auth: false });
  const ops = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const [method, o] of Object.entries(item)) {
      if (method === 'parameters') continue;
      ops.push(o.operationId);
      assert.ok(o.description.length <= 300, `${o.operationId} description too long`);
      // every documented route exists (anything but our 404 handler)
      const url = p.replace(/\{[^}]+\}/g, 'x');
      const r = await call(method.toUpperCase(), url, method === 'get' || method === 'delete' ? undefined : {});
      assert.ok(!(r.status === 404 && r.body.error?.startsWith('No route')), `${method} ${p} is not implemented`);
    }
  }
  assert.ok(ops.length <= 30, `too many operations: ${ops.length}`);
  assert.equal(new Set(ops).size, ops.length);
});

test('character creation computes derived stats', async () => {
  const { character } = await newCampaignWithHero();
  assert.equal(character.maxHp, 10); // d8 + 2 con
  assert.equal(character.derived.proficiencyBonus, 2);
  assert.equal(character.derived.skills.stealth, '+7'); // dex 3 + expertise 4
  assert.equal(character.derived.skills.sleight_of_hand, '+5');
  assert.equal(character.derived.savingThrows.dex, '+5'); // rogue saves
  assert.equal(character.derived.passivePerception, 13);
  assert.equal(character.inventory[0].name, 'Shortsword');
});

test('checks use the sheet', async () => {
  const { id } = await newCampaignWithHero();
  const r = await withDice(10, () => call('POST', `/campaigns/${id}/checks`, { kind: 'skill', skill: 'stealth', dc: 15 }));
  assert.equal(r.body.total, 17);
  assert.equal(r.body.success, true);
  const save = await withDice(5, () => call('POST', `/campaigns/${id}/checks`, { kind: 'save', ability: 'wis', dc: 12 }));
  assert.equal(save.body.total, 6);
  assert.equal(save.body.success, false);
  const bad = await call('POST', `/campaigns/${id}/checks`, { kind: 'skill', skill: 'flying' });
  assert.equal(bad.status, 400);
});

test('hp, dropping to zero, death saves and long rest', async () => {
  const { id } = await newCampaignWithHero();
  let r = await call('POST', `/campaigns/${id}/character/hp`, { type: 'temp', amount: 3 });
  r = await call('POST', `/campaigns/${id}/character/hp`, { type: 'damage', amount: 8 });
  assert.equal(r.body.after.hp, 5);
  r = await call('POST', `/campaigns/${id}/character/hp`, { type: 'damage', amount: 6 });
  assert.equal(r.body.after.hp, 0);
  assert.ok(r.body.conditions.includes('unconscious'));
  r = await withDice(3, () => call('POST', `/campaigns/${id}/checks`, { kind: 'death_save' }));
  assert.equal(r.body.deathSaves.failures, 1);
  r = await withDice(20, () => call('POST', `/campaigns/${id}/checks`, { kind: 'death_save' }));
  assert.equal(r.body.hp, 1);
  r = await call('POST', `/campaigns/${id}/character/rest`, { type: 'long' });
  assert.equal(r.body.hp, 10);
});

test('massive damage kills', async () => {
  const { id } = await newCampaignWithHero();
  const r = await call('POST', `/campaigns/${id}/character/hp`, { type: 'damage', amount: 25 });
  assert.equal(r.body.dead, true);
});

test('inventory and gold', async () => {
  const { id } = await newCampaignWithHero();
  await call('POST', `/campaigns/${id}/character/inventory`, { action: 'add', name: 'Healing Potion', quantity: 2 });
  let r = await call('POST', `/campaigns/${id}/character/inventory`, { action: 'remove', name: 'healing potion' });
  assert.equal(r.body.inventory.find((i) => i.name === 'Healing Potion').quantity, 1);
  r = await call('PATCH', `/campaigns/${id}/character`, { goldChange: -20 });
  assert.equal(r.status, 400);
  r = await call('PATCH', `/campaigns/${id}/character`, { goldChange: -5, addCondition: 'Poisoned' });
  assert.equal(r.body.gold, 10);
  assert.deepEqual(r.body.conditions, ['poisoned']);
});

test('full combat flow with xp and level up', async () => {
  const { id } = await newCampaignWithHero();
  // Player rolls 20 init (+3), goblins roll lower via sequence.
  const initRolls = [20, 5, 4];
  let r = await withDice(() => initRolls.shift() ?? 10, () => call('POST', `/campaigns/${id}/combat`, {
    enemies: [{ name: 'Goblin', count: 2, armorClass: 15, maxHp: 7, initiativeBonus: 2, xp: 150, attacks: [{ name: 'Scimitar', toHit: 4, damage: '1d6+2' }] }],
  }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.currentTurn.id, 'player');
  const [g1, g2] = r.body.initiativeOrder.filter((x) => x.side === 'enemy');

  // Player hits goblin 1: d20=15 +5 = 20 vs AC15; damage 1d6(6)+3 = 9 -> defeated
  r = await withDice((s) => (s === 20 ? 15 : 6), () => call('POST', `/campaigns/${id}/combat/attack`, {
    attackerId: 'player', targetId: g1.id, ability: 'dex', damageDice: '1d6', attackName: 'Shortsword',
  }));
  assert.equal(r.body.hit, true);
  assert.equal(r.body.damageDealt, 9);
  assert.equal(r.body.targetStatus.defeated, true);

  r = await call('POST', `/campaigns/${id}/combat/next-turn`);
  assert.equal(r.body.currentTurn.id, g2.id);

  // Goblin crits player: 2d6 (2,2) + 2 = 6
  r = await withDice((s) => (s === 20 ? 20 : 2), () => call('POST', `/campaigns/${id}/combat/attack`, { attackerId: g2.id, targetId: 'player' }));
  assert.equal(r.body.critical, true);
  assert.equal(r.body.damageDealt, 6);
  assert.equal(r.body.targetStatus.hp, 4);

  r = await call('POST', `/campaigns/${id}/combat/next-turn`);
  assert.equal(r.body.currentTurn.id, 'player'); // defeated goblin skipped
  assert.equal(r.body.round, 2);

  r = await call('POST', `/campaigns/${id}/combat/combatants/${g2.id}`, { type: 'damage', amount: 7, reason: 'sneak attack' });
  assert.equal(r.body.status.defeated, true);

  r = await call('POST', `/campaigns/${id}/combat/end`);
  assert.equal(r.body.xp.awarded, 300);
  assert.equal(r.body.xp.canLevelUp, true);

  r = await call('POST', `/campaigns/${id}/character/level-up`, { hpMethod: 'average' });
  assert.equal(r.body.level, 2);
  assert.equal(r.body.maxHp, 17); // +5 avg +2 con

  const state = await call('GET', `/campaigns/${id}`);
  assert.equal(state.body.combat, null);
  assert.equal(state.body.character.level, 2);
});

test('quests, npcs, journal persist in campaign state', async () => {
  const { id } = await newCampaignWithHero();
  const q = await call('POST', `/campaigns/${id}/quests`, { title: 'Find the Sunken Crown', giver: 'Old Tam' });
  await call('PATCH', `/campaigns/${id}/quests/${q.body.id}`, { progressNote: 'Found a map', status: 'active' });
  const n = await call('POST', `/campaigns/${id}/npcs`, { name: 'Old Tam', attitude: 'friendly' });
  await call('PATCH', `/campaigns/${id}/npcs/${n.body.id}`, { appendNotes: 'Owes Mira a favour' });
  await call('POST', `/campaigns/${id}/journal`, { entry: 'Mira took the job.', location: 'Saltmere docks' });
  await call('PATCH', `/campaigns/${id}`, { appendNotes: 'Tam is secretly a smuggler.' });
  const s = await call('GET', `/campaigns/${id}`);
  assert.equal(s.body.quests[0].progress[0], 'Found a map');
  assert.equal(s.body.npcs[0].notes, 'Owes Mira a favour');
  assert.equal(s.body.location, 'Saltmere docks');
  assert.equal(s.body.recentJournal.length, 1);
  assert.match(s.body.notes, /smuggler/);
  const list = await call('GET', '/campaigns');
  assert.ok(list.body.campaigns.some((c) => c.id === id && c.character.includes('Mira')));
});

test('roll endpoint', async () => {
  const { id } = await newCampaignWithHero();
  let r = await call('POST', `/campaigns/${id}/roll`, { expression: '4d6kh3', count: 6, reason: 'ability scores' });
  assert.equal(r.body.totals.length, 6);
  r = await call('POST', `/campaigns/${id}/roll`, { expression: '1d20+2', advantage: 'advantage' });
  assert.equal(r.body.results[0].d20.rolls.length, 2);
  r = await call('POST', `/campaigns/${id}/roll`, { expression: 'banana' });
  assert.equal(r.status, 400);
});

test('balance check warns about dangerous solo encounters', async () => {
  const { id } = await newCampaignWithHero();
  let r = await call('POST', `/campaigns/${id}/combat`, {
    enemies: [{ name: 'Wolf', armorClass: 13, maxHp: 11, xp: 50, attacks: [{ name: 'Bite', toHit: 4, damage: '2d4+2' }] }],
  });
  assert.equal(r.body.balanceCheck.rating, 'tough');
  assert.match(r.body.balanceCheck.advice, /^Fair but risky/);
  await call('POST', `/campaigns/${id}/combat/end`);
  r = await call('POST', `/campaigns/${id}/combat`, {
    enemies: [{ name: 'Orc', count: 4, armorClass: 13, maxHp: 15, xp: 100, attacks: [{ name: 'Greataxe', toHit: 5, damage: '1d12+3' }] }],
  });
  assert.equal(r.body.balanceCheck.rating, 'deadly');
  assert.ok(r.body.balanceCheck.warnings.length >= 3);
  assert.match(r.body.balanceCheck.advice, /^Too dangerous/);
});
