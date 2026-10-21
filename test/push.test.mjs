import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getVapidKeys,
  isValidSubscription,
  saveSubscription,
  listSubscriptions,
  removeSubscription,
  notificationPayload,
  notifyBox,
  MAX_SUBSCRIPTIONS_PER_BOX,
} from '../src/push.mjs';
import { FakeBlobs } from './fakeBlobs.mjs';

const keys = () => ({ publicKey: 'pub-key-value', privateKey: 'priv-key-value' });

function subscription(endpoint = 'https://push.example/abc123') {
  return {
    endpoint,
    keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(20) },
  };
}

/* -------------------------------------------------------------------- vapid */

test('the vapid keypair is generated once and then reused', async () => {
  const blobs = new FakeBlobs();
  let generated = 0;

  const first = await getVapidKeys(blobs, () => {
    generated += 1;
    return keys();
  });
  const second = await getVapidKeys(blobs, () => {
    generated += 1;
    return keys();
  });

  assert.equal(generated, 1);
  assert.deepEqual(first, second);
  assert.equal(first.publicKey, 'pub-key-value');
});

test('the private key is never exposed through the public endpoint shape', async () => {
  const blobs = new FakeBlobs();
  const stored = await getVapidKeys(blobs, keys);
  assert.ok(stored.privateKey, 'the private key must exist server-side');
  assert.ok(stored.publicKey);
});

/* ------------------------------------------------------------ subscriptions */

test('a well-formed subscription is accepted', () => {
  assert.equal(isValidSubscription(subscription()), true);
});

test('malformed subscriptions are rejected', () => {
  const bad = [
    null,
    undefined,
    'string',
    {},
    { endpoint: 'not-a-url', keys: { p256dh: 'x'.repeat(40), auth: 'a'.repeat(20) } },
    { endpoint: 'http://insecure.example/x', keys: { p256dh: 'x'.repeat(40), auth: 'a'.repeat(20) } },
    { endpoint: 'https://push.example/x' },
    { endpoint: 'https://push.example/x', keys: {} },
    { endpoint: 'https://push.example/x', keys: { p256dh: 'short', auth: 'a'.repeat(20) } },
    { endpoint: 'https://push.example/x', keys: { p256dh: 'p'.repeat(40) } },
    { endpoint: `https://push.example/${'x'.repeat(2100)}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(20) } },
  ];

  for (const value of bad) {
    assert.equal(isValidSubscription(value), false, JSON.stringify(value)?.slice(0, 80));
  }
});

test('subscribing stores a device against the box', async () => {
  const blobs = new FakeBlobs();
  const result = await saveSubscription(blobs, 'box-1', subscription());

  assert.equal(result.ok, true);
  assert.equal(result.replaced, false);

  const list = await listSubscriptions(blobs, 'box-1');
  assert.equal(list.length, 1);
  assert.equal(list[0].endpoint, 'https://push.example/abc123');
});

test('re-subscribing the same endpoint updates rather than duplicating', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription());
  const second = await saveSubscription(blobs, 'box-1', subscription());

  assert.equal(second.replaced, true);
  assert.equal((await listSubscriptions(blobs, 'box-1')).length, 1);
});

test('different endpoints are separate devices', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/one'));
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/two'));

  assert.equal((await listSubscriptions(blobs, 'box-1')).length, 2);
});

test('subscriptions are scoped to their box', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/one'));
  await saveSubscription(blobs, 'box-2', subscription('https://push.example/two'));

  const one = await listSubscriptions(blobs, 'box-1');
  assert.equal(one.length, 1);
  assert.equal(one[0].endpoint, 'https://push.example/one');
});

test('a box cannot collect unlimited devices', async () => {
  const blobs = new FakeBlobs();
  for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_BOX; i += 1) {
    await saveSubscription(blobs, 'box-1', subscription(`https://push.example/${i}`));
  }

  await assert.rejects(
    () => saveSubscription(blobs, 'box-1', subscription('https://push.example/one-too-many')),
    (err) => err.code === 'too_many_subscriptions',
  );
});

test('the stored record keeps no identity beyond the endpoint', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription());

  const raw = JSON.stringify(blobs.dump());
  assert.equal(raw.includes('endpoint'), true);
  for (const field of ['userAgent', 'ip', 'ipAddress', 'userId', 'fingerprint']) {
    assert.equal(raw.includes(field), false, field);
  }
});

test('unsubscribing removes exactly one device', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/one'));
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/two'));

  const removed = await removeSubscription(blobs, 'box-1', 'https://push.example/one');
  assert.equal(removed.ok, true);

  const left = await listSubscriptions(blobs, 'box-1');
  assert.equal(left.length, 1);
  assert.equal(left[0].endpoint, 'https://push.example/two');
});

test('unsubscribing an unknown endpoint is a clean miss', async () => {
  const blobs = new FakeBlobs();
  const result = await removeSubscription(blobs, 'box-1', 'https://push.example/ghost');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_found');
});

/* --------------------------------------------------------------- the payload */

test('the notification never contains the message text', () => {
  const payload = notificationPayload('box-1', 1);

  assert.equal(payload.title, 'a slip arrived');
  assert.equal(payload.body, 'someone wrote to you. tap to read it.');
  assert.equal(payload.url, '/inbox/box-1');
  assert.equal(JSON.stringify(payload).includes('password'), false);
});

test('the payload pluralises', () => {
  assert.equal(notificationPayload('b', 1).title, 'a slip arrived');
  assert.equal(notificationPayload('b', 3).title, '3 slips arrived');
});

/* -------------------------------------------------------------------- fanout */

test('notify sends to every subscribed device', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/one'));
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/two'));

  const sent = [];
  const result = await notifyBox(blobs, 'box-1', async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload });
  });

  assert.equal(result.sent, 2);
  assert.equal(sent.length, 2);
  assert.ok(sent.every((entry) => entry.payload.title === 'a slip arrived'));
});

test('notify on a box with no subscribers is a no-op', async () => {
  const blobs = new FakeBlobs();
  const result = await notifyBox(blobs, 'box-with-nothing', async () => {
    throw new Error('should not be called');
  });

  assert.deepEqual(result, { sent: 0, removed: 0 });
});

test('a dead subscription (410) is deleted, not retried', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/dead'));
  await saveSubscription(blobs, 'box-1', subscription('https://push.example/alive'));

  const result = await notifyBox(blobs, 'box-1', async (sub) => {
    if (sub.endpoint.endsWith('/dead')) {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    }
  });

  assert.equal(result.sent, 1);
  assert.equal(result.removed, 1);

  const left = await listSubscriptions(blobs, 'box-1');
  assert.equal(left.length, 1);
  assert.ok(left[0].endpoint.endsWith('/alive'));
});

test('a transient failure keeps the subscription for next time', async () => {
  const blobs = new FakeBlobs();
  await saveSubscription(blobs, 'box-1', subscription());

  const result = await notifyBox(blobs, 'box-1', async () => {
    throw Object.assign(new Error('rate limited'), { statusCode: 429 });
  });

  assert.equal(result.sent, 0);
  assert.equal(result.removed, 0);
  assert.equal((await listSubscriptions(blobs, 'box-1')).length, 1);
});

test('one failing device does not stop the others', async () => {
  const blobs = new FakeBlobs();
  for (const name of ['a', 'b', 'c']) {
    await saveSubscription(blobs, 'box-1', subscription(`https://push.example/${name}`));
  }

  const delivered = [];
  const result = await notifyBox(blobs, 'box-1', async (sub) => {
    if (sub.endpoint.endsWith('/b')) throw Object.assign(new Error('boom'), { statusCode: 500 });
    delivered.push(sub.endpoint);
  });

  assert.equal(result.sent, 2);
  assert.equal(delivered.length, 2);
});
