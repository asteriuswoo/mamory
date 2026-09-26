import { db, collection, doc, setDoc, deleteDoc, onSnapshot, getDocs, serverTimestamp, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { requireAccount, logout } from "./auth.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimestampLabel, formatTimeLabel, toast, escapeHtml, URGENCY_LABEL, URGENCY_HINT, URGENCY_ORDER, sortMaterials, sortByOrder, resizeImageFile, confirmModal } from "./util.js";
import { mountShareBoard, getTodayUnseenCount, watchUnseenCount } from "./shareboard.js";
import { registerPushToken, watchForegroundPush, isPushDisabled, disablePushToken, enablePushToken } from "./push.js";
import { wireAccountHeaderAvatar } from "./avatar.js";
import { watchAppBadgeClear } from "./badge.js";

document.getElementById("dateLabel").textContent = formatDateLabel(todayStr());
document.getElementById("logoutBtn").addEventListener("click", logout);
document.getElementById("refreshBtn").addEventListener("click", () => window.forceAppRefresh());

document.getElementById("deleteAccountBtn").addEventListener("click", async () => {
  const ok = await confirmModal("정말 떠나실 건가요?", "네! 이제 퇴사합니다🥲", "아니요! 돌아갈래요😊");
  if (!ok || !staffPhone) return;
  await deleteDoc(doc(db, "accounts", staffPhone));
  logout();
});

const notifyBtn = document.getElementById("notifyBtn");

function updateNotifyBtn() {
  if (!("Notification" in window)) {
    notifyBtn.textContent = "알림 미지원 기기";
    notifyBtn.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    notifyBtn.textContent = "알림 차단됨 (기기 설정에서 허용 필요)";
  } else if (Notification.permission === "granted" && !isPushDisabled()) {
    notifyBtn.textContent = "알림 켜짐 ✓ (탭하면 끄기)";
  } else {
    notifyBtn.textContent = "알림 설정하려면 선택하세요";
  }
}

notifyBtn.addEventListener("click", async () => {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    if (isPushDisabled()) {
      if (staffPhone) await enablePushToken(staffPhone);
      toast("알림을 켰어요");
    } else {
      if (staffPhone) await disablePushToken(staffPhone);
      toast("알림을 껐어요");
    }
    updateNotifyBtn();
    return;
  }
  const perm = await Notification.requestPermission();
  updateNotifyBtn();
  if (perm === "granted" && staffPhone) enablePushToken(staffPhone);
});

const screenEl = document.getElementById("screen");

const date = todayStr();
const PENDING_KEY = "cafe_pending_" + date;

let materials = [];
let yesterdayItems = {}; // materialId -> yesterday's checks/items doc data, for the "어제 요청/주문완료" hint
let subcategoryOrder = {}; // { 기본자재: string[], 식자재: string[] } from config/subcategoryOrder
let synced = {}; // materialId -> data actually submitted to Firestore today
let pending = {}; // materialId -> {action:'set', ...fields} | {action:'delete', mainCategory}
// Uncommitted picks made while browsing the current items screen. Nothing
// here is persisted or counted anywhere until "장바구니 담기" is pressed —
// pressing the back button instead just throws it away.
let draft = {}; // materialId -> {action:'set', ...fields} | {removed:true}
let itemsCol;
let staffName = "";
let staffPhone = "";

// nav state
let view = "main"; // main | sub | items | cart | share
let chosenMain = null;
let chosenSub = null;

// history (cart) state
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));
const chipCounts = {};
let cartDate = date;
let cartItems = [];

const MAIN_CATS = ["기본자재", "식자재"];
const MAIN_DESC = {
  기본자재: "컵, 뚜껑, 빨대, 감열지, 냅킨, 원두, 기타",
  식자재: "파우더, 시럽/소스, 베이스, 디저트, 냉동, 탄산",
};

function loadPending() {
  try {
    pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "{}");
  } catch (e) {
    pending = {};
  }
}
function savePending() {
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
}

function effectiveState(id) {
  if (id in draft) return draft[id].removed ? null : draft[id];
  const p = pending[id];
  if (p) return p.action === "delete" ? null : p;
  return synced[id] || null;
}

function discardDraft() {
  draft = {};
}

function commitDraft() {
  for (const id of Object.keys(draft)) {
    const d = draft[id];
    if (d.removed) delete pending[id];
    else pending[id] = d;
  }
  savePending();
  draft = {};
}

function allKnownIds() {
  return new Set([...Object.keys(synced), ...Object.keys(pending)]);
}

// iOS Safari can visually detach the fixed bottom bars from the true screen
// edge (leaving a sliver of the page background showing below them) if
// window.scrollTo() runs in the same tick as a DOM change that shifts page
// height — deferring it a frame lets the browser finish that layout pass
// first, which avoids the glitch.
function scrollTopSafely() {
  requestAnimationFrame(forceFixedBarReflow);
}

// On a cold launch of the installed PWA (icon tap, not a browser tab), iOS
// can paint the very first frame with a stale/incorrect
// env(safe-area-inset-bottom), leaving the fixed bottom tab bar floating
// above the true screen edge until something forces a reflow — which is why
// switching tabs used to "fix" it (that reflow was incidental) while the
// very first screen never got one. Toggling display off/on forces WebKit to
// recompute the fixed-position layout against the real viewport.
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

function goToCart() {
  discardDraft();
  view = "cart";
  cartDate = date;
  loadCartDate(cartDate); // renders internally for today's date
  scrollTopSafely();
}

function updateBottomTabActive() {
  const activeKey = { main: "main", sub: "main", items: "main", cart: "cart", share: "share" }[view] || "main";
  document.querySelectorAll(".bottom-tab[data-nav]").forEach((el) => {
    el.classList.toggle("active", el.dataset.nav === activeKey);
  });
}

document.querySelectorAll(".bottom-tab[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (nav === "cart") {
      goToCart();
      return;
    }
    view = nav;
    render();
    scrollTopSafely();
  });
});

function dowLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return { dow: days[new Date(y, m - 1, d).getDay()], dnum: d };
}

function buildTodayCartItems() {
  const list = [];
  allKnownIds().forEach((id) => {
    const eff = effectiveState(id);
    if (!eff) return;
    list.push({ id, ...eff, submitted: !pending[id] });
  });
  return list;
}

async function loadCartDate(targetDate) {
  if (targetDate === date) {
    cartItems = buildTodayCartItems();
    render();
    return;
  }
  try {
    const snap = await getDocs(collection(db, "checks", targetDate, "items"));
    cartItems = snap.docs.map((d) => ({ id: d.id, ...d.data(), submitted: true }));
    chipCounts[targetDate] = cartItems.length;
  } catch (e) {
    cartItems = [];
  }
  render();
}

function loadAllChipCounts() {
  recentDates.forEach((d) => {
    if (d === date) return; // live count already tracked from onSnapshot
    getDocs(collection(db, "checks", d, "items"))
      .then((snap) => { chipCounts[d] = snap.size; if (view === "cart") render(); })
      .catch(() => {});
  });
}

// One-time lookup of yesterday's requests so the item screen can hint
// "이미 어제 요청했던 자재예요" / 주문완료 여부 — doc IDs match the material's
// own catalog ID, so this is a direct id -> data map.
async function loadYesterdayItems() {
  try {
    const snap = await getDocs(collection(db, "checks", dateStrDaysAgo(1), "items"));
    yesterdayItems = {};
    snap.docs.forEach((d) => { yesterdayItems[d.id] = d.data(); });
  } catch (e) {
    yesterdayItems = {};
  }
  if (view === "items") render();
}

function yesterdayStatusLabel(materialId) {
  const y = yesterdayItems[materialId];
  if (!y) return "어제 발주요청 안 드린 자재예요";
  if (y.ordered) {
    const when = formatTimestampLabel(y.orderedAt);
    return `어제 요청 · 주문완료됨${when ? ` (${when})` : ""}`;
  }
  return "어제 요청 · 주문되지 않음";
}

function selectedCountInMain(main) {
  let n = 0;
  allKnownIds().forEach((id) => {
    const eff = effectiveState(id);
    if (eff && eff.mainCategory === main) n++;
  });
  return n;
}
function selectedCountInSub(main, sub) {
  let n = 0;
  allKnownIds().forEach((id) => {
    const eff = effectiveState(id);
    if (eff && eff.mainCategory === main && eff.subCategory === sub) n++;
  });
  return n;
}
function pendingCountInMain(main) {
  return Object.values(pending).filter((p) => p.mainCategory === main).length;
}

function updateCartNavBadge() {
  const badge = document.getElementById("cartNavBadge");
  const n = Object.keys(pending).length;
  if (n > 0) { badge.textContent = "N"; badge.style.display = "flex"; }
  else badge.style.display = "none";
}

function render() {
  updateBottomTabActive();
  updateCartNavBadge();
  if (view === "main") return renderMain();
  if (view === "sub") return renderSub();
  if (view === "items") return renderItems();
  if (view === "cart") return renderCart();
  if (view === "share") return renderShare();
}

function renderMain() {
  let html = `<div class="big-cat-grid">`;
  for (const cat of MAIN_CATS) {
    const n = selectedCountInMain(cat);
    html += `
      <button class="big-cat-card" data-main="${cat}">
        <div class="big-cat-title-row">
          <span class="label">${cat}</span>
          ${n > 0 ? `<span class="count-badge">${n}</span>` : ""}
          <span class="arrow">›</span>
        </div>
        <div class="desc">${MAIN_DESC[cat]}</div>
      </button>`;
  }
  html += `</div>`;
  screenEl.innerHTML = html;
  screenEl.querySelectorAll("[data-main]").forEach((el) => {
    el.addEventListener("click", () => {
      chosenMain = el.dataset.main;
      view = "sub";
      render();
    });
  });
}

function renderSub() {
  const subs = sortByOrder(
    [...new Set(materials.filter((m) => m.mainCategory === chosenMain).map((m) => m.subCategory))],
    subcategoryOrder[chosenMain]
  );

  let html = `
    <div class="breadcrumb">
      <button class="back-btn" id="backHome">‹ 처음으로</button>
      <span class="step-label">${escapeHtml(chosenMain)}</span>
    </div>`;

  if (subs.length === 0) {
    html += `<div class="card"><div class="empty">이 분류에 등록된 자재가 없어요.</div></div>`;
  } else {
    html += `<div class="card choice-list">`;
    for (const sub of subs) {
      const n = selectedCountInSub(chosenMain, sub);
      html += `
        <button class="choice-row" data-sub="${escapeHtml(sub)}">
          <span class="label">${escapeHtml(sub)}</span>
          <span class="right">
            ${n > 0 ? `<span class="count-badge">${n}</span>` : ""}
            <span class="arrow">›</span>
          </span>
        </button>`;
    }
    html += `</div>`;
  }

  const pendingN = pendingCountInMain(chosenMain);
  html += `
    <button class="btn ${pendingN > 0 ? "gold" : "secondary"} block" id="submitFromSub">
      ${escapeHtml(chosenMain)} 발주 요청하기${pendingN > 0 ? ` (${pendingN})` : ""}
    </button>`;

  screenEl.innerHTML = html;
  document.getElementById("backHome").addEventListener("click", () => { view = "main"; render(); });
  document.getElementById("submitFromSub").addEventListener("click", () => submitCategory(chosenMain));
  screenEl.querySelectorAll("[data-sub]").forEach((el) => {
    el.addEventListener("click", () => {
      chosenSub = el.dataset.sub;
      view = "items";
      discardDraft();
      render();
    });
  });
}

function renderItems() {
  const list = materials.filter((m) => m.mainCategory === chosenMain && m.subCategory === chosenSub);

  let html = `
    <div class="breadcrumb">
      <button class="back-btn" id="backSub">‹ ${escapeHtml(chosenMain)}</button>
      <span class="step-label">${escapeHtml(chosenSub)}</span>
    </div>`;

  if (list.length === 0) {
    html += `<div class="card"><div class="empty">등록된 자재가 없어요.</div></div>`;
  } else {
    for (const m of list) {
      const isLocked = !!synced[m.id];
      const state = effectiveState(m.id) || {};
      const selected = !!state.urgency;
      const ordered = isLocked && synced[m.id].ordered;
      html += `
        <div class="item-card ${selected ? "selected" : ""} ${isLocked ? "locked" : ""}">
          ${selected && !isLocked ? `<button class="cart-remove-btn" data-cart-remove="${m.id}">장바구니에서 빼기</button>` : ""}
          <div class="name">${escapeHtml(m.name)}</div>
          <div class="urgency-row">
            ${URGENCY_ORDER.map((u) => `
              <button class="urgency-btn ${u} ${state.urgency === u ? "active" : ""}" data-id="${m.id}" data-urgency="${u}" ${isLocked ? "disabled" : ""}>
                ${URGENCY_LABEL[u]}<span class="hint">${URGENCY_HINT[u]}</span>
              </button>`).join("")}
          </div>
          ${selected ? `
            <div class="row-between" style="margin-top:8px;">
              <span class="tag ${isLocked ? "submitted" : "pending"}">${isLocked ? "제출됨 · 수정 불가" : "미제출 · 아직 사장님께 전달 안 됨"}</span>
              ${isLocked && canDelete(synced[m.id]) ? `<button class="icon-btn" data-remove="${m.id}" style="color:var(--urgent);">삭제</button>` : ""}
            </div>
            ${ordered ? `<div class="tag ordered" style="margin-top:4px;">✓ 사장님이 주문 완료 처리했어요${formatTimestampLabel(synced[m.id].orderedAt) ? ` (${formatTimestampLabel(synced[m.id].orderedAt)})` : ""}</div>` : ""}
            <div style="font-size:11px; color:var(--muted); margin-top:6px;">${yesterdayStatusLabel(m.id)}</div>
            <div class="note-box show" style="display:flex; gap:8px;">
              <input type="text" placeholder="남은수량 (예: 2개)" data-id="${m.id}" class="qty-input" value="${escapeHtml(state.qty || "")}" ${isLocked ? "readonly" : ""} style="flex:1;" />
              <input type="text" placeholder="메모" data-id="${m.id}" class="note-input" value="${escapeHtml(state.note || "")}" ${isLocked ? "readonly" : ""} style="flex:1;" />
            </div>
            <div class="photo-attach-row">
              <input type="file" accept="image/*" data-photo-input="${m.id}" style="display:none;" />
              ${state.photoUrl ? `
                <div class="photo-preview">
                  <a href="${state.photoUrl}" target="_blank" rel="noopener"><img src="${state.photoUrl}" alt="첨부 사진" /></a>
                  ${!isLocked ? `<button class="photo-remove-btn" data-photo-remove="${m.id}">✕</button>` : ""}
                </div>` : (!isLocked ? `<button class="photo-add-btn" data-photo-trigger="${m.id}">📷 사진 첨부</button>` : "")}
            </div>` : ""}
        </div>`;
    }
    const n = Object.values(draft).filter((d) => !d.removed).length;
    html += `
      <button class="btn ${n > 0 ? "gold" : "secondary"} block" id="addToCartBtn" style="margin-top:4px;">
        장바구니 담기${n > 0 ? ` (${n})` : ""}
      </button>`;
  }

  screenEl.innerHTML = html;
  document.getElementById("backSub").addEventListener("click", () => { discardDraft(); view = "sub"; render(); });
  const addToCartBtn = document.getElementById("addToCartBtn");
  if (addToCartBtn) {
    addToCartBtn.addEventListener("click", () => {
      const n = Object.values(draft).filter((d) => !d.removed).length;
      commitDraft();
      toast(n > 0 ? `장바구니에 담았어요 (${n}개)` : "새로 선택된 자재가 없어요");
      // Stay in the browsing flow (back to the subcategory list) instead of
      // jumping to the cart — staff often pick from several subcategories in
      // a row, and the 담은 목록 bottom tab is always there once they're
      // ready to review everything and submit.
      view = "sub";
      render();
    });
  }
  screenEl.querySelectorAll(".urgency-btn").forEach((el) => {
    el.addEventListener("click", () => onUrgencyClick(el.dataset.id, el.dataset.urgency));
  });
  screenEl.querySelectorAll(".note-input").forEach((el) => {
    el.addEventListener("input", (e) => onNote(e.target.dataset.id, e.target.value));
  });
  screenEl.querySelectorAll(".qty-input").forEach((el) => {
    el.addEventListener("input", (e) => onQty(e.target.dataset.id, e.target.value));
  });
  screenEl.querySelectorAll("[data-remove]").forEach((el) => {
    el.addEventListener("click", () => deleteSubmittedItem(el.dataset.remove));
  });
  screenEl.querySelectorAll("[data-cart-remove]").forEach((el) => {
    el.addEventListener("click", () => removeSelectedItem(el.dataset.cartRemove));
  });
  screenEl.querySelectorAll("[data-photo-trigger]").forEach((el) => {
    el.addEventListener("click", () => {
      screenEl.querySelector(`[data-photo-input="${el.dataset.photoTrigger}"]`).click();
    });
  });
  screenEl.querySelectorAll("[data-photo-input]").forEach((el) => {
    el.addEventListener("change", (e) => onPhotoSelected(el.dataset.photoInput, e.target.files[0]));
  });
  screenEl.querySelectorAll("[data-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => onPhotoRemove(el.dataset.photoRemove));
  });
}

function renderCart() {
  const isTodayCart = cartDate === date;
  let html = `
    <div class="breadcrumb">
      <button class="back-btn" id="backHome2">‹ 처음으로</button>
      <span class="step-label">담은 목록</span>
    </div>
    <div class="card">
      <div class="field" style="margin:0">
        <label>최근 7일 (누구나 볼 수 있어요)</label>
        <div class="day-chip-row" id="cartDayChips"></div>
      </div>
    </div>
    ${isTodayCart ? `<button class="btn secondary block" id="addMoreBtn" style="margin-bottom:14px;">장바구니 더 담기</button>` : ""}`;

  if (cartItems.length === 0) {
    html += `<div class="card"><div class="cart-empty">이 날짜엔 담긴 자재가 없어요.</div></div>`;
    screenEl.innerHTML = html;
    wireCartNav();
    return;
  }

  const byMain = {};
  for (const it of cartItems) {
    const m = it.mainCategory || "기본자재";
    if (!byMain[m]) byMain[m] = [];
    byMain[m].push(it);
  }

  for (const main of MAIN_CATS) {
    if (!byMain[main]) continue;
    html += `<div class="category-title">${escapeHtml(main)}<span class="sub">${byMain[main].length}건</span></div>`;

    const bySub = {};
    for (const it of byMain[main]) {
      const sub = it.subCategory || "기타";
      if (!bySub[sub]) bySub[sub] = [];
      bySub[sub].push(it);
    }

    html += `<div class="card">`;
    const subs = Object.keys(bySub);
    subs.forEach((sub, idx) => {
      html += `<div class="subcat-title" style="${idx === 0 ? "margin-top:0" : "margin-top:14px"}">${escapeHtml(sub)}</div>`;
      for (const it of bySub[sub]) {
        html += `
          <div class="item-row ${it.ordered ? "ordered" : ""}">
            <div style="flex:1">
              <div class="name"><span class="dot ${it.urgency}"></span>${escapeHtml(it.materialName)}${it.qty ? `<span class="qty-pill">${escapeHtml(it.qty)} 남음</span>` : ""}</div>
              ${it.note ? `<div class="note">${escapeHtml(it.note)}</div>` : ""}
              ${it.photoUrl ? `<a href="${it.photoUrl}" target="_blank" rel="noopener"><img src="${it.photoUrl}" class="note-photo-thumb" alt="첨부 사진" /></a>` : ""}
              ${it.staffName ? `<div class="who">${escapeHtml(it.staffName)}님${formatTimeLabel(it.updatedAt) ? ` · ${formatTimeLabel(it.updatedAt)}` : ""}</div>` : ""}
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
              <span class="badge ${it.urgency}">${URGENCY_LABEL[it.urgency] || it.urgency}</span>
              ${isTodayCart ? `<span class="tag ${it.submitted ? "submitted" : "pending"}">${it.submitted ? "제출됨" : "미제출"}</span>` : ""}
              ${it.ordered ? `<span class="tag ordered">✓ 주문완료</span>` : ""}
              ${it.ordered && formatTimestampLabel(it.orderedAt) ? `<span style="font-size:10px; color:var(--muted); text-align:right;">${formatTimestampLabel(it.orderedAt)}</span>` : ""}
              ${isTodayCart && it.submitted && canDelete(it) ? `<button class="icon-btn" data-remove="${it.id}" style="color:var(--urgent); padding:2px 4px; font-size:11px;">삭제</button>` : ""}
              ${isTodayCart && !it.submitted ? `<button class="icon-btn" data-cart-cancel="${it.id}" style="color:var(--urgent); padding:2px 4px; font-size:11px;">취소</button>` : ""}
            </div>
          </div>`;
      }
    });
    html += `</div>`;

    if (isTodayCart) {
      const pendingN = pendingCountInMain(main);
      html += `
        <button class="btn ${pendingN > 0 ? "gold" : "secondary"} block" data-submit="${main}" style="margin-bottom:18px;">
          ${escapeHtml(main)} 발주 요청하기${pendingN > 0 ? ` (${pendingN})` : ""}
        </button>`;
    }
  }

  screenEl.innerHTML = html;
  wireCartNav();
}

function renderShare() {
  screenEl.innerHTML = `
    <div class="breadcrumb">
      <button class="back-btn" id="backHomeShare">‹ 처음으로</button>
      <span class="step-label">공유하기</span>
    </div>
    <div id="shareBoardRoot"></div>`;
  document.getElementById("backHomeShare").addEventListener("click", () => { view = "main"; render(); });
  mountShareBoard(document.getElementById("shareBoardRoot"), { name: staffName, phone: staffPhone });
}

function wireCartNav() {
  document.getElementById("backHome2").addEventListener("click", () => { view = "main"; render(); });
  const addMoreBtn = document.getElementById("addMoreBtn");
  if (addMoreBtn) addMoreBtn.addEventListener("click", () => { view = "main"; render(); });

  const chipsEl = document.getElementById("cartDayChips");
  chipsEl.innerHTML = recentDates
    .map((d) => {
      const { dow, dnum } = dowLabel(d);
      const count = chipCounts[d] || 0;
      const active = d === cartDate;
      return `
        <button class="day-chip ${active ? "active" : ""}" data-date="${d}">
          <div class="dow">${d === date ? "오늘" : dow}</div>
          <div class="dnum">${dnum}</div>
          <div class="dcount">${count > 0 ? count + "건" : ""}</div>
        </button>`;
    })
    .join("");
  chipsEl.querySelectorAll("[data-date]").forEach((el) => {
    el.addEventListener("click", () => {
      cartDate = el.dataset.date;
      loadCartDate(cartDate);
    });
  });

  screenEl.querySelectorAll("[data-submit]").forEach((el) => {
    el.addEventListener("click", () => submitCategory(el.dataset.submit));
  });
  screenEl.querySelectorAll("[data-remove]").forEach((el) => {
    el.addEventListener("click", () => deleteSubmittedItem(el.dataset.remove));
  });
  screenEl.querySelectorAll("[data-cart-cancel]").forEach((el) => {
    el.addEventListener("click", () => cancelPendingCartItem(el.dataset.cartCancel));
  });
}

function cancelPendingCartItem(id) {
  const p = pending[id];
  if (!p) return;
  if (!confirm(`'${p.materialName}'을(를) 장바구니에서 뺄까요?`)) return;
  delete pending[id];
  savePending();
  cartItems = buildTodayCartItems();
  render();
}

function canDelete(m) {
  return m.staffPhone === staffPhone;
}

// Quick one-click removal from the item-selection screen itself, for a
// material that's selected but not yet submitted — whether it's only an
// uncommitted draft pick or already sitting in the cart (pending).
function removeSelectedItem(id) {
  if (synced[id]) return; // already submitted — use the separate 삭제 flow
  const m = materials.find((x) => x.id === id);
  if (!confirm(`'${m ? m.name : "이 자재"}'을(를) 장바구니에서 뺄까요?`)) return;
  if (id in draft && !draft[id].removed) {
    draft[id] = { removed: true };
  } else if (pending[id]) {
    delete pending[id];
    savePending();
  }
  render();
}

async function deleteSubmittedItem(id) {
  const m = synced[id];
  if (!m) return;
  if (!canDelete(m)) {
    toast("본인이 요청한 자재만 삭제할 수 있어요");
    return;
  }
  if (!confirm(`'${m.materialName}'을(를) 삭제할까요? 사장님 화면에서도 바로 사라집니다.`)) return;
  await deleteDoc(doc(itemsCol, id));
  toast("삭제했어요");
}

function upsertDraft(id, overrides) {
  const current = effectiveState(id) || {};
  const m = materials.find((x) => x.id === id);
  if (!m) return;
  draft[id] = {
    action: "set",
    materialName: m.name,
    mainCategory: m.mainCategory || "기본자재",
    subCategory: m.subCategory || "기타",
    urgency: current.urgency,
    note: current.note || "",
    qty: current.qty || "",
    photoUrl: current.photoUrl || "",
    staffName,
    ...overrides,
  };
}

async function onPhotoSelected(id, file) {
  if (!file) return;
  if (synced[id]) return; // locked, ignore
  if (!effectiveState(id)) {
    toast("먼저 긴급도를 선택해주세요");
    return;
  }
  toast("사진 업로드 중...");
  try {
    const blob = await resizeImageFile(file);
    const path = `notePhotos/${date}/${staffPhone}_${id}_${Date.now()}.jpg`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
    const url = await getDownloadURL(fileRef);
    upsertDraft(id, { photoUrl: url });
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

function onPhotoRemove(id) {
  if (synced[id]) return; // locked, ignore
  if (!effectiveState(id)) return;
  upsertDraft(id, { photoUrl: "" });
  render();
}

function onUrgencyClick(id, urgency) {
  if (synced[id]) {
    // Already submitted to the owner — locked, cannot be changed or cancelled here.
    toast("이미 제출된 자재는 수정할 수 없어요");
    return;
  }

  const current = effectiveState(id);
  if (current && current.urgency === urgency) {
    draft[id] = { removed: true };
    render();
    return;
  }
  upsertDraft(id, { urgency });
  render();
}

function onNote(id, note) {
  if (synced[id]) return; // locked, ignore
  if (!effectiveState(id)) return;
  upsertDraft(id, { note });
}

function onQty(id, qty) {
  if (synced[id]) return; // locked, ignore
  if (!effectiveState(id)) return;
  upsertDraft(id, { qty });
}

async function submitCategory(main) {
  const entries = Object.entries(pending).filter(([, p]) => p.mainCategory === main);
  if (entries.length === 0) {
    toast("제출할 변경사항이 없어요");
    return;
  }
  for (const [id, p] of entries) {
    const ref = doc(itemsCol, id);
    if (p.action === "delete") {
      await deleteDoc(ref);
    } else {
      await setDoc(ref, {
        materialName: p.materialName,
        mainCategory: p.mainCategory,
        subCategory: p.subCategory,
        urgency: p.urgency,
        note: p.note || "",
        qty: p.qty || "",
        photoUrl: p.photoUrl || "",
        ordered: false,
        staffName,
        staffPhone,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }
    delete pending[id];
  }
  savePending();
  if (view === "cart") cartItems = buildTodayCartItems();
  render();
  toast(`${main} 발주 요청을 보냈어요`);
}

async function main() {
  const account = await requireAccount("staff");
  if (!account) return;
  staffName = account.name;
  staffPhone = account.phone;
  // Owner accounts can land here too (self-ordering on a solo shift) — auth.js
  // lets that through as a special case, so surface a way back and label the
  // account caption accurately instead of always saying "직원 계정".
  const isOwnerVisiting = account.role === "owner";
  wireAccountHeaderAvatar(document.getElementById("accountName"), account, isOwnerVisiting ? "사장님 계정 (발주 화면)" : "직원 계정");
  if (isOwnerVisiting) document.getElementById("backToOwnerBtn").style.display = "block";

  // Deep-linked here from a push notification (see functions/index.js's
  // `link` field) — land straight on the relevant tab instead of always
  // opening to 자재선택.
  const linkedView = new URLSearchParams(location.search).get("view");
  if (linkedView === "cart") {
    view = "cart";
    cartDate = date;
  } else if (linkedView === "share") {
    view = "share";
  }

  watchForegroundPush();
  watchAppBadgeClear();
  if (Notification.permission === "granted") registerPushToken(staffPhone);

  loadPending();
  itemsCol = collection(db, "checks", date, "items");

  onSnapshot(collection(db, "materials"), (snap) => {
    materials = sortMaterials(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    render();
  });

  onSnapshot(doc(db, "config", "subcategoryOrder"), (snap) => {
    subcategoryOrder = snap.exists() ? snap.data() : {};
    render();
  });

  onSnapshot(itemsCol, (snap) => {
    const newSynced = {};
    snap.docs.forEach((d) => { newSynced[d.id] = d.data(); });

    synced = newSynced;

    // Enforce "submitted items are locked" retroactively: drop any leftover
    // local draft that targets something already submitted (e.g. from before
    // this rule existed, or from another device's stale localStorage copy).
    let pendingChanged = false;
    for (const id of Object.keys(pending)) {
      if (synced[id]) { delete pending[id]; pendingChanged = true; }
    }
    if (pendingChanged) savePending();

    chipCounts[date] = snap.size;
    if (view === "cart" && cartDate === date) {
      cartItems = buildTodayCartItems();
    }
    render();
  });

  // Start the share-board listener right away so the bottom tab's
  // unseen-count badge is live even before the user opens 공유하기.
  const shareNavBadge = document.getElementById("shareNavBadge");
  watchUnseenCount({ name: staffName, phone: staffPhone }, () => {
    const n = getTodayUnseenCount(staffPhone);
    if (n > 0) { shareNavBadge.textContent = "N"; shareNavBadge.style.display = "flex"; }
    else shareNavBadge.style.display = "none";
  });

  loadAllChipCounts();
  loadYesterdayItems();
  updateNotifyBtn();
  render();
  scrollTopSafely();
}

main();
