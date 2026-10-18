// Tiny IndexedDB key/value store (user sample pads).
const DB = 'dubmixer';
let dbp;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbp;
}
export async function kvSet(key, val) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const tx = d.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
  } catch (e) { /* storage unavailable */ }
}
export async function kvGet(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  } catch (e) { return undefined; }
}
export async function kvDel(key) {
  try {
    const d = await db();
    d.transaction('kv', 'readwrite').objectStore('kv').delete(key);
  } catch (e) { /* noop */ }
}
