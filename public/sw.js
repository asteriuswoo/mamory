// Firebase Cloud Messaging needs its own handler living in the site's active
// service worker (not a second SW at the same scope — only one can control
// the page) so background/closed-app pushes can show a notification.
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCWy5B-hqYtKP8D5id4M9cAJms-vek6L5w",
  authDomain: "mmth-order.firebaseapp.com",
  projectId: "mmth-order",
  storageBucket: "mmth-order.firebasestorage.app",
  messagingSenderId: "186023339141",
  appId: "1:186023339141:web:545b26417457b0d41835ec",
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  // Server sends data-only (no top-level `notification` field) specifically
  // so the browser never auto-displays its own default banner — that
  // auto-display plus this handler's own showNotification() call was
  // showing every push twice. This is now the single place a notification
  // gets shown.
  const { title, body, link } = payload.data || {};
  self.registration.showNotification(title || "MAMORY", {
    body: body || "",
    icon: "/icons/icon-192.png",
    tag: payload.messageId || `${title}-${body}`,
    // Stashed on the Notification itself so notificationclick below can read
    // it back — FCM's own webpush.fcmOptions.link auto-open only applies to
    // notifications the browser renders on its own, not ones we render
    // ourselves via showNotification() like this.
    data: { link: link || "/" },
  });
  bumpAppBadge();
});

// Tapping the notification (from the OS notification center / status bar)
// should land on the specific page the notification is about, not just
// wherever the app happened to be left open — e.g. a "자재발주 요청" push
// should open owner.html straight to the order list, not the login screen.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((allClients) => {
      const target = new URL(link, self.location.origin).href;
      for (const client of allClients) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ("navigate" in client) client.navigate(target);
        return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});

// Mirrors public/js/badge.js's counter, but duplicated here in plain
// IndexedDB calls rather than shared via import: sw.js is a classic
// (non-module) service worker, loaded with importScripts, so it can't
// `import` an ES module. The app clears this same counter to 0 when opened.
const BADGE_DB_NAME = "mmate-badge";
const BADGE_STORE = "counters";
const BADGE_KEY = "unseen";

function openBadgeDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BADGE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(BADGE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function bumpAppBadge() {
  if (!self.navigator.setAppBadge) return;
  try {
    const db = await openBadgeDb();
    const current = await new Promise((resolve) => {
      const tx = db.transaction(BADGE_STORE, "readonly");
      const req = tx.objectStore(BADGE_STORE).get(BADGE_KEY);
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => resolve(0);
    });
    const next = current + 1;
    await new Promise((resolve) => {
      const tx = db.transaction(BADGE_STORE, "readwrite");
      tx.objectStore(BADGE_STORE).put(next, BADGE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
    self.navigator.setAppBadge(next).catch(() => {});
  } catch (e) {
    // IndexedDB unavailable — skip badging for this push rather than throw.
  }
}

const CACHE_NAME = "cafe-order-v21";
const APP_SHELL = [
  "index.html",
  "staff.html",
  "owner.html",
  "admin.html",
  "share.html",
  "css/style.css",
  "manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // let Firebase/CDN requests pass through

  event.respondWith(
    // Bypass the browser's own HTTP cache (not just the Cache API storage
    // below) so a deploy is picked up immediately instead of waiting out
    // any Cache-Control max-age on the response.
    fetch(event.request, { cache: "no-store" })
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
