// 모리 키우기 — a floating round button (above the bottom tabs on owner and
// staff pages) that shows the store mascot's level/mood and lets anyone feed
// it whatever food is waiting. 레벨/경험치(totalXp)는 다 같이 키우는 거라
// meta/mascot 문서에 공유로 남지만, "먹이가 모였다/배고프다" 표시는 각자
// 본인이 번 먹이만 본인 화면에 뜨게 accounts/{phone} 문서에 개인별로 쌓는다
// — 안 그러면 내가 오늘 아무것도 안 했는데 다른 직원이 자재를 요청했다고
// 내 화면에도 "밥 주세요"가 뜨는 꼴이 된다. 세 가지 먹이:
//   - 꿀단지 (pendingHoney): awarded server-side (functions/index.js:
//     awardHoneyOnOrderBatch) whenever the OWNER submits a 주문완료 batch —
//     owner 역할 계정들의 accounts 문서에 쌓인다.
//   - 체크베리 (pendingCheckberry): awarded client-side (earnFood) whenever
//     THAT staff member submits a 기본자재 request — 그 직원의 accounts
//     문서에만 쌓인다.
//   - 주먹밥 (pendingOnigiri): awarded client-side (earnFood) whenever THAT
//     staff member submits a 식자재 request — 마찬가지로 본인 문서에만.
// Each of the three is capped at 2 awards per calendar day (see earnFood /
// awardHoneyOnOrderBatch) so splitting submissions into many small ones
// can't farm extra food.
// Feeding consumes *내 계정의* pending food and adds it to the shared
// totalXp, which drives the level (1~20) and growth stage name — 레벨 자체는
// 다 같이 키우는 모리라 공유로 남는다.
import { db, doc, setDoc, onSnapshot, runTransaction } from "./firebase-init.js";
import { todayStr } from "./util.js";

// 성장단계별 그림 — 아직 아기 모리 그림만 있고 나머지 단계는 없어서, 없는
// 단계는 전부 지금의 모리 이미지로 대체한다. 나중에 꼬마모리·마스터모리
// 그림이 생기면 STAGE_MASCOT_IMG에 그 단계 키만 추가하면 된다.
const DEFAULT_MASCOT_IMG = {
  happy: "img/mascot/mascot-happy.png",
  hungry: "img/mascot/mascot-hungry.png",
  loving: "img/mascot/mascot-loving.png",
  sad: "img/mascot/mascot-sad.png",
};

const STAGE_MASCOT_IMG = {
  "아기 모리": {
    happy: "img/mascot/mascot-baby-happy.png",
    hungry: "img/mascot/mascot-baby-hungry.png",
    loving: "img/mascot/mascot-baby-loving.png",
    sad: "img/mascot/mascot-baby-sad.png",
  },
  꼬마모리: {
    happy: "img/mascot/mascot-kid-happy.png",
    hungry: "img/mascot/mascot-kid-hungry.png",
    loving: "img/mascot/mascot-kid-loving.png",
    sad: "img/mascot/mascot-kid-sad.png",
  },
  // 처음부터 있던 기존 그림 — 레벨 10~19(지금의 모리) 구간에 그대로 쓴다.
  "지금의 모리": DEFAULT_MASCOT_IMG,
};

function mascotImgFor(level, mood) {
  const set = STAGE_MASCOT_IMG[stageName(level)] || DEFAULT_MASCOT_IMG;
  return set[mood] || DEFAULT_MASCOT_IMG[mood];
}

// 성장단계가 바뀌는 레벨업 순간(아기 모리 -> 꼬마모리 등)에만 쓰는 축하 그림 —
// 같은 단계 안에서의 레벨업은 이 그림 없이 텍스트만 뜬다. 없는 전환은 그냥
// 텍스트만 나온다.
const STAGE_LEVELUP_IMG = {
  꼬마모리: "img/mascot/mascot-stageup-baby-to-kid.png",
};

// emoji는 img 파일이 없거나 로드에 실패했을 때만 쓰는 대체용 — 아이콘
// 이미지가 준비되면 img가 정상 표시되고 이 emoji는 조용히 무시된다.
const FOOD_META = {
  honey: { label: "꿀단지", img: "img/mascot/honey-jar.png", emoji: "🍯" },
  checkberry: { label: "체크베리", img: "img/mascot/food-checkberry.png", emoji: "🍓" },
  onigiri: { label: "주먹밥", img: "img/mascot/food-onigiri.png", emoji: "🍙" },
};

const HUNGRY_CAPTION = "모리에게<br/>밥을 주세요!";
const MAX_LEVEL = 20;

const STAGES = [
  { min: 1, max: 4, name: "아기 모리" },
  { min: 5, max: 9, name: "꼬마모리" },
  { min: 10, max: 19, name: "지금의 모리" },
  { min: 20, max: 20, name: "마스터모리" },
];

function stageName(level) {
  return (STAGES.find((s) => level >= s.min && level <= s.max) || STAGES[0]).name;
}

// 레벨 L -> L+1로 올라가는 데 필요한 먹이 개수. 평생 쓸 서비스이고 직원과
// 사장이 함께 키우는 마스코트라, 1~5 / 6~9 / 10~20 세 구간 모두 각각 몇
// 달에서 몇 년씩 걸리도록 넉넉하게 늘렸다 (인덱스 0 = 레벨1->2, ...).
const XP_TO_NEXT = [
  200, 220, 240, 290, // 1->2, 2->3, 3->4, 4->5 (아기 모리 구간)
  150, 160, 170, 180, // 5->6, 6->7, 7->8, 8->9 (꼬마모리 구간)
  100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, // 9->10 ... 19->20
];

function xpToNext(level) {
  return XP_TO_NEXT[level - 1] || 0;
}

// 누적 먹인 횟수(totalXp)로부터 현재 레벨과, 그 레벨 안에서의 진행도를 구한다.
function levelFromXp(totalXp) {
  let level = 1;
  let remaining = totalXp || 0;
  while (level < MAX_LEVEL) {
    const need = xpToNext(level);
    if (remaining < need) break;
    remaining -= need;
    level++;
  }
  return { level, xpIntoLevel: remaining, xpNeeded: level < MAX_LEVEL ? xpToNext(level) : 0 };
}

function dayDiff(aStr, bStr) {
  const a = new Date(aStr + "T00:00:00");
  const b = new Date(bStr + "T00:00:00");
  return Math.round((a - b) / 86400000);
}

// 배고픔(밥 주세요 알림)은 "내 계정"에 모아둔 먹이가 하나라도 있으면 뜬다 —
// 레벨/경험치(mascotData)는 공유분이고, 먹이(accountData)는 내 계정 문서에서만
// 온다. sad는 별개 축: lastSubmitDate(사장이 주문완료 제출한 날)가 하루 이상
// 지나면 모리가 서운해한다 — 이건 가게 전체 상태라 공유로 둔다.
function deriveState(mascotData, accountData) {
  const pendingHoney = (accountData && accountData.pendingHoney) || 0;
  const pendingCheckberry = (accountData && accountData.pendingCheckberry) || 0;
  const pendingOnigiri = (accountData && accountData.pendingOnigiri) || 0;
  const totalPending = pendingHoney + pendingCheckberry + pendingOnigiri;
  const { level, xpIntoLevel, xpNeeded } = levelFromXp(mascotData && mascotData.totalXp);
  const lastSubmit = (mascotData && mascotData.lastSubmitDate) || null;
  const today = todayStr();
  const sad = !lastSubmit || dayDiff(today, lastSubmit) >= 2;
  return {
    pendingHoney,
    pendingCheckberry,
    pendingOnigiri,
    totalPending,
    level,
    xpIntoLevel,
    xpNeeded,
    hungry: totalPending > 0,
    sad,
  };
}

let myPhone = "";
let myStoreId = "";
let mascotData = null; // meta/mascot — 공유 레벨/경험치
let accountData = null; // accounts/{myPhone} — 내 계정에 쌓인 먹이
let unsubMascot = null;
let unsubAccount = null;
let state = deriveState(null, null);
let feeding = false;
let reactPose = null; // briefly "loving" right after a successful feed

function recomputeAndRender() {
  state = deriveState(mascotData, accountData);
  render();
}

function moriMood() {
  if (reactPose) return reactPose;
  if (state.hungry) return "hungry";
  if (state.sad) return "sad";
  return "happy";
}

function pendingFoodListHtml() {
  const rows = [
    { key: "honey", n: state.pendingHoney },
    { key: "checkberry", n: state.pendingCheckberry },
    { key: "onigiri", n: state.pendingOnigiri },
  ].filter((r) => r.n > 0);
  if (rows.length === 0) return `<div class="mascot-food-empty">아직 모아둔 먹이가 없어요.</div>`;
  return `<div class="mascot-food-list">${rows
    .map(
      (r) => `
      <div class="mascot-food-item">
        <img src="${FOOD_META[r.key].img}" alt="${FOOD_META[r.key].label}" data-emoji="${FOOD_META[r.key].emoji}" />
        <span>${FOOD_META[r.key].label} ${r.n}개</span>
      </div>`
    )
    .join("")}</div>`;
}

function gaugeHtml() {
  if (state.level >= MAX_LEVEL) {
    return `
      <div class="mascot-gauge-row">
        <div class="mascot-gauge full"><div class="mascot-gauge-fill" style="width:100%"></div></div>
        <div class="mascot-gauge-label">만렙 달성! 🎉</div>
      </div>`;
  }
  const pct = state.xpNeeded > 0 ? Math.min(100, Math.round((state.xpIntoLevel / state.xpNeeded) * 100)) : 0;
  return `
    <div class="mascot-gauge-row">
      <div class="mascot-gauge"><div class="mascot-gauge-fill" style="width:${pct}%"></div></div>
      <div class="mascot-gauge-label">${state.xpIntoLevel} / ${state.xpNeeded}</div>
    </div>`;
}

function render() {
  const fab = document.getElementById("mascotFab");
  if (!fab) return;
  document.getElementById("mascotFabImg").src = mascotImgFor(state.level, moriMood());

  const badge = document.getElementById("mascotFabBadge");
  if (state.totalPending > 0) {
    badge.textContent = state.totalPending;
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
  panelImg.src = mascotImgFor(state.level, moriMood());
  document.getElementById("mascotPanelLevel").innerHTML =
    `Lv.<span class="lv-num">${state.level}</span> ${stageName(state.level)}`;
  document.getElementById("mascotPanelGauge").innerHTML = gaugeHtml();
  document.getElementById("mascotPanelFood").innerHTML = pendingFoodListHtml();
  // 아직 준비 안 된 먹이 아이콘(예: 주먹밥)은 깨진 이미지 아이콘 대신
  // 이모지로 대체 — 이미지 파일이 나중에 채워지면 자연히 정상 표시된다.
  document.querySelectorAll("#mascotPanelFood img").forEach((img) => {
    img.addEventListener("error", () => {
      const span = document.createElement("span");
      span.className = "mascot-food-emoji";
      span.textContent = img.dataset.emoji || "🍽️";
      img.replaceWith(span);
    }, { once: true });
  });

  const feedBtn = document.getElementById("mascotFeedBtn");
  const feedHint = document.getElementById("mascotFeedHint");
  if (reactPose) {
    feedBtn.disabled = true;
    feedHint.textContent = "모리가 행복해해요!";
  } else if (state.totalPending <= 0) {
    feedBtn.disabled = true;
    feedHint.textContent = "모아둔 먹이가 없어요. 자재를 요청하거나 주문완료하면 먹이가 생겨요.";
  } else {
    feedBtn.disabled = false;
    feedHint.textContent = "모리가 배고파해요. 모아둔 먹이를 줘볼까요?";
  }
}

async function feedMascot() {
  if (feeding) return;
  feeding = true;
  try {
    const mascotRef = doc(db, "stores", myStoreId, "meta", "mascot");
    const accountRef = doc(db, "accounts", myPhone);
    const result = await runTransaction(db, async (tx) => {
      // 읽기는 전부 쓰기보다 먼저 — Firestore 트랜잭션 규칙상 get()들을
      // 모아서 먼저 끝내야 한다(쓰기 중간에 다시 읽을 수 없다).
      const [mascotSnap, accountSnap] = await Promise.all([tx.get(mascotRef), tx.get(accountRef)]);
      const mData = mascotSnap.exists() ? mascotSnap.data() : {};
      const aData = accountSnap.exists() ? accountSnap.data() : {};
      const pendingHoney = aData.pendingHoney || 0;
      const pendingCheckberry = aData.pendingCheckberry || 0;
      const pendingOnigiri = aData.pendingOnigiri || 0;
      const total = pendingHoney + pendingCheckberry + pendingOnigiri;
      if (total <= 0) return { ok: false };
      const prev = levelFromXp(mData.totalXp);
      const newTotalXp = (mData.totalXp || 0) + total;
      const next = levelFromXp(newTotalXp);
      // 레벨/경험치는 다 같이 키우는 모리라 공유 문서에, 먹인 사람의 pending
      // 먹이는 그 사람 계정 문서에서만 비운다.
      tx.set(mascotRef, { totalXp: newTotalXp }, { merge: true });
      tx.set(accountRef, { pendingHoney: 0, pendingCheckberry: 0, pendingOnigiri: 0 }, { merge: true });
      return {
        ok: true,
        gained: total,
        leveledUp: next.level > prev.level,
        newLevel: next.level,
        prevStage: stageName(prev.level),
        newStage: stageName(next.level),
        xpIntoLevel: next.xpIntoLevel,
        xpNeeded: next.xpNeeded,
      };
    });
    if (result.ok) {
      reactPose = "loving";
      render();
      // 레벨업이든 아니든 먹일 때마다 매번 경험치가 쌓였다는 걸 바로 알려준다 —
      // 직원이 먹이든 사장이 먹이든 같은 모리를 같이 키우고 있다는 걸 그때그때
      // 체감하게 하는 게 목적. 성장단계 자체가 바뀌는 레벨업이면 그 단계
      // 전용 축하 그림도 같이 보여준다.
      if (result.leveledUp) {
        const stageChanged = result.newStage !== result.prevStage;
        showFeedPopup(
          `레벨업! Lv.${result.newLevel} ${result.newStage}가 됐어요🎉`,
          stageChanged ? STAGE_LEVELUP_IMG[result.newStage] : null
        );
      } else {
        showFeedPopup(`경험치 +${result.gained}! (${result.xpIntoLevel} / ${result.xpNeeded})`);
      }
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
    <img class="mascot-fab-img" id="mascotFabImg" src="img/mascot/mascot-baby-happy.png" alt="모리" />
    <span class="mascot-fab-badge" id="mascotFabBadge"></span>
    <span class="mascot-fab-hungry-dot" id="mascotFabHungryDot"></span>
    <span class="mascot-fab-bubble" id="mascotFabBubble"></span>
  </div>
  <div class="mascot-panel-backdrop" id="mascotPanelBackdrop">
    <div class="mascot-panel">
      <button class="mascot-panel-close" id="mascotPanelClose" aria-label="닫기">✕</button>
      <img class="mascot-panel-img" id="mascotPanelImg" src="img/mascot/mascot-baby-happy.png" alt="모리" />
      <div class="mascot-panel-level" id="mascotPanelLevel">Lv.1 아기 모리</div>
      <div id="mascotPanelGauge"></div>
      <div id="mascotPanelFood"></div>
      <div class="mascot-panel-hint" id="mascotFeedHint"></div>
      <button class="btn gold block" id="mascotFeedBtn">모리에게 먹이 주기</button>
      <div class="mascot-panel-rule">사장님이 주문완료하면 꿀단지, 직원이 기본자재를 요청하면 체크베리, 식자재를 요청하면 주먹밥을 받아요. 모아서 모리에게 먹이면 경험치가 쌓이고, 다 채우면 레벨업해요!</div>
    </div>
  </div>
  <div class="mascot-earn-popup-backdrop" id="mascotEarnBackdrop">
    <div class="mascot-earn-popup">
      <img class="mascot-earn-img" id="mascotEarnImg" alt="" style="display:none;" />
      <div class="mascot-earn-text" id="mascotEarnText"></div>
    </div>
  </div>
`;

let earnPopupTimer = null;

function showFeedPopup(text, imgSrc) {
  const backdrop = document.getElementById("mascotEarnBackdrop");
  if (!backdrop) return;
  const img = document.getElementById("mascotEarnImg");
  if (imgSrc) {
    img.src = imgSrc;
    img.style.display = "block";
  } else {
    img.style.display = "none";
  }
  document.getElementById("mascotEarnText").textContent = text;
  backdrop.classList.add("show");
  if (earnPopupTimer) clearTimeout(earnPopupTimer);
  earnPopupTimer = setTimeout(() => backdrop.classList.remove("show"), 2600);
}

// Called by owner.js every time a 주문완료 체크 + 공유 submit goes through
// (full or partial) so the sad-mascot check has something to measure against.
export function recordSubmitToday(storeId) {
  setDoc(doc(db, "stores", storeId, "meta", "mascot"), { lastSubmitDate: todayStr() }, { merge: true }).catch(() => {});
}

// Called by staff.js right after a 발주 요청하기 submit goes through — 요청을
// 낸 "그 직원"의 accounts 문서에만 먹이를 적립한다(다른 직원 화면엔 안 뜬다).
// 자재요청을 잘게 쪼개 여러 번 제출해서 먹이를 우르르 받아내는 걸 막기 위해,
// 체크베리/주먹밥 각각 하루 최대 2번까지만 적립된다 — 세 번째부터는 요청
// 제출 자체는 정상 처리되지만 먹이는 더 안 생긴다.
export async function earnFood(kind) {
  if (!myPhone) return;
  const pendingField = kind === "checkberry" ? "pendingCheckberry" : "pendingOnigiri";
  const countField = kind === "checkberry" ? "checkberryCount" : "onigiriCount";
  const countDateField = kind === "checkberry" ? "checkberryCountDate" : "onigiriCountDate";
  const today = todayStr();
  const ref = doc(db, "accounts", myPhone);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? snap.data() : {};
      const count = data[countDateField] === today ? data[countField] || 0 : 0;
      if (count >= 2) return; // 오늘 이미 2번 받았음
      tx.set(
        ref,
        { [pendingField]: (data[pendingField] || 0) + 1, [countField]: count + 1, [countDateField]: today },
        { merge: true }
      );
    });
  } catch (e) {
    // transient — the request submission itself already succeeded either way
  }
}

export function mountMascotWidget(phone, storeId) {
  if (phone) myPhone = phone;
  if (storeId) myStoreId = storeId;
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
  render();
  document.getElementById("mascotFeedBtn").addEventListener("click", feedMascot);

  if (unsubMascot) unsubMascot();
  unsubMascot = onSnapshot(doc(db, "stores", myStoreId, "meta", "mascot"), (snap) => {
    mascotData = snap.exists() ? snap.data() : null;
    recomputeAndRender();
  });
  if (unsubAccount) unsubAccount();
  if (myPhone) {
    unsubAccount = onSnapshot(doc(db, "accounts", myPhone), (snap) => {
      accountData = snap.exists() ? snap.data() : null;
      recomputeAndRender();
    });
  }
}
