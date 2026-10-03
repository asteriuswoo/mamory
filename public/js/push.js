// Registers this device for real push notifications (delivered even while
// the app is closed, via sw.js's onBackgroundMessage handler) and shows a
// lightweight in-app toast (not a system notification) for pushes that
// arrive while the app happens to be open in the foreground. A system
// Notification here would double up with the service worker's own — on
// some browsers (notably iOS Safari) the SW still fires even while the page
// is visible, so this must not also call `new Notification()`.
import { db, doc, getDoc, updateDoc, messaging, messagingReady } from "./firebase-init.js";
import { VAPID_KEY } from "./firebase-config.js";
import { toast } from "./util.js";
import { bumpAppBadge } from "./badge.js";
import { getToken, deleteToken, onMessage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// The browser's own Notification permission can't be revoked from JS once
// granted — only the user can do that in browser settings. This app-level
// flag is our own on/off switch on top of that: "off" means we deliberately
// unregistered this device's token and skip re-registering it at load time,
// even though the browser permission itself stays granted.
const DISABLED_KEY = "mmate_notify_disabled";

export function isPushDisabled() {
  return localStorage.getItem(DISABLED_KEY) === "1";
}

// A physical browser/device can get issued a NEW FCM token across visits
// (e.g. after a service-worker update). Without a stable device id, plain
// arrayUnion(token) just keeps piling up tokens for the same phone forever,
// and every still-valid old one gets pushed to too — showing up as the same
// notification arriving 2-3 times on one device. Tagging each stored token
// with a device id that persists in localStorage lets re-registration
// *replace* this device's entry instead of adding another one.
const DEVICE_ID_KEY = "mmate_device_id";
// Remembers which phone/account THIS browser last registered its push token
// under. logout() doesn't (and can't, since the old account is already gone
// from localStorage by then) unregister the old account's copy of this
// device — so switching accounts on one device used to leave it permanently
// registered under BOTH the old and the new account, doubling every
// notification that goes to both. Comparing against this key lets
// registerPushToken clean up the old account's entry itself.
const LAST_TOKEN_PHONE_KEY = "mmate_last_fcm_phone";

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// 다들 모바일 한 대로만 앱을 쓰기 때문에, 알림도 딱 한 사람당 한 기기(모바일)
// 기준으로만 인정한다 — 데스크톱 브라우저(개발/테스트 포함)에서는 알림
// 기기로 등록되지 않는다.
function isMobileDevice() {
  if (navigator.userAgentData && typeof navigator.userAgentData.mobile === "boolean") {
    return navigator.userAgentData.mobile;
  }
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export async function registerPushToken(phone) {
  if (!("serviceWorker" in navigator) || !VAPID_KEY) return;
  if (isPushDisabled()) return;
  if (!isMobileDevice()) return;
  const supported = await messagingReady;
  if (!supported || !messaging) return;
  try {
    // FCM's background handler lives inside our existing sw.js (registered
    // by register-sw.js at app load) rather than a separate SW file, since
    // only one service worker can control the "/" scope at a time.
    const reg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
    if (!token) return;

    const deviceId = getDeviceId();

    // This device switched to a different account since it last registered —
    // strip this device's old entry out of the previous account first, or
    // that account keeps getting this device's notifications forever.
    const lastPhone = localStorage.getItem(LAST_TOKEN_PHONE_KEY);
    if (lastPhone && lastPhone !== phone) {
      const oldRef = doc(db, "accounts", lastPhone);
      const oldSnap = await getDoc(oldRef);
      if (oldSnap.exists()) {
        const oldTokens = oldSnap.data().fcmTokens || [];
        const oldFiltered = oldTokens
          .map((t) => (typeof t === "string" ? { id: t, token: t } : t))
          .filter((t) => t.id !== deviceId);
        if (oldFiltered.length !== oldTokens.length) {
          await updateDoc(oldRef, { fcmTokens: oldFiltered }).catch(() => {});
        }
      }
    }

    // 계정당 토큰은 항상 이 한 건으로 통째로 교체한다(누적/병합 아님) — 한
    // 사람은 폰 한 대라고 보고, 기기를 재설치하거나 localStorage가 지워져서
    // 새 deviceId가 발급돼도 예전 등록이 남아 알림이 여러 번 가는 일이
    // 없도록 한다.
    await updateDoc(doc(db, "accounts", phone), { fcmTokens: [{ id: deviceId, token }] });
    localStorage.setItem(LAST_TOKEN_PHONE_KEY, phone);
  } catch (e) {
    console.error("FCM 토큰 등록 실패", e);
  }
}

// Turns the app's own push switch off: unregisters this device's FCM token
// (both from Firestore and from the browser's push subscription) and
// remembers not to auto re-register at next load. The OS-level permission
// itself stays "granted" — we just stop using it until turned back on here.
export async function disablePushToken(phone) {
  localStorage.setItem(DISABLED_KEY, "1");
  const supported = await messagingReady;
  if (!supported || !messaging) return;
  try {
    const deviceId = getDeviceId();
    const accRef = doc(db, "accounts", phone);
    const snap = await getDoc(accRef);
    const existing = (snap.exists() && snap.data().fcmTokens) || [];
    const filtered = existing
      .map((t) => (typeof t === "string" ? { id: t, token: t } : t))
      .filter((t) => t.id !== deviceId);
    await updateDoc(accRef, { fcmTokens: filtered });
    await deleteToken(messaging).catch(() => {});
  } catch (e) {
    console.error("FCM 토큰 해제 실패", e);
  }
}

export async function enablePushToken(phone) {
  localStorage.removeItem(DISABLED_KEY);
  await registerPushToken(phone);
}

let foregroundWatchStarted = false;
export function watchForegroundPush() {
  if (foregroundWatchStarted) return;
  foregroundWatchStarted = true;
  messagingReady.then((supported) => {
    if (!supported || !messaging) return;
    onMessage(messaging, (payload) => {
      // Server sends data-only (see functions/index.js) so the browser never
      // auto-displays anything on its own — this toast is the only rendering.
      const { title, body } = payload.data || {};
      toast(body ? `${title || "MAMORY"}: ${body}` : title || "새 알림이 있어요");
      bumpAppBadge();
    });
  });
}
