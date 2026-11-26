// Campaign storage.
// SupabaseStore talks to the project's own database through its REST API, using the service key
// that Supabase injects into every Edge Function. MemoryStore is for tests.
//
// Saves use optimistic concurrency: every campaign has a revision number (rev). put(campaign, rev)
// only succeeds if nobody saved since that revision was loaded; otherwise it throws ConflictError
// and the caller reloads and retries, so simultaneous actions never overwrite each other.

export class ConflictError extends Error {
  constructor() {
    super('The campaign was changed by another action at the same time.');
    this.conflict = true;
  }
}

export class MemoryStore {
  constructor(accessKey = null) {
    this.campaigns = new Map();
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
    this.campaigns.set(c.id, structuredClone({ ...c, rev: 0 }));
  }

  async put(c, expectedRev = c.rev ?? 0) {
    const current = this.campaigns.get(c.id);
    if (!current || (current.rev ?? 0) !== expectedRev) throw new ConflictError();
    this.campaigns.set(c.id, structuredClone({ ...c, rev: expectedRev + 1 }));
  }

  async delete(id) {
    this.campaigns.delete(id);
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
    const rows = await this.request(`/campaigns?select=data,rev&id=eq.${encodeURIComponent(id)}`);
    return rows[0] ? { ...rows[0].data, rev: rows[0].rev } : null;
  }

  async create(c) {
    await this.request('/campaigns', {
      method: 'POST',
      body: { id: c.id, name: c.name, data: { ...c, rev: 0 }, rev: 0, updated_at: c.updatedAt },
      prefer: 'return=minimal',
    });
  }

  // Atomic compare-and-set: UPDATE ... WHERE id = ? AND rev = expectedRev.
  async put(c, expectedRev = c.rev ?? 0) {
    const rev = expectedRev + 1;
    const rows = await this.request(`/campaigns?id=eq.${encodeURIComponent(c.id)}&rev=eq.${expectedRev}&select=id`, {
      method: 'PATCH',
      body: { name: c.name, data: { ...c, rev }, rev, updated_at: c.updatedAt },
      prefer: 'return=representation',
    });
    if (!Array.isArray(rows) || rows.length === 0) throw new ConflictError();
  }

  async delete(id) {
    await this.request(`/campaigns?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE', prefer: 'return=minimal' });
  }

  async getAccessKey() {
    if (!this.accessKey) {
      const rows = await this.request('/app_config?select=value&key=eq.access_key');
      this.accessKey = rows[0]?.value ?? null;
    }
    return this.accessKey;
  }
}
