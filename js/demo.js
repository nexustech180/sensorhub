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

/* Looping camera feed for demo mode: a user video if configured, else a generated underwater scene. */
const DemoFeed = (() => {
  const W = 640, H = 360;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  let video = null, objectUrl = null, turbidity = 3, label = 'Built-in simulated feed';
  const t0 = performance.now();

  const fish = Array.from({ length: 5 }, (_, i) => ({
    y: 90 + i * 45 + Math.random() * 20, speed: 30 + Math.random() * 40, size: 10 + Math.random() * 12,
    offset: Math.random() * 900, dir: i % 2 ? -1 : 1, hue: [28, 45, 200, 350, 15][i],
  }));
  const bubbles = Array.from({ length: 26 }, () => ({ x: Math.random() * W, y: Math.random() * H, r: 1 + Math.random() * 3, s: 15 + Math.random() * 30 }));
  const weeds = Array.from({ length: 9 }, (_, i) => ({ x: 30 + i * 72 + Math.random() * 30, h: 70 + Math.random() * 90, hue: 110 + Math.random() * 40 }));

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

  function scene(t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0e5a6e'); g.addColorStop(0.55, '#0a3947'); g.addColorStop(1, '#05161c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    // light rays
    for (let i = 0; i < 5; i++) {
      const x = 60 + i * 140 + Math.sin(t * 0.3 + i) * 30;
      ctx.fillStyle = 'rgba(190,240,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 50, 0); ctx.lineTo(x + 140, H); ctx.lineTo(x + 40, H); ctx.fill();
    }

    // sand
    ctx.fillStyle = '#4a3f28';
    ctx.beginPath(); ctx.moveTo(0, H);
    for (let x = 0; x <= W; x += 20) ctx.lineTo(x, H - 38 - Math.sin(x * 0.02) * 8);
    ctx.lineTo(W, H); ctx.fill();

    // weeds
    ctx.lineWidth = 5; ctx.lineCap = 'round';
    for (const w of weeds) {
      const sway = Math.sin(t * 1.2 + w.x) * 14;
      ctx.strokeStyle = `hsl(${w.hue} 45% 30%)`;
      ctx.beginPath(); ctx.moveTo(w.x, H - 34);
      ctx.quadraticCurveTo(w.x + sway, H - 34 - w.h / 2, w.x + sway * 1.6, H - 34 - w.h); ctx.stroke();
    }

    // fish
    for (const f of fish) {
      const span = W + 120;
      let x = ((t * f.speed + f.offset) % span) - 60;
      if (f.dir < 0) x = W - x;
      const y = f.y + Math.sin(t * 1.5 + f.offset) * 8;
      ctx.save(); ctx.translate(x, y); ctx.scale(f.dir, 1);
      ctx.fillStyle = `hsl(${f.hue} 85% 58%)`;
      ctx.beginPath(); ctx.ellipse(0, 0, f.size * 1.6, f.size * 0.8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-f.size * 1.4, 0); ctx.lineTo(-f.size * 2.4, -f.size * 0.7); ctx.lineTo(-f.size * 2.4, f.size * 0.7); ctx.fill();
      ctx.fillStyle = '#021'; ctx.beginPath(); ctx.arc(f.size * 0.9, -f.size * 0.2, f.size * 0.14, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    // bubbles
    ctx.strokeStyle = 'rgba(220,250,255,0.55)'; ctx.lineWidth = 1;
    for (const b of bubbles) {
      const y = (b.y - t * b.s) % H;
      const yy = y < 0 ? y + H : y;
      ctx.beginPath(); ctx.arc(b.x + Math.sin(t * 2 + b.y) * 3, yy, b.r, 0, Math.PI * 2); ctx.stroke();
    }

    // murky water when turbidity is high (linked to the demo sensor)
    const haze = Math.min(0.75, Math.max(0, (turbidity - 2) / 90));
    if (haze > 0.01) { ctx.fillStyle = `rgba(110,90,50,${haze})`; ctx.fillRect(0, 0, W, H); }
  }

  function grain() {
    for (let i = 0; i < 140; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
      ctx.fillRect(Math.random() * W, Math.random() * H, 2, 2);
    }
    const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.65);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)');
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
    ctx.font = '600 13px ui-monospace, Consolas, monospace';
    ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(10, H - 32, 270, 22);
    ctx.fillStyle = '#fff'; ctx.fillText('CAM-01  ' + new Date().toLocaleString(), 16, H - 16);
    ctx.fillStyle = 'rgba(245,158,11,0.9)'; ctx.fillText('DEMO', W - 52, H - 16);
  }

  return {
    canvas, draw, setVideo,
    setTurbidity: v => { turbidity = v; },
    get label() { return label; },
  };
})();
