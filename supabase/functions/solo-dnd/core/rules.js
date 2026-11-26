// Core numbers from the 5e System Reference Document (SRD 5.1, CC-BY-4.0).

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export const SKILLS = {
  acrobatics: 'dex',
  animal_handling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  survival: 'wis',
};

export const CLASSES = {
  barbarian: { hitDie: 12, saves: ['str', 'con'] },
  bard: { hitDie: 8, saves: ['dex', 'cha'] },
  cleric: { hitDie: 8, saves: ['wis', 'cha'] },
  druid: { hitDie: 8, saves: ['int', 'wis'] },
  fighter: { hitDie: 10, saves: ['str', 'con'] },
  monk: { hitDie: 8, saves: ['str', 'dex'] },
  paladin: { hitDie: 10, saves: ['wis', 'cha'] },
  ranger: { hitDie: 10, saves: ['str', 'dex'] },
  rogue: { hitDie: 8, saves: ['dex', 'int'] },
  sorcerer: { hitDie: 6, saves: ['con', 'cha'] },
  warlock: { hitDie: 8, saves: ['wis', 'cha'] },
  wizard: { hitDie: 6, saves: ['int', 'wis'] },
};

// Total XP needed to reach each level (index 0 = level 1).
export const XP_THRESHOLDS = [
  0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000,
  265000, 305000, 355000,
];

export const CONDITIONS = [
  'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious',
];

export const abilityMod = (score) => Math.floor((score - 10) / 2);
export const proficiencyBonus = (level) => 2 + Math.floor((level - 1) / 4);

export function levelForXp(xp) {
  let level = 1;
  for (let i = 0; i < XP_THRESHOLDS.length; i++) if (xp >= XP_THRESHOLDS[i]) level = i + 1;
  return level;
}

export const normalizeKey = (s) => String(s).trim().toLowerCase().replace(/[\s-]+/g, '_');

export function normalizeAbility(a) {
  const key = normalizeKey(a);
  const full = { strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha' };
  return full[key] ?? key;
}

/** Hit points for a character of the given level using fixed (average) HP per level. */
export function averageMaxHp(hitDie, level, conMod) {
  const perLevel = Math.floor(hitDie / 2) + 1;
  return Math.max(1, hitDie + conMod + (level - 1) * Math.max(1, perLevel + conMod));
}

const signed = (n) => (n >= 0 ? `+${n}` : `${n}`);

/** Character with all derived numbers filled in, ready for the GPT to read. */
export function describeCharacter(c) {
  if (!c) return null;
  const pb = proficiencyBonus(c.level);
  const mods = Object.fromEntries(ABILITIES.map((a) => [a, abilityMod(c.abilityScores[a])]));
  const checkBonus = c.checkBonus ?? 0; // e.g. Stone of Good Luck: applies to every ability check
  const saveBonus = c.saveBonus ?? 0; // e.g. Stone of Good Luck / Cloak of Protection: every saving throw
  const savingThrows = Object.fromEntries(
    ABILITIES.map((a) => [a, signed(mods[a] + (c.savingThrowProficiencies.includes(a) ? pb : 0) + saveBonus)]),
  );
  const skillBonus = (s) =>
    mods[SKILLS[s]] + (c.expertise.includes(s) ? pb * 2 : c.skillProficiencies.includes(s) ? pb : 0) + checkBonus;
  const skills = Object.fromEntries(Object.keys(SKILLS).map((s) => [s, signed(skillBonus(s))]));
  const nextXp = XP_THRESHOLDS[c.level] ?? null;
  return {
    ...c,
    derived: {
      proficiencyBonus: pb,
      abilityModifiers: Object.fromEntries(ABILITIES.map((a) => [a, signed(mods[a])])),
      savingThrows,
      skills,
      initiative: signed(mods.dex + checkBonus + (c.initiativeBonus ?? 0)),
      reliableTalent: Boolean(c.reliableTalent),
      passivePerception: 10 + skillBonus('perception') + (c.passiveBonus ?? 0),
      passiveInvestigation: 10 + skillBonus('investigation') + (c.passiveBonus ?? 0),
      spellSaveDc: c.spellcastingAbility ? 8 + pb + mods[c.spellcastingAbility] : null,
      spellAttackBonus: c.spellcastingAbility ? signed(pb + mods[c.spellcastingAbility]) : null,
      xpForNextLevel: nextXp,
      canLevelUp: levelForXp(c.xp) > c.level && c.level < 20,
    },
  };
}
