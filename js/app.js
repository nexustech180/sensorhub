'use strict';
/* Gold Var Sensor Hub — ESP32 + ESP32-CAM dashboard */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const G = Classifier.GROUPS;
const RANK = { ok: 0, warn: 1, crit: 2 };
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const KEY_SETTINGS = 'sensorhub.settings';
const KEY_KNOWN = 'sensorhub.known';
const DEFAULTS = {
  demo: true, demoCam: true, demoPattern: 'random', demoVideoUrl: '', demoVideoName: '',
  mcuIp: '', mcuPath: '/data', pollMs: 2000,
  ai: true,
  camIp: '', camStream: 'http://{ip}:81/stream', camCapture: 'http://{ip}/capture',
  notify: true, browserNotify: false, sound: false, overlay: true,
  maxRecords: 50000, thresholds: {}, overrides: {},
};

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* storage unavailable */ }
}

let settings = { ...DEFAULTS, ...loadJSON(KEY_SETTINGS, {}) };
const saveSettings = () => saveJSON(KEY_SETTINGS, settings);
// The demo video is only used while demo mode is on AND the feed hasn't been switched to the real camera.
const demoCam = () => settings.demo && settings.demoCam !== false;
const known = new Set(loadJSON(KEY_KNOWN, []));

const S = {
  route: 'home',
  sensors: new Map(),   // key → live sensor state
  version: 0,           // bumps when the sensor set / classification changes
  mcu: 'idle', cam: 'idle',
  alerts: [], unread: 0,
  total: 0, ingests: 0,
  page: 0, pollTimer: null,
};

/* ---------------- formatting ---------------- */
function fmtVal(v, kind) {
  if (kind === 'bool') return v ? 'ON' : 'OFF';
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toFixed(a >= 100 ? 1 : 2)));
}
const fmtTime = ts => new Date(ts).toLocaleTimeString();
function fmtAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return new Date(ts).toLocaleString();
}
const groupLabel = g => (G[g] || G.other).label;
const groupColor = g => (G[g] || G.other).color;
const typeLabel = t => Classifier.byId(t).label;

/* ---------------- URLs ---------------- */
const hostOf = ip => String(ip || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
function mcuUrl() {
  let p = String(settings.mcuPath || '/data').trim();
  if (!p.startsWith('/')) p = '/' + p;
  return `http://${hostOf(settings.mcuIp)}${p}`;
}
const camUrl = tpl => String(tpl || '').replace(/\{ip\}/g, hostOf(settings.camIp));

async function fetchPayload(url, ms = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch { return text; }
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'timed out' : e.message);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- thresholds ---------------- */
function thresholdsFor(type) {
  return settings.thresholds[type] || Classifier.byId(type).th || {};
}

/* ---------------- polling & ingest ---------------- */
function schedulePoll(delay) {
  clearTimeout(S.pollTimer);
  S.pollTimer = setTimeout(poll, delay ?? Math.max(250, +settings.pollMs || 2000));
}

async function poll() {
  try {
    if (settings.demo) {
      setStatus('mcu', 'demo');
      await ingest(Demo.next(settings.demoPattern), 'demo');
    } else if (!hostOf(settings.mcuIp)) {
      setStatus('mcu', 'idle');
    } else {
      let payload;
      try { payload = await fetchPayload(mcuUrl()); }
      catch (e) { setStatus('mcu', 'off', e.message); }
      if (payload !== undefined) {
        setStatus('mcu', 'on');
        await ingest(payload, 'esp32');
      }
    }
  } catch (e) {
    console.error(e);
  }
  schedulePoll();
}

// Plain-text payloads (e.g. from the GOLD-VAR pass-through gateway) are read line by line:
// the built-in "name=value" parser first, then rules the AI helper learned earlier; lines
// nothing can read yet are queued for the AI helper (if it's turned on).
// The gateway sends the newest lines first, so the first value for a name wins.
function prepareText(payload) {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { /* not JSON: read as text */ }
  const merged = {};
  for (const raw of payload.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj = Classifier.parseText(line);
    if (!Object.keys(obj).length) {
      obj = AiAssist.applyLine(line);
      if (!obj) { AiAssist.noteUnknownLine(line); continue; }
    }
    for (const [k, v] of Object.entries(obj)) if (!(k in merged)) merged[k] = v;
  }
  return merged;
}

const classifierOverrides = () => ({ ...AiAssist.keyTypes(), ...settings.overrides });

async function ingest(payload, source) {
  const items = Classifier.parse(prepareText(payload), classifierOverrides());
  if (!items.length) return;
  const ts = Date.now();
  const recs = [];

  for (const it of items) {
    if (it.type === 'other' && !settings.overrides[it.key]) AiAssist.noteUnknownKey(it.key, it.value);
    // A status reported by the device (the GOLD-VAR Mega's own WARNING/DANGER) wins over local thresholds
    const { status, reason } = it.devStatus
      ? { status: it.devStatus, reason: it.devStatus === 'ok' ? 'normal (reported by device)' : 'reported by device' }
      : Classifier.evaluate(it, thresholdsFor(it.type));
    let s = S.sensors.get(it.key);
    if (!s) {
      s = { key: it.key, hist: [], min: Infinity, max: -Infinity, sum: 0, n: 0, status: 'ok' };
      S.sensors.set(it.key, s);
      S.version++;
    }
    if (s.type !== it.type) S.version++;
    const prev = s.status;
    Object.assign(s, { name: it.name, type: it.type, autoType: it.autoType, group: it.group, unit: it.unit, kind: it.kind, value: it.value, status, reason, ts, source });
    s.hist.push(it.value);
    if (s.hist.length > 120) s.hist.shift();
    s.min = Math.min(s.min, it.value); s.max = Math.max(s.max, it.value); s.sum += it.value; s.n++;

    if (!known.has(it.key)) {
      known.add(it.key); saveJSON(KEY_KNOWN, [...known]);
      notify('info', 'New sensor detected', `${it.name} → ${typeLabel(it.type)} (${groupLabel(it.group)})`, it.key);
    }
    if (RANK[status] > RANK[prev]) {
      notify(status, `${it.name} ${status === 'crit' ? 'CRITICAL' : 'warning'}`,
        `${fmtVal(it.value, it.kind)} ${it.unit} — ${reason}`, it.key);
    } else if (status === 'ok' && prev !== 'ok') {
      notify('ok', `${it.name} back to normal`, `${fmtVal(it.value, it.kind)} ${it.unit}`, it.key);
    }

    recs.push({ ts, sensor: it.key, name: it.name, type: it.type, group: it.group, value: it.value, unit: it.unit, kind: it.kind, status, source });
  }

  if (source === 'demo') {
    const t = items.find(i => i.type === 'turbidity');
    if (t) DemoFeed.setTurbidity(t.value);
  }

  await DB.addMany('readings', recs);
  S.total += recs.length;
  if (++S.ingests % 40 === 0) {
    S.total -= await DB.prune('readings', Math.max(1000, +settings.maxRecords || 50000));
    DB.prune('alerts', 2000).catch(() => {});
  }
  refreshViews();
}

// Rebuild in-memory sensor state from the newest stored readings.
async function seedFromDb() {
  const tmp = new Map();
  let seen = 0;
  await DB.each('readings', r => {
    let s = tmp.get(r.sensor);
    if (!s) {
      s = { key: r.sensor, name: r.name, type: r.type, autoType: r.type, group: r.group, unit: r.unit, kind: r.kind,
        value: r.value, status: r.status, reason: '', ts: r.ts, source: r.source, hist: [], min: Infinity, max: -Infinity, sum: 0, n: 0 };
      tmp.set(r.sensor, s);
    }
    if (s.hist.length < 120) s.hist.unshift(r.value);
    s.min = Math.min(s.min, r.value); s.max = Math.max(s.max, r.value); s.sum += r.value; s.n++;
    return ++seen < 4000;
  });
  S.sensors = tmp;
  S.version++;
}

/* ---------------- connection status ---------------- */
function setStatus(which, state, detail) {
  const prev = S[which];
  S[which] = state;
  const pill = $(which === 'mcu' ? '#pill-mcu' : '#pill-cam');
  pill.className = 'pill ' + ({ on: 'on', off: 'off', demo: 'demo-src' }[state] || '');
  const name = which === 'mcu' ? 'ESP32 sensor board' : 'ESP32-CAM';
  pill.title = `${name}: ${{ on: 'connected', off: 'unreachable' + (detail ? ' (' + detail + ')' : ''), idle: 'no IP set', demo: 'demo mode' }[state]}`;
  if (prev === state || state === 'demo' || state === 'idle' || prev === 'demo') return;
  if (state === 'off') {
    const where = which === 'mcu' ? mcuUrl() : hostOf(settings.camIp);
    notify(prev === 'on' ? 'crit' : 'warn', `${name} ${prev === 'on' ? 'disconnected' : 'unreachable'}`, `${where}${detail ? ' — ' + detail : ''}`);
  } else if (state === 'on') {
    notify('ok', `${name} connected`, which === 'mcu' ? mcuUrl() : hostOf(settings.camIp));
  }
}

/* ---------------- notifications ---------------- */
function notify(level, title, msg, sensor) {
  const a = { ts: Date.now(), level, title, msg, sensor: sensor || null };
  S.alerts.unshift(a);
  if (S.alerts.length > 300) S.alerts.pop();
  DB.addMany('alerts', [a]).catch(() => {});
  if ($('#drawer').hidden) S.unread++;
  updateBell();
  renderAlertLists();
  if (settings.notify) toast(a);
  if (settings.browserNotify && level !== 'info' && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body: msg, tag: sensor || title }); } catch { /* unsupported */ }
  }
  if (settings.sound && (level === 'warn' || level === 'crit')) beep(level);
}

function toast(a) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast lv-${a.level}`;
  el.innerHTML = `<div><div class="t">${esc(a.title)}</div><div class="m">${esc(a.msg)}</div></div>`;
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 250); };
  el.onclick = kill;
  box.appendChild(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(kill, a.level === 'crit' ? 9000 : 5000);
}

let audioCtx;
function beep(level) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = level === 'crit' ? 880 : 620;
    g.gain.setValueAtTime(0.12, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.35);
  } catch { /* audio blocked */ }
}

function updateBell() {
  const b = $('#bell-count');
  b.hidden = S.unread === 0;
  b.textContent = S.unread > 99 ? '99+' : S.unread;
}

function alertItems(list) {
  if (!list.length) return '<li class="empty-li">No notifications yet.</li>';
  return list.map(a => `<li class="lv-${a.level}"><div><div class="t">${esc(a.title)}</div><div class="m">${esc(a.msg)}</div></div><time title="${esc(new Date(a.ts).toLocaleString())}" data-ts="${a.ts}">${fmtAgo(a.ts)}</time></li>`).join('');
}
function renderAlertLists() {
  if (S.route === 'home') $('#alert-feed').innerHTML = alertItems(S.alerts.slice(0, 40));
  if (!$('#drawer').hidden) $('#alert-drawer').innerHTML = alertItems(S.alerts);
}

async function loadAlerts() {
  const list = [];
  await DB.each('alerts', a => { list.push(a); return list.length < 300; });
  S.alerts = list;
}

/* ---------------- routing ---------------- */
const ROUTES = ['home', 'live', 'db', 'settings'];
function route() {
  const r = location.hash.replace(/^#\/?/, '') || 'home';
  const prev = S.route;
  S.route = ROUTES.includes(r) ? r : 'home';
  $$('.view').forEach(v => { v.hidden = v.id !== 'view-' + S.route; });
  $$('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === S.route));
  if (prev === 'live' && S.route !== 'live') stopLive();
  if (S.route === 'home') { renderHome(); renderAlertLists(); refreshThumbSnap(); }
  if (S.route === 'live') { startLive(); renderLive(); }
  if (S.route === 'db') { renderDb(); loadRecords(); }
  if (S.route === 'settings') fillSettings();
  window.scrollTo(0, 0);
}

let refreshPending = false;
function refreshViews() {
  if (refreshPending) return;
  refreshPending = true;
  requestAnimationFrame(() => {
    refreshPending = false;
    if (S.route === 'home') renderHome();
    if (S.route === 'live') renderLive();
    if (S.route === 'db') { renderDb(); if (S.page === 0) loadRecordsSoon(); }
    if (S.route === 'settings') renderSensorTable(false);
  });
}

/* ---------------- sensor helpers ---------------- */
function sortedSensors() {
  return [...S.sensors.values()].sort((a, b) =>
    Classifier.GROUP_ORDER.indexOf(a.group) - Classifier.GROUP_ORDER.indexOf(b.group) || a.name.localeCompare(b.name));
}
function byGroup() {
  const m = new Map();
  for (const s of sortedSensors()) {
    if (!m.has(s.group)) m.set(s.group, []);
    m.get(s.group).push(s);
  }
  return m;
}
const featured = () => sortedSensors().filter(s => s.group !== 'system');

/* ---------------- home ---------------- */
function renderHome() {
  const sensors = featured();
  const groups = new Set(sensors.map(s => s.group));
  $('#thumb-db-info').textContent = `${S.total.toLocaleString()} records · ${S.sensors.size} sensors · ${groups.size} groups`;
  const box = $('#thumb-db');
  box.innerHTML = sensors.length
    ? sensors.slice(0, 6).map(s => `<div class="mini ${s.status}" style="--g:${groupColor(s.group)}"><span class="n">${esc(s.name)}</span><span class="v">${fmtVal(s.value, s.kind)}<small>${esc(s.unit)}</small></span></div>`).join('')
    : '<div class="empty">Waiting for sensor data…</div>';

  const info = $('#thumb-feed-info');
  if (demoCam()) info.textContent = 'Demo loop · ' + DemoFeed.label;
  else if (!hostOf(settings.camIp)) info.textContent = 'No camera IP set — open Settings';
  else info.textContent = 'ESP32-CAM · ' + hostOf(settings.camIp);
  $$('#alert-feed time').forEach(t => { t.textContent = fmtAgo(+t.dataset.ts); });
}

// Home thumbnail for a real camera uses snapshots (the ESP32-CAM usually allows only one stream client).
let snapPending = false;
function refreshThumbSnap() {
  const img = $('#thumb-snap'), cv = $('#thumb-feed'), off = $('#thumb-feed-off');
  if (demoCam()) { img.hidden = true; cv.hidden = false; off.hidden = true; return; }
  cv.hidden = true;
  if (!hostOf(settings.camIp)) {
    img.hidden = true; off.hidden = false;
    off.querySelector('span').textContent = 'No camera configured';
    off.querySelector('small').textContent = 'Set the ESP32-CAM IP in Settings';
    setStatus('cam', 'idle');
    return;
  }
  if (snapPending) return;
  snapPending = true;
  const url = camUrl(settings.camCapture);
  const probe = new Image();
  const done = ok => {
    snapPending = false;
    if (ok) { img.src = probe.src; img.hidden = false; off.hidden = true; setStatus('cam', 'on'); }
    else {
      img.hidden = true; off.hidden = false;
      off.querySelector('span').textContent = 'Camera offline';
      off.querySelector('small').textContent = url;
      setStatus('cam', 'off');
    }
  };
  const timer = setTimeout(() => { probe.src = BLANK; done(false); }, 6000);
  probe.onload = () => { clearTimeout(timer); if (probe.src !== BLANK) done(true); };
  probe.onerror = () => { clearTimeout(timer); done(false); };
  probe.src = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
}

let healthTick = 0;
function camHealth() {
  if (demoCam()) { setStatus('cam', 'demo'); return; }
  if (S.route === 'live') return;              // the stream itself reports status
  if (S.route === 'home') refreshThumbSnap();
  else if (++healthTick % 3 === 0) refreshThumbSnap();
}

/* ---------------- live feed ---------------- */
let liveRetry;
function showOffline(show, msg, url) {
  $('#live-offline').hidden = !show;
  if (msg) $('#live-offline-msg').textContent = msg;
  $('#live-offline-url').textContent = url || '';
}
// Quick switch on the Live Feed page between the demo video and the real ESP32-CAM (demo mode only).
function updateSourceButton() {
  const b = $('#btn-source');
  b.hidden = !settings.demo;
  b.textContent = demoCam() ? 'Switch to ESP32-CAM' : 'Switch to demo video';
}
function toggleSource() {
  settings.demoCam = !demoCam();
  const el = $('#s-demoCam');
  if (el) el.checked = settings.demoCam;
  applySettings('demoCam');
}

// If the MJPEG stream never delivers a frame (busy with another viewer, or a different stream
// port/path), fall back to rapidly refreshed snapshots from the capture URL.
let streamCheck, snapLoop, liveMode = null;
function clearLiveTimers() {
  clearTimeout(liveRetry); clearTimeout(streamCheck); clearTimeout(snapLoop);
}
function startSnapshotMode() {
  clearLiveTimers();
  const img = $('#live-img');
  img.dataset.live = '';          // stream load/error handlers ignore the image from now on
  img.src = BLANK;                // release the stream connection
  liveMode = 'snapshot';
  let fails = 0;
  const tick = () => {
    if (S.route !== 'live' || demoCam() || liveMode !== 'snapshot') return;
    const url = camUrl(settings.camCapture);
    const probe = new Image();
    const fail = () => {
      fails++;
      if (fails >= 3) {
        img.hidden = true;
        showOffline(true, 'Camera not reachable — retrying every 5 s', url);
        setStatus('cam', 'off');
      }
      snapLoop = setTimeout(tick, fails >= 3 ? 5000 : 500);
    };
    const timer = setTimeout(() => { probe.src = BLANK; fail(); }, 5000);
    probe.onload = () => {
      if (probe.src === BLANK) return;
      clearTimeout(timer);
      fails = 0;
      img.src = probe.src;
      img.hidden = false;
      showOffline(false);
      setStatus('cam', 'on');
      snapLoop = setTimeout(tick, 120);
    };
    probe.onerror = () => { clearTimeout(timer); fail(); };
    probe.src = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
  };
  $('#live-src').textContent = 'Snapshot mode (video stream unavailable) · ' + camUrl(settings.camCapture);
  tick();
}

function startLive() {
  clearLiveTimers();
  liveMode = null;
  updateSourceButton();
  const img = $('#live-img'), cv = $('#live-canvas');
  $('#btn-overlay').textContent = 'Sensor overlay: ' + (settings.overlay ? 'On' : 'Off');
  if (demoCam()) {
    img.dataset.live = ''; img.src = BLANK; img.hidden = true; cv.hidden = false;
    showOffline(false);
    $('#live-src').textContent = 'Demo · ' + DemoFeed.label;
    return;
  }
  cv.hidden = true;
  if (!hostOf(settings.camIp)) {
    img.hidden = true;
    showOffline(true, 'No ESP32-CAM IP set', 'Add it in Settings → ESP32-CAM');
    $('#live-src').textContent = '';
    setStatus('cam', 'idle');
    return;
  }
  const url = camUrl(settings.camStream);
  $('#live-src').textContent = url;
  img.hidden = false;
  img.dataset.live = '1';
  liveMode = 'stream';
  img.src = url;
  streamCheck = setTimeout(() => {
    if (S.route === 'live' && liveMode === 'stream' && !(img.naturalWidth > 1)) startSnapshotMode();
  }, 5000);
}
function stopLive() {
  clearLiveTimers();
  liveMode = null;
  const img = $('#live-img');
  img.dataset.live = '';
  img.src = BLANK;   // closes the MJPEG connection
}
function onLiveLoad() {
  if (!$('#live-img').dataset.live) return;
  showOffline(false);
  setStatus('cam', 'on');
}
function onLiveError() {
  const img = $('#live-img');
  if (!img.dataset.live) return;
  startSnapshotMode();   // snapshot mode shows the offline message itself if the camera is really down
}

function renderLive() {
  const side = $('#live-side');
  const groups = byGroup();
  side.innerHTML = groups.size ? [...groups].map(([g, list]) => `
    <div class="grp" style="--g:${groupColor(g)}"><h4>${esc(groupLabel(g))}</h4>
      ${list.map(s => `<div class="rd ${s.status}"><span>${esc(s.name)}</span><span>${fmtVal(s.value, s.kind)} ${esc(s.unit)}</span></div>`).join('')}
    </div>`).join('') : '<p class="muted">No readings yet.</p>';

  const ov = $('#live-overlay');
  ov.hidden = !settings.overlay;
  if (settings.overlay) {
    ov.innerHTML = featured().slice(0, 8).map(s =>
      `<span class="chip ${s.status}" style="--g:${groupColor(s.group)}">${esc(s.name)}<b>${fmtVal(s.value, s.kind)} ${esc(s.unit)}</b></span>`).join('');
  }
}

async function snapshot() {
  const name = `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (demoCam()) {
    DemoFeed.draw();
    try {
      DemoFeed.canvas.toBlob(b => download(b, name + '.png'), 'image/png');
    } catch {
      notify('warn', 'Snapshot failed', 'The demo video URL does not allow frame capture. Use a local video file instead.');
    }
    return;
  }
  const url = camUrl(settings.camCapture);
  try {
    const res = await fetch(url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now(), { cache: 'no-store' });
    download(await res.blob(), name + '.jpg');
  } catch {
    window.open(url, '_blank');
  }
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// Demo feed render loop (~25 fps), copied to whichever canvas is visible.
let lastFrame = 0;
function frame(now) {
  requestAnimationFrame(frame);
  if (!demoCam() || now - lastFrame < 40) return;
  const live = S.route === 'live', home = S.route === 'home';
  if (!live && !home) return;
  lastFrame = now;
  DemoFeed.draw();
  const target = $(live ? '#live-canvas' : '#thumb-feed');
  target.getContext('2d').drawImage(DemoFeed.canvas, 0, 0, target.width, target.height);
  if (live) $('#live-clock').textContent = new Date().toLocaleTimeString();
}
setInterval(() => { if (S.route === 'live' && !demoCam()) $('#live-clock').textContent = new Date().toLocaleTimeString(); }, 1000);

/* ---------------- database view ---------------- */
function drawSpark(cv, data, status) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  let lo = Math.min(...data), hi = Math.max(...data);
  if (hi === lo) { hi += 1; lo -= 1; }
  const x = i => (i / (data.length - 1)) * (w - 2) + 1;
  const y = v => h - 3 - ((v - lo) / (hi - lo)) * (h - 6);
  const color = getComputedStyle(document.documentElement).getPropertyValue(status === 'crit' ? '--crit' : status === 'warn' ? '--warn' : '--accent').trim();
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.lineTo(x(data.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
}

function renderDb() {
  const groups = byGroup();
  const alertsNow = [...S.sensors.values()].filter(s => s.status !== 'ok').length;
  $('#db-summary').textContent = `${S.total.toLocaleString()} records · ${S.sensors.size} sensors in ${groups.size} groups · ${alertsNow} in alert` +
    (settings.demo ? ' · demo data' : '');
  const wrap = $('#groups');

  if (!groups.size) {
    wrap.innerHTML = `<div class="empty">No readings yet. ${settings.demo ? 'Demo data will appear in a moment.' : 'Set the ESP32 IP in <a href="#/settings"><u>Settings</u></a> or turn on demo mode.'}</div>`;
    wrap.dataset.v = '';
    return;
  }
  if (wrap.dataset.v !== String(S.version)) {
    wrap.innerHTML = [...groups].map(([g, list]) => `
      <section class="group" style="--g:${groupColor(g)}">
        <div class="group-head"><span class="dot"></span><h3>${esc(groupLabel(g))}</h3><span class="cnt">${list.length} sensor${list.length > 1 ? 's' : ''}</span></div>
        <div class="tiles">${list.map(s => `
          <div class="tile" data-key="${esc(s.key)}">
            <div class="tile-top"><span class="nm" title="${esc(s.key)}">${esc(s.name)}</span><span class="type-chip">${esc(typeLabel(s.type))}</span></div>
            <div class="val"></div>
            <canvas></canvas>
            <div class="stats"></div>
          </div>`).join('')}</div>
      </section>`).join('');
    wrap.dataset.v = String(S.version);
    fillFilters();
  }
  for (const tile of $$('.tile', wrap)) {
    const s = S.sensors.get(tile.dataset.key);
    if (!s) continue;
    tile.className = 'tile ' + s.status;
    tile.title = s.reason ? `${s.status.toUpperCase()}: ${s.reason}` : '';
    $('.val', tile).innerHTML = `${fmtVal(s.value, s.kind)}<small>${esc(s.unit)}</small>`;
    $('.stats', tile).textContent = s.kind === 'bool'
      ? `active ${Math.round((s.sum / s.n) * 100)}% · ${fmtAgo(s.ts)}`
      : `min ${fmtVal(s.min)} · avg ${fmtVal(s.sum / s.n)} · max ${fmtVal(s.max)}`;
    drawSpark($('canvas', tile), s.hist, s.status);
  }
}

function fillFilters() {
  const fg = $('#f-group'), fs = $('#f-sensor');
  const g0 = fg.value, s0 = fs.value;
  const groups = byGroup();
  fg.innerHTML = '<option value="">All groups</option>' + [...groups.keys()].map(g => `<option value="${g}">${esc(groupLabel(g))}</option>`).join('');
  fg.value = groups.has(g0) ? g0 : '';
  const list = sortedSensors().filter(s => !fg.value || s.group === fg.value);
  fs.innerHTML = '<option value="">All sensors</option>' + list.map(s => `<option value="${esc(s.key)}">${esc(s.name)}</option>`).join('');
  fs.value = list.some(s => s.key === s0) ? s0 : '';
}

const PAGE = 25;
async function loadRecords() {
  const g = $('#f-group').value, sensor = $('#f-sensor').value, onlyAlerts = $('#f-alerts').checked;
  const start = S.page * PAGE;
  const rows = [];
  let skipped = 0, more = false;
  await DB.each('readings', r => {
    if (g && r.group !== g) return;
    if (sensor && r.sensor !== sensor) return;
    if (onlyAlerts && r.status === 'ok') return;
    if (skipped < start) { skipped++; return; }
    if (rows.length < PAGE) { rows.push(r); return; }
    more = true;
    return false;
  });
  $('#rec-body').innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${esc(new Date(r.ts).toLocaleString())}</td>
      <td><span class="gtag" style="--g:${groupColor(r.group)}">${esc(groupLabel(r.group))}</span></td>
      <td>${esc(r.name)}</td>
      <td class="muted">${esc(typeLabel(r.type))}</td>
      <td class="num">${fmtVal(r.value, r.kind)} ${esc(r.unit)}</td>
      <td><span class="st ${r.status}">${r.status}</span></td>
      <td class="muted">${esc(r.source)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="muted" style="text-align:center;padding:24px">No records match.</td></tr>';
  $('#pg-info').textContent = rows.length ? `Showing ${start + 1}–${start + rows.length}` : '';
  $('#pg-prev').disabled = S.page === 0;
  $('#pg-next').disabled = !more;
}
let recTimer = 0;
function loadRecordsSoon() {
  if (recTimer) return;
  recTimer = setTimeout(() => { recTimer = 0; if (S.route === 'db') loadRecords(); }, 1500);
}

async function exportCsv() {
  const lines = ['timestamp,iso_time,group,sensor_key,sensor_name,type,value,unit,status,source'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  await DB.each('readings', r => {
    lines.push([r.ts, new Date(r.ts).toISOString(), q(groupLabel(r.group)), q(r.sensor), q(r.name), q(typeLabel(r.type)), r.value, q(r.unit), r.status, r.source].join(','));
  }, 'next');
  download(new Blob([lines.join('\n')], { type: 'text/csv' }), `sensorhub-${new Date().toISOString().slice(0, 10)}.csv`);
}

async function clearDb() {
  if (!confirm('Delete all stored readings? This cannot be undone.')) return;
  await DB.clear('readings');
  S.total = 0; S.page = 0;
  S.sensors.clear(); S.version++;
  renderDb(); loadRecords();
  notify('info', 'Database cleared', 'All stored readings were deleted.');
}

/* ---------------- settings ---------------- */
const FIELDS = ['demo', 'demoCam', 'demoPattern', 'demoVideoUrl', 'mcuIp', 'mcuPath', 'pollMs', 'ai', 'camIp', 'camStream', 'camCapture', 'notify', 'browserNotify', 'sound', 'maxRecords'];

/* ---------------- AI helper ---------------- */
function setAiStatus(msg, level = 'info') {
  const el = $('#ai-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'test-out ' + ({ ok: 'ok', error: 'bad', warn: 'bad' }[level] || '');
}
// The Gemini key is built into the site/app (js/ai-config.js), so everyone shares it.
const geminiKey = () => (typeof GEMINI_API_KEY !== 'undefined' ? String(GEMINI_API_KEY) : '').trim();

function aiSummary() {
  const n = AiAssist.count();
  if (!geminiKey()) return `Off: no Gemini key in js/ai-config.js. ${n} learned rule${n === 1 ? '' : 's'} still used.`;
  return settings.ai ? `On (${AiAssist.model}). ${n} learned rule${n === 1 ? '' : 's'} saved on this device.`
    : `Off. ${n} learned rule${n === 1 ? '' : 's'} still used.`;
}
function configureAi() {
  // Remove keys saved by older versions in browser storage
  if ('aiKey' in settings) { delete settings.aiKey; saveSettings(); }
  if ('relayUrl' in settings) { delete settings.relayUrl; saveSettings(); }
  try { localStorage.removeItem('sensorhub.geminiKey'); } catch { /* storage unavailable */ }
  AiAssist.configure({
    enabled: () => settings.ai && !!geminiKey(),
    apiKey: geminiKey,
    onStatus: (msg, level) => {
      setAiStatus(msg, level);
      if (level === 'error') notify('warn', 'AI helper', msg);
    },
    onLearned: learned => {
      S.version++;
      for (const l of learned) notify('info', 'AI learned how to read new data', l);
      if (S.route === 'settings') renderSensorTable(true);
    },
  });
}

function fillSettings() {
  for (const f of FIELDS) {
    const el = $('#s-' + f);
    if (el.type === 'checkbox') el.checked = !!settings[f]; else el.value = settings[f] ?? '';
  }
  updateVideoInfo();
  setAiStatus(aiSummary());
  renderSensorTable(true);
  renderThresholds();
}

function updateVideoInfo() {
  $('#s-demoVideoInfo').textContent = 'Now looping: ' + DemoFeed.label;
}

function applySettings(changed) {
  saveSettings();
  $('#pill-demo').hidden = !settings.demo;
  if (['demo', 'mcuIp', 'mcuPath', 'demoPattern', 'pollMs'].includes(changed)) schedulePoll(0);
  if (changed === 'ai') setAiStatus(aiSummary());
  if (['demo', 'demoCam', 'camIp', 'camStream', 'camCapture'].includes(changed)) {
    if (demoCam()) setStatus('cam', 'demo');
    else { setStatus('cam', 'idle'); refreshThumbSnap(); }
    if (S.route === 'live') startLive();
    updateSourceButton();
  }
  if (changed === 'demo' && !settings.demo) setStatus('mcu', 'idle');
  if (changed === 'demo') notify('info', settings.demo ? 'Demo mode on' : 'Demo mode off',
    settings.demo ? 'Showing simulated sensor data and a looping video.' : 'Reading from the configured ESP32 boards.');
}

function onSettingChange(e) {
  const f = e.target.id.slice(2);
  const el = e.target;
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value.trim();
  if (f === 'pollMs') v = Math.max(250, v || 2000);
  if (f === 'maxRecords') v = Math.max(1000, v || 50000);
  settings[f] = v;
  if (f === 'browserNotify' && v && 'Notification' in window && Notification.permission !== 'granted') {
    Notification.requestPermission().then(p => {
      if (p !== 'granted') { settings.browserNotify = false; el.checked = false; saveSettings(); }
    });
  }
  if (f === 'demoVideoUrl') {
    if (v) { settings.demoVideoName = ''; DB.delFile('demoVideo').catch(() => {}); DemoFeed.setVideo(v); }
    else DemoFeed.setVideo(null);
    updateVideoInfo();
  }
  applySettings(f);
}

async function onVideoFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  await DB.putFile('demoVideo', file);
  settings.demoVideoName = file.name; settings.demoVideoUrl = '';
  $('#s-demoVideoUrl').value = '';
  DemoFeed.setVideo(file, file.name);
  saveSettings(); updateVideoInfo();
  notify('info', 'Demo video set', file.name + ' will loop in the live feed.');
  e.target.value = '';
}

async function clearVideo() {
  settings.demoVideoName = ''; settings.demoVideoUrl = '';
  $('#s-demoVideoUrl').value = '';
  await DB.delFile('demoVideo').catch(() => {});
  DemoFeed.setVideo(null);
  saveSettings(); updateVideoInfo();
}

async function loadDemoVideo() {
  if (settings.demoVideoName) {
    const blob = await DB.getFile('demoVideo').catch(() => null);
    if (blob) DemoFeed.setVideo(blob, settings.demoVideoName);
  } else if (settings.demoVideoUrl) {
    DemoFeed.setVideo(settings.demoVideoUrl);
  }
}

function renderSensorTable(force) {
  const body = $('#s-sensors');
  if (!force && body.dataset.v === String(S.version)) {
    // values only
    for (const tr of $$('tr[data-key]', body)) {
      const s = S.sensors.get(tr.dataset.key);
      if (s) tr.lastElementChild.textContent = `${fmtVal(s.value, s.kind)} ${s.unit}`;
    }
    return;
  }
  body.dataset.v = String(S.version);
  const opts = Classifier.TYPES.map(t => `<option value="${t.id}">${esc(t.label)}</option>`).join('');
  const list = sortedSensors();
  body.innerHTML = list.length ? list.map(s => `
    <tr data-key="${esc(s.key)}">
      <td><code>${esc(s.key)}</code></td>
      <td>${esc(s.name)}</td>
      <td><select data-override="${esc(s.key)}"><option value="">${AiAssist.isLearnedKey(s.key) ? 'AI' : 'Auto'} (${esc(typeLabel(AiAssist.keyTypes()[s.key] || s.autoType))})</option>${opts}</select></td>
      <td><span class="gtag" style="--g:${groupColor(s.group)}">${esc(groupLabel(s.group))}</span></td>
      <td class="num">${fmtVal(s.value, s.kind)} ${esc(s.unit)}</td>
    </tr>`).join('') : '<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">No sensors detected yet.</td></tr>';
  for (const sel of $$('select[data-override]', body)) sel.value = settings.overrides[sel.dataset.override] || '';
}

function onOverride(e) {
  const sel = e.target.closest('select[data-override]');
  if (!sel) return;
  const key = sel.dataset.override;
  if (sel.value) settings.overrides[key] = sel.value; else delete settings.overrides[key];
  saveSettings();
  const s = S.sensors.get(key);
  if (s) {
    const T = Classifier.byId(sel.value || s.autoType);
    s.type = T.id; s.group = T.group;
    S.version++;
  }
  renderSensorTable(true);
  renderThresholds();
}

const CORE_TYPES = ['ultrasonic', 'vibration', 'sound', 'turbidity', 'ph'];
function renderThresholds() {
  const types = [...new Set([...CORE_TYPES, ...[...S.sensors.values()].filter(s => s.kind !== 'bool').map(s => s.type)])]
    .filter(t => !['system', 'other', 'digital'].includes(t));
  const fields = ['critLo', 'warnLo', 'warnHi', 'critHi'];
  $('#s-thresholds').innerHTML = types.map(t => {
    const th = thresholdsFor(t);
    const T = Classifier.byId(t);
    return `<tr><td>${esc(T.label)} <span class="muted">${esc(T.unit)}</span></td>${fields.map(f =>
      `<td><input type="number" step="any" data-th="${t}" data-f="${f}" value="${th[f] ?? ''}" placeholder="—"></td>`).join('')}</tr>`;
  }).join('');
}

function onThreshold(e) {
  const el = e.target;
  if (!el.dataset.th) return;
  const t = el.dataset.th;
  const cur = { ...thresholdsFor(t) };
  cur[el.dataset.f] = el.value === '' ? null : +el.value;
  settings.thresholds[t] = cur;
  saveSettings();
}

async function testMcu() {
  const out = $('#t-mcu-out');
  if (!hostOf(settings.mcuIp)) { out.innerHTML = '<span class="bad">Enter the ESP32 IP address first.</span>'; return; }
  out.textContent = 'Connecting to ' + mcuUrl() + ' …';
  try {
    const payload = await fetchPayload(mcuUrl(), 5000);
    const items = Classifier.parse(prepareText(payload), classifierOverrides());
    out.innerHTML = `<span class="ok">✓ Connected — ${items.length} reading${items.length === 1 ? '' : 's'} found</span>` +
      (items.length ? `<ul>${items.map(i => `<li><b>${esc(i.name)}</b> = ${fmtVal(i.value, i.kind)} ${esc(i.unit)} → ${esc(typeLabel(i.type))} (${esc(groupLabel(i.group))})</li>`).join('')}</ul>`
        : '<div class="muted">The board answered but no numeric values were found in the response.</div>');
  } catch (e) {
    out.innerHTML = `<span class="bad">✕ Could not reach ${esc(mcuUrl())} (${esc(e.message)}).</span>
      <div class="muted">Check the IP, that this computer is on the same Wi-Fi, and that the sketch sends the <code>Access-Control-Allow-Origin: *</code> header.</div>`;
  }
}

function testCam() {
  const out = $('#t-cam-out');
  if (!hostOf(settings.camIp)) { out.innerHTML = '<span class="bad">Enter the ESP32-CAM IP address first.</span>'; return; }
  const url = camUrl(settings.camCapture);
  out.textContent = 'Requesting snapshot from ' + url + ' …';
  const img = new Image();
  const timer = setTimeout(() => { img.src = BLANK; out.innerHTML = `<span class="bad">✕ Timed out: ${esc(url)}</span>`; }, 7000);
  img.onload = () => {
    if (img.src === BLANK) return;
    clearTimeout(timer);
    out.innerHTML = `<span class="ok">✓ Camera responded (${img.naturalWidth}×${img.naturalHeight})</span>`;
    out.appendChild(img);
  };
  img.onerror = () => { clearTimeout(timer); out.innerHTML = `<span class="bad">✕ No image from ${esc(url)}</span><div class="muted">Is the CameraWebServer sketch running? Try opening the URL in a new tab.</div>`; };
  img.src = url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();
}

/* ---------------- bindings & start ---------------- */
function bind() {
  window.addEventListener('hashchange', route);

  $('#btn-bell').onclick = e => {
    e.stopPropagation();
    const d = $('#drawer');
    d.hidden = !d.hidden;
    $('#btn-bell').classList.toggle('active', !d.hidden);
    if (!d.hidden) { S.unread = 0; updateBell(); renderAlertLists(); }
  };
  $('#drawer-close').onclick = () => { $('#drawer').hidden = true; $('#btn-bell').classList.remove('active'); };
  document.addEventListener('click', e => {
    const d = $('#drawer');
    if (!d.hidden && !d.contains(e.target)) { d.hidden = true; $('#btn-bell').classList.remove('active'); }
  });
  $$('[data-action="clear-alerts"]').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    S.alerts = []; S.unread = 0;
    await DB.clear('alerts');
    updateBell();
    $('#alert-feed').innerHTML = alertItems([]);
    $('#alert-drawer').innerHTML = alertItems([]);
  });

  const img = $('#live-img');
  img.addEventListener('load', onLiveLoad);
  img.addEventListener('error', onLiveError);
  $('#btn-retry').onclick = startLive;
  $('#btn-source').onclick = toggleSource;
  $('#btn-snapshot').onclick = snapshot;
  $('#btn-fullscreen').onclick = () => {
    const p = $('#player');
    document.fullscreenElement ? document.exitFullscreen() : p.requestFullscreen?.();
  };
  $('#btn-overlay').onclick = () => {
    settings.overlay = !settings.overlay; saveSettings();
    $('#btn-overlay').textContent = 'Sensor overlay: ' + (settings.overlay ? 'On' : 'Off');
    renderLive();
  };

  $('#btn-export').onclick = exportCsv;
  $('#btn-cleardb').onclick = clearDb;
  $('#f-group').onchange = () => { S.page = 0; fillFilters(); loadRecords(); };
  $('#f-sensor').onchange = () => { S.page = 0; loadRecords(); };
  $('#f-alerts').onchange = () => { S.page = 0; loadRecords(); };
  $('#pg-prev').onclick = () => { S.page = Math.max(0, S.page - 1); loadRecords(); };
  $('#pg-next').onclick = () => { S.page++; loadRecords(); };

  for (const f of FIELDS) $('#s-' + f).addEventListener('change', onSettingChange);
  $('#s-demoFile').addEventListener('change', onVideoFile);
  $('#s-demoVideoClear').onclick = clearVideo;
  $('#s-sensors').addEventListener('change', onOverride);
  $('#s-thresholds').addEventListener('change', onThreshold);
  $('#s-thReset').onclick = () => { settings.thresholds = {}; saveSettings(); renderThresholds(); };
  $('#t-mcu').onclick = testMcu;
  $('#ai-forget').onclick = () => {
    if (!confirm('Forget everything the AI helper learned on this device? Unknown data will be sent to Gemini again.')) return;
    AiAssist.forget();
    S.version++;
    setAiStatus(aiSummary());
    renderSensorTable(true);
  };
  $('#t-cam').onclick = testCam;

  window.addEventListener('resize', () => { if (S.route === 'db') { $('#groups').dataset.v = ''; renderDb(); } });
}

async function init() {
  await DB.open();
  S.total = await DB.count('readings');
  await seedFromDb();
  await loadAlerts();
  await loadDemoVideo();
  configureAi();
  bind();
  $('#pill-demo').hidden = !settings.demo;
  updateBell();
  route();
  requestAnimationFrame(frame);
  poll();
  setInterval(camHealth, 5000);
  camHealth();
  setInterval(() => { if (S.route === 'home') $$('#alert-feed time').forEach(t => { t.textContent = fmtAgo(+t.dataset.ts); }); }, 15000);
}

init().catch(err => {
  console.error(err);
  document.querySelector('main').innerHTML = `<div class="empty">Could not start: ${esc(err.message)}</div>`;
});
