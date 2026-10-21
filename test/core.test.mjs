import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HushStore,
  MinuteLimiter,
  scanText,
  clientBucket,
  generateId,
  generateOwnerToken,
  hashOwnerToken,
  verifyOwnerToken,
  validateName,
  validatePrompt,
  validateText,
  MAX_TEXT_LENGTH,
  MAX_MESSAGES_PER_BOX,
} from '../src/core.mjs';
import { FakeBlobs } from './fakeBlobs.mjs';

/* ------------------------------------------------------------------ tokens */

test('ids are url-safe and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) {
    const id = generateId();
    assert.match(id, /^[A-Za-z0-9_-]+$/);
    assert.equal(seen.has(id), false);
    seen.add(id);
  }
});

test('owner tokens carry more entropy than box ids', () => {
  assert.ok(generateOwnerToken().length > generateId().length);
});

test('owner token hashes are salted and verify correctly', () => {
  const a = hashOwnerToken('a-very-long-owner-token-value');
  const b = hashOwnerToken('a-very-long-owner-token-value');
  assert.notEqual(a, b);
  assert.equal(verifyOwnerToken('a-very-long-owner-token-value', a), true);
  assert.equal(verifyOwnerToken('a-very-long-owner-token-value', b), true);
});

test('verifyOwnerToken rejects wrong and malformed tokens', () => {
  const stored = hashOwnerToken('correct-token');
  assert.equal(verifyOwnerToken('wrong-token', stored), false);
  assert.equal(verifyOwnerToken('', stored), false);
  for (const bad of [null, undefined, '', 'nope', 'scrypt$1$2$3', 42]) {
    assert.equal(verifyOwnerToken('anything', bad), false);
  }
});

/* -------------------------------------------------------------- moderation */

test('scanText leaves ordinary messages alone', () => {
  for (const text of [
    'I have had a crush on you since year 9',
    'you are genuinely funny, dont change',
    'why did you stop talking to me',
    'send me 50 naira and I will tell you',
  ]) {
    assert.equal(scanText(text).flagged, false, text);
  }
});

test('scanText flags contact details and links', () => {
  const cases = {
    'mail me at someone@example.com': 'email',
    'call 0803 123 4567': 'phone',
    'look at https://evil.example/x': 'link',
    'follow @somebody_real': 'handle',
    'come to 12 Adeola Street tonight': 'address',
  };

  for (const [text, reason] of Object.entries(cases)) {
    const result = scanText(text);
    assert.equal(result.flagged, true, text);
    assert.ok(result.reasons.includes(reason), `${text} -> ${result.reasons}`);
  }
});

test('flagged messages are still delivered, just separated', async () => {
  const store = new HushStore(new FakeBlobs());
  const { id } = await store.createBox({ name: 'Tita', prompt: 'ask me' });

  await store.addMessage(id, 'you are kind');
  await store.addMessage(id, 'email me at x@y.com');

  const messages = await store.listMessages(id);
  assert.equal(messages.length, 2);
  assert.equal(messages.filter((m) => m.flagged).length, 1);
});

/* -------------------------------------------------------------- validation */

test('validateName trims, collapses whitespace, and bounds length', () => {
  assert.deepEqual(validateName('  Tita   Daniel '), { ok: true, value: 'Tita Daniel' });
  assert.equal(validateName('').ok, false);
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('a'.repeat(41)).ok, false);
  assert.equal(validateName(null).ok, false);
  assert.equal(validateName(42).ok, false);
});

test('validatePrompt falls back to a default', () => {
  const fallback = validatePrompt(undefined);
  assert.equal(fallback.ok, true);
  assert.ok(fallback.value.length > 0);

  assert.equal(validatePrompt('   ').ok, true);
  assert.equal(validatePrompt('a'.repeat(121)).ok, false);
});

test('validateText rejects empty and oversized, accepts the boundary', () => {
  assert.equal(validateText('').ok, false);
  assert.equal(validateText('   ').ok, false);
  assert.equal(validateText(null).ok, false);
  assert.equal(validateText('a'.repeat(MAX_TEXT_LENGTH)).ok, true);
  assert.equal(validateText('a'.repeat(MAX_TEXT_LENGTH + 1)).ok, false);
  assert.deepEqual(validateText('  hello  '), { ok: true, value: 'hello' });
});

/* ------------------------------------------------------------------ store */

test('creating a box returns an id and a one-time owner token', async () => {
  const store = new HushStore(new FakeBlobs());
  const box = await store.createBox({ name: 'Tita', prompt: 'ask me anything' });

  assert.match(box.id, /^[A-Za-z0-9_-]+$/);
  assert.ok(box.ownerToken.length >= 40);

  const publicView = await store.publicBox(box.id);
  assert.equal(publicView.name, 'Tita');
  assert.equal(publicView.open, true);
  // The owner hash must never be part of the public shape.
  assert.equal('ownerHash' in publicView, false);
});

test('the stored box does not contain the owner token in the clear', async () => {
  const blobs = new FakeBlobs();
  const store = new HushStore(blobs);
  const box = await store.createBox({ name: 'Tita', prompt: 'ask' });

  const raw = JSON.stringify(blobs.dump());
  assert.equal(raw.includes(box.ownerToken), false, 'raw token must not be stored');
  assert.ok(raw.includes('scrypt$'), 'a scrypt hash should be present instead');
});

test('messages come back newest first', async () => {
  let now = 1_000_000;
  const store = new HushStore(new FakeBlobs(), { now: () => now });
  const { id } = await store.createBox({ name: 'A', prompt: 'q' });

  await store.addMessage(id, 'first');
  now += 1000;
  await store.addMessage(id, 'second');
  now += 1000;
  await store.addMessage(id, 'third');

  const messages = await store.listMessages(id);
  assert.deepEqual(messages.map((m) => m.text), ['third', 'second', 'first']);
});

test('messages are isolated per box', async () => {
  const store = new HushStore(new FakeBlobs());
  const a = await store.createBox({ name: 'A', prompt: 'q' });
  const b = await store.createBox({ name: 'B', prompt: 'q' });

  await store.addMessage(a.id, 'for A');
  await store.addMessage(b.id, 'for B');

  assert.deepEqual((await store.listMessages(a.id)).map((m) => m.text), ['for A']);
  assert.deepEqual((await store.listMessages(b.id)).map((m) => m.text), ['for B']);
});

test('deleting a message removes only that message', async () => {
  const store = new HushStore(new FakeBlobs());
  const { id } = await store.createBox({ name: 'A', prompt: 'q' });

  await store.addMessage(id, 'keep me');
  await store.addMessage(id, 'delete me');

  const before = await store.listMessages(id);
  const target = before.find((m) => m.text === 'delete me');
  await store.deleteMessage(target.key);

  const after = await store.listMessages(id);
  assert.equal(after.length, 1);
  assert.equal(after[0].text, 'keep me');
});

test('countMessages tracks the inbox size', async () => {
  const store = new HushStore(new FakeBlobs());
  const { id } = await store.createBox({ name: 'A', prompt: 'q' });

  assert.equal(await store.countMessages(id), 0);
  await store.addMessage(id, 'one');
  await store.addMessage(id, 'two');
  assert.equal(await store.countMessages(id), 2);
});

test('closing a box is persisted', async () => {
  const store = new HushStore(new FakeBlobs());
  const { id } = await store.createBox({ name: 'A', prompt: 'q' });

  const box = await store.getBox(id);
  box.open = false;
  await store.saveBox(box);

  assert.equal((await store.publicBox(id)).open, false);
});

test('an unknown box has no public view', async () => {
  const store = new HushStore(new FakeBlobs());
  assert.equal(await store.publicBox('does-not-exist'), null);
});

test('the inbox cap is enforced by the caller, and the constant is sane', () => {
  assert.equal(MAX_MESSAGES_PER_BOX, 500);
});

/* ------------------------------------------------------------- rate limiter */

test('the limiter allows up to the cap then refuses, per minute', async () => {
  let now = 0;
  const limiter = new MinuteLimiter(new FakeBlobs(), { limit: 3, now: () => now });

  assert.equal((await limiter.hit('bucket')).allowed, true);
  assert.equal((await limiter.hit('bucket')).allowed, true);
  assert.equal((await limiter.hit('bucket')).allowed, true);
  assert.equal((await limiter.hit('bucket')).allowed, false);

  // Next minute, fresh budget.
  now += 60_000;
  assert.equal((await limiter.hit('bucket')).allowed, true);
});

test('the limiter keeps buckets independent', async () => {
  const limiter = new MinuteLimiter(new FakeBlobs(), { limit: 1 });
  assert.equal((await limiter.hit('a')).allowed, true);
  assert.equal((await limiter.hit('a')).allowed, false);
  assert.equal((await limiter.hit('b')).allowed, true);
});

test('client buckets are salted per box and not reversible to an IP', () => {
  const a = clientBucket('203.0.113.9', 'box-one');
  const b = clientBucket('203.0.113.9', 'box-two');

  assert.notEqual(a, b, 'the same IP must not produce the same bucket across boxes');
  assert.equal(a.includes('203.0.113.9'), false);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.equal(clientBucket('203.0.113.9', 'box-one'), a, 'stable within a box');
});
