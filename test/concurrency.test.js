import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callTool } from '../supabase/functions/solo-dnd/core/tools.js';
import { MemoryStore } from '../supabase/functions/solo-dnd/core/store.js';

async function setup() {
  const store = new MemoryStore();
  const ctx = { store };
  const camp = (await callTool('createCampaign', { name: 'Race' }, ctx)).data;
  await callTool('createCharacter', { campaignId: camp.id, name: 'Elias', class: 'rogue', level: 5, abilityScores: { str: 8, dex: 16, con: 12, int: 12, wis: 10, cha: 16 } }, ctx);
  return { store, ctx, id: camp.id };
}

test('simultaneous actions on one campaign never overwrite each other', async () => {
  const { store, ctx, id } = await setup();
  const items = ['Rope', 'Lantern', 'Tricorder', 'Phaser', 'Rations', 'Medkit', 'Padd', 'Comm badge'];
  const results = await Promise.all(items.map((name) => callTool('manageInventory', { campaignId: id, action: 'add', name }, ctx)));
  for (const r of results) assert.ok(r.ok, r.error);
  const saved = await store.get(id);
  assert.deepEqual(saved.character.inventory.map((i) => i.name).sort(), [...items].sort());
});

test('mixed simultaneous writes all land (HP, gold, notes)', async () => {
  const { store, ctx, id } = await setup();
  await Promise.all([
    callTool('changeHp', { campaignId: id, type: 'damage', amount: 5 }, ctx),
    callTool('updateCharacter', { campaignId: id, goldChange: 50 }, ctx),
    callTool('updateCampaign', { campaignId: id, appendNotes: 'A' }, ctx),
    callTool('updateCampaign', { campaignId: id, appendNotes: 'B' }, ctx),
    callTool('addJournalEntry', { campaignId: id, entry: 'Something happened.' }, ctx),
  ]);
  const saved = await store.get(id);
  assert.equal(saved.character.hp, saved.character.maxHp - 5);
  assert.equal(saved.character.gold, 50);
  assert.deepEqual(saved.notes.split('\n').sort(), ['A', 'B']);
  assert.equal(saved.journal.length, 1);
});

test('gives a clear error if a campaign stays too busy to save', async () => {
  const { store, ctx, id } = await setup();
  store.put = async () => { throw Object.assign(new Error('conflict'), { conflict: true }); };
  const r = await callTool('changeHp', { campaignId: id, type: 'damage', amount: 1 }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /busy/i);
});
