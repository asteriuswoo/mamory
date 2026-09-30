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
import { db, collection, doc, addDoc, deleteDoc, getDocs, onSnapshot, query, orderBy, serverTimestamp, runTransaction, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, dateStrOf, formatDateLabel, formatTimestampLabel, formatTimeLabel, toast, escapeHtml, resizeImageFile, dayAccentClass, openImageLightbox } from "./util.js";
import { avatarHtml, watchAccounts } from "./avatar.js";

const date = todayStr();
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));

function dowLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return { dow: days[new Date(y, m - 1, d).getDay()], dnum: d };
}

let rootEl = null;
let account = { name: "", phone: "", role: "" };
let started = false;

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
  const b = (latest && latest.breakdown) || {};
  cashDraft = {
    50000: b[50000] || 0,
    10000: b[10000] || 0,
    5000: b[5000] || 0,
    1000: b[1000] || 0,
  };
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
  const legacyRef = doc(db, "cashRegister", dateStr);
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
      const entryRef = doc(collection(db, "cashRegister", dateStr, "entries"));
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
  await deleteDoc(doc(db, "cashRegister", cashDate, "entries", entryId));
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
  await addDoc(collection(db, "cashRegister", date, "entries"), {
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
          <span class="cash-log-who">${escapeHtml(e.staffName || "")}님 등록</span>
          <span class="cash-log-detail">${escapeHtml(breakdownLabel(e.breakdown))}</span>
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

  const form = isToday
    ? `
      <div class="cash-bill-grid">
        ${BILL_DENOMS.map((denom) => `
          <div class="cash-bill-cell">
            <button class="cash-bill-add" data-cash-plus="${denom}">${BILL_LABELS[denom]}</button>
            <div class="cash-bill-count" data-cash-count="${denom}">${cashDraft[denom] || 0}장</div>
            <button class="cash-bill-minus" data-cash-minus="${denom}" aria-label="${BILL_LABELS[denom]} 빼기" ${(cashDraft[denom] || 0) <= 0 ? "disabled" : ""}>−</button>
          </div>`).join("")}
      </div>
      <div class="cash-total-row">합계 <strong id="cashTotalDisplay">${cashDraftTotal().toLocaleString()}원</strong></div>
      <button class="btn gold block" id="cashRegisterBtn">시재 등록</button>`
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
    const snap = await getDocs(collection(db, "cashRegister", targetDate, "entries"));
    cashEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const latest = latestEntry(cashEntries);
    cashChipTotals[targetDate] = latest ? latest.total : 0;
  } catch (e) {
    cashEntries = [];
  }
  try {
    const expSnap = await getDocs(collection(db, "cashRegister", targetDate, "expenses"));
    cashExpenses = expSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    cashExpenses = [];
  }
  render();
}

function loadAllCashChipTotals() {
  recentDates.forEach((d) => {
    if (d === date) return;
    getDocs(collection(db, "cashRegister", d, "entries"))
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
let expenseReceiptUrl = "";

function expenseTotalFor(list) {
  return list.reduce((s, e) => s + (e.amount || 0), 0);
}

async function onExpenseReceiptSelected(file) {
  if (!file) return;
  toast("영수증 업로드 중...");
  try {
    const blob = await resizeImageFile(file);
    const path = `notePhotos/${date}/expense_${account.phone}_${Date.now()}.jpg`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
    expenseReceiptUrl = await getDownloadURL(fileRef);
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
  await addDoc(collection(db, "cashRegister", date, "expenses"), {
    description: desc,
    amount,
    receiptUrl: expenseReceiptUrl || "",
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  expenseDescDraft = "";
  expenseAmountDraft = "";
  expenseReceiptUrl = "";
  toast("지출을 등록했어요");
  render();
}

// 시재/충전 로그와 마찬가지로 사장님 계정에서만 지울 수 있다.
async function deleteExpense(id) {
  if (account.role !== "owner") return;
  if (!confirm("이 지출 기록을 삭제할까요?")) return;
  await deleteDoc(doc(db, "cashRegister", cashDate, "expenses", id));
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
        ${e.receiptUrl ? `<img src="${e.receiptUrl}" class="expense-receipt-thumb" data-expense-photo="${e.receiptUrl}" alt="영수증" />` : ""}
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
      <div class="photo-attach-row">
        <input type="file" accept="image/*" id="expenseReceiptInput" style="display:none;" />
        ${expenseReceiptUrl ? `
          <div class="photo-preview">
            <img src="${expenseReceiptUrl}" alt="영수증" class="expense-receipt-preview-img" data-expense-photo="${expenseReceiptUrl}" />
            <button class="photo-remove-btn" id="expenseReceiptRemoveBtn">✕</button>
          </div>` : `<button class="photo-add-btn" id="expenseReceiptAddBtn">🧾 영수증 첨부</button>`}
      </div>
      <button class="btn gold block" id="expenseAddBtn" style="margin-top:8px;">지출 등록</button>`
    : "";

  return `
    <div class="category-title section-title-expense">💸 현금 지출 내역</div>
    <div class="card section-expense">
      <div class="expense-hint">돈통에서 현금으로 급하게 쓴 비용을 남겨주세요 (예: 편의점 우유 구매, 얼음 주문)</div>
      ${form}
      ${expenseListHtml(cashExpenses)}
    </div>`;
}

// ---- 선결제 충전 등록 ----

// 포스기에 이미 등록돼 있는 선결제 손님 명단 — 이 앱에서 아직 한 번도
// 충전을 등록한 적 없어도 이름 칩이 바로 보이게 미리 심어둔다. 실제 충전이
// 생기면 topupGroups()의 정렬 규칙(최근 충전순)에 따라 왼쪽으로 올라간다.
const KNOWN_CUSTOMERS = ["다온주얼리", "퍼펙트환전소", "태극", "금복당", "이석희", "부성사", "크림", "샤샤", "감동"];

let topups = []; // 전체 기간, live — 날짜 무관하게 이름 칩을 항상 채우는 데 쓴다
let topupDate = date; // 지금 보고 있는(내역을 필터링해 보여주는) 날짜
let topupNameDraft = "";
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

// 이름 칩은 날짜 탐색과 무관하게 항상 전체 기간(포스기 명단 + 실제 충전
// 이력) 기준으로 채워진다 — 과거 날짜를 보고 있어도 손님 이름을 바로 골라
// "지금" 충전을 등록할 수 있어야 하기 때문.
function topupChipNames() {
  const groups = groupByCustomer(topups);
  const byName = new Map(groups.map((g) => [g.name, g]));
  KNOWN_CUSTOMERS.forEach((name) => {
    if (!byName.has(name)) byName.set(name, { name, lastAt: -1 });
  });
  return [...byName.values()]
    .sort((a, b) => (b.lastAt ?? -1) - (a.lastAt ?? -1))
    .map((g) => g.name);
}

// 화면에 보이는 충전 내역 카드는 지금 보고 있는 날짜(topupDate)의 것만 —
// 시재와 달리 과거 날짜도 언제든 바로 열어볼 수 있고, 새 충전은 어떤 날짜를
// 보고 있든 상관없이 항상 "지금"으로 등록된다.
function topupGroupsForDate(dateStr) {
  return groupByCustomer(topups.filter((t) => dateStrOf(t.createdAt) === dateStr))
    .sort((a, b) => b.lastAt - a.lastAt);
}

function topupDayChipCounts() {
  const counts = {};
  topups.forEach((t) => {
    const d = dateStrOf(t.createdAt);
    counts[d] = (counts[d] || 0) + 1;
  });
  return counts;
}

function wireTopupDayChips() {
  const chipsEl = rootEl.querySelector("#topupDayChips");
  if (!chipsEl) return;
  const counts = topupDayChipCounts();
  chipsEl.innerHTML = recentDates
    .map((d) => {
      const { dow, dnum } = dowLabel(d);
      const active = d === topupDate;
      return `
        <button class="day-chip ${active ? "active" : ""}" data-tdate="${d}">
          <div class="dow">${d === date ? "오늘" : dow}</div>
          <div class="dnum">${dnum}</div>
          <div class="day-chip-underline ${dayAccentClass(d)}"></div>
          <div class="dcount">${counts[d] ? counts[d] + "건" : ""}</div>
        </button>`;
    })
    .join("");
  chipsEl.querySelectorAll("[data-tdate]").forEach((el) => {
    el.addEventListener("click", () => {
      topupDate = el.dataset.tdate;
      render();
    });
  });
}

function topupBoardHtml() {
  const chipNames = topupChipNames();
  const activeGroups = topupGroupsForDate(topupDate);
  return `
    <div class="category-title section-title-topup">🧾 선결제 충전 등록</div>
    <div class="card section-topup">
      <div class="topup-accrual-hint">💵 현금 결제 시 10% 추가 적립 · 💳 카드 결제 시 5% 추가 적립</div>
      <div class="field" style="margin:0 0 10px;">
        <label>충전 내역 — 날짜별로 보기</label>
        <div class="day-chip-row" id="topupDayChips"></div>
      </div>
      <div class="topup-form">
        <input type="text" id="topupNameInput" placeholder="손님 이름" value="${escapeHtml(topupNameDraft)}" />
        <input type="number" id="topupAmountInput" placeholder="충전 금액" inputmode="numeric" value="${escapeHtml(topupAmountDraft)}" />
        <button class="btn gold" id="topupAddBtn">등록</button>
      </div>
      ${chipNames.length > 0 ? `
        <div class="topup-name-chips">
          ${chipNames.map((n) => `<button class="topup-name-chip" data-topup-name="${escapeHtml(n)}">${escapeHtml(n)}</button>`).join("")}
        </div>` : ""}
      ${activeGroups.length === 0 ? `<div class="empty">${topupDate === date ? "오늘" : formatDateLabel(topupDate)} 등록된 충전 내역이 없어요.</div>` : activeGroups.map((g) => `
        <div class="topup-group">
          <div class="topup-group-head">
            <span class="topup-group-name">${escapeHtml(g.name)}</span>
            <span class="topup-group-total">누적 ${g.total.toLocaleString()}원</span>
          </div>
          <div class="topup-entry-list">
            ${g.entries.map((e) => `
              <div class="topup-entry-row">
                ${avatarHtml(e.staffPhone, e.staffName, 22)}
                <div class="topup-entry-body">
                  <span class="topup-entry-amount">+${(e.amount || 0).toLocaleString()}원</span>
                  <span class="topup-entry-meta">${escapeHtml(e.staffName || "")}님 등록 · ${formatTimestampLabel(e.createdAt)}</span>
                </div>
                ${account.role === "owner" ? `<button class="topup-entry-delete-btn" data-topup-delete="${e.id}" aria-label="삭제">✕</button>` : ""}
              </div>`).join("")}
          </div>
        </div>`).join("")}
    </div>`;
}

// 시재 로그와 마찬가지로 사장님 계정에서만, 항목 하나씩만 지울 수 있다.
async function deleteTopupEntry(entryId) {
  if (account.role !== "owner") return;
  if (!confirm("이 충전 등록 기록을 삭제할까요?")) return;
  await deleteDoc(doc(db, "topups", entryId));
  toast("삭제했어요");
}

async function submitTopup() {
  const name = topupNameDraft.trim();
  const amount = parseInt(topupAmountDraft, 10);
  if (!name) {
    toast("손님 이름을 입력해주세요");
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    toast("충전 금액을 입력해주세요");
    return;
  }
  await addDoc(collection(db, "topups"), {
    customerName: name,
    amount,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  toast(`${name}님 ${amount.toLocaleString()}원 충전을 등록했어요`);
  topupNameDraft = "";
  topupAmountDraft = "";
  render();
}

// ---- 렌더 ----

function render() {
  if (!rootEl) return;
  const isToday = cashDate === date;
  let html = `
    <div class="card">
      <div class="field" style="margin:0">
        <label>최근 7일</label>
        <div class="day-chip-row" id="registerDayChips"></div>
      </div>
    </div>
`;
  html += cashCardHtml(isToday);
  html += expenseCardHtml(isToday);
  html += topupBoardHtml();

  rootEl.innerHTML = html;
  wireRegisterDayChips();
  wireTopupDayChips();

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
  rootEl.querySelectorAll("[data-cash-log-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteCashEntry(el.dataset.cashLogDelete));
  });

  const expenseDescInput = rootEl.querySelector("#expenseDescInput");
  const expenseAmountInput = rootEl.querySelector("#expenseAmountInput");
  if (expenseDescInput) expenseDescInput.addEventListener("input", (e) => { expenseDescDraft = e.target.value; });
  if (expenseAmountInput) expenseAmountInput.addEventListener("input", (e) => { expenseAmountDraft = e.target.value; });
  const expenseReceiptInput = rootEl.querySelector("#expenseReceiptInput");
  const expenseReceiptAddBtn = rootEl.querySelector("#expenseReceiptAddBtn");
  const expenseReceiptRemoveBtn = rootEl.querySelector("#expenseReceiptRemoveBtn");
  if (expenseReceiptAddBtn) expenseReceiptAddBtn.addEventListener("click", () => expenseReceiptInput.click());
  if (expenseReceiptInput) expenseReceiptInput.addEventListener("change", (e) => onExpenseReceiptSelected(e.target.files[0]));
  if (expenseReceiptRemoveBtn) expenseReceiptRemoveBtn.addEventListener("click", () => { expenseReceiptUrl = ""; render(); });
  const expenseAddBtn = rootEl.querySelector("#expenseAddBtn");
  if (expenseAddBtn) expenseAddBtn.addEventListener("click", submitExpense);
  rootEl.querySelectorAll("[data-expense-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteExpense(el.dataset.expenseDelete));
  });
  rootEl.querySelectorAll("[data-expense-photo]").forEach((el) => {
    el.addEventListener("click", () => openImageLightbox(el.dataset.expensePhoto, "영수증"));
  });

  const topupNameInput = rootEl.querySelector("#topupNameInput");
  const topupAmountInput = rootEl.querySelector("#topupAmountInput");
  if (topupNameInput) topupNameInput.addEventListener("input", (e) => { topupNameDraft = e.target.value; });
  if (topupAmountInput) {
    topupAmountInput.addEventListener("input", (e) => { topupAmountDraft = e.target.value; });
    topupAmountInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) submitTopup(); });
  }
  const topupAddBtn = rootEl.querySelector("#topupAddBtn");
  if (topupAddBtn) topupAddBtn.addEventListener("click", submitTopup);
  rootEl.querySelectorAll("[data-topup-name]").forEach((el) => {
    el.addEventListener("click", () => {
      topupNameDraft = el.dataset.topupName;
      render();
      const input = rootEl.querySelector("#topupAmountInput");
      if (input) input.focus();
    });
  });
  rootEl.querySelectorAll("[data-topup-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteTopupEntry(el.dataset.topupDelete));
  });
}

function ensureStarted() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, "cashRegister", date, "entries"), (snap) => {
    cashEntriesToday = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const latestToday = latestEntry(cashEntriesToday);
    cashChipTotals[date] = latestToday ? latestToday.total : 0;
    if (cashDate === date) cashEntries = cashEntriesToday;
    primeCashDraftFromLatest();
    render();
    if (cashEntriesToday.length === 0) migrateLegacyCashDoc(date).then(() => { /* onSnapshot picks up the migrated entries automatically */ });
  });
  onSnapshot(collection(db, "cashRegister", date, "expenses"), (snap) => {
    cashExpensesToday = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (cashDate === date) cashExpenses = cashExpensesToday;
    render();
  });
  onSnapshot(query(collection(db, "topups"), orderBy("createdAt", "desc")), (snap) => {
    topups = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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
