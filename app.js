'use strict';
(() => {
  // Settings live in config.js. This file has no keys, topics, or personal names.
  const CFG = window.CHIEF_CONFIG || {};
  const LS_PASS = 'chief.pass', LS_AUTO = 'chief.auto', LS_FEED = 'chief.feedCache';
  const LS_OUT = 'chief.outbox', LS_HEARD = 'chief.lastHeard', LS_SAVER = 'chief.saver';
  const LS_SEEN_IDS = 'chief.seenIds';
  const QS = new URLSearchParams(location.search);
  const showQuick = QS.get('replies') !== '0';   // on in the normal app; ?replies=0 hides them
  // Battery: the live channel (SSE) is the only network activity while healthy. The feed is polled only
  // while that channel is down, with backoff. Everything stops when hidden or idle.
  // After display-off the previous EventSource is often dead. Wake tears it down, catches up once,
  // and polls only until a new stream is open. Idle sleep while the display stays on is unchanged.
  const BACKOFF_MS = [5000, 10000, 20000, 60000];
  const IDLE_MS = +QS.get('idle') || 3 * 60000;     // battery saver: sleep after this long with no taps/messages
  const WAIT_MS = 5 * 60000;                         // stay awake this long after a send, waiting for the reply
  const SSE_OPEN_MS = 15000;                         // hung CONNECTING after a wake: give up and poll
  const RECONNECT_MS = 12000;                        // try a fresh stream again while still visible
  const SEEN_MAX = 500;                              // replay window; the feed itself only keeps ~20
  const STALE_SKEW_MS = 5000;                        // live messages this far behind the feed window are replays
  const MAX_SHOWN = 20;
  const W3F = 'https://api.web3forms.com/submit';
  const SUBJECT_FALLBACK = 'Chief app message';
  const BEGIN = '-----BEGIN CHIEF MESSAGE-----', END = '-----END CHIEF MESSAGE-----';
  const SEND_TIMEOUT_MS = 150000;

  // A value still holding a YOUR_... placeholder is not configured.
  function usable(value) {
    if (value == null) return '';
    const s = String(value).trim();
    if (!s) return '';
    if (/^YOUR_[A-Z0-9_]+$/.test(s)) return '';
    if (s.includes('YOUR_NAME') || s.includes('YOUR_REPO')) return '';
    return s;
  }
  function safeHttp(value, fallback) {
    const s = usable(value) || fallback || '';
    if (!s || /^\s*(javascript|data):/i.test(s)) return fallback || '';
    return s;
  }
  function safeTopic(value) {
    const s = usable(value);
    if (!s || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)) return '';
    return s;
  }
  function safeApi(value) {
    const s = usable(value);
    if (!s) return '';
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:') return '';
      return u.toString();
    } catch { return ''; }
  }

  const assistantName = usable(CFG.assistantName) || 'Chief';
  // ./feed.json lives next to this page. A GitHub Pages project address can be
  // https://name.github.io/repo with or without a trailing slash, or index.html.
  // Resolve against that folder so the demo feed loads either way.
  function pageFolder() {
    const url = new URL(location.href);
    const last = url.pathname.split('/').pop() || '';
    if (!url.pathname.endsWith('/')) {
      if (/\.[a-z0-9]+$/i.test(last)) url.pathname = url.pathname.replace(/[^/]*$/, '');
      else url.pathname += '/';
    }
    url.search = '';
    url.hash = '';
    return url.href;
  }
  function resolveFeedUrl(value) {
    const raw = safeHttp(value, './feed.json') || './feed.json';
    try { return new URL(raw, pageFolder()).href; }
    catch { return raw; }
  }
  const feedUrl = resolveFeedUrl(CFG.feedUrl);
  const apiFeedUrl = safeApi(CFG.apiFeedUrl);
  const formsubmitId = usable(CFG.formsubmitId);
  const RELAY = formsubmitId ? 'https://formsubmit.co/ajax/' + encodeURIComponent(formsubmitId) : '';
  const topicFromQuery = QS.has('topic') ? safeTopic(QS.get('topic')) : null;
  const topic = topicFromQuery !== null ? topicFromQuery : safeTopic(CFG.ntfyTopic);
  const ntfyServer = safeHttp(CFG.ntfyServer, 'https://ntfy.sh').replace(/\/$/, '');
  const BACKUP = topic ? ntfyServer + '/' + topic : '';
  const SUBJECT = assistantName + ' app message';
  let zoneOpt = {};
  if (usable(CFG.timeZone)) {
    try {
      zoneOpt = { timeZone: usable(CFG.timeZone) };
      new Intl.DateTimeFormat('en-US', zoneOpt).format();
    } catch { zoneOpt = {}; }   // unknown zone: use the browser's zone
  }

  const emailConfigured = () => Boolean(usable(CFG.web3formsKey) || RELAY);

  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder(), dec = new TextDecoder();
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };
  const getJSON = (k, d) => { try { return JSON.parse(store.get(k)) ?? d; } catch { return d; } };

  // ---------- key: derive once, keep a non-extractable CryptoKey in IndexedDB ----------
  const idb = {
    open() {
      return new Promise((res, rej) => {
        if (!window.indexedDB) return rej(new Error('no-idb'));
        const r = indexedDB.open('chief', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('k');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
    },
    async op(mode, fn) {
      try {
        const db = await idb.open();
        return await new Promise((res, rej) => {
          const tx = db.transaction('k', mode); const q = fn(tx.objectStore('k'));
          tx.oncomplete = () => { db.close(); res(q && q.result); };
          tx.onerror = tx.onabort = () => { db.close(); rej(tx.error); };
        });
      } catch { return undefined; }
    },
    get: () => idb.op('readonly', (s) => s.get('main')),
    put: (v) => idb.op('readwrite', (s) => s.put(v, 'main')),
    clear: () => idb.op('readwrite', (s) => s.clear()),
  };
  const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bytesToB64 = (b) => { let s = ''; for (const x of new Uint8Array(b)) s += String.fromCharCode(x); return btoa(s); };
  let keyRec = null; // {salt, iter, key}
  async function pbkdf2(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(salt), iterations: iter },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Returns the CryptoKey for this salt/iter, deriving (slow) only when nothing cached matches.
  async function keyFor(salt, iter, pass) {
    if (keyRec && keyRec.salt === salt && keyRec.iter === iter && !pass) return keyRec.key;
    if (!pass) {
      const r = await idb.get();
      if (r && r.salt === salt && r.iter === iter && r.key) { keyRec = r; return r.key; }
      pass = store.get(LS_PASS);
      if (!pass) throw new Error('nokey');
    }
    const key = await pbkdf2(pass, salt, iter);
    return key;
  }
  async function remember(salt, iter, key) {
    keyRec = { salt, iter, key };
    await idb.put(keyRec);
  }
  async function decryptItems(feed, key) {
    const out = [];
    for (const it of feed.items) {
      let pt;
      try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(it.iv) }, key, b64ToBytes(it.ct)); }
      catch { throw new Error('decrypt'); }
      const m = JSON.parse(dec.decode(pt));
      const row = { t: m.t, text: String(m.text ?? ''), role: m.role === 'owner' ? 'owner' : 'chief', id: m.id || null, ct: it.ct };
      // Drafts and approvals carry structured fields. Free-form text stays on the
      // object but is not what the glasses show for those messages.
      if (typeof m.kind === 'string') row.kind = m.kind;
      if (typeof m.draftId === 'string') row.draftId = m.draftId;
      if (typeof m.draftHash === 'string') row.draftHash = m.draftHash;
      if (typeof m.to === 'string') row.to = m.to;
      if (typeof m.subject === 'string') row.subject = m.subject;
      if (typeof m.body === 'string') row.body = m.body;
      // Personal drafts nest To, Subject, and body under draft. Flat fields are the same values.
      if (m.draft && typeof m.draft === 'object') {
        const d = m.draft;
        const nested = {
          id: typeof d.id === 'string' ? d.id : '',
          to: typeof d.to === 'string' ? d.to : '',
          subject: typeof d.subject === 'string' ? d.subject : '',
          body: typeof d.body === 'string' ? d.body : '',
        };
        row.draft = nested;
        if (nested.id) row.draftId = nested.id;
        if (typeof d.to === 'string') row.to = d.to;
        if (typeof d.subject === 'string') row.subject = d.subject;
        if (typeof d.body === 'string') row.body = d.body;
      }
      if ((row.kind === 'draft' || (row.draft && row.draft.id)) && row.draftId) {
        row.kind = 'draft';
        if (typeof row.to !== 'string') row.to = '';
        if (typeof row.subject !== 'string') row.subject = '';
        if (typeof row.body !== 'string') row.body = '';
      }
      out.push(row);
    }
    return out;
  }
  async function encryptMessage(text, key, salt, iter, extra) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const id = bytesToB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, 'x');
    const t = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const payload = { t, text, role: 'owner', id };
    if (extra && extra.kind === 'send_draft') {
      payload.kind = 'send_draft';
      payload.draftId = String(extra.draftId || '');
      payload.draftHash = String(extra.draftHash || '');
    }
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
    const env = { v: 1, salt, iter, iv: bytesToB64(iv), ct: bytesToB64(ct) };
    return { id, t, armored: BEGIN + '\n' + btoa(JSON.stringify(env)) + '\n' + END };
  }
  async function decryptArmored(armored, key) {
    const env = JSON.parse(atob(armored.slice(BEGIN.length, -END.length).trim()));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.ct));
    return JSON.parse(dec.decode(pt));
  }

  // A drafted email is kind "draft" (nested under draft, or the same fields at the top level).
  // The free-form text is not shown. kind draft_email is not this protocol.
  function isDraft(m) {
    if (!m || m.role === 'owner' || m.kind !== 'draft') return false;
    if (typeof m.draftId !== 'string' || m.draftId.length === 0) return false;
    return typeof m.to === 'string' && typeof m.subject === 'string' && typeof m.body === 'string';
  }
  function draftFields(m) {
    return {
      draftId: String(m.draftId),
      to: typeof m.to === 'string' ? m.to : '',
      subject: typeof m.subject === 'string' ? m.subject : '',
      body: typeof m.body === 'string' ? m.body : '',
    };
  }
  // draftHash = first 12 lowercase hex of SHA-256 over the UTF-8 bytes
  //   decimalByteLength(to) + 0x0A + to
  //   decimalByteLength(subject) + 0x0A + subject
  //   decimalByteLength(body) + 0x0A + body
  // Lengths are UTF-8 byte counts, written in decimal ASCII. 0x0A is a newline.
  function draftCanonicalBytes(to, subject, body) {
    const chunks = [to, subject, body].map((value) => {
      const raw = enc.encode(String(value ?? ''));
      const head = enc.encode(String(raw.length) + '\n');
      const buf = new Uint8Array(head.length + raw.length);
      buf.set(head, 0);
      buf.set(raw, head.length);
      return buf;
    });
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  // Cache key for those exact bytes. charCode 0–255 round-trips the preimage.
  function draftCanonical(to, subject, body) {
    let s = '';
    for (const b of draftCanonicalBytes(to, subject, body)) s += String.fromCharCode(b);
    return s;
  }
  function hexOf(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  async function draftHash(to, subject, body) {
    const dig = await crypto.subtle.digest('SHA-256', draftCanonicalBytes(to, subject, body));
    return hexOf(dig).slice(0, 12);
  }
  // The text a receiver reads. The bubble still says Approved.
  function sendDraftText(draftId, hash) {
    return 'SEND_DRAFT ' + draftId + ' ' + hash;
  }
  // Only an owner message of kind send_draft with this draftId and this hash approves.
  // An assistant-role send_draft does not. Chat text, including a bare SEND_DRAFT line, does not.
  function isSendDraft(m, draftId, hash) {
    return !!m && m.role === 'owner' && m.kind === 'send_draft' && m.draftId === draftId && m.draftHash === hash;
  }
  function spoken(m) {
    if (!m) return '';
    if (isDraft(m)) {
      const f = draftFields(m);
      return 'To ' + f.to + '. Subject ' + f.subject + '. ' + f.body;
    }
    if (m.role === 'owner' && m.kind === 'send_draft') return 'Approved.';
    return m.text || '';
  }

  // ---------- replay protection ----------
  // Ids we have already accepted. A second copy (feed duplicate, ntfy replay, rolled-off ct)
  // must not alert, duplicate a bubble, or look like a new approval. The feed file stays the
  // source of truth for what is on screen; this set only rejects extras. Outbox retry is a
  // resend of an entry we already created, not an inbound id, so it is not gated here.
  let seenOrder = getJSON(LS_SEEN_IDS, []);
  if (!Array.isArray(seenOrder)) seenOrder = [];
  seenOrder = seenOrder.filter((x) => typeof x === 'string' && x);
  if (seenOrder.length > SEEN_MAX) seenOrder = seenOrder.slice(-SEEN_MAX);
  const seenIds = new Set(seenOrder);
  function rememberSeen(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of list) {
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      seenOrder.push(id);
      changed = true;
    }
    if (!changed) return;
    if (seenOrder.length > SEEN_MAX) {
      for (const old of seenOrder.splice(0, seenOrder.length - SEEN_MAX)) seenIds.delete(old);
    }
    store.set(LS_SEEN_IDS, JSON.stringify(seenOrder));
  }
  function noteSeen(list) {
    rememberSeen((Array.isArray(list) ? list : []).map((m) => m && m.id));
  }
  // First copy of an id wins. The feed is oldest-first, so a replay appended later is dropped
  // and the original approval / bubble stays. The same ciphertext is also one message,
  // including when an item has no id.
  function dedupeInbound(list) {
    const ids = new Set(), cts = new Set(), out = [];
    for (const m of list) {
      if (m.id && ids.has(m.id)) continue;
      if (m.ct && cts.has(m.ct)) continue;
      if (m.id) ids.add(m.id);
      if (m.ct) cts.add(m.ct);
      out.push(m);
    }
    return out;
  }

  // ---------- formatting ----------
  // No timeZone option means the browser's own zone.
  const fmtShort = new Intl.DateTimeFormat('en-US', { ...zoneOpt, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const fmtLong = new Intl.DateTimeFormat('en-US', { ...zoneOpt, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtClock = new Intl.DateTimeFormat('en-US', { ...zoneOpt, hour: 'numeric', minute: '2-digit' });
  function fmtTime(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return ((Date.now() - d) / 86400000 < 6 ? fmtShort : fmtLong).format(d).replace(',', '');
  }

  // ---------- speech + alerts ----------
  let speechGen = 0;
  const canSpeak = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  function speak(text) {
    if (!text) return;
    if (!canSpeak()) { showError('Read aloud is not available here.'); return; }
    const gen = ++speechGen;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.onerror = () => { if (gen === speechGen) showError('Could not read aloud.'); };
    speechSynthesis.speak(u);
  }
  // AudioContext only exists for the ~0.5 s of a chime, then it's closed (no idle audio hardware).
  function chime() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const now = ctx.currentTime;
      for (const [f, d] of [[880, 0], [1318.5, 0.16]]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, now + d);
        g.gain.exponentialRampToValueAtTime(0.3, now + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, now + d + 0.3);
        o.connect(g).connect(ctx.destination);
        o.start(now + d); o.stop(now + d + 0.32);
      }
      setTimeout(() => ctx.close().catch(() => {}), 700);
    } catch { /* ignore */ }
  }
  let bannerTimer = null;
  function alertNew(text) {
    chime();
    $('banner').hidden = false;
    document.body.classList.add('new');              // one static border change, no animation
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { $('banner').hidden = true; document.body.classList.remove('new'); }, 6000);
    if (!saver) { try { if (navigator.vibrate) navigator.vibrate(60); } catch { /* ignore */ } }
    if (auto) speak(assistantName + ' says: ' + text);
    scrollEnd();
    // A new message puts the highlight back on its reply row, unless the wearer
    // is typing or confirming Forget.
    const typing = document.activeElement && document.activeElement.matches && document.activeElement.matches('input, textarea');
    if (!confirmOpen && !aboutOpen && !typing) focusReplyRow();
  }

  // ---------- state ----------
  let messages = [];                   // feed (oldest first) plus live items not in the feed yet
  let feedMsgs = [];                   // decrypted feed
  let live = [];                       // entries that arrived live but aren't in the fetched feed yet
  let outbox = getJSON(LS_OUT, []);    // [{id,t,armored,state}] wearer messages not yet in the feed
  const outText = new Map();           // id -> plaintext (memory only)
  const outMeta = new Map();           // id -> {kind, draftId, draftHash} for approvals still in the outbox
  const hashCache = new Map();         // canonical draft string -> 12 hex
  let hashJob = null;
  const rendered = new Map();          // bubble key -> message, for the draft Send button
  let aboutOpen = false;
  let feedText = null, feedSalt = null, feedIter = 310000;
  let waitUntil = 0;
  let auto = store.get(LS_AUTO) !== 'off';
  let saver = store.get(LS_SAVER) !== 'off';
  let lastHeard = store.get(LS_HEARD) || '';   // newest assistant message already alerted/seen
  // A live item older than the whole feed window was already dropped by the publisher.
  // New messages are newer than that window, so they stay. The feed file itself is not filtered.
  function liveIsStale(m) {
    const t = Date.parse(m.t);
    if (!Number.isFinite(t) || !feedMsgs.length) return false;
    let oldest = Infinity;
    for (const f of feedMsgs) {
      const n = Date.parse(f.t);
      if (Number.isFinite(n) && n < oldest) oldest = n;
    }
    return oldest !== Infinity && t < oldest - STALE_SKEW_MS;
  }
  function isReplay(m) {
    if (!m) return true;
    if (m.id && (seenIds.has(m.id) || outbox.some((o) => o.id === m.id) || feedMsgs.some((f) => f.id === m.id) || live.some((f) => f.id === m.id))) return true;
    if (m.ct && (feedMsgs.some((f) => f.ct === m.ct) || live.some((f) => f.ct === m.ct))) return true;
    return liveIsStale(m);
  }

  const saveOutbox = () => store.set(LS_OUT, JSON.stringify(outbox.map(({ id, t, armored, state }) => ({ id, t, armored, state }))));
  function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }
  function setStatus(kind, msg) { const s = $('send-status'); s.dataset.kind = kind || ''; s.textContent = msg || ''; }
  const setChecked = (msg) => { $('checked').textContent = msg; };
  function showLock(msg) {
    sleep();
    if (aboutOpen) {
      aboutOpen = false;
      $('about').hidden = true;
      if (history.state && history.state.chief === 'about') history.back();
    }
    $('feed').hidden = true;
    $('feed').inert = false;
    $('lock').hidden = false;
    $('lock-status').textContent = msg || '';
  }
  function openAbout() {
    if (aboutOpen || confirmOpen || $('feed').hidden) return;
    aboutOpen = true;
    $('feed').hidden = true;
    $('feed').inert = true;
    $('about').hidden = false;
    try { history.pushState({ chief: 'about' }, ''); } catch { /* ignore */ }
    $('about-back').focus();
  }
  function closeAbout(fromPop) {
    if (!aboutOpen) return;
    aboutOpen = false;
    $('about').hidden = true;
    $('feed').inert = false;
    // The feed was hidden while About was open. The lock screen is the other
    // full-page view; if it is hidden, this session still belongs on the chat.
    if ($('lock').hidden) $('feed').hidden = false;
    if (!fromPop && history.state && history.state.chief === 'about') history.back();
    if ($('lock').hidden) $('about-btn').focus();
  }
  function showFeed() { $('lock').hidden = true; $('feed').hidden = false; }
  // About hides the feed, but the passphrase session is still open.
  const unlocked = () => $('lock').hidden && (aboutOpen || !$('feed').hidden);
  function renderToggles() {
    const a = $('auto-btn'); a.textContent = 'Auto-read: ' + (auto ? 'On' : 'Off'); a.setAttribute('aria-pressed', String(auto));
    const v = $('saver-btn'); v.textContent = 'Saver: ' + (saver ? 'On' : 'Off'); v.setAttribute('aria-pressed', String(saver));
  }
  // Newest assistant message by timestamp. The feed is oldest-first, so the
  // first Chief message is not the latest. A tied timestamp keeps the later one.
  function latestChief() {
    let best = null, bestT = -Infinity, bestI = -1;
    messages.forEach((m, i) => {
      if (m.role !== 'chief') return;
      const t = Date.parse(m.t) || 0;
      if (!best || t > bestT || (t === bestT && i > bestI)) { best = m; bestT = t; bestI = i; }
    });
    return best;
  }
  const scrollEnd = () => { const sc = $('scroll'); sc.scrollTop = sc.scrollHeight; };
  function applyLabels() {
    $('banner').textContent = 'New reply from ' + assistantName;
    $('msg').placeholder = 'Message ' + assistantName;
    $('msg').setAttribute('aria-label', 'Message to ' + assistantName);
  }

  // ---------- render: keyed diff, only changed bubbles touch the DOM ----------
  const MARK = { sending: ' · sending…', sent: ' · sent ✓', failed: ' · not sent, tap to retry' };
  const nodes = new Map();   // key -> {li, sig}
  function draftApproved(draftId, hash) {
    if (!hash) return false;
    if (messages.some((m) => isSendDraft(m, draftId, hash))) return true;
    for (const o of outbox) {
      if (o.state === 'failed') continue;
      if (isSendDraft(outMeta.get(o.id), draftId, hash)) return true;
    }
    return false;
  }
  function scheduleHashes(list) {
    const missing = [];
    for (const m of list) {
      if (!isDraft(m)) continue;
      const f = draftFields(m);
      const c = draftCanonical(f.to, f.subject, f.body);
      if (!hashCache.has(c) && !missing.includes(c)) missing.push(c);
    }
    if (!missing.length) return;
    const run = async () => {
      for (const c of missing) {
        if (hashCache.has(c)) continue;
        const raw = new Uint8Array(c.length);
        for (let i = 0; i < c.length; i++) raw[i] = c.charCodeAt(i);
        const dig = await crypto.subtle.digest('SHA-256', raw);
        hashCache.set(c, hexOf(dig).slice(0, 12));
      }
    };
    hashJob = Promise.resolve(hashJob).then(run).then(() => { if (unlocked()) render(); });
  }
  function render() {
    const ids = new Set(messages.map((m) => m.id).filter(Boolean));
    const owned = new Set(messages.filter((m) => m.role === 'owner').map((m) => m.text.trim()));
    const before = outbox.length;
    outbox = outbox.filter((o) => {
      if (ids.has(o.id)) { outMeta.delete(o.id); return false; }
      const meta = outMeta.get(o.id);
      // A chat bubble is replaced when the same words show up in the feed.
      // A draft approval is replaced only by the same draftId and draftHash,
      // so a second draft that also says Approved does not clear this one.
      if (meta && meta.kind === 'send_draft') return !messages.some((m) => isSendDraft(m, meta.draftId, meta.draftHash));
      return !(outText.has(o.id) && owned.has(outText.get(o.id).trim()));
    });
    if (outbox.length !== before) saveOutbox();
    const pend = outbox.filter((o) => outText.has(o.id)).map((o) => ({
      t: o.t, text: outText.get(o.id), role: 'owner', id: o.id, state: o.state, ...(outMeta.get(o.id) || {}),
    }));
    const time = (m) => Date.parse(m.t) || 0;
    const list = [...pend, ...messages].map((m, i) => [m, i])
      // Newest time first. A tied time keeps feed order: the later entry is newer.
      .sort((a, b) => (time(b[0]) - time(a[0])) || (b[1] - a[1]))
      .slice(0, MAX_SHOWN).map(([m]) => m).reverse();
    const sc = $('scroll'), ol = $('convo');
    const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
    const keep = new Set();
    rendered.clear();
    let added = false, prev = null;
    for (const m of list) {
      const key = m.id ? 'i:' + m.id : 'c:' + m.ct;
      keep.add(key);
      rendered.set(key, m);
      const draft = isDraft(m);
      const fields = draft ? draftFields(m) : null;
      const canon = fields ? draftCanonical(fields.to, fields.subject, fields.body) : '';
      const hash = canon ? (hashCache.get(canon) || '') : '';
      const showSend = !!(fields && hash && !draftApproved(fields.draftId, hash));
      const approval = m.role === 'owner' && m.kind === 'send_draft';
      const label = approval ? '' : (m.role === 'owner' ? 'You · ' : assistantName + ' · ') + fmtTime(m.t) + (m.state ? MARK[m.state] : '');
      const shown = approval
        ? ('Approved ✓' + (m.draftId ? '\n' + m.draftId : '') + (m.state === 'failed' ? MARK.failed : ''))
        : (draft ? fields.to + '\n' + fields.subject + '\n' + fields.body : m.text);
      const sig = m.role + '|' + (m.state || '') + '|' + (m.kind || '') + '|' + label + '|' + shown + '|' + (showSend ? '1' : '0');
      let n = nodes.get(key);
      if (!n) {
        const li = document.createElement('li');
        li.append(document.createElement('time'), document.createElement('div'));
        li.firstChild.className = 'time'; li.lastChild.className = 'text';
        n = { li, sig: '' }; nodes.set(key, n); added = true;
      }
      if (n.sig !== sig) {
        n.li.className = 'msg ' + m.role + (draft ? ' draft' : '') + (approval ? ' approved' : '') + (m.state ? ' pending ' + m.state : '');
        if (m.state) n.li.dataset.id = m.id; else delete n.li.dataset.id;
        n.li.dataset.key = key;
        const timeEl = n.li.firstChild;
        timeEl.hidden = approval;
        timeEl.textContent = label;
        const textEl = n.li.querySelector('.text');
        textEl.replaceChildren();
        if (draft) {
          for (const [name, value] of [['To', fields.to], ['Subject', fields.subject]]) {
            const line = document.createElement('div');
            const k = document.createElement('span');
            k.className = 'draft-k';
            k.textContent = name + ': ';
            line.append(k, document.createTextNode(value));
            textEl.append(line);
          }
          const body = document.createElement('div');
          body.className = 'draft-body';
          body.textContent = fields.body;
          textEl.append(body);
        } else {
          textEl.textContent = approval ? shown : m.text;
        }
        let btn = n.li.querySelector('.draft-send');
        if (showSend) {
          if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'send draft-send focusable';
            btn.textContent = 'Send';
            n.li.append(btn);
          }
          btn.hidden = false;
          btn.setAttribute('aria-label', 'Send draft' + (fields.to ? ' to ' + fields.to : ''));
        } else if (btn) {
          // Land on the transcript, not Yes. A second press on Yes would send a plain "Yes".
          // Focus moves before the button is removed so the browser does not shift focus
          // onto the quick-reply row as the button disappears.
          if (document.activeElement === btn) $('scroll').focus();
          btn.remove();
        }
        n.sig = sig;
      }
      // A bubble can take the highlight (a new message does). Select on it
      // jumps to the reply buttons, which live outside this scroller.
      // A draft's own Send is the button under that bubble.
      n.li.tabIndex = 0;
      n.li.classList.add('focusable');
      if (draft) {
        n.li.setAttribute('role', 'article');
        n.li.setAttribute('aria-label', 'Draft email' + (fields && fields.to ? ' to ' + fields.to : ''));
      } else if (approval) {
        n.li.setAttribute('role', 'article');
        n.li.setAttribute('aria-label', m.state === 'failed' ? 'Retry sending approval' : 'Approved ' + (m.draftId || ''));
      } else {
        n.li.setAttribute('role', 'button');
        n.li.setAttribute('aria-label', m.state === 'failed' ? 'Retry sending' : 'Show quick replies');
      }
      const want = prev ? prev.nextSibling : ol.firstChild;
      if (want !== n.li) ol.insertBefore(n.li, want);
      prev = n.li;
    }
    for (const [key, n] of nodes) if (!keep.has(key)) { n.li.remove(); nodes.delete(key); }
    const newest = latestChief();
    const latestKey = newest ? (newest.id ? 'i:' + newest.id : 'c:' + newest.ct) : null;
    for (const [key, n] of nodes) n.li.classList.toggle('latest', key === latestKey);
    placeQuick();
    $('empty').hidden = list.length > 0;
    $('read-btn').disabled = !latestChief();
    scheduleHashes(list);
    if (atBottom || added) scrollEnd();
  }
  // Reply buttons are real buttons in the page, between the transcript and the
  // message box. They stay the same elements for the life of the page (hidden,
  // never removed) so native focus order does not lose them. ?replies=0 hides them.
  function placeQuick() {
    const row = $('quick-replies');
    if (!row) return;
    // The row stays up if any assistant message exists, even when that
    // message has scrolled out of the last 20 shown.
    const show = showQuick && messages.some((m) => m.role === 'chief');
    row.hidden = !show;
  }
  // Highlight the first quick reply and scroll it into view. Returns false when
  // replies are hidden or not on screen yet.
  function focusReplyRow() {
    const row = $('quick-replies');
    if (!row || row.hidden) return false;
    const el = row.querySelector('button:not([disabled])');
    if (!el) return false;
    el.focus();
    return document.activeElement === el;
  }

  // Apply a feed (raw JSON text). Decrypts only when the text changed.
  // feedEpoch drops a slow decrypt that lost the race with a newer fetch or with sleep.
  let feedEpoch = 0;
  async function applyFeed(text, { pass = null, alert = true } = {}) {
    if (text === feedText && !pass) return true;
    const epoch = ++feedEpoch;
    let feed;
    try { feed = JSON.parse(text); } catch { throw new Error('bad-feed'); }
    if (!feed || feed.v !== 1 || !Array.isArray(feed.items)) throw new Error('bad-feed');
    let list = [];
    if (feed.items.length) {
      const iter = feed.iter || 310000;
      const key = await keyFor(feed.salt, iter, pass);
      if (epoch !== feedEpoch) return false;
      list = dedupeInbound(await decryptItems(feed, key));
      if (epoch !== feedEpoch) return false;
      if (!keyRec || keyRec.key !== key) remember(feed.salt, iter, key);
      feedSalt = feed.salt; feedIter = iter;
      for (const o of outbox) if (!outText.has(o.id)) {
        try {
          const parsed = await decryptArmored(o.armored, key);
          outText.set(o.id, String(parsed.text ?? ''));
          if (parsed.kind === 'send_draft' && parsed.role === 'owner') outMeta.set(o.id, { role: 'owner', kind: 'send_draft', draftId: String(parsed.draftId || ''), draftHash: String(parsed.draftHash || '') });
        } catch { /* drop later */ }
      }
    }
    if (epoch !== feedEpoch) return false;
    feedText = text;
    store.set(LS_FEED, text);
    feedMsgs = list;
    rememberSeen(feedMsgs.map((m) => m.id));
    merge(alert);
    return true;
  }

  // Combine feed + live extras, render, and alert on a new assistant message.
  function merge(alert = true) {
    const inFeedCt = new Set(feedMsgs.map((m) => m.ct));
    const inFeedId = new Set(feedMsgs.map((m) => m.id).filter(Boolean));
    live = live.filter((m) => !inFeedCt.has(m.ct) && !(m.id && inFeedId.has(m.id)));
    messages = [...live, ...feedMsgs];
    render();
    const nc = latestChief();
    if (nc && (!lastHeard || new Date(nc.t) > new Date(lastHeard))) {
      if (alert && lastHeard) { alertNew(spoken(nc)); activity(); }
      lastHeard = nc.t; store.set(LS_HEARD, lastHeard);
      if (waitUntil) { waitUntil = 0; setStatus('ok', assistantName + ' replied ✓'); }
    }
  }

  async function fetchText(url, opts) {
    const r = await fetch(url, { cache: 'no-cache', ...opts });   // revalidates with ETag; 304s are cheap
    if (!r.ok) throw new Error('http-' + r.status);
    return r.text();
  }
  function clearNetError() {
    const e = $('error');
    if (!e || e.hidden) return;
    const t = e.textContent || '';
    if (t.startsWith('Offline') || t.startsWith('Could not load')) showError('');
  }
  // One catch-up. Right after a send, an optional API copy can be fresher than the site.
  // A newer refresh aborts the previous fetch so a hung request from before display-off
  // cannot keep the next catch-up from running.
  let refreshGen = 0, refreshCtl = null;
  function cancelRefresh() {
    refreshGen++;
    feedEpoch++;
    if (refreshCtl) { refreshCtl.abort(); refreshCtl = null; }
  }
  async function refresh() {
    if (!unlocked()) return false;
    const gen = ++refreshGen;
    if (refreshCtl) refreshCtl.abort();
    const ctl = new AbortController();
    refreshCtl = ctl;
    const timer = setTimeout(() => ctl.abort(), 20000);
    const stopped = () => gen !== refreshGen;
    try {
      let text = null;
      if (apiFeedUrl && Date.now() < waitUntil) {
        try { text = await fetchText(apiFeedUrl, { headers: { Accept: 'application/vnd.github.raw+json' }, signal: ctl.signal }); }
        catch (e) { if (e.name === 'AbortError' || stopped()) return false; /* fall back */ }
      }
      if (stopped()) return false;
      try { if (text === null) text = await fetchText(feedUrl, { signal: ctl.signal }); }
      catch (e) {
        if (e.name === 'AbortError' || stopped()) return false;
        setChecked('Offline · ' + fmtClock.format(new Date()));
        if (!feedText) showError(navigator.onLine === false ? 'Offline. Check your phone connection.' : 'Could not load messages. Try Refresh.');
        if (!sseLive && !asleep && !document.hidden) startPolling();
        return false;
      }
      if (stopped()) return false;
      try {
        const applied = await applyFeed(text);
        if (stopped() || applied === false) return false;
        showError('');
      }
      catch (e) {
        if (e.name === 'AbortError' || stopped()) return false;
        if (e.message === 'nokey') { showLock(); return false; }
        showError(e.message === 'decrypt' ? 'Could not decrypt. The key changed? Use Forget passphrase.' : 'Message feed is damaged. Try Refresh.');
      }
      if (!sseLive && !stopped()) setChecked('Checked ' + fmtClock.format(new Date()));
      return true;
    } finally {
      clearTimeout(timer);
      if (refreshCtl === ctl) refreshCtl = null;
    }
  }

  // ---------- connection manager: live channel first, backoff polling only while it's down ----------
  let es = null, sseLive = false, asleep = true;
  let pollTimer = null, pollStep = 0, idleTimer = null;
  let sseWatch = null, reconnectTimer = null, freshTimer = null, esGen = 0;
  // Date.now() jumps across a freeze; performance.now() does not. The gap means the
  // display slept even when no visibility event was delivered. Idle time with the
  // page actually running does not move this, so battery-saver sleep stays as it was.
  let clockSkew = Date.now() - performance.now();
  function noteClock() { clockSkew = Date.now() - performance.now(); }
  function wasSuspended() {
    const skew = Date.now() - performance.now();
    const jumped = skew - clockSkew > 4000;
    clockSkew = skew;
    return jumped;
  }
  function startPolling(reset) {
    if (reset) pollStep = 0;
    if (pollTimer || sseLive || asleep || document.hidden) return;
    const ms = BACKOFF_MS[Math.min(pollStep, BACKOFF_MS.length - 1)];
    pollTimer = setTimeout(async () => { pollTimer = null; pollStep++; await refresh(); startPolling(); }, ms);
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function closeLive() {
    esGen++;
    clearTimeout(sseWatch); sseWatch = null;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    const sock = es;
    es = null;
    sseLive = false;
    if (sock) {
      sock.onopen = sock.onmessage = sock.onerror = null;
      try { sock.close(); } catch { /* ignore */ }
    }
    stopPolling();
  }
  function armSseWatch(gen) {
    clearTimeout(sseWatch); sseWatch = null;
    if (!window.EventSource || !BACKUP) return;
    sseWatch = setTimeout(() => {
      sseWatch = null;
      if (gen !== esGen || asleep || document.hidden || sseLive) return;
      // Still not open. The browser retry often never fires after a long freeze.
      closeLive();
      startPolling(true);
      refresh();
      scheduleReconnect();
    }, SSE_OPEN_MS);
  }
  function scheduleReconnect() {
    if (reconnectTimer || asleep || document.hidden || sseLive || !BACKUP || !window.EventSource) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (asleep || document.hidden || sseLive || !unlocked()) return;
      connectLive(true);
    }, RECONNECT_MS);
  }
  function connectLive(force = false) {
    // A CLOSED socket will not retry. OPEN/CONNECTING after a freeze can be a zombie,
    // so a wake from sleep passes force and always builds a new one.
    // No ntfy topic (the public demo, until config.js line 19 is set): poll the feed.
    if (!force && es && es.readyState !== 2) return;
    closeLive();
    if (!BACKUP || !window.EventSource) { startPolling(); return; }
    const gen = esGen;
    let sock;
    try { sock = new EventSource(BACKUP + '/sse'); } catch { startPolling(); return; }
    es = sock;
    armSseWatch(gen);
    sock.onopen = () => {
      if (gen !== esGen || es !== sock) return;
      sseLive = true;
      pollStep = 0;
      stopPolling();
      clearTimeout(sseWatch); sseWatch = null;
      clearTimeout(reconnectTimer); reconnectTimer = null;
      setChecked('Live ' + fmtClock.format(new Date()));
      clearNetError();
      refresh();
    };
    sock.onmessage = (ev) => { if (gen === esGen && es === sock) onLive(ev); };
    sock.onerror = () => {
      if (gen !== esGen || es !== sock) return;
      sseLive = false;
      const closed = sock.readyState === 2;
      if (!asleep && !document.hidden) setChecked('Reconnecting…');
      if (closed) closeLive();
      if (asleep || document.hidden) return;
      startPolling();
      if (closed) scheduleReconnect();
    };
  }
  // Full reconnect after hide, freeze, or a dead socket. Catch up immediately; do not
  // wait for onopen, which may never fire. Idle sleep itself is still activity()'s job.
  function wakeFresh() {
    if (!unlocked() || document.hidden) return false;
    if (freshTimer) { clearTimeout(freshTimer); freshTimer = null; }
    noteClock();
    asleep = false;
    clearNetError();
    setChecked('Reconnecting…');
    connectLive(true);
    refresh();
    activity();
    return true;
  }
  function scheduleWakeFresh() {
    if (document.hidden || !unlocked()) return;
    if (freshTimer) return;
    freshTimer = setTimeout(() => { freshTimer = null; wakeFresh(); }, 0);
  }
  // Wake up (tap, focus, visible, send): connect, and if we were asleep or frozen, catch up.
  function wake() {
    if (!unlocked() || document.hidden) return false;
    const suspended = wasSuspended();
    if (asleep || suspended) return wakeFresh();
    connectLive();
    activity();
    return true;
  }
  function activity() {
    clearTimeout(idleTimer); idleTimer = null;
    if (!saver || asleep) return;
    const ms = Math.max(IDLE_MS, waitUntil - Date.now());
    idleTimer = setTimeout(() => { idleTimer = null; sleep('Paused to save battery · tap to update'); }, ms);
  }
  // Stop everything: no connection, no timers. Does not change how long idle waits.
  function sleep(msg) {
    asleep = true;
    if (freshTimer) { clearTimeout(freshTimer); freshTimer = null; }
    closeLive();
    cancelRefresh();
    clearTimeout(idleTimer); idleTimer = null;
    if (msg) setChecked(msg);
  }

  async function onLive(ev) {
    let d;
    try { d = JSON.parse(JSON.parse(ev.data).message); } catch { return; }   // wearer backup copies etc. are not JSON
    if (!d || d.v !== 1) return;
    if (d.k === 'chief-ping') { refresh(); return; }
    if (d.k !== 'chief-feed' || !d.item || !d.item.ct) return;
    if (d.salt !== feedSalt || (d.iter || 310000) !== feedIter || !keyRec) { refresh(); return; }
    if (feedMsgs.some((m) => m.ct === d.item.ct) || live.some((m) => m.ct === d.item.ct)) return;
    let m;
    try { [m] = await decryptItems({ items: [d.item] }, keyRec.key); } catch { return; }   // not ours: ignore
    if (asleep || document.hidden) return;   // wake's catch-up refresh will apply the feed copy
    if (isReplay(m)) return;                  // duplicate id, known ct, or behind the feed window
    if (m.id) rememberSeen(m.id);
    live.unshift(m);
    live.sort((a, b) => (Date.parse(b.t) || 0) - (Date.parse(a.t) || 0));
    merge(true);
    setChecked('Live ' + fmtClock.format(new Date()));
  }

  // ---------- sending: optimistic, network in the background ----------
  // POST a form body as a simple CORS request (no preflight); true if the relay says success.
  async function postForm(url, fields, referrerPolicy, timeoutMs = SEND_TIMEOUT_MS) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams(fields), headers: { Accept: 'application/json' },
        keepalive: true, referrerPolicy, signal: ctl.signal });
      const d = await r.json().catch(() => null);
      return r.ok && d && (d.success === true || d.success === 'true');
    } catch { return false; } finally { clearTimeout(to); }
  }
  // Web3Forms first; FormSubmit only if Web3Forms is missing or fails. Placeholders are never sent.
  async function relayOnce(o) {
    const key = usable(CFG.web3formsKey);
    if (key) {
      if (await postForm(W3F, { access_key: key, subject: SUBJECT || SUBJECT_FALLBACK, from_name: assistantName + ' app', message: o.armored }, 'strict-origin-when-cross-origin', 20000)) return true;
    }
    if (!RELAY) return false;
    return postForm(RELAY, { _subject: SUBJECT, _template: 'basic', _captcha: 'false', message: o.armored }, 'no-referrer-when-downgrade');
  }
  function backupCopy(o) {
    if (!BACKUP) return;
    try { fetch(BACKUP, { method: 'POST', body: o.armored, keepalive: true }).catch(() => {}); } catch { /* ignore */ }
  }
  async function deliver(o) {
    o.state = 'sending'; saveOutbox(); render();
    let ok = false;
    if (emailConfigured()) {
      ok = await relayOnce(o);
      if (!ok && outbox.includes(o)) { await new Promise((r) => setTimeout(r, 4000)); ok = await relayOnce(o); }
    } else if (BACKUP) {
      try {
        const r = await fetch(BACKUP, { method: 'POST', body: o.armored, keepalive: true });
        ok = r.ok;
      } catch { ok = false; }
    }
    if (!outbox.includes(o)) return;                 // already showed up in the feed
    o.state = ok ? 'sent' : 'failed'; saveOutbox(); render();
    if (!ok) setStatus('err', 'Not sent. Tap the red message to retry.');
    else if (waitUntil) setStatus('ok', 'Sent ✓ Waiting for ' + assistantName + '…');
  }
  function startWaiting() { waitUntil = Date.now() + WAIT_MS; wake(); startPolling(true); }
  // Chat Send and a draft's Send share delivery. extra is set only for kind send_draft.
  async function queueOwner(text, extra) {
    if (!emailConfigured() && !BACKUP) {
      setStatus('err', 'Sending is not set up. For email, set config.js line 9 (web3formsKey) or line 14 (formsubmitId). For ntfy, set line 19 (ntfyTopic).');
      return false;
    }
    if (!keyRec || !feedSalt) { setStatus('err', 'Not ready yet. Tap Refresh, then try again.'); return false; }
    const m = await encryptMessage(text, keyRec.key, feedSalt, feedIter, extra);
    rememberSeen(m.id);   // the live echo of this send is not a second message
    const o = { ...m, state: 'sending' };
    outText.set(o.id, text);
    if (extra && extra.kind === 'send_draft') outMeta.set(o.id, { role: 'owner', kind: 'send_draft', draftId: String(extra.draftId || ''), draftHash: String(extra.draftHash || '') });
    outbox.push(o); saveOutbox();
    render(); scrollEnd();
    setStatus('busy', 'Sending in the background…');
    startWaiting();
    if (emailConfigured()) backupCopy(o);
    deliver(o);
    return true;
  }
  async function send(preset) {
    const input = $('msg');
    const fromField = typeof preset !== 'string';
    const text = (fromField ? input.value : preset).trim();
    if (!text) { setStatus('err', 'Type or speak a message first.'); input.focus(); return; }
    const queued = await queueOwner(text);
    if (queued && fromField) input.value = '';
  }
  // The green Send under one draft. Plain chat, Yes, and the words SEND_DRAFT do not come through here.
  const sendingDraft = new Set();
  async function sendDraft(m) {
    if (!isDraft(m)) return;
    const f = draftFields(m);
    const canon = draftCanonical(f.to, f.subject, f.body);
    if (sendingDraft.has(canon)) return;
    const focused = document.activeElement;
    if (focused && focused.classList && focused.classList.contains('draft-send')) $('scroll').focus();
    sendingDraft.add(canon);
    try {
      const hash = hashCache.get(canon) || await draftHash(f.to, f.subject, f.body);
      hashCache.set(canon, hash);
      if (draftApproved(f.draftId, hash)) return;
      await queueOwner(sendDraftText(f.draftId, hash), { kind: 'send_draft', draftId: f.draftId, draftHash: hash });
    } finally { sendingDraft.delete(canon); }
  }

  // ---------- unlock / start ----------
  async function unlock(pass) {
    let text;
    try { text = await fetchText(feedUrl); } catch { $('lock-status').textContent = 'Could not load messages. Check your connection.'; return false; }
    try {
      const feed = JSON.parse(text);
      if (!feed.items || !feed.items.length) { $('lock-status').textContent = 'No messages yet. Try again later.'; return false; }
      feedText = null;
      await applyFeed(text, { pass, alert: false });
    } catch (e) {
      $('lock-status').textContent = e.message === 'decrypt' ? 'Could not decrypt. Wrong passphrase?' : 'Message feed is damaged. Try again.';
      return false;
    }
    store.set(LS_PASS, pass);
    showFeed(); scrollEnd();
    setChecked('Checked ' + fmtClock.format(new Date()));
    wake();
    return true;
  }

  async function start() {
    applyLabels();
    renderToggles();
    const cached = store.get(LS_FEED);
    const hasPass = Boolean(store.get(LS_PASS));
    if (!hasPass && !(await idb.get())) { showLock(); return; }
    showFeed();
    setChecked('Updating…');
    if (cached) {   // instant: last feed from this device, decrypted with the stored key
      try { await applyFeed(cached, { alert: false }); scrollEnd(); } catch (e) { if (e.message === 'nokey') { showLock(); return; } }
    }
    const cutoff = Date.now() - 2 * 86400000;
    outbox = outbox.filter((o) => (Date.parse(o.t) || 0) > cutoff);
    for (const o of outbox) if (o.state === 'sending') o.state = 'failed';   // app was closed mid-send
    saveOutbox();
    render();
    // Cache is on screen before the catch-up fetch, so a late decrypt cannot cover a newer feed.
    // A hidden start stays quiet; visibility/resume reconnects when the display is back.
    if (!document.hidden && !wake()) refresh();
    if (unlocked()) focusPrimary();
  }
  // Put the highlight on the first quick reply so a swipe can reach it.
  // The message field is the next stop down.
  function focusPrimary() {
    if ($('feed').hidden) return;
    if (focusReplyRow()) return;
    const el = $('msg');
    if (!el) return;
    el.focus();
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
  }

  // ---------- events ----------
  $('pass-toggle').addEventListener('click', () => {
    const input = $('pass');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    input.classList.toggle('secret', !show);
    const btn = $('pass-toggle');
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-pressed', String(show));
    btn.setAttribute('aria-label', show ? 'Hide passphrase' : 'Show passphrase');
  });
  $('unlock-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = $('pass').value.trim();
    if (!v) { $('lock-status').textContent = 'Enter your passphrase.'; return; }
    $('lock-status').textContent = 'Unlocking…';
    if (await unlock(v)) { $('pass').value = ''; focusPrimary(); }
  });
  $('compose').addEventListener('submit', (ev) => { ev.preventDefault(); send(); });
  $('quick-replies').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (b && b.dataset.text) send(b.dataset.text);
  });
  $('convo').addEventListener('click', (ev) => {
    if (ev.target.closest('#quick-replies')) return;
    const draftBtn = ev.target.closest('.draft-send');
    if (draftBtn) {
      const li = draftBtn.closest('li');
      const m = li && rendered.get(li.dataset.key);
      if (m) sendDraft(m);
      return;
    }
    const failed = ev.target.closest('li.failed');
    if (failed) {
      const o = outbox.find((x) => x.id === failed.dataset.id);
      if (o) { setStatus('busy', 'Retrying in the background…'); startWaiting(); deliver(o); }
      return;
    }
    // Select on a transcript bubble brings its reply row back, even after the
    // highlight has moved on to Forget or another message.
    if (ev.target.closest('li.msg')) focusReplyRow();
  });
  $('read-btn').addEventListener('click', () => { const m = latestChief(); if (m) speak(spoken(m)); });
  $('refresh-btn').addEventListener('click', () => { setChecked('Checking…'); refresh(); });
  $('auto-btn').addEventListener('click', () => {
    auto = !auto; store.set(LS_AUTO, auto ? 'on' : 'off'); renderToggles();
    if (!auto && canSpeak()) speechSynthesis.cancel();
  });
  $('saver-btn').addEventListener('click', () => { saver = !saver; store.set(LS_SAVER, saver ? 'on' : 'off'); renderToggles(); activity(); });
  $('about-btn').addEventListener('click', openAbout);
  $('about-back').addEventListener('click', () => closeAbout(false));
  $('banner').addEventListener('click', () => { $('banner').hidden = true; document.body.classList.remove('new'); const m = latestChief(); if (m) speak(spoken(m)); });
  // Forget is two steps. The first tap only opens this prompt; Cancel is the focused choice.
  let confirmOpen = false;
  function setCovered(on) {
    confirmOpen = on;
    $('confirm').hidden = !on;
    $('feed').inert = on;
    $('lock').inert = on;
  }
  function askForget() {
    if (confirmOpen) return;
    setCovered(true);
    try { history.pushState({ chief: 'confirm-forget' }, ''); } catch { /* ignore */ }
    $('confirm-cancel').focus();
  }
  function cancelForget(fromPop) {
    if (!confirmOpen) return;
    setCovered(false);
    if (!fromPop && history.state && history.state.chief === 'confirm-forget') history.back();
    if (unlocked()) $('forget-btn').focus();
  }
  function commitForget() {
    if (!confirmOpen) return;   // a single tap on the feed's Forget button never reaches here
    const drop = !!(history.state && history.state.chief === 'confirm-forget');
    setCovered(false);
    if (drop) history.back();
    for (const k of [LS_PASS, LS_FEED, LS_OUT, LS_HEARD]) store.del(k);
    // Seen ids stay, so an old copied message still will not pop up.
    idb.clear();
    sleep();
    keyRec = null; messages = []; feedMsgs = []; live = []; outbox = []; outText.clear(); outMeta.clear(); hashCache.clear(); feedText = null; feedSalt = null; waitUntil = 0; lastHeard = '';
    if (canSpeak()) speechSynthesis.cancel();
    render(); setStatus('', '');
    showLock('Passphrase forgotten.');
    $('pass').focus();
  }
  $('forget-btn').addEventListener('click', askForget);
  $('confirm-cancel').addEventListener('click', () => cancelForget(false));
  $('confirm-forget').addEventListener('click', commitForget);
  // Meta Ray-Ban Display delivers touchpad and Neural Band input as keydown:
  // ArrowUp, ArrowDown, ArrowLeft, ArrowRight, and Enter. Chromium moves focus
  // by on-screen position. Enter activates the focused control, which fires click
  // on a real button. This page does not take over those arrow keys, except Up
  // and Down on the transcript, and the draft Send path below. A draft's Send
  // sits inside the scroller, so spatial navigation never lands on it.
  // Down at the bottom of the transcript focuses that Send, then Yes.
  // Up from Yes focuses that Send, then the transcript.
  // Left and Right inside the passphrase or message field move the text cursor.
  // At either end of the text, spatial navigation would otherwise leave the field.
  function visibleDraftSend() {
    const buttons = document.querySelectorAll('#convo .draft-send');
    for (let i = buttons.length - 1; i >= 0; i--) {
      if (!buttons[i].hidden) return buttons[i];
    }
    return null;
  }
  function firstReply() {
    const row = $('quick-replies');
    if (!row || row.hidden) return null;
    return row.querySelector('button');
  }
  function nudgeCaret(el, dir, shift) {
    const len = el.value.length;
    let a = el.selectionStart;
    let b = el.selectionEnd;
    if (a == null || b == null) return;
    const clamp = (n) => Math.max(0, Math.min(len, n));
    if (!shift) {
      const pos = a !== b ? (dir < 0 ? Math.min(a, b) : Math.max(a, b)) : clamp(a + dir);
      el.setSelectionRange(pos, pos, 'none');
      return;
    }
    const backward = el.selectionDirection === 'backward';
    const edge = backward ? a : b;
    const next = clamp(edge + dir);
    if (backward) {
      if (next > b) el.setSelectionRange(b, next, 'forward');
      else el.setSelectionRange(next, b, 'backward');
    } else if (next < a) el.setSelectionRange(next, a, 'backward');
    else el.setSelectionRange(a, next, 'forward');
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (aboutOpen) { ev.preventDefault(); closeAbout(false); return; }
      if (!confirmOpen) return;
      ev.preventDefault();
      cancelForget(false);
      return;
    }
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      const field = document.activeElement;
      if (field && (field.id === 'pass' || field.id === 'msg') && typeof field.selectionStart === 'number') {
        ev.preventDefault();
        nudgeCaret(field, ev.key === 'ArrowLeft' ? -1 : 1, ev.shiftKey);
      }
      return;
    }
    // Draft Send is between the transcript and Yes. Arrow keys have to move
    // there explicitly: the button is inside the scrolling transcript.
    if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      const el = document.activeElement;
      const send = visibleDraftSend();
      const yes = firstReply();
      if (send && el && el.classList && el.classList.contains('draft-send')) {
        ev.preventDefault();
        if (ev.key === 'ArrowUp') $('scroll').focus();
        else if (yes) yes.focus();
        else $('msg').focus();
        return;
      }
      if (ev.key === 'ArrowUp' && send && el && el.closest && el.closest('#quick-replies')) {
        ev.preventDefault();
        send.focus();
        return;
      }
    }
    // The transcript sits above the reply buttons. While it has the highlight,
    // Up and Down scroll it. Down at the bottom moves to draft Send, then Yes.
    if ((ev.key === 'ArrowUp' || ev.key === 'ArrowDown') && !ev.altKey && !ev.ctrlKey && !ev.metaKey && document.activeElement === $('scroll')) {
      const sc = $('scroll');
      const max = Math.max(0, sc.scrollHeight - sc.clientHeight);
      const step = Math.max(48, Math.round(sc.clientHeight * 0.8));
      if (ev.key === 'ArrowDown' && sc.scrollTop >= max - 1) {
        const send = visibleDraftSend();
        if (send) { ev.preventDefault(); send.focus(); return; }
        const next = firstReply();
        if (next) { ev.preventDefault(); next.focus(); }
        return;
      }
      if (ev.key === 'ArrowUp' && sc.scrollTop <= 0) { ev.preventDefault(); return; }
      ev.preventDefault();
      sc.scrollTop = ev.key === 'ArrowUp' ? Math.max(0, sc.scrollTop - step) : Math.min(max, sc.scrollTop + step);
      return;
    }
    // A transcript row is not a native button. Enter activates it once.
    // Real buttons, including the quick replies, keep the browser's own Enter.
    if (ev.key !== 'Enter' || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const el = document.activeElement;
    if (!el || !el.classList || !el.classList.contains('msg')) return;
    const sendBtn = el.querySelector('.draft-send');
    if (sendBtn && !sendBtn.hidden) { ev.preventDefault(); sendBtn.focus(); return; }
    ev.preventDefault();
    el.click();
  });
  window.addEventListener('popstate', () => {
    if (aboutOpen) closeAbout(true);
    else if (confirmOpen) cancelForget(true);
  });
  // Any interaction wakes the app (cheap no-op when already awake: just re-arms one timeout).
  for (const ev of ['pointerdown', 'keydown', 'focus']) window.addEventListener(ev, wake, { passive: true, capture: true });
  // Hide, freeze, and pagehide all mean the glasses left this page. Stop radios and speech.
  // The saved passphrase, key, and feed cache stay so the next open shows the chat again.
  function shutdown() {
    sleep();
    clearTimeout(bannerTimer);
    if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) shutdown(); else scheduleWakeFresh(); });
  window.addEventListener('pagehide', () => shutdown());
  document.addEventListener('freeze', () => shutdown());
  // resume is the pair of freeze. pageshow covers the back-forward cache. Neither waits
  // for a tap, so a long display-off comes back on its own.
  document.addEventListener('resume', () => scheduleWakeFresh());
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) scheduleWakeFresh(); });
  window.addEventListener('online', () => {
    if (!unlocked() || document.hidden || asleep) return;   // idle saver stays paused until a tap
    if (!sseLive || wasSuspended()) scheduleWakeFresh();
  });

  window.ChiefCrypto = { pbkdf2, decryptItems, encryptMessage, isReplay, noteSeen, draftHash, draftCanonical, isDraft, isSendDraft };
  // Glasses Back exits only when nothing is left to go back to, and the first
  // such Back opens the system menu (Resume). Do not push an entry here.
  // A leftover forget prompt or About screen is dropped so it cannot add a permanent extra step.
  if (history.state && (history.state.chief === 'confirm-forget' || history.state.chief === 'about') && history.length > 1) history.back();
  else if (!history.state || history.state.chief !== 'root') history.replaceState({ chief: 'root' }, '');
  start();
})();
