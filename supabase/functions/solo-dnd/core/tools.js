// Every game action exposed to ChatGPT, as MCP tools.
// Each tool validates its input, loads the campaign from the store, changes it and saves it.
import { describeCharacter } from './rules.js';
import { rollD20, newId } from './dice.js';
import {
  HttpError, bad, text, int, advantageMode, safeRoll, logRoll, buildCharacter, updateCharacter, addItem, removeItem,
  changeCharacterHp, rest, awardXp, levelUp, characterCheck, startCombat, combatView, combatAttack, adjustCombatant,
  nextTurn, endCombat,
} from './game.js';
import { DM_GUIDE } from './guide.js';
import { syncCampaign } from './mirror.js';

const now = () => new Date().toISOString();

// ---------- schema helpers ----------
const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const B = (description) => ({ type: 'boolean', description });
const list = (description) => ({ type: 'array', items: { type: 'string' }, description });
const advantage = { type: 'string', enum: ['none', 'advantage', 'disadvantage'], description: 'Roll two d20s and keep the higher (advantage) or lower (disadvantage).' };
const ability = (description) => ({ type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'], description });
const campaignId = S('Campaign id, e.g. cmp_1a2b3c4d (from listCampaigns).');

const combatantSchema = {
  type: 'object',
  required: ['name', 'armorClass', 'maxHp'],
  properties: {
    name: S('e.g. "Goblin"'),
    count: I('How many identical copies (they get numbered).', { minimum: 1, maximum: 20 }),
    armorClass: I('AC'),
    maxHp: I('Hit points'),
    initiativeBonus: I('Usually the DEX modifier.'),
    xp: I('XP awarded when defeated.'),
    notes: S('Tactics, resistances, special abilities.'),
    attacks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['toHit', 'damage'],
        properties: { name: S('e.g. "Scimitar"'), toHit: I('Attack bonus, e.g. 4'), damage: S('Dice, e.g. "1d6+2"'), damageType: S('e.g. slashing') },
      },
    },
  },
};

// ---------- campaign views ----------
function campaignSummary(c) {
  return {
    id: c.id,
    name: c.name,
    character: c.character ? `${c.character.name}, level ${c.character.level} ${c.character.race} ${c.character.class}` : null,
    party: (c.party ?? []).map((p) => `${p.name} (${p.id}), level ${p.level} ${p.class}`),
    location: c.location,
    updatedAt: c.updatedAt,
  };
}

function campaignView(c, journal = 10) {
  return {
    id: c.id,
    name: c.name,
    setting: c.setting,
    tone: c.tone,
    location: c.location,
    inGameDate: c.inGameDate,
    clock: c.clock ?? null,
    scene: c.scene ?? null,
    ledgerSeq: c.lastSeq ?? 0,
    dmNotes: c.notes,
    character: describeCharacter(c.character),
    party: (c.party ?? []).map(describeCharacter),
    quests: c.quests,
    npcs: c.npcs,
    combat: combatView(c),
    recentJournal: c.journal.slice(-journal),
    journalEntriesTotal: c.journal.length,
    recentRolls: c.rollHistory.slice(-5),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The lead character ("player", default) or a party member by id or name. */
function needCharacter(c, a = {}) {
  if (!c.character) throw bad('This campaign has no character yet. Create one with createCharacter.');
  const id = a.characterId;
  if (id === undefined || id === null || id === '' || id === 'player') return c.character;
  const key = String(id).toLowerCase();
  if (c.character.name.toLowerCase() === key) return c.character;
  const m = (c.party ?? []).find((p) => p.id === id || p.name.toLowerCase() === key);
  if (!m) throw new HttpError(404, `No character "${id}". Use "player" or a party id: ${(c.party ?? []).map((p) => p.id).join(', ') || 'none'}.`);
  return m;
}

const slug = (name) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'member';

function doRoll(a) {
  const count = int(a.count, 'count', { min: 1, max: 20 }) ?? 1;
  const reason = text(a.reason, 'reason', { max: 200 }) ?? null;
  const mode = advantageMode(a.advantage);
  if (mode !== 'none') {
    const expr = text(a.expression, 'expression', { max: 100 }) ?? '1d20';
    const m = expr.replace(/\s+/g, '').match(/^1?d20([+-]\d+)?$/i);
    if (!m) throw bad('Advantage/disadvantage only applies to a single d20 roll like "1d20+5".');
    const mod = Number(m[1] ?? 0);
    const results = Array.from({ length: count }, () => {
      const d = rollD20(mode);
      return { d20: d, modifier: mod, total: d.natural + mod };
    });
    return { reason, expression: expr, advantage: mode, results, ...(count === 1 ? { total: results[0].total } : {}) };
  }
  const expr = text(a.expression, 'expression', { required: true, max: 100 });
  const results = Array.from({ length: count }, () => safeRoll(expr));
  return count === 1 ? { reason, ...results[0] } : { reason, results, totals: results.map((r) => r.total) };
}

// ---------- tool table ----------
// kind: 'read' (no save), 'write' (loads + saves campaign), 'global' (no campaign), 'destructive'.
const TOOLS = [
  {
    name: 'getDmGuide',
    title: 'Read the Dungeon Master guide',
    description: 'Returns the full Dungeon Master rules and play guide. Call this once at the start of every conversation, before anything else, and follow it.',
    kind: 'global',
    properties: {},
    run: async () => ({ guide: DM_GUIDE }),
  },
  {
    name: 'listCampaigns',
    title: 'List saved campaigns',
    description: 'List all saved campaigns, most recently played first. Call at the start of a chat to find the campaign to resume.',
    kind: 'global',
    properties: {},
    run: async (a, { store }) => ({ campaigns: (await store.list()).map(campaignSummary) }),
  },
  {
    name: 'createCampaign',
    title: 'Start a new campaign',
    description: 'Create a new campaign. Returns its id; pass that id to every other tool.',
    kind: 'global',
    required: ['name'],
    properties: {
      name: S('Campaign title'),
      setting: S('World/setting summary the DM should remember.'),
      tone: S('e.g. "grim and gritty", "lighthearted", "horror"'),
      location: S('Starting location'),
      inGameDate: S('In-world date/time, free text'),
      notes: S('Secret DM notes: plot outline, villain plans. Never shown to the player.'),
    },
    run: async (a, { store }) => {
      const c = {
        id: newId('cmp'),
        name: text(a.name, 'name', { required: true, max: 100 }),
        setting: text(a.setting, 'setting', { max: 4000 }) ?? null,
        tone: text(a.tone, 'tone', { max: 200 }) ?? null,
        location: text(a.location, 'location', { max: 200 }) ?? null,
        inGameDate: text(a.inGameDate, 'inGameDate', { max: 100 }) ?? null,
        notes: text(a.notes, 'notes', { max: 8000 }) ?? null,
        character: null,
        quests: [],
        npcs: [],
        journal: [],
        rollHistory: [],
        combat: null,
        createdAt: now(),
        updatedAt: now(),
      };
      await store.create(c);
      return campaignView(c);
    },
  },
  {
    name: 'getCampaign',
    title: 'Load full campaign state',
    description: 'Everything needed to resume play: character sheet with all bonuses, quests, NPCs, current combat, recent journal and secret DM notes.',
    kind: 'read',
    properties: { journalEntries: I('How many recent journal entries to include (default 10).', { minimum: 0, maximum: 50 }) },
    run: async (a, { campaign }) => campaignView(campaign, int(a.journalEntries, 'journalEntries', { min: 0, max: 50 }) ?? 10),
  },
  {
    name: 'updateCampaign',
    title: 'Update campaign details',
    description: 'Update location, in-game date, setting, tone or secret DM notes. Use appendNotes to add a line to the DM notes without rewriting them.',
    kind: 'write',
    properties: {
      name: S('Title'), setting: S('Setting'), tone: S('Tone'), location: S('Current location'),
      inGameDate: S('In-world date/time'), notes: S('Replace all DM notes'), appendNotes: S('Add a line to the DM notes'),
      scene: S('One or two sentences: the current scene and who is where (shown at the top of every handoff)'),
    },
    run: async (a, { campaign: c, emit }) => {
      const fields = { name: 100, setting: 4000, tone: 200, location: 200, inGameDate: 100, notes: 8000, scene: 1000 };
      const changed = [];
      for (const [k, max] of Object.entries(fields)) {
        if (a[k] !== undefined) {
          c[k] = text(a[k], k, { max }) ?? null;
          changed.push(k);
        }
      }
      if (a.appendNotes) {
        c.notes = [c.notes, text(a.appendNotes, 'appendNotes', { max: 2000 })].filter(Boolean).join('\n');
        changed.push('appendNotes');
      }
      if (c.notes && c.notes.length > 8000) c.notes = c.notes.slice(-8000);
      if (changed.length) {
        const shown = Object.fromEntries(changed.filter((k) => k !== 'notes').map((k) => [k, a[k]]));
        emit(a.scene !== undefined ? 'scene' : 'campaign', `Campaign updated: ${changed.join(', ')}${a.location ? ` (location: ${a.location})` : ''}`, shown);
      }
      return campaignView(c);
    },
  },
  {
    name: 'deleteCampaign',
    title: 'Delete a campaign',
    description: 'Permanently delete a campaign. Only when the player explicitly asks.',
    kind: 'destructive',
    properties: {},
    run: async (a, { store, campaign }) => {
      await store.delete(campaign.id);
      return { deleted: campaign.id };
    },
  },
  {
    name: 'createCharacter',
    title: 'Create the player character',
    description: 'Create (or replace) the lead character, or with partyMember true add/replace a playable party member (gets an id for characterId). Server computes modifiers, proficiency, HP, saves and skills.',
    kind: 'write',
    required: ['name', 'class', 'abilityScores'],
    properties: {
      name: S('Character name'),
      partyMember: B('Add as an additional playable party member instead of replacing the lead character'),
      race: S('e.g. Elf, Dwarf, Human'),
      class: S('e.g. fighter, wizard, rogue'),
      subclass: S('Optional'),
      background: S('e.g. Acolyte, Criminal'),
      alignment: S('Optional'),
      level: I('Starting level, default 1', { minimum: 1, maximum: 20 }),
      abilityScores: {
        type: 'object',
        description: 'All six scores, racial bonuses already applied.',
        required: ['str', 'dex', 'con', 'int', 'wis', 'cha'],
        properties: { str: I('Strength'), dex: I('Dexterity'), con: I('Constitution'), int: I('Intelligence'), wis: I('Wisdom'), cha: I('Charisma') },
      },
      armorClass: I('AC from armor/shield. Default 10 + DEX mod.'),
      checkBonus: I('Standing bonus to every ability check incl. skills and initiative, e.g. 1 for a Stone of Good Luck'),
      saveBonus: I('Standing bonus to every saving throw, e.g. 1 for a Stone of Good Luck'),
      reliableTalent: B('Rogue 11+ Reliable Talent: proficient skill checks treat a d20 of 9 or lower as 10'),
      initiativeBonus: I('Extra initiative bonus from feats/items, e.g. 5 for Alert'),
      passiveBonus: I('Extra bonus to passive Perception and Investigation, e.g. 5 for Observant'),
      maxHp: I('Override computed max HP.'),
      speed: I('Default 30'),
      skillProficiencies: list('e.g. ["stealth","perception"]'),
      expertise: list('Skills with double proficiency'),
      savingThrowProficiencies: list('Override class default, e.g. ["dex","int"]'),
      features: list('Class/race features, feats, traits'),
      spellcastingAbility: ability('For casters'),
      spells: list('Known/prepared spells and cantrips'),
      spellSlots: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Max slots per level, e.g. {"1":2}' },
      gold: I('Starting gold'),
      inventory: { type: 'array', items: { type: 'object', properties: { name: S('Item'), quantity: I('Qty'), notes: S('Stats/notes'), equipped: B('Equipped') } } },
      personality: S('Traits, ideals, bonds, flaws'),
      backstory: S('Backstory'),
    },
    run: async (a, { campaign: c, emit }) => {
      const ch = buildCharacter(a);
      if (!a.partyMember) {
        c.character = { ...ch, id: 'player' };
        emit('character', `Lead character set: ${ch.name}, level ${ch.level} ${ch.class}`, { hp: ch.maxHp, ac: ch.armorClass, xp: ch.xp });
        return describeCharacter(c.character);
      }
      if (!c.character) throw bad('Create the lead character first, then add party members.');
      c.party = c.party ?? [];
      const id = slug(ch.name);
      const existing = c.party.findIndex((p) => p.id === id);
      const member = { ...ch, id };
      if (existing >= 0) c.party[existing] = member;
      else {
        if (c.party.length >= 12) throw bad('At most 12 party members.');
        c.party.push(member);
      }
      emit('character', `Party member ${existing >= 0 ? 'replaced' : 'added'}: ${ch.name} (${id}), level ${ch.level} ${ch.class}`, { hp: ch.maxHp, ac: ch.armorClass, xp: ch.xp });
      return describeCharacter(member);
    },
  },
  {
    name: 'updateCharacter',
    title: 'Update the character sheet',
    description: 'Change any sheet field. Also: expendSpellSlot (level), goldChange (+/-), addCondition/removeCondition, addFeature, inspiration. Use changeHp for damage/healing.',
    kind: 'write',
    properties: {
      name: S('Name'), race: S('Race'), subclass: S('Subclass'), background: S('Background'), alignment: S('Alignment'),
      abilityScores: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Only the scores that change, e.g. {"str":16}' },
      armorClass: I('New AC'), speed: I('Speed'), maxHp: I('New max HP'),
      checkBonus: I('Standing bonus to every ability check incl. skills and initiative, e.g. 1 for a Stone of Good Luck'),
      saveBonus: I('Standing bonus to every saving throw, e.g. 1 for a Stone of Good Luck'),
      reliableTalent: B('Rogue 11+ Reliable Talent: proficient skill checks treat a d20 of 9 or lower as 10'),
      initiativeBonus: I('Extra initiative bonus from feats/items, e.g. 5 for Alert'),
      passiveBonus: I('Extra bonus to passive Perception and Investigation, e.g. 5 for Observant'),
      skillProficiencies: list('Full replacement list'), expertise: list('Full replacement list'),
      savingThrowProficiencies: list('Full replacement list'),
      features: list('Full replacement list'), addFeature: S('Append one feature'),
      spellcastingAbility: ability('Casting ability'),
      spells: list('Full replacement list'),
      spellSlots: { type: 'object', additionalProperties: { type: 'integer' }, description: 'New max slots per level; resets used slots.' },
      expendSpellSlot: I('Spend one slot of this level', { minimum: 1, maximum: 9 }),
      restoreSpellSlot: I('Regain one slot of this level', { minimum: 1, maximum: 9 }),
      goldChange: I('Add (positive) or spend (negative) gold'),
      inspiration: B('Has inspiration'),
      conditions: list('Full replacement list'), addCondition: S('e.g. poisoned'), removeCondition: S('e.g. poisoned'),
      personality: S('Personality'), backstory: S('Backstory'),
    },
    run: async (a, { campaign: c, emit }) => {
      const ch = needCharacter(c, a);
      updateCharacter(ch, a);
      const { campaignId: _c, characterId: _id, ...changes } = a;
      emit('character', `${ch.name} sheet updated: ${Object.keys(changes).join(', ')}`, changes);
      return describeCharacter(ch);
    },
  },
  {
    name: 'changeHp',
    title: 'Damage or heal the character',
    description: 'Apply damage, healing or temporary HP to the player character outside of combatAttack. Handles temp HP, dropping to 0, death save failures and massive damage.',
    kind: 'write',
    required: ['type', 'amount'],
    properties: {
      type: { type: 'string', enum: ['damage', 'heal', 'temp'] },
      amount: I('Amount', { minimum: 0 }),
      critical: B('Was it a critical hit (matters at 0 HP)'),
      reason: S('e.g. "fell into a pit"'),
    },
    run: async (a, { campaign: c, emit }) => {
      const ch = needCharacter(c, a);
      const type = a.type ?? 'damage';
      if (!['damage', 'heal', 'temp'].includes(type)) throw bad('"type" must be damage, heal or temp.');
      const amount = int(a.amount, 'amount', { required: true, min: 0, max: 10000 });
      const r = changeCharacterHp(ch, { type, amount, critical: Boolean(a.critical) });
      emit('hp', `${ch.name} ${type === 'damage' ? 'takes' : type === 'heal' ? 'heals' : 'gains temp HP'} ${amount}${a.reason ? ` (${a.reason})` : ''}: HP ${r.after.hp}/${r.after.maxHp}${r.dead ? ' DEAD' : ''}`, { before: r.before, after: r.after, notes: r.notes });
      return { type, amount, reason: a.reason ?? null, ...r, conditions: ch.conditions, deathSaves: ch.deathSaves };
    },
  },
  {
    name: 'rest',
    title: 'Take a short or long rest',
    description: 'Short rest: spend hit dice to heal (server rolls). Long rest: restore HP, spell slots and half of hit dice.',
    kind: 'write',
    required: ['type'],
    properties: { type: { type: 'string', enum: ['short', 'long'] }, hitDiceToSpend: I('Short rest only', { minimum: 0 }) },
    run: async (a, { campaign: c, emit }) => {
      const ch = needCharacter(c, a);
      if (c.combat) throw bad('You cannot rest during combat. End combat first.');
      if (a.type !== 'short' && a.type !== 'long') throw bad('"type" must be "short" or "long".');
      const r = rest(ch, { type: a.type, hitDiceToSpend: int(a.hitDiceToSpend, 'hitDiceToSpend', { min: 0, max: 20 }) ?? 0 });
      emit('rest', `${ch.name} takes a ${a.type} rest: HP ${ch.hp}/${ch.maxHp}`, { type: a.type, hitDiceSpent: r.hitDiceSpent, rolls: r.rolls, healed: r.healed });
      return r;
    },
  },
  {
    name: 'awardXp',
    title: 'Award experience points',
    description: 'Give XP for milestones, roleplay or non-combat victories. The response says if the character can level up.',
    kind: 'write',
    required: ['amount'],
    properties: { amount: I('XP', { minimum: 0 }), reason: S('Why') },
    run: async (a, { campaign: c, emit }) => {
      const ch = needCharacter(c, a);
      const r = awardXp(ch, int(a.amount, 'amount', { required: true, min: 0, max: 1000000 }));
      if (a.reason) r.reason = text(a.reason, 'reason', { max: 200 });
      emit('xp', `${ch.name} +${r.awarded} XP${r.reason ? ` (${r.reason})` : ''}: total ${r.xp}${r.canLevelUp ? ' — can level up' : ''}`, { awarded: r.awarded, total: r.xp, reason: r.reason ?? null });
      return r;
    },
  },
  {
    name: 'levelUp',
    title: 'Level up the character',
    description: 'Raise level by one and add HP (average or rolled). Afterwards add new features/spells with updateCharacter.',
    kind: 'write',
    properties: { hpMethod: { type: 'string', enum: ['average', 'roll'] } },
    run: async (a, { campaign: c, emit }) => {
      const hpMethod = a.hpMethod ?? 'average';
      if (!['average', 'roll'].includes(hpMethod)) throw bad('"hpMethod" must be "average" or "roll".');
      const ch = needCharacter(c, a);
      const r = levelUp(ch, { hpMethod });
      emit('xp', `${ch.name} reaches level ${r.level} (+${r.hpGained} HP, max ${r.maxHp})`, { level: r.level, hpGained: r.hpGained, hpRoll: r.hpRoll });
      return { ...r, character: describeCharacter(ch) };
    },
  },
  {
    name: 'manageInventory',
    title: 'Add, remove or equip items',
    description: 'Add, remove, equip or unequip an inventory item by name. Use updateCharacter goldChange for money.',
    kind: 'write',
    required: ['action', 'name'],
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'equip', 'unequip'] },
      name: S('Item name'),
      quantity: I('Default 1', { minimum: 1 }),
      notes: S('Item stats or description, e.g. "1d8 slashing, versatile 1d10"'),
      equipped: B('Equip when adding'),
    },
    run: async (a, { campaign: c, emit }) => {
      const ch = needCharacter(c, a);
      const action = a.action ?? 'add';
      let item;
      if (action === 'add') item = addItem(ch, a);
      else if (action === 'remove') item = removeItem(ch, a);
      else if (action === 'equip' || action === 'unequip') {
        item = ch.inventory.find((i) => i.name.toLowerCase() === String(a.name ?? '').toLowerCase() || i.id === a.name);
        if (!item) throw new HttpError(404, `"${a.name}" is not in the inventory.`);
        item.equipped = action === 'equip';
      } else throw bad('"action" must be add, remove, equip or unequip.');
      emit('item', `${ch.name}: ${action} ${action === 'add' || action === 'remove' ? `${int(a.quantity, 'quantity') ?? 1} × ` : ''}${item.name}`, { action, item: item.name, notes: a.notes ?? null });
      return { action, item, inventory: ch.inventory, gold: ch.gold };
    },
  },
  {
    name: 'rollDice',
    title: 'Roll dice',
    description: 'Roll any dice expression fairly, e.g. "1d20+3", "8d6", "4d6kh3", "2d6+1d4-1". Use for monster saves, spell damage, random tables. Set count to repeat (e.g. 6 for ability scores).',
    kind: 'write',
    required: ['expression'],
    properties: {
      expression: S('Dice expression'),
      reason: S('What the roll is for'),
      advantage,
      count: I('Repeat the roll N times', { minimum: 1, maximum: 20 }),
    },
    run: async (a, { campaign: c, emit }) => {
      const r = doRoll(a);
      const result = r.total ?? r.totals ?? r.results?.map((x) => x.total);
      logRoll(c, { reason: r.reason, expression: a.expression, result });
      emit('roll', `${r.reason ?? 'Roll'}: ${r.breakdown ?? `${a.expression} → ${JSON.stringify(result)}`}`, { expression: a.expression, result, advantage: r.advantage ?? null });
      return r;
    },
  },
  {
    name: 'makeCheck',
    title: 'Roll a check for the character',
    description: 'Roll a skill check, ability check, saving throw, attack, initiative or death save for the lead character or a party member (characterId), using their sheet. Give a DC for success/failure.',
    kind: 'write',
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['skill', 'ability', 'save', 'attack', 'initiative', 'death_save'] },
      skill: S('For kind=skill, e.g. "stealth", "sleight_of_hand"'),
      ability: ability("For ability/save/attack, or to override a skill's ability"),
      dc: I('Difficulty class (or target AC for attacks)'),
      advantage,
      bonus: I('Extra modifier, e.g. +2 or -2'),
      proficient: B('Attack only: proficient with the weapon (default true)'),
      damage: S('Attack only: weapon dice like "1d8"; ability mod added and rolled on hit'),
      reason: S('What the check is for'),
    },
    run: async (a, { campaign: c, emit }) => {
      const ch = needCharacter(c, a);
      const r = { character: ch.name, ...characterCheck(ch, a) };
      if (a.reason) r.reason = text(a.reason, 'reason', { max: 200 });
      logRoll(c, { reason: r.reason ?? r.label ?? r.kind, result: r.total ?? r.d20?.natural, success: r.success });
      const outcome = r.success === undefined ? '' : ` vs DC ${r.dc}: ${r.success ? 'success' : 'failure'}`;
      emit('check', r.kind === 'death_save'
        ? `${ch.name} death save: d20 ${r.d20.natural} (successes ${r.deathSaves.successes}, failures ${r.deathSaves.failures})${r.dead ? ' — DIES' : ''}`
        : `${ch.name} ${r.label}${r.reason ? ` (${r.reason})` : ''}: ${r.breakdown}${outcome}`, { kind: r.kind, total: r.total ?? null, natural: r.d20?.natural, dc: r.dc ?? null, success: r.success ?? null });
      return r;
    },
  },
  {
    name: 'addQuest',
    title: 'Add a quest',
    description: 'Record a new quest or plot hook the character has taken on.',
    kind: 'write',
    required: ['title'],
    properties: { title: S('Quest title'), description: S('Details'), giver: S('Who gave it'), reward: S('Promised reward') },
    run: async (a, { campaign: c, emit }) => {
      const q = {
        id: newId('qst'),
        title: text(a.title, 'title', { required: true, max: 120 }),
        description: text(a.description, 'description', { max: 2000 }) ?? null,
        giver: text(a.giver, 'giver', { max: 100 }) ?? null,
        reward: text(a.reward, 'reward', { max: 300 }) ?? null,
        status: 'active',
        progress: [],
        createdAt: now(),
      };
      c.quests.push(q);
      emit('quest', `Quest added: ${q.title}${q.giver ? ` (from ${q.giver})` : ''}`, { id: q.id, reward: q.reward });
      return q;
    },
  },
  {
    name: 'updateQuest',
    title: 'Update a quest',
    description: "Add a progress note or change a quest's status to completed, failed or abandoned.",
    kind: 'write',
    required: ['questId'],
    properties: {
      questId: S('Quest id, e.g. qst_1a2b3c4d'),
      status: { type: 'string', enum: ['active', 'completed', 'failed', 'abandoned'] },
      progressNote: S('What just happened with this quest'),
      title: S('Title'), description: S('Description'), giver: S('Giver'), reward: S('Reward'),
    },
    run: async (a, { campaign: c, emit }) => {
      const q = c.quests.find((x) => x.id === a.questId);
      if (!q) throw new HttpError(404, 'No such quest. Use getCampaign to see quest ids.');
      if (a.status !== undefined) {
        if (!['active', 'completed', 'failed', 'abandoned'].includes(a.status)) throw bad('"status" must be active, completed, failed or abandoned.');
        q.status = a.status;
      }
      for (const [k, max] of Object.entries({ title: 120, description: 2000, giver: 100, reward: 300 })) {
        if (a[k] !== undefined) q[k] = text(a[k], k, { max }) ?? null;
      }
      if (a.progressNote) q.progress.push(text(a.progressNote, 'progressNote', { max: 500 }));
      emit('quest', `Quest "${q.title}"${a.status ? ` → ${a.status}` : ''}${a.progressNote ? `: ${a.progressNote}` : ''}`, { id: q.id, status: q.status });
      return q;
    },
  },
  {
    name: 'addNpc',
    title: 'Remember an NPC',
    description: 'Save a named NPC the character met so they stay consistent across sessions.',
    kind: 'write',
    required: ['name'],
    properties: { name: S('Name'), description: S('Looks, voice, role'), location: S('Where found'), attitude: S('friendly / neutral / hostile / etc.'), notes: S('Secrets, motives, history') },
    run: async (a, { campaign: c, emit }) => {
      const n = {
        id: newId('npc'),
        name: text(a.name, 'name', { required: true, max: 100 }),
        description: text(a.description, 'description', { max: 1000 }) ?? null,
        location: text(a.location, 'location', { max: 200 }) ?? null,
        attitude: text(a.attitude, 'attitude', { max: 60 }) ?? 'neutral',
        notes: text(a.notes, 'notes', { max: 2000 }) ?? null,
        alive: true,
      };
      c.npcs.push(n);
      emit('npc', `NPC recorded: ${n.name} (${n.attitude})${n.location ? ` at ${n.location}` : ''}`, { id: n.id });
      return n;
    },
  },
  {
    name: 'updateNpc',
    title: 'Update an NPC',
    description: "Change an NPC's attitude, location, notes, or mark them dead.",
    kind: 'write',
    required: ['npcId'],
    properties: {
      npcId: S('NPC id, e.g. npc_1a2b3c4d'),
      name: S('Name'), description: S('Description'), location: S('Location'), attitude: S('Attitude'),
      notes: S('Replace notes'), appendNotes: S('Add a note'), alive: B('Alive?'),
    },
    run: async (a, { campaign: c, emit }) => {
      const n = c.npcs.find((x) => x.id === a.npcId);
      if (!n) throw new HttpError(404, 'No such NPC. Use getCampaign to see NPC ids.');
      for (const [k, max] of Object.entries({ name: 100, description: 1000, location: 200, attitude: 60, notes: 2000 })) {
        if (a[k] !== undefined) n[k] = text(a[k], k, { max }) ?? null;
      }
      if (a.appendNotes) n.notes = [n.notes, text(a.appendNotes, 'appendNotes', { max: 500 })].filter(Boolean).join('\n');
      if (a.alive !== undefined) n.alive = Boolean(a.alive);
      const { campaignId: _c, npcId: _n, ...changes } = a;
      emit('npc', `NPC ${n.name} updated: ${Object.keys(changes).join(', ')}`, changes);
      return n;
    },
  },
  {
    name: 'addJournalEntry',
    title: 'Write to the adventure journal',
    description: "Save a short summary of what just happened (scene end, big decision, discovery). This is the campaign's long-term memory. Optionally updates current location/date.",
    kind: 'write',
    required: ['entry'],
    properties: { entry: S('Summary, 1-5 sentences'), location: S('Current location'), inGameDate: S('In-world date/time') },
    run: async (a, { campaign: c, emit }) => {
      const e = {
        id: newId('jrn'),
        at: now(),
        inGameDate: text(a.inGameDate, 'inGameDate', { max: 100 }) ?? c.inGameDate,
        location: text(a.location, 'location', { max: 200 }) ?? c.location,
        entry: text(a.entry, 'entry', { required: true, max: 4000 }),
      };
      if (a.location) c.location = e.location;
      if (a.inGameDate) c.inGameDate = e.inGameDate;
      c.journal.push(e);
      emit('journal', e.entry, { location: e.location, inGameDate: e.inGameDate });
      return e;
    },
  },
  {
    name: 'getJournal',
    title: 'Read the adventure journal',
    description: 'Read older journal entries (newest last). Use offset to page further back.',
    kind: 'read',
    properties: { limit: I('Default 30', { minimum: 1, maximum: 200 }), offset: I('Skip this many of the newest entries', { minimum: 0 }) },
    run: async (a, { campaign: c }) => {
      const limit = int(a.limit, 'limit', { min: 1, max: 200 }) ?? 30;
      const offset = int(a.offset, 'offset', { min: 0 }) ?? 0;
      const end = c.journal.length - offset;
      return { total: c.journal.length, entries: c.journal.slice(Math.max(0, end - limit), Math.max(0, end)) };
    },
  },
  {
    name: 'startCombat',
    title: 'Start combat',
    description: 'Start an encounter: enemies (plus party members and NPC allies) with AC, HP, attacks, XP. Rolls initiative for all. Returns balanceCheck: obey it before round 1. addToExisting adds reinforcements.',
    kind: 'write',
    required: ['enemies'],
    properties: {
      enemies: { type: 'array', items: combatantSchema, description: 'Foes. May be empty only when addToExisting just adds party members.' },
      includeParty: B('Every playable party member joins the fight alongside the lead'),
      partyMembers: list('Ids of the party members who join (from getCampaign party)'),
      allies: { type: 'array', items: combatantSchema, description: 'Friendly NPCs/companions fighting alongside' },
      playerInitiative: I('Use if the player rolled initiative themselves'),
      playerInitiativeBonus: I('Extra initiative bonus (e.g. Alert feat)'),
      addToExisting: B('Add these to the current fight'),
    },
    run: async (a, { campaign: c, emit }) => {
      const r = startCombat(c, a);
      emit('combat', `${a.addToExisting ? 'Joined combat' : 'Combat started'}: ${r.initiativeOrder.map((x) => `${x.name} ${x.initiative}`).join(', ')} (balance: ${r.balanceCheck.rating})`, { round: r.round, order: r.initiativeOrder.map((x) => ({ id: x.id, name: x.name, initiative: x.initiative })) });
      return r;
    },
  },
  {
    name: 'getCombat',
    title: 'Get combat state',
    description: 'Current round, whose turn it is, initiative order, HP and conditions of every combatant.',
    kind: 'read',
    properties: {},
    run: async (a, { campaign: c }) => combatView(c) ?? { active: false },
  },
  {
    name: 'combatAttack',
    title: 'Resolve an attack',
    description: 'Roll an attack between combatants (ids from combat state; lead is "player", party members use their id). Rolls to hit vs AC, rolls damage (crits doubled), applies it. Hero attacks need damageDice or damage.',
    kind: 'write',
    required: ['attackerId', 'targetId'],
    properties: {
      attackerId: S('Combatant id or "player"'),
      targetId: S('Combatant id or "player"'),
      attackName: S("Monster attack name, or the player's weapon/spell name"),
      advantage,
      ability: ability('Player only: attack ability (default str; dex for finesse/ranged)'),
      damageDice: S('Player only: weapon dice, e.g. "1d8"; ability mod is added'),
      proficient: B('Player only, default true'),
      bonus: I('Player only: extra to-hit bonus (magic weapon, Archery style)'),
      toHit: I('Override total attack bonus (e.g. spell attack)'),
      damage: S('Override full damage expression, e.g. "1d10" for Fire Bolt'),
      targetHelplessWithin5ft: B('Target is the unconscious player within 5 ft (auto-crit)'),
    },
    run: async (a, { campaign: c, emit }) => {
      const r = combatAttack(c, a);
      emit('combat', `${r.attacker} → ${r.target} (${r.attack}): ${r.total} vs AC ${r.targetArmorClass} ${r.hit ? `HIT${r.critical ? ' (CRIT)' : ''} for ${r.damageDealt}${r.targetStatus ? `, ${r.target} HP ${r.targetStatus.hp}/${r.targetStatus.maxHp}` : ''}` : 'miss'}`, { natural: r.d20.natural, total: r.total, hit: r.hit, critical: r.critical, damage: r.damageDealt ?? 0 });
      return r;
    },
  },
  {
    name: 'adjustCombatant',
    title: 'Damage, heal or set conditions',
    description: "Apply damage/healing that isn't a normal attack (save spells, traps, potions), add/remove conditions, or mark an enemy as fled/surrendered (defeated).",
    kind: 'write',
    required: ['combatantId'],
    properties: {
      combatantId: S('Combatant id or "player"'),
      type: { type: 'string', enum: ['damage', 'heal', 'temp'] },
      amount: I('HP amount', { minimum: 0 }),
      reason: S('e.g. "Burning Hands, failed DEX save"'),
      addCondition: S('e.g. prone, frightened'),
      removeCondition: S('Condition to remove'),
      defeated: B('Enemies only: remove from (true) or return to (false) the fight'),
    },
    run: async (a, { campaign: c, emit }) => {
      const r = adjustCombatant(c, a.combatantId, a);
      const what = [a.amount !== undefined ? `${a.type ?? 'damage'} ${a.amount}` : null, a.addCondition ? `+${a.addCondition}` : null, a.removeCondition ? `-${a.removeCondition}` : null, a.defeated !== undefined ? (a.defeated ? 'out of the fight' : 'back in the fight') : null].filter(Boolean).join(', ');
      emit('combat', `${r.combatant}: ${what}${a.reason ? ` (${a.reason})` : ''}${r.status ? ` → HP ${r.status.hp}/${r.status.maxHp}` : ''}`, { amount: a.amount ?? null, type: a.type ?? null });
      return r;
    },
  },
  {
    name: 'nextTurn',
    title: 'Advance to the next turn',
    description: 'End the current turn and move to the next combatant in initiative order (skips defeated enemies). Tells you whose turn it is.',
    kind: 'write',
    properties: {},
    run: async (a, { campaign: c }) => nextTurn(c),
  },
  {
    name: 'endCombat',
    title: 'End combat and award XP',
    description: 'Finish the encounter. Awards XP for defeated enemies (or xpOverride) and reports if the character can level up.',
    kind: 'write',
    properties: { xpOverride: I('Award this XP instead') },
    run: async (a, { campaign: c, emit }) => {
      const r = endCombat(c, a);
      emit('combat', `Combat ended after ${r.rounds} round(s): defeated ${r.defeated.join(', ') || 'none'}; survivors ${r.survivors.join(', ') || 'none'}`, { party: r.party, xpByCharacter: r.xpByCharacter, totalXp: r.totalXp });
      return r;
    },
  },
  {
    name: 'recordEvent',
    title: 'Record a story event in the ledger',
    description: 'Permanently record a consequential non-dice outcome the moment it happens: decision, deal, money, discovery, scene outcome, XP-eligible milestone, canon fact or correction. Dice, HP, items and XP log themselves.',
    kind: 'write',
    required: ['type', 'summary'],
    properties: {
      type: { type: 'string', enum: ['scene', 'decision', 'deal', 'money', 'discovery', 'milestone', 'fact', 'correction', 'other'] },
      summary: S('One factual sentence: who did what, with exact names and numbers'),
      details: S('Optional extra facts (amounts, terms, conditions, what remains unresolved)'),
      participants: list('Characters involved (names or ids) — matters for later XP attribution'),
      xpEligible: B('True if this is an active achievement that may earn XP under the campaign rules'),
      amount: { type: 'number', description: 'Money involved, if any (positive received, negative spent)' },
      currency: S('Currency of amount, e.g. gp, SOC, credits'),
      unresolved: B('True if the outcome is still pending/unverified'),
    },
    run: async (a, { campaign: c, emit }) => {
      const type = text(a.type, 'type', { required: true, max: 20 });
      const summary = text(a.summary, 'summary', { required: true, max: 1000 });
      const data = {};
      if (a.details) data.details = text(a.details, 'details', { max: 4000 });
      if (Array.isArray(a.participants)) data.participants = a.participants.slice(0, 20).map((p) => text(p, 'participant', { required: true, max: 100 }));
      if (a.xpEligible !== undefined) data.xpEligible = Boolean(a.xpEligible);
      if (a.amount !== undefined) {
        if (typeof a.amount !== 'number' || !Number.isFinite(a.amount)) throw bad('"amount" must be a number.');
        data.amount = a.amount;
        data.currency = text(a.currency, 'currency', { max: 20 }) ?? null;
      }
      if (a.unresolved !== undefined) data.unresolved = Boolean(a.unresolved);
      emit(type, summary, data);
      return { recorded: true, type, summary, ...data };
    },
  },
  {
    name: 'advanceTime',
    title: 'Advance in-game time',
    description: 'The ONLY way in-game time passes. Moves the campaign clock forward and records it. Refuses to pass the end of the accounting cycle unless allowPastClose is true.',
    kind: 'write',
    required: ['reason'],
    properties: {
      days: I('Whole days to advance', { minimum: 0, maximum: 3650 }),
      hours: I('Extra hours to advance', { minimum: 0, maximum: 23 }),
      reason: S('Why time passes, e.g. "travel to Anubis", "long rest"'),
      allowPastClose: B('Explicitly allow moving beyond the cycle close (only after the player agrees)'),
    },
    run: async (a, { campaign: c, emit }) => {
      const clock = c.clock;
      if (!clock) throw bad('This campaign has no clock yet. Set it with setClock (player-confirmed).');
      const days = int(a.days, 'days', { min: 0, max: 3650 }) ?? 0;
      const hours = int(a.hours, 'hours', { min: 0, max: 23 }) ?? 0;
      if (!days && !hours) throw bad('Give days and/or hours to advance.');
      const reason = text(a.reason, 'reason', { required: true, max: 300 });
      const totalHours = (clock.hour ?? 0) + hours;
      const newDay = clock.day + days + Math.floor(totalHours / 24);
      if (clock.cycleLength && newDay > clock.cycleLength && !a.allowPastClose) {
        throw bad(`That would pass Day ${clock.cycleLength}/${clock.cycleLength}, the mandatory cycle close. Close/reconcile the cycle first, or ask the player and pass allowPastClose: true.`);
      }
      const before = clock.label ?? `Day ${clock.day}/${clock.cycleLength}`;
      clock.day = newDay;
      clock.hour = totalHours % 24;
      clock.label = `Day ${clock.day}${clock.cycleLength ? `/${clock.cycleLength}` : ''}${clock.hour ? ` +${clock.hour}h` : ''}`;
      emit('time', `Time advances ${days ? `${days} day(s)` : ''}${days && hours ? ' ' : ''}${hours ? `${hours} hour(s)` : ''} (${reason}): ${before} → ${clock.label}`, { days, hours, reason, day: clock.day, hour: clock.hour });
      return { clock, closeDue: Boolean(clock.cycleLength && clock.day >= clock.cycleLength) };
    },
  },
  {
    name: 'setClock',
    title: 'Set or correct the campaign clock',
    description: 'Set the clock only when the player explicitly confirms or orders it (e.g. confirming an unverified clock, starting a new accounting cycle). Always recorded with the reason.',
    kind: 'write',
    required: ['day', 'reason'],
    properties: {
      day: I('Current day number', { minimum: 0 }),
      cycleLength: I('Days per accounting cycle, e.g. 28'),
      reason: S('Why, e.g. "player confirmed Day 3/28", "player ordered new cycle"'),
      verified: B('True when the player has confirmed this value'),
      note: S('Optional note shown with the clock'),
    },
    run: async (a, { campaign: c, emit }) => {
      const before = c.clock?.label ?? 'unset';
      const day = int(a.day, 'day', { required: true, min: 0, max: 100000 });
      const cycleLength = int(a.cycleLength, 'cycleLength', { min: 1, max: 1000 }) ?? c.clock?.cycleLength ?? null;
      c.clock = {
        day,
        hour: 0,
        cycleLength,
        label: `Day ${day}${cycleLength ? `/${cycleLength}` : ''}`,
        verified: a.verified === undefined ? true : Boolean(a.verified),
        note: text(a.note, 'note', { max: 500 }) ?? null,
      };
      const reason = text(a.reason, 'reason', { required: true, max: 300 });
      emit('time', `Clock set: ${before} → ${c.clock.label}${c.clock.verified ? ' (verified)' : ' (UNVERIFIED)'} — ${reason}`, { ...c.clock, reason });
      return { clock: c.clock };
    },
  },
  {
    name: 'getHandoff',
    title: 'Load the exact live state to resume',
    description: 'Call at the start of every conversation (after getDmGuide) and whenever unsure. Exact clock, scene, every character\'s HP/XP/conditions, combat, open threads, DM notes and the latest ledger events. Never resume from memory.',
    kind: 'read',
    properties: { recentEvents: I('How many recent ledger events to include (default 25)', { minimum: 0, maximum: 100 }) },
    run: async (a, { campaign: c, store }) => {
      const n = int(a.recentEvents, 'recentEvents', { min: 0, max: 100 }) ?? 25;
      const recent = n ? (await store.getEvents(c.id, { limit: n, newestFirst: true })).reverse() : [];
      const brief = (ch) => ch && ({
        id: ch.id ?? 'player', name: ch.name, level: ch.level, class: ch.class, hp: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp,
        armorClass: ch.armorClass, xp: ch.xp, conditions: ch.conditions, dead: ch.dead,
        spellSlotsLeft: Object.fromEntries(Object.entries(ch.spellSlots ?? {}).map(([l, s]) => [l, `${s.max - s.used}/${s.max}`])),
      });
      const mirrorState = c.mirror?.repo ? await store.getMirrorState(c.id) : null;
      return {
        campaign: { id: c.id, name: c.name, location: c.location, scene: c.scene ?? null, clock: c.clock ?? null, ledgerSeq: c.lastSeq ?? 0 },
        clockWarning: c.clock?.verified === false ? 'Clock is UNVERIFIED: ask the player to confirm it before any time-sensitive play, then setClock.' : undefined,
        characters: [brief(c.character), ...(c.party ?? []).map(brief)].filter(Boolean),
        combat: combatView(c),
        openThreads: (c.quests ?? []).filter((q) => q.status === 'active').map((q) => ({ id: q.id, title: q.title, latest: q.progress.at(-1) ?? null })),
        dmNotes: c.notes,
        recentEvents: recent.map((e) => ({ seq: e.seq, at: e.at, type: e.type, summary: e.summary })),
        mirror: mirrorState ? { repo: c.mirror.repo, path: c.mirror.path, syncedThrough: mirrorState.lastSeq, lastSyncedAt: mirrorState.lastSyncedAt, lastError: mirrorState.lastError } : null,
      };
    },
  },
  {
    name: 'getLedger',
    title: 'Read the event ledger',
    description: 'Read numbered ledger events (oldest first) to check exactly what happened: e.g. all xp-eligible milestones, money, or everything since a given #.',
    kind: 'read',
    properties: {
      afterSeq: I('Only events after this number', { minimum: 0 }),
      beforeSeq: I('Only events before this number', { minimum: 1 }),
      limit: I('Default 50, max 200', { minimum: 1, maximum: 200 }),
      types: list('Filter by type, e.g. ["milestone","xp","money","decision"]'),
    },
    run: async (a, { campaign: c, store }) => {
      const events = await store.getEvents(c.id, {
        afterSeq: int(a.afterSeq, 'afterSeq', { min: 0 }) ?? 0,
        beforeSeq: int(a.beforeSeq, 'beforeSeq', { min: 1 }) ?? null,
        limit: int(a.limit, 'limit', { min: 1, max: 200 }) ?? 50,
        types: Array.isArray(a.types) ? a.types.map(String) : null,
      });
      return { ledgerSeq: c.lastSeq ?? 0, count: events.length, events };
    },
  },
  {
    name: 'checkpoint',
    title: 'Checkpoint: end of scene or session',
    description: 'Call at the end of every scene and before the conversation ends. Records the scene summary, updates the current scene, and immediately mirrors the ledger and live state to GitHub (if configured).',
    kind: 'write',
    required: ['summary'],
    properties: {
      summary: S('2-5 factual sentences: what happened in this scene, decisions made, what is unresolved'),
      scene: S('Where things stand now, for the next conversation to resume from'),
      location: S('Current location'),
    },
    after: async (a, { campaign, ctx }) => {
      if (!campaign.mirror?.repo) return { mirror: 'not configured' };
      const r = await syncCampaign(ctx.store, campaign.id, ctx.github);
      return { mirror: r };
    },
    run: async (a, { campaign: c, emit }) => {
      const summary = text(a.summary, 'summary', { required: true, max: 3000 });
      if (a.scene !== undefined) c.scene = text(a.scene, 'scene', { max: 1000 });
      if (a.location !== undefined) c.location = text(a.location, 'location', { max: 200 });
      emit('checkpoint', summary, { scene: c.scene ?? null, location: c.location ?? null, clock: c.clock?.label ?? null });
      return { checkpoint: true, summary, scene: c.scene ?? null };
    },
  },
];

const PER_CHARACTER = new Set(['updateCharacter', 'changeHp', 'rest', 'awardXp', 'levelUp', 'manageInventory', 'makeCheck']);
const characterId = S('Which character: "player" (default: the lead) or a party member id/name from getCampaign.party');

/** Tool definitions in MCP format. */
export function listTools() {
  return TOOLS.map((t) => {
    const needsCampaign = t.kind !== 'global';
    const perCharacter = PER_CHARACTER.has(t.name) ? { characterId } : {};
    const properties = needsCampaign ? { campaignId, ...perCharacter, ...t.properties } : t.properties;
    const required = [...(needsCampaign ? ['campaignId'] : []), ...(t.required ?? [])];
    return {
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
      annotations: {
        title: t.title,
        readOnlyHint: t.kind === 'read' || t.name === 'getDmGuide' || t.name === 'listCampaigns',
        destructiveHint: t.kind === 'destructive',
        idempotentHint: t.kind === 'read',
        openWorldHint: false,
      },
    };
  });
}

const MAX_ATTEMPTS = 8;

/**
 * Run a tool. Returns { ok: true, data } or { ok: false, error }.
 * store: { list(), get(id), put(campaign), delete(id) } (all async).
 */
export async function callTool(name, args, { store, github = null }) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { ok: false, error: `Unknown tool "${name}".` };
  const a = args && typeof args === 'object' ? args : {};
  try {
    if (tool.kind === 'global') return { ok: true, data: await tool.run(a, { store }) };
    const id = text(a.campaignId, 'campaignId', { required: true, max: 40 });
    // Load, run, save; if another action saved in between, reload and run again on the fresh state.
    // A losing attempt's result (including its dice) is discarded, so nothing is ever half-applied.
    for (let attempt = 1; ; attempt++) {
      const campaign = await store.get(id);
      if (!campaign) throw new HttpError(404, `No campaign "${id}". Use listCampaigns to find the right id.`);
      const rev = campaign.rev ?? 0;
      const events = [];
      const emit = (type, summary, data = null) => events.push({ type, summary: String(summary).slice(0, 2000), data });
      const data = await tool.run(a, { store, campaign, emit });
      if (tool.kind !== 'write') return { ok: true, data };
      campaign.updatedAt = now();
      try {
        const saved = await store.put(campaign, rev, events);
        campaign.lastSeq = saved?.lastSeq ?? campaign.lastSeq;
        const extra = tool.after ? await tool.after(a, { campaign, ctx: { store, github } }) : {};
        return { ok: true, data: { ...data, ...extra, ...(events.length ? { ledger: `recorded #${saved.lastSeq - events.length + 1}${events.length > 1 ? `–#${saved.lastSeq}` : ''}` } : {}) } };
      } catch (e) {
        if (!e?.conflict) throw e;
        if (attempt >= MAX_ATTEMPTS) {
          throw new HttpError(409, 'The campaign is busy with other actions right now. Wait a moment and try again; nothing was changed.');
        }
        await new Promise((r) => setTimeout(r, Math.random() * 25 * attempt));
      }
    }
  } catch (e) {
    if (e instanceof HttpError) return { ok: false, error: e.message };
    console.error(`Tool ${name} failed:`, e);
    return { ok: false, error: 'Internal error while running the tool. Try again; if it keeps failing, tell the player.' };
  }
}
