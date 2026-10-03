// 오늘 발주 view — mounted/unmounted by app-shell.js. Everything here that
// touches the DOM or subscribes to Firestore is scoped inside mount()/
// unmount() rather than running at module load time, since this module now
// stays loaded across tab switches instead of being torn down by a full
// page reload each time.
import { db, storage, ref, uploadBytes, getDownloadURL, STORE_NAME, QUICK_ORDER_LINKS, collection, doc, addDoc, updateDoc, setDoc, onSnapshot, getDocs, serverTimestamp } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimeLabel, formatTimestampLabel, toast, escapeHtml, resizeImageFile, openImageLightbox, URGENCY_LABEL, URGENCY_GROUP_CAPTION, sortMaterials, dayAccentClass, NOTIFY_BELL_ON, NOTIFY_BELL_OFF } from "./util.js";
import { isPushDisabled, disablePushToken, enablePushToken } from "./push.js";
import { recordSubmitToday } from "./mascot.js";
import { mountHumanityTrigger } from "./humanityboard.js";

let myOwnerPhone = "";

let datePick, todayBtn, dayChips, orderList, newRequestCard, newRequestText, urgentCount, shareBtn, previewCard, sharePreview, copyBtn, notifyBtn, quickOrderLinksEl, pageSub;

let items = []; // {id, ...data}
let unsub = null;
let materialsUnsub = null;
let subcatUnsub = null;
let materialsOrder = {}; // materialId -> catalog rank (matches the staff selection-tab order)
let materialFirstAppearanceRank = {}; // "main::sub" -> first-appearance rank in the catalog (fallback order)
let subcategoryOrder = {}; // { 기본자재: string[], 식자재: string[] } from config/subcategoryOrder — owner's explicit order
let orderedPending = new Set(); // item ids checked locally but not yet shared/locked
let receiptPhotos = []; // 지금 보고 있는 날짜의 "전체 영수증" 사진 URL들 — live
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
    chipCounts[datePick.value] = items.length;
    chipUnordered[datePick.value] = items.some((it) => !it.ordered);
    render();
    renderChips();
    renderReceiptCard();
  });
  if (receiptUnsub) receiptUnsub();
  receiptPhotos = [];
  receiptUnsub = onSnapshot(doc(db, "checks", datePick.value), (snap) => {
    receiptPhotos = (snap.exists() && snap.data().receiptPhotos) || [];
    renderReceiptCard();
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
    for (const p of receiptPendingFiles) {
      const blob = await resizeImageFile(p.file);
      const path = `receiptPhotos/${datePick.value}/${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      urls.push(await getDownloadURL(fileRef));
    }
    if (receiptMode === "all") {
      await setDoc(doc(db, "checks", datePick.value), { receiptPhotos: [...receiptPhotos, ...urls] }, { merge: true });
    } else {
      await Promise.all([...receiptSelectedIds].map((id) => {
        const it = items.find((x) => x.id === id);
        const existing = (it && it.ownerAttachedPhotos) || [];
        return updateDoc(doc(db, "checks", datePick.value, "items", id), { ownerAttachedPhotos: [...existing, ...urls] });
      }));
    }
    toast("첨부완료");
    resetReceiptDraft();
    renderReceiptCard();
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  } finally {
    receiptUploading = false;
  }
}

function receiptCardHtml() {
  const isToday = datePick.value === todayStr();

  if (receiptMode === null) {
    return `
      <div class="field" style="margin:0;">
        <label>결제 영수증 (주문완료 체크 전 필수)</label>
        <button type="button" class="btn secondary block" id="receiptModeAllBtn" style="margin-top:8px;">🧾 전체 영수증 첨부</button>
        <button type="button" class="btn secondary block" id="receiptModeSelectBtn" style="margin-top:8px;">🎯 선택 자재 영수증 첨부</button>
        <button type="button" class="btn secondary block" id="myReceiptsBtn" style="margin-top:8px;">📎 ${isToday ? "오늘 " : ""}내가 첨부한 영수증 보기</button>
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
      ${previewHtml}
      <label class="btn secondary block receipt-upload-btn" style="margin-top:8px;">
        📷 영수증 사진 추가
        <input type="file" accept="image/*" id="receiptPhotoInput" multiple style="display:none;" />
      </label>
      <button type="button" class="btn gold block" id="receiptAttachSubmitBtn" style="margin-top:8px;">첨부하기${receiptPendingFiles.length > 0 ? ` (${receiptPendingFiles.length})` : ""}</button>
      <button type="button" class="btn secondary block" id="myReceiptsBtn" style="margin-top:8px;">📎 ${isToday ? "오늘 " : ""}내가 첨부한 영수증 보기</button>
    </div>`;
}

function wireReceiptCard() {
  const allBtn = document.getElementById("receiptModeAllBtn");
  if (allBtn) allBtn.addEventListener("click", () => { receiptMode = "all"; renderReceiptCard(); });
  const selectBtn = document.getElementById("receiptModeSelectBtn");
  if (selectBtn) selectBtn.addEventListener("click", () => { receiptMode = "select"; renderReceiptCard(); });
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
  const myBtn = document.getElementById("myReceiptsBtn");
  if (myBtn) myBtn.addEventListener("click", openMyReceiptsOverlay);
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
  const overallUrls = receiptPhotos;
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
          <div class="receipt-photo-row" style="margin-top:12px;">${overallUrls.map((url) => `<img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />`).join("")}</div>
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

function toggleOrderedLocal(id, checked) {
  const it = items.find((x) => x.id === id);
  if (it && it.ordered) return; // already shared and locked — can't uncheck
  if (!hasReceiptFor(it)) return; // 체크박스 자체가 disabled라 평소엔 안 들어오지만, 방어적으로 한 번 더 막는다
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
  const byStaff = {}; // staffPhone -> { staffName, count } — one push per staff member per submit, not per item
  for (const id of ids) {
    try {
      const it = items.find((x) => x.id === id);
      const photosForItem = (it && it.ownerAttachedPhotos && it.ownerAttachedPhotos.length > 0) ? it.ownerAttachedPhotos : receiptPhotos;
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
    const isReceiptLocked = !isLocked && !hasReceiptFor(it);
    return `
      <div class="item-row ${isChecked ? "ordered" : ""}">
        <div style="flex:1">
          <div class="name">${!it.ordered && !orderedPending.has(it.id) ? `<span class="tag new">NEW</span>` : ""}<span class="dot ${it.urgency}"></span>${escapeHtml(it.materialName)}${showSub && it.subCategory ? `<span class="subcat-inline-tag">${escapeHtml(it.subCategory)}</span>` : ""}${it.qty ? `<span class="qty-pill">${escapeHtml(it.qty)} 남음</span>` : ""}${it.orderQty && it.orderQty > 1 ? `<span class="qty-pill">요청 ${it.orderQty}개</span>` : ""}</div>
          ${it.note ? `<div class="note">${escapeHtml(it.note)}</div>` : ""}
          ${materialPhotoUrlsOf(it).map((url) => `<a href="${url}" target="_blank" rel="noopener"><img src="${url}" class="note-photo-thumb" alt="첨부 사진" /></a>`).join("")}
          ${it.ownerAttachedPhotos && it.ownerAttachedPhotos.length > 0 ? `
          <div class="owner-receipt-comment">
            <div class="owner-receipt-comment-label">📎 내가 첨부한 영수증</div>
            <div class="receipt-photo-row">${it.ownerAttachedPhotos.map((url) => `<img src="${url}" class="receipt-photo-thumb" data-receipt-lightbox="${url}" alt="영수증" />`).join("")}</div>
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
      const qtyText = it.qty ? ` (${it.qty} 남음)` : "";
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

function updateNotifyBtn() {
  if (!("Notification" in window)) {
    notifyBtn.innerHTML = NOTIFY_BELL_OFF;
    notifyBtn.title = "알림 미지원 기기";
    notifyBtn.disabled = true;
    return;
  }
  if (Notification.permission === "denied") {
    notifyBtn.innerHTML = NOTIFY_BELL_OFF;
    notifyBtn.title = "알림 차단됨 (기기 설정에서 허용 필요)";
  } else if (Notification.permission === "granted" && !isPushDisabled()) {
    notifyBtn.innerHTML = NOTIFY_BELL_ON;
    notifyBtn.title = "알림 켜짐 (탭하면 끄기)";
  } else {
    notifyBtn.innerHTML = NOTIFY_BELL_OFF;
    notifyBtn.title = "알림 설정하려면 탭하세요";
  }
}

async function onNotifyBtnClick() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    if (isPushDisabled()) {
      if (myOwnerPhone) await enablePushToken(myOwnerPhone);
      toast("알림을 켰어요");
    } else {
      if (myOwnerPhone) await disablePushToken(myOwnerPhone);
      toast("알림을 껐어요");
    }
    updateNotifyBtn();
    return;
  }
  const perm = await Notification.requestPermission();
  updateNotifyBtn();
  if (perm === "granted" && myOwnerPhone) enablePushToken(myOwnerPhone);
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
  orderList = document.getElementById("orderList");
  newRequestCard = document.getElementById("newRequestCard");
  newRequestText = document.getElementById("newRequestText");
  urgentCount = document.getElementById("urgentCount");
  shareBtn = document.getElementById("shareBtn");
  previewCard = document.getElementById("previewCard");
  sharePreview = document.getElementById("sharePreview");
  copyBtn = document.getElementById("copyBtn");
  notifyBtn = document.getElementById("notifyBtn");
  quickOrderLinksEl = document.getElementById("quickOrderLinks");
  receiptCardEl = document.getElementById("receiptCard");
  stickyShareBarEl = document.getElementById("stickyShareBar");
  myReceiptsOverlayRoot = document.getElementById("myReceiptsOverlayRoot");

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
  updateNotifyBtn();

  renderChips();
  subscribe();
  loadChipCounts();

  materialsUnsub = onSnapshot(collection(db, "materials"), (snap) => {
    const mats = sortMaterials(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    materialsOrder = {};
    materialFirstAppearanceRank = {};
    mats.forEach((m, idx) => {
      materialsOrder[m.id] = idx;
      const key = `${m.mainCategory}::${m.subCategory}`;
      if (!(key in materialFirstAppearanceRank)) materialFirstAppearanceRank[key] = idx;
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
