'use strict';
/* Demo mode: simulated ESP32 sensor payloads and a looping camera feed. */

const Demo = (() => {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
  const r = (v, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
  const started = Date.now();
  const st = { dist: 140, vib: 4, snd: 46, turb: 3, ph: 7.2, phDrift: 0, rssi: -58 };

  // Random walk that stays realistic but occasionally crosses alert thresholds.
  function random() {
    st.dist = clamp(st.dist + gauss() * 14 + (140 - st.dist) * 0.04, 3, 390);
    if (Math.random() < 0.025) st.dist = 4 + Math.random() * 12;            // something close to the sensor

    st.vib = Math.random() < 0.04 ? 55 + Math.random() * 45 : clamp(st.vib * 0.55 + Math.random() * 7, 0, 100);

    st.snd = clamp(st.snd + gauss() * 3 + (46 - st.snd) * 0.12, 32, 98);
    if (Math.random() < 0.03) st.snd = 76 + Math.random() * 18;              // loud event

    st.turb = clamp(st.turb + gauss() * 0.6 + (3 - st.turb) * 0.08, 0.2, 400);
    if (Math.random() < 0.02) st.turb += 15 + Math.random() * 60;            // muddy water event

    st.phDrift = clamp(st.phDrift + gauss() * 0.05, -2, 2);
    if (Math.random() < 0.015) st.phDrift += (Math.random() < 0.5 ? -1 : 1) * (1 + Math.random());
    st.phDrift *= 0.96;
    st.ph = clamp(7.2 + st.phDrift + gauss() * 0.04, 0, 14);

    st.rssi = clamp(st.rssi + gauss() * 1.5, -85, -40);

    return {
      device: 'esp32-demo',
      ultrasonic_cm: r(st.dist),
      vibration: r(st.vib),
      sound_db: r(st.snd),
      turbidity_ntu: r(st.turb, 2),
      ph: r(st.ph, 2),
      wifi_rssi: Math.round(st.rssi),
      uptime_s: Math.round((Date.now() - started) / 1000),
    };
  }

  // Pre-coded scenario: normal → object approaches → shaking + noise → dirty water → acid → recovery.
  const SCRIPT = [
    [150, 3, 42, 2.1, 7.1], [148, 4, 44, 2.3, 7.1], [120, 5, 45, 2.2, 7.2], [80, 4, 47, 2.4, 7.2],
    [40, 6, 52, 2.4, 7.2], [14, 8, 58, 2.5, 7.1], [4, 9, 61, 2.6, 7.1], [35, 22, 66, 2.8, 7.1],
    [90, 68, 78, 3.0, 7.0], [110, 92, 93, 3.4, 7.0], [130, 40, 70, 6.5, 6.9], [140, 12, 52, 14.8, 6.8],
    [145, 6, 47, 38.0, 6.4], [148, 5, 46, 72.0, 6.1], [150, 4, 45, 55.0, 5.4], [150, 4, 44, 24.0, 6.0],
    [150, 3, 43, 9.0, 6.7], [150, 3, 43, 4.2, 7.0], [150, 3, 42, 2.4, 7.1], [150, 3, 42, 2.2, 7.1],
  ];
  let step = 0;
  const HOLD = 2; // polls per scripted frame
  function scripted() {
    const [d, v, s, t, p] = SCRIPT[Math.floor(step / HOLD) % SCRIPT.length];
    step++;
    return {
      device: 'esp32-demo',
      ultrasonic_cm: d, vibration: v, sound_db: s, turbidity_ntu: t, ph: p,
      wifi_rssi: -60, uptime_s: Math.round((Date.now() - started) / 1000),
    };
  }

  return { next: pattern => (pattern === 'scripted' ? scripted() : random()) };
})();

/* Looping camera feed for demo mode: a user video if configured, else a generated night-vision riverbank scene. */
const DemoFeed = (() => {
  const W = 640, H = 360;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  let video = null, objectUrl = null, turbidity = 3, label = 'Built-in simulated feed';
  const t0 = performance.now();

  // Night-vision (IR, greyscale) view of a riverbank site, as a fixed surveillance camera sees it.
  // Seeded so the scenery is the same on every start.
  let seed = 20261125;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const HORIZON = 172, RIVER_TOP = 196, RIVER_BOT = 262;
  const hills = Array.from({ length: 17 }, (_, i) => ({ x: i * 40, y: HORIZON - 14 - rnd() * 22 }));
  const trees = Array.from({ length: 120 }, (_, i) => ({ x: i * 5.6 + rnd() * 5, h: 10 + rnd() * 26, w: 5 + rnd() * 9 }));
  const ripples = Array.from({ length: 46 }, () => ({ x: rnd() * W, y: RIVER_TOP + 6 + rnd() * (RIVER_BOT - RIVER_TOP - 22), l: 14 + rnd() * 50, s: 5 + rnd() * 9 }));
  const grass = Array.from({ length: 260 }, () => ({ x: rnd() * W, y: RIVER_BOT + 10 + rnd() * (H - RIVER_BOT - 10), h: 3 + rnd() * 10 }));
  const rocks = Array.from({ length: 7 }, () => ({ x: rnd() * W, y: RIVER_BOT + 10 + rnd() * 14, r: 3 + rnd() * 6 }));

  function setVideo(src, name) {
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    video = null;
    label = 'Built-in simulated feed';
    if (!src) return;
    if (src instanceof Blob) { objectUrl = URL.createObjectURL(src); src = objectUrl; }
    video = document.createElement('video');
    video.muted = true; video.loop = true; video.playsInline = true;
    video.src = src;
    video.play().catch(() => {});
    label = name || src;
  }

  // A person walks along the track for ~16 s of every 50 s cycle (something for the camera to "see").
  function walker(t) {
    const cycle = 50, walk = 16, p = (t % cycle) / walk;
    if (p > 1) return;
    const x = -20 + p * (W + 40), y = 318, step = Math.sin(t * 7);
    ctx.fillStyle = '#b9bec2'; ctx.strokeStyle = '#b9bec2'; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(x, y - 33, 4, 0, Math.PI * 2); ctx.fill();          // head
    ctx.fillRect(x - 4, y - 28, 8, 16);                                          // body
    ctx.beginPath(); ctx.moveTo(x, y - 13); ctx.lineTo(x + step * 5, y);         // legs
    ctx.moveTo(x, y - 13); ctx.lineTo(x - step * 5, y);
    ctx.moveTo(x, y - 25); ctx.lineTo(x - step * 4, y - 15); ctx.stroke();       // arm
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x - 7, y, 14, 2);          // shadow
  }

  function scene(t) {
    // sky
    let g = ctx.createLinearGradient(0, 0, 0, HORIZON);
    g.addColorStop(0, '#2c3033'); g.addColorStop(1, '#4b5154');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, HORIZON + 2);

    // far hills and tree line
    ctx.fillStyle = '#303537';
    ctx.beginPath(); ctx.moveTo(0, HORIZON + 4);
    for (const h of hills) ctx.lineTo(h.x, h.y);
    ctx.lineTo(W, HORIZON + 4); ctx.fill();
    ctx.fillStyle = '#1d2123';
    for (const tr of trees) {
      ctx.beginPath(); ctx.ellipse(tr.x, HORIZON + 6 - tr.h / 2, tr.w, tr.h / 2 + 3, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillRect(0, HORIZON + 2, W, RIVER_TOP - HORIZON);

    // river; it turns lighter and muddier as the demo turbidity sensor rises
    const mud = Math.min(1, Math.max(0, (turbidity - 2) / 60));
    const mix = (a, b) => Math.round(a + (b - a) * mud);
    g = ctx.createLinearGradient(0, RIVER_TOP, 0, RIVER_BOT);
    g.addColorStop(0, `rgb(${mix(88, 128)},${mix(95, 118)},${mix(98, 100)})`);
    g.addColorStop(1, `rgb(${mix(58, 104)},${mix(64, 96)},${mix(67, 80)})`);
    ctx.fillStyle = g; ctx.fillRect(0, RIVER_TOP, W, RIVER_BOT - RIVER_TOP);
    ctx.lineWidth = 1;
    for (const r of ripples) {
      const x = ((r.x + t * r.s) % (W + r.l)) - r.l;
      ctx.strokeStyle = `rgba(215,222,226,${0.10 + 0.12 * (1 - mud)})`;
      ctx.beginPath(); ctx.moveTo(x, r.y); ctx.lineTo(x + r.l, r.y + Math.sin(t + r.x) * 0.6); ctx.stroke();
    }

    // near bank with a dirt track
    g = ctx.createLinearGradient(0, RIVER_BOT, 0, H);
    g.addColorStop(0, '#2b2f31'); g.addColorStop(1, '#1a1d1e');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.moveTo(0, RIVER_BOT);
    for (let x = 0; x <= W; x += 8) ctx.lineTo(x, RIVER_BOT - 2 + Math.sin(x * 0.012) * 3);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.fill();
    ctx.fillStyle = '#3d4244';
    ctx.beginPath(); ctx.moveTo(0, 312);
    ctx.bezierCurveTo(W * 0.3, 300, W * 0.6, 326, W, 310); ctx.lineTo(W, 330);
    ctx.bezierCurveTo(W * 0.6, 344, W * 0.3, 318, 0, 330); ctx.fill();
    ctx.fillStyle = '#3a3f42';
    for (const k of rocks) { ctx.beginPath(); ctx.ellipse(k.x, k.y, k.r * 1.4, k.r, 0, 0, Math.PI * 2); ctx.fill(); }
    ctx.strokeStyle = '#41474a'; ctx.lineWidth = 1;
    for (const b of grass) {
      const sway = Math.sin(t * 1.3 + b.x * 0.05) * 1.5;
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x + sway, b.y - b.h); ctx.stroke();
    }
    walker(t);
  }

  // sensor noise, slight vignette and scan lines, as on a real low-light camera
  function grain() {
    for (let i = 0; i < 900; i++) {
      const v = Math.random() * 255 | 0;
      ctx.fillStyle = `rgba(${v},${v},${v},0.06)`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.06)';
    for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.7);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  function draw() {
    const t = (performance.now() - t0) / 1000;
    if (video && video.readyState >= 2 && video.videoWidth) {
      const s = Math.max(W / video.videoWidth, H / video.videoHeight);
      const w = video.videoWidth * s, h = video.videoHeight * s;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
    } else {
      scene(t);
    }
    grain();
    // on-screen display, like an NVR: camera name and timestamp burned into the picture
    const d = new Date(), p = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    ctx.font = '600 12px ui-monospace, Consolas, monospace';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.fillStyle = '#eef0f2';
    for (const [txt, x] of [['CAM-01 RIVERBANK', 12], [stamp, 12]]) {
      const y = txt === stamp ? H - 12 : H - 28;
      ctx.strokeText(txt, x, y); ctx.fillText(txt, x, y);
    }
    ctx.fillStyle = '#d8a33a'; ctx.strokeText('SIMULATED', W - 86, H - 12); ctx.fillText('SIMULATED', W - 86, H - 12);
  }

  return {
    canvas, draw, setVideo,
    setTurbidity: v => { turbidity = v; },
    get label() { return label; },
  };
})();
