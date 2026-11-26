import { roll, rollD20, dieRoll, validateExpression, DiceError, newId } from './dice.js';
import {
  ABILITIES, SKILLS, CLASSES, XP_THRESHOLDS, abilityMod, proficiencyBonus, levelForXp, normalizeKey,
  normalizeAbility, averageMaxHp,
} from './rules.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg) => new HttpError(400, msg);

// ---------- input helpers ----------

export function text(v, name, { required = false, max = 2000 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`"${name}" is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw bad(`"${name}" must be text.`);
  if (v.length > max) throw bad(`"${name}" must be at most ${max} characters.`);
  return v.trim();
}

export function int(v, name, { required = false, min = -1e9, max = 1e9 } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`"${name}" is required.`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw bad(`"${name}" must be a whole number.`);
  if (n < min || n > max) throw bad(`"${name}" must be between ${min} and ${max}.`);
  return n;
}

function textList(v, name, { max = 50 } = {}) {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw bad(`"${name}" must be a list.`);
  if (v.length > max) throw bad(`"${name}" can have at most ${max} entries.`);
  return v.map((x, i) => text(x, `${name}[${i}]`, { required: true, max: 500 }));
}

function abilityList(v, name) {
  const list = textList(v, name);
  if (!list) return undefined;
  return list.map((a) => {
    const k = normalizeAbility(a);
    if (!ABILITIES.includes(k)) throw bad(`Unknown ability "${a}" in ${name}. Use one of ${ABILITIES.join(', ')}.`);
    return k;
  });
}

function skillList(v, name) {
  const list = textList(v, name);
  if (!list) return undefined;
  return [...new Set(list.map((s) => {
    const k = normalizeKey(s);
    if (!SKILLS[k]) throw bad(`Unknown skill "${s}". Use one of ${Object.keys(SKILLS).join(', ')}.`);
    return k;
  }))];
}

export function advantageMode(v) {
  if (v === undefined || v === null || v === '' || v === 'none' || v === false) return 'none';
  if (v === true) return 'advantage';
  if (v === 'advantage' || v === 'disadvantage') return v;
  throw bad('"advantage" must be "advantage", "disadvantage" or "none".');
}

export function safeRoll(expr, opts) {
  try {
    return roll(expr, opts);
  } catch (e) {
    if (e instanceof DiceError) throw bad(e.message);
    throw e;
  }
}

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

// ---------- logging ----------

export function logRoll(campaign, entry) {
  campaign.rollHistory.push({ at: new Date().toISOString(), ...entry });
  if (campaign.rollHistory.length > 100) campaign.rollHistory.splice(0, campaign.rollHistory.length - 100);
}

// ---------- character ----------

function parseScores(input, existing) {
  if (input === undefined) return existing;
  if (typeof input !== 'object' || input === null) throw bad('"abilityScores" must be an object like {"str":15,...}.');
  const out = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(input)) {
    const a = normalizeAbility(k);
    if (!ABILITIES.includes(a)) throw bad(`Unknown ability "${k}".`);
    out[a] = int(v, `abilityScores.${a}`, { required: true, min: 1, max: 30 });
  }
  const missing = ABILITIES.filter((a) => out[a] === undefined);
  if (missing.length) throw bad(`abilityScores is missing: ${missing.join(', ')}.`);
  return out;
}

function parseSpellSlots(input) {
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null) throw bad('"spellSlots" must be an object like {"1": 2, "2": 1}.');
  const out = {};
  for (const [lvl, max] of Object.entries(input)) {
    const l = int(lvl, 'spell slot level', { required: true, min: 1, max: 9 });
    out[l] = { max: int(max, `spellSlots.${l}`, { required: true, min: 0, max: 10 }), used: 0 };
  }
  return out;
}

export function buildCharacter(body) {
  const cls = normalizeKey(text(body.class, 'class', { required: true, max: 60 }));
  const classInfo = CLASSES[cls];
  const level = int(body.level, 'level', { min: 1, max: 20 }) ?? 1;
  const abilityScores = parseScores(body.abilityScores);
  const conMod = abilityMod(abilityScores.con);
  const hitDie = int(body.hitDie, 'hitDie', { min: 4, max: 12 }) ?? classInfo?.hitDie ?? 8;
  const maxHp = int(body.maxHp, 'maxHp', { min: 1, max: 1000 }) ?? averageMaxHp(hitDie, level, conMod);
  const spellcastingAbility = body.spellcastingAbility ? normalizeAbility(body.spellcastingAbility) : null;
  if (spellcastingAbility && !ABILITIES.includes(spellcastingAbility)) throw bad('Unknown spellcastingAbility.');

  const character = {
    name: text(body.name, 'name', { required: true, max: 100 }),
    race: text(body.race, 'race', { max: 60 }) ?? 'Human',
    class: cls,
    subclass: text(body.subclass, 'subclass', { max: 60 }) ?? null,
    background: text(body.background, 'background', { max: 60 }) ?? null,
    alignment: text(body.alignment, 'alignment', { max: 40 }) ?? null,
    level,
    xp: int(body.xp, 'xp', { min: 0 }) ?? XP_THRESHOLDS[level - 1],
    abilityScores,
    hitDie,
    hitDiceRemaining: level,
    maxHp,
    hp: maxHp,
    tempHp: 0,
    armorClass: int(body.armorClass, 'armorClass', { min: 1, max: 40 }) ?? 10 + abilityMod(abilityScores.dex),
    speed: int(body.speed, 'speed', { min: 0, max: 200 }) ?? 30,
    savingThrowProficiencies: abilityList(body.savingThrowProficiencies, 'savingThrowProficiencies') ?? classInfo?.saves ?? [],
    skillProficiencies: skillList(body.skillProficiencies, 'skillProficiencies') ?? [],
    expertise: skillList(body.expertise, 'expertise') ?? [],
    features: textList(body.features, 'features') ?? [],
    spellcastingAbility,
    spells: textList(body.spells, 'spells', { max: 100 }) ?? [],
    spellSlots: parseSpellSlots(body.spellSlots) ?? {},
    gold: int(body.gold, 'gold', { min: 0 }) ?? 0,
    inventory: [],
    conditions: [],
    inspiration: false,
    deathSaves: { successes: 0, failures: 0 },
    dead: false,
    personality: text(body.personality, 'personality') ?? null,
    backstory: text(body.backstory, 'backstory', { max: 5000 }) ?? null,
  };
  for (const item of body.inventory ?? []) addItem(character, item);
  return character;
}

export function updateCharacter(c, body) {
  const simpleText = { name: 100, race: 60, subclass: 60, background: 60, alignment: 40, personality: 2000, backstory: 5000 };
  for (const [k, max] of Object.entries(simpleText)) if (body[k] !== undefined) c[k] = text(body[k], k, { max }) ?? null;
  if (body.abilityScores !== undefined) c.abilityScores = parseScores(body.abilityScores, c.abilityScores);
  if (body.armorClass !== undefined) c.armorClass = int(body.armorClass, 'armorClass', { required: true, min: 1, max: 40 });
  if (body.speed !== undefined) c.speed = int(body.speed, 'speed', { required: true, min: 0, max: 200 });
  if (body.maxHp !== undefined) {
    c.maxHp = int(body.maxHp, 'maxHp', { required: true, min: 1, max: 1000 });
    c.hp = Math.min(c.hp, c.maxHp);
  }
  if (body.savingThrowProficiencies !== undefined) c.savingThrowProficiencies = abilityList(body.savingThrowProficiencies, 'savingThrowProficiencies');
  if (body.skillProficiencies !== undefined) c.skillProficiencies = skillList(body.skillProficiencies, 'skillProficiencies');
  if (body.expertise !== undefined) c.expertise = skillList(body.expertise, 'expertise');
  if (body.features !== undefined) c.features = textList(body.features, 'features');
  if (body.addFeature !== undefined) c.features.push(text(body.addFeature, 'addFeature', { required: true, max: 500 }));
  if (body.spells !== undefined) c.spells = textList(body.spells, 'spells', { max: 100 });
  if (body.spellcastingAbility !== undefined) {
    const a = body.spellcastingAbility ? normalizeAbility(body.spellcastingAbility) : null;
    if (a && !ABILITIES.includes(a)) throw bad('Unknown spellcastingAbility.');
    c.spellcastingAbility = a;
  }
  if (body.spellSlots !== undefined) c.spellSlots = parseSpellSlots(body.spellSlots);
  if (body.expendSpellSlot !== undefined) {
    const l = int(body.expendSpellSlot, 'expendSpellSlot', { required: true, min: 1, max: 9 });
    const slot = c.spellSlots[l];
    if (!slot || slot.used >= slot.max) throw bad(`No level ${l} spell slots left.`);
    slot.used += 1;
  }
  if (body.restoreSpellSlot !== undefined) {
    const l = int(body.restoreSpellSlot, 'restoreSpellSlot', { required: true, min: 1, max: 9 });
    const slot = c.spellSlots[l];
    if (slot && slot.used > 0) slot.used -= 1;
  }
  if (body.goldChange !== undefined) {
    const next = c.gold + int(body.goldChange, 'goldChange', { required: true });
    if (next < 0) throw bad(`Not enough gold: has ${c.gold}.`);
    c.gold = next;
  }
  if (body.inspiration !== undefined) c.inspiration = Boolean(body.inspiration);
  if (body.conditions !== undefined) c.conditions = (textList(body.conditions, 'conditions') ?? []).map(normalizeKey);
  if (body.addCondition !== undefined) {
    const cond = normalizeKey(text(body.addCondition, 'addCondition', { required: true, max: 60 }));
    if (!c.conditions.includes(cond)) c.conditions.push(cond);
  }
  if (body.removeCondition !== undefined) {
    const cond = normalizeKey(text(body.removeCondition, 'removeCondition', { required: true, max: 60 }));
    c.conditions = c.conditions.filter((x) => x !== cond);
  }
  return c;
}

export function addItem(c, body) {
  const name = text(body.name, 'name', { required: true, max: 100 });
  const quantity = int(body.quantity, 'quantity', { min: 1, max: 100000 }) ?? 1;
  const existing = c.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.quantity += quantity;
    if (body.notes) existing.notes = text(body.notes, 'notes', { max: 500 });
    if (body.equipped !== undefined) existing.equipped = Boolean(body.equipped);
    return existing;
  }
  const item = {
    id: newId('itm'),
    name,
    quantity,
    notes: text(body.notes, 'notes', { max: 500 }) ?? null,
    equipped: Boolean(body.equipped),
  };
  c.inventory.push(item);
  return item;
}

export function removeItem(c, body) {
  const name = text(body.name, 'name', { required: true, max: 100 });
  const quantity = int(body.quantity, 'quantity', { min: 1, max: 100000 }) ?? 1;
  const idx = c.inventory.findIndex((i) => i.name.toLowerCase() === name.toLowerCase() || i.id === name);
  if (idx < 0) throw new HttpError(404, `"${name}" is not in the inventory.`);
  const item = c.inventory[idx];
  if (quantity > item.quantity) throw bad(`Only ${item.quantity} ${item.name} in inventory.`);
  item.quantity -= quantity;
  if (item.quantity === 0) c.inventory.splice(idx, 1);
  return { ...item };
}

/** Apply damage / healing / temp HP to the player character, with 5e dropping-to-0 rules. */
export function changeCharacterHp(c, { type, amount, critical = false }) {
  const before = { hp: c.hp, tempHp: c.tempHp };
  const notes = [];
  if (c.dead) throw bad(`${c.name} is dead. Use updateCharacter or create a new character.`);

  if (type === 'temp') {
    c.tempHp = Math.max(c.tempHp, amount); // temp HP doesn't stack
    notes.push(`Temporary HP is now ${c.tempHp}.`);
  } else if (type === 'heal') {
    const wasDown = c.hp === 0;
    c.hp = Math.min(c.maxHp, c.hp + amount);
    if (wasDown && c.hp > 0) {
      c.conditions = c.conditions.filter((x) => x !== 'unconscious');
      c.deathSaves = { successes: 0, failures: 0 };
      notes.push(`${c.name} regains consciousness.`);
    }
  } else if (type === 'damage') {
    let remaining = amount;
    const absorbed = Math.min(c.tempHp, remaining);
    c.tempHp -= absorbed;
    remaining -= absorbed;
    if (absorbed) notes.push(`${absorbed} absorbed by temporary HP.`);
    if (c.hp === 0 && remaining > 0) {
      if (remaining >= c.maxHp) {
        c.dead = true;
        notes.push(`Massive damage while down: ${c.name} dies.`);
      } else {
        c.deathSaves.failures += critical ? 2 : 1;
        notes.push(`Damage while at 0 HP: ${critical ? 2 : 1} death save failure(s).`);
      }
    } else if (remaining > 0) {
      const overflow = remaining - c.hp;
      c.hp = Math.max(0, c.hp - remaining);
      if (c.hp === 0) {
        if (overflow >= c.maxHp) {
          c.dead = true;
          notes.push(`Massive damage: ${c.name} is killed outright.`);
        } else {
          if (!c.conditions.includes('unconscious')) c.conditions.push('unconscious');
          c.deathSaves = { successes: 0, failures: 0 };
          notes.push(`${c.name} drops to 0 HP and falls unconscious. Make death saving throws on their turns.`);
        }
      }
    }
    if (c.deathSaves.failures >= 3) {
      c.dead = true;
      notes.push(`Three death save failures: ${c.name} dies.`);
    }
  }
  return { before, after: { hp: c.hp, tempHp: c.tempHp, maxHp: c.maxHp }, dead: c.dead, notes };
}

export function rest(c, { type, hitDiceToSpend = 0 }) {
  const result = { type, notes: [] };
  if (c.dead) throw bad(`${c.name} is dead.`);
  if (type === 'short') {
    const spend = Math.min(hitDiceToSpend, c.hitDiceRemaining);
    if (hitDiceToSpend > c.hitDiceRemaining) result.notes.push(`Only ${c.hitDiceRemaining} hit dice were available.`);
    const conMod = abilityMod(c.abilityScores.con);
    const rolls = [];
    let healed = 0;
    for (let i = 0; i < spend; i++) {
      const r = dieRoll(c.hitDie);
      rolls.push(r);
      healed += Math.max(0, r + conMod);
    }
    c.hitDiceRemaining -= spend;
    const hpChange = changeCharacterHp(c, { type: 'heal', amount: healed });
    Object.assign(result, { hitDiceSpent: spend, rolls, conModifierPerDie: conMod, healed, ...hpChange });
    result.notes.push('Short-rest class features (e.g. Warlock pact slots, Second Wind, Action Surge) recover now.');
  } else {
    c.hp = c.maxHp;
    c.tempHp = 0;
    const regained = Math.max(1, Math.floor(c.level / 2));
    c.hitDiceRemaining = Math.min(c.level, c.hitDiceRemaining + regained);
    for (const slot of Object.values(c.spellSlots)) slot.used = 0;
    c.deathSaves = { successes: 0, failures: 0 };
    c.conditions = c.conditions.filter((x) => x !== 'unconscious');
    Object.assign(result, { hp: c.hp, hitDiceRemaining: c.hitDiceRemaining, spellSlots: c.spellSlots });
    result.notes.push('All HP and spell slots restored; regained up to half your hit dice.');
  }
  return result;
}

export function awardXp(c, amount) {
  c.xp += amount;
  const target = levelForXp(c.xp);
  return {
    awarded: amount,
    xp: c.xp,
    level: c.level,
    canLevelUp: target > c.level && c.level < 20,
    xpForNextLevel: XP_THRESHOLDS[c.level] ?? null,
  };
}

export function levelUp(c, { hpMethod = 'average' }) {
  if (c.level >= 20) throw bad('Already level 20.');
  const conMod = abilityMod(c.abilityScores.con);
  let gain;
  let rolled = null;
  if (hpMethod === 'roll') {
    rolled = dieRoll(c.hitDie);
    gain = Math.max(1, rolled + conMod);
  } else {
    gain = Math.max(1, Math.floor(c.hitDie / 2) + 1 + conMod);
  }
  const oldPb = proficiencyBonus(c.level);
  c.level += 1;
  c.maxHp += gain;
  c.hp += gain;
  c.hitDiceRemaining += 1;
  if (c.xp < XP_THRESHOLDS[c.level - 1]) c.xp = XP_THRESHOLDS[c.level - 1];
  const notes = [`${c.name} is now level ${c.level}.`];
  if (proficiencyBonus(c.level) > oldPb) notes.push(`Proficiency bonus rises to +${proficiencyBonus(c.level)}.`);
  if ([4, 8, 12, 16, 19].includes(c.level)) notes.push('Ability Score Improvement (or a feat) is available: update abilityScores.');
  notes.push('Add new class features, spells and spell slots with updateCharacter.');
  return { level: c.level, hpGained: gain, hpRoll: rolled, maxHp: c.maxHp, notes };
}

// ---------- checks ----------

/** Roll a check for the player character. */
export function characterCheck(c, body) {
  const kind = text(body.kind, 'kind', { required: true, max: 20 });
  const mode = advantageMode(body.advantage);
  const extra = int(body.bonus, 'bonus', { min: -50, max: 50 }) ?? 0;
  const dc = int(body.dc, 'dc', { min: 1, max: 50 });
  const pb = proficiencyBonus(c.level);
  const mod = (a) => abilityMod(c.abilityScores[a]);

  if (kind === 'death_save') {
    if (c.hp > 0 || c.dead) throw bad('Death saves are only for a character at 0 HP who is not dead.');
    const d = rollD20(mode);
    const notes = [];
    if (d.natural === 20) {
      c.hp = 1;
      c.conditions = c.conditions.filter((x) => x !== 'unconscious');
      c.deathSaves = { successes: 0, failures: 0 };
      notes.push(`Natural 20! ${c.name} regains 1 HP and wakes up.`);
    } else if (d.natural === 1) {
      c.deathSaves.failures += 2;
      notes.push('Natural 1: two failures.');
    } else if (d.natural >= 10) c.deathSaves.successes += 1;
    else c.deathSaves.failures += 1;
    if (c.deathSaves.failures >= 3) {
      c.dead = true;
      notes.push(`${c.name} has died.`);
    } else if (c.deathSaves.successes >= 3) {
      notes.push(`${c.name} is stable (still unconscious at 0 HP, regains 1 HP after 1d4 hours).`);
    }
    return { kind, d20: d, deathSaves: { ...c.deathSaves }, hp: c.hp, dead: c.dead, notes };
  }

  let label;
  let modifier;
  const parts = {};
  if (kind === 'skill') {
    const skill = normalizeKey(text(body.skill, 'skill', { required: true, max: 40 }));
    if (!SKILLS[skill]) throw bad(`Unknown skill "${body.skill}". Use one of ${Object.keys(SKILLS).join(', ')}.`);
    const ability = body.ability ? normalizeAbility(body.ability) : SKILLS[skill];
    if (!ABILITIES.includes(ability)) throw bad('Unknown ability.');
    const prof = c.expertise.includes(skill) ? pb * 2 : c.skillProficiencies.includes(skill) ? pb : 0;
    Object.assign(parts, { [ability]: mod(ability), proficiency: prof });
    modifier = mod(ability) + prof;
    label = `${skill.replace(/_/g, ' ')} (${ability}) check`;
  } else if (kind === 'ability' || kind === 'save' || kind === 'attack' || kind === 'initiative') {
    const defaultAbility = kind === 'initiative' ? 'dex' : kind === 'attack' ? 'str' : undefined;
    const ability = normalizeAbility(body.ability ?? defaultAbility ?? '');
    if (!ABILITIES.includes(ability)) throw bad(`"ability" is required for a ${kind} roll: one of ${ABILITIES.join(', ')}.`);
    let prof = 0;
    if (kind === 'save' && c.savingThrowProficiencies.includes(ability)) prof = pb;
    if (kind === 'attack' && body.proficient !== false) prof = pb;
    Object.assign(parts, { [ability]: mod(ability), proficiency: prof });
    modifier = mod(ability) + prof;
    label = kind === 'save' ? `${ability} saving throw` : kind === 'attack' ? `attack roll (${ability})` : kind === 'initiative' ? 'initiative' : `${ability} check`;
  } else {
    throw bad('"kind" must be one of: skill, ability, save, attack, initiative, death_save.');
  }

  if (extra) parts.bonus = extra;
  modifier += extra;
  const d = rollD20(mode);
  const total = d.natural + modifier;
  const result = {
    kind,
    label,
    d20: d,
    modifier: signed(modifier),
    modifierParts: parts,
    total,
    breakdown: `d20(${d.rolls.join(d.mode === 'none' ? '' : '/')}) ${signed(modifier)} = ${total}`,
    natural20: d.natural === 20,
    natural1: d.natural === 1,
  };
  if (dc !== undefined) {
    result.dc = dc;
    result.success = kind === 'attack' ? d.natural === 20 || (d.natural !== 1 && total >= dc) : total >= dc;
  }
  if (kind === 'attack' && body.damage) {
    const hit = result.success ?? true;
    if (hit) {
      const dmgExpr = `${body.damage}${body.addAbilityToDamage === false ? '' : signed(mod(normalizeAbility(body.ability ?? 'str')))}`;
      result.damage = safeRoll(dmgExpr, { critical: d.natural === 20 });
    }
  }
  if (c.conditions.length) result.activeConditions = c.conditions;
  return result;
}

// ---------- combat ----------

function parseAttacks(list, name) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw bad(`"${name}" must be a list.`);
  return list.slice(0, 10).map((a, i) => {
    const attack = {
      name: text(a.name, `${name}[${i}].name`, { max: 60 }) ?? 'Attack',
      toHit: int(a.toHit, `${name}[${i}].toHit`, { required: true, min: -10, max: 30 }),
      damage: text(a.damage, `${name}[${i}].damage`, { required: true, max: 60 }),
      damageType: text(a.damageType, `${name}[${i}].damageType`, { max: 30 }) ?? null,
    };
    try {
      validateExpression(attack.damage);
    } catch (e) {
      throw bad(`${name}[${i}].damage: ${e.message}`);
    }
    return attack;
  });
}

function buildCombatant(body, side, i) {
  const label = `${side === 'enemy' ? 'enemies' : 'allies'}[${i}]`;
  const maxHp = int(body.maxHp ?? body.hp, `${label}.maxHp`, { required: true, min: 1, max: 5000 });
  const count = int(body.count, `${label}.count`, { min: 1, max: 20 }) ?? 1;
  const base = text(body.name, `${label}.name`, { required: true, max: 60 });
  return Array.from({ length: count }, (_, n) => ({
    id: newId(side === 'enemy' ? 'foe' : 'ally'),
    name: count > 1 ? `${base} ${n + 1}` : base,
    side,
    armorClass: int(body.armorClass, `${label}.armorClass`, { required: true, min: 1, max: 40 }),
    maxHp,
    hp: maxHp,
    initiativeBonus: int(body.initiativeBonus, `${label}.initiativeBonus`, { min: -10, max: 20 }) ?? 0,
    attacks: parseAttacks(body.attacks, `${label}.attacks`),
    xp: int(body.xp, `${label}.xp`, { min: 0, max: 1000000 }) ?? 0,
    notes: text(body.notes, `${label}.notes`, { max: 500 }) ?? null,
    conditions: [],
    defeated: false,
  }));
}

function rollInitiativeFor(combatant) {
  const natural = dieRoll(20);
  combatant.initiative = natural + combatant.initiativeBonus;
  combatant.initiativeRoll = natural;
}

function sortOrder(combat) {
  combat.order.sort((a, b) => {
    const ca = combat.combatants.find((x) => x.id === a);
    const cb = combat.combatants.find((x) => x.id === b);
    return cb.initiative - ca.initiative || cb.initiativeBonus - ca.initiativeBonus;
  });
}

// ---------- solo balance ----------

// Rough XP budgets for a *single* character (per-level guide, tuned toward the gentle side).
const SOLO_BUDGET = { routine: [25, 50, 75, 125, 250, 300, 350, 450, 550, 600, 800, 1000, 1100, 1250, 1400, 1600, 2000, 2100, 2400, 2800] };
SOLO_BUDGET.tough = SOLO_BUDGET.routine.map((x) => x * 2);
SOLO_BUDGET.deadly = SOLO_BUDGET.routine.map((x) => x * 4);

function averageDamage(expr, critical = false) {
  try {
    return roll(expr, { roller: (sides) => (sides + 1) / 2, critical }).total;
  } catch {
    return 0;
  }
}

/** Estimate how dangerous the active enemies are for one character, so the DM can adjust before round 1. */
export function balanceCheck(campaign) {
  const c = campaign.character;
  const foes = campaign.combat.combatants.filter((x) => x.side === 'enemy' && !x.defeated);
  const allies = campaign.combat.combatants.filter((x) => x.side === 'ally' && !x.defeated).length;
  const rawXp = foes.reduce((sum, f) => sum + f.xp, 0);
  const n = foes.length;
  const multiplier = n <= 1 ? 1 : n === 2 ? 1.5 : n <= 6 ? 2 : n <= 10 ? 2.5 : 3;
  const adjustedXp = Math.round(rawXp * multiplier);
  const lvl = Math.min(20, c.level) - 1;
  const rating = adjustedXp > SOLO_BUDGET.deadly[lvl] ? 'deadly'
    : adjustedXp > SOLO_BUDGET.tough[lvl] ? 'hard'
      : adjustedXp > SOLO_BUDGET.routine[lvl] ? 'tough' : 'routine';

  // Worst case for one round: every foe hits with its strongest attack, on average damage.
  const worstRound = Math.round(foes.reduce((sum, f) => sum + Math.max(0, ...f.attacks.map((a) => averageDamage(a.damage))), 0));
  const biggestHit = Math.round(Math.max(0, ...foes.flatMap((f) => f.attacks.map((a) => averageDamage(a.damage, true)))));
  const warnings = [];
  if (rating === 'deadly') warnings.push('Encounter XP is far above a solo budget. Remove foes, weaken them, or give the player a clear escape/parley option.');
  if (worstRound >= c.hp) warnings.push(`If every foe hits this round they average ${worstRound} damage, which would drop ${c.name} (${c.hp} HP) in one round.`);
  else if (worstRound > c.maxHp / 2) warnings.push(`One bad round averages ${worstRound} damage, more than half of ${c.name}'s max HP.`);
  if (biggestHit >= c.maxHp && c.level <= 4) warnings.push(`A single critical hit (~${biggestHit}) could take ${c.name} from full HP to 0.`);
  if (n > 3 && allies === 0) warnings.push(`${n} enemies against one hero: action economy heavily favours the foes. Consider fewer foes or an ally.`);
  if (!foes.some((f) => f.xp > 0)) warnings.push('No enemy has an xp value, so the difficulty rating is unreliable.');

  return {
    rating,
    enemyXp: rawXp,
    adjustedXp,
    soloBudget: { routine: SOLO_BUDGET.routine[lvl], tough: SOLO_BUDGET.tough[lvl], deadly: SOLO_BUDGET.deadly[lvl] },
    worstCaseRoundDamage: worstRound,
    characterHp: `${c.hp}/${c.maxHp}`,
    warnings,
    advice: rating === 'deadly' || worstRound >= c.hp
      ? 'Too dangerous for a solo hero. Before narrating round 1, fix it: remove or weaken foes with adjustCombatant, add an ally, or turn it into a parley/chase with a clear escape.'
      : warnings.length
        ? 'Fair but risky. Fine to run; have enemies fight smart but not cruelly, and let them flee or surrender when bloodied.'
        : 'Balance looks fair for a solo hero.',
  };
}

export function startCombat(campaign, body) {
  const c = campaign.character;
  if (!c) throw bad('Create a character before starting combat.');
  const enemies = body.enemies;
  if (!Array.isArray(enemies) || enemies.length === 0) throw bad('"enemies" must be a non-empty list.');
  const newcomers = [
    ...enemies.flatMap((e, i) => buildCombatant(e, 'enemy', i)),
    ...(Array.isArray(body.allies) ? body.allies.flatMap((a, i) => buildCombatant(a, 'ally', i)) : []),
  ];
  if (newcomers.length > 30) throw bad('At most 30 combatants.');

  if (campaign.combat) {
    if (!body.addToExisting) throw bad('Combat is already running. Pass "addToExisting": true to add reinforcements, or end it first.');
    const current = campaign.combat.order[campaign.combat.turnIndex];
    for (const n of newcomers) {
      rollInitiativeFor(n);
      campaign.combat.combatants.push(n);
      campaign.combat.order.push(n.id);
    }
    sortOrder(campaign.combat);
    campaign.combat.turnIndex = campaign.combat.order.indexOf(current);
    return { ...combatView(campaign), balanceCheck: balanceCheck(campaign) };
  }

  const player = {
    id: 'player',
    name: c.name,
    side: 'player',
    initiativeBonus: abilityMod(c.abilityScores.dex) + (int(body.playerInitiativeBonus, 'playerInitiativeBonus', { min: -10, max: 20 }) ?? 0),
    conditions: [],
  };
  const all = [player, ...newcomers];
  all.forEach(rollInitiativeFor);
  if (body.playerInitiative !== undefined) {
    player.initiative = int(body.playerInitiative, 'playerInitiative', { min: -10, max: 50 });
    player.initiativeRoll = null;
  }
  campaign.combat = {
    round: 1,
    turnIndex: 0,
    combatants: all,
    order: all.map((x) => x.id),
    log: [],
    startedAt: new Date().toISOString(),
  };
  sortOrder(campaign.combat);
  return { ...combatView(campaign), balanceCheck: balanceCheck(campaign) };
}

function getCombat(campaign) {
  if (!campaign.combat) throw bad('No combat is running. Start one with startCombat.');
  return campaign.combat;
}

function findCombatant(combat, id, label) {
  const key = String(id ?? '').toLowerCase();
  const c = combat.combatants.find((x) => x.id === id || x.name.toLowerCase() === key);
  if (!c) throw new HttpError(404, `No combatant "${id}" (${label}). Use ids from the combat state.`);
  return c;
}

function combatantHp(campaign, combatant) {
  if (combatant.side === 'player') return { hp: campaign.character.hp, maxHp: campaign.character.maxHp, armorClass: campaign.character.armorClass };
  return { hp: combatant.hp, maxHp: combatant.maxHp, armorClass: combatant.armorClass };
}

export function combatView(campaign) {
  const combat = campaign.combat;
  if (!combat) return null;
  const currentId = combat.order[combat.turnIndex];
  const current = combat.combatants.find((x) => x.id === currentId);
  const ch = campaign.character;
  return {
    round: combat.round,
    currentTurn: { id: current.id, name: current.name, side: current.side },
    initiativeOrder: combat.order.map((id) => {
      const x = combat.combatants.find((y) => y.id === id);
      const status = x.side === 'player'
        ? { hp: ch.hp, maxHp: ch.maxHp, tempHp: ch.tempHp, armorClass: ch.armorClass, conditions: ch.conditions, dead: ch.dead }
        : { hp: x.hp, maxHp: x.maxHp, armorClass: x.armorClass, conditions: x.conditions, defeated: x.defeated, attacks: x.attacks, notes: x.notes };
      return { id: x.id, name: x.name, side: x.side, initiative: x.initiative, ...status };
    }),
    recentEvents: combat.log.slice(-8),
    enemiesRemaining: combat.combatants.filter((x) => x.side === 'enemy' && !x.defeated).length,
  };
}

function applyDamageToCombatant(campaign, target, { type, amount, critical }) {
  if (target.side === 'player') {
    const r = changeCharacterHp(campaign.character, { type, amount, critical });
    return { hp: r.after.hp, maxHp: r.after.maxHp, notes: r.notes, dead: r.dead };
  }
  const notes = [];
  if (type === 'heal') {
    target.hp = Math.min(target.maxHp, target.hp + amount);
    if (target.hp > 0 && target.defeated) {
      target.defeated = false;
      notes.push(`${target.name} is back on their feet.`);
    }
  } else {
    target.hp = Math.max(0, target.hp - amount);
    if (target.hp === 0 && !target.defeated) {
      target.defeated = true;
      notes.push(`${target.name} is defeated.`);
    }
  }
  return { hp: target.hp, maxHp: target.maxHp, defeated: target.defeated, notes };
}

function combatLog(combat, message) {
  combat.log.push(`R${combat.round}: ${message}`);
  if (combat.log.length > 60) combat.log.splice(0, combat.log.length - 60);
}

export function combatAttack(campaign, body) {
  const combat = getCombat(campaign);
  const attacker = findCombatant(combat, body.attackerId, 'attackerId');
  const target = findCombatant(combat, body.targetId, 'targetId');
  if (target.side !== 'player' && target.defeated) throw bad(`${target.name} is already defeated.`);
  const mode = advantageMode(body.advantage);
  const ch = campaign.character;

  let toHit;
  let damageExpr;
  let attackName;
  const overrideToHit = int(body.toHit, 'toHit', { min: -10, max: 30 });
  const overrideDamage = text(body.damage, 'damage', { max: 60 });

  if (attacker.side === 'player') {
    const ability = normalizeAbility(body.ability ?? 'str');
    if (!ABILITIES.includes(ability)) throw bad('Unknown ability.');
    const m = abilityMod(ch.abilityScores[ability]);
    const prof = body.proficient === false ? 0 : proficiencyBonus(ch.level);
    toHit = overrideToHit ?? m + prof + (int(body.bonus, 'bonus', { min: -20, max: 20 }) ?? 0);
    attackName = text(body.attackName, 'attackName', { max: 60 }) ?? 'Attack';
    if (overrideDamage) damageExpr = overrideDamage;
    else {
      const dice = text(body.damageDice, 'damageDice', { max: 40 });
      if (!dice) throw bad('For the player\'s attack give "damageDice" (e.g. "1d8") or a full "damage" expression.');
      damageExpr = `${dice}${signed(m)}`;
    }
  } else {
    const attacks = attacker.attacks ?? [];
    const named = body.attackName ? attacks.find((a) => a.name.toLowerCase() === String(body.attackName).toLowerCase()) : attacks[0];
    if (!named && (overrideToHit === undefined || !overrideDamage)) {
      throw bad(`${attacker.name} has no attack "${body.attackName ?? ''}". Give "toHit" and "damage", or use one of: ${attacks.map((a) => a.name).join(', ') || 'none'}.`);
    }
    toHit = overrideToHit ?? named.toHit;
    damageExpr = overrideDamage ?? named.damage;
    attackName = named?.name ?? text(body.attackName, 'attackName', { max: 60 }) ?? 'Attack';
  }

  const { armorClass } = combatantHp(campaign, target);
  const d = rollD20(mode);
  const total = d.natural + toHit;
  const critical = d.natural === 20;
  // Attacks against an unconscious target within 5 ft are automatic crits in 5e; let the GPT flag it.
  const autoCrit = Boolean(body.targetHelplessWithin5ft) && target.side === 'player' && ch.hp === 0;
  const hit = critical || (d.natural !== 1 && total >= armorClass);
  const result = {
    attacker: attacker.name,
    target: target.name,
    attack: attackName,
    d20: d,
    toHit: signed(toHit),
    total,
    targetArmorClass: armorClass,
    hit,
    critical: hit && (critical || autoCrit),
  };
  if (hit) {
    const dmg = safeRoll(damageExpr, { critical: result.critical });
    const amount = Math.max(0, dmg.total);
    result.damage = dmg;
    result.damageDealt = amount;
    result.targetStatus = applyDamageToCombatant(campaign, target, { type: 'damage', amount, critical: result.critical });
    combatLog(combat, `${attacker.name} hits ${target.name} with ${attackName} for ${amount}${result.critical ? ' (crit)' : ''}.`);
  } else {
    combatLog(combat, `${attacker.name} misses ${target.name} with ${attackName}${d.natural === 1 ? ' (natural 1)' : ''}.`);
  }
  logRoll(campaign, { reason: `${attacker.name} attacks ${target.name}`, result: `${total} vs AC ${armorClass}: ${hit ? 'hit' : 'miss'}` });
  result.enemiesRemaining = combat.combatants.filter((x) => x.side === 'enemy' && !x.defeated).length;
  if (result.enemiesRemaining === 0) result.hint = 'All enemies are defeated. Call endCombat to award XP.';
  return result;
}

export function adjustCombatant(campaign, combatantId, body) {
  const combat = getCombat(campaign);
  const target = findCombatant(combat, combatantId, 'combatantId');
  const result = { combatant: target.name };
  if (body.amount !== undefined) {
    const type = body.type ?? 'damage';
    if (!['damage', 'heal', 'temp'].includes(type)) throw bad('"type" must be damage, heal or temp.');
    if (type === 'temp' && target.side !== 'player') throw bad('Temporary HP is only tracked for the player character.');
    const amount = int(body.amount, 'amount', { required: true, min: 0, max: 10000 });
    result.status = applyDamageToCombatant(campaign, target, { type, amount, critical: Boolean(body.critical) });
    combatLog(combat, `${target.name} ${type === 'heal' ? 'heals' : type === 'temp' ? 'gains temp HP' : 'takes'} ${amount}${body.reason ? ` (${body.reason})` : ''}.`);
  }
  const conditionsHolder = target.side === 'player' ? campaign.character : target;
  if (body.addCondition) {
    const cond = normalizeKey(text(body.addCondition, 'addCondition', { required: true, max: 60 }));
    if (!conditionsHolder.conditions.includes(cond)) conditionsHolder.conditions.push(cond);
    combatLog(combat, `${target.name} is now ${cond}.`);
  }
  if (body.removeCondition) {
    const cond = normalizeKey(text(body.removeCondition, 'removeCondition', { required: true, max: 60 }));
    conditionsHolder.conditions = conditionsHolder.conditions.filter((x) => x !== cond);
    combatLog(combat, `${target.name} is no longer ${cond}.`);
  }
  if (body.defeated !== undefined && target.side !== 'player') {
    target.defeated = Boolean(body.defeated);
    combatLog(combat, `${target.name} ${target.defeated ? 'is out of the fight (fled, surrendered or defeated)' : 'rejoins the fight'}.`);
  }
  result.conditions = conditionsHolder.conditions;
  result.combat = combatView(campaign);
  return result;
}

export function nextTurn(campaign) {
  const combat = getCombat(campaign);
  const n = combat.order.length;
  for (let step = 0; step < n; step++) {
    combat.turnIndex += 1;
    if (combat.turnIndex >= n) {
      combat.turnIndex = 0;
      combat.round += 1;
    }
    const cur = combat.combatants.find((x) => x.id === combat.order[combat.turnIndex]);
    if (cur.side === 'player' || !cur.defeated) break;
  }
  const view = combatView(campaign);
  const cur = view.currentTurn;
  const ch = campaign.character;
  if (cur.side === 'player') {
    view.hint = ch.hp === 0 && !ch.dead
      ? `${ch.name} is at 0 HP: roll a death save with makeCheck kind "death_save".`
      : `It's ${ch.name}'s turn. Ask the player what they do.`;
  } else {
    view.hint = `It's ${cur.name}'s turn (${cur.side}). Decide its action, then use combatAttack with attackerId "${cur.id}".`;
  }
  return view;
}

export function endCombat(campaign, body) {
  const combat = getCombat(campaign);
  const defeated = combat.combatants.filter((x) => x.side === 'enemy' && x.defeated);
  const computedXp = defeated.reduce((s, x) => s + x.xp, 0);
  const xp = int(body?.xpOverride, 'xpOverride', { min: 0 }) ?? computedXp;
  const summary = {
    rounds: combat.round,
    defeated: defeated.map((x) => x.name),
    survivors: combat.combatants.filter((x) => x.side === 'enemy' && !x.defeated).map((x) => x.name),
    xp: campaign.character.dead ? { awarded: 0 } : awardXp(campaign.character, xp),
    character: { hp: campaign.character.hp, maxHp: campaign.character.maxHp, dead: campaign.character.dead },
  };
  campaign.combat = null;
  return summary;
}
