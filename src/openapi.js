// OpenAPI 3.1 spec for ChatGPT Custom GPT Actions.
// Limits to keep in mind: max 30 operations, operation descriptions <= 300 chars.

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const I = (description, extra = {}) => ({ type: 'integer', description, ...extra });
const B = (description) => ({ type: 'boolean', description });
const strList = (description) => ({ type: 'array', items: { type: 'string' }, description });

const advantage = { type: 'string', enum: ['none', 'advantage', 'disadvantage'], description: 'Roll two d20s and keep the higher (advantage) or lower (disadvantage).' };
const abilityEnum = { type: 'string', enum: ['str', 'dex', 'con', 'int', 'wis', 'cha'] };
const ok = (description) => ({ 200: { description, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } } });
const body = (properties, required = []) => ({
  required: true,
  content: { 'application/json': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } },
});

const campaignId = { name: 'campaignId', in: 'path', required: true, schema: { type: 'string' }, description: 'Campaign id, e.g. cmp_1a2b3c4d.' };
const pathParam = (name, description) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });

const op = (operationId, summary, description, extra = {}) => ({
  operationId,
  summary,
  description,
  'x-openai-isConsequential': false,
  ...extra,
});

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

export function buildSpec(serverUrl) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Solo Adventure Engine',
      version: '1.0.0',
      description: 'Dice, 5e rules math and persistent memory for a solo tabletop RPG run by a GPT dungeon master.',
    },
    servers: [{ url: serverUrl }],
    components: {
      schemas: {},
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/campaigns': {
        get: op('listCampaigns', 'List saved campaigns', 'List all saved campaigns, most recently played first. Call at the start of a chat to find the campaign to resume.', { responses: ok('Campaign list') }),
        post: op('createCampaign', 'Start a new campaign', 'Create a new campaign. Returns its id; use that id in every other call.', {
          requestBody: body({
            name: S('Campaign title'),
            setting: S('World/setting summary the DM should remember.'),
            tone: S('e.g. "grim and gritty", "lighthearted", "horror"'),
            location: S('Starting location'),
            inGameDate: S('In-world date/time, free text'),
            notes: S('DM-only notes: secrets, plans, plot threads.'),
          }, ['name']),
          responses: ok('The new campaign'),
        }),
      },
      '/campaigns/{campaignId}': {
        parameters: [campaignId],
        get: op('getCampaign', 'Load full campaign state', 'Get everything needed to resume play: character sheet with derived bonuses, quests, NPCs, current combat, recent journal and DM notes.', {
          parameters: [{ name: 'journalEntries', in: 'query', required: false, schema: { type: 'integer', minimum: 0, maximum: 50 }, description: 'How many recent journal entries to include (default 10).' }],
          responses: ok('Campaign state'),
        }),
        patch: op('updateCampaign', 'Update campaign details', 'Update location, in-game date, setting, tone or DM notes. Use appendNotes to add a line to the DM notes without rewriting them.', {
          requestBody: body({
            name: S('Title'), setting: S('Setting'), tone: S('Tone'), location: S('Current location'),
            inGameDate: S('In-world date/time'), notes: S('Replace all DM notes'), appendNotes: S('Add a line to the DM notes'),
          }),
          responses: ok('Updated campaign'),
        }),
        delete: op('deleteCampaign', 'Delete a campaign', 'Permanently delete a campaign. Only when the player explicitly asks.', {
          'x-openai-isConsequential': true,
          responses: ok('Deleted'),
        }),
      },
      '/campaigns/{campaignId}/character': {
        parameters: [campaignId],
        put: op('createCharacter', 'Create the player character', 'Create (or replace) the player character. Server computes modifiers, proficiency, HP, saves and skill bonuses. Saving throw proficiencies default from class.', {
          requestBody: body({
            name: S('Character name'),
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
            maxHp: I('Override computed max HP.'),
            speed: I('Default 30'),
            skillProficiencies: strList('e.g. ["stealth","perception"]'),
            expertise: strList('Skills with double proficiency'),
            savingThrowProficiencies: strList('Override class default, e.g. ["dex","int"]'),
            features: strList('Class/race features, feats, traits'),
            spellcastingAbility: { ...abilityEnum, description: 'For casters' },
            spells: strList('Known/prepared spells and cantrips'),
            spellSlots: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Max slots per level, e.g. {"1":2}' },
            gold: I('Starting gold'),
            inventory: { type: 'array', items: { type: 'object', properties: { name: S('Item'), quantity: I('Qty'), notes: S('Stats/notes'), equipped: B('Equipped') } } },
            personality: S('Traits, ideals, bonds, flaws'),
            backstory: S('Backstory'),
          }, ['name', 'class', 'abilityScores']),
          responses: ok('Character sheet'),
        }),
        patch: op('updateCharacter', 'Update the character sheet', 'Change any sheet field. Also: expendSpellSlot (level), goldChange (+/-), addCondition/removeCondition, addFeature, inspiration. Use changeHp for damage/healing.', {
          requestBody: body({
            name: S('Name'), race: S('Race'), subclass: S('Subclass'), background: S('Background'), alignment: S('Alignment'),
            abilityScores: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Only the scores that change, e.g. {"str":16}' },
            armorClass: I('New AC'), speed: I('Speed'), maxHp: I('New max HP'),
            skillProficiencies: strList('Full replacement list'), expertise: strList('Full replacement list'),
            savingThrowProficiencies: strList('Full replacement list'),
            features: strList('Full replacement list'), addFeature: S('Append one feature'),
            spellcastingAbility: { ...abilityEnum, description: 'Casting ability' },
            spells: strList('Full replacement list'),
            spellSlots: { type: 'object', additionalProperties: { type: 'integer' }, description: 'New max slots per level; resets used slots.' },
            expendSpellSlot: I('Spend one slot of this level', { minimum: 1, maximum: 9 }),
            restoreSpellSlot: I('Regain one slot of this level', { minimum: 1, maximum: 9 }),
            goldChange: I('Add (positive) or spend (negative) gold'),
            inspiration: B('Has inspiration'),
            conditions: strList('Full replacement list'), addCondition: S('e.g. poisoned'), removeCondition: S('e.g. poisoned'),
            personality: S('Personality'), backstory: S('Backstory'),
          }),
          responses: ok('Updated character sheet'),
        }),
      },
      '/campaigns/{campaignId}/character/hp': {
        parameters: [campaignId],
        post: op('changeHp', 'Damage or heal the character', 'Apply damage, healing or temporary HP to the player character outside of combatAttack. Handles temp HP, dropping to 0, death save failures and massive damage.', {
          requestBody: body({
            type: { type: 'string', enum: ['damage', 'heal', 'temp'] },
            amount: I('Amount', { minimum: 0 }),
            critical: B('Was it a critical hit (matters at 0 HP)'),
            reason: S('e.g. "fell into a pit"'),
          }, ['type', 'amount']),
          responses: ok('HP result'),
        }),
      },
      '/campaigns/{campaignId}/character/rest': {
        parameters: [campaignId],
        post: op('rest', 'Take a short or long rest', 'Short rest: spend hit dice to heal (server rolls). Long rest: restore HP, spell slots and half of hit dice.', {
          requestBody: body({ type: { type: 'string', enum: ['short', 'long'] }, hitDiceToSpend: I('Short rest only', { minimum: 0 }) }, ['type']),
          responses: ok('Rest result'),
        }),
      },
      '/campaigns/{campaignId}/character/xp': {
        parameters: [campaignId],
        post: op('awardXp', 'Award experience points', 'Give XP for milestones, roleplay or non-combat victories. Response says if the character can level up.', {
          requestBody: body({ amount: I('XP', { minimum: 0 }), reason: S('Why') }, ['amount']),
          responses: ok('XP result'),
        }),
      },
      '/campaigns/{campaignId}/character/level-up': {
        parameters: [campaignId],
        post: op('levelUp', 'Level up the character', 'Raise level by one and add HP (average or rolled). Afterwards add new features/spells with updateCharacter.', {
          requestBody: body({ hpMethod: { type: 'string', enum: ['average', 'roll'] } }),
          responses: ok('Level-up result'),
        }),
      },
      '/campaigns/{campaignId}/character/inventory': {
        parameters: [campaignId],
        post: op('manageInventory', 'Add, remove or equip items', 'Add, remove, equip or unequip an inventory item by name. Use updateCharacter goldChange for money.', {
          requestBody: body({
            action: { type: 'string', enum: ['add', 'remove', 'equip', 'unequip'] },
            name: S('Item name'),
            quantity: I('Default 1', { minimum: 1 }),
            notes: S('Item stats or description, e.g. "1d8 slashing, versatile 1d10"'),
            equipped: B('Equip when adding'),
          }, ['action', 'name']),
          responses: ok('Inventory'),
        }),
      },
      '/campaigns/{campaignId}/roll': {
        parameters: [campaignId],
        post: op('rollDice', 'Roll dice', 'Roll any dice expression fairly, e.g. "1d20+3", "8d6", "4d6kh3", "2d6+1d4-1". Use for NPC/monster saves, damage, random tables. Set count to roll it several times.', {
          requestBody: body({
            expression: S('Dice expression'),
            reason: S('What the roll is for'),
            advantage,
            count: I('Repeat the roll N times (e.g. 6 for ability scores)', { minimum: 1, maximum: 20 }),
          }, ['expression']),
          responses: ok('Roll result with every die shown'),
        }),
      },
      '/campaigns/{campaignId}/checks': {
        parameters: [campaignId],
        post: op('makeCheck', 'Roll a check for the character', 'Roll a skill check, ability check, saving throw, attack, initiative or death save for the player character using their sheet. Give a DC to get success/failure.', {
          requestBody: body({
            kind: { type: 'string', enum: ['skill', 'ability', 'save', 'attack', 'initiative', 'death_save'] },
            skill: S('For kind=skill, e.g. "stealth", "sleight_of_hand"'),
            ability: { ...abilityEnum, description: 'For ability/save/attack, or to override a skill\'s ability' },
            dc: I('Difficulty class (or target AC for attacks)'),
            advantage,
            bonus: I('Extra modifier, e.g. +1d4 from Bless already rolled, or -2'),
            proficient: B('Attack only: proficient with the weapon (default true)'),
            damage: S('Attack only: weapon dice like "1d8"; ability mod added and rolled on hit'),
            reason: S('What the check is for'),
          }, ['kind']),
          responses: ok('Check result'),
        }),
      },
      '/campaigns/{campaignId}/quests': {
        parameters: [campaignId],
        post: op('addQuest', 'Add a quest', 'Record a new quest or plot hook the character has taken on.', {
          requestBody: body({ title: S('Quest title'), description: S('Details'), giver: S('Who gave it'), reward: S('Promised reward') }, ['title']),
          responses: ok('Quest'),
        }),
      },
      '/campaigns/{campaignId}/quests/{questId}': {
        parameters: [campaignId, pathParam('questId', 'Quest id, e.g. qst_1a2b3c4d')],
        patch: op('updateQuest', 'Update a quest', 'Add a progress note or change a quest\'s status to completed, failed or abandoned.', {
          requestBody: body({
            status: { type: 'string', enum: ['active', 'completed', 'failed', 'abandoned'] },
            progressNote: S('What just happened with this quest'),
            title: S('Title'), description: S('Description'), giver: S('Giver'), reward: S('Reward'),
          }),
          responses: ok('Quest'),
        }),
      },
      '/campaigns/{campaignId}/npcs': {
        parameters: [campaignId],
        post: op('addNpc', 'Remember an NPC', 'Save a named NPC the character met so they stay consistent across sessions.', {
          requestBody: body({ name: S('Name'), description: S('Looks, voice, role'), location: S('Where found'), attitude: S('friendly / neutral / hostile / etc.'), notes: S('Secrets, motives, history') }, ['name']),
          responses: ok('NPC'),
        }),
      },
      '/campaigns/{campaignId}/npcs/{npcId}': {
        parameters: [campaignId, pathParam('npcId', 'NPC id, e.g. npc_1a2b3c4d')],
        patch: op('updateNpc', 'Update an NPC', 'Change an NPC\'s attitude, location, notes, or mark them dead.', {
          requestBody: body({
            name: S('Name'), description: S('Description'), location: S('Location'), attitude: S('Attitude'),
            notes: S('Replace notes'), appendNotes: S('Add a note'), alive: B('Alive?'),
          }),
          responses: ok('NPC'),
        }),
      },
      '/campaigns/{campaignId}/journal': {
        parameters: [campaignId],
        post: op('addJournalEntry', 'Write to the adventure journal', 'Save a short summary of what just happened (scene end, big decision, discovery). This is the campaign\'s long-term memory. Optionally updates current location/date.', {
          requestBody: body({ entry: S('Summary, 1-5 sentences'), location: S('Current location'), inGameDate: S('In-world date/time') }, ['entry']),
          responses: ok('Journal entry'),
        }),
        get: op('getJournal', 'Read the adventure journal', 'Read older journal entries (newest last). Use offset to page further back.', {
          parameters: [
            { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 }, description: 'Default 30' },
            { name: 'offset', in: 'query', required: false, schema: { type: 'integer', minimum: 0 }, description: 'Skip this many of the newest entries' },
          ],
          responses: ok('Journal entries'),
        }),
      },
      '/campaigns/{campaignId}/combat': {
        parameters: [campaignId],
        post: op('startCombat', 'Start combat', 'Start an encounter: give enemies (and optional allies) with AC, HP, attacks, XP. Server rolls initiative for everyone incl. the player. Set addToExisting to add reinforcements.', {
          requestBody: body({
            enemies: { type: 'array', items: combatantSchema },
            allies: { type: 'array', items: combatantSchema, description: 'Friendly NPCs/companions fighting alongside' },
            playerInitiative: I('Use if the player rolled initiative themselves'),
            playerInitiativeBonus: I('Extra initiative bonus (e.g. Alert feat)'),
            addToExisting: B('Add these to the current fight'),
          }, ['enemies']),
          responses: ok('Combat state with initiative order'),
        }),
        get: op('getCombat', 'Get combat state', 'Current round, whose turn it is, initiative order, HP and conditions of every combatant.', { responses: ok('Combat state') }),
      },
      '/campaigns/{campaignId}/combat/attack': {
        parameters: [campaignId],
        post: op('combatAttack', 'Resolve an attack', 'Roll an attack between combatants (ids from combat state; player id is "player"). Rolls to hit vs AC, rolls damage (crits doubled), applies it. Player attacks need damageDice or damage.', {
          requestBody: body({
            attackerId: S('Combatant id or "player"'),
            targetId: S('Combatant id or "player"'),
            attackName: S('Monster attack name, or the player\'s weapon/spell name'),
            advantage,
            ability: { ...abilityEnum, description: 'Player only: attack ability (default str; dex for finesse/ranged)' },
            damageDice: S('Player only: weapon dice, e.g. "1d8"; ability mod is added'),
            proficient: B('Player only, default true'),
            bonus: I('Player only: extra to-hit bonus (magic weapon, Archery style)'),
            toHit: I('Override total attack bonus (e.g. spell attack)'),
            damage: S('Override full damage expression, e.g. "1d10" for Fire Bolt'),
            targetHelplessWithin5ft: B('Target is the unconscious player within 5 ft (auto-crit)'),
          }, ['attackerId', 'targetId']),
          responses: ok('Attack result'),
        }),
      },
      '/campaigns/{campaignId}/combat/combatants/{combatantId}': {
        parameters: [campaignId, pathParam('combatantId', 'Combatant id or "player"')],
        post: op('adjustCombatant', 'Damage, heal or set conditions', 'Apply damage/healing that isn\'t a normal attack (spells with saves, traps, potions), add/remove conditions, or mark an enemy as fled/surrendered (defeated).', {
          requestBody: body({
            type: { type: 'string', enum: ['damage', 'heal', 'temp'] },
            amount: I('HP amount', { minimum: 0 }),
            reason: S('e.g. "Burning Hands, failed DEX save"'),
            addCondition: S('e.g. prone, frightened'),
            removeCondition: S('Condition to remove'),
            defeated: B('Enemies only: remove from (true) or return to (false) the fight'),
          }),
          responses: ok('Combatant status and combat state'),
        }),
      },
      '/campaigns/{campaignId}/combat/next-turn': {
        parameters: [campaignId],
        post: op('nextTurn', 'Advance to the next turn', 'End the current turn and move to the next combatant in initiative order (skips defeated enemies). Tells you whose turn it is.', { responses: ok('Combat state') }),
      },
      '/campaigns/{campaignId}/combat/end': {
        parameters: [campaignId],
        post: op('endCombat', 'End combat and award XP', 'Finish the encounter. Awards XP for defeated enemies (or xpOverride) and reports if the character can level up.', {
          requestBody: { required: false, content: { 'application/json': { schema: { type: 'object', properties: { xpOverride: I('Award this XP instead') } } } } },
          responses: ok('Combat summary'),
        }),
      },
    },
  };
}
