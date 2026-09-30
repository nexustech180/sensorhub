'use strict';
/*
 * Smart sensor classifier.
 * Takes whatever the ESP32 sends (flat JSON, nested JSON, arrays of {name,value,unit}
 * objects, or plain "key: value" text) and turns it into typed, grouped readings.
 * Classification order: manual override → strong key match → unit → weak key match
 * → value shape (boolean → digital) → unclassified.
 */
const Classifier = (() => {
  const GROUPS = {
    water:       { label: 'Water Quality',       color: '#22d3ee' },
    proximity:   { label: 'Proximity & Motion',  color: '#a78bfa' },
    acoustic:    { label: 'Sound & Vibration',   color: '#f472b6' },
    environment: { label: 'Environment',         color: '#34d399' },
    power:       { label: 'Power',               color: '#fbbf24' },
    biometric:   { label: 'Biometric',           color: '#fb7185' },
    location:    { label: 'Location',            color: '#60a5fa' },
    digital:     { label: 'Digital I/O',         color: '#94a3b8' },
    system:      { label: 'Device / System',     color: '#64748b' },
    other:       { label: 'Unclassified',        color: '#a8a29e' },
  };
  const GROUP_ORDER = Object.keys(GROUPS);

  // Keys are matched against normalised snake_case names. Order matters within a pass.
  const TYPES = [
    { id: 'ph', label: 'pH', group: 'water', unit: 'pH',
      keys: [/(^|_)ph(_|$)/, /acidi/, /alkalin/], units: ['ph'],
      th: { critLo: 5.5, warnLo: 6.5, warnHi: 8.5, critHi: 9.5 } },
    { id: 'turbidity', label: 'Turbidity', group: 'water', unit: 'NTU',
      keys: [/turb/, /(^|_)ntu(_|$)/, /clarity/, /cloudi/], units: ['ntu'],
      th: { warnHi: 10, critHi: 50 } },
    { id: 'tds', label: 'TDS / Conductivity', group: 'water', unit: 'ppm',
      keys: [/(^|_)tds/, /conductiv/, /(^|_)ec(_|$)/, /salinit/], units: ['us/cm', 'ms/cm', 'µs/cm'],
      th: { warnHi: 500, critHi: 1000 } },
    { id: 'dissolved_oxygen', label: 'Dissolved Oxygen', group: 'water', unit: 'mg/L',
      keys: [/dissolved/, /(^|_)d_?o2?(_|$)/], weak: [/oxygen/], units: ['mg/l'],
      th: { critLo: 3, warnLo: 5 } },
    { id: 'orp', label: 'ORP / Redox', group: 'water', unit: 'mV', keys: [/(^|_)orp/, /redox/] },
    { id: 'water_level', label: 'Water Level', group: 'water', unit: '%',
      keys: [/water_?level/, /tank_?level/, /liquid_?level/], weak: [/tank/, /float/, /^level$/],
      th: { critLo: 10, warnLo: 20 } },
    { id: 'flow', label: 'Flow', group: 'water', unit: 'L/min',
      keys: [/flow/, /(^|_)lpm(_|$)/], units: ['l/min', 'lpm', 'l/h'] },

    { id: 'ultrasonic', label: 'Ultrasonic / Distance', group: 'proximity', unit: 'cm',
      keys: [/ultra_?sonic/, /sonar/, /hc_?sr_?0?4/, /dist/, /proximit/, /lidar/, /(^|_)tof(_|$)/, /jsn_?sr/],
      weak: [/range/, /echo/, /(^|_)us(_|$)/], units: ['cm', 'mm', 'in'],
      th: { critLo: 5, warnLo: 15 } },
    { id: 'motion', label: 'Motion / PIR', group: 'proximity', unit: '',
      keys: [/(^|_)pir/, /motion/, /presence/, /occupan/, /intrud/], boolAlert: 'warn' },
    { id: 'accel', label: 'Accelerometer', group: 'proximity', unit: 'g',
      keys: [/accel/, /(^|_)acc_?[xyz]?(_|$)/, /g_?force/, /(^|_)mpu/, /adxl/], weak: [/(^|_)a[xyz](_|$)/, /tilt/],
      units: ['g', 'm/s2', 'm/s²'] },
    { id: 'gyro', label: 'Gyroscope', group: 'proximity', unit: '°/s',
      keys: [/gyro/, /(^|_)yaw/, /(^|_)pitch/, /(^|_)roll(_|$)/], weak: [/(^|_)g[xyz](_|$)/, /rotation/],
      units: ['°/s', 'dps', 'rad/s'] },

    { id: 'vibration', label: 'Vibration', group: 'acoustic', unit: '%',
      keys: [/vib/, /shock/, /sw_?420/, /knock/, /tremor/, /seism/, /piezo/],
      th: { warnHi: 60, critHi: 85 }, boolAlert: 'warn' },
    { id: 'sound', label: 'Sound', group: 'acoustic', unit: 'dB',
      keys: [/sound/, /noise/, /(^|_)mic(_|$|rophone)/, /audio/, /(^|_)db(_|$)/, /decibel/, /acoust/, /(^|_)spl(_|$)/, /ky_?03[78]/, /max4466/],
      units: ['db', 'dba'], th: { warnHi: 75, critHi: 90 } },

    { id: 'flame', label: 'Flame', group: 'environment', unit: '', keys: [/flame/, /fire/], boolAlert: 'crit' },
    { id: 'rain', label: 'Rain', group: 'environment', unit: '', keys: [/rain/, /precip/], boolAlert: 'warn' },
    { id: 'soil', label: 'Soil Moisture', group: 'environment', unit: '%', keys: [/soil/, /moist/], th: { warnLo: 20 } },
    { id: 'humidity', label: 'Humidity', group: 'environment', unit: '%RH',
      keys: [/humid/, /(^|_)rh(_|$)/], weak: [/(^|_)hum(_|$)/], units: ['%rh', 'rh'],
      th: { warnLo: 20, warnHi: 85 } },
    { id: 'temperature', label: 'Temperature', group: 'environment', unit: '°C',
      keys: [/temp/, /celsius/, /fahrenheit/, /ds18b20/, /thermo/, /lm35/, /ntc/], weak: [/(^|_)t(_|$)/],
      units: ['c', '°c', 'f', '°f', 'degc', 'degf'], th: { warnLo: 0, warnHi: 40, critHi: 55 } },
    { id: 'pressure', label: 'Pressure', group: 'environment', unit: 'hPa',
      keys: [/press/, /baro/, /(^|_)hpa/, /(^|_)bmp\d*/], units: ['hpa', 'pa', 'kpa', 'bar', 'mbar', 'psi'] },
    { id: 'gas', label: 'Gas / Air Quality', group: 'environment', unit: 'ppm',
      keys: [/gas/, /(^|_)mq_?\d+/, /co2/, /smoke/, /voc/, /air_?qual/, /(^|_)aqi/, /lpg/, /methane/, /ammonia/, /pm2_?5/, /pm10/],
      weak: [/(^|_)co(_|$)/, /(^|_)pm(_|$)/], units: ['ppm', 'ppb', 'ug/m3', 'µg/m³'],
      th: { warnHi: 400, critHi: 1000 } },
    { id: 'light', label: 'Light', group: 'environment', unit: 'lux',
      keys: [/light/, /(^|_)lux/, /(^|_)ldr/, /bh1750/, /illum/, /(^|_)uv/], weak: [/photo/, /bright/],
      units: ['lux', 'lx'] },

    { id: 'battery', label: 'Battery', group: 'power', unit: '%', keys: [/batt/], th: { critLo: 10, warnLo: 20 } },
    { id: 'voltage', label: 'Voltage', group: 'power', unit: 'V',
      keys: [/volt/, /(^|_)vin(_|$)/, /vbat/, /(^|_)vcc/], weak: [/(^|_)v(_|$)/], units: ['v', 'mv'] },
    { id: 'current', label: 'Current', group: 'power', unit: 'A',
      keys: [/current/, /(^|_)amps?(_|$)/, /acs712/, /ina219/], weak: [/(^|_)i(_|$)/, /(^|_)ma(_|$)/], units: ['a', 'ma'] },
    { id: 'power', label: 'Power / Energy', group: 'power', unit: 'W',
      keys: [/power/, /watt/, /kwh/, /energy/], weak: [/(^|_)w(_|$)/], units: ['w', 'kw', 'kwh', 'wh'] },

    { id: 'heart', label: 'Heart Rate / SpO₂', group: 'biometric', unit: 'bpm',
      keys: [/heart/, /(^|_)bpm/, /pulse/, /spo2/, /oxim/, /max3010/], weak: [/(^|_)hr(_|$)/], units: ['bpm'] },
    { id: 'gps', label: 'GPS', group: 'location', unit: '',
      keys: [/(^|_)lat(itude)?(_|$)/, /(^|_)lon(gitude)?(_|$)/, /(^|_)lng(_|$)/, /gps/, /altitude/, /satellit/],
      weak: [/speed/, /heading/, /course/, /(^|_)alt(_|$)/] },

    { id: 'touch', label: 'Touch / Button', group: 'digital', unit: '', keys: [/touch/, /button/, /(^|_)btn/], weak: [/switch/] },
    { id: 'magnetic', label: 'Magnetic / Hall', group: 'digital', unit: '', keys: [/hall/, /magnet/, /reed/], weak: [/door/] },
    { id: 'relay', label: 'Relay / Output', group: 'digital', unit: '', keys: [/relay/, /(^|_)led(_|$)/, /buzzer/, /pump/, /valve/, /(^|_)fan(_|$)/] },

    { id: 'system', label: 'Device Stats', group: 'system', unit: '',
      keys: [/rssi/, /uptime/, /heap/, /(^|_)mem/, /wifi/, /millis/, /(^|_)cpu/, /free_?ram/], weak: [/signal/], units: ['dbm'] },

    { id: 'digital', label: 'Digital Input', group: 'digital', unit: '', keys: [] },
    { id: 'other', label: 'Unclassified', group: 'other', unit: '', keys: [] },
  ];
  const BY_ID = Object.fromEntries(TYPES.map(t => [t.id, t]));
  const byId = id => BY_ID[id] || BY_ID.other;

  // Key suffixes that are really units (e.g. "distance_cm", "tempC").
  const SUFFIX_UNITS = {
    cm: 'cm', mm: 'mm', in: 'in', db: 'dB', dba: 'dBA', ntu: 'NTU', c: '°C', f: '°F', pct: '%', percent: '%',
    lux: 'lux', ppm: 'ppm', ppb: 'ppb', hpa: 'hPa', kpa: 'kPa', pa: 'Pa', v: 'V', mv: 'mV', a: 'A', ma: 'mA',
    w: 'W', kw: 'kW', kwh: 'kWh', bpm: 'bpm', s: 's', ms: 'ms', dbm: 'dBm', rh: '%RH', lpm: 'L/min',
  };
  const PRETTY_UNIT = { c: '°C', '°c': '°C', degc: '°C', f: '°F', '°f': '°F', degf: '°F', db: 'dB', ntu: 'NTU',
    hpa: 'hPa', ph: 'pH', ppm: 'ppm', lux: 'lux', v: 'V', mv: 'mV', a: 'A', ma: 'mA', w: 'W', bpm: 'bpm',
    '%': '%', '%rh': '%RH', dbm: 'dBm', cm: 'cm', mm: 'mm' };
  const SPECIAL_WORDS = { ph: 'pH', tds: 'TDS', co2: 'CO₂', rssi: 'RSSI', pir: 'PIR', ntu: 'NTU', ldr: 'LDR',
    uv: 'UV', orp: 'ORP', voc: 'VOC', tvoc: 'TVOC', aqi: 'AQI', gps: 'GPS', spo2: 'SpO₂', pm25: 'PM2.5', rh: 'RH', wifi: 'WiFi' };

  const CONTAINER = /^(sensors?|data|readings?|values?|payload|measurements?|results?|state|status)$/i;
  const META = /^(device|device_?id|board|id|name|mac|ip|chip|chip_?id|firmware|fw|version|ver|timestamp|ts|time|date|datetime|epoch|unit|units|type|label)$/i;
  const BOOL_TRUE = /^(on|high|true|yes|detected|open|active|1)$/i;
  const BOOL_FALSE = /^(off|low|false|no|clear|closed|inactive|none|0)$/i;

  function norm(s) {
    return String(s)
      .replace(/pH/g, 'ph')
      .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9µ°%]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  function humanize(parts) {
    const words = parts.map(norm).join('_').split('_').filter(Boolean);
    // drop trailing unit suffix: "ultrasonic_cm" → "Ultrasonic"
    if (words.length > 1 && SUFFIX_UNITS[words[words.length - 1]]) words.pop();
    return words.map(w => SPECIAL_WORDS[w] || (w[0].toUpperCase() + w.slice(1))).join(' ') || 'Sensor';
  }

  function toValue(raw) {
    if (typeof raw === 'number') return isFinite(raw) ? { value: raw, kind: 'num' } : null;
    if (typeof raw === 'boolean') return { value: raw ? 1 : 0, kind: 'bool' };
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return { value: parseFloat(s), kind: 'num' };
      if (BOOL_TRUE.test(s)) return { value: 1, kind: 'bool' };
      if (BOOL_FALSE.test(s)) return { value: 0, kind: 'bool' };
      const m = s.match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z%°µ/²]+)$/); // "23.4 C"
      if (m) return { value: parseFloat(m[1]), kind: 'num', unit: m[2] };
    }
    return null;
  }

  function classify(texts, unit, kind) {
    for (const text of texts) for (const T of TYPES) if (T.keys.some(r => r.test(text))) return T;
    if (unit) {
      const u = unit.toLowerCase();
      const T = TYPES.find(t => t.units && t.units.includes(u));
      if (T) return T;
    }
    for (const text of texts) for (const T of TYPES) if (T.weak && T.weak.some(r => r.test(text))) return T;
    return kind === 'bool' ? BY_ID.digital : BY_ID.other;
  }

  function parseText(txt) {
    const obj = {};
    const re = /([A-Za-z][\w .-]*?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*([a-zA-Z%°/]*)/g;
    let m;
    while ((m = re.exec(txt))) obj[m[1].trim()] = m[3] ? { value: +m[2], unit: m[3] } : +m[2];
    return obj;
  }

  /* Parse any payload into [{key, name, type, autoType, group, value, unit, kind}] */
  function parse(payload, overrides = {}) {
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = parseText(payload); }
    }
    const out = [];
    const seen = new Set();

    function emit(path, raw, unitHint, typeHint) {
      const v = toValue(raw);
      if (!v) return;
      const key = path.join('.');
      if (seen.has(key)) return;
      seen.add(key);
      const clean = path.filter(p => !CONTAINER.test(p));
      if (!clean.length) clean.push(path[path.length - 1]);
      const leaf = norm(clean[clean.length - 1]);
      const full = norm(clean.join('_'));
      const lastWord = leaf.split('_').pop();
      const suffixUnit = leaf.includes('_') ? SUFFIX_UNITS[lastWord] : undefined;
      const unitRaw = unitHint || v.unit || '';
      const texts = [typeHint && norm(typeHint), leaf, full].filter(Boolean);
      const auto = classify(texts, unitRaw || (suffixUnit && lastWord), v.kind);
      const T = overrides[key] ? byId(overrides[key]) : auto;
      const unit = unitRaw ? (PRETTY_UNIT[unitRaw.toLowerCase()] || unitRaw) : (suffixUnit || (v.kind === 'bool' ? '' : T.unit));
      out.push({ key, name: humanize(clean), type: T.id, autoType: auto.id, group: T.group, value: v.value, unit, kind: v.kind });
    }

    function walk(node, path) {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        if (node.length && node.every(x => typeof x === 'number')) {
          const axes = node.length === 3 ? ['x', 'y', 'z'] : node.map((_, i) => String(i));
          node.forEach((x, i) => emit([...path, axes[i]], x));
          return;
        }
        node.forEach((item, i) => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const name = item.name ?? item.sensor ?? item.label ?? item.id ?? item.type ?? String(i);
            walk(item, [...path, String(name)]);
          } else emit([...path, String(i)], item);
        });
        return;
      }
      if (typeof node === 'object') {
        const valKey = ['value', 'val', 'reading'].find(k => k in node && typeof node[k] !== 'object');
        if (valKey) {
          emit(path.length ? path : ['value'], node[valKey], node.unit || node.units, node.type || node.kind);
          return;
        }
        for (const [k, v] of Object.entries(node)) {
          if (META.test(k) && (typeof v !== 'object' || v === null)) continue;
          walk(v, [...path, k]);
        }
        return;
      }
      emit(path.length ? path : ['value'], node);
    }

    walk(payload, []);
    return out;
  }

  /* Threshold evaluation → {status: ok|warn|crit, reason} */
  function evaluate(item, th) {
    const T = byId(item.type);
    if (item.kind === 'bool') {
      return item.value && T.boolAlert ? { status: T.boolAlert, reason: 'triggered' } : { status: 'ok', reason: '' };
    }
    const v = item.value, t = th || {};
    const has = k => t[k] !== null && t[k] !== undefined && t[k] !== '' && isFinite(t[k]);
    if (has('critLo') && v <= t.critLo) return { status: 'crit', reason: `at or below critical minimum ${t.critLo}` };
    if (has('critHi') && v >= t.critHi) return { status: 'crit', reason: `at or above critical maximum ${t.critHi}` };
    if (has('warnLo') && v <= t.warnLo) return { status: 'warn', reason: `below ${t.warnLo}` };
    if (has('warnHi') && v >= t.warnHi) return { status: 'warn', reason: `above ${t.warnHi}` };
    return { status: 'ok', reason: 'within normal range' };
  }

  return { GROUPS, GROUP_ORDER, TYPES, byId, parse, evaluate };
})();
