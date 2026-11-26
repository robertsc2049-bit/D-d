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

test('party: members get full sheets, own checks, combat turns and XP shares', async () => {
  const store = new MemoryStore();
  const ctx = { store };
  const ok = async (name, args) => {
    const r = await callTool(name, args, ctx);
    assert.ok(r.ok, `${name}: ${r.error}`);
    return r.data;
  };
  const camp = await ok('createCampaign', { name: 'Party' });
  const id = camp.id;
  await ok('createCharacter', { campaignId: id, name: 'Elias', class: 'rogue', level: 18, abilityScores: { str: 8, dex: 20, con: 12, int: 12, wis: 10, cha: 20 }, armorClass: 17 });
  // Lysa and Fen exactly as recorded in CREW_AND_MECHANICS.json
  const lysa = await ok('createCharacter', {
    campaignId: id, partyMember: true, name: 'Lysa Renn', class: 'rogue', subclass: 'Thief', level: 17, xp: 231500,
    abilityScores: { str: 8, dex: 20, con: 14, int: 12, wis: 16, cha: 12 }, armorClass: 17, maxHp: 122,
    savingThrowProficiencies: ['dex', 'int', 'wis'], reliableTalent: true, initiativeBonus: 5,
    expertise: ['stealth', 'investigation', 'insight', 'perception'], skillProficiencies: ['acrobatics', 'sleight_of_hand', 'deception', 'survival'],
  });
  assert.equal(lysa.id, 'lysa-renn');
  assert.equal(lysa.derived.initiative, '+10');
  assert.equal(lysa.derived.passivePerception, 25);
  assert.deepEqual([lysa.derived.skills.stealth, lysa.derived.skills.investigation, lysa.derived.skills.deception, lysa.derived.savingThrows.wis], ['+17', '+13', '+7', '+9']);
  const fen = await ok('createCharacter', {
    campaignId: id, partyMember: true, name: 'Halric Fen', class: 'rogue', level: 17, abilityScores: { str: 8, dex: 16, con: 12, int: 20, wis: 20, cha: 10 },
    armorClass: 15, maxHp: 105, savingThrowProficiencies: ['dex', 'int', 'wis'], passiveBonus: 5,
    expertise: ['investigation', 'history', 'insight', 'perception'], skillProficiencies: ['persuasion', 'sleight_of_hand'],
  });
  assert.equal(fen.derived.passivePerception, 32);
  assert.equal(fen.derived.passiveInvestigation, 32);

  // Checks by characterId, and unknown ids are rejected
  const chk = await withDice(10, () => ok('makeCheck', { campaignId: id, characterId: 'halric-fen', kind: 'skill', skill: 'history' }));
  assert.equal(chk.character, 'Halric Fen');
  assert.equal(chk.total, 27);
  assert.match((await callTool('makeCheck', { campaignId: id, characterId: 'nobody', kind: 'ability', ability: 'str' }, ctx)).error, /lysa-renn/);
  const lead = await withDice(10, () => ok('makeCheck', { campaignId: id, kind: 'save', ability: 'dex' }));
  assert.equal(lead.character, 'Elias');

  // Combat with the whole party: initiative order: Elias 20+5, Lysa 19+10, Fen 1+3, goblin 2+2
  const seq = [20, 19, 1, 2];
  let r = await withDice(() => seq.shift() ?? 10, () => ok('startCombat', {
    campaignId: id, includeParty: true,
    enemies: [{ name: 'Goblin', armorClass: 13, maxHp: 30, xp: 300, attacks: [{ name: 'Blade', toHit: 4, damage: '1d6+2' }] }],
  }));
  assert.deepEqual(r.initiativeOrder.map((x) => x.id).slice(0, 2), ['lysa-renn', 'player']);
  assert.equal(r.balanceCheck.heroes, 3);
  const goblin = r.initiativeOrder.find((x) => x.side === 'enemy');

  // Lysa attacks with her own DEX and proficiency: d20 10 + 5 + 6 = 21
  r = await withDice((s) => (s === 20 ? 10 : 6), () => ok('combatAttack', { campaignId: id, attackerId: 'lysa-renn', targetId: goblin.id, ability: 'dex', damageDice: '1d6' }));
  assert.equal(r.total, 21);
  assert.equal(r.damageDealt, 11);

  // Goblin crits Fen; damage lands on Fen's sheet, not Elias's
  r = await withDice((s) => (s === 20 ? 20 : 6), () => ok('combatAttack', { campaignId: id, attackerId: goblin.id, targetId: 'halric-fen' }));
  assert.equal(r.targetStatus.hp, 105 - 14);
  const state = await ok('getCampaign', { campaignId: id });
  assert.equal(state.party.find((p) => p.id === 'halric-fen').hp, 91);
  assert.equal(state.character.hp, state.character.maxHp);

  await ok('adjustCombatant', { campaignId: id, combatantId: goblin.id, type: 'damage', amount: 99 });
  r = await ok('endCombat', { campaignId: id });
  assert.equal(r.totalXp, 300);
  assert.equal(r.xpByCharacter['lysa-renn'].awarded, 100);
  assert.equal(r.xpByCharacter.player.awarded, 100);
  assert.equal(r.party.length, 3);

  // Per-character rest, HP and inventory
  await ok('rest', { campaignId: id, characterId: 'halric-fen', type: 'long' });
  assert.equal((await ok('getCampaign', { campaignId: id })).party.find((p) => p.id === 'halric-fen').hp, 105);
  const inv = await ok('manageInventory', { campaignId: id, characterId: 'lysa-renn', action: 'add', name: 'Klingon cloak' });
  assert.equal(inv.inventory.length, 1);
  assert.equal((await ok('getCampaign', { campaignId: id })).character.inventory.length, 0);

  // Party members can join a running fight
  await ok('startCombat', { campaignId: id, enemies: [{ name: 'Drone', armorClass: 12, maxHp: 5 }] });
  r = await ok('startCombat', { campaignId: id, addToExisting: true, partyMembers: ['halric-fen'] });
  assert.ok(r.initiativeOrder.some((x) => x.id === 'halric-fen'));
  assert.ok(!r.initiativeOrder.some((x) => x.id === 'lysa-renn'));
});

test('relationships: recorded, updated by name, shown in getHandoff and the mirror', async () => {
  const { ok, call, id } = await setup();
  const n = await ok('addNpc', { campaignId: id, name: 'Lysa Renn', role: 'companion (party id lysa-renn)', attitude: 'loyal', relationship: 'Trusted partner.', notes: 'Hides a debt.' });
  assert.equal((await call('addNpc', { campaignId: id, name: 'lysa renn' })).ok, false);
  await ok('setClock', { campaignId: id, day: 3, cycleLength: 28, reason: 'test' });
  const u = await ok('updateNpc', { campaignId: id, npcId: 'Lysa Renn', relationshipNote: 'Elias kept his promise about the escrow.', appendNotes: 'Debt is 40k.' });
  assert.equal(u.id, n.id);
  assert.equal(u.relationshipLog[0].day, 'Day 3/28');
  assert.match(u.notes, /Hides a debt\.\nDebt is 40k\./);
  const h = await ok('getHandoff', { campaignId: id });
  assert.equal(h.relationships[0].name, 'Lysa Renn');
  assert.equal(h.relationships[0].relationship, 'Trusted partner.');
  assert.deepEqual(h.relationships[0].recentChanges, ['Day 3/28: Elias kept his promise about the escrow.']);
  assert.match(h.relationships[0].dmNotes, /Debt is 40k/);
  const ledger = await ok('getLedger', { campaignId: id, types: ['npc'] });
  assert.ok(!JSON.stringify(ledger).includes('40k'), 'secret notes stay out of the ledger summary');
  const { renderHandoff } = await import('../supabase/functions/solo-dnd/core/mirror.js');
  const md = renderHandoff({ ...(await ok('getCampaign', { campaignId: id })), npcs: [u] }, []);
  assert.match(md, /## Relationships\n- \*\*Lysa Renn\*\* \(companion \(party id lysa-renn\)\) — loyal: Trusted partner\. _Latest: Day 3\/28: Elias kept his promise/);
  assert.ok(!md.includes('40k'));
});

test('books: accounts, transfers, equity and fleet are ledgered and validated', async () => {
  const { ok, call, id } = await setup();
  await ok('setAccount', { campaignId: id, id: 'mrc-cash', name: 'MRC unrestricted', owner: 'MRC', currency: 'cr', kind: 'cash', balance: 1000, reason: 'opening' });
  await ok('setAccount', { campaignId: id, id: 'mrc-term', name: 'MRC term deposit', owner: 'MRC', currency: 'cr', kind: 'term', balance: 50, reason: 'opening' });
  await ok('setAccount', { campaignId: id, id: 'elias', name: 'Elias personal', currency: 'SOC', kind: 'cash', balance: 10, reason: 'opening' });
  const t = await ok('postTransaction', { campaignId: id, fromAccount: 'mrc-cash', toAccount: 'MRC term deposit', amount: 200.5, reason: 'move to term' });
  assert.deepEqual(t.changes.map((x) => x.after), [799.5, 250.5]);
  assert.equal((await call('postTransaction', { campaignId: id, fromAccount: 'mrc-cash', toAccount: 'elias', amount: 1, reason: 'x' })).ok, false, 'no implicit FX');
  assert.equal((await call('postTransaction', { campaignId: id, account: 'elias', amount: -11, reason: 'overspend' })).ok, false, 'no overdraft');
  await ok('postTransaction', { campaignId: id, account: 'elias', amount: -4, reason: 'bagpipe lessons' });
  assert.equal((await call('setHolding', { campaignId: id, entity: 'Venture', owners: [{ owner: 'A', pct: 60 }, { owner: 'B', pct: 50 }], reason: 'x' })).ok, false);
  await ok('setHolding', { campaignId: id, entity: 'Venture', type: 'company', owners: [{ owner: 'A', pct: 60 }, { owner: 'B', pct: 40 }], reason: 'founding' });
  await ok('updateShip', { campaignId: id, designation: 'MRC-1', create: true, name: 'First Light', owner: 'MRC', status: 'Missing', reason: 'register' });
  await ok('updateShip', { campaignId: id, designation: 'first light', status: 'Found', reason: 'Longwatch success' });
  assert.equal((await call('updateShip', { campaignId: id, designation: 'MRC-999', status: 'x', reason: 'x' })).ok, false);
  const f = await ok('getFinances', { campaignId: id });
  assert.deepEqual(f.totalsByCurrency, { cr: { cash: 799.5, term: 250.5 }, SOC: { cash: 6 } });
  assert.equal(f.holdings[0].owners[1].pct, 40);
  const fl = await ok('getFleet', { campaignId: id, query: 'found' });
  assert.equal(fl.ships[0].name, 'First Light');
  const h = await ok('getHandoff', { campaignId: id, recentEvents: 20 });
  assert.equal(h.fleet.ships, 1);
  assert.equal(h.finances.accounts.length, 3);
  assert.ok(h.recentEvents.some((e) => e.type === 'money' && /bagpipe lessons: Elias personal -4 SOC → 6/.test(e.summary)));
  const { renderFinances, renderFleet } = await import('../supabase/functions/solo-dnd/core/ledgers.js');
  const c = await ok('getCampaign', { campaignId: id });
  assert.equal(renderFinances(c), null, 'getCampaign view has no books; mirror renders from the raw campaign');
  assert.match(renderFleet({ name: 'x', fleet: [{ designation: 'MRC-1', name: 'First Light' }] }), /\| MRC-1 \| First Light \|/);
});

test('living world: threat clocks tick by dice when time passes, trigger, and stay secret when asked', async () => {
  const { ok, call, id } = await setup();
  await ok('setClock', { campaignId: id, day: 1, cycleLength: 28, reason: 'test' });
  await ok('addThreat', { campaignId: id, name: 'Raiders regroup', goal: 'Retake their ships', stakes: 'They strike the convoy', steps: ['scouts seen', 'raid on a depot', 'fleet gathers', 'attack'], segments: 4, pace: 'fast' });
  await ok('addThreat', { campaignId: id, name: 'Cabal', goal: 'Bury evidence', stakes: 'Witness vanishes', segments: 6, pace: 'slow', secret: true });
  assert.equal((await call('addThreat', { campaignId: id, name: 'raiders regroup', goal: 'x', stakes: 'y' })).ok, false);
  // every die shows 6 → every threat ticks every day; d20 of 6 never reaches the default 17 → no complication
  const r = await withDice(6, () => ok('advanceTime', { campaignId: id, days: 3, reason: 'travel' }));
  const raid = r.world.ticks.find((t) => t.name === 'Raiders regroup');
  assert.deepEqual([raid.from, raid.to, raid.step], [0, 3, 'fleet gathers']);
  assert.equal(r.world.complication, null);
  const r2 = await withDice(20, () => ok('advanceTime', { campaignId: id, days: 2, reason: 'wait' }));
  assert.equal(r2.world.triggered[0].name, 'Raiders regroup');
  assert.ok(r2.world.complication, 'a natural 20 raises a complication');
  const h = await ok('getHandoff', { campaignId: id, recentEvents: 30 });
  assert.equal(h.threats.find((t) => t.name === 'Raiders regroup').status, 'triggered');
  assert.ok(h.recentEvents.some((e) => e.summary.startsWith('A hidden threat advanced')));
  assert.ok(!h.recentEvents.some((e) => e.summary.includes('Cabal')), 'secret threat names stay out of the ledger');
  const u = await ok('updateThreat', { campaignId: id, threatId: 'Cabal', tick: -1, reason: 'witness moved to safety' });
  assert.equal(u.change.to, u.change.from - 1);
  await ok('updateThreat', { campaignId: id, threatId: 'Raiders regroup', status: 'resolved' });
  assert.equal((await ok('getHandoff', { campaignId: id })).threats.length, 1);
  const { renderHandoff } = await import('../supabase/functions/solo-dnd/core/mirror.js');
  const md = renderHandoff({ name: 'x', threats: [{ name: 'Open', kind: 'threat', filled: 1, segments: 4, pace: 'slow', status: 'active', stakes: 'boom', secret: false, steps: [] }, { name: 'Hidden', kind: 'threat', filled: 1, segments: 4, pace: 'slow', status: 'active', stakes: 'x', secret: true, steps: [] }] }, []);
  assert.match(md, /Open\*\* \(threat\) — clock 1\/4/);
  assert.ok(!md.includes('Hidden'));
});
