import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { newId } from './store.js';
import { describeCharacter } from './rules.js';
import { buildSpec } from './openapi.js';
import {
  HttpError, bad, text, int, advantageMode, safeRoll, logRoll, buildCharacter, updateCharacter, addItem, removeItem,
  changeCharacterHp, rest, awardXp, levelUp, characterCheck, startCombat, combatView, combatAttack, adjustCombatant,
  nextTurn, endCombat,
} from './game.js';
import { rollD20 } from './dice.js';
import { mcpHandler } from './mcp.js';

const now = () => new Date().toISOString();

function campaignSummary(c) {
  return {
    id: c.id,
    name: c.name,
    character: c.character ? `${c.character.name}, level ${c.character.level} ${c.character.race} ${c.character.class}` : null,
    location: c.location,
    updatedAt: c.updatedAt,
  };
}

function campaignView(c, { journal = 10 } = {}) {
  return {
    id: c.id,
    name: c.name,
    setting: c.setting,
    tone: c.tone,
    location: c.location,
    inGameDate: c.inGameDate,
    notes: c.notes,
    character: describeCharacter(c.character),
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

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createApp({ store, apiKey, publicUrl, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '200kb' }));

  // Request log (secret key redacted) to help debug connection problems: see data/server.log.
  if (log) {
    app.use((req, res, next) => {
      const started = Date.now();
      res.on('finish', () => {
        const path = apiKey?.length >= 8 ? req.originalUrl.split(apiKey).join('<key>') : req.originalUrl;
        const rpc = req.body?.method ? ` ${req.body.method}${req.body.params?.name ? `:${req.body.params.name}` : ''}` : '';
        log(`${new Date().toISOString()} ${req.method} ${path}${rpc} -> ${res.statusCode} (${Date.now() - started}ms)`);
      });
      next();
    });
  }

  // OAuth discovery probes (ChatGPT checks these before connecting an MCP server).
  // Answer "not found" so clients know no OAuth login is needed; the key lives in the MCP URL.
  app.use('/.well-known', (req, res) => res.status(404).json({ error: 'Not found. This server does not use OAuth.' }));

  // ---------- public routes ----------
  app.get('/', (req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Solo Adventure Engine</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Solo Adventure Engine</h1>
<p>This server is running. It is the dice, rules and memory for a ChatGPT Custom GPT dungeon master.</p>
<p>ChatGPT plugin / MCP connector URL: <code>${(publicUrl || `${req.protocol}://${req.get('host')}`)}/mcp/&lt;your API key&gt;</code></p>
<p>Custom GPT Action spec: <code>${(publicUrl || `${req.protocol}://${req.get('host')}`)}/openapi.json</code></p>
</body>`);
  });
  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/openapi.json', (req, res) => res.json(buildSpec(publicUrl || `${req.protocol}://${req.get('host')}`)));
  app.get('/privacy', (req, res) => {
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Privacy</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5">
<h1>Privacy policy</h1>
<p>This is a personal game server. It stores only the campaign data your GPT sends it (characters, quests, notes, dice rolls) so your game can continue between chats. Data is kept on this server, is not shared or sold, and can be deleted at any time with the deleteCampaign action.</p>
</body>`);
  });

  // ---------- MCP (ChatGPT plugins / custom MCP connectors) ----------
  // Key can be in the URL (/mcp/<key>, for clients that can't send headers) or as a Bearer header.
  const mcpAuth = (req, res, next) => {
    if (!apiKey) return next();
    const header = req.get('authorization') ?? '';
    const token = req.params.key ?? (header.startsWith('Bearer ') ? header.slice(7).trim() : '');
    if (token && safeEqual(token, apiKey)) return next();
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Wrong or missing key. Use the full MCP URL printed by the server, ending in /mcp/<your key>.' }, id: null });
  };
  const handleMcp = mcpHandler({ apiKey });
  app.post(['/mcp', '/mcp/:key'], mcpAuth, (req, res, next) => handleMcp(req, res).catch(next));
  app.all(['/mcp', '/mcp/:key'], (req, res) => {
    res.status(405).set('allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This MCP server is stateless: use POST.' }, id: null });
  });

  // ---------- auth ----------
  app.use((req, res, next) => {
    if (!apiKey) return next();
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token && safeEqual(token, apiKey)) return next();
    res.status(401).json({ error: 'Missing or wrong API key. In the GPT Action, set Authentication to API Key, type Bearer.' });
  });

  // Load campaign, run handler, persist. Handler returns the JSON body.
  const withCampaign = (handler, { mutate = true } = {}) => async (req, res) => {
    const campaign = store.get(req.params.campaignId);
    if (!campaign) throw new HttpError(404, `No campaign "${req.params.campaignId}". Use listCampaigns to find the right id.`);
    const body = await handler(req, campaign, req.body ?? {});
    if (mutate) {
      campaign.updatedAt = now();
      store.save();
    }
    res.json(body);
  };
  const needCharacter = (campaign) => {
    if (!campaign.character) throw bad('This campaign has no character yet. Create one with createCharacter.');
    return campaign.character;
  };

  // ---------- campaigns ----------
  app.get('/campaigns', (req, res) => {
    const list = store.list().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(campaignSummary);
    res.json({ campaigns: list });
  });

  app.post('/campaigns', (req, res) => {
    const b = req.body ?? {};
    const c = {
      id: newId('cmp'),
      name: text(b.name, 'name', { required: true, max: 100 }),
      setting: text(b.setting, 'setting', { max: 4000 }) ?? null,
      tone: text(b.tone, 'tone', { max: 200 }) ?? null,
      location: text(b.location, 'location', { max: 200 }) ?? null,
      inGameDate: text(b.inGameDate, 'inGameDate', { max: 100 }) ?? null,
      notes: text(b.notes, 'notes', { max: 8000 }) ?? null,
      character: null,
      quests: [],
      npcs: [],
      journal: [],
      rollHistory: [],
      combat: null,
      createdAt: now(),
      updatedAt: now(),
    };
    store.put(c);
    store.save();
    res.status(201).json(campaignView(c));
  });

  app.get('/campaigns/:campaignId', withCampaign((req, c) => {
    const journal = int(req.query.journalEntries, 'journalEntries', { min: 0, max: 50 }) ?? 10;
    return campaignView(c, { journal });
  }, { mutate: false }));

  app.patch('/campaigns/:campaignId', withCampaign((req, c, b) => {
    const fields = { name: 100, setting: 4000, tone: 200, location: 200, inGameDate: 100, notes: 8000 };
    for (const [k, max] of Object.entries(fields)) if (b[k] !== undefined) c[k] = text(b[k], k, { max }) ?? null;
    if (b.appendNotes) c.notes = [c.notes, text(b.appendNotes, 'appendNotes', { max: 2000 })].filter(Boolean).join('\n');
    if (c.notes && c.notes.length > 8000) c.notes = c.notes.slice(-8000);
    return campaignView(c);
  }));

  app.delete('/campaigns/:campaignId', (req, res) => {
    if (!store.delete(req.params.campaignId)) throw new HttpError(404, 'No such campaign.');
    store.save();
    res.json({ deleted: req.params.campaignId });
  });

  // ---------- character ----------
  app.put('/campaigns/:campaignId/character', withCampaign((req, c, b) => {
    c.character = buildCharacter(b);
    return describeCharacter(c.character);
  }));

  app.patch('/campaigns/:campaignId/character', withCampaign((req, c, b) => describeCharacter(updateCharacter(needCharacter(c), b))));

  app.post('/campaigns/:campaignId/character/hp', withCampaign((req, c, b) => {
    const ch = needCharacter(c);
    const type = b.type ?? 'damage';
    if (!['damage', 'heal', 'temp'].includes(type)) throw bad('"type" must be damage, heal or temp.');
    const amount = int(b.amount, 'amount', { required: true, min: 0, max: 10000 });
    const r = changeCharacterHp(ch, { type, amount, critical: Boolean(b.critical) });
    return { type, amount, reason: b.reason ?? null, ...r, conditions: ch.conditions, deathSaves: ch.deathSaves };
  }));

  app.post('/campaigns/:campaignId/character/rest', withCampaign((req, c, b) => {
    const ch = needCharacter(c);
    if (c.combat) throw bad('You cannot rest during combat. End combat first.');
    const type = b.type;
    if (type !== 'short' && type !== 'long') throw bad('"type" must be "short" or "long".');
    const hitDiceToSpend = int(b.hitDiceToSpend, 'hitDiceToSpend', { min: 0, max: 20 }) ?? 0;
    return rest(ch, { type, hitDiceToSpend });
  }));

  app.post('/campaigns/:campaignId/character/xp', withCampaign((req, c, b) => {
    const r = awardXp(needCharacter(c), int(b.amount, 'amount', { required: true, min: 0, max: 1000000 }));
    if (b.reason) r.reason = text(b.reason, 'reason', { max: 200 });
    return r;
  }));

  app.post('/campaigns/:campaignId/character/level-up', withCampaign((req, c, b) => {
    const hpMethod = b.hpMethod ?? 'average';
    if (!['average', 'roll'].includes(hpMethod)) throw bad('"hpMethod" must be "average" or "roll".');
    const r = levelUp(needCharacter(c), { hpMethod });
    return { ...r, character: describeCharacter(c.character) };
  }));

  app.post('/campaigns/:campaignId/character/inventory', withCampaign((req, c, b) => {
    const ch = needCharacter(c);
    const action = b.action ?? 'add';
    let item;
    if (action === 'add') item = addItem(ch, b);
    else if (action === 'remove') item = removeItem(ch, b);
    else if (action === 'equip' || action === 'unequip') {
      item = ch.inventory.find((i) => i.name.toLowerCase() === String(b.name ?? '').toLowerCase() || i.id === b.name);
      if (!item) throw new HttpError(404, `"${b.name}" is not in the inventory.`);
      item.equipped = action === 'equip';
    } else throw bad('"action" must be add, remove, equip or unequip.');
    return { action, item, inventory: ch.inventory, gold: ch.gold };
  }));

  // ---------- dice ----------
  const doRoll = (b) => {
    const count = int(b.count, 'count', { min: 1, max: 20 }) ?? 1;
    const reason = text(b.reason, 'reason', { max: 200 }) ?? null;
    const mode = advantageMode(b.advantage);
    if (mode !== 'none') {
      const expr = text(b.expression, 'expression', { max: 100 }) ?? '1d20';
      const m = expr.replace(/\s+/g, '').match(/^1?d20([+-]\d+)?$/i);
      if (!m) throw bad('Advantage/disadvantage only applies to a single d20 roll like "1d20+5".');
      const mod = Number(m[1] ?? 0);
      const rolls = Array.from({ length: count }, () => {
        const d = rollD20(mode);
        return { d20: d, modifier: mod, total: d.natural + mod };
      });
      return { reason, expression: expr, advantage: mode, results: rolls, total: count === 1 ? rolls[0].total : undefined };
    }
    const expr = text(b.expression, 'expression', { required: true, max: 100 });
    const results = Array.from({ length: count }, () => safeRoll(expr));
    return count === 1 ? { reason, ...results[0] } : { reason, results, totals: results.map((r) => r.total) };
  };

  app.post('/roll', (req, res) => res.json(doRoll(req.body ?? {})));

  app.post('/campaigns/:campaignId/roll', withCampaign((req, c, b) => {
    const r = doRoll(b);
    logRoll(c, { reason: r.reason, expression: b.expression, result: r.total ?? r.totals ?? r.results?.map((x) => x.total) });
    return r;
  }));

  app.post('/campaigns/:campaignId/checks', withCampaign((req, c, b) => {
    const r = characterCheck(needCharacter(c), b);
    if (b.reason) r.reason = text(b.reason, 'reason', { max: 200 });
    logRoll(c, { reason: r.reason ?? r.label ?? r.kind, result: r.total ?? r.d20?.natural, success: r.success });
    return r;
  }));

  // ---------- quests ----------
  const QUEST_STATUS = ['active', 'completed', 'failed', 'abandoned'];
  app.post('/campaigns/:campaignId/quests', withCampaign((req, c, b) => {
    const q = {
      id: newId('qst'),
      title: text(b.title, 'title', { required: true, max: 120 }),
      description: text(b.description, 'description', { max: 2000 }) ?? null,
      giver: text(b.giver, 'giver', { max: 100 }) ?? null,
      reward: text(b.reward, 'reward', { max: 300 }) ?? null,
      status: 'active',
      progress: [],
      createdAt: now(),
    };
    c.quests.push(q);
    return q;
  }));

  app.patch('/campaigns/:campaignId/quests/:questId', withCampaign((req, c, b) => {
    const q = c.quests.find((x) => x.id === req.params.questId);
    if (!q) throw new HttpError(404, 'No such quest. Use getCampaign to see quest ids.');
    if (b.status !== undefined) {
      if (!QUEST_STATUS.includes(b.status)) throw bad(`"status" must be one of ${QUEST_STATUS.join(', ')}.`);
      q.status = b.status;
    }
    for (const [k, max] of Object.entries({ title: 120, description: 2000, giver: 100, reward: 300 })) {
      if (b[k] !== undefined) q[k] = text(b[k], k, { max }) ?? null;
    }
    if (b.progressNote) q.progress.push(text(b.progressNote, 'progressNote', { max: 500 }));
    return q;
  }));

  // ---------- NPCs ----------
  app.post('/campaigns/:campaignId/npcs', withCampaign((req, c, b) => {
    const n = {
      id: newId('npc'),
      name: text(b.name, 'name', { required: true, max: 100 }),
      description: text(b.description, 'description', { max: 1000 }) ?? null,
      location: text(b.location, 'location', { max: 200 }) ?? null,
      attitude: text(b.attitude, 'attitude', { max: 60 }) ?? 'neutral',
      notes: text(b.notes, 'notes', { max: 2000 }) ?? null,
      alive: true,
    };
    c.npcs.push(n);
    return n;
  }));

  app.patch('/campaigns/:campaignId/npcs/:npcId', withCampaign((req, c, b) => {
    const n = c.npcs.find((x) => x.id === req.params.npcId);
    if (!n) throw new HttpError(404, 'No such NPC. Use getCampaign to see NPC ids.');
    for (const [k, max] of Object.entries({ name: 100, description: 1000, location: 200, attitude: 60, notes: 2000 })) {
      if (b[k] !== undefined) n[k] = text(b[k], k, { max }) ?? null;
    }
    if (b.appendNotes) n.notes = [n.notes, text(b.appendNotes, 'appendNotes', { max: 500 })].filter(Boolean).join('\n');
    if (b.alive !== undefined) n.alive = Boolean(b.alive);
    return n;
  }));

  // ---------- journal ----------
  app.post('/campaigns/:campaignId/journal', withCampaign((req, c, b) => {
    const e = {
      id: newId('jrn'),
      at: now(),
      inGameDate: text(b.inGameDate, 'inGameDate', { max: 100 }) ?? c.inGameDate,
      location: text(b.location, 'location', { max: 200 }) ?? c.location,
      entry: text(b.entry, 'entry', { required: true, max: 4000 }),
    };
    if (b.location) c.location = e.location;
    if (b.inGameDate) c.inGameDate = e.inGameDate;
    c.journal.push(e);
    return e;
  }));

  app.get('/campaigns/:campaignId/journal', withCampaign((req, c) => {
    const limit = int(req.query.limit, 'limit', { min: 1, max: 200 }) ?? 30;
    const offset = int(req.query.offset, 'offset', { min: 0 }) ?? 0;
    const end = c.journal.length - offset;
    return { total: c.journal.length, entries: c.journal.slice(Math.max(0, end - limit), Math.max(0, end)) };
  }, { mutate: false }));

  // ---------- combat ----------
  app.post('/campaigns/:campaignId/combat', withCampaign((req, c, b) => startCombat(c, b)));
  app.get('/campaigns/:campaignId/combat', withCampaign((req, c) => combatView(c) ?? { active: false }, { mutate: false }));
  app.post('/campaigns/:campaignId/combat/attack', withCampaign((req, c, b) => combatAttack(c, b)));
  app.post('/campaigns/:campaignId/combat/combatants/:combatantId', withCampaign((req, c, b) => adjustCombatant(c, req.params.combatantId, b)));
  app.post('/campaigns/:campaignId/combat/next-turn', withCampaign((req, c) => nextTurn(c)));
  app.post('/campaigns/:campaignId/combat/end', withCampaign((req, c, b) => endCombat(c, b)));

  // ---------- errors ----------
  app.use((req, res) => res.status(404).json({ error: `No route ${req.method} ${req.path}. See /openapi.json.` }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body is not valid JSON.' });
    const status = err.status && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Internal server error.' : err.message });
  });

  return app;
}
