'use strict';
/* IndexedDB storage: readings, alerts and uploaded files (demo video). */
const DB = (() => {
  let db;

  function open() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('sensorhub', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        const readings = d.createObjectStore('readings', { keyPath: 'id', autoIncrement: true });
        readings.createIndex('ts', 'ts');
        readings.createIndex('sensor', 'sensor');
        const alerts = d.createObjectStore('alerts', { keyPath: 'id', autoIncrement: true });
        alerts.createIndex('ts', 'ts');
        d.createObjectStore('files');
      };
      r.onsuccess = () => { db = r.result; resolve(); };
      r.onerror = () => reject(r.error);
    });
  }

  const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
  const req = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  function addMany(name, items) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(name, 'readwrite');
      const s = t.objectStore(name);
      items.forEach(i => s.add(i));
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  const count = name => req(store(name).count());
  const clear = name => req(store(name, 'readwrite').clear());

  // Iterate records; 'prev' = newest first. Return false from fn to stop.
  function each(name, fn, direction = 'prev') {
    return new Promise((resolve, reject) => {
      const r = store(name).openCursor(null, direction);
      r.onsuccess = () => {
        const c = r.result;
        if (!c || fn(c.value) === false) return resolve();
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
  }

  // Delete oldest records beyond `max`. Resolves with number deleted.
  async function prune(name, max) {
    const n = await count(name);
    const excess = n - max;
    if (excess <= 0) return 0;
    return new Promise((resolve, reject) => {
      const t = db.transaction(name, 'readwrite');
      const r = t.objectStore(name).openCursor();
      let k = 0;
      r.onsuccess = () => {
        const c = r.result;
        if (!c || k >= excess) return;
        c.delete(); k++; c.continue();
      };
      t.oncomplete = () => resolve(k);
      t.onerror = () => reject(t.error);
    });
  }

  const putFile = (key, blob) => req(store('files', 'readwrite').put(blob, key));
  const getFile = key => req(store('files').get(key));
  const delFile = key => req(store('files', 'readwrite').delete(key));

  return { open, addMany, count, clear, each, prune, putFile, getFile, delFile };
})();
