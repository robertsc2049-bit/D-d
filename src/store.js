import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomBytes(4).toString('hex')}`;

/** Tiny JSON-file store. Good for one player; swap for a database if you ever need more. */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { campaigns: {} };
    if (file && fs.existsSync(file)) {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data.campaigns ??= {};
    }
  }

  save() {
    if (!this.file) return; // in-memory mode (tests)
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.data.campaigns);
  }

  get(id) {
    return this.data.campaigns[id];
  }

  put(campaign) {
    this.data.campaigns[campaign.id] = campaign;
  }

  delete(id) {
    const existed = Boolean(this.data.campaigns[id]);
    delete this.data.campaigns[id];
    return existed;
  }
}
