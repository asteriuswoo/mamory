// Web App Badging API: shows an unread-count dot/number on the PWA's home
// screen icon. The service worker bumps the count (in IndexedDB, since a SW
// can be killed between pushes and needs somewhere durable to read it back
// from) each time it shows a background notification; opening/foregrounding
// the app here clears both the OS badge and the stored count. iOS Safari
// does not support this API at all yet (same gap as web push itself), so
// this is a no-op there rather than an error.
const DB_NAME = "mmate-badge";
const STORE = "counters";
const KEY = "unseen";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function setCount(n) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(n, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function getCount() {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY);
    req.onsuccess = () => resolve(req.result || 0);
    req.onerror = () => resolve(0);
  });
}

// Called from push.js's onMessage — Firebase routes a push to the SW's
// onBackgroundMessage (sw.js has its own copy of this same bump logic) only
// when the tab isn't the active/focused one at delivery time; the exact same
// push type when the tab IS in front goes straight to onMessage here
// instead, so both paths need to bump the same counter or a push received
// while the app happens to be open never reaches the icon.
export async function bumpAppBadge() {
  if (!navigator.setAppBadge) return;
  try {
    const next = (await getCount()) + 1;
    await setCount(next);
    navigator.setAppBadge(next).catch(() => {});
  } catch (e) {
    // IndexedDB unavailable — skip badging for this push rather than throw.
  }
}

export async function clearAppBadge() {
  try {
    await setCount(0);
  } catch (e) {
    // IndexedDB unavailable (e.g. private browsing) — badge itself still clears below.
  }
  if (navigator.clearAppBadge) navigator.clearAppBadge().catch(() => {});
}

let started = false;
export function watchAppBadgeClear() {
  if (started) return;
  started = true;
  if (!navigator.clearAppBadge) return;
  clearAppBadge();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") clearAppBadge();
  });
  window.addEventListener("focus", () => clearAppBadge());
}
