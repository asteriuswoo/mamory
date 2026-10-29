// 등록해요 — 직원 화면(staff.js)과 사장님 화면(register.js)에서 공통으로 쓰는
// 렌더링/데이터 모듈. mountRegisterBoard(el, account)로 붙여 쓴다.
// 세 가지 독립된 기능을 한 화면에 담는다:
//   1. 시재 등록 — 권종별 장수를 세서 "시재 등록"을 누르면 그 한 번이 통째로
//      하나의 기록으로 로그에 쌓인다(덮어쓰지 않음). 하루에 여러 번 등록해도
//      전부 시간/등록자/권종별 내역과 함께 남는다.
//   2. 현금 지출 내역 — 돈통에서 현금으로 급하게 쓴 비용(우유 급구매, 얼음
//      주문 등) 기록 — 시재와 같은 날짜 범위를 공유한다.
//   3. 선결제 충전 등록 — 손님이 충전할 때마다 남기는 기록. 차감/잔액 개념 없이
//      "누가 언제 얼마 냈는지"만 쌓이는 로그이며, 같은 손님 이름으로 계속 쌓인다.
import { db, collection, doc, addDoc, updateDoc, deleteDoc, getDocs, setDoc, arrayUnion, arrayRemove, writeBatch, onSnapshot, query, orderBy, serverTimestamp, runTransaction, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimestampLabel, formatTimeLabel, toast, escapeHtml, resizeImageFile, dayAccentClass, openImageLightbox, showActionSheet, MULTIPLE_FILE_ATTR } from "./util.js";
import { avatarHtml, watchAccounts } from "./avatar.js";

const date = todayStr();
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));

// 시재등록(시재+현금지출)과 선결제등록은 서로 날짜 개념부터 다른 완전히
// 별개 기능이라 세그먼트 탭으로 나눈다 — 공유하기 탭과 같은 패턴. 새로고침해도
// 보던 탭 그대로 떠야 해서 sessionStorage에 남겨두고 시작할 때 복원한다.
const REGISTER_TAB_KEY = "mamory_registerTab";
function loadRegisterTab() {
  try {
    const saved = sessionStorage.getItem(REGISTER_TAB_KEY);
    return saved === "cash" || saved === "topup" ? saved : "cash";
  } catch (e) {
    return "cash";
  }
}
function saveRegisterTab() {
  try {
    sessionStorage.setItem(REGISTER_TAB_KEY, registerTab);
  } catch (e) {
    // sessionStorage 불가 환경이면 그냥 이번 로드는 기본 탭으로 넘어간다.
  }
}
let registerTab = loadRegisterTab(); // "cash" | "topup"

function dowLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return { dow: days[new Date(y, m - 1, d).getDay()], dnum: d };
}

let rootEl = null;
let account = { name: "", phone: "", role: "" };
let started = false;

// ---- 등록해요 하단 탭 N배지 ----
// 예전엔 시재/선결제 각 탭의 "마지막으로 본 시각"을 render() 때마다 갱신해서
// 판단했는데, 그 값이 바뀌어도 하단 탭 배지 자체는 다음 Firestore 변경이
// 와야 재평가돼서 — 탭에 들어가 보기만 해서는 안 사라지고 새로고침을
// 해야만 사라지는 문제가 있었다(공유하기 하단 배지에서 겪은 것과 같은
// 종류의 버그). 그래서 하단 탭 배지는 훨씬 단순하게, 하단 탭 아이콘 자체를
// 탭하는 순간 바로 꺼지고, 그 뒤에 올라온 활동이 있을 때만 다시 켜지는
// 방식으로 바꾼다.
const NAV_BADGE_SEEN_KEY = "mamory_registerNavBadgeSeenAt";
const registerBadgeListeners = [];

function loadNavBadgeSeenAt() {
  try {
    const all = JSON.parse(localStorage.getItem(NAV_BADGE_SEEN_KEY) || "{}");
    if (account.phone in all) return all[account.phone];
  } catch (e) {
    // localStorage 불가 환경 — 아래에서 지금 시각으로 새로 깔고 넘어간다.
  }
  const now = Date.now();
  saveNavBadgeSeenAt(now);
  return now;
}

function saveNavBadgeSeenAt(ts) {
  try {
    const all = JSON.parse(localStorage.getItem(NAV_BADGE_SEEN_KEY) || "{}");
    all[account.phone] = ts;
    localStorage.setItem(NAV_BADGE_SEEN_KEY, JSON.stringify(all));
  } catch (e) {
    // localStorage 불가 환경이면 그냥 이번 세션만 배지가 덜 정확한 걸로 넘어간다.
  }
}

function registerTabActivityMs(tab) {
  let max = 0;
  if (tab === "cash") {
    cashEntriesToday.forEach((e) => { max = Math.max(max, tsMillisDesc(e.createdAt)); });
    cashExpensesToday.forEach((e) => { max = Math.max(max, tsMillisDesc(e.createdAt)); });
  } else if (tab === "topup") {
    topups.forEach((t) => { max = Math.max(max, tsMillisDesc(t.createdAt)); });
  }
  return max;
}

function latestRegisterActivityMs() {
  return Math.max(registerTabActivityMs("cash"), registerTabActivityMs("topup"));
}

function notifyRegisterBadgeListeners() {
  registerBadgeListeners.forEach((cb) => cb());
}

// 하단 탭(등록해요)을 탭하는 순간 호출 — 그 즉시 배지가 꺼지고, 그 뒤에
// 올라온 활동이 있을 때만 다시 켜진다.
export function markRegisterNavBadgeSeen() {
  saveNavBadgeSeenAt(Date.now());
}

export function hasUnseenRegisterActivity() {
  return latestRegisterActivityMs() > loadNavBadgeSeenAt();
}

// 등록해요 화면을 아직 한 번도 안 열어봤어도(mountRegisterBoard 전) 하단 탭
// N배지가 바로 뜨도록, 화면 마운트와 무관하게 리스너만 미리 돌려둔다 —
// shareboard.js의 watchUnseenCount와 같은 패턴.
export function watchRegisterUnseen(acc, onChange) {
  account = { ...account, ...acc };
  registerBadgeListeners.push(onChange);
  ensureStarted();
  onChange();
}

const BILL_DENOMS = [50000, 10000, 5000, 1000];
const BILL_LABELS = { 50000: "50,000", 10000: "10,000", 5000: "5,000", 1000: "1,000" };

let cashDate = date;
let cashEntriesToday = []; // 항상 live — onSnapshot
let cashEntries = []; // 지금 보고 있는 날짜의 항목들 (오늘이면 cashEntriesToday와 동일)
const cashChipTotals = {}; // date -> 그 날 가장 최근 등록 총액 (칩에 표시)

// 지금 세고 있는 중인, 아직 등록 버튼을 안 누른 권종별 장수 — "등록" 버튼을
// 눌러야 비로소 하나의 기록으로 로그에 쌓인다. 그날 첫 등록은 0부터 직접
// 세어 타이핑하지만, 그 이후 등록은 이미 몇 장인지 알고 있으니 마지막으로
// 등록된 장수에서 시작해 +/-로만 조정한다(아래 primeCashDraftFromLatest).
let cashDraft = { 50000: 0, 10000: 0, 5000: 0, 1000: 0 };
// 사용자가 이번 세션에서 +/- 를 한 번이라도 눌렀으면 true — 그 이후엔 다른
// 기기의 실시간 갱신이 편집 중인 값을 덮어쓰지 않는다.
let cashDraftDirty = false;

function cashDraftTotal() {
  return BILL_DENOMS.reduce((sum, denom) => sum + (cashDraft[denom] || 0) * denom, 0);
}

function primeCashDraftFromLatest() {
  if (cashDraftDirty) return;
  const latest = latestEntry(cashEntriesToday);
  if (latest) {
    const b = latest.breakdown || {};
    cashDraft = {
      50000: b[50000] || 0,
      10000: b[10000] || 0,
      5000: b[5000] || 0,
      1000: b[1000] || 0,
    };
    return;
  }
  // 오늘 아직 아무도 등록을 안 했으면 — 마감 근무자가 어제 마지막으로 센
  // 시재를 오늘 오픈 근무자가 그대로 이어받아서(이월) 달라진 권종만
  // +/-로 조정하면 되도록, 어제의 마지막 등록값을 시작점으로 삼는다.
  primeCashDraftFromYesterday();
}

async function primeCashDraftFromYesterday() {
  if (cashDraftDirty || cashEntriesToday.length > 0) return;
  try {
    const snap = await getDocs(collection(db, "stores", account.storeId, "cashRegister", dateStrDaysAgo(1), "entries"));
    if (cashDraftDirty || cashEntriesToday.length > 0) return; // 그 사이 상황이 바뀌었으면 건너뜀
    const latest = latestEntry(snap.docs.map((d) => d.data()));
    if (!latest) return;
    const b = latest.breakdown || {};
    cashDraft = {
      50000: b[50000] || 0,
      10000: b[10000] || 0,
      5000: b[5000] || 0,
      1000: b[1000] || 0,
    };
    render();
  } catch (e) {
    // 조용히 포기 — 기본값(0)부터 직접 세는 기존 방식으로 돌아간다.
  }
}

function tsMillisDesc(ts) {
  if (!ts) return Date.now(); // 아직 서버 확인 전인 낙관적 항목 — 맨 위로
  return typeof ts.toDate === "function" ? ts.toDate().getTime() : ts.seconds * 1000;
}

function latestEntry(entries) {
  if (entries.length === 0) return null;
  return [...entries].sort((a, b) => tsMillisDesc(b.createdAt) - tsMillisDesc(a.createdAt))[0];
}

// 이 기능이 등록 기록 로그가 되기 전, cashRegister/{date} 문서 하나에 권종별
// 장수 합계만 저장하던 구버전 데이터를 위한 1회성 이관 — 기존에 이미
// 등록됐던 금액이 로그에서 사라지지 않도록 등록 기록 하나로 옮겨 넣는다.
// 트랜잭션으로 감싸 여러 기기에서 동시에 열어도 중복 이관되지 않게 막는다.
async function migrateLegacyCashDoc(dateStr) {
  const legacyRef = doc(db, "stores", account.storeId, "cashRegister", dateStr);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(legacyRef);
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.migratedToLog || !data.total) return;
      const breakdown = {};
      BILL_DENOMS.forEach((denom) => {
        const count = data[`bill${denom}`] || 0;
        if (count > 0) breakdown[denom] = count;
      });
      const entryRef = doc(collection(db, "stores", account.storeId, "cashRegister", dateStr, "entries"));
      tx.set(entryRef, {
        breakdown,
        total: data.total,
        staffName: data.staffName || "",
        staffPhone: data.staffPhone || "",
        createdAt: data.updatedAt || serverTimestamp(),
        migrated: true,
      });
      tx.update(legacyRef, { migratedToLog: true });
    });
  } catch (e) {
    // 이관 실패해도 새 등록 자체는 계속 동작해야 하니 조용히 넘어간다.
    console.error(e);
  }
}

// 등록된 시재 기록은 사장님 계정에서만, 그것도 로그 한 건 단위로만 지울 수
// 있게 한다 — 직원이 잘못 등록한 걸 발견해도 직접 지우지 못하고 사장님한테
// 알려야 하는 게 의도된 동작(감시용 로그이므로).
async function deleteCashEntry(entryId) {
  if (account.role !== "owner") return;
  if (!confirm("이 시재 등록 기록을 삭제할까요?")) return;
  await deleteDoc(doc(db, "stores", account.storeId, "cashRegister", cashDate, "entries", entryId));
  // 오늘 날짜는 live 리스너가 알아서 다시 그려주지만, 과거 날짜는 한 번
  // 불러온 스냅샷이라 직접 지워줘야 목록에서 바로 사라진다.
  if (cashDate !== date) {
    cashEntries = cashEntries.filter((e) => e.id !== entryId);
    const latest = latestEntry(cashEntries);
    cashChipTotals[cashDate] = latest ? latest.total : 0;
    render();
  }
  toast("삭제했어요");
}

async function registerCashDraft() {
  const total = cashDraftTotal();
  if (total <= 0) {
    toast("등록할 금액이 없어요");
    return;
  }
  if (!confirm(`선택한 장수로 ${total.toLocaleString()}원으로 시재를 등록하시겠습니까?`)) return;
  const breakdown = {};
  BILL_DENOMS.forEach((denom) => { if (cashDraft[denom] > 0) breakdown[denom] = cashDraft[denom]; });
  await addDoc(collection(db, "stores", account.storeId, "cashRegister", date, "entries"), {
    breakdown,
    total,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  // draft를 0으로 비우지 않는다 — 방금 등록한 장수가 다음 등록의 시작점이
  // 된다. dirty만 풀어주면 곧 도착할 live 갱신이 정확히 그 값으로 다시
  // 맞춰준다(primeCashDraftFromLatest).
  cashDraftDirty = false;
  toast(`시재 ${total.toLocaleString()}원 등록했어요`);
  render();
}

// 서랍 안 현금을 실제로 전부 회수했을 때처럼, 지금 세는 중인 장수와
// 무관하게 바로 0원으로 만들고 싶을 때 쓴다 — 등록 로그와 똑같은 방식으로
// "0원짜리 등록"을 하나 남겨서(isReset 표시), 최근 등록 기준 요약도 바로
// 0원이 되고 누가 언제 리셋했는지도 로그에 그대로 남는다.
async function resetCashRegister() {
  if (!confirm("시재를 0원으로 리셋할까요?")) return;
  await addDoc(collection(db, "stores", account.storeId, "cashRegister", date, "entries"), {
    breakdown: {},
    total: 0,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
    isReset: true,
  });
  cashDraft = { 50000: 0, 10000: 0, 5000: 0, 1000: 0 };
  cashDraftDirty = false;
  toast("시재를 0원으로 리셋했어요");
  render();
}

function breakdownLabel(breakdown) {
  return BILL_DENOMS
    .filter((denom) => (breakdown || {})[denom] > 0)
    .map((denom) => `${BILL_LABELS[denom]}원×${breakdown[denom]}`)
    .join(", ");
}

function cashHistoryHtml(entries) {
  if (entries.length === 0) return "";
  // 같은 날 안에서 직전 등록 대비 얼마나 변했는지 보여주기 위해 시간순으로
  // 한 번 훑어 각 항목에 diff를 매긴다 — 그날의 첫 등록은 비교 대상이 없어
  // diff가 null. 삭제되면 다음 렌더에서 자동으로 다시 계산되니 따로 저장할
  // 필요는 없다.
  const chronological = [...entries].sort((a, b) => tsMillisDesc(a.createdAt) - tsMillisDesc(b.createdAt));
  const diffById = new Map();
  chronological.forEach((e, i) => {
    diffById.set(e.id, i > 0 ? (e.total || 0) - (chronological[i - 1].total || 0) : null);
  });

  const rows = [...entries]
    .sort((a, b) => tsMillisDesc(b.createdAt) - tsMillisDesc(a.createdAt))
    .map((e) => {
      const diff = diffById.get(e.id);
      const diffHtml = diff === null || diff === undefined
        ? ""
        : `<span class="cash-log-diff ${diff < 0 ? "down" : diff > 0 ? "up" : ""}">${diff > 0 ? "+" : ""}${diff.toLocaleString()}원</span>`;
      return `
      <div class="cash-log-row">
        ${avatarHtml(e.staffPhone, e.staffName, 22)}
        <div class="cash-log-body">
          <span class="cash-log-who">${escapeHtml(e.staffName || "")}님 ${e.isReset ? "리셋" : "등록"}</span>
          <span class="cash-log-detail">${e.isReset ? "0원으로 리셋함" : escapeHtml(breakdownLabel(e.breakdown))}</span>
        </div>
        <div class="cash-log-right">
          <span class="cash-log-amount plus">${(e.total || 0).toLocaleString()}원</span>
          ${diffHtml}
          <span class="cash-log-time">${formatTimeLabel(e.createdAt)}</span>
        </div>
        ${account.role === "owner" ? `<button class="cash-log-delete-btn" data-cash-log-delete="${e.id}" aria-label="삭제">✕</button>` : ""}
      </div>`;
    })
    .join("");
  return `<div class="cash-log-list">${rows}</div>`;
}

function cashCardHtml(isToday) {
  const latest = latestEntry(cashEntries);
  const summary = latest
    ? `<div class="cash-summary">최근 등록 <strong>${(latest.total || 0).toLocaleString()}원</strong>${latest.staffName ? ` · ${escapeHtml(latest.staffName)}님` : ""}${formatTimeLabel(latest.createdAt) ? ` (${formatTimeLabel(latest.createdAt)})` : ""}</div>`
    : `<div class="cash-summary empty">${isToday ? "아직 오늘 시재를 등록하지 않았어요." : "등록된 시재가 없어요."}</div>`;

  const carriedOver = isToday && !latest && cashDraftTotal() > 0;
  const form = isToday
    ? `
      ${carriedOver ? `<div class="cash-carryover-hint">어제 마감 시재에서 이어왔어요 · 달라진 권종만 조정하세요</div>` : ""}
      <div class="cash-bill-grid">
        ${BILL_DENOMS.map((denom) => `
          <div class="cash-bill-cell">
            <button class="cash-bill-add" data-cash-plus="${denom}">${BILL_LABELS[denom]}</button>
            <div class="cash-bill-count" data-cash-count="${denom}">${cashDraft[denom] || 0}장</div>
            <button class="cash-bill-minus" data-cash-minus="${denom}" aria-label="${BILL_LABELS[denom]} 빼기" ${(cashDraft[denom] || 0) <= 0 ? "disabled" : ""}>−</button>
          </div>`).join("")}
      </div>
      <div class="cash-total-row">합계 <strong id="cashTotalDisplay">${cashDraftTotal().toLocaleString()}원</strong></div>
      <div class="cash-submit-row">
        ${account.role === "owner" ? `<button type="button" class="cash-reset-btn" id="cashResetBtn">Reset</button>` : ""}
        <button class="btn gold" id="cashRegisterBtn">시재 등록</button>
      </div>`
    : "";

  return `
    <div class="category-title section-title-cash">💰 ${isToday ? "오늘의 시재" : `${formatDateLabel(cashDate)} 시재`}</div>
    <div class="card cash-register-card section-cash">
      ${summary}
      ${form}
      ${cashHistoryHtml(cashEntries)}
    </div>`;
}

function wireRegisterDayChips() {
  const chipsEl = rootEl.querySelector("#registerDayChips");
  chipsEl.innerHTML = recentDates
    .map((d) => {
      const { dow, dnum } = dowLabel(d);
      const active = d === cashDate;
      return `
        <button class="day-chip ${active ? "active" : ""}" data-rdate="${d}">
          <div class="dow">${d === date ? "오늘" : dow}</div>
          <div class="dnum">${dnum}</div>
          <div class="day-chip-underline ${dayAccentClass(d)}"></div>
          <div class="dcount">${cashChipTotals[d] ? cashChipTotals[d].toLocaleString() + "원" : ""}</div>
        </button>`;
    })
    .join("");
  chipsEl.querySelectorAll("[data-rdate]").forEach((el) => {
    el.addEventListener("click", () => loadCashDate(el.dataset.rdate));
  });
}

async function loadCashDate(targetDate) {
  cashDate = targetDate;
  if (targetDate === date) {
    cashEntries = cashEntriesToday;
    cashExpenses = cashExpensesToday;
    render();
    return;
  }
  try {
    const snap = await getDocs(collection(db, "stores", account.storeId, "cashRegister", targetDate, "entries"));
    cashEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const latest = latestEntry(cashEntries);
    cashChipTotals[targetDate] = latest ? latest.total : 0;
  } catch (e) {
    cashEntries = [];
  }
  try {
    const expSnap = await getDocs(collection(db, "stores", account.storeId, "cashRegister", targetDate, "expenses"));
    cashExpenses = expSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    cashExpenses = [];
  }
  render();
}

function loadAllCashChipTotals() {
  recentDates.forEach((d) => {
    if (d === date) return;
    getDocs(collection(db, "stores", account.storeId, "cashRegister", d, "entries"))
      .then((snap) => {
        const entries = snap.docs.map((doc) => doc.data());
        const latest = latestEntry(entries);
        cashChipTotals[d] = latest ? latest.total : 0;
        if (rootEl && rootEl.querySelector("#registerDayChips")) wireRegisterDayChips();
      })
      .catch(() => {});
  });
}

// ---- 현금 지출 내역 (돈통에서 쓴 비용) ----

let cashExpensesToday = []; // 항상 live — onSnapshot
let cashExpenses = []; // 지금 보고 있는 날짜의 지출 목록 (오늘이면 cashExpensesToday와 동일)
const expenseChipCounts = {}; // date -> 그 날 지출 건수 (시재 칩과 별개로 쓰지 않고 요약에만 사용)

let expenseDescDraft = "";
let expenseAmountDraft = "";
let expenseReceiptUrls = [];
let expenseAttachTargetId = null; // 이미 등록된 지출 중 뒤늦게 영수증을 붙일 대상 id

function expenseTotalFor(list) {
  return list.reduce((s, e) => s + (e.amount || 0), 0);
}

// 옛 지출 기록은 receiptUrl(단수) 하나였고, 지금은 여러 장을 담는
// receiptUrls(배열)로 바뀌었다 — 어느 쪽으로 저장됐든 한 번에 뽑아 쓴다.
function expenseReceiptUrlsOf(e) {
  if (e.receiptUrls && e.receiptUrls.length > 0) return e.receiptUrls;
  return e.receiptUrl ? [e.receiptUrl] : [];
}

async function onExpenseReceiptsSelected(files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `영수증 ${files.length}장 업로드 중...` : "영수증 업로드 중...");
  try {
    for (const file of files) {
      const blob = await resizeImageFile(file);
      const path = `stores/${account.storeId}/notePhotos/${date}/expense_${account.phone}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      expenseReceiptUrls.push(await getDownloadURL(fileRef));
    }
    render();
    toast("영수증을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("영수증 업로드에 실패했어요");
  }
}

async function submitExpense() {
  const desc = expenseDescDraft.trim();
  const amount = parseInt(expenseAmountDraft, 10);
  if (!desc) {
    toast("무엇에 썼는지 입력해주세요");
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    toast("금액을 입력해주세요");
    return;
  }
  await addDoc(collection(db, "stores", account.storeId, "cashRegister", date, "expenses"), {
    description: desc,
    amount,
    receiptUrls: expenseReceiptUrls,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  expenseDescDraft = "";
  expenseAmountDraft = "";
  expenseReceiptUrls = [];
  toast("지출을 등록했어요");
  render();
}

// 등록할 때 깜빡하고 영수증을 안 붙였어도 나중에 붙일 수 있게 — 등록 자체를
// 막는 대신, 이미 쌓인 기록에도 뒤늦게 사진만 추가하는 길을 열어둔다.
async function onExpenseRowReceiptsSelected(id, files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `영수증 ${files.length}장 업로드 중...` : "영수증 업로드 중...");
  try {
    const existing = cashExpenses.find((e) => e.id === id);
    const urls = existing ? expenseReceiptUrlsOf(existing) : [];
    for (const file of files) {
      const blob = await resizeImageFile(file);
      const path = `stores/${account.storeId}/notePhotos/${cashDate}/expense_${account.phone}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      urls.push(await getDownloadURL(fileRef));
    }
    await updateDoc(doc(db, "stores", account.storeId, "cashRegister", cashDate, "expenses", id), { receiptUrls: urls });
    if (cashDate !== date) {
      // 과거 날짜는 live 리스너가 없어서 직접 반영해야 화면에 바로 보인다.
      const target = cashExpenses.find((e) => e.id === id);
      if (target) target.receiptUrls = urls;
      render();
    }
    toast("영수증을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("영수증 업로드에 실패했어요");
  }
}

// 시재/충전 로그와 마찬가지로 사장님 계정에서만 지울 수 있다.
async function deleteExpense(id) {
  if (account.role !== "owner") return;
  if (!confirm("이 지출 기록을 삭제할까요?")) return;
  await deleteDoc(doc(db, "stores", account.storeId, "cashRegister", cashDate, "expenses", id));
  if (cashDate !== date) {
    cashExpenses = cashExpenses.filter((e) => e.id !== id);
    render();
  }
  toast("삭제했어요");
}

function expenseListHtml(list) {
  if (list.length === 0) return `<div class="empty" style="margin-top:10px;">등록된 지출이 없어요.</div>`;
  const total = expenseTotalFor(list);
  const rows = [...list]
    .sort((a, b) => tsMillisDesc(b.createdAt) - tsMillisDesc(a.createdAt))
    .map((e) => `
      <div class="expense-row">
        ${avatarHtml(e.staffPhone, e.staffName, 22)}
        <div class="expense-body">
          <span class="expense-desc">${escapeHtml(e.description)}</span>
          <span class="expense-meta">${escapeHtml(e.staffName || "")}님 · ${formatTimeLabel(e.createdAt)}</span>
        </div>
        ${expenseReceiptUrlsOf(e).length > 0
          ? expenseReceiptUrlsOf(e).map((url) => `<img src="${url}" class="expense-receipt-thumb" data-expense-photo="${url}" alt="영수증" />`).join("")
          : `<button class="expense-attach-btn" data-expense-attach="${e.id}">📎 첨부</button>`}
        <span class="expense-amount">−${(e.amount || 0).toLocaleString()}원</span>
        ${account.role === "owner" ? `<button class="expense-delete-btn" data-expense-delete="${e.id}" aria-label="삭제">✕</button>` : ""}
      </div>`)
    .join("");
  return `
    <div class="expense-total-row">지출 합계 <strong>${total.toLocaleString()}원</strong></div>
    <div class="expense-list">${rows}</div>`;
}

function expenseCardHtml(isToday) {
  const form = isToday
    ? `
      <div class="expense-form">
        <input type="text" id="expenseDescInput" placeholder="무엇에 썼나요? (예: 우유 2개)" value="${escapeHtml(expenseDescDraft)}" />
        <input type="number" id="expenseAmountInput" placeholder="금액" inputmode="numeric" value="${escapeHtml(expenseAmountDraft)}" />
      </div>
      <div class="photo-attach-row" style="flex-wrap:wrap;">
        <input type="file" accept="image/*" id="expenseReceiptInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
        ${expenseReceiptUrls.map((url, i) => `
          <div class="photo-preview">
            <img src="${url}" alt="영수증" class="expense-receipt-preview-img" data-expense-photo="${url}" />
            <button class="photo-remove-btn" data-expense-receipt-remove="${i}">✕</button>
          </div>`).join("")}
        <button class="photo-add-btn" id="expenseReceiptAddBtn">🧾 영수증 첨부</button>
      </div>
      <button class="btn gold block" id="expenseAddBtn" style="margin-top:8px;">지출 등록</button>`
    : "";

  return `
    <div class="category-title section-title-expense">💸 현금 지출 내역</div>
    <div class="card section-expense">
      <div class="expense-hint">돈통에서 현금으로 급하게 쓴 비용을 남겨주세요 (예: 편의점 우유 구매, 얼음 주문)</div>
      ${form}
      <input type="file" accept="image/*" id="expenseRowReceiptInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
      ${expenseListHtml(cashExpenses)}
    </div>`;
}

// ---- 선결제 충전 등록 ----

// 포스기에 이미 등록돼 있는 선결제 손님 명단 — 이 앱에서 아직 한 번도
// 충전을 등록한 적 없어도 이름 칩이 바로 보이게 미리 심어둔다. 실제 충전이
// 생기면 topupGroups()의 정렬 규칙(최근 충전순)에 따라 왼쪽으로 올라간다.
const KNOWN_CUSTOMERS = ["다온주얼리", "퍼펙트환전소", "태극", "금복당", "이석희", "부성사", "크림", "샤샤", "감동"];

let topups = []; // 전체 기간, live — 날짜 무관하게 이름 칩을 항상 채우는 데 쓴다
let customTopupNames = []; // 직원이 직접 추가한 손님 이름(config/topupCustomers) — live, 전 직원 공유
let topupHiddenNames = []; // 더 이상 칩으로 안 보이게 숨긴 손님 이름(config/topupCustomers.hiddenNames) — live, 전 직원 공유
let topupSelectedName = null; // null이면 손님 목록, 이름이 있으면 그 손님의 전체 충전 내역을 본다
let topupAmountDraft = "";

function groupByCustomer(list) {
  const byName = new Map();
  for (const t of list) {
    const name = (t.customerName || "").trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(t);
  }
  return [...byName.entries()].map(([name, entries]) => ({
    name,
    total: entries.reduce((s, t) => s + (t.amount || 0), 0),
    entries: [...entries].sort((a, b) => tsMillisDesc(b.createdAt) - tsMillisDesc(a.createdAt)),
    lastAt: Math.max(...entries.map((t) => tsMillisDesc(t.createdAt))),
  }));
}

// 이름 목록은 날짜와 무관하게 항상 전체(포스기 명단 + 직접 추가한 손님 +
// 실제 충전 이력) 기준으로 채워진다 — 날짜가 지나도 이름 탭만 누르면 그
// 손님의 충전 내역이 통째로 남아있는 게 이번 개편의 핵심.
function topupChipNames() {
  const groups = groupByCustomer(topups);
  const byName = new Map(groups.map((g) => [g.name, g]));
  KNOWN_CUSTOMERS.forEach((name) => {
    if (!byName.has(name)) byName.set(name, { name, lastAt: -1 });
  });
  customTopupNames.forEach((name) => {
    if (!byName.has(name)) byName.set(name, { name, lastAt: -1 });
  });
  topupHiddenNames.forEach((name) => byName.delete(name));
  return [...byName.values()]
    .sort((a, b) => (b.lastAt ?? -1) - (a.lastAt ?? -1))
    .map((g) => g.name);
}

// 더 이상 충전 안 하는 손님을 칩 목록에서 치운다 — 과거 충전 기록(topups
// 문서)은 그대로 둔다. KNOWN_CUSTOMERS(코드에 박힌 목록)든 직접 추가한
// 이름이든 실제 충전 이력이 있는 이름이든 전부 이 방식 하나로 처리된다.
async function hideTopupCustomer(name) {
  if (!confirm(`${name}님을 손님 목록에서 삭제할까요?\n(지금까지의 충전 기록은 그대로 남아있어요)`)) return;
  await setDoc(doc(db, "stores", account.storeId, "config", "topupCustomers"), { hiddenNames: arrayUnion(name) }, { merge: true });
  if (topupSelectedName === name) topupSelectedName = null;
  toast(`${name}님을 목록에서 삭제했어요`);
}

// 이름을 바꾸면 지금까지 그 이름으로 쌓인 충전 기록도 전부 새 이름으로
// 옮겨서(batch), 한 손님의 누적 충전 내역이 중간에 끊기지 않고 새 이름
// 밑으로 그대로 이어지게 한다. 옛 이름은 hiddenNames에 넣어 따로 칩이
// 남지 않게 한다.
async function renameTopupCustomer(oldName) {
  const newName = (window.prompt("새 이름을 입력하세요", oldName) || "").trim();
  if (!newName || newName === oldName) return;
  const matching = topups.filter((t) => (t.customerName || "").trim() === oldName);
  const batch = writeBatch(db);
  matching.forEach((t) => batch.update(doc(db, "stores", account.storeId, "topups", t.id), { customerName: newName }));
  batch.set(
    doc(db, "stores", account.storeId, "config", "topupCustomers"),
    { names: arrayUnion(newName), hiddenNames: arrayUnion(oldName) },
    { merge: true }
  );
  await batch.commit();
  if (topupSelectedName === oldName) topupSelectedName = newName;
  toast(`${oldName} → ${newName}(으)로 이름을 바꿨어요`);
}

async function openTopupChipMenu(name) {
  const choice = await showActionSheet([
    { label: "✏️ 이름 수정" },
    { label: "🗑️ 삭제", danger: true },
  ]);
  if (choice === 0) renameTopupCustomer(name);
  else if (choice === 1) hideTopupCustomer(name);
}

// 손님 이름 칩을 꾹 누르면(길게 누르기) 위 메뉴가 뜬다 — 누르는 중 손가락이
// 조금이라도 움직이면(스크롤 의도로 보고) 취소되고, 길게 누르기가 실제로
// 발동했으면 그 뒤에 따라오는 click(= 해당 손님 선택)은 막는다.
function wireTopupChipLongPress() {
  rootEl.querySelectorAll("[data-topup-select]").forEach((chip) => {
    const name = chip.dataset.topupSelect;
    let holdTimer = null;
    let firedLongPress = false;
    let startX = 0;
    let startY = 0;
    const cancelHold = () => clearTimeout(holdTimer);

    chip.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX = e.clientX;
      startY = e.clientY;
      firedLongPress = false;
      holdTimer = setTimeout(() => {
        firedLongPress = true;
        if (navigator.vibrate) navigator.vibrate(15);
        openTopupChipMenu(name);
      }, 450);
    });
    chip.addEventListener("pointermove", (e) => {
      if (Math.abs(e.clientX - startX) > 8 || Math.abs(e.clientY - startY) > 8) cancelHold();
    });
    chip.addEventListener("pointerup", cancelHold);
    chip.addEventListener("pointercancel", cancelHold);
    chip.addEventListener(
      "click",
      (e) => {
        if (!firedLongPress) return;
        e.preventDefault();
        e.stopPropagation();
        firedLongPress = false;
      },
      true
    );
  });
}

// 손님 이름은 여러 직원이 함께 쓰는 공용 명단이라 config 문서에 저장해서
// 실시간으로 공유한다 — 코드에 박아둔 KNOWN_CUSTOMERS와 달리 배포 없이도
// 누구나 새 손님을 추가할 수 있다.
async function addNewTopupCustomer() {
  const name = (window.prompt("추가할 손님 이름을 입력하세요") || "").trim();
  if (!name) return;
  // 예전에 삭제(숨김)했던 이름을 그대로 다시 추가하면, hiddenNames에 남아있는
  // 기록 때문에 topupChipNames()가 계속 걸러내버려서 칩이 안 보이는 버그가
  // 있었다 — 추가할 때 hiddenNames에서도 같이 빼서, 다시 추가한 이름은
  // 확실히 보이게 한다.
  await setDoc(doc(db, "stores", account.storeId, "config", "topupCustomers"), { names: arrayUnion(name), hiddenNames: arrayRemove(name) }, { merge: true });
  toast(`${name}님을 추가했어요`);
}

function topupBoardHtml() {
  if (!topupSelectedName) {
    const chipNames = topupChipNames();
    return `
      <div class="category-title section-title-topup">🧾 선결제 충전 등록</div>
      <div class="card section-topup">
        <div class="topup-accrual-hint">💰 충전될 때마다 충전금액을 등록해주세요!</div>
        <div class="topup-name-chips">
          ${chipNames.map((n) => `<button class="topup-name-chip" data-topup-select="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join("")}
          <button type="button" class="topup-name-chip add-new" id="topupAddCustomerBtn">+ 손님 추가</button>
        </div>
      </div>`;
  }

  const group = groupByCustomer(topups.filter((t) => (t.customerName || "").trim() === topupSelectedName))[0]
    || { name: topupSelectedName, total: 0, entries: [] };

  return `
    <div class="category-title section-title-topup">🧾 선결제 충전 등록</div>
    <div class="card section-topup">
      <button type="button" class="topup-back-btn" id="topupBackBtn">‹ 손님 목록</button>
      <div class="topup-group-head">
        <span class="topup-group-name">${escapeHtml(group.name)}</span>
        <span class="topup-group-total">누적 ${group.total.toLocaleString()}원</span>
      </div>
      <div class="topup-form">
        <input type="number" id="topupAmountInput" placeholder="충전 금액" inputmode="numeric" value="${escapeHtml(topupAmountDraft)}" />
        <button class="btn gold" id="topupAddBtn">등록</button>
      </div>
      <div class="topup-accrual-hint">💰 충전될 때마다 충전금액을 등록해주세요!</div>
      ${group.entries.length === 0 ? `<div class="empty">아직 등록된 충전 내역이 없어요.</div>` : `
      <div class="topup-entry-list">
        ${group.entries.map((e) => `
          <div class="topup-entry-row">
            ${avatarHtml(e.staffPhone, e.staffName, 22)}
            <div class="topup-entry-body">
              <span class="topup-entry-amount">+${(e.amount || 0).toLocaleString()}원</span>
              <span class="topup-entry-meta">${escapeHtml(e.staffName || "")}님 등록 · ${formatTimestampLabel(e.createdAt)}</span>
            </div>
            ${account.role === "owner" ? `<button class="topup-entry-delete-btn" data-topup-delete="${e.id}" aria-label="삭제">✕</button>` : ""}
          </div>`).join("")}
      </div>`}
    </div>`;
}

// 시재 로그와 마찬가지로 사장님 계정에서만, 항목 하나씩만 지울 수 있다.
async function deleteTopupEntry(entryId) {
  if (account.role !== "owner") return;
  if (!confirm("이 충전 등록 기록을 삭제할까요?")) return;
  await deleteDoc(doc(db, "stores", account.storeId, "topups", entryId));
  toast("삭제했어요");
}

async function submitTopup() {
  const name = topupSelectedName;
  const amount = parseInt(topupAmountDraft, 10);
  if (!name) return;
  if (!Number.isFinite(amount) || amount <= 0) {
    toast("충전 금액을 입력해주세요");
    return;
  }
  await addDoc(collection(db, "stores", account.storeId, "topups"), {
    customerName: name,
    amount,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  toast(`${name}님 ${amount.toLocaleString()}원 충전을 등록했어요`);
  topupAmountDraft = "";
  render();
}

// ---- 렌더 ----

function render() {
  if (!rootEl) return;
  const isToday = cashDate === date;

  let html = `
    <div class="seg register-tab-seg">
      <button type="button" class="${registerTab === "cash" ? "active" : ""}" data-register-tab="cash">💰 시재등록</button>
      <button type="button" class="${registerTab === "topup" ? "active" : ""}" data-register-tab="topup">🧾 선결제등록</button>
    </div>`;

  if (registerTab === "cash") {
    html += `
      <div class="card">
        <div class="field" style="margin:0">
          <label>최근 7일</label>
          <div class="day-chip-row" id="registerDayChips"></div>
        </div>
      </div>
`;
    html += cashCardHtml(isToday);
    html += expenseCardHtml(isToday);
  } else {
    html += topupBoardHtml();
  }

  rootEl.innerHTML = html;
  rootEl.querySelectorAll("[data-register-tab]").forEach((el) => {
    el.addEventListener("click", () => { registerTab = el.dataset.registerTab; saveRegisterTab(); render(); });
  });
  if (registerTab === "cash") wireRegisterDayChips();

  function refreshCashDraftDisplay(denom) {
    const countEl = rootEl.querySelector(`[data-cash-count="${denom}"]`);
    if (countEl) countEl.textContent = `${cashDraft[denom] || 0}장`;
    const minusEl = rootEl.querySelector(`[data-cash-minus="${denom}"]`);
    if (minusEl) minusEl.disabled = (cashDraft[denom] || 0) <= 0;
    const totalEl = rootEl.querySelector("#cashTotalDisplay");
    if (totalEl) totalEl.textContent = `${cashDraftTotal().toLocaleString()}원`;
  }
  rootEl.querySelectorAll("[data-cash-plus]").forEach((el) => {
    el.addEventListener("click", () => {
      const denom = Number(el.dataset.cashPlus);
      // 그날 첫 등록은 몇 장인지 세어 타이핑, 그 이후엔 이미 아는 장수에서
      // 버튼으로만 +1씩 조정 — 매번 프롬프트를 또 띄우지 않는다.
      if (cashEntriesToday.length === 0) {
        const input = window.prompt(`${BILL_LABELS[denom]}원권 몇 장 추가할까요?`, "");
        if (input === null) return;
        const n = parseInt(input, 10);
        if (!Number.isFinite(n) || n <= 0) return;
        cashDraftDirty = true;
        cashDraft[denom] = (cashDraft[denom] || 0) + n;
      } else {
        cashDraftDirty = true;
        cashDraft[denom] = (cashDraft[denom] || 0) + 1;
      }
      refreshCashDraftDisplay(denom);
    });
  });
  rootEl.querySelectorAll("[data-cash-minus]").forEach((el) => {
    el.addEventListener("click", () => {
      const denom = Number(el.dataset.cashMinus);
      cashDraftDirty = true;
      cashDraft[denom] = Math.max(0, (cashDraft[denom] || 0) - 1);
      refreshCashDraftDisplay(denom);
    });
  });
  const cashRegisterBtn = rootEl.querySelector("#cashRegisterBtn");
  if (cashRegisterBtn) cashRegisterBtn.addEventListener("click", registerCashDraft);
  const cashResetBtn = rootEl.querySelector("#cashResetBtn");
  if (cashResetBtn) cashResetBtn.addEventListener("click", resetCashRegister);
  rootEl.querySelectorAll("[data-cash-log-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteCashEntry(el.dataset.cashLogDelete));
  });

  const expenseDescInput = rootEl.querySelector("#expenseDescInput");
  const expenseAmountInput = rootEl.querySelector("#expenseAmountInput");
  if (expenseDescInput) expenseDescInput.addEventListener("input", (e) => { expenseDescDraft = e.target.value; });
  if (expenseAmountInput) expenseAmountInput.addEventListener("input", (e) => { expenseAmountDraft = e.target.value; });
  const expenseReceiptInput = rootEl.querySelector("#expenseReceiptInput");
  const expenseReceiptAddBtn = rootEl.querySelector("#expenseReceiptAddBtn");
  if (expenseReceiptAddBtn) expenseReceiptAddBtn.addEventListener("click", () => expenseReceiptInput.click());
  if (expenseReceiptInput) {
    expenseReceiptInput.addEventListener("change", (e) => {
      onExpenseReceiptsSelected(Array.from(e.target.files || []));
      e.target.value = "";
    });
  }
  rootEl.querySelectorAll("[data-expense-receipt-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      expenseReceiptUrls.splice(Number(el.dataset.expenseReceiptRemove), 1);
      render();
    });
  });
  const expenseAddBtn = rootEl.querySelector("#expenseAddBtn");
  if (expenseAddBtn) expenseAddBtn.addEventListener("click", submitExpense);
  rootEl.querySelectorAll("[data-expense-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteExpense(el.dataset.expenseDelete));
  });
  rootEl.querySelectorAll("[data-expense-photo]").forEach((el) => {
    el.addEventListener("click", () => openImageLightbox(el.dataset.expensePhoto, "영수증"));
  });
  const expenseRowReceiptInput = rootEl.querySelector("#expenseRowReceiptInput");
  rootEl.querySelectorAll("[data-expense-attach]").forEach((el) => {
    el.addEventListener("click", () => {
      expenseAttachTargetId = el.dataset.expenseAttach;
      if (expenseRowReceiptInput) expenseRowReceiptInput.click();
    });
  });
  if (expenseRowReceiptInput) {
    expenseRowReceiptInput.addEventListener("change", (e) => {
      const files = Array.from(e.target.files || []);
      const id = expenseAttachTargetId;
      expenseAttachTargetId = null;
      e.target.value = "";
      if (id && files.length > 0) onExpenseRowReceiptsSelected(id, files);
    });
  }

  const topupAmountInput = rootEl.querySelector("#topupAmountInput");
  if (topupAmountInput) {
    topupAmountInput.addEventListener("input", (e) => { topupAmountDraft = e.target.value; });
    topupAmountInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) submitTopup(); });
  }
  const topupAddBtn = rootEl.querySelector("#topupAddBtn");
  if (topupAddBtn) topupAddBtn.addEventListener("click", submitTopup);
  const topupAddCustomerBtn = rootEl.querySelector("#topupAddCustomerBtn");
  if (topupAddCustomerBtn) topupAddCustomerBtn.addEventListener("click", addNewTopupCustomer);
  const topupBackBtn = rootEl.querySelector("#topupBackBtn");
  if (topupBackBtn) topupBackBtn.addEventListener("click", () => { topupSelectedName = null; render(); });
  rootEl.querySelectorAll("[data-topup-select]").forEach((el) => {
    el.addEventListener("click", () => {
      topupSelectedName = el.dataset.topupSelect;
      topupAmountDraft = "";
      render();
    });
  });
  wireTopupChipLongPress();
  rootEl.querySelectorAll("[data-topup-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteTopupEntry(el.dataset.topupDelete));
  });
}

function ensureStarted() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, "stores", account.storeId, "cashRegister", date, "entries"), (snap) => {
    cashEntriesToday = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const latestToday = latestEntry(cashEntriesToday);
    cashChipTotals[date] = latestToday ? latestToday.total : 0;
    if (cashDate === date) cashEntries = cashEntriesToday;
    primeCashDraftFromLatest();
    render();
    notifyRegisterBadgeListeners();
    if (cashEntriesToday.length === 0) migrateLegacyCashDoc(date).then(() => { /* onSnapshot picks up the migrated entries automatically */ });
  });
  onSnapshot(collection(db, "stores", account.storeId, "cashRegister", date, "expenses"), (snap) => {
    cashExpensesToday = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (cashDate === date) cashExpenses = cashExpensesToday;
    render();
    notifyRegisterBadgeListeners();
  });
  onSnapshot(query(collection(db, "stores", account.storeId, "topups"), orderBy("createdAt", "desc")), (snap) => {
    topups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
    notifyRegisterBadgeListeners();
  });
  onSnapshot(doc(db, "stores", account.storeId, "config", "topupCustomers"), (snap) => {
    const d = snap.exists() ? snap.data() : {};
    customTopupNames = d.names || [];
    topupHiddenNames = d.hiddenNames || [];
    render();
  });
  loadAllCashChipTotals();
}

export function mountRegisterBoard(el, acc) {
  rootEl = el;
  account = acc;
  ensureStarted();
  watchAccounts(render);
}
