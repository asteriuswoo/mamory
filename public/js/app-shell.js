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
import { wireAccountHeaderAvatar } from "./avatar.js";
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

// 위 reflow(콜드 런칭 보정)만으론 부족했다 — 실제로 더 자주 겹치는 건
// 스크롤하는 도중/직후, iOS Safari가 주소창을 숨기거나 보이게 하면서
// "레이아웃 뷰포트"와 실제 눈에 보이는 "비주얼 뷰포트"가 순간적으로
// 어긋나는 경우다. 그 순간엔 CSS position:fixed 하나만 믿지 말고, 실제
// 보이는 뷰포트 크기를 계속 재서 하단 탭바의 bottom 값을 직접 맞춰준다 —
// visualViewport의 resize/scroll 이벤트가 바로 그 어긋남이 생기고 있는
// 동안(애니메이션 도중까지) 계속 뜨므로, 끝나길 기다리지 않고 실시간으로
// 따라간다.
function pinBottomTabsToVisualViewport() {
  const bar = document.querySelector(".bottom-tabs");
  if (!bar || !window.visualViewport) return;
  const vv = window.visualViewport;
  const sync = () => {
    const gap = window.innerHeight - vv.height - vv.offsetTop;
    bar.style.bottom = `${Math.max(0, gap)}px`;
  };
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  sync();
}
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

  const navBadge = document.getElementById("shareNavBadge");
  watchUnseenCount({ name: acc.name, phone: acc.phone }, () => {
    if (hasUnseenShareActivity(acc.phone)) { navBadge.textContent = "N"; navBadge.style.display = "flex"; }
    else navBadge.style.display = "none";
  });

  const registerNavBadge = document.getElementById("registerNavBadge");
  watchRegisterUnseen({ name: acc.name, phone: acc.phone }, () => {
    if (hasUnseenRegisterActivity()) { registerNavBadge.textContent = "N"; registerNavBadge.style.display = "flex"; }
    else registerNavBadge.style.display = "none";
  });

  watchForegroundPush();
  watchAppBadgeClear();
  if ("Notification" in window && Notification.permission === "granted" && !isPushDisabled()) registerPushToken(acc.phone);
  mountMascotWidget(acc.phone);
  mountMusicBar(document.getElementById("musicBarRoot"), { name: acc.name, phone: acc.phone });

  switchTo(pathOf(location.pathname) || "owner.html", { push: false, isInitial: true });
  forceFixedBarReflow();
});
