'use strict';
(() => {
  // Settings live in config.js. This file has no keys, topics, or personal names.
  const CFG = window.CHIEF_CONFIG || {};
  const LS_PASS = 'chief.pass', LS_AUTO = 'chief.auto', LS_FEED = 'chief.feedCache';
  const LS_OUT = 'chief.outbox', LS_HEARD = 'chief.lastHeard', LS_SAVER = 'chief.saver';
  const LS_SEEN_IDS = 'chief.seenIds', LS_SEEN_T = 'chief.seenT';
  const QS = new URLSearchParams(location.search);
  const showQuick = QS.get('replies') !== '0';   // on in the normal app; ?replies=0 hides them
  const QUICK = ['Yes', 'No', 'Later', 'Tell me more'];
  // Battery: the live channel (SSE) is the only network activity while healthy. The feed is polled only
  // while that channel is down, with backoff. Everything stops when hidden or idle.
  const BACKOFF_MS = [5000, 10000, 20000, 60000];
  const IDLE_MS = +QS.get('idle') || 3 * 60000;     // battery saver: sleep after this long with no taps/messages
  const WAIT_MS = 5 * 60000;                         // stay awake this long after a send, waiting for the reply
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
  const feedUrl = safeHttp(CFG.feedUrl, 'feed.json');
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
      out.push({ t: m.t, text: String(m.text ?? ''), role: m.role === 'owner' ? 'owner' : 'chief', id: m.id || null, ct: it.ct });
    }
    return out;
  }
  async function encryptMessage(text, key, salt, iter) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const id = bytesToB64(crypto.getRandomValues(new Uint8Array(9))).replace(/[+/=]/g, 'x');
    const t = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify({ t, text, role: 'owner', id })));
    const env = { v: 1, salt, iter, iv: bytesToB64(iv), ct: bytesToB64(ct) };
    return { id, t, armored: BEGIN + '\n' + btoa(JSON.stringify(env)) + '\n' + END };
  }
  async function decryptArmored(armored, key) {
    const env = JSON.parse(atob(armored.slice(BEGIN.length, -END.length).trim()));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(env.iv) }, key, b64ToBytes(env.ct));
    return JSON.parse(dec.decode(pt)).text;
  }

  // ---------- replay protection ----------
  // Live updates (not the saved feed) drop a message we have already accepted,
  // and drop one whose time is older than the newest time we have accepted.
  // The feed itself still shows its history.
  let seenIds = new Set((getJSON(LS_SEEN_IDS, []) || []).filter((x) => typeof x === 'string'));
  let seenT = store.get(LS_SEEN_T) || '';
  function isReplay(m) {
    if (!m) return true;
    if (m.id && seenIds.has(m.id)) return true;
    const ms = Date.parse(m.t);
    const prev = Date.parse(seenT);
    if (!Number.isNaN(ms) && !Number.isNaN(prev) && ms < prev) return true;
    return false;
  }
  function noteSeen(list) {
    let dirty = false;
    let best = Date.parse(seenT);
    for (const m of list) {
      if (!m) continue;
      if (m.id && !seenIds.has(m.id)) { seenIds.add(m.id); dirty = true; }
      const ms = Date.parse(m.t);
      if (!Number.isNaN(ms) && (Number.isNaN(best) || ms > best)) { best = ms; seenT = m.t; dirty = true; }
    }
    if (seenIds.size > 500) { seenIds = new Set([...seenIds].slice(-400)); dirty = true; }
    if (!dirty) return;
    store.set(LS_SEEN_IDS, JSON.stringify([...seenIds]));
    if (seenT) store.set(LS_SEEN_T, seenT);
  }
  function uniqueById(list) {
    const seen = new Set();
    const out = [];
    for (const m of list) {
      if (m.id) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
      }
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
  }

  // ---------- state ----------
  let messages = [];                   // shown: feed + live extras, newest first
  let feedMsgs = [];                   // decrypted feed
  let live = [];                       // entries that arrived live but aren't in the fetched feed yet
  let outbox = getJSON(LS_OUT, []);    // [{id,t,armored,state}] wearer messages not yet in the feed
  const outText = new Map();           // id -> plaintext (memory only)
  let feedText = null, feedSalt = null, feedIter = 310000;
  let busy = false, waitUntil = 0;
  let auto = store.get(LS_AUTO) !== 'off';
  let saver = store.get(LS_SAVER) !== 'off';
  let lastHeard = store.get(LS_HEARD) || '';   // newest assistant message already alerted/seen

  const saveOutbox = () => store.set(LS_OUT, JSON.stringify(outbox.map(({ id, t, armored, state }) => ({ id, t, armored, state }))));
  function showError(msg) { const e = $('error'); e.textContent = msg || ''; e.hidden = !msg; }
  function setStatus(kind, msg) { const s = $('send-status'); s.dataset.kind = kind || ''; s.textContent = msg || ''; }
  const setChecked = (msg) => { $('checked').textContent = msg; };
  function showLock(msg) { sleep(); $('feed').hidden = true; $('lock').hidden = false; $('lock-status').textContent = msg || ''; }
  function showFeed() { $('lock').hidden = true; $('feed').hidden = false; }
  const unlocked = () => !$('feed').hidden;
  function renderToggles() {
    const a = $('auto-btn'); a.textContent = 'Auto-read: ' + (auto ? 'On' : 'Off'); a.setAttribute('aria-pressed', String(auto));
    const v = $('saver-btn'); v.textContent = 'Saver: ' + (saver ? 'On' : 'Off'); v.setAttribute('aria-pressed', String(saver));
  }
  const latestChief = () => messages.find((m) => m.role === 'chief');
  const scrollEnd = () => { const sc = $('scroll'); sc.scrollTop = sc.scrollHeight; };
  function applyLabels() {
    $('banner').textContent = 'New reply from ' + assistantName;
    $('msg').placeholder = 'Message ' + assistantName;
    $('msg').setAttribute('aria-label', 'Message to ' + assistantName);
  }

  // ---------- render: keyed diff, only changed bubbles touch the DOM ----------
  const MARK = { sending: ' · sending…', sent: ' · sent ✓', failed: ' · not sent, tap to retry' };
  const nodes = new Map();   // key -> {li, sig}
  function render() {
    const ids = new Set(messages.map((m) => m.id).filter(Boolean));
    const owned = new Set(messages.filter((m) => m.role === 'owner').map((m) => m.text.trim()));
    const before = outbox.length;
    outbox = outbox.filter((o) => !ids.has(o.id) && !(outText.has(o.id) && owned.has(outText.get(o.id).trim())));
    if (outbox.length !== before) saveOutbox();
    const pend = outbox.filter((o) => outText.has(o.id)).map((o) => ({ t: o.t, text: outText.get(o.id), role: 'owner', id: o.id, state: o.state }));
    const time = (m) => Date.parse(m.t) || 0;
    const list = [...pend, ...messages].map((m, i) => [m, i])
      .sort((a, b) => (time(b[0]) - time(a[0])) || ((a[0].role === 'owner') - (b[0].role === 'owner')) || (a[1] - b[1]))
      .slice(0, MAX_SHOWN).map(([m]) => m).reverse();
    const sc = $('scroll'), ol = $('convo');
    const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40;
    const keep = new Set();
    let added = false, prev = null;
    for (const m of list) {
      const key = m.id ? 'i:' + m.id : 'c:' + m.ct;
      keep.add(key);
      const label = (m.role === 'owner' ? 'You · ' : assistantName + ' · ') + fmtTime(m.t) + (m.state ? MARK[m.state] : '');
      const sig = m.role + '|' + (m.state || '') + '|' + label + '|' + m.text;
      let n = nodes.get(key);
      if (!n) {
        const li = document.createElement('li');
        li.append(document.createElement('time'), document.createElement('div'));
        li.firstChild.className = 'time'; li.lastChild.className = 'text';
        n = { li, sig: '' }; nodes.set(key, n); added = true;
      }
      if (n.sig !== sig) {
        n.li.className = 'msg ' + m.role + (m.state ? ' pending ' + m.state : '');
        if (m.state) n.li.dataset.id = m.id; else delete n.li.dataset.id;
        n.li.firstChild.textContent = label;
        n.li.lastChild.textContent = m.text;
        n.sig = sig;
      }
      let want = prev ? prev.nextSibling : ol.firstChild;
      while (want && want.id === 'quick-replies') want = want.nextSibling;
      if (want !== n.li) ol.insertBefore(n.li, want);
      prev = n.li;
    }
    for (const [key, n] of nodes) if (!keep.has(key)) { n.li.remove(); nodes.delete(key); }
    placeQuick(list);
    $('empty').hidden = list.length > 0;
    $('read-btn').disabled = !latestChief();
    if (atBottom || added) scrollEnd();
  }
  // Quick replies sit under the newest assistant bubble and send that text. ?replies=0 hides them.
  function placeQuick(list) {
    const row = $('quick-replies');
    if (!showQuick) { if (row) row.remove(); return; }
    let chiefKey = null;
    for (const m of list) if (m.role === 'chief') chiefKey = m.id ? 'i:' + m.id : 'c:' + m.ct;
    const host = chiefKey && nodes.get(chiefKey);
    if (!host) { if (row) row.remove(); return; }
    let el = row;
    if (!el) {
      el = document.createElement('li');
      el.id = 'quick-replies';
      el.className = 'quick-replies';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', 'Quick replies');
      for (const label of QUICK) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.dataset.text = label;
        el.append(b);
      }
      el.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (b && el.contains(b)) send(b.dataset.text);
      });
    }
    if (host.li.nextSibling !== el) host.li.after(el);
  }

  // Apply a feed (raw JSON text). Decrypts only when the text changed.
  async function applyFeed(text, { pass = null, alert = true } = {}) {
    if (text === feedText && !pass) return true;
    let feed;
    try { feed = JSON.parse(text); } catch { throw new Error('bad-feed'); }
    if (!feed || feed.v !== 1 || !Array.isArray(feed.items)) throw new Error('bad-feed');
    let list = [];
    if (feed.items.length) {
      const iter = feed.iter || 310000;
      const key = await keyFor(feed.salt, iter, pass);
      list = uniqueById(await decryptItems(feed, key));
      if (!keyRec || keyRec.key !== key) remember(feed.salt, iter, key);
      feedSalt = feed.salt; feedIter = iter;
      for (const o of outbox) if (!outText.has(o.id)) { try { outText.set(o.id, await decryptArmored(o.armored, key)); } catch { /* drop later */ } }
    }
    noteSeen(list);
    feedText = text;
    store.set(LS_FEED, text);
    feedMsgs = list;
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
      if (alert && lastHeard) { alertNew(nc.text); activity(); }
      lastHeard = nc.t; store.set(LS_HEARD, lastHeard);
      if (waitUntil) { waitUntil = 0; setStatus('ok', assistantName + ' replied ✓'); }
    }
  }

  async function fetchText(url, opts) {
    const r = await fetch(url, { cache: 'no-cache', ...opts });   // revalidates with ETag; 304s are cheap
    if (!r.ok) throw new Error('http-' + r.status);
    return r.text();
  }
  // One catch-up. Right after a send, an optional API copy can be fresher than the site.
  async function refresh() {
    if (busy || !unlocked()) return false;
    busy = true;
    try {
      let text = null;
      if (apiFeedUrl && Date.now() < waitUntil) {
        try { text = await fetchText(apiFeedUrl, { headers: { Accept: 'application/vnd.github.raw+json' } }); } catch { /* fall back */ }
      }
      try { if (text === null) text = await fetchText(feedUrl); }
      catch {
        setChecked('Offline · ' + fmtClock.format(new Date()));
        if (!feedText) showError(navigator.onLine === false ? 'Offline. Check your phone connection.' : 'Could not load messages. Try Refresh.');
        return false;
      }
      try { await applyFeed(text); showError(''); }
      catch (e) {
        if (e.message === 'nokey') { showLock(); return false; }
        showError(e.message === 'decrypt' ? 'Could not decrypt. The key changed? Use Forget passphrase.' : 'Message feed is damaged. Try Refresh.');
      }
      if (!sseLive) setChecked('Checked ' + fmtClock.format(new Date()));
      return true;
    } finally { busy = false; }
  }

  // ---------- connection manager: live channel first, backoff polling only while it's down ----------
  let es = null, sseLive = false, asleep = true;
  let pollTimer = null, pollStep = 0, idleTimer = null;
  function startPolling(reset) {
    if (reset) pollStep = 0;
    if (pollTimer || sseLive || asleep) return;
    const ms = BACKOFF_MS[Math.min(pollStep, BACKOFF_MS.length - 1)];
    pollTimer = setTimeout(async () => { pollTimer = null; pollStep++; await refresh(); startPolling(); }, ms);
  }
  function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
  function connectLive() {
    if (es) return;
    if (!BACKUP || !window.EventSource) { startPolling(); return; }
    try { es = new EventSource(BACKUP + '/sse'); } catch { es = null; startPolling(); return; }
    es.onopen = () => { sseLive = true; pollStep = 0; stopPolling(); setChecked('Live ' + fmtClock.format(new Date())); refresh(); };
    es.onmessage = onLive;
    es.onerror = () => {           // EventSource retries on its own; poll (with backoff) only while it's down
      sseLive = false;
      setChecked('Reconnecting…');
      if (es && es.readyState === 2) { es.close(); es = null; }
      startPolling();
    };
  }
  function closeLive() { if (es) { es.close(); es = null; } sseLive = false; }
  // Wake up (tap, focus, visible, send): connect, catch up once, (re)arm the idle timer.
  function wake() {
    if (!unlocked() || document.hidden) return;
    const was = asleep;
    asleep = false;
    connectLive();
    if (was && !BACKUP) refresh();
    activity();
  }
  function activity() {
    clearTimeout(idleTimer); idleTimer = null;
    if (!saver || asleep) return;
    const ms = Math.max(IDLE_MS, waitUntil - Date.now());
    idleTimer = setTimeout(() => { idleTimer = null; sleep('Paused to save battery · tap to update'); }, ms);
  }
  // Stop everything: no connection, no timers.
  function sleep(msg) {
    asleep = true;
    closeLive(); stopPolling();
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
    if ((m.id && (feedMsgs.some((x) => x.id === m.id) || live.some((x) => x.id === m.id))) || isReplay(m)) return;
    noteSeen([m]);
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
  async function send(preset) {
    const input = $('msg');
    const fromField = typeof preset !== 'string';
    const text = (fromField ? input.value : preset).trim();
    if (!text) { setStatus('err', 'Type or speak a message first.'); input.focus(); return; }
    if (!emailConfigured() && !BACKUP) {
      setStatus('err', 'Sending is not set up. In config.js, replace YOUR_WEB3FORMS_KEY on the web3formsKey line.');
      return;
    }
    if (!keyRec || !feedSalt) { setStatus('err', 'Not ready yet. Tap Refresh, then try again.'); return; }
    const m = await encryptMessage(text, keyRec.key, feedSalt, feedIter);
    const o = { ...m, state: 'sending' };
    outText.set(o.id, text);
    outbox.push(o); saveOutbox();
    if (fromField) input.value = '';
    render(); scrollEnd();
    setStatus('busy', 'Sending in the background…');
    startWaiting();
    if (emailConfigured()) backupCopy(o);
    deliver(o);
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
    wake();
    if (cached) {   // instant: last feed from this device, decrypted with the stored key
      try { await applyFeed(cached, { alert: false }); scrollEnd(); } catch (e) { if (e.message === 'nokey') { showLock(); return; } }
    }
    const cutoff = Date.now() - 2 * 86400000;
    outbox = outbox.filter((o) => (Date.parse(o.t) || 0) > cutoff);
    for (const o of outbox) if (o.state === 'sending') o.state = 'failed';   // app was closed mid-send
    saveOutbox();
    render();
    if (!es) refresh();   // a live channel's onopen does its own catch-up
  }

  // ---------- events ----------
  $('unlock-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const v = $('pass').value.trim();
    if (!v) { $('lock-status').textContent = 'Enter your passphrase.'; return; }
    $('lock-status').textContent = 'Unlocking…';
    if (await unlock(v)) { $('pass').value = ''; $('msg').focus(); }
  });
  $('compose').addEventListener('submit', (ev) => { ev.preventDefault(); send(); });
  $('convo').addEventListener('click', (ev) => {
    const li = ev.target.closest('li.failed');
    const o = li && outbox.find((x) => x.id === li.dataset.id);
    if (o) { setStatus('busy', 'Retrying in the background…'); startWaiting(); deliver(o); }
  });
  $('read-btn').addEventListener('click', () => { const m = latestChief(); if (m) speak(m.text); });
  $('refresh-btn').addEventListener('click', () => { setChecked('Checking…'); refresh(); });
  $('auto-btn').addEventListener('click', () => {
    auto = !auto; store.set(LS_AUTO, auto ? 'on' : 'off'); renderToggles();
    if (!auto && canSpeak()) speechSynthesis.cancel();
  });
  $('saver-btn').addEventListener('click', () => { saver = !saver; store.set(LS_SAVER, saver ? 'on' : 'off'); renderToggles(); activity(); });
  $('banner').addEventListener('click', () => { $('banner').hidden = true; document.body.classList.remove('new'); const m = latestChief(); if (m) speak(m.text); });
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
    // Seen ids and the newest timestamp stay, so an old copied message still will not pop up.
    idb.clear();
    sleep();
    keyRec = null; messages = []; feedMsgs = []; live = []; outbox = []; outText.clear(); feedText = null; feedSalt = null; waitUntil = 0; lastHeard = '';
    if (canSpeak()) speechSynthesis.cancel();
    render(); setStatus('', '');
    showLock('Passphrase forgotten.');
    $('pass').focus();
  }
  $('forget-btn').addEventListener('click', askForget);
  $('confirm-cancel').addEventListener('click', () => cancelForget(false));
  $('confirm-forget').addEventListener('click', commitForget);
  document.addEventListener('keydown', (ev) => {
    if (!confirmOpen || ev.key !== 'Escape') return;
    ev.preventDefault();
    cancelForget(false);
  });
  window.addEventListener('popstate', () => { if (confirmOpen) cancelForget(true); });
  // Any interaction wakes the app (cheap no-op when already awake: just re-arms one timeout).
  for (const ev of ['pointerdown', 'keydown', 'focus']) window.addEventListener(ev, wake, { passive: true, capture: true });
  // Hide, freeze, and pagehide all mean the glasses left this page. Stop radios and speech.
  // The saved passphrase, key, and feed cache stay so the next open shows the chat again.
  function shutdown() {
    sleep();
    clearTimeout(bannerTimer);
    if (canSpeak()) { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) shutdown(); else wake(); });
  window.addEventListener('pagehide', () => shutdown());
  document.addEventListener('freeze', () => shutdown());
  window.addEventListener('pageshow', (ev) => { if (ev.persisted && !document.hidden) wake(); });
  window.addEventListener('online', () => { if (unlocked() && !asleep) { connectLive(); refresh(); } });

  window.ChiefCrypto = { pbkdf2, decryptItems, encryptMessage, isReplay, noteSeen };
  // Glasses Back exits only when nothing is left to go back to, and the first
  // such Back opens the system menu (Resume). Do not push an entry here.
  // A leftover forget prompt is dropped so it cannot add a permanent extra step.
  if (history.state && history.state.chief === 'confirm-forget' && history.length > 1) history.back();
  else if (!history.state || history.state.chief !== 'root') history.replaceState({ chief: 'root' }, '');
  start();
})();
