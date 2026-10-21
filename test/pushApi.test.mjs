import test from 'node:test';
import assert from 'node:assert/strict';
import { createHushHandler } from '../src/api.mjs';
import { listSubscriptions } from '../src/push.mjs';
import { FakeBlobs } from './fakeBlobs.mjs';

/** Boot with push wired to a fake sender so nothing leaves the process. */
function boot({ push = true, ...options } = {}) {
  const blobs = options.blobs ?? new FakeBlobs();
  const sent = [];

  const handler = createHushHandler({
    blobs,
    ...(push
      ? {
          generateVapidKeys: () => ({ publicKey: 'test-public-key', privateKey: 'test-private-key' }),
          sendPush: async (subscription, payload) => {
            sent.push({ endpoint: subscription.endpoint, payload });
          },
        }
      : {}),
    ...options,
  });

  const call = async (path, { method = 'GET', body } = {}) => {
    const request = new Request(`https://hush.test${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
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
    return { status: response.status, body: parsed };
  };

  return { blobs, call, sent };
}

async function makeBox(call, name = 'Tita') {
  const res = await call('/api/boxes', { method: 'POST', body: { name, prompt: 'ask me' } });
  assert.equal(res.status, 201);
  return res.body;
}

const device = (n = 1) => ({
  endpoint: `https://push.example/device-${n}`,
  keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(20) },
});

/* ------------------------------------------------------------------- the key */

test('the public key is available without authentication', async () => {
  const { call } = boot();
  const res = await call('/api/push/key');

  assert.equal(res.status, 200);
  assert.equal(res.body.publicKey, 'test-public-key');
  assert.equal('privateKey' in res.body, false, 'the private key must never be sent to a browser');
});

test('push endpoints report unavailable when push is not configured', async () => {
  const { call } = boot({ push: false });
  const res = await call('/api/push/key');
  assert.equal(res.status, 503);
  assert.equal(res.body.error, 'push_unavailable');
});

/* ------------------------------------------------------------ subscribing */

test('the owner can subscribe a device to their box', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  const res = await call(`/api/boxes/${box.id}/push`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken, subscription: device(1) },
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('subscribing requires the owner token', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  for (const ownerToken of [undefined, '', 'wrong-token']) {
    const res = await call(`/api/boxes/${box.id}/push`, {
      method: 'POST',
      body: { ownerToken, subscription: device(1) },
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'bad_token');
  }
});

test('subscribing rejects a malformed subscription', async () => {
  const { call } = boot();
  const box = await makeBox(call);

  for (const subscription of [null, {}, { endpoint: 'nope' }, { endpoint: 'https://x.example/a' }]) {
    const res = await call(`/api/boxes/${box.id}/push`, {
      method: 'POST',
      body: { ownerToken: box.ownerToken, subscription },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_subscription');
  }
});

test('subscribing to an unknown box is a 404', async () => {
  const { call } = boot();
  const res = await call('/api/boxes/does-not-exist/push', {
    method: 'POST',
    body: { ownerToken: 'x', subscription: device(1) },
  });
  assert.equal(res.status, 404);
});

test('the owner can unsubscribe a device', async () => {
  const { blobs, call } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/push`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken, subscription: device(1) },
  });

  const res = await call(`/api/boxes/${box.id}/push`, {
    method: 'DELETE',
    body: { ownerToken: box.ownerToken, endpoint: device(1).endpoint },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  assert.equal((await listSubscriptions(blobs, box.id)).length, 0);
});

test('unsubscribing needs an endpoint', async () => {
  const { call } = boot();
  const box = await makeBox(call);
  const res = await call(`/api/boxes/${box.id}/push`, {
    method: 'DELETE',
    body: { ownerToken: box.ownerToken },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'missing_endpoint');
});

/* ------------------------------------------------------------- notifying */

test('a new message notifies the subscribed owner', async () => {
  const { call, sent } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/push`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken, subscription: device(1) },
  });

  const res = await call(`/api/boxes/${box.id}/messages`, {
    method: 'POST',
    body: { text: 'i have been meaning to tell you something' },
  });
  assert.equal(res.status, 201);

  // notifyBox is fired without awaiting, so give the microtask queue a turn.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.title, 'a slip arrived');
  assert.equal(sent[0].payload.url, `/inbox/${box.id}`);
});

test('the notification body never carries the message text', async () => {
  const { call, sent } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/push`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken, subscription: device(1) },
  });

  await call(`/api/boxes/${box.id}/messages`, {
    method: 'POST',
    body: { text: 'my password is hunter2hunter2' },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const serialised = JSON.stringify(sent[0].payload);
  assert.equal(serialised.includes('hunter2'), false);
  assert.equal(serialised.includes('password'), false);
});

test('no subscribers means no send attempt', async () => {
  const { call, sent } = boot();
  const box = await makeBox(call);

  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'hello' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 0);
});

test('every subscribed device is notified', async () => {
  const { call, sent } = boot();
  const box = await makeBox(call);

  for (const n of [1, 2, 3]) {
    await call(`/api/boxes/${box.id}/push`, {
      method: 'POST',
      body: { ownerToken: box.ownerToken, subscription: device(n) },
    });
  }

  await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'hi' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sent.length, 3);
});

test('a failing push does not break sending a message', async () => {
  const blobs = new FakeBlobs();
  const handler = createHushHandler({
    blobs,
    generateVapidKeys: () => ({ publicKey: 'pub', privateKey: 'priv' }),
    sendPush: async () => {
      throw Object.assign(new Error('push service down'), { statusCode: 500 });
    },
  });

  const call = async (path, { method = 'GET', body } = {}) => {
    const request = new Request(`https://hush.test${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const response = await handler(request);
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  const box = await makeBox(call);
  await call(`/api/boxes/${box.id}/push`, {
    method: 'POST',
    body: { ownerToken: box.ownerToken, subscription: device(1) },
  });

  const res = await call(`/api/boxes/${box.id}/messages`, { method: 'POST', body: { text: 'still works' } });
  assert.equal(res.status, 201, 'the sender must not be told about a push failure');
});

test('the sender learns nothing about whether the owner has notifications on', async () => {
  const { call } = boot();
  const withPush = await makeBox(call, 'has push');
  const withoutPush = await makeBox(call, 'no push');

  await call(`/api/boxes/${withPush.id}/push`, {
    method: 'POST',
    body: { ownerToken: withPush.ownerToken, subscription: device(1) },
  });

  const a = await call(`/api/boxes/${withPush.id}/messages`, { method: 'POST', body: { text: 'x' } });
  const b = await call(`/api/boxes/${withoutPush.id}/messages`, { method: 'POST', body: { text: 'x' } });

  assert.equal(a.status, b.status);
  assert.deepEqual(a.body, b.body);
});
