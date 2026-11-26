// The living world: threats and opportunities on clocks that advance by fair dice whenever in-game time passes,
// plus a complication check. This is what makes the world act on its own instead of waiting for the player.
import { dieRoll, newId } from './dice.js';
import { bad, text, int, HttpError } from './game.js';

const PACE = { slow: 6, steady: 5, fast: 4 }; // d6 result needed for a threat to tick each period
const MAX_PERIODS = 28;

export function world(c) {
  c.world = c.world ?? { complicationOn: 17 };
  c.threats = c.threats ?? [];
  return c;
}

export function findThreat(c, id) {
  const k = String(id ?? '').trim().toLowerCase();
  const t = world(c).threats.find((x) => x.id === id || x.name.toLowerCase() === k);
  if (!t) throw new HttpError(404, `No threat "${id}". Threats: ${c.threats.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}.`);
  return t;
}

export function addThreat(c, a) {
  world(c);
  const name = text(a.name, 'name', { required: true, max: 120 });
  if (c.threats.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw bad(`"${name}" already exists. Use updateThreat.`);
  const pace = a.pace ?? 'steady';
  if (!PACE[pace]) throw bad('"pace" must be slow, steady or fast.');
  const kind = a.kind ?? 'threat';
  if (!['threat', 'opportunity'].includes(kind)) throw bad('"kind" must be threat or opportunity.');
  const t = {
    id: newId('thr'),
    name,
    kind,
    goal: text(a.goal, 'goal', { required: true, max: 500 }),
    stakes: text(a.stakes, 'stakes', { required: true, max: 500 }),
    steps: Array.isArray(a.steps) ? a.steps.slice(0, 12).map((s, i) => text(s, `steps[${i}]`, { required: true, max: 300 })) : [],
    segments: int(a.segments, 'segments', { min: 2, max: 12 }) ?? 6,
    filled: int(a.filled, 'filled', { min: 0, max: 11 }) ?? 0,
    pace,
    secret: Boolean(a.secret),
    status: 'active',
    log: [],
  };
  if (t.filled >= t.segments) throw bad('"filled" must be below "segments".');
  c.threats.push(t);
  return t;
}

function tick(t, n, why, clockLabel) {
  const before = t.filled;
  t.filled = Math.max(0, Math.min(t.segments, t.filled + n));
  if (t.filled >= t.segments && t.status === 'active') t.status = 'triggered';
  const step = t.filled > before ? t.steps[t.filled - 1] ?? null : null;
  t.log.push({ day: clockLabel ?? null, from: before, to: t.filled, why });
  if (t.log.length > 40) t.log.splice(0, t.log.length - 40);
  return { id: t.id, name: t.name, kind: t.kind, from: before, to: t.filled, of: t.segments, status: t.status, step, secret: t.secret, stakes: t.stakes };
}

export function updateThreat(c, a) {
  const t = findThreat(c, a.threatId);
  for (const [k, max] of Object.entries({ name: 120, goal: 500, stakes: 500 })) if (a[k] !== undefined) t[k] = text(a[k], k, { required: true, max });
  if (a.pace !== undefined) {
    if (!PACE[a.pace]) throw bad('"pace" must be slow, steady or fast.');
    t.pace = a.pace;
  }
  if (a.secret !== undefined) t.secret = Boolean(a.secret);
  let change = null;
  if (a.tick !== undefined) {
    const n = int(a.tick, 'tick', { required: true, min: -12, max: 12 });
    change = tick(t, n, text(a.reason, 'reason', { required: true, max: 300 }), c.clock?.label);
  }
  if (a.status !== undefined) {
    if (!['active', 'triggered', 'resolved', 'defused'].includes(a.status)) throw bad('"status" must be active, triggered, resolved or defused.');
    t.status = a.status;
  }
  return { threat: t, change };
}

/** Roll the world forward for `periods` (days, or 8-hour blocks for short waits). */
export function worldTurn(c, periods) {
  world(c);
  const n = Math.min(MAX_PERIODS, Math.max(0, periods));
  const ticks = [];
  const rolls = [];
  for (const t of c.threats.filter((x) => x.status === 'active')) {
    let hits = 0;
    const faces = [];
    for (let i = 0; i < n && t.filled + hits < t.segments; i++) {
      const r = dieRoll(6);
      faces.push(r);
      if (r >= PACE[t.pace]) hits++;
    }
    rolls.push({ threat: t.name, d6: faces, needs: PACE[t.pace] });
    if (hits) ticks.push(tick(t, hits, `world turn (${faces.join(',')} vs ${PACE[t.pace]}+)`, c.clock?.label));
  }
  let complication = null;
  const on = c.world.complicationOn ?? 17;
  for (let i = 0; i < n && on <= 20; i++) {
    const r = dieRoll(20);
    if (r >= on) {
      complication = { period: i + 1, d20: r, needed: on, instruction: 'A complication arises during this time: introduce an encounter, hazard, rival move, accident or opportunity that fits the location and active threats. Make it concrete and resolve it with dice; do not skip it.' };
      break;
    }
  }
  return { periods: n, ticks, complication, rolls };
}

export function threatView(c, { dm = true } = {}) {
  return (c.threats ?? [])
    .filter((t) => t.status === 'active' || t.status === 'triggered')
    .filter((t) => dm || !t.secret)
    .map((t) => ({
      id: t.id, name: t.name, kind: t.kind, clock: `${t.filled}/${t.segments}`, pace: t.pace, status: t.status,
      ...(dm ? { goal: t.goal, stakes: t.stakes, nextStep: t.steps[t.filled] ?? null, secret: t.secret } : { stakes: t.stakes }),
    }));
}
