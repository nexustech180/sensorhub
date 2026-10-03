'use strict';
/*
 * AI classification via the Google Gemini API.
 * The first reading of every new sensor is sent to Gemini, which picks one of the
 * Classifier's known types. The rule-based classifier stays the instant/offline
 * fallback; the AI answer replaces it once it arrives and is remembered locally,
 * so each sensor is sent only once. Manual overrides in Settings always win.
 *
 * Only the sensor's key, display name, first value, unit, value kind and the
 * rule-based guess are sent — never camera images or reading history.
 */
const AI = (() => {
  const KEY_RESULTS = 'sensorhub.ai';
  const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
  const BATCH_DELAY = 400;     // ms to collect sensors that appear in the same payload
  const MAX_BATCH = 40;        // sensors per request
  const RETRY_MS = 60000;      // wait before retrying a sensor whose request failed
  const TIMEOUT_MS = 20000;

  let cfg = () => ({});
  let onResult = () => {};
  let results = load();        // key → { type, confidence, reason, model, ts }
  const queue = new Map();     // key → reading waiting to be sent
  const inFlight = new Set();
  const failedAt = new Map();  // key → ts of last failure
  let timer = null;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY_RESULTS)) || {}; } catch { return {}; }
  }
  function save() {
    try { localStorage.setItem(KEY_RESULTS, JSON.stringify(results)); } catch { /* storage unavailable */ }
  }

  /* cfgFn() → { enabled, apiKey, model, endpoint }; resultFn(entries, error) is called after each batch. */
  function init(cfgFn, resultFn) { cfg = cfgFn; onResult = resultFn; }

  const ready = () => {
    const c = cfg();
    return !!(c.enabled && c.model && (c.apiKey || (c.endpoint && c.endpoint !== DEFAULT_ENDPOINT)));
  };

  /* AI types to feed into Classifier.parse: key → type id */
  const types = () => Object.fromEntries(Object.entries(results).map(([k, r]) => [k, r.type]));
  const get = key => results[key];
  const pending = () => queue.size + inFlight.size;

  /* Queue a reading for classification unless it is already classified, queued, in flight or cooling down. */
  function submit(item) {
    if (!ready() || results[item.key] || queue.has(item.key) || inFlight.has(item.key)) return false;
    const f = failedAt.get(item.key);
    if (f && Date.now() - f < RETRY_MS) return false;
    queue.set(item.key, item);
    clearTimeout(timer);
    timer = setTimeout(flush, BATCH_DELAY);
    return true;
  }

  /* Drop stored AI results so the given (or all) sensors are classified again on their next reading. */
  function forget(keys) {
    if (keys) keys.forEach(k => { delete results[k]; failedAt.delete(k); });
    else { results = {}; failedAt.clear(); }
    save();
  }

  async function flush() {
    timer = null;
    if (!queue.size) return;
    const batch = [...queue.values()].slice(0, MAX_BATCH);
    batch.forEach(i => { queue.delete(i.key); inFlight.add(i.key); });
    if (queue.size) timer = setTimeout(flush, BATCH_DELAY);

    let entries = [], error = null;
    try {
      entries = await classify(batch);
      const ts = Date.now(), model = cfg().model;
      for (const e of entries) results[e.key] = { type: e.type, confidence: e.confidence, reason: e.reason, model, ts };
      save();
      // Sensors Gemini skipped are retried later, like failures.
      const got = new Set(entries.map(e => e.key));
      batch.forEach(i => { if (!got.has(i.key)) failedAt.set(i.key, Date.now()); });
    } catch (e) {
      error = e;
      batch.forEach(i => failedAt.set(i.key, Date.now()));
    } finally {
      batch.forEach(i => inFlight.delete(i.key));
    }
    onResult(entries, error);
  }

  function prompt(batch) {
    const catalogue = Classifier.TYPES.map(t =>
      `- ${t.id}: ${t.label} (group: ${Classifier.GROUPS[t.group].label}${t.unit ? `, typical unit: ${t.unit}` : ''})`).join('\n');
    const sensors = batch.map(i => ({
      key: i.key, name: i.name, first_value: i.value, unit: i.unit || null,
      value_kind: i.kind === 'bool' ? 'boolean' : 'number', rule_based_guess: i.ruleType,
    }));
    return `You classify sensors reported by an ESP32 microcontroller for an IoT monitoring dashboard.
For each sensor, choose the single best type id from this catalogue:
${catalogue}

Use the data key, name, unit and the plausibility of the first value (e.g. pH is 0-14, turbidity in NTU,
relative humidity 0-100). Key names may be abbreviations, part numbers (e.g. DHT22, MQ135, HC-SR04, BMP280)
or non-English words. "rule_based_guess" comes from a simple keyword matcher and may be wrong.
Use "digital" for generic on/off inputs and "other" only when nothing fits.
Return one result per sensor, using the exact "key" given.

Sensors:
${JSON.stringify(sensors, null, 2)}`;
  }

  async function classify(batch) {
    const c = cfg();
    const base = (c.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
    const url = `${base}/models/${encodeURIComponent(c.model)}:generateContent`;
    const ids = Classifier.TYPES.map(t => t.id);
    const body = {
      contents: [{ role: 'user', parts: [{ text: prompt(batch) }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: {
              key: { type: 'STRING' },
              type: { type: 'STRING', enum: ids },
              confidence: { type: 'NUMBER', description: '0 to 1' },
              reason: { type: 'STRING', description: 'One short sentence' },
            },
            required: ['key', 'type', 'confidence', 'reason'],
            propertyOrdering: ['key', 'type', 'confidence', 'reason'],
          },
        },
      },
    };

    const headers = { 'Content-Type': 'application/json' };
    if (c.apiKey) headers['x-goog-api-key'] = c.apiKey;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let res, data;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal });
      data = await res.json().catch(() => null);
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'Gemini request timed out' : 'Could not reach Gemini (' + e.message + ')');
    } finally {
      clearTimeout(t);
    }
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}${data?.error?.message ? ': ' + data.error.message : ''}`);
    if (data?.promptFeedback?.blockReason) throw new Error('Gemini blocked the request: ' + data.promptFeedback.blockReason);

    const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    let list;
    try { list = JSON.parse(text); } catch { throw new Error('Gemini returned an unreadable answer'); }
    if (!Array.isArray(list)) throw new Error('Gemini returned an unexpected answer');

    const keys = new Set(batch.map(i => i.key));
    return list
      .filter(e => e && keys.has(e.key) && ids.includes(e.type))
      .map(e => ({
        key: e.key, type: e.type,
        confidence: Math.max(0, Math.min(1, +e.confidence || 0)),
        reason: String(e.reason || '').slice(0, 200),
      }));
  }

  /* One-off request used by the "Test Gemini" button. */
  async function test() {
    const sample = Classifier.parse({ water_ntu: 4.2, mq135: 410, hcsr04: 37 });
    sample.forEach(s => { s.ruleType = s.autoType; });
    return classify(sample);
  }

  return { init, ready, submit, types, get, pending, forget, test, DEFAULT_ENDPOINT };
})();
