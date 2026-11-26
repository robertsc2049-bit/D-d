import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool, listTools } from '../supabase/functions/solo-dnd/core/tools.js';
import { MemoryStore } from '../supabase/functions/solo-dnd/core/store.js';
import { withDice } from './helpers.js';

async function setup() {
  const store = new MemoryStore();
  const ctx = { store };
  const call = async (name, args = {}) => {
    const r = await callTool(name, args, ctx);
    return r;
  };
  const ok = async (name, args) => {
    const r = await call(name, args);
    assert.ok(r.ok, `${name} failed: ${r.error}`);
    return r.data;
  };
  const camp = await ok('createCampaign', { name: 'The Sunken Crown', tone: 'heroic' });
  const character = await ok('createCharacter', {
    campaignId: camp.id,
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
  return { store, call, ok, id: camp.id, character };
}

test('tool definitions are well formed', () => {
  const tools = listTools();
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('getDmGuide'));
  for (const t of tools) {
    assert.equal(t.inputSchema.type, 'object');
    for (const r of t.inputSchema.required ?? []) assert.ok(t.inputSchema.properties[r], `${t.name} requires undefined ${r}`);
  }
  assert.deepEqual(tools.find((t) => t.name === 'makeCheck').inputSchema.required, ['campaignId', 'kind']);
  assert.equal(tools.find((t) => t.name === 'deleteCampaign').annotations.destructiveHint, true);
  assert.equal(tools.find((t) => t.name === 'getCampaign').annotations.readOnlyHint, true);
});

test('character creation computes derived stats', async () => {
  const { character } = await setup();
  assert.equal(character.maxHp, 10);
  assert.equal(character.derived.skills.stealth, '+7');
  assert.equal(character.derived.skills.sleight_of_hand, '+5');
  assert.equal(character.derived.savingThrows.dex, '+5');
  assert.equal(character.derived.passivePerception, 13);
});

test('changes persist in the store', async () => {
  const { ok, store, id } = await setup();
  await ok('changeHp', { campaignId: id, type: 'damage', amount: 3 });
  const saved = await store.get(id);
  assert.equal(saved.character.hp, 7);
  // read-only tools don't need to save; errors don't save partial work
  const before = JSON.stringify(await store.get(id));
  const { call } = { call: (n, a) => callTool(n, a, { store }) };
  const r = await call('manageInventory', { campaignId: id, action: 'remove', name: 'Dragon' });
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(await store.get(id)), before);
});

test('checks use the sheet', async () => {
  const { ok, call, id } = await setup();
  const r = await withDice(10, () => ok('makeCheck', { campaignId: id, kind: 'skill', skill: 'stealth', dc: 15 }));
  assert.equal(r.total, 17);
  assert.equal(r.success, true);
  const bad = await call('makeCheck', { campaignId: id, kind: 'skill', skill: 'flying' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Unknown skill/);
});

test('hp, death saves and long rest', async () => {
  const { ok, id } = await setup();
  await ok('changeHp', { campaignId: id, type: 'temp', amount: 3 });
  let r = await ok('changeHp', { campaignId: id, type: 'damage', amount: 8 });
  assert.equal(r.after.hp, 5);
  r = await ok('changeHp', { campaignId: id, type: 'damage', amount: 6 });
  assert.ok(r.conditions.includes('unconscious'));
  r = await withDice(3, () => ok('makeCheck', { campaignId: id, kind: 'death_save' }));
  assert.equal(r.deathSaves.failures, 1);
  r = await withDice(20, () => ok('makeCheck', { campaignId: id, kind: 'death_save' }));
  assert.equal(r.hp, 1);
  r = await ok('rest', { campaignId: id, type: 'long' });
  assert.equal(r.hp, 10);
});

test('full combat flow with balance check, xp and level up', async () => {
  const { ok, id } = await setup();
  const init = [20, 5, 4];
  let r = await withDice(() => init.shift() ?? 10, () => ok('startCombat', {
    campaignId: id,
    enemies: [{ name: 'Goblin', count: 2, armorClass: 15, maxHp: 7, initiativeBonus: 2, xp: 150, attacks: [{ name: 'Scimitar', toHit: 4, damage: '1d6+2' }] }],
  }));
  assert.equal(r.currentTurn.id, 'player');
  assert.ok(r.balanceCheck);
  const [g1, g2] = r.initiativeOrder.filter((x) => x.side === 'enemy');

  r = await withDice((s) => (s === 20 ? 15 : 6), () => ok('combatAttack', {
    campaignId: id, attackerId: 'player', targetId: g1.id, ability: 'dex', damageDice: '1d6',
  }));
  assert.equal(r.damageDealt, 9);
  assert.equal(r.targetStatus.defeated, true);

  r = await ok('nextTurn', { campaignId: id });
  assert.equal(r.currentTurn.id, g2.id);
  r = await withDice((s) => (s === 20 ? 20 : 2), () => ok('combatAttack', { campaignId: id, attackerId: g2.id, targetId: 'player' }));
  assert.equal(r.critical, true);
  assert.equal(r.targetStatus.hp, 4);

  r = await ok('nextTurn', { campaignId: id });
  assert.equal(r.currentTurn.id, 'player');
  assert.equal(r.round, 2);
  await ok('adjustCombatant', { campaignId: id, combatantId: g2.id, type: 'damage', amount: 7 });
  r = await ok('endCombat', { campaignId: id });
  assert.equal(r.xp.awarded, 300);
  assert.equal(r.xp.canLevelUp, true);
  r = await ok('levelUp', { campaignId: id });
  assert.equal(r.maxHp, 17);
});

test('balance check flags deadly fights', async () => {
  const { ok, id } = await setup();
  const r = await ok('startCombat', {
    campaignId: id,
    enemies: [{ name: 'Orc', count: 4, armorClass: 13, maxHp: 15, xp: 100, attacks: [{ name: 'Greataxe', toHit: 5, damage: '1d12+3' }] }],
  });
  assert.equal(r.balanceCheck.rating, 'deadly');
  assert.match(r.balanceCheck.advice, /^Too dangerous/);
});

test('quests, npcs, journal, notes and rolls', async () => {
  const { ok, id } = await setup();
  const q = await ok('addQuest', { campaignId: id, title: 'Find the Sunken Crown', giver: 'Old Tam' });
  await ok('updateQuest', { campaignId: id, questId: q.id, progressNote: 'Found a map' });
  const n = await ok('addNpc', { campaignId: id, name: 'Old Tam', attitude: 'friendly' });
  await ok('updateNpc', { campaignId: id, npcId: n.id, appendNotes: 'Owes Mira a favour' });
  await ok('addJournalEntry', { campaignId: id, entry: 'Mira took the job.', location: 'Saltmere docks' });
  await ok('updateCampaign', { campaignId: id, appendNotes: 'Tam is secretly a smuggler.' });
  const rolls = await ok('rollDice', { campaignId: id, expression: '4d6kh3', count: 6 });
  assert.equal(rolls.totals.length, 6);
  const s = await ok('getCampaign', { campaignId: id });
  assert.equal(s.quests[0].progress[0], 'Found a map');
  assert.equal(s.npcs[0].notes, 'Owes Mira a favour');
  assert.equal(s.location, 'Saltmere docks');
  assert.match(s.dmNotes, /smuggler/);
  assert.equal(s.recentRolls.length, 1);
  const list = await ok('listCampaigns');
  assert.match(list.campaigns[0].character, /Mira/);
  await ok('deleteCampaign', { campaignId: id });
  assert.equal((await ok('listCampaigns')).campaigns.length, 0);
});

test('unknown campaign and tool give clear errors', async () => {
  const { call } = await setup();
  assert.match((await call('getCampaign', { campaignId: 'cmp_nope' })).error, /listCampaigns/);
  assert.match((await call('getCampaign', {})).error, /campaignId/);
  assert.match((await call('fly', {})).error, /Unknown tool/);
});

test('Elias (level 18 Mastermind) matches the campaign repo numbers', async () => {
  const store = new MemoryStore();
  const ctx = { store };
  const camp = (await callTool('createCampaign', { name: 'Elias check' }, ctx)).data;
  const r = await callTool('createCharacter', {
    campaignId: camp.id, name: 'Elias Mere', class: 'rogue', subclass: 'Mastermind', level: 18, xp: 265000,
    abilityScores: { str: 8, dex: 20, con: 12, int: 12, wis: 10, cha: 20 }, armorClass: 17,
    savingThrowProficiencies: ['dex', 'int', 'wis'],
    skillProficiencies: ['sleight_of_hand', 'stealth', 'investigation'],
    expertise: ['deception', 'persuasion', 'insight', 'perception'],
    checkBonus: 1, saveBonus: 1, reliableTalent: true,
  }, ctx);
  assert.ok(r.ok, r.error);
  const d = r.data.derived;
  // Values recorded in campaigns/star-trek-transfer/CREW_AND_MECHANICS.json ("live with Luckstone")
  assert.deepEqual(
    { de: d.skills.deception, pe: d.skills.persuasion, in: d.skills.insight, pc: d.skills.perception, sh: d.skills.sleight_of_hand, st: d.skills.stealth, iv: d.skills.investigation },
    { de: '+18', pe: '+18', in: '+13', pc: '+13', sh: '+12', st: '+12', iv: '+8' },
  );
  assert.equal(d.savingThrows.wis, '+7');
  assert.equal(d.passivePerception, 23);
  assert.equal(d.proficiencyBonus, 6);
  assert.equal(d.initiative, '+6');
  assert.equal(r.data.maxHp, 111); // fixed-average HP for Rogue 18 with CON 12

  // Reliable Talent: a natural 3 on a proficient skill counts as 10; luckstone adds +1.
  const low = await withDice(3, () => callTool('makeCheck', { campaignId: camp.id, kind: 'skill', skill: 'deception' }, ctx));
  assert.equal(low.data.total, 28);
  assert.equal(low.data.reliableTalentApplied, true);
  // Not proficient in athletics: no Reliable Talent, luckstone still applies.
  const ath = await withDice(3, () => callTool('makeCheck', { campaignId: camp.id, kind: 'skill', skill: 'athletics' }, ctx));
  assert.equal(ath.data.total, 3 - 1 + 1);
  // Saves get the luckstone, attacks do not.
  const save = await withDice(10, () => callTool('makeCheck', { campaignId: camp.id, kind: 'save', ability: 'wis' }, ctx));
  assert.equal(save.data.total, 17);
  const atk = await withDice(10, () => callTool('makeCheck', { campaignId: camp.id, kind: 'attack', ability: 'dex' }, ctx));
  assert.equal(atk.data.total, 21);
});
