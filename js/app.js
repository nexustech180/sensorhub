'use strict';
/* Gold Var Sensor Hub, basic version: live sensor readings and the camera picture. */

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/* ---------------- settings (same storage key as the full app, so values carry over) ---------------- */
const KEY_SETTINGS = 'sensorhub.settings';
const DEFAULTS = {
  demo: true, mcuIp: '', mcuPath: '/data', pollMs: 2000,
  camIp: '', camStream: 'http://{ip}:81/stream', camCapture: 'http://{ip}/capture',
};
let stored = {};
try { stored = JSON.parse(localStorage.getItem(KEY_SETTINGS)) || {}; } catch { /* storage unavailable */ }
const settings = { ...DEFAULTS, ...stored };
function saveSettings() {
  try { localStorage.setItem(KEY_SETTINGS, JSON.stringify({ ...stored, ...settings })); } catch { /* storage unavailable */ }
}

const hostOf = ip => String(ip || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
function mcuUrl() {
  let p = String(settings.mcuPath || '/data').trim();
  if (!p.startsWith('/')) p = '/' + p;
  return `http://${hostOf(settings.mcuIp)}${p}`;
}
const camUrl = tpl => String(tpl || '').replace(/\{ip\}/g, hostOf(settings.camIp));
const fresh = url => url + (url.includes('?') ? '&' : '?') + '_t=' + Date.now();

function fmtVal(v, kind) {
  if (kind === 'bool') return v ? 'ON' : 'OFF';
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 1000 ? Math.round(v).toLocaleString() : String(Number(v.toFixed(a >= 100 ? 1 : 2)));
}

/* ---------------- sensor readings ---------------- */
const sensors = new Map();   // key → { name, group, unit, kind, value, status, reason }
let pollTimer;

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

// The WiFi gateway sends plain "name=value" lines (newest first); JSON is read as is.
function readText(payload) {
  if (typeof payload !== 'string') return payload;
  try { return JSON.parse(payload); } catch { /* not JSON */ }
  const merged = {};
  for (const line of payload.split(/\r?\n/)) {
    for (const [k, v] of Object.entries(Classifier.parseText(line.trim()))) if (!(k in merged)) merged[k] = v;
  }
  return merged;
}

function ingest(payload) {
  for (const it of Classifier.parse(readText(payload))) {
    // A status reported by the device itself (the Mega's WARNING/DANGER) wins over the built-in limits
    const { status, reason } = it.devStatus
      ? { status: it.devStatus, reason: 'reported by device' }
      : Classifier.evaluate(it, Classifier.byId(it.type).th || {});
    sensors.set(it.key, { name: it.name, group: it.group, unit: it.unit, kind: it.kind, value: it.value, status, reason });
    if (settings.demo && it.type === 'turbidity') DemoFeed.setTurbidity(it.value);
  }
  renderReadings();
}

function renderReadings() {
  const order = Classifier.GROUP_ORDER;
  const list = [...sensors.values()].sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || a.name.localeCompare(b.name));
  const label = { ok: 'OK', warn: 'WARNING', crit: 'ALARM' };
  $('#readings').innerHTML = list.length
    ? list.map(s => `<tr class="${s.status}"><td>${esc(s.name)}</td><td>${fmtVal(s.value, s.kind)} ${esc(s.unit)}</td>` +
        `<td title="${esc(s.reason)}">${label[s.status] || 'OK'}</td></tr>`).join('')
    : '<tr><td colspan="3">Waiting for data…</td></tr>';
}

async function poll() {
  clearTimeout(pollTimer);
  const status = $('#mcu-status');
  try {
    if (settings.demo) {
      status.textContent = 'Demo mode: simulated readings.';
      ingest(Demo.next('random'));
    } else if (!hostOf(settings.mcuIp)) {
      status.textContent = 'Enter the sensor board IP in Settings below.';
    } else {
      try {
        ingest(await fetchPayload(mcuUrl()));
        status.textContent = `Connected to ${mcuUrl()}.`;
      } catch (e) {
        status.textContent = `Sensor board not reachable (${mcuUrl()}: ${e.message}). Retrying…`;
      }
    }
  } catch (e) {
    console.error(e);
  }
  pollTimer = setTimeout(poll, Math.max(250, +settings.pollMs || 2000));
}

/* ---------------- camera ---------------- */
// Real camera: the MJPEG stream; if no frame arrives within 5 s (the ESP32-CAM serves one viewer
// at a time), fall back to refreshing snapshots. Demo: the built-in simulated feed.
let camTimer, demoFrame;
function camMessage(text) {
  const m = $('#cam-msg');
  m.hidden = !text;
  m.textContent = text || '';
}
function startCamera() {
  clearTimeout(camTimer);
  cancelAnimationFrame(demoFrame);
  const img = $('#cam-img'), cv = $('#cam-canvas');
  img.onload = img.onerror = null;
  img.src = BLANK;
  img.hidden = true; cv.hidden = true; camMessage('');

  if (settings.demo) {
    cv.hidden = false;
    $('#cam-status').textContent = 'Demo mode: simulated camera.';
    const ctx = cv.getContext('2d');
    let last = 0;
    const draw = now => {
      demoFrame = requestAnimationFrame(draw);
      if (now - last < 40) return;
      last = now;
      DemoFeed.draw();
      ctx.drawImage(DemoFeed.canvas, 0, 0, cv.width, cv.height);
    };
    demoFrame = requestAnimationFrame(draw);
    return;
  }
  if (!hostOf(settings.camIp)) {
    $('#cam-status').textContent = 'Enter the camera IP in Settings below.';
    return;
  }

  const stream = camUrl(settings.camStream);
  $('#cam-status').textContent = `Camera: ${stream}`;
  img.hidden = false;
  img.onload = () => { if (img.src !== BLANK) camMessage(''); };
  img.onerror = () => startSnapshots();
  img.src = stream;
  camTimer = setTimeout(() => { if (!(img.naturalWidth > 1)) startSnapshots(); }, 5000);
}
function startSnapshots() {
  clearTimeout(camTimer);
  const img = $('#cam-img');
  img.onload = img.onerror = null;
  img.src = BLANK;   // close the stream connection
  const url = camUrl(settings.camCapture);
  $('#cam-status').textContent = `Camera (snapshots): ${url}`;
  let fails = 0;
  const tick = () => {
    if (settings.demo) return;
    const probe = new Image();
    probe.onload = () => { fails = 0; img.src = probe.src; img.hidden = false; camMessage(''); camTimer = setTimeout(tick, 150); };
    probe.onerror = () => {
      if (++fails >= 3) { img.hidden = true; camMessage(`Camera not reachable (${url}). Retrying every 5 seconds…`); }
      camTimer = setTimeout(tick, fails >= 3 ? 5000 : 500);
    };
    probe.src = fresh(url);
  };
  tick();
}

/* ---------------- settings form ---------------- */
function bindSettings() {
  $('#s-demo').checked = !!settings.demo;
  $('#s-mcuIp').value = settings.mcuIp || '';
  $('#s-camIp').value = settings.camIp || '';
  $('#s-demo').addEventListener('change', e => {
    settings.demo = e.target.checked;
    sensors.clear(); renderReadings();
    saveSettings(); poll(); startCamera();
  });
  $('#s-mcuIp').addEventListener('change', e => { settings.mcuIp = e.target.value.trim(); saveSettings(); sensors.clear(); renderReadings(); poll(); });
  $('#s-camIp').addEventListener('change', e => { settings.camIp = e.target.value.trim(); saveSettings(); startCamera(); });
}

bindSettings();
poll();
startCamera();
