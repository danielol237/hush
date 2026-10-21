# Hush

**One link. Anyone can write to you. You never see who.**

### ▶ [Try it live → jade-kitten-a45079.netlify.app](https://jade-kitten-a45079.netlify.app)

Hush is an anonymous message box. You create a box, get a link, and post it
anywhere. People open it and type something. You read the words in a private
inbox — never a name, a handle, an IP, or a device.

No accounts. No signup. No app.

---

## What it actually does

1. You make a box and choose a name and a question.
2. You get **two** links:
   - a **share link** — `/b/:id` — safe to post publicly
   - a **private inbox link** — `/inbox/:id#t=<token>` — the only key to your messages
3. Anyone with the share link writes. They see no names, and so do you.
4. You open the inbox link to read, delete, or close the box.

The private link is returned **once**, at creation. Only a scrypt hash of it is
stored. Lose it and the inbox is gone — that is the price of having no accounts
and nothing to reset.

---

## Why it looks like this

The whole interface is a **till receipt on thermal paper, sitting on a dark
counter**. That is not decoration — it is the argument. A receipt is something
handed to you, read once, and thrown away, which is exactly what an anonymous
message is. The metaphor does the explaining that copy usually has to.

It also rules out the obvious direction. Every anonymous-message app ships the
same surface: neon gradient, glassy rounded cards, 3D stickers, pill buttons.
That language is now so common that it reads as a template — and a template
asks for less trust, not more, from an app whose entire promise is discretion.

So the constraints here are deliberately tight:

- **Monochrome print.** Till printers have one colour. Everything is
  monospace on cream, with the same dot-matrix grammar a receipt uses —
  dashed rules, a reference number, tiny letter-spaced caps.
- **One colour, and it is the stamp.** Each box derives its own stamp colour
  from its id, so two people's links never look alike in a feed. Nothing else
  on the page is coloured.
- **Physical, not flat.** The slip is rotated a fraction of a degree and casts
  a shadow, because paper on a counter is never perfectly square. The message
  slips in the inbox each sit at a slightly different angle for the same
  reason.
- **Torn edges, not rounded corners.** The top and bottom of every slip are
  torn with a repeating zigzag. Nothing on the page has a border radius.
- **No stock art.** No 3D hands, no stickers, no gradients. The only mark is a
  nine-pixel filled square.

The prompt presets on the create screen exist for a product reason too: a blank
"ask me anything" is a decision, and most people will not make one. Five
concrete questions turn an empty box into a tap.

---

## The anonymity claim, precisely

This is the part most anonymous apps are vague about, so here is the exact
position:

**Not stored, ever, next to a message:**

- IP address
- user agent
- cookies or device fingerprint
- an account id, because there are no accounts
- any stable sender identifier

**Stored with each message:**

- the text
- a timestamp
- whether it tripped the safety filter, and which rule

**What does exist transiently:**

Rate limiting needs a counter per client per minute, or one script can fill an
inbox in seconds. That counter is a salted hash of `ip + box id` — so the same
person on the same box is one bucket, but the same IP across two boxes produces
two unrelated buckets, and the hash cannot be reversed to an address. It expires
with the minute and is never joined to a message.

The honest caveat: **the hosting provider sees request metadata** as it routes
traffic. Hush does not store it and does not correlate it, but no web app can
promise more than that. Anyone who needs stronger guarantees than "the app does
not keep it" needs a network-level anonymity system, not a website.

---

## Why the moderation exists

Sarahah, Yik Yak, and NGL all shipped the same feature and all hit the same
wall: anonymous messages are a harassment vector. The people who built them
mostly found out afterwards.

Hush handles it in the product rather than in a policy page:

**Flagged, not blocked.** Each message is scanned for contact details — emails,
phone numbers, links, handles, street addresses. A hit does not delete the
message and does not warn the sender. It routes the message into a separate
**flagged** section of the inbox, clearly marked, with the rule that fired.

The reasoning: a filter that silently drops messages gets abused for false
positives ("did they answer? did it break?") and a filter that hard-blocks
teaches people to type `zero eight zero three`. Showing the recipient everything,
but separating the risky items, keeps them in control and never blindsides them.

**The owner holds every lever.** Close the box instantly, delete any message,
reopen when you want. No support ticket, no waiting.

**Deliberately narrow patterns.** Broad profanity blacklists flag ordinary
speech and create a false sense of safety. The patterns here target doxxing and
off-platform contact — the things that turn an anonymous message into a real
threat.

---

## Run it

```bash
git clone https://github.com/danielol237/hush.git
cd hush
npm install
npm test          # 46 tests
```

### Deploy to Netlify

```bash
npm i -g netlify-cli
netlify deploy --prod
```

Or drag the folder onto <https://app.netlify.com/drop>.

Netlify Blobs holds the boxes and messages, so the app survives cold starts and
scales across regions without a database.

The live demo has no expiry of its own — it stays up as long as the Netlify
account behind it is active, and redeploying from this repo takes a minute.

---

## API

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `POST` | `/api/boxes` | — | Create a box → `{ id, ownerToken }` |
| `GET` | `/api/boxes/:id` | — | Public box: name, prompt, open |
| `POST` | `/api/boxes/:id/messages` | — | Send `{ text }` |
| `POST` | `/api/boxes/:id/inbox` | owner token | Read all messages |
| `POST` | `/api/boxes/:id/close` | owner token | Toggle open/closed |
| `DELETE` | `/api/boxes/:id/messages/:messageId` | owner token | Delete one message |

The owner token travels in the request body, and in the browser it lives in the
URL fragment (`#t=...`) — the part of a URL browsers never send to a server — so
it stays out of logs and referrer headers.

### Limits

- 500 characters per message
- 500 messages per box
- 6 sends per minute per client per box
- 6 boxes per minute per client

---

## Architecture

```
src/
  core.mjs       store, moderation, validation, token hashing
  api.mjs        HTTP contract as a factory over any blob store
netlify/
  functions/api.mjs   thin wrapper supplying the real Blobs store
public/
  index.html     app shell
  app.js         three views + router
  styles.css     paper-and-ink visual system
test/
  core.test.mjs  store, moderation, validation, tokens, limiter
  api.test.mjs   the full HTTP contract
  fakeBlobs.mjs  in-memory blob store for tests
```

`src/api.mjs` takes a blob store as an argument rather than importing one, so
the entire HTTP contract runs in tests against an in-memory fake. The Netlify
function is four lines. There is no test-only copy of the logic to drift.

---

## License

MIT — see [LICENSE](LICENSE).
