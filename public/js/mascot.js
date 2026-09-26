// 모리 키우기 — a floating round button (above the bottom tabs on owner and
// staff pages) that shows the store mascot's mood and lets the owner feed it
// a honey jar. Honey jars are earned server-side by a Cloud Function
// (functions/index.js: awardHoneyOnAllOrdered) whenever every 발주 request
// submitted today gets marked 주문완료 on that same day — this module only
// reads meta/mascot and spends jars via feedMascot().
import { db, doc, setDoc, onSnapshot, runTransaction } from "./firebase-init.js";
import { todayStr } from "./util.js";

const MASCOT_IMG = {
  happy: "img/mascot/mascot-happy.png",
  hungry: "img/mascot/mascot-hungry.png",
  loving: "img/mascot/mascot-loving.png",
  sad: "img/mascot/mascot-sad.png",
};

const HONEY_JAR_IMG = "img/mascot/honey-jar.png";
const HUNGRY_CAPTION = "모리에게<br/>밥을 주세요!";

function dayDiff(aStr, bStr) {
  const a = new Date(aStr + "T00:00:00");
  const b = new Date(bStr + "T00:00:00");
  return Math.round((a - b) / 86400000);
}

// The "밥 주세요" nudge (bubble + red dot) is tied directly to having an
// unspent jar sitting there today — it appears the moment the owner earns a
// jar (체크 후 공유 -> Cloud Function awards it) and clears as soon as they
// feed it. No jars, or already fed today -> neutral/happy, nothing to nudge.
// Separately, if the owner hasn't even done a 주문완료 후 공유 submit at all
// in a day or more (lastSubmitDate, written by owner.js on every submit —
// full or partial), 모리 looks sad regardless of the jar/feed state.
function deriveState(data) {
  const jars = (data && data.honeyJars) || 0;
  const lastFed = (data && data.lastFedDate) || null;
  const lastSubmit = (data && data.lastSubmitDate) || null;
  const today = todayStr();
  const fedToday = lastFed === today;
  const hungry = jars > 0 && !fedToday;
  const sad = !lastSubmit || dayDiff(today, lastSubmit) >= 2;
  return { jars, hungry, fedToday, sad };
}

let unsub = null;
let state = { jars: 0, hungry: false, fedToday: false, sad: false };
let feeding = false;
let reactPose = null; // briefly "loving" right after a successful feed

function moriMood() {
  if (reactPose) return reactPose;
  if (state.hungry) return "hungry";
  if (state.sad) return "sad";
  return "happy";
}

function render() {
  const fab = document.getElementById("mascotFab");
  if (!fab) return;
  document.getElementById("mascotFabImg").src = MASCOT_IMG[moriMood()];

  const badge = document.getElementById("mascotFabBadge");
  if (state.jars > 0) {
    badge.textContent = state.jars;
    badge.style.display = "flex";
  } else {
    badge.style.display = "none";
  }
  document.getElementById("mascotFabHungryDot").style.display = state.hungry && !reactPose ? "block" : "none";

  const bubble = document.getElementById("mascotFabBubble");
  if (state.hungry && !reactPose) {
    bubble.innerHTML = HUNGRY_CAPTION;
    bubble.style.display = "block";
  } else {
    bubble.style.display = "none";
  }

  const panelImg = document.getElementById("mascotPanelImg");
  if (!panelImg) return;
  panelImg.src = MASCOT_IMG[moriMood()];
  document.getElementById("mascotPanelJars").textContent = state.jars;

  const feedBtn = document.getElementById("mascotFeedBtn");
  const feedHint = document.getElementById("mascotFeedHint");
  if (reactPose) {
    feedBtn.disabled = true;
    feedHint.textContent = "모리가 행복해해요! 🍯";
  } else if (state.jars <= 0) {
    feedBtn.disabled = true;
    feedHint.textContent = "꿀단지가 없어요. 오늘 올라온 발주 요청을 당일에 모두 주문완료하면 꿀단지를 받을 수 있어요.";
  } else if (state.fedToday) {
    feedBtn.disabled = true;
    feedHint.textContent = "오늘은 이미 밥을 줬어요. 내일 또 챙겨주세요!";
  } else {
    feedBtn.disabled = false;
    feedHint.textContent = "모리가 배고파해요. 꿀단지를 줘볼까요?";
  }
}

async function feedMascot() {
  if (feeding) return;
  feeding = true;
  try {
    const ref = doc(db, "meta", "mascot");
    const today = todayStr();
    const result = await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const jars = data.honeyJars || 0;
      if (jars <= 0) return { ok: false };
      if (data.lastFedDate === today) return { ok: false };
      tx.set(ref, { honeyJars: jars - 1, lastFedDate: today }, { merge: true });
      return { ok: true };
    });
    if (result.ok) {
      reactPose = "loving";
      render();
      setTimeout(() => { reactPose = null; render(); }, 1800);
    }
  } catch (e) {
    // transient failure — panel just won't update; the fab's own onSnapshot
    // will resync state on the next change anyway
  } finally {
    feeding = false;
  }
}

function openPanel() {
  document.getElementById("mascotPanelBackdrop").classList.add("show");
  render();
}

function closePanel() {
  document.getElementById("mascotPanelBackdrop").classList.remove("show");
}

const WIDGET_HTML = `
  <div class="mascot-fab" id="mascotFab">
    <img class="mascot-fab-img" id="mascotFabImg" src="img/mascot/mascot-happy.png" alt="모리" />
    <span class="mascot-fab-badge" id="mascotFabBadge"></span>
    <span class="mascot-fab-hungry-dot" id="mascotFabHungryDot"></span>
    <span class="mascot-fab-bubble" id="mascotFabBubble"></span>
  </div>
  <div class="mascot-panel-backdrop" id="mascotPanelBackdrop">
    <div class="mascot-panel">
      <button class="mascot-panel-close" id="mascotPanelClose" aria-label="닫기">✕</button>
      <img class="mascot-panel-img" id="mascotPanelImg" src="img/mascot/mascot-happy.png" alt="모리" />
      <div class="mascot-panel-jars">🍯 보유 꿀단지 <strong id="mascotPanelJars">0</strong>개</div>
      <div class="mascot-panel-hint" id="mascotFeedHint"></div>
      <button class="btn gold block" id="mascotFeedBtn">모리에게 먹이 주기</button>
      <div class="mascot-panel-rule">오늘 올라온 발주 요청을 당일에 전부 주문완료하면 꿀단지를 하나 받아요. 하루 이상 못 먹이면 모리가 허기져요 — 매일 챙겨주세요!</div>
    </div>
  </div>
  <div class="mascot-earn-popup-backdrop" id="mascotEarnBackdrop">
    <div class="mascot-earn-popup">
      <img class="mascot-earn-img" id="mascotEarnImg" src="${HONEY_JAR_IMG}" alt="꿀단지" />
      <div class="mascot-earn-text" id="mascotEarnText"></div>
    </div>
  </div>
`;

let earnPopupTimer = null;
let honeyImgFailed = false;

// kind: "full" (all of today's requests just got 주문완료 -> jar earned) or
// "partial" (some, not all, got marked -> nudge toward the rest).
export function showMascotEarnPopup(kind) {
  const backdrop = document.getElementById("mascotEarnBackdrop");
  if (!backdrop) return;
  const img = document.getElementById("mascotEarnImg");
  const text = document.getElementById("mascotEarnText");
  if (kind === "full") {
    img.style.display = honeyImgFailed ? "none" : "block";
    text.textContent = "모리에게 줄 꿀단지를 얻었어요!";
  } else {
    img.style.display = "none";
    text.textContent = "꿀단지를 얻기 위해 나머지도 주문해볼까요?";
  }
  backdrop.classList.add("show");
  if (earnPopupTimer) clearTimeout(earnPopupTimer);
  earnPopupTimer = setTimeout(() => backdrop.classList.remove("show"), 2600);
}

// Called by owner.js every time a 주문완료 체크 + 공유 submit goes through
// (full or partial) so the sad-mascot check has something to measure against.
export function recordSubmitToday() {
  setDoc(doc(db, "meta", "mascot"), { lastSubmitDate: todayStr() }, { merge: true }).catch(() => {});
}

export function mountMascotWidget() {
  if (document.getElementById("mascotFab")) return; // already mounted on this page
  const host = document.createElement("div");
  host.innerHTML = WIDGET_HTML;
  while (host.firstChild) document.body.appendChild(host.firstChild);

  document.getElementById("mascotFab").addEventListener("click", openPanel);
  document.getElementById("mascotPanelClose").addEventListener("click", closePanel);
  document.getElementById("mascotPanelBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "mascotPanelBackdrop") closePanel();
  });
  document.getElementById("mascotEarnBackdrop").addEventListener("click", () => {
    document.getElementById("mascotEarnBackdrop").classList.remove("show");
    if (earnPopupTimer) clearTimeout(earnPopupTimer);
  });
  // Graceful degradation until the honey-jar artwork is in place: fall back
  // to just the text rather than showing a broken-image icon.
  document.getElementById("mascotEarnImg").addEventListener("error", function () {
    honeyImgFailed = true;
    this.style.display = "none";
  });
  render();
  document.getElementById("mascotFeedBtn").addEventListener("click", feedMascot);

  if (unsub) unsub();
  unsub = onSnapshot(doc(db, "meta", "mascot"), (snap) => {
    state = deriveState(snap.exists() ? snap.data() : null);
    render();
  });
}
