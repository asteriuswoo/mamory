import { db, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, getDocs, query, orderBy, serverTimestamp, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { requireAccount, logout } from "./auth.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimestampLabel, formatTimeLabel, toast, escapeHtml, openImageLightbox, URGENCY_LABEL, URGENCY_HINT, URGENCY_ORDER, URGENCY_GROUP_CAPTION, sortMaterials, sortByOrder, resizeImageFile, confirmModal, dayAccentClass, NOTIFY_BELL_ON, qtyRemainingLabel, MULTIPLE_FILE_ATTR } from "./util.js";
import { mountShareBoard, hasUnseenShareActivity, watchUnseenCount, setInitialShareTab, setInitialShareDate, markShareNavBadgeSeen } from "./shareboard.js";
import { mountRegisterBoard, watchRegisterUnseen, hasUnseenRegisterActivity } from "./registerboard.js";
import { mountPayrollBoard, mountClockWidget } from "./payroll.js";
import { registerPushToken, watchForegroundPush, watchNotificationBadge, openNotificationPanel } from "./push.js";
import { wireAccountHeaderAvatar } from "./avatar.js";
import { watchAppBadgeClear } from "./badge.js";
import { mountMascotWidget, earnFood } from "./mascot.js";
import { mountHumanityTrigger } from "./humanityboard.js";
import { mountMusicBar } from "./musicbar.js";

document.addEventListener("click", (e) => {
  const img = e.target.closest("[data-receipt-lightbox]");
  if (!img) return;
  openImageLightbox(img.dataset.receiptLightbox, "영수증");
});

document.getElementById("dateLabel").textContent = formatDateLabel(todayStr());
document.getElementById("logoutBtn").addEventListener("click", logout);
document.getElementById("refreshBtn").addEventListener("click", () => window.forceAppRefresh());

document.getElementById("deleteAccountBtn").addEventListener("click", async () => {
  const ok = await confirmModal("정말 떠나실 건가요?", "네! 이제 퇴사합니다🥲", "아니요! 돌아갈래요😊");
  if (!ok || !staffPhone) return;
  await deleteDoc(doc(db, "accounts", staffPhone));
  logout();
});

// 종 아이콘은 이제 켜짐/꺼짐을 자기가 보여주지 않는다 — 탭하면 뜨는
// 알림내역 패널 안에 푸시 on/off 토글이 있고, 종 자체는 고정 아이콘 +
// 안 읽은 알림 개수 배지만 보여준다(push.js의 watchNotificationBadge).
const notifyBtn = document.getElementById("notifyBtn");
const notifyBadgeEl = document.getElementById("notifyBadge");
notifyBtn.innerHTML = NOTIFY_BELL_ON;
notifyBtn.addEventListener("click", () => openNotificationPanel(staffPhone));

const screenEl = document.getElementById("screen");

const date = todayStr();
const PENDING_KEY = "cafe_pending_" + date;
// 이월된(어제 미주문) 자재를 "취소"로 뺀 적 있으면 기억해둔다 — 안 그러면
// 새로고침마다 loadCarryoverItems()가 "아직 pending에 없네"라고 보고 매번
// 다시 집어넣어버린다. 날짜별 키라 다음날엔 자연히 초기화된다.
const DISMISSED_CARRYOVER_KEY = "cafe_dismissed_carryover_" + date;

let materials = [];
let yesterdayItems = {}; // materialId -> yesterday's checks/items doc data, for the "어제 요청/주문완료" hint
let subcategoryOrder = {}; // { 기본자재: string[], 식자재: string[] } from config/subcategoryOrder
let synced = {}; // materialId -> data actually submitted to Firestore today
let pending = {}; // materialId -> {action:'set', ...fields} | {action:'delete', mainCategory}
// 2일마다 자동으로 담기는 고정 자재(functions/index.js: autoRequestFixedMaterials)
// — 아직 아무도 제출 안 한, 장바구니에만 걸쳐 있는 상태. materialId -> data.
let autoPending = {};
// Uncommitted picks made while browsing the current items screen. Nothing
// here is persisted or counted anywhere until "장바구니 담기" is pressed —
// pressing the back button instead just throws it away.
let draft = {}; // materialId -> {action:'set', ...fields} | {removed:true}
let itemsCol;
let staffName = "";
let staffPhone = "";
let staffRole = "staff";

// nav state
let view = "main"; // main | sub | items | cart | share
let chosenMain = null;
let chosenSub = null;
let subSearchQuery = ""; // 소분류 목록 화면의 자재명 검색어
let cartSearchQuery = ""; // 담은 목록 화면의 자재명 검색어 — 어제 요청한 걸 또
                           // 중복으로 담지 않으려고, 스크롤 없이 바로 찾기 위함
let highlightMaterialId = null; // 검색 결과 선택 직후, 그 자재 카드로 스크롤+하이라이트하기 위한 1회용 표시

// history (cart) state
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));
const chipCounts = {};
let cartDate = date;
let cartItems = [];

// ---- 사장님이 첨부한 영수증 보기 (담은 목록 탭) ----
let showOwnerReceiptsOverlay = false;
let ownerReceiptsLoading = false;
let ownerDayReceiptPhotos = []; // 지금 보고 있는 cartDate의 "전체 영수증" — 필요할 때만 한 번 불러온다

// 담은 목록 탭을 열어보지 않아도 오늘 사장님이 첨부한 영수증 개수를
// 실시간으로 알 수 있게 — 날짜 칩 바로 아래 클립 칩의 N배지 숫자로 쓴다.
let todayOwnerReceiptCount = 0;
// 과거 날짜를 볼 때는 실시간 구독이 없어서, 날짜 칩을 눌러 그 날짜로
// 넘어갈 때(loadCartDate) 한 번 불러와 둔다 — 0건이면 칩 자체를 숨긴다.
let cartDateReceiptCount = 0;

// Cart item ids currently showing the inline "다른 상태로 바꾸기" picker.
const statusPickerFor = new Set();
// Cart item ids currently showing the "남은 수량 수정" input (대신 평소엔
// "OO남음" 배지만 보여서 목록이 입력창으로 가득 차지 않는다).
const qtyEditingFor = new Set();

const MAIN_CATS = ["기본자재", "식자재"];
const MAIN_DESC = {
  기본자재: "컵, 뚜껑, 빨대, 감열지, 냅킨, 원두, 기타",
  식자재: "파우더, 시럽/소스, 베이스, 디저트, 냉동, 탄산",
};

// 품목명 옆에 작게 표시할 정상발주/긴급 판단 기준.
const MATERIAL_ORDER_CRITERIA = {
  아이스M컵: { normal: "12줄 이상", urgent: "10줄 미만" },
  일반돔뚜껑: { normal: "12줄 이상", urgent: "10줄 미만" },
};

function renderOrderCriteriaHint(materialName) {
  const c = MATERIAL_ORDER_CRITERIA[materialName];
  if (!c) return "";
  return `<div class="order-criteria-hint">여유 ${escapeHtml(c.normal)} · 긴급 ${escapeHtml(c.urgent)}</div>`;
}

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

let dismissedCarryovers = new Set();
function loadDismissedCarryovers() {
  try {
    dismissedCarryovers = new Set(JSON.parse(localStorage.getItem(DISMISSED_CARRYOVER_KEY) || "[]"));
  } catch (e) {
    dismissedCarryovers = new Set();
  }
}
function saveDismissedCarryovers() {
  localStorage.setItem(DISMISSED_CARRYOVER_KEY, JSON.stringify([...dismissedCarryovers]));
}

// 옛 발주 항목은 photoUrl(단수) 하나였고, 지금은 여러 장을 담는
// photoUrls(배열)로 바뀌었다 — 어느 쪽으로 저장됐든 한 번에 뽑아 쓴다.
function materialPhotoUrlsOf(it) {
  if (it.photoUrls && it.photoUrls.length > 0) return it.photoUrls;
  return it.photoUrl ? [it.photoUrl] : [];
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

// 위 reflow(화면 전환 시점 보정)만으론 부족했다 — 실제로 더 자주 겹치는 건
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

// 자재 이름 검색창에 포커스하는 순간 모바일 키보드가 화면 아래쪽 상당
// 부분을 가린다 — 처음엔 스크롤로 입력창을 키보드 위로 끌어올려봤지만,
// 키보드가 열리는 애니메이션 도중 하단 탭바까지 같이 들썩여서 오히려
// 더 어지러웠다. 그래서 검색창에 포커스하면 입력창+결과 리스트만 화면
// 전체를 차지하는 전용 모드로 전환한다 — 다른 고정 UI(상단바/하단
// 탭바)는 그 밑에 그대로 있지만 이 오버레이가 화면 전체를 덮어버려서
// 키보드가 열리든 말든 같이 흔들리는 것처럼 보이지 않는다.
let searchFullscreenMode = null; // null | "sub" | "cart"

function searchFullscreenQuery() {
  if (searchFullscreenMode === "sub") return subSearchQuery;
  if (searchFullscreenMode === "cart") return cartSearchQuery;
  return "";
}

function searchFullscreenResultsHtml(query) {
  if (searchFullscreenMode === "sub") {
    if (!query.trim()) return `<div class="card"><div class="empty">자재 이름을 입력해보세요</div></div>`;
    return subSearchResultsHtml(query);
  }
  if (searchFullscreenMode === "cart") {
    return cartGroupedItemsHtml(displayedCartItemsFor(query), cartDate === date, query);
  }
  return "";
}

function searchFullscreenPlaceholder() {
  return searchFullscreenMode === "sub" ? "자재 이름으로 검색" : "자재 이름으로 검색 (이미 요청했는지 확인)";
}

function openSearchFullscreen(mode) {
  searchFullscreenMode = mode;
  renderSearchFullscreen();
}

function closeSearchFullscreen() {
  if (!searchFullscreenMode) return;
  searchFullscreenMode = null;
  if (subSearchQuery) subSearchQuery = "";
  if (cartSearchQuery) cartSearchQuery = "";
  const root = document.getElementById("searchFullscreenRoot");
  if (root) root.innerHTML = "";
}

// render()가 호출될 때마다(검색 중이 아닌 다른 화면 상태 변화로도) 전체
// 화면 모드가 열려있다면 그 결과 리스트도 같이 최신 상태로 맞춰준다 —
// 예를 들어 전체 화면 검색 중에 수량을 바꾸거나 상태를 토글하면 그 변경이
// 바로 보여야 한다. 컨테이너 자체(#searchFullscreenResults)는 안 바뀌고
// 내용만 갈아끼우므로, 거기 걸어둔 delegated 클릭 리스너는 그대로 유지된다.
function refreshSearchFullscreenResults() {
  if (!searchFullscreenMode) return;
  const resultsEl = document.getElementById("searchFullscreenResults");
  if (resultsEl) resultsEl.innerHTML = searchFullscreenResultsHtml(searchFullscreenQuery());
}

function renderSearchFullscreen() {
  const root = document.getElementById("searchFullscreenRoot");
  if (!root) return;
  if (!searchFullscreenMode) { root.innerHTML = ""; return; }
  const query = searchFullscreenQuery();
  root.innerHTML = `
    <div class="search-fullscreen-overlay">
      <div class="sub-search-wrap">
        <input type="text" id="searchFullscreenInput" class="sub-search-input" placeholder="${searchFullscreenPlaceholder()}" value="${escapeHtml(query)}" />
        <button type="button" class="search-fullscreen-cancel-btn" id="searchFullscreenCancelBtn">취소</button>
      </div>
      <div class="search-fullscreen-results" id="searchFullscreenResults">${searchFullscreenResultsHtml(query)}</div>
    </div>`;
  const input = document.getElementById("searchFullscreenInput");
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  // 결과 리스트만 갈아끼우고 입력창 자체는 절대 건드리지 않는다 — 전체를
  // 다시 그리면(render()) 한글 조합 중 입력창 DOM이 깨지는 문제가 있다.
  input.addEventListener("input", (e) => {
    const q = e.target.value;
    if (searchFullscreenMode === "sub") subSearchQuery = q;
    else if (searchFullscreenMode === "cart") cartSearchQuery = q;
    const resultsEl = document.getElementById("searchFullscreenResults");
    if (resultsEl) resultsEl.innerHTML = searchFullscreenResultsHtml(q);
  });
  document.getElementById("searchFullscreenCancelBtn").addEventListener("click", () => {
    closeSearchFullscreen();
    render();
  });
  document.getElementById("searchFullscreenResults").addEventListener("click", (e) => {
    if (searchFullscreenMode === "sub") {
      const resultEl = e.target.closest("[data-search-result]");
      if (!resultEl) return;
      const m = materials.find((x) => x.id === resultEl.dataset.searchResult);
      if (!m) return;
      chosenSub = m.subCategory;
      highlightMaterialId = m.id;
      view = "items";
      closeSearchFullscreen();
      discardDraft();
      render();
      return;
    }
    if (searchFullscreenMode === "cart") handleCartItemsListClick(e);
  });
}

function goToCart() {
  discardDraft();
  view = "cart";
  cartDate = date;
  cartSearchQuery = "";
  loadCartDate(cartDate); // renders internally for today's date
  scrollTopSafely();
}

function updateBottomTabActive() {
  const activeKey = { main: "main", sub: "main", items: "main", cart: "cart", share: "share", register: "register", payroll: "payroll" }[view] || "main";
  document.querySelectorAll(".bottom-tab[data-nav]").forEach((el) => {
    el.classList.toggle("active", el.dataset.nav === activeKey);
  });
  syncViewToUrl();
}

// 새로고침(버튼이든 스와이프든)해도 지금 보던 탭에 그대로 있도록, 현재
// view를 주소창 쿼리에 남겨둔다 — main()이 시작할 때 알림 딥링크와 똑같은
// 방식으로 이 값을 다시 읽어서 그 탭으로 바로 연다. render()가 호출될 때마다
// 함께 불려서, view가 바뀌는 모든 곳을 일일이 손대지 않아도 항상 최신
// 상태로 맞춰진다.
function syncViewToUrl() {
  const linkable = { cart: "cart", share: "share", register: "register", payroll: "payroll" }[view] || null;
  const url = new URL(location.href);
  if (url.searchParams.get("view") === linkable) return;
  if (linkable) url.searchParams.set("view", linkable);
  else url.searchParams.delete("view");
  history.replaceState(null, "", url);
}

document.querySelectorAll(".bottom-tab[data-nav]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const nav = btn.dataset.nav;
    if (nav === "share") {
      markShareNavBadgeSeen();
      const badge = document.getElementById("shareNavBadge");
      if (badge) badge.style.display = "none";
    }
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
  const seen = new Set();
  allKnownIds().forEach((id) => {
    const eff = effectiveState(id);
    if (!eff) return;
    list.push({ id, ...eff, submitted: !pending[id] });
    seen.add(id);
  });
  // 2일마다 자동으로 담긴 고정 자재 — 누군가 이미 같은 자재를 직접
  // 골랐거나 제출했으면(위에서 이미 목록에 들어갔으면) 중복 표시하지 않는다.
  Object.keys(autoPending).forEach((id) => {
    if (seen.has(id)) return;
    list.push({ id, ...autoPending[id], submitted: false, autoAdded: true });
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
    const checkDocSnap = await getDoc(doc(db, "checks", targetDate));
    cartDateReceiptCount = (checkDocSnap.exists() && checkDocSnap.data().allReceiptPhotosHistory || []).length;
  } catch (e) {
    cartItems = [];
    cartDateReceiptCount = 0;
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

// 사장님이 "전체 영수증"으로 첨부한 사진은 checks/{date}.allReceiptPhotosHistory에
// 공유해도 안 비워지는 기록으로 쌓인다(그날 체크 때마다 쓰고 비워지는
// receiptPhotos와는 다른 필드) — 특정 자재 하나만 콕 집어 첨부한 영수증
// (ownerAttachedPhotos)은 그 자재 카드에서 바로 보이니 여기 모아보기
// 대상에서는 뺀다. 자주 바뀌는 live 데이터가 아니라 "눌러서 확인하는"
// 용도라 overlay를 열 때 한 번만 불러온다.
async function openOwnerReceiptsOverlay() {
  showOwnerReceiptsOverlay = true;
  ownerReceiptsLoading = true;
  render();
  try {
    const snap = await getDoc(doc(db, "checks", cartDate));
    ownerDayReceiptPhotos = (snap.exists() && snap.data().allReceiptPhotosHistory) || [];
  } catch (e) {
    ownerDayReceiptPhotos = [];
  }
  ownerReceiptsLoading = false;
  render();
}

function closeOwnerReceiptsOverlay() {
  showOwnerReceiptsOverlay = false;
  render();
}

// 담은 목록의 "사장님께 알리기" 버튼 — 오늘 아직 주문완료 처리 안 된
// 건수를 그냥 한 번 상기시켜드리는 용도. 문서 하나만 남기면 functions/
// index.js의 notifyOwnerUnorderedReminder가 알림을 보낸다 — 알림
// 내용엔 누가 눌렀는지 일부러 안 담는다(익명 리마인더).
async function nudgeOwnerAboutUnordered() {
  const n = Object.values(synced).filter((it) => !it.ordered).length;
  if (n <= 0) {
    toast("오늘 미주문건이 없어요");
    return;
  }
  try {
    await addDoc(collection(db, "checks", date, "unorderedNudges"), {
      count: n,
      staffPhone,
      createdAt: serverTimestamp(),
    });
    toast("사장님께 알려드렸습니다 😊");
  } catch (e) {
    toast("알리기에 실패했어요 — 다시 시도해주세요");
  }
}

function ownerReceiptsOverlayHtml() {
  // 특정 자재 하나에만 콕 집어 첨부한 영수증(ownerAttachedPhotos)은 여기
  // 모아보기 대상이 아니다 — 그건 그 자재 카드 안에 댓글처럼 바로 붙어있으니
  // 거기서 보면 되고, 여긴 "전체 영수증"만 모아서 보여준다.
  const overallUrls = ownerDayReceiptPhotos;
  const empty = overallUrls.length === 0;
  return `
    <div class="payroll-form-overlay" id="ownerReceiptsOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">📎 사장님이 첨부한 영수증</div>
          <button class="payroll-form-close-btn" id="ownerReceiptsCloseBtn" aria-label="닫기">✕</button>
        </div>
        ${ownerReceiptsLoading ? `<div class="empty" style="margin-top:12px;">불러오는 중...</div>` : empty ? `<div class="empty" style="margin-top:12px;">아직 첨부된 전체 영수증이 없어요.</div>` : `
          <div class="receipt-photo-row" style="margin-top:12px;">${overallUrls.map((url) => `<img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />`).join("")}</div>
        `}
      </div>
    </div>`;
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

// 어제 요청했지만 사장님이 아직 주문완료 처리 안 한 자재는, 자재탭에서
// 다시 찾아 담지 않아도 오늘 담은 목록에 자동으로 다시 올라오게 한다 —
// "어제 요청드렸지만 주문되지 않았어요" 표시와 함께, 상태(긴급도)나 남은
// 수량만 고쳐서 바로 다시 제출할 수 있도록. 오늘 이미 같은 자재를 직접
// 담았거나 제출한 경우는 건너뛴다 — pending/synced 우선이 맞다.
//
// 세션당 한 번만 돈다: 매 렌더마다 다시 돌면, 직원이 이월된 항목을
// "취소"로 치워도 다음 렌더에 다시 살아나버린다. 혹시 타이밍상 이미
// synced된(오늘 직접 다시 제출한) 자재 위에 실수로 겹쳐 써도, 뒤이어
// 도착하는 items 실시간 리스너가 "이미 synced면 pending 지움" 정리를
// 해주므로 금방 바로잡힌다.
let carryoverLoaded = false;
async function loadCarryoverItems() {
  if (carryoverLoaded) return;
  carryoverLoaded = true;
  let changed = false;
  try {
    const snap = await getDocs(collection(db, "checks", dateStrDaysAgo(1), "items"));
    snap.docs.forEach((docSnap) => {
      const data = docSnap.data();
      const id = docSnap.id;
      if (data.ordered) return;
      // "주문완료" 체크는 깜빡했어도, 그 자재에 "선택 자재 영수증 첨부"로
      // 영수증 사진을 따로 붙여뒀으면 실제로는 이미 주문한 거다 — 체크만
      // 안 한 것뿐이라 또 요청할 필요가 없다.
      if (data.ownerAttachedPhotos && data.ownerAttachedPhotos.length > 0) return;
      if (synced[id] || pending[id]) return; // 오늘 이미 손댄 자재는 건너뛴다
      if (dismissedCarryovers.has(id)) return; // 오늘 이미 "취소"로 뺀 적 있으면 다시 안 넣는다
      pending[id] = {
        action: "set",
        materialName: data.materialName,
        mainCategory: data.mainCategory || "기본자재",
        subCategory: data.subCategory || "기타",
        urgency: data.urgency,
        note: data.note || "",
        qty: data.qty || "",
        orderQty: data.orderQty || 1,
        photoUrls: data.photoUrls || [],
        staffName,
        carriedOverFrom: true,
      };
      changed = true;
    });
  } catch (e) {
    // 어제 기록이 없으면 그냥 넘어간다.
  }
  if (changed) {
    savePending();
    cartItems = buildTodayCartItems();
    render();
  }
}

function yesterdayStatusLabel(materialId) {
  const y = yesterdayItems[materialId];
  if (!y) return "어제 발주요청 안 드린 자재예요";
  if (y.ordered) {
    const when = formatTimestampLabel(y.orderedAt);
    return `어제 요청 · 주문완료됨${when ? ` (${when})` : ""}`;
  }
  return "어제 요청드렸지만 주문되지 않음";
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
  const own = Object.values(pending).filter((p) => p.mainCategory === main).length;
  const auto = Object.values(autoPending).filter((p) => p.mainCategory === main).length;
  return own + auto;
}

function updateCartNavBadge() {
  const badge = document.getElementById("cartNavBadge");
  const n = Object.keys(pending).length;
  if (n > 0) { badge.textContent = "N"; badge.style.display = "flex"; }
  else badge.style.display = "none";
}

function render() {
  // staff.html의 인라인 스크립트가 새로고침 순간 기본(자재선택) 탭이 한
  // 프레임 보이는 걸 막으려고 #screen을 미리 숨겨두는 경우가 있다 — 실제
  // 렌더가 일어나는 지금, 그 숨김을 확실히 풀어준다.
  screenEl.style.display = "";
  updateBottomTabActive();
  updateCartNavBadge();
  refreshSearchFullscreenResults();
  // 홈(자재선택)에서만 계정 카드(아바타/로그아웃/출근도장/극한직업 버튼)를
  // 보여주고, 다른 탭들은 바로 그 탭의 내용으로 들어가게 한다 — 바텀탭을
  // 누르면 이미 자기 홈(여기서는 자재선택)으로 갈 수 있으니 매 탭마다
  // 계정 카드를 반복해서 보여줄 필요가 없다.
  const profileCard = document.getElementById("profileCard");
  const isHomeView = view === "main" || view === "sub" || view === "items";
  if (profileCard) profileCard.style.display = isHomeView ? "" : "none";
  const monthEndBanner = document.getElementById("monthEndBanner");
  if (monthEndBanner) monthEndBanner.style.display = (isHomeView && isLastDayOfMonth()) ? "block" : "none";
  const humanityBtn = document.getElementById("humanityBtn");
  if (humanityBtn) humanityBtn.style.display = isHomeView ? "" : "none";
  if (view === "main") return renderMain();
  if (view === "sub") return renderSub();
  if (view === "items") return renderItems();
  if (view === "cart") return renderCart();
  if (view === "share") return renderShare();
  if (view === "register") return renderRegister();
  if (view === "payroll") return renderPayroll();
}

function isLastDayOfMonth() {
  const today = new Date();
  return today.getDate() === new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
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
      subSearchQuery = "";
      view = "sub";
      render();
    });
  });
}

function matchingMaterialsInMain(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return sortMaterials(materials.filter((m) => m.mainCategory === chosenMain && m.name.toLowerCase().includes(q)));
}

function subSearchResultsHtml(query) {
  const results = matchingMaterialsInMain(query);
  if (results.length === 0) {
    return `<div class="card"><div class="empty">"${escapeHtml(query)}"와 일치하는 자재가 없어요.</div></div>`;
  }
  return `
    <div class="card choice-list">
      ${results.map((m) => `
        <button class="choice-row" data-search-result="${m.id}">
          <span class="label">${escapeHtml(m.name)}</span>
          <span class="right">
            <span class="subcat-inline-tag search-result-tag">${escapeHtml(m.subCategory)}</span>
            <span class="arrow">›</span>
          </span>
        </button>`).join("")}
    </div>`;
}

function renderSub() {
  const subs = sortByOrder(
    [...new Set(materials.filter((m) => m.mainCategory === chosenMain).map((m) => m.subCategory))],
    subcategoryOrder[chosenMain]
  );

  let html = `
    <div class="breadcrumb">
      <span class="step-label">${escapeHtml(chosenMain)}</span>
    </div>
    <div class="sub-search-wrap">
      <input type="text" id="subSearchInput" class="sub-search-input" placeholder="자재 이름으로 검색" value="" readonly />
    </div>
    <div class="sub-list-hint">지금 사용하는 분 제외하고 예비 여분의 수량만 기입해주세요</div>
    <div id="subCategoryGrid">`;

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
  html += `</div>`;

  const pendingN = pendingCountInMain(chosenMain);
  html += `
    <button class="btn ${pendingN > 0 ? "gold" : "secondary"} block" id="submitFromSub">
      ${escapeHtml(chosenMain)} 발주 요청하기${pendingN > 0 ? ` (${pendingN})` : ""}
    </button>`;

  screenEl.innerHTML = html;
  document.getElementById("submitFromSub").addEventListener("click", () => submitCategory(chosenMain));
  document.getElementById("subSearchInput").addEventListener("focus", () => openSearchFullscreen("sub"));
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
        <div class="item-card ${selected ? "selected" : ""} ${isLocked ? "locked" : ""}" data-material-card="${m.id}">
          ${selected && !isLocked ? `<button class="cart-remove-btn" data-cart-remove="${m.id}">장바구니에서 빼기</button>` : ""}
          <div class="name">${escapeHtml(m.name)}</div>
          ${renderOrderCriteriaHint(m.name)}
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
            <div class="note-box show">
              <div style="display:flex; gap:8px;">
                <div class="qty-input-wrap" style="flex:1;">
                  <input type="text" placeholder="${m.subCategory === "비품" ? "남은수량 (예: 2개)" : "남은 예비 수량 (예: 2개)"}" data-id="${m.id}" class="qty-input" value="${escapeHtml(state.qty || "")}" ${isLocked ? "readonly" : ""} />
                  ${m.subCategory === "비품" ? "" : `<span class="required-asterisk">*</span>`}
                </div>
                <input type="text" placeholder="메모" data-id="${m.id}" class="note-input" value="${escapeHtml(state.note || "")}" ${isLocked ? "readonly" : ""} style="flex:1;" />
              </div>
              <div style="display:flex; gap:8px; align-items:center; margin-top:6px;">
                <div style="flex:1;">
                  ${m.subCategory === "비품" ? "" : `<button type="button" class="qty-none-btn" data-qty-none="${m.id}" ${isLocked ? "disabled" : ""}>예비 없음</button>`}
                </div>
                <div class="order-qty-row" style="flex:1; margin-top:0;">
                  <span class="order-qty-label">요청 수량</span>
                  <div class="order-qty-stepper">
                    <button class="order-qty-btn" data-id="${m.id}" data-qty-delta="-1" ${isLocked ? "disabled" : ""}>−</button>
                    <span class="order-qty-value">${state.orderQty || 1}개</span>
                    <button class="order-qty-btn" data-id="${m.id}" data-qty-delta="1" ${isLocked ? "disabled" : ""}>+</button>
                  </div>
                </div>
              </div>
            </div>
            <div class="photo-attach-row" style="flex-wrap:wrap;">
              <input type="file" accept="image/*" data-photo-input="${m.id}" ${MULTIPLE_FILE_ATTR} style="display:none;" />
              ${(state.photoUrls || []).map((url, i) => `
                <div class="photo-preview">
                  <img src="${url}" data-receipt-lightbox="${url}" alt="첨부 사진" />
                  ${!isLocked ? `<button class="photo-remove-btn" data-photo-remove="${m.id}" data-photo-remove-index="${i}">✕</button>` : ""}
                </div>`).join("")}
              ${!isLocked ? `<button class="photo-add-btn" data-photo-trigger="${m.id}">📷 사진 첨부</button>` : ""}
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
  if (highlightMaterialId) {
    const targetId = highlightMaterialId;
    highlightMaterialId = null; // 한 번만 스크롤+강조하고, 이후 재렌더에선 다시 안 띄운다
    const card = screenEl.querySelector(`[data-material-card="${targetId}"]`);
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("material-card-highlight");
      card.addEventListener("animationend", () => card.classList.remove("material-card-highlight"), { once: true });
    }
  }
  document.getElementById("backSub").addEventListener("click", () => { discardDraft(); view = "sub"; render(); });
  const addToCartBtn = document.getElementById("addToCartBtn");
  if (addToCartBtn) {
    addToCartBtn.addEventListener("click", () => {
      const missingQty = Object.values(draft).some(
        (d) => !d.removed && d.urgency && d.subCategory !== "비품" && !(d.qty || "").trim()
      );
      if (missingQty) {
        toast("남은 예비 수량을 입력해주세요");
        return;
      }
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
  screenEl.querySelectorAll("[data-qty-none]").forEach((el) => {
    el.addEventListener("click", () => {
      const id = el.dataset.qtyNone;
      if (synced[id]) return; // locked, ignore
      upsertDraft(id, { urgency: "urgent", qty: "없음" });
      render();
    });
  });
  screenEl.querySelectorAll("[data-qty-delta]").forEach((el) => {
    el.addEventListener("click", () => onOrderQtyDelta(el.dataset.id, parseInt(el.dataset.qtyDelta, 10)));
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
    el.addEventListener("change", (e) => {
      onPhotosSelected(el.dataset.photoInput, Array.from(e.target.files || []));
      e.target.value = "";
    });
  });
  screenEl.querySelectorAll("[data-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => onPhotoRemove(el.dataset.photoRemove, Number(el.dataset.photoRemoveIndex)));
  });
}

function displayedCartItemsFor(query) {
  const q = query.trim().toLowerCase();
  return q ? cartItems.filter((it) => (it.materialName || "").toLowerCase().includes(q)) : cartItems;
}

function renderCart() {
  const isTodayCart = cartDate === date;
  const receiptCountForView = isTodayCart ? todayOwnerReceiptCount : cartDateReceiptCount;
  let html = `
    <div class="breadcrumb">
      <button class="back-btn" id="backHome2">‹ 자재 선택</button>
      <span class="step-label">담은 목록</span>
    </div>
    <div class="card">
      <div class="field" style="margin:0">
        <label>최근 7일 (누구나 볼 수 있어요)</label>
        <div class="day-chip-row" id="cartDayChips"></div>
      </div>
      ${receiptCountForView <= 0 ? "" : `
      <button type="button" class="receipt-clip-chip" id="ownerReceiptsBtn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        ${isTodayCart ? "오늘 " : ""}사장님이 첨부한 영수증<span class="receipt-clip-badge">${receiptCountForView}</span>
      </button>`}
    </div>`;

  if (cartItems.length === 0) {
    html += `<div class="card"><div class="cart-empty">이 날짜엔 담긴 자재가 없어요.</div></div>`;
    if (showOwnerReceiptsOverlay) html += ownerReceiptsOverlayHtml();
    screenEl.innerHTML = html;
    wireCartNav();
    return;
  }

  // 오늘 담은 목록엔 어제 이전부터 아직 주문 안 된 자재도 같이 섞여있어서,
  // "이거 어제 이미 요청했었나?" 확인하려고 매번 쭉 내려서 찾아야 했다 —
  // 자재명으로 바로 찾을 수 있게 검색창을 둔다.
  const displayedCartItems = displayedCartItemsFor(cartSearchQuery);

  if (isTodayCart) {
    html += `
    <div class="sub-search-wrap">
      <input type="text" id="cartSearchInput" class="sub-search-input" placeholder="자재 이름으로 검색 (이미 요청했는지 확인)" value="" readonly />
    </div>`;
  }

  html += `<div id="cartItemsList">${cartGroupedItemsHtml(displayedCartItems, isTodayCart, cartSearchQuery)}</div>`;

  if (showOwnerReceiptsOverlay) html += ownerReceiptsOverlayHtml();
  screenEl.innerHTML = html;
  wireCartNav();
}

// 검색창에 한글 입력 중 매번 전체 화면을 다시 그리면(render()) 한글
// 조합(초성+중성+종성)이 깨진다 — 조합 중에 입력창 DOM 자체가 통째로
// 교체되면 IME가 지금 어느 글자를 조합 중인지 잃어버려서 "흔들리고
// 받침이 안 붙는" 증상이 난다. 그래서 목록 부분만 따로 함수로 빼서,
// 검색어가 바뀔 때는 #cartItemsList의 내용만 갈아끼우고 입력창 자체는
// 절대 건드리지 않는다 (아래 wireCartNav의 delegated 리스너 참고).
function cartGroupedItemsHtml(items, isTodayCart, searchQuery) {
  if (searchQuery.trim() && items.length === 0) {
    return `<div class="card"><div class="empty">"${escapeHtml(searchQuery)}"와 일치하는 자재가 이 목록에 없어요.</div></div>`;
  }
  let html = "";

  function cartItemRowHtml(it, showSub) {
    // 제출된(공유된) 자재는 제출한 사람만 상태(보통/긴급/품절)를 바꿀 수
    // 있다 — canDelete와 같은 기준: staffPhone이 없는(자동 담김) 자재는
    // 누구 것도 아니라서 누구나 바꿀 수 있게 둔다.
    const canChangeStatus = isTodayCart && !it.ordered && (!it.staffPhone || it.staffPhone === staffPhone);
    const pickerOpen = statusPickerFor.has(it.id);
    const otherUrgencies = URGENCY_ORDER.filter((u) => u !== it.urgency);
    // 아직 제출 전(로컬 pending)인 자재는 남은 수량을 담은 뒤에도 "수정"
    // 버튼으로 고칠 수 있다 — 전에는 자재탭에서 처음 담을 때만 적을 수
    // 있고 담고 나면 못 고쳤는데, 이월된 자재는 수량이 바뀌어있을 수 있어서
    // 꼭 필요하다. 이미 제출됐거나(사장님이 보는 중) 주문완료된 건 그대로
    // 고정 표시. 평소엔 기존 "OO남음" 배지 그대로 보여주고, 수정 중일 때만
    // 그 자리 대신 입력창+저장 버튼을 보여준다(목록이 입력창으로 가득 차지
    // 않도록).
    const qtyEditable = isTodayCart && !it.submitted && !it.ordered;
    const qtyEditing = qtyEditingFor.has(it.id);
    return `
      <div class="item-row ${it.ordered ? "ordered" : ""}">
        <div style="flex:1">
          <div class="name"><span class="dot ${it.urgency}"></span>${escapeHtml(it.materialName)}${showSub && it.subCategory ? `<span class="subcat-inline-tag">${escapeHtml(it.subCategory)}</span>` : ""}${it.autoAdded ? `<span class="subcat-inline-tag">2일마다 자동</span>` : ""}${!qtyEditing && it.qty ? `<span class="qty-pill">${escapeHtml(qtyRemainingLabel(it.qty))}</span>` : ""}${qtyEditable && !qtyEditing ? `<button type="button" class="qty-edit-btn" data-cart-qty-edit-toggle="${it.id}">수정</button>` : ""}${it.orderQty && it.orderQty > 1 ? `<span class="qty-pill">요청 ${it.orderQty}개</span>` : ""}</div>
          ${it.carriedOverFrom ? `<div class="carryover-tag">⏮ 어제 요청드렸지만 주문되지 않았어요</div>` : ""}
          ${qtyEditing ? `
            <div class="qty-edit-row">
              <input type="text" class="qty-edit-input" data-cart-qty-edit="${it.id}" data-cart-qty-auto="${it.autoAdded ? "1" : ""}" value="${escapeHtml(it.qty || "")}" placeholder="남은 수량 (예: 2개)" />
              <button type="button" class="qty-edit-save-btn" data-cart-qty-save="${it.id}">저장</button>
            </div>` : ""}
          ${it.note ? `<div class="note">${escapeHtml(it.note)}</div>` : ""}
          ${materialPhotoUrlsOf(it).map((url) => `<img src="${url}" class="note-photo-thumb" data-receipt-lightbox="${url}" alt="첨부 사진" />`).join("")}
          ${it.ordered && it.receiptPhotos && it.receiptPhotos.length > 0 ? `
          <div class="receipt-photo-row" style="margin-top:4px;">
            ${it.receiptPhotos.map((url) => `<img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="사장님 결제 영수증" />`).join("")}
          </div>` : ""}
          ${!it.ordered && it.ownerAttachedPhotos && it.ownerAttachedPhotos.length > 0 ? `
          <div class="owner-receipt-comment">
            <div class="owner-receipt-comment-label">📎 사장님이 첨부한 영수증</div>
            <div class="receipt-photo-row">${it.ownerAttachedPhotos.map((url) => `<img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />`).join("")}</div>
          </div>` : ""}
          ${it.staffName ? `<div class="who">${escapeHtml(it.staffName)}님${formatTimeLabel(it.updatedAt) ? ` · ${formatTimeLabel(it.updatedAt)}` : ""}</div>` : ""}
          ${isTodayCart && !it.submitted ? `
            <div class="order-qty-row" style="margin-top:6px;">
              <span class="order-qty-label">요청 수량</span>
              <div class="order-qty-stepper">
                <button class="order-qty-btn" data-cart-id="${it.id}" data-cart-auto="${it.autoAdded ? "1" : ""}" data-cart-qty-delta="-1">−</button>
                <span class="order-qty-value">${it.orderQty || 1}개</span>
                <button class="order-qty-btn" data-cart-id="${it.id}" data-cart-auto="${it.autoAdded ? "1" : ""}" data-cart-qty-delta="1">+</button>
              </div>
            </div>` : ""}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
          <span class="badge ${it.urgency} ${canChangeStatus ? "tappable" : ""}" ${canChangeStatus ? `data-status-toggle="${it.id}"` : ""}>${it.urgency === "urgent" ? "🚨 " : ""}${URGENCY_LABEL[it.urgency] || it.urgency}</span>
          ${pickerOpen ? `
            <div class="status-picker">
              ${otherUrgencies.map((u) => `<button class="status-picker-btn ${u}" data-status-pick="${it.id}" data-status-value="${u}">${URGENCY_LABEL[u]}</button>`).join("")}
            </div>` : ""}
          ${isTodayCart ? `<span class="tag ${it.submitted ? "submitted" : "pending"}">${it.submitted ? "제출됨" : "미제출"}</span>` : ""}
          ${it.ordered ? `<span class="tag ordered">✓ 주문완료</span>` : ""}
          ${it.ordered && formatTimestampLabel(it.orderedAt) ? `<span style="font-size:10px; color:var(--muted); text-align:right;">${formatTimestampLabel(it.orderedAt)}</span>` : ""}
          ${isTodayCart && it.submitted && canDelete(it) ? `<button class="icon-btn" data-remove="${it.id}" style="color:var(--urgent); padding:2px 4px; font-size:11px;">삭제</button>` : ""}
          ${isTodayCart && !it.submitted ? `<button class="icon-btn" data-cart-cancel="${it.id}" style="color:var(--urgent); padding:2px 4px; font-size:11px;">취소</button>` : ""}
        </div>
      </div>`;
  }

  const byMain = {};
  for (const it of items) {
    const m = it.mainCategory || "기본자재";
    if (!byMain[m]) byMain[m] = [];
    byMain[m].push(it);
  }

  if (isTodayCart) {
    html += `<div class="cart-status-hint">탭하면 상태를 변경할 수 있어요</div>`;
  }

  const unorderedTodayCount = Object.values(synced).filter((it) => !it.ordered).length;
  for (const main of MAIN_CATS) {
    if (!byMain[main]) continue;
    const showNudgeBtn = isTodayCart && main === "기본자재" && unorderedTodayCount > 0;
    html += `<div class="category-title row-between"><span>${escapeHtml(main)}<span class="sub">${byMain[main].length}건</span></span>${showNudgeBtn ? `<button type="button" class="nudge-owner-chip" data-nudge-owner="1">🔔 사장님께 알리기</button>` : ""}</div>`;

    // 품절/긴급 항목은 소분류에 상관없이 이 대분류 카드 맨 위에 따로 모아서
    // 보여준다 — 사장님 화면과 동일하게 맞춘다. 정상 발주 항목만 기존처럼
    // 소분류별로 묶는다. 어느 쪽이든 자재탭(기본자재 탭)에서 보이는 소분류
    // 순서(컵>뚜껑>원두>빨대 등, 자재관리에서 정해둔 순서)를 그대로 따라야
    // 한다 — 요청 들어온 순서대로 쌓이면 찾기 불편하다.
    const subOrder = subcategoryOrder[main] || [];
    const subRank = {};
    subOrder.forEach((name, i) => { subRank[name] = i; });
    const bySubOrder = (it) => subRank[it.subCategory] ?? 9999;

    const soldoutItems = byMain[main].filter((it) => it.urgency === "soldout").sort((a, b) => bySubOrder(a) - bySubOrder(b));
    const urgentItems = byMain[main].filter((it) => it.urgency === "urgent").sort((a, b) => bySubOrder(a) - bySubOrder(b));
    const normalItems = byMain[main].filter((it) => it.urgency !== "urgent" && it.urgency !== "soldout");

    const bySub = {};
    for (const it of normalItems) {
      const sub = it.subCategory || "기타";
      if (!bySub[sub]) bySub[sub] = [];
      bySub[sub].push(it);
    }

    html += `<div class="card">`;
    if (soldoutItems.length > 0) {
      html += `<div class="subcat-title urgency-caption soldout" style="margin-top:0;"><span class="urgency-caption-label">${URGENCY_LABEL.soldout}</span>${URGENCY_GROUP_CAPTION.soldout}</div>`;
      for (const it of soldoutItems) html += cartItemRowHtml(it, true);
    }
    if (urgentItems.length > 0) {
      html += `<div class="subcat-title urgency-caption urgent" style="margin-top:${soldoutItems.length > 0 ? "14px" : "0"};"><span class="urgency-caption-label">${URGENCY_LABEL.urgent}</span>${URGENCY_GROUP_CAPTION.urgent}</div>`;
      for (const it of urgentItems) html += cartItemRowHtml(it, true);
    }
    if (normalItems.length > 0) {
      const isFirstGroup = soldoutItems.length === 0 && urgentItems.length === 0;
      html += `<div class="subcat-title urgency-caption normal" style="margin-top:${isFirstGroup ? "0" : "14px"};"><span class="urgency-caption-label">${URGENCY_LABEL.normal}</span>${URGENCY_GROUP_CAPTION.normal}</div>`;
      const subs = sortByOrder(Object.keys(bySub), subOrder);
      subs.forEach((sub) => {
        html += `<div class="subcat-title" style="margin-top:14px">${escapeHtml(sub)}</div>`;
        for (const it of bySub[sub]) html += cartItemRowHtml(it, false);
      });
    }
    html += `</div>`;

    if (isTodayCart) {
      const pendingN = pendingCountInMain(main);
      html += `
        <button class="btn ${pendingN > 0 ? "gold" : "secondary"} block" data-submit="${main}" style="margin-bottom:18px;">
          ${escapeHtml(main)} 발주 요청하기${pendingN > 0 ? ` (${pendingN})` : ""}
        </button>`;
    }
  }

  return html;
}

async function changeCartItemUrgency(id, newUrgency) {
  const it = cartItems.find((x) => x.id === id);
  if (!it || it.ordered) return;
  if (it.staffPhone && it.staffPhone !== staffPhone) return;
  if (it.submitted) {
    await updateDoc(doc(itemsCol, id), { urgency: newUrgency });
  } else if (pending[id]) {
    pending[id] = { ...pending[id], urgency: newUrgency };
    savePending();
    cartItems = buildTodayCartItems();
  }
  statusPickerFor.delete(id);
  render();
}

function renderShare() {
  screenEl.innerHTML = `
    <div class="breadcrumb">
      <span class="step-label">공유하기</span>
    </div>
    <div id="shareBoardRoot"></div>`;
  mountShareBoard(document.getElementById("shareBoardRoot"), { name: staffName, phone: staffPhone });
}

function renderRegister() {
  screenEl.innerHTML = `
    <div class="breadcrumb">
      <span class="step-label">등록해요</span>
    </div>
    <div id="registerBoardRoot"></div>`;
  mountRegisterBoard(document.getElementById("registerBoardRoot"), { name: staffName, phone: staffPhone, role: staffRole });
}

function renderPayroll() {
  screenEl.innerHTML = `
    <div class="breadcrumb">
      <span class="step-label">${staffRole === "owner" ? "직원 급여 제출함" : "출근기록"}</span>
    </div>
    <div id="payrollBoardRoot"></div>`;
  mountPayrollBoard(document.getElementById("payrollBoardRoot"), { name: staffName, phone: staffPhone, role: staffRole });
}

function wireCartNav() {
  document.getElementById("backHome2").addEventListener("click", () => { view = "main"; render(); });
  const cartSearchInput = document.getElementById("cartSearchInput");
  if (cartSearchInput) cartSearchInput.addEventListener("focus", () => openSearchFullscreen("cart"));
  const ownerReceiptsBtn = document.getElementById("ownerReceiptsBtn");
  if (ownerReceiptsBtn) ownerReceiptsBtn.addEventListener("click", openOwnerReceiptsOverlay);
  const ownerReceiptsOverlay = document.getElementById("ownerReceiptsOverlay");
  if (ownerReceiptsOverlay) {
    ownerReceiptsOverlay.addEventListener("click", (e) => { if (e.target === ownerReceiptsOverlay) closeOwnerReceiptsOverlay(); });
    document.getElementById("ownerReceiptsCloseBtn").addEventListener("click", closeOwnerReceiptsOverlay);
  }

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
          <div class="day-chip-underline ${dayAccentClass(d)}"></div>
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

  // 자재 행들은 검색어 입력마다 #cartItemsList만 통째로 다시 그려지므로
  // (위 cartSearchInput 핸들러 참고), 행 하나하나에 리스너를 다는 대신
  // 바뀌지 않는 #cartItemsList 자체에 한 번만 걸어두는 delegated 리스너로
  // 처리한다 — 그래야 재검색 후에도 행 클릭이 계속 동작한다.
  const cartItemsList = document.getElementById("cartItemsList");
  if (cartItemsList) cartItemsList.addEventListener("click", handleCartItemsListClick);
}

// #cartItemsList(담은 목록 화면)와 전체화면 검색 모드의 결과 리스트
// 둘 다 같은 모양의 자재 행을 보여주므로, 행 클릭 처리도 하나의 함수로
// 공유한다 — 데이터는 변경되지 않고 어느 쪽 컨테이너에서 눌렸는지만
// 다르다.
function handleCartItemsListClick(e) {
  const nudgeEl = e.target.closest("[data-nudge-owner]");
  if (nudgeEl) { nudgeOwnerAboutUnordered(); return; }
  const submitEl = e.target.closest("[data-submit]");
  if (submitEl) { submitCategory(submitEl.dataset.submit); return; }
  const removeEl = e.target.closest("[data-remove]");
  if (removeEl) { deleteSubmittedItem(removeEl.dataset.remove); return; }
  const cancelEl = e.target.closest("[data-cart-cancel]");
  if (cancelEl) { cancelPendingCartItem(cancelEl.dataset.cartCancel); return; }
  const toggleEl = e.target.closest("[data-status-toggle]");
  if (toggleEl) {
    const id = toggleEl.dataset.statusToggle;
    if (statusPickerFor.has(id)) statusPickerFor.delete(id);
    else statusPickerFor.add(id);
    render();
    return;
  }
  const pickEl = e.target.closest("[data-status-pick]");
  if (pickEl) { changeCartItemUrgency(pickEl.dataset.statusPick, pickEl.dataset.statusValue); return; }
  const qtyEl = e.target.closest("[data-cart-qty-delta]");
  if (qtyEl) { onCartOrderQtyDelta(qtyEl.dataset.cartId, !!qtyEl.dataset.cartAuto, parseInt(qtyEl.dataset.cartQtyDelta, 10)); return; }
  const qtyEditToggleEl = e.target.closest("[data-cart-qty-edit-toggle]");
  if (qtyEditToggleEl) { qtyEditingFor.add(qtyEditToggleEl.dataset.cartQtyEditToggle); render(); return; }
  const qtySaveEl = e.target.closest("[data-cart-qty-save]");
  if (qtySaveEl) {
    const id = qtySaveEl.dataset.cartQtySave;
    const row = qtySaveEl.closest(".item-row");
    const input = row ? row.querySelector("[data-cart-qty-edit]") : null;
    saveCartQtyEdit(id, !!(input && input.dataset.cartQtyAuto), input ? input.value : "");
    return;
  }
}

// "수정" 눌러서 입력창이 뜬 상태에서 "저장"을 눌렀을 때만 실제로 반영한다
// — 그 전까지는 로컬 상태도 안 건드려서, 입력하다 다른 데를 눌러도 원래
// 값이 그대로 남는다. autoPending(여러 직원이 공유하는 2일 자동 자재)은
// 서버에도 바로 반영해서 다른 직원 화면에도 보이게 한다.
async function saveCartQtyEdit(id, isAuto, value) {
  if (isAuto) {
    if (!autoPending[id]) return;
    autoPending[id] = { ...autoPending[id], qty: value };
    await updateDoc(doc(db, "checks", date, "autoPending", id), { qty: value || "" }).catch(() => {});
  } else {
    if (!pending[id]) return;
    pending[id] = { ...pending[id], qty: value };
    savePending();
  }
  const it = cartItems.find((x) => x.id === id);
  if (it) it.qty = value;
  qtyEditingFor.delete(id);
  render();
}

// Same "요청 수량" stepper as the item-selection screen, but for items that
// are already sitting in the cart (committed to `pending`, or shared
// `autoPending` for the 2-day auto-recurring materials) and not yet
// submitted to the owner — lets staff adjust it without going back to browse.
async function onCartOrderQtyDelta(id, isAuto, delta) {
  if (isAuto) {
    const a = autoPending[id];
    if (!a) return;
    const next = Math.max(1, (a.orderQty || 1) + delta);
    autoPending[id] = { ...a, orderQty: next };
    cartItems = buildTodayCartItems();
    render();
    await updateDoc(doc(db, "checks", date, "autoPending", id), { orderQty: next });
    return;
  }
  const p = pending[id];
  if (!p) return;
  const next = Math.max(1, (p.orderQty || 1) + delta);
  pending[id] = { ...p, orderQty: next };
  savePending();
  cartItems = buildTodayCartItems();
  render();
}

async function cancelPendingCartItem(id) {
  const p = pending[id];
  if (p) {
    if (!confirm(`'${p.materialName}'을(를) 장바구니에서 뺄까요?`)) return;
    delete pending[id];
    savePending();
    // 이월된 자재였다면, 다음 새로고침 때 loadCarryoverItems()가 또
    // 집어넣지 않도록 "오늘은 이미 뺐다"고 기억해둔다.
    if (p.carriedOverFrom) {
      dismissedCarryovers.add(id);
      saveDismissedCarryovers();
    }
    cartItems = buildTodayCartItems();
    render();
    return;
  }
  const a = autoPending[id];
  if (!a) return;
  if (!confirm(`'${a.materialName}'을(를) 장바구니에서 뺄까요?`)) return;
  await deleteDoc(doc(db, "checks", date, "autoPending", id));
}

function canDelete(m) {
  // Auto-requested items (2일마다 자동 요청되는 고정 자재) carry no staffPhone —
  // nobody personally owns them, so any staff member can remove one that's not
  // actually needed that day, same as shareboard.js treats unattributed posts.
  return (!m.staffPhone || m.staffPhone === staffPhone) && !m.ordered;
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
  if (m.ordered) {
    toast("이미 주문완료된 자재는 삭제할 수 없어요");
    return;
  }
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
    orderQty: current.orderQty || 1,
    photoUrls: current.photoUrls || [],
    staffName,
    ...overrides,
  };
}

async function onPhotosSelected(id, files) {
  if (!files || files.length === 0) return;
  if (synced[id]) return; // locked, ignore
  const current = effectiveState(id);
  if (!current) {
    toast("먼저 긴급도를 선택해주세요");
    return;
  }
  toast(files.length > 1 ? `사진 ${files.length}장 업로드 중...` : "사진 업로드 중...");
  try {
    const urls = [];
    for (const file of files) {
      const blob = await resizeImageFile(file);
      const path = `notePhotos/${date}/${staffPhone}_${id}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      urls.push(await getDownloadURL(fileRef));
    }
    upsertDraft(id, { photoUrls: [...(current.photoUrls || []), ...urls] });
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

// ---- 신규 가입 온보딩 (모리가 실제 탭을 화살표로 짚어가며 소개) ----
// target이 없는 스텝(첫 인사)은 가운데 뜨는 카드로, target이 있는 스텝은
// 그 실제 DOM 요소를 스포트라이트로 띄우고 화살표 달린 말풍선을 옆에 붙인다.
const ONBOARDING_STEPS = [
  { target: null, text: "안녕하세요, 모리예요! 🐻\nMAMORY가 처음이시죠? 제가 탭을 하나씩 직접 짚어드릴게요." },
  { target: ".big-cat-grid", text: "여기서 부족한 자재를 체크해요.\n기본자재/식자재 고르고 소분류 들어가서, 긴급·정상·품절 중 골라 체크하면 끝!" },
  { target: '.bottom-tab[data-nav="cart"]', text: "체크한 자재들은 여기, 담은 목록에 모여요.\n다 담았으면 제출 버튼을 눌러서 사장님께 보내주세요." },
  { target: '.bottom-tab[data-nav="register"]', text: "마감할 땐 여기서\n시재(현금)랑 선결제 내역을 등록해요." },
  { target: '.bottom-tab[data-nav="share"]', text: "여기선 품절된 메뉴, 레시피 변경, 공지사항을 다같이 나눠요." },
  { target: '.bottom-tab[data-nav="payroll"]', text: "여기서 출퇴근 도장도 찍고\n내 근무 기록도 확인할 수 있어요.\n\n이제 시작해볼까요?" },
];
let onboardingStep = 0;
let onboardingSpotlightEl = null;

function openOnboarding() {
  onboardingStep = 0;
  renderOnboarding();
}

function clearOnboardingSpotlight() {
  if (onboardingSpotlightEl) {
    onboardingSpotlightEl.classList.remove("onboarding-spotlight");
    onboardingSpotlightEl = null;
  }
}

function closeOnboarding() {
  clearOnboardingSpotlight();
  const root = document.getElementById("onboardingOverlayRoot");
  if (root) root.innerHTML = "";
}

function renderOnboarding() {
  const root = document.getElementById("onboardingOverlayRoot");
  if (!root) return;
  clearOnboardingSpotlight();
  const step = ONBOARDING_STEPS[onboardingStep];
  const isLast = onboardingStep === ONBOARDING_STEPS.length - 1;
  const dotsHtml = `
    <div class="onboarding-dots">
      ${ONBOARDING_STEPS.map((_, i) => `<span class="onboarding-dot ${i === onboardingStep ? "active" : ""}"></span>`).join("")}
    </div>`;
  const nextLabel = isLast ? "시작하기!" : "다음";
  const bodyHtml = escapeHtml(step.text).replace(/\n/g, "<br>");

  if (!step.target) {
    root.innerHTML = `
      <div class="onboarding-blocker onboarding-blocker-dim" id="onboardingBlocker">
        <div class="payroll-form-sheet onboarding-sheet">
          <img class="onboarding-mascot-img" src="img/mascot/mascot-happy.png" alt="모리" />
          <div class="onboarding-bubble">${bodyHtml}</div>
          ${dotsHtml}
          <button type="button" class="btn gold block" id="onboardingNextBtn">${nextLabel}</button>
        </div>
      </div>`;
    document.getElementById("onboardingNextBtn").addEventListener("click", () => advanceOnboarding(isLast));
    return;
  }

  const target = document.querySelector(step.target);
  if (!target) { advanceOnboarding(isLast); return; } // 해당 요소가 없으면 그 스텝은 건너뛴다

  root.innerHTML = `
    <div class="onboarding-blocker" id="onboardingBlocker">
      <div class="onboarding-tooltip" id="onboardingTooltip" style="visibility:hidden;">
        <button class="onboarding-tooltip-skip" id="onboardingSkipBtn" aria-label="건너뛰기">✕</button>
        <div class="onboarding-tooltip-head">
          <img class="onboarding-tooltip-mascot" src="img/mascot/mascot-happy.png" alt="모리" />
          <div class="onboarding-tooltip-text">${bodyHtml}</div>
        </div>
        ${dotsHtml}
        <button type="button" class="btn gold block" id="onboardingNextBtn">${nextLabel}</button>
        <div class="onboarding-arrow" id="onboardingArrow"></div>
      </div>
    </div>`;

  target.scrollIntoView({ block: "center", behavior: "instant" });
  target.classList.add("onboarding-spotlight");
  onboardingSpotlightEl = target;

  requestAnimationFrame(() => {
    const tooltip = document.getElementById("onboardingTooltip");
    const arrow = document.getElementById("onboardingArrow");
    const rect = target.getBoundingClientRect();
    const tRect = tooltip.getBoundingClientRect();
    const margin = 14;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    let top, arrowDir;
    if (spaceBelow >= tRect.height + margin || spaceBelow > spaceAbove) {
      top = Math.min(rect.bottom + margin, window.innerHeight - tRect.height - 12);
      arrowDir = "up";
    } else {
      top = rect.top - tRect.height - margin;
      arrowDir = "down";
    }
    top = Math.max(12, top);
    let left = rect.left + rect.width / 2 - tRect.width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tRect.width - 12));
    tooltip.style.top = `${top}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.visibility = "visible";
    arrow.className = `onboarding-arrow ${arrowDir}`;
    const arrowLeft = Math.max(16, Math.min(rect.left + rect.width / 2 - left - 8, tRect.width - 32));
    arrow.style.left = `${arrowLeft}px`;
  });

  document.getElementById("onboardingSkipBtn").addEventListener("click", closeOnboarding);
  document.getElementById("onboardingNextBtn").addEventListener("click", () => advanceOnboarding(isLast));
}

function advanceOnboarding(isLast) {
  if (isLast) { closeOnboarding(); return; }
  onboardingStep += 1;
  renderOnboarding();
}

function onPhotoRemove(id, index) {
  if (synced[id]) return; // locked, ignore
  const current = effectiveState(id);
  if (!current) return;
  const urls = [...(current.photoUrls || [])];
  urls.splice(index, 1);
  upsertDraft(id, { photoUrls: urls });
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

function onOrderQtyDelta(id, delta) {
  if (synced[id]) return; // locked, ignore
  const current = effectiveState(id);
  if (!current) return;
  const next = Math.max(1, (current.orderQty || 1) + delta);
  upsertDraft(id, { orderQty: next });
  render();
}

async function submitCategory(main) {
  const entries = Object.entries(pending).filter(([, p]) => p.mainCategory === main);
  const autoEntries = Object.entries(autoPending).filter(([, p]) => p.mainCategory === main);
  if (entries.length === 0 && autoEntries.length === 0) {
    toast("제출할 변경사항이 없어요");
    return;
  }
  let addedCount = 0;
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
        orderQty: p.orderQty || 1,
        photoUrls: p.photoUrls || [],
        ordered: false,
        staffName,
        staffPhone,
        updatedAt: serverTimestamp(),
      }, { merge: true });
      addedCount++;
    }
    delete pending[id];
  }
  // 2일마다 자동으로 담긴 것도 이 제출에 같이 실어 보낸다 — 지금 제출하는
  // 사람이 확인하고 보내는 거니 그 사람 이름으로 나간다.
  for (const [id, a] of autoEntries) {
    await setDoc(doc(itemsCol, id), {
      materialName: a.materialName,
      mainCategory: a.mainCategory,
      subCategory: a.subCategory,
      urgency: a.urgency,
      note: a.note || "",
      qty: a.qty || "",
      orderQty: a.orderQty || 1,
      photoUrls: a.photoUrls || [],
      ordered: false,
      staffName,
      staffPhone,
      updatedAt: serverTimestamp(),
    }, { merge: true });
    await deleteDoc(doc(db, "checks", date, "autoPending", id));
    addedCount++;
  }
  savePending();
  // 사장님 알림은 항목 하나하나가 아니라 이 제출 묶음당 한 번만 가도록,
  // 개별 자재 문서와는 별도로 "제출 이벤트" 문서 하나를 추가로 남긴다 —
  // functions/index.js의 notifyOwnerOnNewRequest가 이 문서 생성을 구독한다.
  if (addedCount > 0) {
    await addDoc(collection(db, "checks", date, "requestBatches"), {
      staffName,
      staffPhone,
      mainCategory: main,
      itemCount: addedCount,
      createdAt: serverTimestamp(),
    });
    // 먹이는 이제 요청한 사람의 계정에만 개인적으로 쌓인다(mascot.js 참고)
    // — 사장이 "내가 직접 발주 요청하기"로 자재를 요청해도 사장 본인
    // 화면에만 뜨고 다른 직원 화면엔 영향이 없으니, 역할과 상관없이
    // 요청한 사람에게 적립해주면 된다.
    earnFood(main === "기본자재" ? "checkberry" : "onigiri");
  }
  if (view === "cart") cartItems = buildTodayCartItems();
  render();
  toast(`${main} 발주 요청을 보냈어요`);
}

async function main() {
  const account = await requireAccount("staff");
  if (!account) return;
  staffName = account.name;
  staffPhone = account.phone;
  staffRole = account.role;
  // Owner accounts can land here too (self-ordering on a solo shift) — auth.js
  // lets that through as a special case, so surface a way back and label the
  // account caption accurately instead of always saying "직원 계정".
  const isOwnerVisiting = account.role === "owner";
  wireAccountHeaderAvatar(document.getElementById("accountName"), account, isOwnerVisiting ? "사장님 계정 (발주 화면)" : "직원 계정");
  if (isOwnerVisiting) document.getElementById("backToOwnerBtn").style.display = "block";
  mountHumanityTrigger(document.getElementById("humanityBtn"), document.getElementById("humanityOverlayRoot"), account);

  // Deep-linked here from a push notification (see functions/index.js's
  // `link` field) — land straight on the relevant tab instead of always
  // opening to 자재선택.
  const linkedParams = new URLSearchParams(location.search);
  const linkedView = linkedParams.get("view");
  if (linkedView === "cart") {
    view = "cart";
    cartDate = date;
  } else if (linkedView === "share") {
    view = "share";
    setInitialShareTab(linkedParams.get("stab"));
    setInitialShareDate(linkedParams.get("sdate"));
  } else if (linkedView === "register") {
    view = "register";
  } else if (linkedView === "payroll") {
    view = "payroll";
  }

  watchForegroundPush();
  watchAppBadgeClear();
  mountMascotWidget(staffPhone);
  mountMusicBar(document.getElementById("musicBarRoot"), { name: staffName, phone: staffPhone });
  if (!isOwnerVisiting) mountClockWidget(document.getElementById("clockWidgetRoot"), { name: staffName, phone: staffPhone });
  if ("Notification" in window && Notification.permission === "granted") registerPushToken(staffPhone);

  loadPending();
  loadDismissedCarryovers();
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

  onSnapshot(collection(db, "checks", date, "autoPending"), (snap) => {
    autoPending = {};
    snap.docs.forEach((d) => { autoPending[d.id] = d.data(); });
    if (view === "cart" && cartDate === date) {
      cartItems = buildTodayCartItems();
    }
    render();
  });

  onSnapshot(doc(db, "checks", date), (snap) => {
    todayOwnerReceiptCount = (snap.exists() && snap.data().allReceiptPhotosHistory || []).length;
    render();
  });

  // Start the share-board listener right away so the bottom tab's
  // unseen-count badge is live even before the user opens 공유하기.
  const shareNavBadge = document.getElementById("shareNavBadge");
  watchUnseenCount({ name: staffName, phone: staffPhone }, () => {
    if (hasUnseenShareActivity(staffPhone)) { shareNavBadge.textContent = "N"; shareNavBadge.style.display = "flex"; }
    else shareNavBadge.style.display = "none";
  });

  // 등록해요(시재/선결제) 탭도 같은 방식으로 — 열어보지 않아도 변화가
  // 있으면 바로 N배지가 뜬다.
  const registerNavBadge = document.getElementById("registerNavBadge");
  watchRegisterUnseen({ name: staffName, phone: staffPhone }, () => {
    if (hasUnseenRegisterActivity()) { registerNavBadge.textContent = "N"; registerNavBadge.style.display = "flex"; }
    else registerNavBadge.style.display = "none";
  });

  loadAllChipCounts();
  loadYesterdayItems();
  loadCarryoverItems();
  watchNotificationBadge(notifyBadgeEl, staffPhone);
  render();
  scrollTopSafely();

  // 방금 가입한 신규 직원만 login.js가 ?onboarding=1을 붙여서 보낸다 —
  // 한 번 보여준 뒤엔 새로고침해도 다시 안 뜨게 URL에서 바로 지운다.
  const onboardingParams = new URLSearchParams(location.search);
  if (onboardingParams.get("onboarding") === "1") {
    onboardingParams.delete("onboarding");
    const qs = onboardingParams.toString();
    history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
    openOnboarding();
  }
}

main();
