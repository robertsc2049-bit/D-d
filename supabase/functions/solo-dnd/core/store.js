// Campaign storage.
// SupabaseStore talks to the project's own database through its REST API, using the service key
// that Supabase injects into every Edge Function. MemoryStore is for tests.

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

  async put(c) {
    this.campaigns.set(c.id, structuredClone(c));
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
    const rows = await this.request(`/campaigns?select=data&id=eq.${encodeURIComponent(id)}`);
    return rows[0]?.data ?? null;
  }

  async put(c) {
    await this.request('/campaigns?on_conflict=id', {
      method: 'POST',
      body: { id: c.id, name: c.name, data: c, updated_at: c.updatedAt },
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
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
