// GitHub mirror: commits the live state and the event ledger into a folder of a GitHub repository,
// in ONE commit per sync, using the Git Data API. It only ever writes inside the configured folder.
import { renderFinances, renderFleet } from './ledgers.js';
import { threatView } from './world.js';
// Campaign config: campaign.mirror = { repo: "owner/name", branch: "main", path: "campaigns/x/live" }.

const MONTH = (iso) => iso.slice(0, 7);
const fmtTime = (iso) => iso.replace('T', ' ').slice(0, 16) + 'Z';

function escapeMd(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').trim();
}

export function renderLedgerLine(e) {
  const details = e.data && Object.keys(e.data).length ? ` — \`${JSON.stringify(e.data)}\`` : '';
  return `- **#${e.seq}** ${fmtTime(e.at)} \`${e.type}\` ${escapeMd(e.summary)}${details}`;
}

export function renderLedgerMonth(campaign, month, events) {
  return [
    `# Ledger ${month} — ${campaign.name}`,
    '',
    'Written automatically by the Solo Adventure Engine at the moment each event happened. Append-only: never edit;',
    'corrections are new `correction` events. Times are real-world UTC; in-game time is in `time` events.',
    '',
    ...events.map(renderLedgerLine),
    '',
  ].join('\n');
}

function sheetLine(ch) {
  if (!ch) return '- (none)';
  const slots = Object.entries(ch.spellSlots ?? {})
    .filter(([, s]) => s.max)
    .map(([l, s]) => `${l}:${s.max - s.used}/${s.max}`)
    .join(' ');
  return `- **${ch.name}** (${ch.id ?? 'player'}) — L${ch.level} ${ch.class}; HP ${ch.hp}/${ch.maxHp}${ch.tempHp ? ` (+${ch.tempHp} temp)` : ''}; AC ${ch.armorClass}; XP ${ch.xp}`
    + `${ch.conditions?.length ? `; conditions: ${ch.conditions.join(', ')}` : ''}${slots ? `; slots ${slots}` : ''}${ch.dead ? '; DEAD' : ''}`;
}

export function renderHandoff(campaign, recent) {
  const clock = campaign.clock;
  const lines = [
    `# Live handoff — ${campaign.name}`,
    '',
    `Generated automatically ${fmtTime(new Date().toISOString())} from the live server (ledger up to #${campaign.lastSeq ?? 0}).`,
    'This live layer supersedes older repository files for everything it records. Older files remain the historical',
    'baseline for facts not recorded here.',
    '',
    '## Clock',
    clock ? `- ${clock.label ?? `Day ${clock.day}/${clock.cycleLength}`}${clock.verified === false ? ' — **UNVERIFIED: confirm with the player**' : ''}${clock.note ? ` — ${escapeMd(clock.note)}` : ''}` : '- Not set',
    '',
    '## Scene',
    `- Location: ${escapeMd(campaign.location) || 'unrecorded'}`,
    campaign.scene ? `- ${escapeMd(campaign.scene)}` : '- (no scene summary recorded)',
    '',
    '## Characters',
    sheetLine(campaign.character),
    ...(campaign.party ?? []).map(sheetLine),
    '',
  ];
  if (campaign.combat) {
    lines.push('## Combat in progress', `- Round ${campaign.combat.round}; ${campaign.combat.combatants.length} combatants`, '');
  }
  const people = [...(campaign.npcs ?? [])].sort((x, y) => Number(y.alive) - Number(x.alive));
  if (people.length) {
    lines.push('## Relationships', ...people.map((n) => {
      const last = (n.relationshipLog ?? []).at(-1);
      return `- **${escapeMd(n.name)}**${n.role ? ` (${escapeMd(n.role)})` : ''} — ${escapeMd(n.attitude)}${n.alive === false ? '; DEAD' : ''}`
        + `${n.relationship ? `: ${escapeMd(n.relationship)}` : ''}${last ? ` _Latest: ${last.day ? `${escapeMd(last.day)}: ` : ''}${escapeMd(last.note)}_` : ''}`;
    }), '');
  }
  const fronts = threatView(campaign, { dm: false });
  if (fronts.length) lines.push('## Threats and opportunities in motion', ...fronts.map((t) => `- **${escapeMd(t.name)}** (${t.kind}) — clock ${t.clock}, ${t.pace}${t.status === 'triggered' ? ', TRIGGERED' : ''}: ${escapeMd(t.stakes)}`), '');
  const open = (campaign.quests ?? []).filter((q) => q.status === 'active');
  if (open.length) lines.push('## Open threads', ...open.map((q) => `- ${escapeMd(q.title)}${q.progress?.length ? ` — latest: ${escapeMd(q.progress.at(-1))}` : ''}`), '');
  lines.push('## Most recent events', ...recent.map(renderLedgerLine), '');
  return lines.join('\n');
}

const README = (campaign) => `# Live layer (automatic)

This folder is written automatically by the Solo Adventure Engine server for **${campaign.name}**.
Do not edit these files by hand: the next sync overwrites them.

- \`HANDOFF_LIVE.md\`: current clock, scene, character HP/XP/conditions and the latest events.
- \`STATE.json\`: the complete machine-readable live state.
- \`FINANCES.md\` / \`FLEET.md\`: accounts, equity and the ship register (when the campaign keeps books).
- \`ledger/YYYY-MM.md\`: every event, numbered, written at the moment it happened. Append-only.

Precedence: this live layer supersedes older repository files for anything it records.
Older files remain the historical baseline for facts not recorded here.
`;

export class GitHub {
  constructor({ token, fetchImpl = fetch, api = 'https://api.github.com' }) {
    this.token = token;
    this.fetch = fetchImpl;
    this.api = api;
  }

  async call(method, path, body) {
    const res = await this.fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'solo-adventure-engine',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`GitHub ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return text ? JSON.parse(text) : null;
  }

  /** Create one commit on top of the branch head containing the given files. Fails (no force) if the branch moved. */
  async commitFiles({ repo, branch, message, files }) {
    const ref = await this.call('GET', `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const head = ref.object.sha;
    const commit = await this.call('GET', `/repos/${repo}/git/commits/${head}`);
    const tree = await this.call('POST', `/repos/${repo}/git/trees`, {
      base_tree: commit.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    const created = await this.call('POST', `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [head] });
    await this.call('PATCH', `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: created.sha, force: false });
    return created.sha;
  }
}

/**
 * Push any ledger events not yet mirrored. Returns a short status object; never throws for GitHub errors
 * (they are recorded in mirror_state and retried on the next sync).
 */
export async function syncCampaign(store, campaignId, github) {
  const campaign = await store.get(campaignId);
  if (!campaign?.mirror?.repo) return { campaignId, skipped: 'no mirror configured' };
  if (!github) return { campaignId, skipped: 'GitHub token not configured (secret GITHUB_TOKEN)' };
  const state = await store.getMirrorState(campaignId);
  const lastSeq = campaign.lastSeq ?? 0;
  if (lastSeq <= state.lastSeq) return { campaignId, upToDate: true, lastSeq };

  try {
    const fresh = await store.getEvents(campaignId, { afterSeq: state.lastSeq, limit: 1000 });
    const months = [...new Set(fresh.map((e) => MONTH(e.at)))];
    const base = campaign.mirror.path.replace(/\/+$/, '');
    const files = {};
    for (const month of months) {
      // Rewrite each touched month from the database so the file is always complete and ordered.
      const all = [];
      let after = 0;
      for (;;) {
        const page = await store.getEvents(campaignId, { afterSeq: after, limit: 1000 });
        if (!page.length) break;
        all.push(...page.filter((e) => MONTH(e.at) === month));
        after = page.at(-1).seq;
        if (page.length < 1000) break;
      }
      files[`${base}/ledger/${month}.md`] = renderLedgerMonth(campaign, month, all);
    }
    const recent = (await store.getEvents(campaignId, { limit: 30, newestFirst: true })).reverse();
    const { mirror, ...publicState } = campaign;
    files[`${base}/STATE.json`] = `${JSON.stringify(publicState, null, 2)}\n`;
    files[`${base}/HANDOFF_LIVE.md`] = renderHandoff(campaign, recent);
    files[`${base}/README.md`] = README(campaign);
    const fin = renderFinances(campaign);
    if (fin) files[`${base}/FINANCES.md`] = fin;
    const fleet = renderFleet(campaign);
    if (fleet) files[`${base}/FLEET.md`] = fleet;
    const syncedTo = fresh.length ? fresh.at(-1).seq : lastSeq;
    const sha = await github.commitFiles({
      repo: campaign.mirror.repo,
      branch: campaign.mirror.branch ?? 'main',
      message: `live: ${campaign.name} ledger #${state.lastSeq + 1}–#${syncedTo}`,
      files,
    });
    await store.setMirrorState(campaignId, { lastSeq: syncedTo, lastCommit: sha, lastSyncedAt: new Date().toISOString(), lastError: null });
    return { campaignId, committed: sha, events: fresh.length, lastSeq: syncedTo };
  } catch (e) {
    await store.setMirrorState(campaignId, { lastError: String(e.message).slice(0, 500) });
    return { campaignId, error: e.message };
  }
}

export async function syncAll(store, github) {
  const campaigns = await store.list();
  const results = [];
  for (const c of campaigns) if (c.mirror?.repo) results.push(await syncCampaign(store, c.id, github));
  return results;
}
