/**
 * Hush — the shared logic.
 *
 * Runs unchanged on Netlify Functions and under Node's test runner, so the
 * code the tests exercise is the code that serves real traffic.
 *
 * The rule that shapes everything here: a sender is never identified. We do
 * not store an IP, a user agent, a cookie or a device fingerprint against a
 * message. Rate limiting keeps a transient per-minute counter keyed on the
 * client, but that counter is never joined to a message and expires on its own.
 */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const MAX_TEXT_LENGTH = 500;
export const MAX_NAME_LENGTH = 40;
export const MAX_PROMPT_LENGTH = 120;
export const MAX_MESSAGES_PER_BOX = 500;

const SCRYPT_KEYLEN = 32;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/* ------------------------------------------------------------------- tokens */

/** 144 bits of entropy, url-safe. */
export function generateId() {
  return randomBytes(18).toString('base64url');
}

/** Owner tokens are longer: they are the only key to a private inbox. */
export function generateOwnerToken() {
  return randomBytes(32).toString('base64url');
}

export function hashOwnerToken(token) {
  const salt = randomBytes(16);
  const derived = scryptSync(token.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return [
    'scrypt',
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export function verifyOwnerToken(token, stored) {
  if (typeof token !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, n, r, p, saltB64, hashB64] = parts;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64url');
    expected = Buffer.from(hashB64, 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const actual = scryptSync(token.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

/* --------------------------------------------------------------- moderation */

/**
 * Patterns that suggest someone is trying to dox the recipient or push them
 * off-platform. Flagged messages are still delivered, but land in a separate
 * folder so the recipient is never blindsided by them.
 *
 * This is deliberately narrow. Broad keyword blacklists produce false
 * positives on ordinary speech and teach people to work around the filter.
 */
const RISK_PATTERNS = [
  { name: 'email', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/ },
  { name: 'phone', re: /(?:\+?\d[\s().-]?){9,}/ },
  { name: 'link', re: /\b(?:https?:\/\/|www\.)\S+/i },
  { name: 'handle', re: /(?:^|\s)@[a-z0-9_.]{2,}/i },
  { name: 'address', re: /\b\d{1,5}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|close|crescent)\b/i },
];

/** @returns {{ flagged: boolean, reasons: string[] }} */
export function scanText(text) {
  const reasons = RISK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.name);
  return { flagged: reasons.length > 0, reasons };
}

/**
 * A stable, non-reversible bucket for a client. Used only for rate limiting,
 * never written next to a message. Salting with the box id means a counter
 * cannot be correlated across boxes either.
 */
export function clientBucket(ip, boxId) {
  return createHash('sha256').update(`${boxId}:${ip}`).digest('base64url').slice(0, 22);
}

/* -------------------------------------------------------------- validation */

export function validateName(value) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid_name' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) return { ok: false, error: 'invalid_name' };
  return { ok: true, value: name };
}

export function validatePrompt(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, value: 'Send me something you would not say out loud.' };
  }
  if (typeof value !== 'string') return { ok: false, error: 'invalid_prompt' };
  const prompt = value.trim().replace(/\s+/g, ' ');
  if (prompt.length > MAX_PROMPT_LENGTH) return { ok: false, error: 'invalid_prompt' };
  return { ok: true, value: prompt };
}

export function validateText(value) {
  if (typeof value !== 'string') return { ok: false, error: 'invalid_text' };
  const text = value.trim();
  if (text.length < 1) return { ok: false, error: 'empty_text' };
  if (text.length > MAX_TEXT_LENGTH) return { ok: false, error: 'text_too_long' };
  return { ok: true, value: text };
}

/* ------------------------------------------------------------------- store */

/**
 * Blob-backed store.
 *
 * `blobs` is anything with get/set/delete/list that behaves like Netlify
 * Blobs, which is what lets the same store run against an in-memory fake in
 * the tests.
 */
export class HushStore {
  #blobs;
  #now;

  constructor(blobs, { now = () => Date.now() } = {}) {
    this.#blobs = blobs;
    this.#now = now;
  }

  async createBox({ name, prompt }) {
    const id = generateId();
    const ownerToken = generateOwnerToken();
    const record = {
      id,
      name,
      prompt,
      ownerHash: hashOwnerToken(ownerToken),
      createdAt: this.#now(),
      open: true,
    };
    await this.#blobs.setJSON(`box:${id}`, record);
    return { id, ownerToken, createdAt: record.createdAt };
  }

  async getBox(id) {
    return this.#blobs.get(`box:${id}`, { type: 'json' });
  }

  async saveBox(box) {
    await this.#blobs.setJSON(`box:${box.id}`, box);
  }

  /** Public view: never includes the owner hash or anything about senders. */
  async publicBox(id) {
    const box = await this.getBox(id);
    if (!box) return null;
    return {
      id: box.id,
      name: box.name,
      prompt: box.prompt,
      open: box.open,
      createdAt: box.createdAt,
    };
  }

  async addMessage(boxId, text) {
    const id = `${this.#now().toString(36)}-${randomBytes(4).toString('hex')}`;
    const scan = scanText(text);
    const message = {
      id,
      text,
      createdAt: this.#now(),
      flagged: scan.flagged,
      reasons: scan.reasons,
    };

    const key = `msg:${boxId}:${String(message.createdAt).padStart(15, '0')}:${id}`;
    await this.#blobs.setJSON(key, message);
    return message;
  }

  /** Newest first. */
  async listMessages(boxId, { limit = 200 } = {}) {
    const { blobs } = await this.#blobs.list({ prefix: `msg:${boxId}:` });
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
    const out = [];
    for (const key of keys) {
      const value = await this.#blobs.get(key, { type: 'json' });
      if (value) out.push({ ...value, key });
    }
    return out;
  }

  async deleteMessage(key) {
    await this.#blobs.delete(key);
  }

  async countMessages(boxId) {
    const { blobs } = await this.#blobs.list({ prefix: `msg:${boxId}:` });
    return blobs.length;
  }
}

/* -------------------------------------------------------------- rate limit */

/**
 * Per-minute counter. Best-effort by design: it is a speed bump for scripts,
 * not a security boundary, and it never touches message storage.
 */
export class MinuteLimiter {
  #blobs;
  #now;
  #limit;

  constructor(blobs, { limit = 6, now = () => Date.now() } = {}) {
    this.#blobs = blobs;
    this.#now = now;
    this.#limit = limit;
  }

  async hit(bucket) {
    const minute = Math.floor(this.#now() / 60_000);
    const key = `rl:${bucket}:${minute}`;
    const current = Number((await this.#blobs.get(key)) ?? '0');
    if (current >= this.#limit) return { allowed: false, remaining: 0 };
    await this.#blobs.set(key, String(current + 1));
    return { allowed: true, remaining: this.#limit - current - 1 };
  }
}
