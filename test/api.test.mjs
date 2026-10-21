import test from 'node:test';
import assert from 'node:assert/strict';
import { createHushHandler } from '../src/api.mjs';
import { FakeBlobs } from './fakeBlobs.mjs';

/** Boot the handler over a fake store and return a fetch-like helper. */
function boot(options = {}) {
  const blobs = options.blobs ?? new FakeBlobs();
  const handler = createHushHandler({ blobs, ...options });

  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const request = new Request(`https://hush.test${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await handler(request);
    const text = await response.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  };

  return { blobs, call };
}

/** Create a box and return its public id plus owner token. */
async function makeBox(call, name = 'Tita') {
  const res = await call('/api/boxes', { method: 'POST', body: { name, prompt: 'ask me anything' } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/* ------------------------------------------------------------------- create */

test('creating a box returns a shareable id and a private owner token', async () => {
  const { call } = boot();
  const res = await call('/api/boxes', { method: 'POST', body: { name: 'Tita', prompt: 'say it' } });

  assert.equal(res.status, 201);
  assert.match(res.body.id, /^[A-Za-z0-9_-]+$/);
  assert.ok(res.body.ownerToken.length >= 40);
  assert.equal(typeof res.body.createdAt, 'number');
});

test('the owner token is never returned again', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  const pub = await call(`/api/boxes/${box.id}`);
  assert.equal(pub.status, 200);
  assert.equal('ownerToken' in pub.body, false);
  assert.equal('ownerHash' in pub.body, false);
});

test('create rejects a missing name', async () => {
  const { call } = boot();
  for (const body of [{}, { name: '' }, { name: '   ' }, { name: null }, { name: 'x'.repeat(41) }]) {
    const res = await call('/api/boxes', { method: 'POST', body });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_name');
  }
});

test('create rejects malformed json and oversized bodies', async () => {
  const { call } = boot();

  const bad = await call('/api/boxes', { method: 'POST', body: undefined, headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);

  const request = new Request('https://hush.test/api/boxes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'a'.repeat(70_000) }),
  });
  const handler = createHushHandler({ blobs: new FakeBlobs() });
  const response = await handler(request);
  assert.equal(response.status, 413);
});

/* --------------------------------------------------------------------- send */

test('a message lands in the inbox without any sender identity', async () => {
  const { call, blobs } = boot();
  const box = await makeBox(call);

  const sent = await call(`/api/boxes/${box.id}/messages`, {
    method: 'POST',
    body: { text: 'you are the funniest person I know' },
    headers: { 'x-nf-client-connection-ip': '203.0.113.9' },
  });
  assert.equal(sent.status, 201);
  assert.deepEqual(sent.body, { ok: true });

  const raw = JSON.stringify(blobs.dump());
  assert.equal(raw.includes('203.0.113.9'), false, 'the sender IP must never be stored');
});

test('the send response is identical for every sender', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  const a = await call(`/api/boxes/${box.id}/messages`, {
    method: 'POST',
    body: { text: 'hello from one' },
    headers: { 'x-nf-client-connection-ip': '198.51.100.1' },
  });
  const b = await call(`/api/boxes/${box.id}/messages`, {
    method: 'POST',
    body: { text: 'hello from another' },
    headers: { 'x-nf-client-connection-ip': '198.51.100.2' },
  });

  assert.equal(a.status, b.status);
  assert.deepEqual(a.body, b.body);
});

test('sending rejects empty, oversized, and missing text', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  for (const body of [{}, { text: '' }, { text: '   ' }, { text: null }]) {
    const res = await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body });
    assert.equal(res.status, 400);
  }

  const long = await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'a'.repeat(501) } });
  assert.equal(long.status, 400);
  assert.equal(long.body.error, 'text_too_long');

  const exact = await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'a'.repeat(500) } });
  assert.equal(exact.status, 201);
});

test('a closed box refuses new messages', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  const closed = await call(`/api/boxes/${box.id}/close`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken, open: false },
  });
  assert.equal(closed.status, 200);

  const res = await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'anyone there' } });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'closed');
});

test('sending to an unknown box is a plain 404', async () => {
  const { call } = boot();
  const res = await call('/api/boxes/nope/messages', { method: 'POST', body: { text: 'hi' } });
  assert.equal(res.status, 404);
});

/* -------------------------------------------------------------------- inbox */

test('the owner reads their messages, newest first', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'first' } });
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'second' } });

  const inbox = await call(`/api/boxes/${box.id}/inbox`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken },
  });

  assert.equal(inbox.status, 200);
  assert.deepEqual(inbox.body.messages.map((m) => m.text), ['second', 'first']);
  assert.equal(inbox.body.box.name, 'Tita');
});

test('a wrong owner token is refused', async () => {
  const { call } = boot();
  const box = await makeBox(call);
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'secret words' } });

  for (const ownerToken of ['wrong', '', 'a'.repeat(43)]) {
    const res = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken } });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'bad_token');
    assert.equal(JSON.stringify(res.body).includes('secret words'), false);
  }
});

test('the inbox cannot be read with only the public id', async () => {
  const { call } = boot();
  const box = await makeBox(call);
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'private' } });

  const res = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: {} });
  assert.equal(res.status, 403);
});

test('GET on the inbox path does not leak anything', async () => {
  const { call } = boot();
  const box = await makeBox(call);
  const res = await call(`/api/boxes/${box.id}/inbox`);
  assert.equal(res.status, 404);
});

test('the inbox reports which messages were flagged, and why', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'you are lovely' } });
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'text me on 08031234567' } });

  const inbox = await call(`/api/boxes/${box.id}/inbox`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken },
  });

  const flagged = inbox.body.messages.filter((m) => m.flagged);
  assert.equal(flagged.length, 1);
  assert.ok(flagged[0].reasons.includes('phone'));
});

/* ------------------------------------------------------------------- delete */

test('the owner deletes a single message', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'keep' } });
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'remove' } });

  let inbox = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken: box.ownerToken } });
  const target = inbox.body.messages.find((m) => m.text === 'remove');

  const del = await call(`/api/boxes/${box.id}/messages/${target.id}`, {
    method: 'DELETE',
    body: { ownerToken: box.ownerToken },
  });
  assert.equal(del.status, 200);

  inbox = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken: box.ownerToken } });
  assert.deepEqual(inbox.body.messages.map((m) => m.text), ['keep']);
});

test('deleting requires the owner token', async () => {
  const { call } = boot();
  const box = await makeBox(call);
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'mine' } });

  const inbox = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken: box.ownerToken } });
  const id = inbox.body.messages[0].id;

  const res = await call(`/api/boxes/${box.id}/messages/${id}`, {
    method: 'DELETE',
    body: { ownerToken: 'wrong-token' },
  });
  assert.equal(res.status, 403);

  const still = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken: box.ownerToken } });
  assert.equal(still.body.messages.length, 1);
});

test('deleting an unknown message is a 404', async () => {
  const { call } = boot();
  const box = await makeBox(call);
  const res = await call(`/api/boxes/${box.id}/messages/nope`, {
    method: 'DELETE',
    body: { ownerToken: box.ownerToken },
  });
  assert.equal(res.status, 404);
});

/* ---------------------------------------------------------------- rate limit */

test('sending is rate limited per client', async () => {
  const { call } = boot({ limit: 3 });
  const box = await makeBox(call);

  let last;
  for (let i = 0; i < 5; i += 1) {
    last = await call(`/api/boxes/${box.id}/messages`, {
      method: 'POST',
      body: { text: `spam ${i}` },
      headers: { 'x-nf-client-connection-ip': '192.0.2.7' },
    });
  }
  assert.equal(last.status, 429);
  assert.equal(last.body.error, 'rate_limited');
});

test('rate limiting one sender does not block another', async () => {
  const { call } = boot({ limit: 2 });
  const box = await makeBox(call);

  for (let i = 0; i < 3; i += 1) {
    await call(`/api/boxes/${box.id}/messages`, {
      method: 'POST',
      body: { text: 'x' },
      headers: { 'x-nf-client-connection-ip': '192.0.2.1' },
    });
  }

  const other = await call(`/api/boxes/${box.id}/messages`, {
    method: 'POST',
    body: { text: 'from somewhere else' },
    headers: { 'x-nf-client-connection-ip': '192.0.2.2' },
  });
  assert.equal(other.status, 201);
});

/* ------------------------------------------------------------------- misc */

test('health responds', async () => {
  const { call } = boot();
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('security headers are on every response', async () => {
  const { call } = boot();
  const res = await call('/api/health');

  assert.ok(res.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('unknown api routes are json 404s', async () => {
  const { call } = boot();
  const res = await call('/api/nothing');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

test('the full journey: create, send, read, delete, close', async () => {
  const { call } = boot();
  const box = await makeBox(call, 'Tita');

  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'I think about you a lot' } });
  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'you talk too much' } });

  let inbox = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken: box.ownerToken } });
  assert.equal(inbox.body.messages.length, 2);

  const mean = inbox.body.messages.find((m) => m.text === 'you talk too much');
  await call(`/api/boxes/${box.id}/messages/${mean.id}`, {
    method: 'DELETE',
    body: { ownerToken: box.ownerToken },
  });

  inbox = await call(`/api/boxes/${box.id}/inbox`, { method: 'POST', body: { ownerToken: box.ownerToken } });
  assert.deepEqual(inbox.body.messages.map((m) => m.text), ['I think about you a lot']);

  await call(`/api/boxes/${box.id}/close`, { method: 'POST', body: { ownerToken: box.ownerToken, open: false } });
  const blocked = await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'hello?' } });
  assert.equal(blocked.status, 403);
});
