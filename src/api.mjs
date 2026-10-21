// Hush HTTP API.
//
// Written as a factory over a blob store so the whole contract can be tested
// against an in-memory fake, with the Netlify function being a thin wrapper
// that supplies the real store.

import {
  HushStore,
  MinuteLimiter,
  clientBucket,
  validateName,
  validatePrompt,
  validateText,
  verifyOwnerToken,
  MAX_MESSAGES_PER_BOX,
} from './core.mjs';

export const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cache-Control': 'no-store',
};

const MAX_BODY = 64 * 1024;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

function clientIp(req) {
  return (
    req.headers.get('x-nf-client-connection-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

async function readJson(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) return { error: 'payload_too_large' };
  if (text.length === 0) return { value: {} };
  try {
    return { value: JSON.parse(text) };
  } catch {
    return { error: 'invalid_json' };
  }
}

/**
 * @param {object} options
 * @param {{get:Function,set:Function,setJSON:Function,delete:Function,list:Function}} options.blobs
 */
export function createHushHandler({ blobs, now = () => Date.now(), limit = 6 } = {}) {
  const store = new HushStore(blobs, { now });
  const limiter = new MinuteLimiter(blobs, { limit, now });

  return async function handler(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '') || '/';

    try {
      if (path === '/health') {
        return json(200, { status: 'ok' });
      }

      // ---- create a box ------------------------------------------------
      if (path === '/boxes' && req.method === 'POST') {
        const gate = await limiter.hit(`create:${clientIp(req)}`);
        if (!gate.allowed) return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });

        const parsed = await readJson(req);
        if (parsed.error === 'payload_too_large') return json(413, { error: 'payload_too_large' });
        if (parsed.error) return json(400, { error: parsed.error });

        const name = validateName(parsed.value?.name);
        if (!name.ok) return json(400, { error: name.error });

        const prompt = validatePrompt(parsed.value?.prompt);
        if (!prompt.ok) return json(400, { error: prompt.error });

        const box = await store.createBox({ name: name.value, prompt: prompt.value });
        return json(201, box);
      }

      // ---- public box --------------------------------------------------
      const boxMatch = /^\/boxes\/([A-Za-z0-9_-]{1,64})$/.exec(path);
      if (boxMatch && req.method === 'GET') {
        const box = await store.publicBox(boxMatch[1]);
        if (!box) return json(404, { error: 'not_found' });
        return json(200, box);
      }

      // ---- send a message ----------------------------------------------
      const sendMatch = /^\/boxes\/([A-Za-z0-9_-]{1,64})\/messages$/.exec(path);
      if (sendMatch && req.method === 'POST') {
        const boxId = sendMatch[1];
        const box = await store.getBox(boxId);
        if (!box) return json(404, { error: 'not_found' });
        if (!box.open) return json(403, { error: 'closed' });

        const gate = await limiter.hit(`send:${clientBucket(clientIp(req), boxId)}`);
        if (!gate.allowed) return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });

        const parsed = await readJson(req);
        if (parsed.error === 'payload_too_large') return json(413, { error: 'payload_too_large' });
        if (parsed.error) return json(400, { error: parsed.error });

        const text = validateText(parsed.value?.text);
        if (!text.ok) return json(400, { error: text.error });

        if ((await store.countMessages(boxId)) >= MAX_MESSAGES_PER_BOX) {
          return json(507, { error: 'inbox_full' });
        }

        await store.addMessage(boxId, text.value);
        // Identical response for every sender, always. Nothing about who sent it.
        return json(201, { ok: true });
      }

      // ---- owner: read inbox -------------------------------------------
      const inboxMatch = /^\/boxes\/([A-Za-z0-9_-]{1,64})\/inbox$/.exec(path);
      if (inboxMatch && req.method === 'POST') {
        const box = await store.getBox(inboxMatch[1]);
        if (!box) return json(404, { error: 'not_found' });

        const parsed = await readJson(req);
        if (parsed.error) return json(400, { error: parsed.error });

        if (!verifyOwnerToken(parsed.value?.ownerToken ?? '', box.ownerHash)) {
          return json(403, { error: 'bad_token' });
        }

        const messages = await store.listMessages(inboxMatch[1]);
        return json(200, {
          box: {
            id: box.id,
            name: box.name,
            prompt: box.prompt,
            open: box.open,
            createdAt: box.createdAt,
          },
          // Strip the internal storage key: the client only needs the id.
          messages: messages.map(({ id, text, createdAt, flagged, reasons }) => ({
            id,
            text,
            createdAt,
            flagged,
            reasons,
          })),
        });
      }

      // ---- owner: open / close -----------------------------------------
      const closeMatch = /^\/boxes\/([A-Za-z0-9_-]{1,64})\/close$/.exec(path);
      if (closeMatch && req.method === 'POST') {
        const box = await store.getBox(closeMatch[1]);
        if (!box) return json(404, { error: 'not_found' });

        const parsed = await readJson(req);
        if (parsed.error) return json(400, { error: parsed.error });
        if (!verifyOwnerToken(parsed.value?.ownerToken ?? '', box.ownerHash)) {
          return json(403, { error: 'bad_token' });
        }

        // Toggle, so the same button reopens a closed box.
        box.open = parsed.value?.open === undefined ? !box.open : Boolean(parsed.value.open);
        await store.saveBox(box);
        return json(200, { ok: true, open: box.open });
      }

      // ---- owner: delete one message -----------------------------------
      const delMatch = /^\/boxes\/([A-Za-z0-9_-]{1,64})\/messages\/([A-Za-z0-9_-]{1,96})$/.exec(path);
      if (delMatch && req.method === 'DELETE') {
        const box = await store.getBox(delMatch[1]);
        if (!box) return json(404, { error: 'not_found' });

        const parsed = await readJson(req);
        if (parsed.error) return json(400, { error: parsed.error });
        if (!verifyOwnerToken(parsed.value?.ownerToken ?? '', box.ownerHash)) {
          return json(403, { error: 'bad_token' });
        }

        const messages = await store.listMessages(delMatch[1]);
        const target = messages.find((m) => m.id === delMatch[2]);
        if (!target) return json(404, { error: 'not_found' });

        await store.deleteMessage(target.key);
        return json(200, { ok: true });
      }

      return json(404, { error: 'not_found' });
    } catch (err) {
      console.error('[hush] unhandled', err);
      return json(500, { error: 'internal_error' });
    }
  };
}
