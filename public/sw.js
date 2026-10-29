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
  const { title, body, link, iconUrl } = payload.data || {};
  self.registration.showNotification(title || "MAMORY", {
    body: body || "",
    // 특정 계정의 행동이면 그 사람 프로필 사진, 발주 확인처럼 모리 이미지가
    // 맞는 시스템 알림은 모리 이미지 — 서버(functions/index.js)가 골라서
    // 보내준 URL을 그대로 쓰고, 없으면(대부분의 익명/시스템 알림) 기본
    // 앱 아이콘을 쓴다.
    icon: iconUrl || "/icons/icon-192.png",
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

const CACHE_NAME = "cafe-order-v148";
const APP_SHELL = [
  "index.html",
  "staff.html",
  "owner.html",
  "admin.html",
  "share.html",
  "payroll.html",
  "register.html",
  "css/style.css",
  "manifest.json",
  "js/admin.js",
  "js/app-shell.js",
  "js/auth.js",
  "js/avatar.js",
  "js/badge.js",
  "js/firebase-config.js",
  "js/firebase-init.js",
  "js/humanityboard.js",
  "js/login.js",
  "js/mascot.js",
  "js/musicbar.js",
  "js/ordertrend.js",
  "js/owner.js",
  "js/payroll.js",
  "js/payrollpage.js",
  "js/push.js",
  "js/register-sw.js",
  "js/register.js",
  "js/registerboard.js",
  "js/share.js",
  "js/shareboard.js",
  "js/staff.js",
  "js/util.js",
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

  // Stale-while-revalidate: 캐시가 있으면 그걸로 즉시 응답해서 네트워크가
  // 느리거나 끊겨도 "빈 껍데기"로 기다리는 일 없이 바로 뜨고, 동시에
  // 백그라운드에서 최신 버전을 받아 캐시를 갱신해둔다 (이전의 network-first
  // 방식은 매번 네트워크 응답을 기다려야 해서, 네트워크가 느릴 때 가끔
  // 빈 화면으로 한참 멈춰 있었다).
  //
  // 배포 직후에도 새로고침을 두 번 할 필요는 없다 — sw.js 자체가 바뀌면
  // (CACHE_NAME 변경) 브라우저가 새 서비스워커를 설치하면서 APP_SHELL을
  // 전부 새로 받아 캐시해두고, skipWaiting()/clients.claim()으로 즉시
  // activate시킨 뒤 register-sw.js의 controllerchange 리스너가 그 순간
  // 페이지를 한 번 자동으로 새로고침해서 이미 새로 캐시된 최신 버전을
  // 바로 보여주기 때문이다.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res && res.ok) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
