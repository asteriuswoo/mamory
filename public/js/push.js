// Registers this device for real push notifications (delivered even while
// the app is closed, via sw.js's onBackgroundMessage handler) and shows a
// lightweight in-app toast (not a system notification) for pushes that
// arrive while the app happens to be open in the foreground. A system
// Notification here would double up with the service worker's own — on
// some browsers (notably iOS Safari) the SW still fires even while the page
// is visible, so this must not also call `new Notification()`.
import { db, doc, getDoc, updateDoc, collection, query, orderBy, limit, onSnapshot, serverTimestamp, messaging, messagingReady } from "./firebase-init.js";
import { VAPID_KEY } from "./firebase-config.js";
import { toast, escapeHtml, todayStr, dateStrDaysAgo, dateStrOf, formatDateLabel } from "./util.js";
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

    // 한 사람이 폰+맥처럼 기기 여러 대를 동시에 등록할 수 있게, 이 기기의
    // deviceId만 골라 교체하고 다른 기기의 토큰은 그대로 둔다.
    const accRef = doc(db, "accounts", phone);
    const accSnap = await getDoc(accRef);
    const existingTokens = (accSnap.exists() && accSnap.data().fcmTokens) || [];
    const nextTokens = [
      ...existingTokens.map((t) => (typeof t === "string" ? { id: t, token: t } : t)).filter((t) => t.id !== deviceId),
      { id: deviceId, token },
    ];
    await updateDoc(accRef, { fcmTokens: nextTokens });
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

// 로그아웃할 때 이 기기의 알림 토큰을 그 계정에서 지운다 — disablePushToken과
// 달리 "이 기기에서 알림을 영구히 끈다"는 로컬 플래그는 안 남긴다(같은
// 기기를 다른 직원이 로그인해서 쓸 수도 있는데, 그 사람까지 알림이 꺼진
// 채로 시작하면 안 된다). 로그아웃 후에도 토큰이 안 지워지고 남아있으면,
// 나중에 다른 기기로 또 로그인했을 때 두 기기 모두에 똑같은 알림이 두 번
// 가는 문제가 생긴다.
export async function removeDeviceTokenOnLogout(phone) {
  if (!phone) return;
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
    if (filtered.length !== existing.length) {
      await updateDoc(accRef, { fcmTokens: filtered });
    }
  } catch (e) {
    console.error("로그아웃 시 알림 토큰 정리 실패", e);
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

// ---- 알림 내역 (종 배지 + 패널) ----
// 서버(functions/index.js)는 푸시를 보낼 때마다 accounts/{phone}/notifications
// 에도 똑같은 내용을 한 벌 남겨둔다 — 기기에 실제로 푸시가 도착했는지와
// 무관하게, 앱을 열면 항상 "무슨 알림이 왔었는지" 직접 확인할 수 있게
// 하기 위해서다. 이 세션에서 겪은 것처럼 권한/서비스워커 문제로 푸시가
// 조용히 안 올 때 특히 요긴하다. 3일 지난 기록은 서버가 매일 새벽에 정리.
function tsMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function timeAgoLabel(ms) {
  if (!ms) return "";
  const diffMin = Math.floor((Date.now() - ms) / 60000);
  if (diffMin < 1) return "방금";
  if (diffMin < 60) return `${diffMin}분 전`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}시간 전`;
  return `${Math.floor(diffHr / 24)}일 전`;
}

// 직원/사장이 받는 알림은 겹치는 것도 많지만(공유해요 등) 발주 요청·주문
// 완료·급여처럼 역할마다 다른 종류도 섞여 있어서, 유형을 한눈에 구분할 수
// 있게 아이콘을 붙인다. 서버(functions/index.js)가 notify() 호출마다 찍어
// 보내는 type 문자열과 1:1로 맞춘다.
// 아이콘은 되도록 공유하기 세그먼트 탭(💬 소통해요 · 📦 품절공유 · 📖
// 메뉴공유)에서 실제로 쓰는 것과 그대로 맞춘다 — 알림 패널에서만 다른
// 아이콘(예: 엉뚱한 샴푸통 🧴)을 쓰면 같은 걸 가리키는데 안 헷갈리게.
const NOTIF_TYPE_META = {
  request: { icon: "🛒", label: "발주 요청" },
  order: { icon: "✅", label: "주문완료" },
  share: { icon: "💬", label: "소통해요" },
  soldout: { icon: "📦", label: "품절공유" },
  recipe: { icon: "📖", label: "메뉴공유" },
  discontinued: { icon: "🔴", label: "단종" },
  cash: { icon: "💰", label: "시재" },
  payroll: { icon: "💵", label: "급여" },
  attendance: { icon: "⏰", label: "출퇴근" },
  schedule: { icon: "🗓️", label: "근무" },
  humanity: { icon: "💢", label: "극한직업" },
  general: { icon: "🔔", label: "알림" },
};

function notifTypeMeta(type) {
  return NOTIF_TYPE_META[type] || NOTIF_TYPE_META.general;
}

function dateGroupLabel(dateStr) {
  if (dateStr === todayStr()) return "오늘";
  if (dateStr === dateStrDaysAgo(1)) return "어제";
  return formatDateLabel(dateStr);
}

// 이미 createdAt 내림차순으로 온 목록이라, 날짜가 바뀌는 지점마다 새 묶음을
// 시작하면 된다(재정렬 불필요) — 날짜별로, 유형별로 한눈에 보기 쉽게.
function groupNotifItemsByDate(items) {
  const groups = [];
  let current = null;
  items.forEach((n) => {
    const d = dateStrOf(n.createdAt);
    if (!current || current.date !== d) {
      current = { date: d, items: [] };
      groups.push(current);
    }
    current.items.push(n);
  });
  return groups;
}

let notifItems = [];
let notifLastSeenAtMs = 0;
let notifBadgeEl = null;
let notifUnsubItems = null;
let notifUnsubAccount = null;

function renderNotifBadge() {
  if (!notifBadgeEl) return;
  const unread = notifItems.filter((n) => tsMillis(n.createdAt) > notifLastSeenAtMs).length;
  notifBadgeEl.textContent = unread > 9 ? "9+" : String(unread);
  notifBadgeEl.style.display = unread > 0 ? "inline-flex" : "none";
}

// staff.js/owner.js가 헤더 마운트 시점에 한 번 불러서, 종 아이콘 옆 배지를
// 살아있는 알림 개수로 유지한다.
export function watchNotificationBadge(badgeEl, phone) {
  notifBadgeEl = badgeEl;
  if (notifUnsubItems) notifUnsubItems();
  if (notifUnsubAccount) notifUnsubAccount();
  notifUnsubAccount = onSnapshot(doc(db, "accounts", phone), (snap) => {
    notifLastSeenAtMs = tsMillis(snap.data() && snap.data().notifLastSeenAt);
    renderNotifBadge();
  });
  notifUnsubItems = onSnapshot(
    query(collection(db, "accounts", phone, "notifications"), orderBy("createdAt", "desc"), limit(50)),
    (snap) => {
      notifItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderNotifBadge();
    }
  );
}

function pushToggleLabel(pushOn) {
  return pushOn ? "🔔 푸시 켜짐 (탭하면 끄기)" : "🔕 푸시 꺼짐 (탭하면 켜기)";
}

async function currentPushState() {
  if (!("Notification" in window)) return "unsupported";
  if (!(await messagingReady)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission === "granted" && !isPushDisabled()) return "on";
  return "off";
}

async function onPushToggleClick(phone, btn) {
  if (!("Notification" in window)) return;
  if (!(await messagingReady)) {
    toast("이 브라우저에서는 알림을 지원하지 않아요 (iOS는 홈 화면에 추가한 앱으로 열어야 해요)");
    return;
  }
  if (Notification.permission === "denied") {
    toast("알림이 차단돼 있어요. 기기 설정에서 허용해주세요");
    return;
  }
  if (Notification.permission === "granted") {
    if (isPushDisabled()) {
      await enablePushToken(phone);
      toast("알림을 켰어요");
    } else {
      await disablePushToken(phone);
      toast("알림을 껐어요");
    }
  } else {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      await enablePushToken(phone);
      toast("알림을 켰어요");
    }
  }
  const state = await currentPushState();
  btn.textContent = pushToggleLabel(state === "on");
}

// 종 아이콘을 탭하면 뜨는 패널 — 최근 3일 알림 목록 + 맨 위에 푸시 on/off
// 토글. 패널을 열면 그 순간을 notifLastSeenAt으로 찍어서 배지를 비운다.
export async function openNotificationPanel(phone) {
  updateDoc(doc(db, "accounts", phone), { notifLastSeenAt: serverTimestamp() }).catch(() => {});
  notifLastSeenAtMs = Date.now();
  renderNotifBadge();

  const pushState = await currentPushState();

  const overlay = document.createElement("div");
  overlay.className = "sheet-backdrop";
  overlay.innerHTML = `
    <div class="action-sheet notif-panel">
      <div class="notif-panel-head">
        <span class="notif-panel-title-text">🔔 알림</span>
        ${pushState === "unsupported" ? "" : `<button type="button" class="notif-panel-push-toggle" id="notifPushToggle">${pushToggleLabel(pushState === "on")}</button>`}
      </div>
      <div class="notif-panel-list">
        ${notifItems.length === 0
          ? `<div class="empty">최근 3일간 받은 알림이 없어요.</div>`
          : groupNotifItemsByDate(notifItems).map((group) => `
            <div class="notif-panel-date-header">${dateGroupLabel(group.date)}</div>
            ${group.items.map((n) => {
              const meta = notifTypeMeta(n.type);
              return `
                <button type="button" class="notif-panel-row" data-notif-link="${escapeHtml(n.link || "/")}">
                  <div class="notif-panel-row-top">
                    <span class="notif-panel-row-type">${meta.icon} ${escapeHtml(meta.label)}</span>
                    <span class="notif-panel-row-time">${timeAgoLabel(tsMillis(n.createdAt))}</span>
                  </div>
                  <div class="notif-panel-row-title">${escapeHtml(n.title || "")}</div>
                  <div class="notif-panel-row-body">${escapeHtml(n.body || "")}</div>
                </button>`;
            }).join("")}`).join("")}
      </div>
      <button type="button" class="action-sheet-cancel" data-close>닫기</button>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("[data-close]").addEventListener("click", close);
  overlay.querySelectorAll("[data-notif-link]").forEach((el) => {
    el.addEventListener("click", () => { location.href = el.dataset.notifLink; });
  });
  const toggleBtn = overlay.querySelector("#notifPushToggle");
  if (toggleBtn) toggleBtn.addEventListener("click", () => onPushToggleClick(phone, toggleBtn));
}
