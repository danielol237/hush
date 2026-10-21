// Netlify entrypoint. All the logic lives in src/api.mjs so it can be tested
// without a network; this file only supplies the real blob store and the real
// push sender.

import { getStore } from '@netlify/blobs';
import webpush from 'web-push';
import { createHushHandler } from '../../src/api.mjs';
import { getVapidKeys } from '../../src/push.mjs';

const blobs = getStore({ name: 'hush', consistency: 'strong' });

let cachedKeys = null;

/** Generate a VAPID keypair the first time it is needed. */
async function keys() {
  if (!cachedKeys) {
    cachedKeys = await getVapidKeys(blobs, () => webpush.generateVAPIDKeys());
    webpush.setVapidDetails('mailto:hush@mail.tryaxon.site', cachedKeys.publicKey, cachedKeys.privateKey);
  }
  return cachedKeys;
}

const handler = createHushHandler({
  blobs,
  generateVapidKeys: () => webpush.generateVAPIDKeys(),
  sendPush: async (subscription, payload) => {
    await keys();
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify(payload),
    );
  },
});

export default handler;
export const config = { path: '/api/*' };
