// Hush client.
//
// Three views, three URL shapes:
//   /                     create a box
//   /b/:id                send someone an anonymous message
//   /inbox/:id#t=TOKEN    the owner's inbox (token in the fragment, never sent)
//
// The owner token lives in the URL fragment for the same reason Cinder's key
// does: browsers strip it before the request leaves the machine, so it never
// reaches a server log.

/* ---------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data.error ?? 'request_failed'), { status: response.status, data });
  }
  return data;
}

/* --------------------------------------------------------------------- dom */

/**
 * Every box gets its own accent hue, derived from its id.
 *
 * Deterministic — the same link always looks the same — but different people's
 * links are visually distinct, which is the whole point of posting one in a
 * story feed. Hues are picked from a hand-tuned set rather than spread evenly
 * around the wheel: full-spectrum rotation produces yellows and greens that
 * wash out on near-black.
 */
const SIGNAL_HUES = [74, 96, 148, 172, 194, 214, 258, 286, 320, 340, 8, 26];

function signalFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  const hue = SIGNAL_HUES[hash % SIGNAL_HUES.length];
  return `hsl(${hue} 92% 62%)`;
}

function applySignal(id) {
  const root = document.documentElement;
  if (id) root.style.setProperty('--signal', signalFor(id));
  else root.style.removeProperty('--signal');
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** Render a flag reason as human words. */
function reasonLabel(reason) {
  return {
    email: 'an email address',
    phone: 'a phone number',
    link: 'a link',
    handle: 'a handle',
    address: 'a street address',
  }[reason] ?? reason;
}

const app = document.getElementById('app');

function screen(...nodes) {
  // Drop falsy entries: conditional children are written as `cond ? node : null`
  // and appendChild(null) would render the string "null".
  app.replaceChildren(...nodes.filter(Boolean));
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function notice(message, tone = 'error') {
  return el('p', {
    class: `notice${tone === 'error' ? '' : ` notice--${tone}`}`,
    role: tone === 'error' ? 'alert' : 'status',
    text: message,
  });
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const original = button.textContent;
    button.textContent = 'copied';
    button.classList.add('is-done');
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove('is-done');
    }, 1600);
  } catch {
    button.textContent = 'press ctrl+c';
  }
}

function timeAgo(ts) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function fact(title, body) {
  return el('article', { class: 'fact' }, [el('h2', { text: title }), el('p', { text: body })]);
}

/**
 * The printed header at the top of every slip: the mark, a reference number,
 * and a dashed rule. Real receipts always carry this, and it is what makes the
 * paper read as a receipt rather than a card.
 */
function slipHead(reference) {
  return [
    el('div', { class: 'slip-head' }, [
      el('span', { class: 'slip-mark', text: 'hush' }),
      el('span', { class: 'slip-ref', text: reference }),
    ]),
    el('hr', { class: 'rule' }),
  ];
}

/* ------------------------------------------------------------------ create */

function createView() {
  applySignal(null);
  const name = el('input', {
    id: 'name',
    class: 'field',
    type: 'text',
    maxlength: '40',
    placeholder: 'Your name or handle',
    autocomplete: 'nickname',
  });

  const prompt = el('input', {
    id: 'prompt',
    class: 'field',
    type: 'text',
    maxlength: '120',
    placeholder: 'Send me something you would not say out loud.',
  });

  // Prompt presets. These are the difference between a link nobody clicks and
  // one that gets answered: a blank "ask me anything" is a decision, and most
  // people will not make one.
  const PRESETS = [
    'what do you actually think of me?',
    'one thing you never said to my face',
    'describe me in three words',
    'a secret you are carrying',
    'what should I stop doing?',
  ];

  const chips = el(
    'div',
    { class: 'chips' },
    PRESETS.map((preset) =>
      el('button', {
        class: 'chip',
        type: 'button',
        text: preset,
        onclick: () => {
          prompt.value = preset;
          prompt.focus();
        },
      }),
    ),
  );

  const errorSlot = el('div', { class: 'slot' });
  const submit = el('button', { class: 'btn btn--primary', type: 'submit', text: 'Create my link' });

  const form = el('form', { class: 'card', novalidate: 'true' }, [
    el('span', { class: 'stamp', text: 'unsigned' }),
    ...slipHead('new slip'),
    el('div', { class: 'stack' }, [
      el('label', { class: 'label', for: 'name', text: 'What should people call you?' }),
      name,
    ]),
    el('div', { class: 'stack' }, [
      el('label', { class: 'label', for: 'prompt', text: 'The question on your box' }),
      prompt,
      chips,
    ]),
    errorSlot,
    submit,
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorSlot.replaceChildren();

    if (name.value.trim().length === 0) {
      errorSlot.replaceChildren(notice('You need a name for the link.'));
      name.focus();
      return;
    }

    submit.disabled = true;
    submit.textContent = 'Making it…';

    try {
      const box = await api('/api/boxes', {
        method: 'POST',
        body: { name: name.value, prompt: prompt.value },
      });
      linkView(box);
    } catch (err) {
      errorSlot.replaceChildren(notice(friendlyError(err)));
      submit.disabled = false;
      submit.textContent = 'Create my link';
    }
  });

  screen(
    el('section', { class: 'hero' }, [
      el('h1', { html: 'Ask me anything.<br><em>No names.</em>' }),
      el('p', {
        class: 'lede',
        text: 'Make one link. Anyone can write to you through it. You see what they said, never who said it.',
      }),
    ]),
    form,
    el('section', { class: 'facts' }, [
      fact('One link', 'Post it anywhere. Every message lands in the same private inbox.'),
      fact('No names', 'Senders are never identified — not to you, not in the database.'),
      fact('Yours to close', 'Close the box or delete a message whenever you want.'),
    ]),
  );
}

function friendlyError(err) {
  if (err?.status === 429) return 'Too many boxes from here. Give it a minute.';
  if (err?.data?.error === 'invalid_name') return 'That name is too long or empty.';
  if (err?.data?.error === 'invalid_prompt') return 'That question is too long.';
  return 'Could not create the box. Try again.';
}

/* -------------------------------------------------------------------- link */

function linkView({ id, ownerToken }) {
  applySignal(id);
  const base = `${location.origin}/b/${id}`;
  const inboxUrl = `${location.origin}/inbox/${id}#t=${ownerToken}`;

  const shareInput = el('input', { class: 'field field--mono', readonly: 'readonly', value: base });
  shareInput.addEventListener('focus', () => shareInput.select());

  const copyShare = el('button', { class: 'btn btn--primary btn--small', type: 'button', text: 'Copy' });
  copyShare.addEventListener('click', () => copyText(base, copyShare));

  const inboxInput = el('input', { class: 'field field--mono', readonly: 'readonly', value: inboxUrl });
  inboxInput.addEventListener('focus', () => inboxInput.select());

  const copyInbox = el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Copy' });
  copyInbox.addEventListener('click', () => copyText(inboxUrl, copyInbox));

  screen(
    el('section', { class: 'hero hero--tight' }, [
      el('h1', { html: 'Your box is open.<br><em>Post the link.</em>' }),
    ]),
    el('div', { class: 'card' }, [
      el('label', { class: 'label', text: 'The link you share' }),
      el('div', { class: 'share-box' }, [shareInput, copyShare]),
      el('ul', { class: 'warn-list' }, [
        el('li', { text: 'Put it on your story, in your bio, wherever people already see you.' }),
        el('li', { text: 'Anyone with this link can write to you. Nobody can read your inbox through it.' }),
      ]),

      el('label', { class: 'label', style: 'margin-top:28px', text: 'Your private inbox link' }),
      el('div', { class: 'share-box' }, [inboxInput, copyInbox]),
      el('p', {
        class: 'fineprint',
        text: 'Keep this one to yourself. It is the only key to your messages — there is no account, no password reset, and no way for anyone to recover it. Save it now.',
      }),
      el('div', { class: 'row' }, [
        el('a', {
          class: 'btn btn--ghost btn--small',
          href: `/inbox/${id}#t=${ownerToken}`,
          text: 'Open my inbox',
        }),
      ]),
    ]),
  );
}

/* -------------------------------------------------------------------- send */

async function sendView(id) {
  const errorSlot = el('div', { class: 'slot' });

  try {
    const box = await api(`/api/boxes/${encodeURIComponent(id)}`);
    applySignal(box.id);
    if (!box.open) {
      screen(
        el('section', { class: 'hero hero--tight' }, [
          el('h1', { html: 'This box<br><em>is closed.</em>' }),
        ]),
        el('div', { class: 'card' }, [
          notice(`${box.name} is not taking messages right now.`, 'info'),
        ]),
      );
      return;
    }

    const text = el('textarea', {
      id: 'message',
      class: 'field field--area',
      rows: '5',
      maxlength: '500',
      placeholder: 'Say it. They will never know it was you.',
    });

    const counter = el('span', { class: 'counter', text: '0 / 500' });
    text.addEventListener('input', () => {
      counter.textContent = `${text.value.length} / 500`;
      counter.classList.toggle('is-near', text.value.length > 440);
    });

    const submit = el('button', { class: 'btn btn--primary', type: 'submit', text: 'Send anonymously' });

    const form = el('form', { class: 'card send-card', novalidate: 'true' }, [
      el('span', { class: 'stamp', text: 'no name' }),
      ...slipHead('incoming'),
      el('p', { class: 'recipient', html: `To <strong>${escapeHtml(box.name)}</strong>` }),
      el('p', { class: 'prompt-line', text: box.prompt }),
      text,
      counter,
      errorSlot,
      submit,
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorSlot.replaceChildren();

      if (text.value.trim().length === 0) {
        errorSlot.replaceChildren(notice('Write something first.'));
        text.focus();
        return;
      }

      submit.disabled = true;
      submit.textContent = 'Sending…';

      try {
        await api(`/api/boxes/${encodeURIComponent(id)}/messages`, {
          method: 'POST',
          body: { text: text.value },
        });
        sentView(box);
      } catch (err) {
        submit.disabled = false;
        submit.textContent = 'Send anonymously';
        if (err?.status === 429) errorSlot.replaceChildren(notice('Slow down a moment. Try again in a minute.'));
        else if (err?.status === 403) errorSlot.replaceChildren(notice('This box just closed.'));
        else if (err?.data?.error === 'text_too_long') errorSlot.replaceChildren(notice('That is over 500 characters.'));
        else errorSlot.replaceChildren(notice('It did not send. Try again.'));
      }
    });

    screen(
      el('section', { class: 'hero hero--tight' }, [
        el('h1', { html: 'Say it<br><em>anonymously.</em>' }),
      ]),
      form,
      el('p', {
        class: 'fineprint',
        text: `No name, no account, no trace. ${escapeHtml(box.name)} will read the words and nothing else.`,
      }),
    );
  } catch (err) {
    screen(
      el('section', { class: 'hero hero--tight' }, [
        el('h1', { html: 'Box<br><em>not found.</em>' }),
      ]),
      el('div', { class: 'card' }, [
        notice(
          err?.status === 404
            ? 'That link does not point to a box. Check it with whoever sent it.'
            : 'Could not reach the server. Check your connection.',
        ),
      ]),
    );
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function sentView(box) {
  screen(
    el('div', { class: 'card sent' }, [
      el('div', { class: 'sent-mark' }, [
        el('svg', { viewBox: '0 0 24 24', width: '22', height: '22', 'aria-hidden': 'true' }, []),
      ]),
      el('h2', { text: 'Sent.' }),
      el('p', { text: `It is in ${box.name}'s inbox now. They will not know it came from you.` }),
      el('div', { class: 'row', style: 'justify-content:center' }, [
        el('a', { class: 'btn btn--ghost btn--small', href: '/', text: 'Make my own box' }),
      ]),
    ]),
  );
  // Simple tick drawn as an SVG path so no icon font is needed.
  const svg = app.querySelector('.sent-mark svg');
  if (svg) {
    svg.innerHTML = '<path d="M4 12.5 9 17.5 20 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>';
  }
}

/* ------------------------------------------------------------------- inbox */

async function inboxView(id) {
  const params = new URLSearchParams(location.hash.slice(1));
  const ownerToken = params.get('t');

  if (!ownerToken) {
    screen(
      el('section', { class: 'hero hero--tight' }, [
        el('h1', { html: 'Inbox key<br><em>is missing.</em>' }),
      ]),
      el('div', { class: 'card' }, [
        notice('This inbox link is incomplete. Use the full private link you were given when you made the box — the part after the # matters.'),
        el('div', { class: 'row' }, [
          el('a', { class: 'btn btn--ghost btn--small', href: '/', text: 'Make a new box' }),
        ]),
      ]),
    );
    return;
  }

  await loadInbox(id, ownerToken);
}

async function loadInbox(id, ownerToken) {
  try {
    const data = await api(`/api/boxes/${encodeURIComponent(id)}/inbox`, {
      method: 'POST',
      body: { ownerToken },
    });
    applySignal(data.box.id);
    renderInbox(id, ownerToken, data);
  } catch (err) {
    if (err?.status === 403) {
      screen(
        el('section', { class: 'hero hero--tight' }, [
          el('h1', { html: 'Wrong key.<br><em>No access.</em>' }),
        ]),
        el('div', { class: 'card' }, [
          notice('That key does not open this inbox. Check you copied the whole link.'),
        ]),
      );
    } else if (err?.status === 404) {
      screen(
        el('section', { class: 'hero hero--tight' }, [
          el('h1', { html: 'No such<br><em>inbox.</em>' }),
        ]),
        el('div', { class: 'card' }, [notice('This box does not exist, or it was deleted.')]),
      );
    } else {
      screen(
        el('section', { class: 'hero hero--tight' }, [
          el('h1', { html: 'Could not<br><em>open it.</em>' }),
        ]),
        el('div', { class: 'card' }, [notice('Check your connection and reload.')]),
      );
    }
  }
}

function renderInbox(id, ownerToken, { box, messages }) {
  const visible = messages.filter((m) => !m.flagged);
  const flagged = messages.filter((m) => m.flagged);

  const refresh = el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Refresh' });
  refresh.addEventListener('click', async () => {
    refresh.disabled = true;
    refresh.textContent = 'Refreshing…';
    await loadInbox(id, ownerToken);
  });

  const closeBtn = el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: box.open ? 'Close the box' : 'Reopen the box' });
  closeBtn.addEventListener('click', async () => {
    closeBtn.disabled = true;
    try {
      await api(`/api/boxes/${encodeURIComponent(id)}/close`, {
        method: 'POST',
        body: { ownerToken },
      });
      await loadInbox(id, ownerToken);
    } catch {
      closeBtn.disabled = false;
      closeBtn.textContent = 'Try again';
    }
  });

  const shareInput = el('input', { class: 'field field--mono', readonly: 'readonly', value: `${location.origin}/b/${id}` });
  const copyShare = el('button', { class: 'btn btn--ghost btn--small', type: 'button', text: 'Copy link' });
  copyShare.addEventListener('click', () => copyText(shareInput.value, copyShare));

  const notes = el('div', { class: 'notes' });

  if (messages.length === 0) {
    notes.append(
      el('div', { class: 'empty' }, [
        el('strong', { text: 'Nothing yet.' }),
        el('span', { text: 'Post your link somewhere and check back.' }),
      ]),
    );
  } else {
    for (const message of visible) notes.append(noteCard(id, ownerToken, message, false));
    if (flagged.length > 0) {
      notes.append(
        el('p', { class: 'section-label', text: `Held back — ${flagged.length} message${flagged.length === 1 ? '' : 's'} with contact details` }),
      );
      for (const message of flagged) notes.append(noteCard(id, ownerToken, message, true));
    }
  }

  screen(
    el('div', { class: 'inbox-head' }, [
      el('div', {}, [
        el('h1', { text: `${box.name}'s inbox` }),
        el('p', {
          class: 'meta',
          text: `${messages.length} message${messages.length === 1 ? '' : 's'}${flagged.length > 0 ? ` · ${flagged.length} hidden for review` : ''}`,
        }),
      ]),
      el('span', { class: `badge${box.open ? '' : ' badge--closed'}`, text: box.open ? 'open' : 'closed' }),
    ]),
    el('div', { class: 'toolbar' }, [shareInput, copyShare, refresh, closeBtn]),
    notes,
    el('p', {
      class: 'fineprint',
      text: 'Nobody can see who sent these — including us. The trade is that a cruel message cannot be traced, so use the delete button freely.',
    }),
  );
}

function noteCard(boxId, ownerToken, message, flagged) {
  const del = el('button', { class: 'icon-btn', type: 'button', text: 'Delete' });
  del.addEventListener('click', async () => {
    del.disabled = true;
    del.textContent = 'Deleting…';
    try {
      await api(`/api/boxes/${encodeURIComponent(boxId)}/messages/${encodeURIComponent(message.id)}`, {
        method: 'DELETE',
        body: { ownerToken },
      });
      await loadInbox(boxId, ownerToken);
    } catch {
      del.disabled = false;
      del.textContent = 'Delete';
    }
  });

  return el('article', { class: `note${flagged ? ' note--flagged' : ''}` }, [
    el('p', { class: 'note-text', text: message.text }),
    el('div', { class: 'note-foot' }, [
      el('span', {}, [
        flagged
          ? el('span', {
              class: 'note-flag',
              text: `contains ${message.reasons.map(reasonLabel).join(' and ')} · `,
            })
          : null,
        el('span', { text: timeAgo(message.createdAt) }),
      ]),
      del,
    ]),
  ]);
}

/* ------------------------------------------------------------------ router */

function route() {
  const send = /^\/b\/([A-Za-z0-9_-]{1,64})$/.exec(location.pathname);
  if (send) return sendView(send[1]);

  const inbox = /^\/inbox\/([A-Za-z0-9_-]{1,64})$/.exec(location.pathname);
  if (inbox) return inboxView(inbox[1]);

  return createView();
}

route();
window.addEventListener('hashchange', route);
