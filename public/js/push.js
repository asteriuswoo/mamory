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
// Remembers the exact token string THIS browser last wrote for itself, so a
// later re-registration (e.g. after a service-worker update mints a new
// token) can find and remove that specific old entry — including ones saved
// before the {id, token} shape existed, which the deviceId match alone
// can't catch since those were stored as bare strings keyed by their own value.
const LAST_TOKEN_KEY = "mmate_last_fcm_token";

function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export async function registerPushToken(phone) {
  if (!("serviceWorker" in navigator) || !VAPID_KEY) return;
  if (isPushDisabled()) return;
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
    const prevToken = localStorage.getItem(LAST_TOKEN_KEY);
    const accRef = doc(db, "accounts", phone);
    const snap = await getDoc(accRef);
    const existing = (snap.exists() && snap.data().fcmTokens) || [];
    // Legacy entries were plain token strings with no device id — treat each
    // as its own one-off device so old installs still get migrated cleanly.
    const deduped = existing
      .map((t) => (typeof t === "string" ? { id: t, token: t } : t))
      .filter((t) => t.id !== deviceId && t.token !== prevToken);
    deduped.push({ id: deviceId, token });
    await updateDoc(accRef, { fcmTokens: deduped });
    localStorage.setItem(LAST_TOKEN_KEY, token);
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
