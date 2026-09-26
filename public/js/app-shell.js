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
import { watchUnseenCount } from "./shareboard.js";
import { registerPushToken, watchForegroundPush, isPushDisabled } from "./push.js";
import { watchAppBadgeClear } from "./badge.js";

const VIEWS = {
  "owner.html": { title: "발주 리스트 - MAMMORY", load: () => import("./owner.js") },
  "admin.html": { title: "자재 관리 - MAMMORY", load: () => import("./admin.js") },
  "share.html": { title: "공유하기 - MAMMORY", load: () => import("./share.js") },
};

const mainContent = document.getElementById("mainContent");
const fragmentCache = {};
let account = null;
let currentView = null; // { path, mod }
let unwireAvatar = null;

// #accountName / #logoutBtn / #refreshBtn live INSIDE each view's own
// #mainContent markup (every view happens to render the same account card at
// its top), not in the shared shell — so unlike the header/bottom-tabs, they
// get thrown away and recreated on every view switch and need re-wiring
// every time, not just once at boot.
function wireContentChrome() {
  if (unwireAvatar) unwireAvatar();
  unwireAvatar = wireAccountHeaderAvatar(document.getElementById("accountName"), account, "사장님 계정");
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("refreshBtn").addEventListener("click", () => window.forceAppRefresh());
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
  watchUnseenCount({ name: acc.name, phone: acc.phone }, (n) => {
    if (n > 0) { navBadge.textContent = "N"; navBadge.style.display = "flex"; }
    else navBadge.style.display = "none";
  });

  watchForegroundPush();
  watchAppBadgeClear();
  if (Notification.permission === "granted" && !isPushDisabled()) registerPushToken(acc.phone);

  switchTo(pathOf(location.pathname) || "owner.html", { push: false, isInitial: true });
  forceFixedBarReflow();
});
