// Netlify entrypoint. All the logic lives in src/api.mjs so it can be tested
// without a network; this file only supplies the real blob store.

import { getStore } from '@netlify/blobs';
import { createHushHandler } from '../../src/api.mjs';

const handler = createHushHandler({
  blobs: getStore({ name: 'hush', consistency: 'strong' }),
});

export default handler;
export const config = { path: '/api/*' };
