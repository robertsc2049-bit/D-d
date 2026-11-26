
export class DiceError extends Error {}

const MAX_DICE = 100;
const MAX_SIDES = 1000;

// Cryptographically fair die: integer in [1, sides], using Web Crypto (works in Deno and Node).
// Rejection sampling avoids modulo bias.
function secureDie(sides) {
  const limit = Math.floor(0x100000000 / sides) * sides;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return (buf[0] % sides) + 1;
  }
}

/** Random lowercase hex string with the given number of bytes of entropy. */
export function randomHex(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export const newId = (prefix) => `${prefix}_${randomHex(4)}`;

let rollDie = secureDie;

/** Test hook: replace the random source. Returns a function that restores it. */
export function setDieRoller(fn) {
  const previous = rollDie;
  rollDie = fn;
  return () => {
    rollDie = previous;
  };
}

const TERM = /([+-]?)(?:(\d*)d(\d+)(?:(kh|kl)(\d+))?|(\d+))/y;

/**
 * Roll a dice expression such as "1d20+5", "2d6 + 1d4 - 1", "4d6kh3", "2d20kl1".
 * With { critical: true } the number of dice in every dice term is doubled (5e critical hits).
 */
export function roll(expression, { critical = false, roller = rollDie } = {}) {
  const expr = String(expression ?? '').replace(/\s+/g, '').toLowerCase();
  if (!expr) throw new DiceError('Dice expression is empty.');
  if (expr.length > 100) throw new DiceError('Dice expression is too long.');

  const terms = [];
  let total = 0;
  let pos = 0;
  while (pos < expr.length) {
    TERM.lastIndex = pos;
    const m = TERM.exec(expr);
    if (!m || m[0] === '' || (pos > 0 && !m[1])) {
      throw new DiceError(`Could not read dice expression "${expression}" near "${expr.slice(pos)}". Use forms like 1d20+5, 2d6+3, 4d6kh3.`);
    }
    pos = TERM.lastIndex;
    const sign = m[1] === '-' ? -1 : 1;

    if (m[6] !== undefined) {
      const value = Number(m[6]);
      terms.push({ type: 'modifier', value: sign * value });
      total += sign * value;
      continue;
    }

    let count = m[2] === '' ? 1 : Number(m[2]);
    const sides = Number(m[3]);
    if (count < 1) throw new DiceError('Must roll at least one die.');
    if (sides < 2 || sides > MAX_SIDES) throw new DiceError(`Dice must have between 2 and ${MAX_SIDES} sides.`);
    if (critical) count *= 2;
    if (count > MAX_DICE) throw new DiceError(`At most ${MAX_DICE} dice per term.`);

    const rolls = Array.from({ length: count }, () => roller(sides));
    let kept = rolls;
    if (m[4]) {
      const keep = Number(m[5]);
      if (keep < 1 || keep > count) throw new DiceError(`Cannot keep ${keep} of ${count} dice.`);
      const sorted = rolls.map((v, i) => [v, i]).sort((a, b) => (m[4] === 'kh' ? b[0] - a[0] : a[0] - b[0]));
      const keepIdx = new Set(sorted.slice(0, keep).map(([, i]) => i));
      kept = rolls.filter((_, i) => keepIdx.has(i));
    }
    const subtotal = kept.reduce((a, b) => a + b, 0) * sign;
    total += subtotal;
    terms.push({
      type: 'dice',
      notation: `${sign < 0 ? '-' : ''}${count}d${sides}${m[4] ? m[4] + m[5] : ''}`,
      rolls,
      kept,
      subtotal,
    });
  }

  return { expression: expr, total, terms, breakdown: describe(terms, total), ...(critical ? { critical: true } : {}) };
}

function describe(terms, total) {
  const parts = terms.map((t, i) => {
    const text = t.type === 'modifier' ? String(Math.abs(t.value)) : `${t.notation.replace('-', '')}[${t.rolls.join(',')}]`;
    const negative = t.type === 'modifier' ? t.value < 0 : t.subtotal < 0 || t.notation.startsWith('-');
    if (i === 0) return negative ? `-${text}` : text;
    return `${negative ? '-' : '+'} ${text}`;
  });
  return `${parts.join(' ')} = ${total}`;
}

/** Throws DiceError if the expression is invalid, without using any randomness. */
export function validateExpression(expression) {
  roll(expression, { roller: () => 1 });
}

/** Roll a d20 with "advantage", "disadvantage" or "none". */
export function rollD20(mode = 'none') {
  if (mode === 'advantage' || mode === 'disadvantage') {
    const rolls = [rollDie(20), rollDie(20)];
    const natural = mode === 'advantage' ? Math.max(...rolls) : Math.min(...rolls);
    return { rolls, natural, mode };
  }
  const natural = rollDie(20);
  return { rolls: [natural], natural, mode: 'none' };
}

export function dieRoll(sides) {
  return rollDie(sides);
}
