/**
 * Push notifications for Hush.
 *
 * The hard part is not the push protocol — it is doing it without accounts and
 * without an environment variable. So the VAPID keypair bootstraps itself: the
 * first request that needs it generates a pair and writes it to Blobs, and every
 * later request reads the same pair. No dashboard configuration, no secrets in
 * the repo.
 *
 * A subscription is stored against the box it belongs to, and only the holder
 * of the owner token can create or remove one. That keeps the promise intact:
 * the server knows "this browser wants to hear about this box", and nothing
 * about who owns it.
 */

import { createHash } from 'node:crypto';

/** One browser per device; ten devices per box is generous and bounded. */
export const MAX_SUBSCRIPTIONS_PER_BOX = 10;

const VAPID_KEY = 'push:vapid';

function endpointHash(endpoint) {
  return createHash('sha256').update(endpoint).digest('base64url').slice(0, 24);
}

function subscriptionKey(boxId, endpoint) {
  return `push:sub:${boxId}:${endpointHash(endpoint)}`;
}

/**
 * Read the VAPID keypair, creating it on first use.
 *
 * `generateKeys` is injected so tests do not need web-push installed, and so the
 * caller controls where the keys come from in production.
 */
export async function getVapidKeys(blobs, generateKeys) {
  const existing = await blobs.get(VAPID_KEY, { type: 'json' });
  if (existing?.publicKey && existing?.privateKey) return existing;

  const keys = generateKeys();
  await blobs.setJSON(VAPID_KEY, keys);

  // A concurrent first request may have won the race; prefer whatever is now
  // stored so every client ends up with the same public key.
  const settled = await blobs.get(VAPID_KEY, { type: 'json' });
  return settled?.publicKey ? settled : keys;
}

/** Shape-check a browser PushSubscription before we store it. */
export function isValidSubscription(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof value.endpoint !== 'string') return false;
  if (!/^https:\/\//.test(value.endpoint)) return false;
  if (value.endpoint.length > 2048) return false;

  const keys = value.keys;
  if (!keys || typeof keys !== 'object') return false;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length < 20) return false;
  if (typeof keys.auth !== 'string' || keys.auth.length < 8) return false;

  return true;
}

export async function saveSubscription(blobs, boxId, subscription) {
  if (!isValidSubscription(subscription)) {
    throw Object.assign(new Error('invalid subscription'), { code: 'invalid_subscription' });
  }

  const { blobs: existing } = await blobs.list({ prefix: `push:sub:${boxId}:` });
  const key = subscriptionKey(boxId, subscription.endpoint);

  // Re-subscribing the same endpoint is an update, not a new slot.
  const isUpdate = existing.some((entry) => entry.key === key);
  if (!isUpdate && existing.length >= MAX_SUBSCRIPTIONS_PER_BOX) {
    throw Object.assign(new Error('too many subscriptions'), { code: 'too_many_subscriptions' });
  }

  await blobs.setJSON(key, {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    createdAt: Date.now(),
  });

  return { ok: true, replaced: isUpdate };
}

export async function listSubscriptions(blobs, boxId) {
  const { blobs: entries } = await blobs.list({ prefix: `push:sub:${boxId}:` });
  const out = [];
  for (const entry of entries) {
    const value = await blobs.get(entry.key, { type: 'json' });
    if (value?.endpoint) out.push({ key: entry.key, ...value });
  }
  return out;
}

export async function removeSubscription(blobs, boxId, endpoint) {
  const key = subscriptionKey(boxId, endpoint);
  const existing = await blobs.get(key);
  if (!existing) return { ok: false, reason: 'not_found' };
  await blobs.delete(key);
  return { ok: true };
}

/**
 * The notification body.
 *
 * Deliberately vague. A push notification is rendered on a lock screen, in front
 * of whoever is holding the phone — so it says that a message arrived and
 * nothing else. Putting the text in here would undo the product on the one
 * surface the owner does not control.
 */
export function notificationPayload(boxId, count) {
  return {
    title: count === 1 ? 'a slip arrived' : `${count} slips arrived`,
    body: 'someone wrote to you. tap to read it.',
    url: `/inbox/${boxId}`,
    tag: `hush-${boxId}`,
  };
}

/**
 * Fan a notification out to every device subscribed to a box.
 *
 * A 404 or 410 from the push service means the subscription is dead — the user
 * cleared site data, or the browser rotated it. Those are deleted rather than
 * retried, otherwise every send pays for a corpse forever.
 */
export async function notifyBox(blobs, boxId, sendPush, { count = 1 } = {}) {
  const subscriptions = await listSubscriptions(blobs, boxId);
  if (subscriptions.length === 0) return { sent: 0, removed: 0 };

  const payload = notificationPayload(boxId, count);
  let sent = 0;
  let removed = 0;

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await sendPush(subscription, payload);
        sent += 1;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) {
          await blobs.delete(subscription.key);
          removed += 1;
          return;
        }
        // Anything else (rate limit, timeout) is transient: keep the
        // subscription and let the next message try again.
        console.error('[hush] push failed', err?.statusCode ?? err?.message);
      }
    }),
  );

  return { sent, removed };
}
