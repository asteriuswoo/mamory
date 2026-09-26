// 오늘 발주 view — mounted/unmounted by app-shell.js. Everything here that
// touches the DOM or subscribes to Firestore is scoped inside mount()/
// unmount() rather than running at module load time, since this module now
// stays loaded across tab switches instead of being torn down by a full
// page reload each time.
import { db, STORE_NAME, QUICK_ORDER_LINKS, collection, doc, updateDoc, onSnapshot, getDocs, serverTimestamp } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimeLabel, formatTimestampLabel, toast, escapeHtml, URGENCY_LABEL, sortMaterials } from "./util.js";
import { isPushDisabled, disablePushToken, enablePushToken } from "./push.js";
import { recordSubmitToday } from "./mascot.js";

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
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));
const chipCounts = {};
const chipUnordered = {}; // date -> true if that date still has any not-yet-ordered item

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

function toggleOrderedLocal(id, checked) {
  const it = items.find((x) => x.id === id);
  if (it && it.ordered) return; // already shared and locked — can't uncheck
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
  for (const id of ids) {
    try {
      await updateDoc(doc(db, "checks", datePick.value, "items", id), { ordered: true, orderedAt: serverTimestamp() });
      orderedPending.delete(id);
    } catch (e) {
      toast("일부 항목 업데이트에 실패했어요");
    }
  }
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

  let html = "";
  for (const main of mains) {
    const bySub = {};
    for (const it of byMain[main]) {
      const sub = it.subCategory || "기타";
      if (!bySub[sub]) bySub[sub] = [];
      bySub[sub].push(it);
    }
    html += `<div class="category-title">${escapeHtml(main)}<span class="sub">${byMain[main].length}건</span></div>`;
    html += `<div class="card">`;
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
    subs.forEach((sub, idx) => {
      if (idx > 0) html += `<div class="subcat-title" style="margin-top:14px">${escapeHtml(sub)}</div>`;
      else html += `<div class="subcat-title" style="margin-top:0">${escapeHtml(sub)}</div>`;
      for (const it of sortItems(bySub[sub])) {
        const isChecked = it.ordered || orderedPending.has(it.id);
        const isLocked = !!it.ordered;
        html += `
          <div class="item-row ${isChecked ? "ordered" : ""}">
            <div style="flex:1">
              <div class="name">${!it.ordered && !orderedPending.has(it.id) ? `<span class="tag new">NEW</span>` : ""}<span class="dot ${it.urgency}"></span>${escapeHtml(it.materialName)}${it.qty ? `<span class="qty-pill">${escapeHtml(it.qty)} 남음</span>` : ""}</div>
              ${it.note ? `<div class="note">${escapeHtml(it.note)}</div>` : ""}
              ${it.photoUrl ? `<a href="${it.photoUrl}" target="_blank" rel="noopener"><img src="${it.photoUrl}" class="note-photo-thumb" alt="첨부 사진" /></a>` : ""}
              <div class="who">${it.staffName ? escapeHtml(it.staffName) + "님" : ""}${formatTimeLabel(it.updatedAt) ? ` · ${formatTimeLabel(it.updatedAt)}` : ""}</div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px;">
              <span class="badge ${it.urgency}">${URGENCY_LABEL[it.urgency] || it.urgency}</span>
              <div class="order-check">
                <input type="checkbox" id="ordered-${it.id}" data-ordered-id="${it.id}" ${isChecked ? "checked" : ""} ${isLocked ? "disabled" : ""} />
                <label for="ordered-${it.id}">${isLocked ? "공유됨" : "주문완료"}</label>
              </div>
              ${isLocked && formatTimestampLabel(it.orderedAt) ? `<span style="font-size:10px; color:var(--muted); text-align:right;">${formatTimestampLabel(it.orderedAt)}</span>` : ""}
            </div>
          </div>`;
      }
    });
    html += `</div>`;
  }

  const pendingN = orderedPending.size;
  html += `
    <div class="card">
      <button class="btn ${pendingN > 0 ? "gold" : "secondary"} block" id="shareCheckedBtn">
        체크하고 직원에게 공유${pendingN > 0 ? ` (${pendingN})` : ""}
      </button>
    </div>`;

  orderList.innerHTML = html;

  orderList.querySelectorAll("[data-ordered-id]").forEach((el) => {
    el.addEventListener("change", (e) => toggleOrderedLocal(e.target.dataset.orderedId, e.target.checked));
  });
  const shareCheckedBtn = document.getElementById("shareCheckedBtn");
  if (shareCheckedBtn) shareCheckedBtn.addEventListener("click", shareOrderedChecks);
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
      text += `- ${tag}${it.materialName}${qtyText}${it.note ? ` : ${it.note}` : ""}\n`;
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

export function mount(account) {
  myOwnerPhone = account.phone;

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

  quickOrderLinksEl.innerHTML = QUICK_ORDER_LINKS
    .map((l) => `<a class="btn soft" href="${escapeHtml(l.url)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`)
    .join("");

  datePick.value = todayStr();
  updateDateLabel();
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
  if (materialsUnsub) { materialsUnsub(); materialsUnsub = null; }
  if (subcatUnsub) { subcatUnsub(); subcatUnsub = null; }
}
