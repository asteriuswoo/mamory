// 오늘 발주 view — mounted/unmounted by app-shell.js. Everything here that
// touches the DOM or subscribes to Firestore is scoped inside mount()/
// unmount() rather than running at module load time, since this module now
// stays loaded across tab switches instead of being torn down by a full
// page reload each time.
import { db, storage, ref, uploadBytes, getDownloadURL, STORE_NAME, QUICK_ORDER_LINKS, collection, doc, addDoc, updateDoc, setDoc, onSnapshot, getDocs, serverTimestamp } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimeLabel, formatTimestampLabel, toast, showTopBanner, escapeHtml, resizeImageFile, openImageLightbox, URGENCY_LABEL, URGENCY_GROUP_CAPTION, sortMaterials, dayAccentClass, NOTIFY_BELL_ON, qtyRemainingLabel, MULTIPLE_FILE_ATTR, showActionSheet } from "./util.js";
import { watchNotificationBadge, openNotificationPanel } from "./push.js";
import { recordSubmitToday } from "./mascot.js";
import { mountHumanityTrigger } from "./humanityboard.js";
import { computeTrendData, trendInsightsHtml, trendListHtml } from "./ordertrend.js";

// 사장님이 번거롭다고 해서 "영수증 첨부해야만 주문완료 체크 가능" 잠금을
// 잠깐 풀어둔다 — 영수증 첨부 기능 자체는 그대로 쓸 수 있고, 체크/공유를
// 막아서는 게 아니라 공유할 때 영수증이 없으면 확인창만 한 번 띄운다.
// 나중에 다시 잠가달라고 하면 이 값만 true로 되돌리면 된다(잠금 로직/UI는
// 그대로 남아있어서 바로 복원됨).
const RECEIPT_REQUIRED_TO_CHECK = false;

let myOwnerPhone = "";

let datePick, todayBtn, dayChips, receiptClipRowEl, orderList, newRequestCard, newRequestText, urgentCount, shareBtn, previewCard, sharePreview, copyBtn, notifyBtn, notifyBadgeEl, quickOrderLinksEl, pageSub;

let items = []; // {id, ...data}
let unsub = null;
let materialsUnsub = null;
let subcatUnsub = null;
let materialsOrder = {}; // materialId -> catalog rank (matches the staff selection-tab order)
let materialFirstAppearanceRank = {}; // "main::sub" -> first-appearance rank in the catalog (fallback order)
let materialReceiptAlias = {}; // materialId -> 자재관리에서 등록해둔 "영수증 검색어" (없으면 "")
let subcategoryOrder = {}; // { 기본자재: string[], 식자재: string[] } from config/subcategoryOrder — owner's explicit order
let orderedPending = new Set(); // item ids checked locally but not yet shared/locked
let receiptPhotos = []; // 지금 보고 있는 날짜의 "전체 영수증" 사진 URL들(공유하면 비워짐) — live
let allReceiptPhotosHistory = []; // 그날 "전체 영수증"으로 올린 사진 전체 — 공유해도 안 비워지는 기록용 — live
let receiptUnsub = null;
let receiptUploading = false;
// 영수증을 "전체"에 적용할지 "선택한 자재"에만 적용할지 매번 명시적으로
// 고르게 한다 — 하나를 고르기 전엔 사진 추가 자체를 못 하게 막아서 실수로
// 엉뚱한 곳에 붙는 걸 방지한다. 사진은 고르는 즉시 올라가지 않고, "첨부하기"를
// 눌러야만 실제로 업로드/저장된다 — 그 전까진 미리보기에서 X로 뺄 수 있다.
let receiptMode = null; // null(아직 안 고름) | "all" | "select"
let receiptSelectedIds = new Set(); // "select" 모드에서 체크한 자재 id들
let receiptPendingFiles = []; // [{file, previewUrl}] — 첨부하기 전 로컬 미리보기
let receiptCardEl, stickyShareBarEl;
let showMyReceiptsOverlay = false;
let myReceiptsOverlayRoot;
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));
const chipCounts = {};
const chipUnordered = {}; // date -> true if that date still has any not-yet-ordered item

let trendOverlayRoot;
let showTrendOverlay = false;
let trendLoading = false;
let trendData = [];

async function loadOrderTrend() {
  trendLoading = true;
  renderTrendOverlay();
  trendData = await computeTrendData(recentDates);
  trendLoading = false;
  renderTrendOverlay();
}

function openOrderTrend() {
  showTrendOverlay = true;
  loadOrderTrend();
  renderTrendOverlay();
}

function closeOrderTrend() {
  showTrendOverlay = false;
  renderTrendOverlay();
}

function renderTrendOverlay() {
  if (!trendOverlayRoot) return;
  if (!showTrendOverlay) { trendOverlayRoot.innerHTML = ""; return; }
  trendOverlayRoot.innerHTML = `
    <div class="payroll-form-overlay" id="trendOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">📊 발주 트렌드</div>
          <button class="payroll-form-close-btn" id="trendCloseBtn" aria-label="닫기">✕</button>
        </div>
        <div style="font-size:12px; color:var(--muted); margin:6px 0 14px;">최근 7일 동안 요청된 자재 기준</div>
        ${trendLoading ? `<div class="empty">불러오는 중...</div>` : trendData.length === 0 ? `<div class="empty">최근 7일간 요청 기록이 없어요.</div>` : `
        ${trendInsightsHtml(trendData, recentDates.length)}
        ${trendListHtml(trendData)}`}
      </div>
    </div>`;
  const overlay = document.getElementById("trendOverlay");
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeOrderTrend(); });
  document.getElementById("trendCloseBtn").addEventListener("click", closeOrderTrend);
}

// 옛 발주 항목은 photoUrl(단수) 하나였고, 지금은 여러 장을 담는
// photoUrls(배열)로 바뀌었다 — 어느 쪽으로 저장됐든 한 번에 뽑아 쓴다.
function materialPhotoUrlsOf(it) {
  if (it.photoUrls && it.photoUrls.length > 0) return it.photoUrls;
  return it.photoUrl ? [it.photoUrl] : [];
}

function updateDateLabel() {
  pageSub.textContent = formatDateLabel(datePick.value);
}

function dowLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return { dow: days[new Date(y, m - 1, d).getDay()], dnum: d };
}

async function loadChipCounts() {
  await Promise.all(
    recentDates.map(async (date) => {
      try {
        const snap = await getDocs(collection(db, "checks", date, "items"));
        chipCounts[date] = snap.size;
        chipUnordered[date] = snap.docs.some((d) => !d.data().ordered);
      } catch (e) {
        chipCounts[date] = chipCounts[date] || 0;
      }
      renderChips();
    })
  );
}

function renderChips() {
  dayChips.innerHTML = recentDates
    .map((date) => {
      const { dow, dnum } = dowLabel(date);
      const count = chipCounts[date] || 0;
      const active = date === datePick.value;
      const unordered = !!chipUnordered[date];
      return `
        <button class="day-chip ${active ? "active" : ""}" data-date="${date}">
          <div class="dow">${date === todayStr() ? "오늘" : dow}</div>
          <div class="dnum">${dnum}</div>
          <div class="day-chip-underline ${dayAccentClass(date)}"></div>
          <div class="dcount">${count > 0 ? count + "건" : ""}</div>
          <div class="day-chip-dot-row">${unordered ? `<span class="day-chip-dot"></span>` : ""}</div>
        </button>`;
    })
    .join("");
  dayChips.querySelectorAll("[data-date]").forEach((el) => {
    el.addEventListener("click", () => {
      datePick.value = el.dataset.date;
      updateDateLabel();
      subscribe();
      renderChips();
    });
  });
}

function subscribe() {
  if (unsub) unsub();
  orderedPending.clear();
  unsub = onSnapshot(collection(db, "checks", datePick.value, "items"), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // Once an item comes back from Firestore as ordered, it's locked — drop
    // any local pending mark for it (it's already shared and confirmed).
    items.forEach((it) => { if (it.ordered) orderedPending.delete(it.id); });
    reconcileOrderedPending();
    chipCounts[datePick.value] = items.length;
    chipUnordered[datePick.value] = items.some((it) => !it.ordered);
    render();
    renderChips();
    renderReceiptCard();
  });
  if (receiptUnsub) receiptUnsub();
  receiptPhotos = [];
  allReceiptPhotosHistory = [];
  receiptUnsub = onSnapshot(doc(db, "checks", datePick.value), (snap) => {
    receiptPhotos = (snap.exists() && snap.data().receiptPhotos) || [];
    allReceiptPhotosHistory = (snap.exists() && snap.data().allReceiptPhotosHistory) || [];
    // 영수증이 막 첨부/해제되면 그 사실 자체가 발주 목록의 체크박스
    // 잠금(hasReceiptFor) 여부를 바꾸는데, render()를 안 부르면 이미 그려진
    // #orderList는 예전 disabled 상태 그대로 남는다 — renderReceiptCard()
    // 만으로는 영수증 카드만 다시 그려질 뿐 체크박스 쪽엔 반영 안 됐었다.
    reconcileOrderedPending();
    render();
    renderReceiptCard();
    renderReceiptClipRow();
    renderMyReceiptsOverlay();
  });
}

// 실제로 결제한 영수증 사진(들)을 첨부해두고, 이게 하나도 없으면 아래 발주
// 항목들의 "주문완료" 체크 자체를 막는다 — 장바구니에만 담아두고 결제는 안
// 한 채로 체크해서 공유해버리는 실수를 구조적으로 방지하기 위함. 영수증은
// "전체"(오늘 체크 전체에 적용) 또는 선택한 자재 하나 이상에만 적용되도록
// 매번 먼저 고르게 한다 — 자재 하나만 콕 집어 영수증을 받았을 때 굳이 전체를
// 다 묶어둘 필요는 없어서. 사진은 고르자마자 올라가지 않고, 미리보기에서
// X로 뺄 수 있게 뒀다가 "첨부하기"를 눌러야 실제로 업로드/저장된다.
function onReceiptFilesPicked(files) {
  if (!files || files.length === 0) return;
  files.forEach((file) => {
    receiptPendingFiles.push({ file, previewUrl: URL.createObjectURL(file) });
  });
  renderReceiptCard();
}

function removeReceiptPendingFile(idx) {
  const removed = receiptPendingFiles.splice(idx, 1)[0];
  if (removed) URL.revokeObjectURL(removed.previewUrl);
  renderReceiptCard();
}

function resetReceiptDraft() {
  receiptPendingFiles.forEach((p) => URL.revokeObjectURL(p.previewUrl));
  receiptPendingFiles = [];
  receiptSelectedIds = new Set();
  receiptMode = null;
}

const RECEIPT_OCR_URL = "https://asia-northeast3-mmth-order.cloudfunctions.net/extractReceiptText";

function normalizeForMatch(s) {
  return (s || "").replace(/[\s()·,.\-&_*]/g, "").toLowerCase();
}

// 영수증 OCR 텍스트 안에 검색어가 들어있는지 본다. 전체가 그대로 들어있으면
// 항상 매칭이고, 그게 아닐 때만 isAlias일 경우에 한해 단어 단위로 더 본다.
//
// 자재명(자재관리에서 검색어를 따로 안 등록해둔 경우)은 "일반우유"/
// "시그니처우유"/"저지방우유"처럼 끝 단어만 같고 실제로는 서로 다른 자재인
// 경우가 많아서 — 전체가 그대로 안 겹치면 매칭 안 시킨다. 괄호 안 "(1.5L)"
// 같은 용량 표시는 영수증엔 안 찍히는 경우가 많아서 떼고 비교한다.
//
// 반면 자재관리에서 따로 등록해둔 "영수증 검색어"는 사장님이 직접 그
// 유통업체 품명을 보고 적어둔 값이라 괄호를 안 뗀다 — "(L)"/"(S/M)"처럼
// 사이즈를 구분하는 의미 있는 내용을 괄호 안에 적어두는 경우가 있어서,
// 용량 표시로 보고 지워버리면 "홀더(라지)"와 "홀더(미듐)"이 똑같은
// 검색어가 돼버린다. 단어가 여러 개면(예: "번트 카라멜 파우더") 전체가
// 그대로 안 겹쳐도 과반수 이상 겹치면 매칭한다 — OCR이 단어 하나를
// 잘못 읽어도(예: "파우더"→"파워") 나머지로 찾아내게. 다만 "원두"처럼
// 공통 단어 딱 하나만 겹치는 건 매칭으로 안 치는데, "디카페인 원두"가
// "일반 원두"에도 걸리는 식의 오매칭이 실제로 나서다 — 검색어 단어
// 중 더 많은 쪽이 겹쳐야 그 변형(디카/라지 등)까지 맞다고 볼 수 있다.
function receiptTextMatchesMaterial(normalizedOcrText, searchTerm, isAlias) {
  let raw = (isAlias ? (searchTerm || "") : (searchTerm || "").replace(/\([^)]*\)/g, "")).trim();
  // "말차P"/"버터P"처럼 파우더류 자재명 끝에 붙여둔 "P"는 사장님이 내부적으로
  // 구분하려고 붙인 표시일 뿐 영수증엔 찍히지 않는다(영수증엔 "파우더"라고
  // 한글로 찍힘) — 매칭 대상에서 이 trailing P만 떼고 나머지로 찾는다.
  // 영수증 검색어(alias)는 사장님이 영수증 표기 그대로 입력한 값이라 이
  // 규칙을 적용하지 않는다.
  if (!isAlias) raw = raw.replace(/(?<=[가-힣])p$/i, "").trim();
  const core = normalizeForMatch(raw);
  if (core.length < 2) return false;
  if (normalizedOcrText.includes(core)) return true;
  // 띄어쓰기로 나뉜 단어들이 제품명 안에 순서만 다르게 들어있는 경우도
  // 매칭시킨다(예: "콜드브루 원액" 자재명이 "원액(콜드브루)"처럼 뒤집혀서
  // 찍혀도 잡히게) — 예전엔 영수증 검색어를 등록한 자재에만 이 단어 단위
  // 매칭을 허용했는데, 등록 안 한 일반 자재명도 똑같이 혜택을 보게 한다.
  // 다만 띄어쓰기가 아예 없는 복합어("1구캐리어"처럼)는 여기서도 단어를
  // 못 쪼개서 여전히 못 잡는다 — 그런 건 영수증 검색어를 띄어서 등록하거나
  // 그대로 등록해야 한다.
  const words = raw.split(/\s+/).map((w) => normalizeForMatch(w)).filter((w) => w.length >= 2);
  if (words.length <= 1) return false;
  const matchedCount = words.filter((w) => normalizedOcrText.includes(w)).length;
  return matchedCount >= Math.floor(words.length / 2) + 1;
}

// "전체 영수증" 사진 한 장을 서버로 보내 글자를 읽어오고(OCR), 아직
// 미주문 상태인 자재들 중 그 글자에 들어있는 이름이 있으면 체크해둔다 —
// 여러 장을 한꺼번에 올려도 첫 장만 읽는다(매번 다 읽으면 그만큼 더
// 과금되고 느려지는데, 보통 영수증 한 장에 그날 품목이 다 찍혀 있어서
// 한 장으로도 충분하다). 잘못 읽거나 아예 없는 자재는 사장님이 직접
// 나머지를 체크하면 된다.
async function autoCheckFromReceiptPhoto(path) {
  try {
    const res = await fetch(`${RECEIPT_OCR_URL}?path=${encodeURIComponent(path)}`);
    if (!res.ok) return { newlyChecked: [], alreadyChecked: [] };
    const { text } = await res.json();
    if (!text) return { newlyChecked: [], alreadyChecked: [] };
    const normalizedText = normalizeForMatch(text);
    const newlyChecked = [];
    const alreadyChecked = [];
    for (const it of items) {
      // 자재관리에서 "영수증 검색어"를 따로 등록해둔 자재는 그 검색어로만
      // 찾는다(자재명 대신 — 둘 다 보면 "원두"처럼 겹치는 일반 단어가
      // 다시 끼어들 수 있어서). 등록 안 해둔 자재는 그대로 자재명으로 찾는다.
      const alias = materialReceiptAlias[it.id];
      const searchTerm = alias || it.materialName;
      if (!receiptTextMatchesMaterial(normalizedText, searchTerm, !!alias)) continue;
      // 이미 체크(orderedPending)됐거나 아예 주문완료까지 끝난(ordered) 자재도
      // 영수증 글자와 겹치는지는 똑같이 확인한다 — 다만 새로 체크할 건
      // 없으니 "이미 체크돼있다"는 것만 알려준다. 완전히 새로운(둘 다
      // 아닌) 자재만 이번에 새로 체크한다.
      if (it.ordered || orderedPending.has(it.id)) {
        alreadyChecked.push(it.materialName);
      } else {
        orderedPending.add(it.id);
        newlyChecked.push(it.materialName);
      }
    }
    return { newlyChecked, alreadyChecked };
  } catch (e) {
    console.error("영수증 자동 체크 실패", e);
    return { newlyChecked: [], alreadyChecked: [] };
  }
}

async function submitReceiptAttachment() {
  if (receiptUploading) return;
  if (receiptPendingFiles.length === 0) {
    toast("첨부할 사진을 추가해주세요");
    return;
  }
  if (receiptMode === "select" && receiptSelectedIds.size === 0) {
    toast("첨부할 자재를 선택해주세요");
    return;
  }
  receiptUploading = true;
  toast(receiptPendingFiles.length > 1 ? `영수증 사진 ${receiptPendingFiles.length}장 업로드 중...` : "영수증 사진 업로드 중...");
  try {
    const urls = [];
    const paths = [];
    for (const p of receiptPendingFiles) {
      const blob = await resizeImageFile(p.file);
      const path = `receiptPhotos/${datePick.value}/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      urls.push(await getDownloadURL(fileRef));
      paths.push(path);
    }
    if (receiptMode === "all") {
      await setDoc(
        doc(db, "checks", datePick.value),
        { receiptPhotos: [...receiptPhotos, ...urls], allReceiptPhotosHistory: [...allReceiptPhotosHistory, ...urls] },
        { merge: true }
      );
      toast("제품명 읽는 중...");
      const { newlyChecked, alreadyChecked } = paths.length > 0
        ? await autoCheckFromReceiptPhoto(paths[0])
        : { newlyChecked: [], alreadyChecked: [] };
      const namesPreview = (list) => (list.length <= 4 ? list.join(", ") : `${list.slice(0, 3).join(", ")} 외 ${list.length - 3}개`);
      if (newlyChecked.length === 0 && alreadyChecked.length === 0) {
        showTopBanner("영수증에서 일치하는 제품명을 못 찾았어요 — 직접 체크해주세요", 3500);
      } else {
        // 이미 체크돼 있던 것과 이번에 새로 체크된 것은 성격이 달라서,
        // 배너를 하나로 합치지 않고 순서대로 따로 띄운다.
        if (alreadyChecked.length > 0) {
          showTopBanner(`📎 영수증에서 읽은 ${namesPreview(alreadyChecked)}은 이미 체크돼있어요`, 3200);
          if (newlyChecked.length > 0) await new Promise((resolve) => setTimeout(resolve, 3500));
        }
        if (newlyChecked.length > 0) {
          showTopBanner(`✅ 영수증에서 읽은 제품명으로 ${namesPreview(newlyChecked)} 자동 체크했어요 — 확인하고 필요하면 추가로 체크해주세요`, 5000);
        }
      }
    } else {
      await Promise.all([...receiptSelectedIds].map((id) => {
        const it = items.find((x) => x.id === id);
        const existing = (it && it.ownerAttachedPhotos) || [];
        return updateDoc(doc(db, "checks", datePick.value, "items", id), { ownerAttachedPhotos: [...existing, ...urls] });
      }));
      toast("첨부완료");
    }
    resetReceiptDraft();
    render();
    renderReceiptCard();
    // 버튼 문구가 "첨부하고 체크하러 가기"니까, 첨부가 끝나면 그 약속대로
    // 방금 풀린 체크리스트까지 바로 스크롤해서 눈앞에 보이게 한다 — 안
    // 그러면 영수증 카드는 위쪽에 있어서 첨부해도 뭐가 바뀌었는지 안 보일
    // 수 있다.
    orderList.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  } finally {
    receiptUploading = false;
  }
}

function receiptCardHtml() {
  if (receiptMode === null) {
    return `
      <div class="field" style="margin:0;">
        <label>결제 영수증 (주문완료 체크 전 필수)</label>
        <div class="seg" style="margin-top:8px;">
          <button type="button" class="active" id="receiptAttachMenuBtn">📎 영수증 첨부하기</button>
          <button type="button" class="active seg-trend-btn" id="orderTrendBtn">📊 발주 트렌드</button>
        </div>
      </div>`;
  }

  const unordered = items.filter((it) => !it.ordered);
  const targetHtml = receiptMode === "select"
    ? (unordered.length === 0
        ? `<div class="empty" style="margin-top:8px;">첨부할 미주문 자재가 없어요.</div>`
        : `<div class="receipt-target-check-list" style="margin-top:8px;">
            ${unordered.map((it) => `
              <label class="receipt-target-check-row">
                <input type="checkbox" data-receipt-target-check="${it.id}" ${receiptSelectedIds.has(it.id) ? "checked" : ""} />
                <span>${escapeHtml(it.materialName)}</span>
              </label>`).join("")}
          </div>`)
    : "";

  const previewHtml = receiptPendingFiles.length > 0 ? `
    <div class="receipt-photo-row">
      ${receiptPendingFiles.map((p, i) => `
        <div class="photo-preview">
          <img src="${p.previewUrl}" alt="영수증 미리보기" />
          <button type="button" class="photo-remove-btn" data-receipt-pending-remove="${i}">✕</button>
        </div>`).join("")}
    </div>` : "";

  return `
    <div class="field" style="margin:0;">
      <div class="row-between">
        <label>${receiptMode === "all" ? "전체 영수증" : "선택 자재 영수증"}</label>
        <button type="button" class="receipt-mode-back-btn" id="receiptModeBackBtn">‹ 다시 선택</button>
      </div>
      ${targetHtml}
      ${receiptMode === "all" ? `<div class="receipt-ocr-hint">📸 제품명이 잘 보이도록 찍어주세요 — 자동으로 자재를 찾아 체크해드려요</div>` : ""}
      ${previewHtml}
      <label class="btn secondary block receipt-upload-btn" style="margin-top:8px;">
        📷 영수증 사진 추가
        <input type="file" accept="image/*" id="receiptPhotoInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
      </label>
      <button type="button" class="btn normal block" id="receiptAttachSubmitBtn" style="margin-top:8px;">첨부하고 체크하러 가기${receiptPendingFiles.length > 0 ? ` (${receiptPendingFiles.length})` : ""}</button>
    </div>`;
}

function wireReceiptCard() {
  const attachMenuBtn = document.getElementById("receiptAttachMenuBtn");
  if (attachMenuBtn) {
    attachMenuBtn.addEventListener("click", () => {
      showActionSheet([
        { label: "🧾 전체 영수증 첨부", onClick: () => { receiptMode = "all"; renderReceiptCard(); } },
        { label: "🎯 선택 자재 영수증 첨부", onClick: () => { receiptMode = "select"; renderReceiptCard(); } },
        { label: "📎 내가 첨부한 영수증 보기", onClick: openMyReceiptsOverlay },
      ]);
    });
  }
  const trendBtn = document.getElementById("orderTrendBtn");
  if (trendBtn) trendBtn.addEventListener("click", openOrderTrend);
  const backBtn = document.getElementById("receiptModeBackBtn");
  if (backBtn) backBtn.addEventListener("click", () => { resetReceiptDraft(); renderReceiptCard(); });
  receiptCardEl.querySelectorAll("[data-receipt-target-check]").forEach((el) => {
    el.addEventListener("change", (e) => {
      const id = el.dataset.receiptTargetCheck;
      if (e.target.checked) receiptSelectedIds.add(id);
      else receiptSelectedIds.delete(id);
    });
  });
  const photoInput = document.getElementById("receiptPhotoInput");
  if (photoInput) {
    photoInput.addEventListener("change", (e) => {
      onReceiptFilesPicked(Array.from(e.target.files || []));
      e.target.value = "";
    });
  }
  receiptCardEl.querySelectorAll("[data-receipt-pending-remove]").forEach((el) => {
    el.addEventListener("click", () => removeReceiptPendingFile(Number(el.dataset.receiptPendingRemove)));
  });
  const submitBtn = document.getElementById("receiptAttachSubmitBtn");
  if (submitBtn) submitBtn.addEventListener("click", submitReceiptAttachment);
}

function renderStickyShareBar() {
  if (!stickyShareBarEl) return;
  const pendingN = orderedPending.size;
  stickyShareBarEl.innerHTML = `
    <button class="btn gold block sticky-share-btn" id="stickyShareBtn">
      체크하고 직원에게 공유${pendingN > 0 ? ` (${pendingN})` : ""}
    </button>`;
  const btn = document.getElementById("stickyShareBtn");
  if (btn) btn.addEventListener("click", shareOrderedChecks);
}

function renderReceiptCard() {
  if (receiptCardEl) {
    receiptCardEl.innerHTML = receiptCardHtml();
    wireReceiptCard();
  }
  renderStickyShareBar();
}

// 예전엔 "내가 첨부한 영수증 보기" 버튼이 영수증 첨부 카드 안에 회색
// secondary 버튼으로 있었는데, 카드 배경과 톤이 비슷해서 첨부가 있는지도
// 잘 안 보였다 — 날짜 칩 바로 아래에, 그날 실제로 첨부된 영수증이 있을
// 때만 클립 칩 + N배지로 띄워서 눈에 바로 들어오게 바꾼다. 하나도 없는
// 날은 칩 자체를 안 그려서 그 줄이 조용히 사라진다.
function renderReceiptClipRow() {
  if (!receiptClipRowEl) return;
  const n = allReceiptPhotosHistory.length;
  if (n <= 0) { receiptClipRowEl.innerHTML = ""; return; }
  const isToday = datePick.value === todayStr();
  receiptClipRowEl.innerHTML = `
    <button type="button" class="receipt-clip-chip" id="receiptClipChipBtn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
      ${isToday ? "오늘 " : ""}첨부한 영수증
      <span class="receipt-clip-badge">${n}</span>
    </button>`;
  document.getElementById("receiptClipChipBtn").addEventListener("click", openMyReceiptsOverlay);
}

// 직원 쪽 "담은 목록"에서 자재 요청에 사진을 첨부해 모아보는 것과 똑같이,
// 사장님도 본인이 첨부해둔 영수증(전체 + 자재별)을 한곳에 모아 볼 수 있게 —
// 지금 보고 있는 날짜의 items/receiptPhotos가 이미 메모리에 다 있어서 별도
// 조회 없이 바로 구성한다.
function openMyReceiptsOverlay() {
  showMyReceiptsOverlay = true;
  renderMyReceiptsOverlay();
}

function closeMyReceiptsOverlay() {
  showMyReceiptsOverlay = false;
  renderMyReceiptsOverlay();
}

function myReceiptsOverlayHtml() {
  // 특정 자재 하나에만 콕 집어 첨부한 영수증(ownerAttachedPhotos)은 여기 모아보기
  // 대상이 아니다 — 그건 그 자재 카드 안에 댓글처럼 바로 붙어있으니 거기서
  // 보면 되고, 여긴 "전체 영수증"만 모아서 보여준다.
  // receiptPhotos가 아니라 allReceiptPhotosHistory를 써야 한다 — receiptPhotos는
  // 공유(주문완료 제출)하면 재잠금을 위해 []로 비워지는 필드라, 공유 후엔
  // 사장님 본인한테도 "아무것도 없다"고 잘못 나와버린다.
  const overallUrls = allReceiptPhotosHistory;
  const empty = overallUrls.length === 0;
  const isToday = datePick.value === todayStr();
  return `
    <div class="payroll-form-overlay" id="myReceiptsOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">📎 ${isToday ? "오늘 " : ""}내가 첨부한 영수증</div>
          <button class="payroll-form-close-btn" id="myReceiptsCloseBtn" aria-label="닫기">✕</button>
        </div>
        ${empty ? `<div class="empty" style="margin-top:12px;">아직 첨부된 전체 영수증이 없어요.</div>` : `
          <div class="receipt-photo-row" style="margin-top:12px;">${overallUrls.map((url) => `
            <div class="photo-preview">
              <img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />
              <button type="button" class="photo-remove-btn" data-my-receipt-delete="${url}">✕</button>
            </div>`).join("")}</div>
        `}
      </div>
    </div>`;
}

function renderMyReceiptsOverlay() {
  if (!myReceiptsOverlayRoot) return;
  myReceiptsOverlayRoot.innerHTML = showMyReceiptsOverlay ? myReceiptsOverlayHtml() : "";
  const overlay = document.getElementById("myReceiptsOverlay");
  if (!overlay) return;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeMyReceiptsOverlay(); });
  document.getElementById("myReceiptsCloseBtn").addEventListener("click", closeMyReceiptsOverlay);
  overlay.querySelectorAll("[data-receipt-lightbox]").forEach((el) => {
    el.addEventListener("click", () => openImageLightbox(el.dataset.receiptLightbox, "영수증"));
  });
  overlay.querySelectorAll("[data-my-receipt-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteOverallReceiptPhoto(el.dataset.myReceiptDelete));
  });
}

// Items not yet marked "주문완료" float to the top of their subcategory so
// missed or newly-arrived requests stand out; within each group, keep the
// same order the staff selection screen uses.
function sortItems(list) {
  return [...list].sort((a, b) => {
    const an = a.ordered ? 1 : 0;
    const bn = b.ordered ? 1 : 0;
    if (an !== bn) return an - bn;
    const ao = materialsOrder[a.id] ?? 9999;
    const bo = materialsOrder[b.id] ?? 9999;
    if (ao !== bo) return ao - bo;
    return (a.materialName || "").localeCompare(b.materialName || "");
  });
}

function hasReceiptFor(it) {
  return receiptPhotos.length > 0 || !!(it && it.ownerAttachedPhotos && it.ownerAttachedPhotos.length > 0);
}

// 이미 첨부해둔 영수증 사진을 지우면, 아직 공유 전(orderedPending)으로
// 체크만 해둔 상태였던 항목은 그 체크의 근거가 사라진 거라 다시 잠겨야
// 한다 — 지우자마자 여기서 바로 떨어내서 체크박스가 눈에 보이게 재잠금된다.
function reconcileOrderedPending() {
  if (!RECEIPT_REQUIRED_TO_CHECK) return;
  for (const id of [...orderedPending]) {
    const it = items.find((x) => x.id === id);
    if (!it || !hasReceiptFor(it)) orderedPending.delete(id);
  }
}

async function deleteOverallReceiptPhoto(url) {
  if (!confirm("삭제하면 아직 공유 전인 발주들은 체크를 다시 해야 해요. 삭제할까요?")) return;
  await setDoc(
    doc(db, "checks", datePick.value),
    {
      receiptPhotos: receiptPhotos.filter((u) => u !== url),
      allReceiptPhotosHistory: allReceiptPhotosHistory.filter((u) => u !== url),
    },
    { merge: true }
  );
  toast("삭제완료");
}

async function deleteItemReceiptPhoto(itemId, url) {
  if (!confirm("삭제하면 이 자재의 주문완료 체크가 다시 잠겨요. 삭제할까요?")) return;
  const it = items.find((x) => x.id === itemId);
  if (!it) return;
  const next = (it.ownerAttachedPhotos || []).filter((u) => u !== url);
  await updateDoc(doc(db, "checks", datePick.value, "items", itemId), { ownerAttachedPhotos: next });
  toast("삭제완료");
}

function toggleOrderedLocal(id, checked) {
  const it = items.find((x) => x.id === id);
  if (it && it.ordered) return; // already shared and locked — can't uncheck
  if (RECEIPT_REQUIRED_TO_CHECK && !hasReceiptFor(it)) return; // 체크박스 자체가 disabled라 평소엔 안 들어오지만, 방어적으로 한 번 더 막는다
  if (checked) orderedPending.add(id);
  else orderedPending.delete(id);
  render();
}

async function shareOrderedChecks() {
  if (orderedPending.size === 0) {
    toast("체크된 항목이 없어요");
    return;
  }
  const ids = [...orderedPending];
  // 영수증 첨부 잠금을 풀어둔 동안엔(RECEIPT_REQUIRED_TO_CHECK = false), 첨부
  // 없이도 체크·공유가 되니까 — 공유 직전에 한 번이라도 첨부된 사진이
  // 있는지 확인해서, 하나도 없으면 그래도 보낼지 한 번 더 물어본다.
  if (!RECEIPT_REQUIRED_TO_CHECK && !ids.some((id) => hasReceiptFor(items.find((x) => x.id === id)))) {
    if (!confirm("영수증 첨부가 되지 않았습니다. 그래도 공유할까요?")) return;
  }
  const byStaff = {}; // staffPhone -> { staffName, count } — one push per staff member per submit, not per item
  for (const id of ids) {
    try {
      const it = items.find((x) => x.id === id);
      // "선택 자재 영수증"으로 그 자재에 콕 집어 첨부한 사진만 그 자재 항목에
      // 남긴다 — "전체 영수증"은 특정 자재 하나의 것이 아니니 개별 항목에
      // 복사해 붙이지 않고, 그날 모아보는 영수증 모음(allReceiptPhotosHistory)
      // 쪽에만 남긴다.
      const photosForItem = (it && it.ownerAttachedPhotos && it.ownerAttachedPhotos.length > 0) ? it.ownerAttachedPhotos : [];
      await updateDoc(doc(db, "checks", datePick.value, "items", id), { ordered: true, orderedAt: serverTimestamp(), receiptPhotos: photosForItem });
      orderedPending.delete(id);
      if (it && it.staffPhone) {
        const key = it.staffPhone;
        if (!byStaff[key]) byStaff[key] = { staffName: it.staffName || "", count: 0 };
        byStaff[key].count++;
      }
    } catch (e) {
      toast("일부 항목 업데이트에 실패했어요");
    }
  }
  for (const [staffPhone, info] of Object.entries(byStaff)) {
    await addDoc(collection(db, "checks", datePick.value, "orderBatches"), {
      staffPhone,
      staffName: info.staffName,
      itemCount: info.count,
      receiptPhotos,
      createdAt: serverTimestamp(),
    });
  }
  // 이번에 첨부한 영수증은 이번 체크분에만 유효 — 공유 후에 새로 들어오는
  // 요청들은 그 사이에 실제로 결제했다는 보장이 없으니, 다음 체크를 위해선
  // 다시 영수증을 첨부하게 잠금을 되돌린다.
  await setDoc(doc(db, "checks", datePick.value), { receiptPhotos: [] }, { merge: true });
  receiptPhotos = [];
  renderReceiptCard();
  toast("체크한 항목을 직원에게 공유했어요");
  recordSubmitToday();
  render();
}

function render() {
  const newCount = items.filter((i) => !i.ordered).length;
  newRequestText.textContent = newCount > 0 ? `신규 발주 요청 ${newCount}건` : "신규 발주 요청이 없습니다";
  newRequestCard.classList.toggle("new", newCount > 0);
  if (newCount > 0) {
    // Restart the flash on every render (not just the first time it appears)
    // so it stays noticeable whenever there's an unhandled request waiting —
    // whether that's from just now or from before the page was even opened.
    newRequestCard.classList.remove("flash");
    void newRequestCard.offsetWidth;
    newRequestCard.classList.add("flash");
  }
  urgentCount.textContent = items.filter((i) => i.urgency === "urgent" || i.urgency === "soldout").length;

  if (items.length === 0) {
    orderList.innerHTML = `<div class="card"><div class="empty">이 날짜엔 담긴 발주 항목이 없어요.</div></div>`;
    if (stickyShareBarEl) stickyShareBarEl.innerHTML = "";
    return;
  }

  const byMain = {};
  for (const it of items) {
    const main = it.mainCategory || "기본자재";
    if (!byMain[main]) byMain[main] = [];
    byMain[main].push(it);
  }

  // A main category with any leftover not-yet-ordered item floats above one
  // that's fully handled — otherwise a straggling item under "식자재" sits
  // visually buried below the entire (possibly long) "기본자재" section just
  // because of the fixed category order, even though it needs attention.
  const order = ["기본자재", "식자재"];
  const mains = Object.keys(byMain).sort((a, b) => {
    const aNew = byMain[a].some((it) => !it.ordered) ? 0 : 1;
    const bNew = byMain[b].some((it) => !it.ordered) ? 0 : 1;
    if (aNew !== bNew) return aNew - bNew;
    return order.indexOf(a) - order.indexOf(b);
  });

  function itemRowHtml(it, showSub) {
    const isChecked = it.ordered || orderedPending.has(it.id);
    const isLocked = !!it.ordered;
    const isReceiptLocked = !isLocked && RECEIPT_REQUIRED_TO_CHECK && !hasReceiptFor(it);
    return `
      <div class="item-row ${isChecked ? "ordered" : ""}">
        <div style="flex:1">
          <div class="name">${!it.ordered && !orderedPending.has(it.id) ? `<span class="tag new">NEW</span>` : ""}<span class="dot ${it.urgency}"></span>${escapeHtml(it.materialName)}${showSub && it.subCategory ? `<span class="subcat-inline-tag">${escapeHtml(it.subCategory)}</span>` : ""}${it.qty ? `<span class="qty-pill">${escapeHtml(qtyRemainingLabel(it.qty))}</span>` : ""}${it.orderQty && it.orderQty > 1 ? `<span class="qty-pill">요청 ${it.orderQty}개</span>` : ""}</div>
          ${it.note ? `<div class="note">${escapeHtml(it.note)}</div>` : ""}
          ${materialPhotoUrlsOf(it).map((url) => `<img src="${url}" class="note-photo-thumb" data-receipt-lightbox="${url}" alt="첨부 사진" />`).join("")}
          ${it.ownerAttachedPhotos && it.ownerAttachedPhotos.length > 0 ? `
          <div class="owner-receipt-comment">
            <div class="owner-receipt-comment-label">📎 내가 첨부한 영수증</div>
            <div class="receipt-photo-row">${it.ownerAttachedPhotos.map((url) => isLocked
              ? `<img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />`
              : `<div class="photo-preview">
                   <img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />
                   <button type="button" class="photo-remove-btn" data-item-receipt-delete-id="${it.id}" data-item-receipt-delete-url="${url}">✕</button>
                 </div>`).join("")}</div>
          </div>` : ""}
          <div class="who">${it.staffName ? escapeHtml(it.staffName) + "님" : ""}${formatTimeLabel(it.updatedAt) ? ` · ${formatTimeLabel(it.updatedAt)}` : ""}</div>
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
          <span class="badge ${it.urgency}">${it.urgency === "urgent" ? "🚨 " : ""}${URGENCY_LABEL[it.urgency] || it.urgency}</span>
          <div class="order-check ${isReceiptLocked ? "receipt-locked" : ""}" ${isReceiptLocked ? `data-receipt-locked="${it.id}"` : ""}>
            <input type="checkbox" id="ordered-${it.id}" data-ordered-id="${it.id}" ${isChecked ? "checked" : ""} ${isLocked || isReceiptLocked ? "disabled" : ""} />
            <label for="ordered-${it.id}">${isLocked ? "공유됨" : isReceiptLocked ? "🔒 주문완료" : "주문완료"}</label>
          </div>
          ${isLocked && formatTimestampLabel(it.orderedAt) ? `<span style="font-size:10px; color:var(--muted); text-align:right;">${formatTimestampLabel(it.orderedAt)}</span>` : ""}
        </div>
      </div>`;
  }

  let html = "";
  for (const main of mains) {
    // 품절/긴급 항목은 소분류에 상관없이 이 대분류 카드 맨 위에 따로 모아서
    // 보여준다 — 나머지(정상 발주)는 기존처럼 소분류별로 묶는다.
    const soldoutItems = byMain[main].filter((it) => it.urgency === "soldout");
    const urgentItems = byMain[main].filter((it) => it.urgency === "urgent");
    const restItems = byMain[main].filter((it) => it.urgency !== "urgent" && it.urgency !== "soldout");

    const bySub = {};
    for (const it of restItems) {
      const sub = it.subCategory || "기타";
      if (!bySub[sub]) bySub[sub] = [];
      bySub[sub].push(it);
    }
    html += `<div class="category-title">${escapeHtml(main)}<span class="sub">${byMain[main].length}건</span></div>`;
    html += `<div class="card">`;

    if (soldoutItems.length > 0) {
      html += `<div class="subcat-title urgency-caption soldout" style="margin-top:0;"><span class="urgency-caption-label">${URGENCY_LABEL.soldout}</span>${URGENCY_GROUP_CAPTION.soldout}</div>`;
      for (const it of sortItems(soldoutItems)) html += itemRowHtml(it, true);
    }

    if (urgentItems.length > 0) {
      html += `<div class="subcat-title urgency-caption urgent" style="margin-top:${soldoutItems.length > 0 ? "14px" : "0"};"><span class="urgency-caption-label">${URGENCY_LABEL.urgent}</span>${URGENCY_GROUP_CAPTION.urgent}</div>`;
      for (const it of sortItems(urgentItems)) html += itemRowHtml(it, true);
    }

    if (restItems.length > 0) {
      const isFirstGroup = soldoutItems.length === 0 && urgentItems.length === 0;
      html += `<div class="subcat-title urgency-caption normal" style="margin-top:${isFirstGroup ? "0" : "14px"};"><span class="urgency-caption-label">${URGENCY_LABEL.normal}</span>${URGENCY_GROUP_CAPTION.normal}</div>`;

      // Subcategories with any not-yet-ordered item float above fully-completed
      // ones, so a fresh request never gets buried under an already-handled group.
      // Within that, the owner's explicit 소분류 순서 wins; anything not yet
      // arranged there falls back to catalog first-appearance order.
      const explicitRank = {};
      (subcategoryOrder[main] || []).forEach((name, i) => { explicitRank[name] = i; });
      const subs = Object.keys(bySub).sort((subA, subB) => {
        const aNew = bySub[subA].some((it) => !it.ordered) ? 0 : 1;
        const bNew = bySub[subB].some((it) => !it.ordered) ? 0 : 1;
        if (aNew !== bNew) return aNew - bNew;
        const aExp = explicitRank[subA] ?? 9999;
        const bExp = explicitRank[subB] ?? 9999;
        if (aExp !== bExp) return aExp - bExp;
        const ao = materialFirstAppearanceRank[`${main}::${subA}`] ?? 9999;
        const bo = materialFirstAppearanceRank[`${main}::${subB}`] ?? 9999;
        return ao - bo;
      });
      subs.forEach((sub) => {
        html += `<div class="subcat-title" style="margin-top:14px">${escapeHtml(sub)}</div>`;
        for (const it of sortItems(bySub[sub])) html += itemRowHtml(it);
      });
    }
    html += `</div>`;
  }

  orderList.innerHTML = html;

  orderList.querySelectorAll("[data-ordered-id]").forEach((el) => {
    el.addEventListener("change", (e) => toggleOrderedLocal(e.target.dataset.orderedId, e.target.checked));
  });
  orderList.querySelectorAll("[data-receipt-locked]").forEach((el) => {
    el.addEventListener("click", () => toast("주문완료 체크를 위해 이미지를 먼저 첨부해주세요"));
  });
  orderList.querySelectorAll("[data-receipt-lightbox]").forEach((el) => {
    el.addEventListener("click", () => openImageLightbox(el.dataset.receiptLightbox, "영수증"));
  });
  orderList.querySelectorAll("[data-item-receipt-delete-id]").forEach((el) => {
    el.addEventListener("click", () => deleteItemReceiptPhoto(el.dataset.itemReceiptDeleteId, el.dataset.itemReceiptDeleteUrl));
  });
  renderStickyShareBar();
}

function buildShareText() {
  let text = `[${STORE_NAME}] ${formatDateLabel(datePick.value)} 발주 리스트\n`;
  if (items.length === 0) {
    text += "\n담긴 발주 항목이 없습니다.";
    return text;
  }

  const byMain = {};
  for (const it of items) {
    const main = it.mainCategory || "기본자재";
    if (!byMain[main]) byMain[main] = [];
    byMain[main].push(it);
  }
  const order = ["기본자재", "식자재"];
  const mains = Object.keys(byMain).sort((a, b) => order.indexOf(a) - order.indexOf(b));

  for (const main of mains) {
    text += `\n■ ${main}\n`;
    for (const it of sortItems(byMain[main])) {
      const tag = it.urgency === "urgent" ? "[긴급] " : it.urgency === "soldout" ? "[품절] " : "";
      const qtyText = it.qty ? ` (${qtyRemainingLabel(it.qty)})` : "";
      const orderQtyText = it.orderQty && it.orderQty > 1 ? ` [요청 ${it.orderQty}개]` : "";
      text += `- ${tag}${it.materialName}${qtyText}${orderQtyText}${it.note ? ` : ${it.note}` : ""}\n`;
    }
  }
  text += `\n총 ${items.length}건 (긴급/품절 ${items.filter((i) => i.urgency === "urgent" || i.urgency === "soldout").length}건)`;
  return text;
}

async function onShareBtnClick() {
  const text = buildShareText();
  if (navigator.share) {
    try {
      await navigator.share({ title: `${STORE_NAME} 발주 리스트`, text });
      return;
    } catch (e) {
      // fall through to preview
    }
  }
  sharePreview.textContent = text;
  previewCard.style.display = "block";
  previewCard.scrollIntoView({ behavior: "smooth" });
}

// navigator.clipboard.writeText() throws in a bunch of real-world mobile
// situations (PWA standalone context, a stale/lost document focus, older
// WebViews) even though copying itself is perfectly possible there — so on
// any failure, fall back to the old select-a-hidden-textarea + execCommand
// approach before actually telling the user it failed.
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

async function onCopyBtnClick() {
  const text = sharePreview.textContent;
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard api");
    await navigator.clipboard.writeText(text);
    toast("복사했어요. 카카오톡 등에 붙여넣기 하세요");
  } catch (e) {
    if (legacyCopy(text)) {
      toast("복사했어요. 카카오톡 등에 붙여넣기 하세요");
    } else {
      toast("복사에 실패했어요. 직접 선택해서 복사해주세요");
    }
  }
}

// 종 아이콘은 이제 켜짐/꺼짐을 자기가 보여주지 않는다 — 탭하면 뜨는
// 알림내역 패널 안에 푸시 on/off 토글이 있고, 종 자체는 고정 아이콘 +
// 안 읽은 알림 개수 배지만 보여준다(push.js의 watchNotificationBadge).
function onNotifyBtnClick() {
  openNotificationPanel(myOwnerPhone);
}

function isLastDayOfMonth() {
  const today = new Date();
  return today.getDate() === new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
}

export function mount(account) {
  myOwnerPhone = account.phone;
  mountHumanityTrigger(document.getElementById("humanityBtn"), document.getElementById("humanityOverlayRoot"), account);

  const monthEndBanner = document.getElementById("monthEndBanner");
  if (monthEndBanner) monthEndBanner.style.display = isLastDayOfMonth() ? "block" : "none";

  pageSub = document.getElementById("pageSub");
  datePick = document.getElementById("datePick");
  todayBtn = document.getElementById("todayBtn");
  dayChips = document.getElementById("dayChips");
  receiptClipRowEl = document.getElementById("receiptClipRow");
  orderList = document.getElementById("orderList");
  newRequestCard = document.getElementById("newRequestCard");
  newRequestText = document.getElementById("newRequestText");
  urgentCount = document.getElementById("urgentCount");
  shareBtn = document.getElementById("shareBtn");
  previewCard = document.getElementById("previewCard");
  sharePreview = document.getElementById("sharePreview");
  copyBtn = document.getElementById("copyBtn");
  notifyBtn = document.getElementById("notifyBtn");
  notifyBadgeEl = document.getElementById("notifyBadge");
  notifyBtn.innerHTML = NOTIFY_BELL_ON;
  quickOrderLinksEl = document.getElementById("quickOrderLinks");
  receiptCardEl = document.getElementById("receiptCard");
  stickyShareBarEl = document.getElementById("stickyShareBar");
  myReceiptsOverlayRoot = document.getElementById("myReceiptsOverlayRoot");
  trendOverlayRoot = document.getElementById("trendOverlayRoot");

  quickOrderLinksEl.innerHTML = QUICK_ORDER_LINKS
    .map((l) => `<a class="btn soft" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`)
    .join("");

  datePick.value = todayStr();
  updateDateLabel();
  renderReceiptCard();
  datePick.addEventListener("change", () => { updateDateLabel(); subscribe(); renderChips(); });
  todayBtn.addEventListener("click", () => { datePick.value = todayStr(); updateDateLabel(); subscribe(); renderChips(); });
  shareBtn.addEventListener("click", onShareBtnClick);
  copyBtn.addEventListener("click", onCopyBtnClick);
  notifyBtn.addEventListener("click", onNotifyBtnClick);
  watchNotificationBadge(notifyBadgeEl, myOwnerPhone);

  renderChips();
  subscribe();
  loadChipCounts();

  materialsUnsub = onSnapshot(collection(db, "materials"), (snap) => {
    const mats = sortMaterials(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    materialsOrder = {};
    materialFirstAppearanceRank = {};
    materialReceiptAlias = {};
    mats.forEach((m, idx) => {
      materialsOrder[m.id] = idx;
      const key = `${m.mainCategory}::${m.subCategory}`;
      if (!(key in materialFirstAppearanceRank)) materialFirstAppearanceRank[key] = idx;
      materialReceiptAlias[m.id] = m.receiptAlias || "";
    });
    render();
  });

  subcatUnsub = onSnapshot(doc(db, "config", "subcategoryOrder"), (snap) => {
    subcategoryOrder = snap.exists() ? snap.data() : {};
    render();
  });
}

export function unmount() {
  if (unsub) { unsub(); unsub = null; }
  if (receiptUnsub) { receiptUnsub(); receiptUnsub = null; }
  if (materialsUnsub) { materialsUnsub(); materialsUnsub = null; }
  if (subcatUnsub) { subcatUnsub(); subcatUnsub = null; }
}
