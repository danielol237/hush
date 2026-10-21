// In-memory stand-in for Netlify Blobs, with the same surface the store uses.
// Lets the whole app be exercised in tests without any network.

export class FakeBlobs {
  #data = new Map();

  async get(key, options) {
    const raw = this.#data.get(key);
    if (raw === undefined || raw === null) return null;
    if (options?.type === 'json') return JSON.parse(raw);
    return raw;
  }

  async set(key, value) {
    this.#data.set(key, String(value));
  }

  async setJSON(key, value) {
    this.#data.set(key, JSON.stringify(value));
  }

  async delete(key) {
    this.#data.delete(key);
  }

  async list({ prefix = '' } = {}) {
    const blobs = [...this.#data.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }));
    return { blobs };
  }

  get size() {
    return this.#data.size;
  }

  dump() {
    return Object.fromEntries(this.#data);
  }
}
