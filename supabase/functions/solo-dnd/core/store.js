// Campaign storage + append-only event ledger.
// SupabaseStore talks to the project's own database through its REST API, using the service key
// that Supabase injects into every Edge Function. MemoryStore is for tests.
//
// Saves use optimistic concurrency: every campaign has a revision number (rev). put(campaign, rev, events)
// only succeeds if nobody saved since that revision was loaded; otherwise it throws ConflictError and the
// caller reloads and retries, so simultaneous actions never overwrite each other. The campaign and its new
// ledger events are written in one transaction, so state and ledger always agree.

export class ConflictError extends Error {
  constructor() {
    super('The campaign was changed by another action at the same time.');
    this.conflict = true;
  }
}

const stamp = (events) => events.map((e) => ({ at: new Date().toISOString(), ...e }));

export class MemoryStore {
  constructor(accessKey = null) {
    this.campaigns = new Map();
    this.events = new Map(); // campaignId -> [{seq, at, type, summary, data}]
    this.mirrors = new Map();
    this.accessKey = accessKey;
  }

  async list() {
    return [...this.campaigns.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((c) => structuredClone(c));
  }

  async get(id) {
    const c = this.campaigns.get(id);
    return c ? structuredClone(c) : null;
  }

  async create(c) {
    if (this.campaigns.has(c.id)) throw new Error(`Campaign ${c.id} already exists.`);
    this.campaigns.set(c.id, structuredClone({ ...c, rev: 0, lastSeq: 0 }));
    this.events.set(c.id, []);
  }

  async put(c, expectedRev = c.rev ?? 0, events = []) {
    const current = this.campaigns.get(c.id);
    if (!current || (current.rev ?? 0) !== expectedRev) throw new ConflictError();
    const log = this.events.get(c.id) ?? [];
    let seq = current.lastSeq ?? 0;
    for (const e of stamp(events)) log.push(structuredClone({ ...e, seq: ++seq }));
    this.events.set(c.id, log);
    this.campaigns.set(c.id, structuredClone({ ...c, rev: expectedRev + 1, lastSeq: seq }));
    return { rev: expectedRev + 1, lastSeq: seq };
  }

  async delete(id) {
    this.campaigns.delete(id);
    this.events.delete(id);
    this.mirrors.delete(id);
  }

  async getEvents(id, { afterSeq = 0, beforeSeq = null, limit = 50, types = null, newestFirst = false } = {}) {
    let list = (this.events.get(id) ?? []).filter((e) => e.seq > afterSeq && (beforeSeq === null || e.seq < beforeSeq));
    if (types?.length) list = list.filter((e) => types.includes(e.type));
    if (newestFirst) list = [...list].reverse();
    return structuredClone(list.slice(0, limit));
  }

  async getMirrorState(id) {
    return structuredClone(this.mirrors.get(id) ?? { lastSeq: 0, lastCommit: null, lastSyncedAt: null, lastError: null });
  }

  async setMirrorState(id, state) {
    this.mirrors.set(id, { ...(await this.getMirrorState(id)), ...state });
  }

  async getAccessKey() {
    return this.accessKey;
  }
}

export class SupabaseStore {
  constructor({ url, serviceKey, fetchImpl = fetch }) {
    if (!url || !serviceKey) throw new Error('SUPABASE_URL and a service/secret key are required.');
    this.base = `${url.replace(/\/+$/, '')}/rest/v1`;
    this.fetch = fetchImpl;
    // Legacy service_role keys are JWTs and go in Authorization too; new sb_secret_ keys only need "apikey".
    this.headers = { apikey: serviceKey, ...(serviceKey.startsWith('eyJ') ? { authorization: `Bearer ${serviceKey}` } : {}) };
    this.accessKey = null;
  }

  async request(path, { method = 'GET', body, prefer } = {}) {
    const res = await this.fetch(`${this.base}${path}`, {
      method,
      headers: { ...this.headers, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Database ${method} ${path.split('?')[0]} failed: ${res.status} ${raw}`);
    // Writes with "return=minimal" answer 201/204 with an empty body.
    return raw ? JSON.parse(raw) : null;
  }

  async list() {
    const rows = await this.request('/campaigns?select=data&order=updated_at.desc');
    return rows.map((r) => r.data);
  }

  async get(id) {
    const rows = await this.request(`/campaigns?select=data,rev,last_seq&id=eq.${encodeURIComponent(id)}`);
    return rows[0] ? { ...rows[0].data, rev: rows[0].rev, lastSeq: Number(rows[0].last_seq) } : null;
  }

  async create(c) {
    await this.request('/campaigns', {
      method: 'POST',
      body: { id: c.id, name: c.name, data: { ...c, rev: 0, lastSeq: 0 }, rev: 0, last_seq: 0, updated_at: c.updatedAt },
      prefer: 'return=minimal',
    });
  }

  // Atomic compare-and-set of campaign + ledger events (see commit_campaign in the migrations).
  async put(c, expectedRev = c.rev ?? 0, events = []) {
    const result = await this.request('/rpc/commit_campaign', {
      method: 'POST',
      body: {
        p_id: c.id,
        p_expected_rev: expectedRev,
        p_name: c.name,
        p_data: c,
        p_updated_at: c.updatedAt,
        p_events: stamp(events),
      },
    });
    if (!result) throw new ConflictError();
    return result;
  }

  async delete(id) {
    await this.request(`/campaigns?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  async getEvents(id, { afterSeq = 0, beforeSeq = null, limit = 50, types = null, newestFirst = false } = {}) {
    let q = `/events?select=seq,at,type,summary,data&campaign_id=eq.${encodeURIComponent(id)}&seq=gt.${Number(afterSeq)}`;
    if (beforeSeq !== null) q += `&seq=lt.${Number(beforeSeq)}`;
    if (types?.length) q += `&type=in.(${types.map(encodeURIComponent).join(',')})`;
    q += `&order=seq.${newestFirst ? 'desc' : 'asc'}&limit=${Number(limit)}`;
    const rows = await this.request(q);
    return rows.map((r) => ({ ...r, seq: Number(r.seq) }));
  }

  async getMirrorState(id) {
    const rows = await this.request(`/mirror_state?select=last_seq,last_commit,last_synced_at,last_error&campaign_id=eq.${encodeURIComponent(id)}`);
    const r = rows[0];
    return r
      ? { lastSeq: Number(r.last_seq), lastCommit: r.last_commit, lastSyncedAt: r.last_synced_at, lastError: r.last_error }
      : { lastSeq: 0, lastCommit: null, lastSyncedAt: null, lastError: null };
  }

  async setMirrorState(id, state) {
    const row = { campaign_id: id };
    if (state.lastSeq !== undefined) row.last_seq = state.lastSeq;
    if (state.lastCommit !== undefined) row.last_commit = state.lastCommit;
    if (state.lastSyncedAt !== undefined) row.last_synced_at = state.lastSyncedAt;
    if (state.lastError !== undefined) row.last_error = state.lastError;
    await this.request('/mirror_state?on_conflict=campaign_id', {
      method: 'POST',
      body: row,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  async getAccessKey() {
    if (!this.accessKey) {
      const rows = await this.request('/app_config?select=value&key=eq.access_key');
      this.accessKey = rows[0]?.value ?? null;
    }
    return this.accessKey;
  }
}
