// Shared shell for owner.html / admin.html / share.html. These three pages
// used to be a plain multi-page app — every tab click was a full browser
// navigation, so the header and bottom tab bar visibly unmounted and
// remounted on every switch (and Safari doesn't support the View Transitions
// API that papers over that on Chrome). This shell keeps the header/bottom
// tabs permanently mounted and only swaps <main id="mainContent">'s content,
// so tab switches are instant and never flicker on any browser.
//
// Each view still ships as its own real, standalone HTML file (so a direct
// link, bookmark, or reload still works with no JS) — this shell just
// fetches a sibling view's file on first visit, lifts out its #mainContent
// fragment, and caches it in memory so later switches don't refetch.
import { requireAccount, logout } from "./auth.js";
import { wireAccountHeaderAvatar, setAccountsStoreId } from "./avatar.js";
import { watchUnseenCount, hasUnseenShareActivity, markShareNavBadgeSeen } from "./shareboard.js";
import { watchRegisterUnseen, hasUnseenRegisterActivity, markRegisterNavBadgeSeen } from "./registerboard.js";
import { registerPushToken, watchForegroundPush, isPushDisabled } from "./push.js";
import { watchAppBadgeClear } from "./badge.js";
import { mountMascotWidget } from "./mascot.js";
import { mountMusicBar } from "./musicbar.js";

const VIEWS = {
  "owner.html": { title: "발주 리스트 - MAMORY", load: () => import("./owner.js") },
  "admin.html": { title: "자재 관리 - MAMORY", load: () => import("./admin.js") },
  "share.html": { title: "공유하기 - MAMORY", load: () => import("./share.js") },
  "register.html": { title: "등록해요 - MAMORY", load: () => import("./register.js") },
  "payroll.html": { title: "급여관리 - MAMORY", load: () => import("./payrollpage.js") },
};

const mainContent = document.getElementById("mainContent");
const fragmentCache = {};
let account = null;
let currentView = null; // { path, mod }
let unwireAvatar = null;

// #accountName / #logoutBtn / #refreshBtn used to live inside every view's
// own #mainContent markup, but now only the home tab (자재 관리 = admin.html)
// keeps that account card — the other views skip straight to their content,
// so these elements won't exist there. Each lookup is null-checked since
// this runs on every view switch regardless of which view it is.
function wireContentChrome() {
  if (unwireAvatar) { unwireAvatar(); unwireAvatar = null; }
  const accountNameEl = document.getElementById("accountName");
  if (accountNameEl) unwireAvatar = wireAccountHeaderAvatar(accountNameEl, account, "사장님 계정");
  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", logout);
  const refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => window.forceAppRefresh());
}

function pathOf(href) {
  return new URL(href, location.href).pathname.split("/").pop();
}

// On a cold launch of the installed PWA (icon tap, not a browser tab), iOS
// can paint the very first frame with a stale env(safe-area-inset-bottom),
// leaving the fixed bottom tab bar floating above the true screen edge until
// something forces a reflow. Toggling display off/on makes WebKit recompute
// fixed-position layout against the real viewport.
function forceFixedBarReflow() {
  // The display-toggle reflow trick wasn't enough on its own — the classic,
  // more reliable fix for this exact iOS Safari bug (safe-area/viewport
  // metrics stuck stale after a cold PWA launch) is nudging the scroll
  // position by 1px and back, which forces WebKit to recompute them against
  // the real viewport. Retried once more after a short delay in case the
  // very first attempt runs before the cold-launch layout has settled.
  const nudge = () => {
    window.scrollTo(0, 1);
    requestAnimationFrame(() => window.scrollTo(0, 0));
  };
  nudge();
  setTimeout(nudge, 300);
}

// owner.html/admin.html/share.html/register.html/payroll.html도 이제
// html/body를 고정(position:fixed)해서 스크롤 바운스를 막는다(각 파일의
// <head> 참고, staff.html과 동일한 구조) — 이 함수가 보정하려던 "주소창
// 숨김/보임으로 레이아웃 뷰포트와 비주얼 뷰포트가 어긋나는" 상황 자체가
// 그 고정된 레이아웃에선 더 이상 일어나지 않는다. 그런데도 계속 돌면서
// 실제론 없는 작은 간극을 측정해 탭바를 진짜 바닥에서 위로 띄워버리는
// 부작용만 냈다 — bottom.style을 직접 건드리는 인라인 스타일이라 CSS의
// .bottom-tabs { bottom: ... } 값을 전부 덮어써버렸던 것. staff.js에서
// 똑같은 이유로 먼저 비워둔 적이 있어서(pinBottomTabsToVisualViewport의
// 그 쪽 정의 참고) 여기도 동일하게 비운다 — 순수 CSS position:fixed +
// bottom 값만으로 이제 충분하다.
function pinBottomTabsToVisualViewport() {}
pinBottomTabsToVisualViewport();

function setActiveTab(path) {
  document.querySelectorAll(".bottom-tab").forEach((a) => {
    a.classList.toggle("active", pathOf(a.getAttribute("href")) === path);
  });
}

async function fetchFragment(path) {
  if (fragmentCache[path]) return fragmentCache[path];
  const res = await fetch(path);
  const text = await res.text();
  const parsed = new DOMParser().parseFromString(text, "text/html");
  const html = parsed.getElementById("mainContent").innerHTML;
  fragmentCache[path] = html;
  return html;
}

async function switchTo(path, { push, isInitial } = {}) {
  if (!VIEWS[path]) return;
  if (currentView && currentView.path === path && !isInitial) return;
  if (currentView && currentView.mod.unmount) currentView.mod.unmount();

  if (!isInitial) {
    mainContent.innerHTML = await fetchFragment(path);
  } else {
    // First view on this load is already server-rendered into #mainContent —
    // cache it as-is instead of re-fetching what we already have.
    fragmentCache[path] = mainContent.innerHTML;
  }

  document.title = VIEWS[path].title;
  setActiveTab(path);
  wireContentChrome();

  const mod = await VIEWS[path].load();
  mod.mount(account);
  currentView = { path, mod };

  if (push) history.pushState(null, "", path);
}

document.querySelectorAll(".bottom-tab").forEach((a) => {
  a.addEventListener("click", (e) => {
    const path = pathOf(a.getAttribute("href"));
    if (path === "share.html") {
      markShareNavBadgeSeen();
      const navBadge = document.getElementById("shareNavBadge");
      if (navBadge) navBadge.style.display = "none";
    }
    if (path === "register.html") {
      markRegisterNavBadgeSeen();
      const registerBadge = document.getElementById("registerNavBadge");
      if (registerBadge) registerBadge.style.display = "none";
    }
    if (!VIEWS[path]) return; // not one of the 3 SPA views — let it navigate normally
    e.preventDefault();
    switchTo(path, { push: true });
  });
});

window.addEventListener("popstate", () => {
  switchTo(pathOf(location.pathname) || "owner.html", { push: false });
});

requireAccount("owner").then((acc) => {
  if (!acc) return;
  account = acc;
  setAccountsStoreId(acc.storeId);

  const navBadge = document.getElementById("shareNavBadge");
  watchUnseenCount({ name: acc.name, phone: acc.phone, storeId: acc.storeId }, () => {
    if (hasUnseenShareActivity(acc.phone)) { navBadge.textContent = "N"; navBadge.style.display = "flex"; }
    else navBadge.style.display = "none";
  });

  const registerNavBadge = document.getElementById("registerNavBadge");
  watchRegisterUnseen({ name: acc.name, phone: acc.phone, storeId: acc.storeId }, () => {
    if (hasUnseenRegisterActivity()) { registerNavBadge.textContent = "N"; registerNavBadge.style.display = "flex"; }
    else registerNavBadge.style.display = "none";
  });

  watchForegroundPush();
  watchAppBadgeClear();
  if ("Notification" in window && Notification.permission === "granted" && !isPushDisabled()) registerPushToken(acc.phone);
  mountMascotWidget(acc.phone, acc.storeId);
  mountMusicBar(document.getElementById("musicBarRoot"), { name: acc.name, phone: acc.phone, storeId: acc.storeId });

  switchTo(pathOf(location.pathname) || "owner.html", { push: false, isInitial: true });
  forceFixedBarReflow();
});
