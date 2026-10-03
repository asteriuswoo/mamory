// 출근기록 · 급여대장 — 직원 개인이 자기 시급/근무시간을 기록하고 급여를
// 자동 계산해보는 탭(하우머치류 앱 대체). 철저히 계정 개인 데이터라 본인
// 전화번호 하위 accounts/{phone}/shifts 에만 읽고 쓴다 — 다른 사람 근무는
// 아예 조회하지 않는다. mountPayrollBoard(el, account)로 붙여 쓴다.
//
// 사장님 계정에서는 이 탭이 완전히 다른 화면이 된다 — 본인 근무를 기록하는
// 게 아니라, 직원들이 월급날 제출한 급여 요청(payrollRequests)을 직원별로
// 모아 보여주는 수신함 역할만 한다.
import { db, collection, collectionGroup, doc, addDoc, updateDoc, deleteDoc, getDocs, onSnapshot, query, orderBy, where, serverTimestamp } from "./firebase-init.js";
import { toast, escapeHtml } from "./util.js";
import { avatarHtml } from "./avatar.js";

let rootEl = null;
let account = { name: "", phone: "" };
let started = false;

let hourlyWage = 0;
let payCycleStartDay = 1; // 1~28일 중 "이 날부터 다음달 이 날 전날까지"가 한 주기
let paydayOfMonth = null; // 1~28일 — 실제로 월급을 받는 날짜. null이면 아직 등록 안 함
let insuranceType = "33"; // "33" = 3.3% 사업소득세 공제, "4das" = 4대보험 공제
// 급여 제출할 때 같이 넘어가서 사장님이 바로 입금할 수 있게 — 계좌 설정도
// payCycleStartDay/paydayOfMonth처럼 한 번 등록해두면 계속 재사용된다.
let bankName = "";
let bankAccountNumber = "";
let shifts = []; // 전체 근무 기록 — live
let cycleOffset = 0; // 0 = 오늘이 속한 주기, -1 = 이전 주기, +1 = 다음 주기
let view = "list"; // list | payslip
let shiftCalYear = 0;
let shiftCalMonth = 0; // 0-indexed
let shiftCalSelectedDate = null; // 상세 보기 대상 날짜 — null이면 달력만 표시
let myPayrollRequests = []; // 내가 제출한 급여 요청 — live, 이미 제출한 기간인지 확인용
let submittedDetailOpen = false; // "제출한 내용 보기" 토글
let showForm = false;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 2026년 대한민국 법정공휴일 — 캘린더에 주말과 같이 빨간색으로 표시하는
// 용도라 API 연동 없이 그 해 날짜만 박아둔다. 설/추석/부처님오신날처럼
// 음력 기준인 날짜는 매년 바뀌므로, 새해가 되면 이 목록도 갱신해야 한다.
const KR_HOLIDAYS_2026 = new Set([
  "2026-01-01", // 신정
  "2026-02-16", "2026-02-17", "2026-02-18", // 설날 연휴
  "2026-03-01", "2026-03-02", // 삼일절 + 대체공휴일
  "2026-05-05", // 어린이날
  "2026-05-24", "2026-05-25", // 부처님오신날 + 대체공휴일
  "2026-06-06", // 현충일
  "2026-07-17", // 제헌절 (2026년 한시적으로 공휴일 재지정)
  "2026-08-15", "2026-08-17", // 광복절 + 대체공휴일
  "2026-09-24", "2026-09-25", "2026-09-26", // 추석 연휴
  "2026-10-03", "2026-10-05", // 개천절 + 대체공휴일
  "2026-10-09", // 한글날
  "2026-12-25", // 크리스마스
]);

// 주말(토/일)이거나 공휴일이면 true — 캘린더 날짜를 빨간색으로 표시할지
// 판단하는 기준.
function isRedDate(dateStr, dow) {
  return dow === 0 || dow === 6 || KR_HOLIDAYS_2026.has(dateStr);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function ymd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

// month는 1~12 — new Date(y, month, 0)은 그 달의 마지막 날을 준다.
function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

// startDay을 기준으로 오늘이 속한 급여 주기의 시작/끝 날짜를 구하고,
// cycleOffset만큼 앞뒤로 이동한다. startDay이 1~28로 제한돼 있어 매달
// 말일 걱정 없이 setMonth로 안전하게 이동할 수 있다.
function cycleBounds(offset) {
  const today = new Date();
  let anchor = new Date(today.getFullYear(), today.getMonth(), payCycleStartDay);
  if (anchor > today) anchor = addMonths(anchor, -1);
  anchor = addMonths(anchor, offset);
  const nextAnchor = addMonths(anchor, 1);
  const end = addDays(nextAnchor, -1);
  return { start: anchor, end };
}

function formatCycleLabel(start, end) {
  const yy = String(start.getFullYear()).slice(2);
  return `${yy}.${pad2(start.getMonth() + 1)}.${pad2(start.getDate())} ~ ${pad2(end.getMonth() + 1)}.${pad2(end.getDate())}`;
}

// "매달 O일"이라는 규칙 설명보다, 실제로 다가오는 월급날이 며칠인지 바로
// 보여주는 게 직원마다 등록일이 다 달라서 더 와닿는다.
function nextPaydayLabel() {
  if (paydayOfMonth == null) return "급여 지급일 미등록 — 정산일 옆 버튼에서 등록해주세요";
  const today = new Date();
  if (today.getDate() === paydayOfMonth) return "오늘이 월급날이에요! 🎉";
  let y = today.getFullYear();
  let m = today.getMonth();
  if (today.getDate() > paydayOfMonth) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  const d = new Date(y, m, paydayOfMonth);
  return `다음 월급날 ${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAYS[d.getDay()]})`;
}

function formatShiftDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${WEEKDAYS[dt.getDay()]})`;
}

function shiftMinutes(startTime, endTime, breakMinutes) {
  const [sh, sm] = (startTime || "0:0").split(":").map(Number);
  const [eh, em] = (endTime || "0:0").split(":").map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins < 0) mins += 24 * 60; // 자정 넘어가는 근무
  return Math.max(0, mins - (breakMinutes || 0));
}

function computeShiftPay(s, wage) {
  const mins = shiftMinutes(s.startTime, s.endTime, s.breakMinutes);
  const hours = mins / 60;
  const base = wage * hours;
  const night = base * (s.nightPct || 0) / 100;
  const overtime = base * (s.overtimePct || 0) / 100;
  const holiday = base * (s.holidayPct || 0) / 100;
  const extra = s.extraAllowance || 0;
  return { mins, hours, base, night, overtime, holiday, extra, total: base + night + overtime + holiday + extra };
}

function shiftsInCycle(start, end) {
  const startStr = ymd(start);
  const endStr = ymd(end);
  return shifts.filter((s) => s.date >= startStr && s.date <= endStr).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

// 근무 등록/수정 캘린더에 이미 등록해둔 날짜를 점으로 표시하기 위한 날짜
// 집합 — 기간과 무관하게 전체 근무 기록 기준이라, 어느 달로 넘어가도
// "이 날은 이미 등록했었지"를 바로 알 수 있다.
function registeredShiftDates() {
  return new Set(shifts.map((s) => s.date));
}

// 하우머치 등 대부분의 급여 계산기가 그렇듯, 공제액은 반올림이 아니라
// 10원 미만을 잘라낸다(원단위 절사) — 반올림을 쓰면 같은 근무시간이어도
// 다른 앱과 몇 원 단위로 어긋나 보인다.
function roundDownTo10(n) {
  return Math.floor(n / 10) * 10;
}

// 공제 방식에 따른 항목별 내역 — 3.3%(사업소득세+지방소득세) 또는
// 4대보험(국민연금/건강보험/장기요양보험/고용보험, 근로자 부담분 기준 요율).
// 4대보험 요율은 매년 조금씩 바뀌는데, 이 앱은 세무 신고용이 아니라 대략적인
// 실수령액 참고용이라 최신 공개 요율로 근사치만 계산한다.
function computeDeduction(gross, type) {
  if (type === "4das") {
    const pension = roundDownTo10(gross * 0.045);
    const health = roundDownTo10(gross * 0.03545);
    const longTermCare = roundDownTo10(health * 0.1295);
    const employment = roundDownTo10(gross * 0.009);
    return {
      total: pension + health + longTermCare + employment,
      // Firestore는 배열 안에 배열을 못 담아서(nested array) [label, amount]
      // 튜플이 아니라 {label, amount} 객체로 담는다 — 이 값이 그대로
      // payrollRequests 문서에 저장되기 때문.
      rows: [
        { label: "국민연금 (4.5%)", amount: pension },
        { label: "건강보험 (3.545%)", amount: health },
        { label: "장기요양보험", amount: longTermCare },
        { label: "고용보험 (0.9%)", amount: employment },
      ],
    };
  }
  const incomeTax = roundDownTo10(gross * 0.03);
  const localTax = roundDownTo10(incomeTax * 0.1);
  return {
    total: incomeTax + localTax,
    rows: [
      { label: "사업소득세", amount: incomeTax },
      { label: "지방소득세", amount: localTax },
    ],
  };
}

// ---- 근무 등록 폼 draft ----
let formWage = 0;
let formDates = new Set();
let formStartHour = "";
let formStartMin = "";
let formEndHour = "";
let formEndMin = "";
let formBreak = 0;
let formNightPct = 0;
let formOvertimePct = 0;
let formHolidayPct = 0;
let formExtra = 0;
let formInsuranceType = "33";
let showDatePicker = false;
let calYear = 0;
let calMonth = 0; // 0-indexed

function openForm() {
  formWage = hourlyWage || 0;
  formDates = new Set();
  formStartHour = "";
  formStartMin = "";
  formEndHour = "";
  formEndMin = "";
  formBreak = 0;
  formNightPct = 0;
  formOvertimePct = 0;
  formHolidayPct = 0;
  formExtra = 0;
  formInsuranceType = insuranceType;
  showDatePicker = false;
  const today = new Date();
  calYear = today.getFullYear();
  calMonth = today.getMonth();
  showForm = true;
  render();
}

function formStartTime() {
  return formStartHour !== "" && formStartMin !== "" ? `${pad2(formStartHour)}:${pad2(formStartMin)}` : "";
}

function formEndTime() {
  return formEndHour !== "" && formEndMin !== "" ? `${pad2(formEndHour)}:${pad2(formEndMin)}` : "";
}

async function submitForm() {
  if (formDates.size === 0) {
    toast("근무일을 선택해주세요");
    return;
  }
  const startTime = formStartTime();
  const endTime = formEndTime();
  if (!startTime || !endTime) {
    toast("근무 시간을 입력해주세요");
    return;
  }
  const wage = parseInt(formWage, 10);
  if (!Number.isFinite(wage) || wage <= 0) {
    toast("시급을 입력해주세요");
    return;
  }
  const accountUpdates = {};
  if (wage !== hourlyWage) accountUpdates.hourlyWage = wage;
  if (formInsuranceType !== insuranceType) accountUpdates.insuranceType = formInsuranceType;
  if (Object.keys(accountUpdates).length > 0) {
    await updateDoc(doc(db, "accounts", account.phone), accountUpdates);
    hourlyWage = wage;
    insuranceType = formInsuranceType;
  }
  const breakMinutes = parseInt(formBreak, 10) || 0;
  const extraAllowance = parseInt(formExtra, 10) || 0;
  await Promise.all(
    [...formDates].map((d) =>
      addDoc(collection(db, "accounts", account.phone, "shifts"), {
        date: d,
        startTime,
        endTime,
        breakMinutes,
        nightPct: formNightPct,
        overtimePct: formOvertimePct,
        holidayPct: formHolidayPct,
        extraAllowance,
        createdAt: serverTimestamp(),
      })
    )
  );
  toast(`근무 ${formDates.size}건 등록했어요`);
  showForm = false;
  render();
}

async function deleteShift(id) {
  if (!confirm("이 근무 기록을 삭제할까요?")) return;
  await deleteDoc(doc(db, "accounts", account.phone, "shifts", id));
  toast("삭제했어요");
}

// ---- 근무 기록 수정 (편집 모드에서 항목 탭) ----
let editingShiftId = null;
let editOriginal = null; // 변경 여부를 비교할 원본 스냅샷
let editDates = new Set(); // 항상 최대 1개만 담는다 (등록 폼과 달리 단일 선택)
let editStartHour = "";
let editStartMin = "";
let editEndHour = "";
let editEndMin = "";
let editBreak = 0;
let editShowDatePicker = false;
let editCalYear = 0;
let editCalMonth = 0;

function openEditShift(shift) {
  editingShiftId = shift.id;
  editOriginal = shift;
  editDates = new Set([shift.date]);
  const [sh, sm] = (shift.startTime || "").split(":");
  const [eh, em] = (shift.endTime || "").split(":");
  editStartHour = sh !== undefined && sh !== "" ? String(Number(sh)) : "";
  editStartMin = sm !== undefined && sm !== "" ? String(Number(sm)) : "";
  editEndHour = eh !== undefined && eh !== "" ? String(Number(eh)) : "";
  editEndMin = em !== undefined && em !== "" ? String(Number(em)) : "";
  editBreak = shift.breakMinutes || 0;
  editShowDatePicker = false;
  const [y, m, d] = shift.date.split("-").map(Number);
  editCalYear = y;
  editCalMonth = m - 1;
  render();
}

function closeEditShift() {
  editingShiftId = null;
  editOriginal = null;
  render();
}

async function saveEditShift() {
  if (editDates.size === 0) {
    toast("근무일을 선택해주세요");
    return;
  }
  const newDate = [...editDates][0];
  const startTime = editStartHour !== "" && editStartMin !== "" ? `${pad2(editStartHour)}:${pad2(editStartMin)}` : "";
  const endTime = editEndHour !== "" && editEndMin !== "" ? `${pad2(editEndHour)}:${pad2(editEndMin)}` : "";
  if (!startTime || !endTime) {
    toast("근무 시간을 입력해주세요");
    return;
  }
  const breakMinutes = parseInt(editBreak, 10) || 0;

  const dateChanged = newDate !== editOriginal.date;
  const timeChanged =
    startTime !== editOriginal.startTime ||
    endTime !== editOriginal.endTime ||
    breakMinutes !== (editOriginal.breakMinutes || 0);

  if (!dateChanged && !timeChanged) {
    closeEditShift();
    return;
  }

  if (dateChanged) {
    if (!confirm("날짜를 변경하면 기존 근무 기록은 삭제되고 새 날짜로 저장돼요. 변경하시겠습니까?")) return;
  } else if (timeChanged) {
    if (!confirm("변경한 시간으로 저장할까요?")) return;
  }

  await updateDoc(doc(db, "accounts", account.phone, "shifts", editingShiftId), {
    date: newDate,
    startTime,
    endTime,
    breakMinutes,
  });
  toast("수정했어요");
  closeEditShift();
}

function editShiftHtml() {
  const dateSummary = editDates.size === 0 ? "날짜 선택" : [...editDates].map((d) => formatShiftDateLabel(d)).join(", ");
  return `
    <div class="payroll-form-overlay" id="payrollEditOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">근무 수정</div>
          <button class="payroll-form-close-btn" id="payrollEditCloseBtn" aria-label="닫기">✕</button>
        </div>
        <div class="field">
          <label>근무일</label>
          <button type="button" class="payroll-date-summary-btn" id="payrollEditDateSummaryBtn">
            <span class="payroll-date-summary-text">${dateSummary}</span>
            <span class="payroll-date-summary-chev">${editShowDatePicker ? "︿" : "⌄"}</span>
          </button>
          ${editShowDatePicker ? calendarHtml(editDates, editCalYear, editCalMonth, "editCalPrevMonth", "editCalNextMonth", "data-edit-date", registeredShiftDates()) : ""}
        </div>
        <div class="field">
          <label>근무 시간</label>
          <div class="payroll-time-row">
            ${timeSelectHtml("payrollEditStart", editStartHour, editStartMin)}
            <span>-</span>
            ${timeSelectHtml("payrollEditEnd", editEndHour, editEndMin)}
          </div>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>휴게 시간(분)</label>
          <input type="number" id="payrollEditBreak" inputmode="numeric" value="${editBreak || ""}" placeholder="0" />
        </div>
        <button class="btn gold block" id="payrollEditSaveBtn" style="margin-top:16px;">저장</button>
      </div>
    </div>`;
}

// 월급날 직원이 "제출"을 누르면 그 정산기간의 근무기록+실수령액을 통째로
// 스냅샷으로 남긴다 — 사장님 계정에서만 보이는 별도 수신함(payrollRequests)
// 용도라, 나중에 직원이 근무 기록을 고치거나 지워도 이미 제출한 내역은
// 그대로 남는다.
async function submitPayrollRequest() {
  const { start, end } = cycleBounds(cycleOffset);
  const cycleLabel = formatCycleLabel(start, end);
  const cycleShifts = shiftsInCycle(start, end);
  if (cycleShifts.length === 0) {
    toast("제출할 근무 기록이 없어요");
    return;
  }
  if (!bankName || !bankAccountNumber) {
    toast("입금받을 계좌를 먼저 등록해주세요 (상단 🏦 계좌 등록)");
    return;
  }
  const { gross, deduction, net } = payslipTotals(cycleShifts);
  if (!confirm(`${cycleLabel} 급여(실수령액 ${Math.round(net).toLocaleString()}원)를 사장님께 제출할까요?`)) return;
  await addDoc(collection(db, "payrollRequests"), {
    staffName: account.name,
    staffPhone: account.phone,
    cycleLabel,
    cycleStart: ymd(start),
    cycleEnd: ymd(end),
    hourlyWage,
    insuranceType,
    bankName,
    bankAccountNumber,
    gross: Math.round(gross),
    deductionTotal: deduction.total,
    deductionRows: deduction.rows,
    net: Math.round(net),
    shifts: cycleShifts.map((s) => ({
      date: s.date,
      startTime: s.startTime,
      endTime: s.endTime,
      breakMinutes: s.breakMinutes || 0,
      nightPct: s.nightPct || 0,
      overtimePct: s.overtimePct || 0,
      holidayPct: s.holidayPct || 0,
      extraAllowance: s.extraAllowance || 0,
      pay: Math.round(computeShiftPay(s, hourlyWage).total),
    })),
    createdAt: serverTimestamp(),
  });
  submittedDetailOpen = false;
  toast("사장님께 제출했어요");
  render();
}

async function editPayCycleStartDay() {
  const input = window.prompt("정산 시작일을 입력하세요 (1~28일). 예: 16 → 16일부터 다음달 15일까지가 한 주기", String(payCycleStartDay));
  if (input === null) return;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1 || n > 28) {
    toast("1~28 사이로 입력해주세요");
    return;
  }
  payCycleStartDay = n;
  await updateDoc(doc(db, "accounts", account.phone), { payCycleStartDay: n });
  toast("정산 시작일을 저장했어요");
  render();
}

// 정산 시작일(급여 계산 기간)과 실제로 통장에 월급이 들어오는 날은 서로
// 별개 개념이다 — 어떤 직원은 정산 종료일에 바로 받고, 어떤 직원은 정산
// 기간과 무관한 고정된 날짜(예: 매달 15일)에 받는다. 그래서 "정산 시작일"
// 계산으로 월급날을 추정하지 않고, 본인이 직접 등록한 날짜(1~28일)만
// 월급날 배너/알림의 기준으로 쓴다.
async function editPaydayOfMonth() {
  const input = window.prompt(
    "월급 받는 날을 입력하세요 (1~28일). 예: 15 → 매달 15일에 월급을 받아요",
    paydayOfMonth ? String(paydayOfMonth) : ""
  );
  if (input === null) return;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1 || n > 28) {
    toast("1~28 사이로 입력해주세요");
    return;
  }
  paydayOfMonth = n;
  await updateDoc(doc(db, "accounts", account.phone), { paydayOfMonth: n });
  toast("월급날을 저장했어요");
  render();
}

// 한 번 등록해두면 급여 제출할 때마다 스냅샷으로 같이 실려가서, 사장님이
// 급여 제출함만 보고 바로 입금할 수 있다.
async function editBankInfo() {
  const bank = window.prompt("은행명을 입력하세요 (예: 국민은행)", bankName || "");
  if (bank === null) return;
  const trimmedBank = bank.trim();
  if (!trimmedBank) {
    toast("은행명을 입력해주세요");
    return;
  }
  const acct = window.prompt("계좌번호를 입력하세요", bankAccountNumber || "");
  if (acct === null) return;
  const trimmedAcct = acct.trim();
  if (!trimmedAcct) {
    toast("계좌번호를 입력해주세요");
    return;
  }
  bankName = trimmedBank;
  bankAccountNumber = trimmedAcct;
  await updateDoc(doc(db, "accounts", account.phone), { bankName: trimmedBank, bankAccountNumber: trimmedAcct });
  toast("계좌 정보를 저장했어요");
  render();
}

// ---- 렌더 ----

// 앞/뒤 달의 날짜를 흐리게라도 채워 넣는 이유 — 첫 주가 목/금/토처럼 늦게
// 시작하는 달은 첫 줄이 거의 텅 비어 보여서, 실제로는 줄 간격이 다 똑같은데
// "첫 주와 둘째 주 사이 공백이 유독 크다"는 착시가 생겼다. 실제 달력 앱들처럼
// 빈 칸을 이전/다음 달 숫자로 채우면 이 착시가 사라진다.
function calendarHtml(selectedDates, year, month, prevBtnId, nextBtnId, dateAttr, registeredDates) {
  const firstDow = new Date(year, month, 1).getDay();
  const totalDays = daysInMonth(year, month + 1);
  let prevYear = year, prevMonth = month - 1;
  if (prevMonth < 0) { prevMonth = 11; prevYear -= 1; }
  const prevMonthDays = daysInMonth(prevYear, prevMonth + 1);
  let nextYear = year, nextMonth = month + 1;
  if (nextMonth > 11) { nextMonth = 0; nextYear += 1; }

  const cells = [];
  for (let i = firstDow - 1; i >= 0; i--) {
    cells.push({ d: prevMonthDays - i, muted: true });
  }
  for (let d = 1; d <= totalDays; d++) {
    const dt = new Date(year, month, d);
    cells.push({ d, muted: false, dateStr: ymd(dt), dow: dt.getDay() });
  }
  const trailing = (7 - (cells.length % 7)) % 7;
  for (let d = 1; d <= trailing; d++) {
    cells.push({ d, muted: true });
  }

  const todayDateStr = ymd(new Date());

  return `
    <div class="payroll-calendar">
      <div class="payroll-calendar-header">
        <button type="button" class="icon-btn" id="${prevBtnId}">‹</button>
        <strong>${year}년 ${month + 1}월</strong>
        <button type="button" class="icon-btn" id="${nextBtnId}">›</button>
      </div>
      <div class="payroll-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="payroll-calendar-grid">
        ${cells.map((c) => {
          if (c.muted) return `<span class="payroll-calendar-cell muted">${c.d}</span>`;
          const active = selectedDates.has(c.dateStr);
          const isToday = c.dateStr === todayDateStr;
          const isRegistered = registeredDates && registeredDates.has(c.dateStr);
          const isRed = isRedDate(c.dateStr, c.dow);
          return `<button type="button" class="payroll-calendar-cell ${active ? "active" : ""} ${isToday ? "today" : ""} ${isRed ? "red-date" : ""}" ${dateAttr}="${c.dateStr}">${c.d}${isRegistered ? `<span class="payroll-calendar-dot"></span>` : ""}</button>`;
        }).join("")}
      </div>
    </div>`;
}

function timeSelectHtml(idPrefix, hourVal, minVal) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const mins = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];
  return `
    <div class="payroll-time-select">
      <select id="${idPrefix}Hour" class="payroll-wheel-select">
        <option value="" ${hourVal === "" ? "selected" : ""}>시</option>
        ${hours.map((h) => `<option value="${h}" ${String(hourVal) === String(h) ? "selected" : ""}>${pad2(h)}시</option>`).join("")}
      </select>
      <select id="${idPrefix}Min" class="payroll-wheel-select">
        <option value="" ${minVal === "" ? "selected" : ""}>분</option>
        ${mins.map((m) => `<option value="${m}" ${String(minVal) === String(m) ? "selected" : ""}>${pad2(m)}분</option>`).join("")}
      </select>
    </div>`;
}

function formHtml() {
  const dateSummary = formDates.size === 0 ? "날짜 선택" : `${[...formDates].sort().map((d) => formatShiftDateLabel(d)).join(", ")}`;
  return `
    <div class="payroll-form-overlay" id="payrollFormOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">근무 등록</div>
          <button class="payroll-form-close-btn" id="payrollFormCloseBtn" aria-label="닫기">✕</button>
        </div>
        <div class="field payroll-inline-field">
          <label>시급</label>
          <input type="number" id="payrollFormWage" inputmode="numeric" value="${formWage || ""}" />
        </div>
        <div class="field">
          <label>근무일 (복수 선택 가능)</label>
          <button type="button" class="payroll-date-summary-btn" id="payrollDateSummaryBtn">
            <span class="payroll-date-summary-text">${dateSummary}</span>
            <span class="payroll-date-summary-chev">${showDatePicker ? "︿" : "⌄"}</span>
          </button>
          ${showDatePicker ? calendarHtml(formDates, calYear, calMonth, "calPrevMonth", "calNextMonth", "data-form-date", registeredShiftDates()) : ""}
        </div>
        <div class="field">
          <label>근무 시간</label>
          <div class="payroll-time-row">
            ${timeSelectHtml("payrollFormStart", formStartHour, formStartMin)}
            <span>-</span>
            ${timeSelectHtml("payrollFormEnd", formEndHour, formEndMin)}
          </div>
        </div>
        <div class="field">
          <label>휴게 시간(분)</label>
          <input type="number" id="payrollFormBreak" inputmode="numeric" value="${formBreak || ""}" placeholder="0" />
        </div>
        <div class="payroll-allowance-row">
          <div class="field" style="flex:1; margin-bottom:0;">
            <label>야간 수당</label>
            <select id="payrollFormNight">
              <option value="0" ${formNightPct === 0 ? "selected" : ""}>없음</option>
              <option value="50" ${formNightPct === 50 ? "selected" : ""}>+50%</option>
            </select>
          </div>
          <div class="field" style="flex:1; margin-bottom:0;">
            <label>연장 수당</label>
            <select id="payrollFormOvertime">
              <option value="0" ${formOvertimePct === 0 ? "selected" : ""}>없음</option>
              <option value="50" ${formOvertimePct === 50 ? "selected" : ""}>+50%</option>
            </select>
          </div>
          <div class="field" style="flex:1; margin-bottom:0;">
            <label>휴일 수당</label>
            <select id="payrollFormHoliday">
              <option value="0" ${formHolidayPct === 0 ? "selected" : ""}>없음</option>
              <option value="50" ${formHolidayPct === 50 ? "selected" : ""}>+50%</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>추가 수당 (매일 받는 식대, 유류비 등)</label>
          <input type="number" id="payrollFormExtra" inputmode="numeric" value="${formExtra || ""}" placeholder="0" />
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>공제 방식</label>
          <div class="seg">
            <button type="button" class="${formInsuranceType === "33" ? "active" : ""}" data-insurance-type="33">3.3% (사업소득세)</button>
            <button type="button" class="${formInsuranceType === "4das" ? "active" : ""}" data-insurance-type="4das">4대보험</button>
          </div>
        </div>
        <button class="btn gold block" id="payrollFormSubmitBtn" style="margin-top:16px;">확인</button>
      </div>
    </div>`;
}

// 리스트로는 근무가 많아질수록 한눈에 들어오지 않아서, 다른 탭들(스케줄/
// 출퇴근기록)과 같은 월간 캘린더로 보여준다 — 근무 등록된 날엔 점을 찍고,
// 그 날짜 칸 안에 근무시간을 형광펜처럼 눈에 띄게 표시한다. 날짜를 누르면
// 그날 등록된 근무를 수정/삭제할 수 있는 상세 창이 뜬다.
function ensureShiftCalStarted() {
  if (shiftCalYear) return;
  const today = new Date();
  shiftCalYear = today.getFullYear();
  shiftCalMonth = today.getMonth();
}

function openShiftCalDay(dateStr) {
  const dayShifts = shifts.filter((s) => s.date === dateStr);
  if (dayShifts.length === 0) {
    toast("등록된 근무가 없어요. + 등록으로 추가해보세요");
    return;
  }
  shiftCalSelectedDate = dateStr;
  render();
}

function closeShiftCalDay() {
  shiftCalSelectedDate = null;
  render();
}

function myShiftCalendarHtml() {
  ensureShiftCalStarted();
  const firstDow = new Date(shiftCalYear, shiftCalMonth, 1).getDay();
  const totalDays = daysInMonth(shiftCalYear, shiftCalMonth + 1);
  const byDate = new Map();
  for (const s of shifts) {
    if (!byDate.has(s.date)) byDate.set(s.date, []);
    byDate.get(s.date).push(s);
  }
  const todayDateStr = ymd(new Date());

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  return `
    <div class="payroll-calendar">
      <div class="payroll-calendar-header">
        <button type="button" class="icon-btn" id="shiftCalPrevMonth">‹</button>
        <strong>${shiftCalYear}년 ${shiftCalMonth + 1}월</strong>
        <button type="button" class="icon-btn" id="shiftCalNextMonth">›</button>
      </div>
      <div class="payroll-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="payroll-calendar-grid payroll-schedule-grid">
        ${cells.map((d) => {
          if (d === null) return `<div class="payroll-schedule-cell muted"></div>`;
          const dt = new Date(shiftCalYear, shiftCalMonth, d);
          const dateStr = ymd(dt);
          const isToday = dateStr === todayDateStr;
          const isRed = isRedDate(dateStr, dt.getDay());
          const dayShifts = byDate.get(dateStr) || [];
          return `
            <button type="button" class="payroll-schedule-cell ${isToday ? "today" : ""}" data-shift-cal-day="${dateStr}">
              <div class="payroll-schedule-daynum ${isRed ? "red-date" : ""}">${d}${dayShifts.length > 0 ? `<span class="payroll-shift-cal-dot"></span>` : ""}</div>
              ${dayShifts.length > 0 ? `<div class="payroll-shift-cal-timeband">${dayShifts.map((s) => `<span class="payroll-shift-cal-time">${s.startTime}~${s.endTime}</span>`).join("")}</div>` : ""}
            </button>`;
        }).join("")}
      </div>
    </div>`;
}

function shiftCalDayOverlayHtml() {
  if (!shiftCalSelectedDate) return "";
  const dayShifts = shifts.filter((s) => s.date === shiftCalSelectedDate);
  return `
    <div class="payroll-form-overlay" id="shiftCalDayOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">${formatShiftDateLabel(shiftCalSelectedDate)} 근무</div>
          <button class="payroll-form-close-btn" id="shiftCalDayCloseBtn" aria-label="닫기">✕</button>
        </div>
        ${dayShifts.length === 0 ? `<div class="empty" style="margin-top:12px;">등록된 근무가 없어요.</div>` : `
        <div class="payroll-shift-list" style="margin:14px 0;">
          ${dayShifts.map((s) => {
            const pay = computeShiftPay(s, hourlyWage);
            return `
            <div class="payroll-shift-row">
              <div class="payroll-shift-info">
                <div class="payroll-shift-date">${s.startTime}~${s.endTime}</div>
                <div class="payroll-shift-time">${Math.round(pay.total).toLocaleString()}원</div>
              </div>
              <button class="payroll-shift-edit-btn" data-shift-cal-edit="${s.id}">수정</button>
              <button class="payroll-shift-delete-btn" data-shift-cal-delete="${s.id}">삭제</button>
            </div>`;
          }).join("")}
        </div>`}
      </div>
    </div>`;
}

function payslipTotals(cycleShifts) {
  const totals = cycleShifts.reduce((acc, s) => {
    const p = computeShiftPay(s, hourlyWage);
    acc.hours += p.hours;
    acc.base += p.base;
    acc.night += p.night;
    acc.overtime += p.overtime;
    acc.holiday += p.holiday;
    acc.extra += p.extra;
    return acc;
  }, { hours: 0, base: 0, night: 0, overtime: 0, holiday: 0, extra: 0 });
  const gross = totals.base + totals.night + totals.overtime + totals.holiday + totals.extra;
  const deduction = computeDeduction(gross, insuranceType);
  const net = gross - deduction.total;
  return { totals, gross, deduction, net };
}

function sumIcon(kind) {
  return kind === "plus"
    ? `<span class="sum-icon sum-icon-plus">+</span>`
    : `<span class="sum-icon sum-icon-minus">−</span>`;
}

function formatSubmittedAt(ts) {
  const d = new Date(tsMillisOf(ts));
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${pad2(d.getHours())}:${pad2(d.getMinutes())} 제출`;
}

function payslipHtml(cycleShifts, cycleLabel) {
  const { totals, gross, deduction, net } = payslipTotals(cycleShifts);
  const { start, end } = cycleBounds(cycleOffset);
  const cycleStartStr = ymd(start);
  const cycleEndStr = ymd(end);
  const existing = myPayrollRequests.find((r) => r.cycleStart === cycleStartStr && r.cycleEnd === cycleEndStr);

  function row(label, amount) {
    if (!amount) return "";
    return `<div class="row-between payroll-payslip-line"><span>${label}</span><span>${Math.round(amount).toLocaleString()}원</span></div>`;
  }

  const submitSectionHtml = existing ? `
    <div class="card payroll-submitted-card">
      <div class="payroll-submitted-status">✅ 제출되었습니다</div>
      <div class="payroll-payslip-sub">${formatSubmittedAt(existing.createdAt)}</div>
      <button type="button" class="btn secondary block" id="payrollViewSubmittedBtn" style="margin-top:10px;">${submittedDetailOpen ? "숨기기" : "제출한 내용 보기"}</button>
      ${submittedDetailOpen ? `
        <div class="payroll-admin-detail">
          <div class="row-between payroll-payslip-line"><span>${sumIcon("plus")}지급 합계</span><span>${(existing.gross || 0).toLocaleString()}원</span></div>
          <div class="row-between payroll-payslip-line"><span>${sumIcon("minus")}공제 합계</span><span>${(existing.deductionTotal || 0).toLocaleString()}원</span></div>
          <div class="row-between payroll-payslip-line"><strong>실수령액</strong><strong>${(existing.net || 0).toLocaleString()}원</strong></div>
          <div class="payroll-admin-shift-header">근무 내역</div>
          ${(existing.shifts || []).map((s) => `
            <div class="row-between payroll-admin-shift-line">
              <span>${formatShiftDateLabel(s.date)} ${s.startTime}~${s.endTime}</span>
              <span>${(s.pay || 0).toLocaleString()}원</span>
            </div>`).join("")}
        </div>` : ""}
    </div>` : (() => {
        // 등록해둔 월급날 당일에만 제출할 수 있게 잠근다 — 잠겼을 때도
        // 버튼 자체는 눌러지게 두고(disabled 대신), 눌렀을 때 왜 안 되는지
        // 토스트로 알려준다. 월급날을 아직 등록 안 했으면 예전처럼 언제든
        // 제출 가능하게 둔다.
        const isPaydayToday = paydayOfMonth != null && new Date().getDate() === paydayOfMonth;
        const locked = paydayOfMonth != null && !isPaydayToday;
        if (locked) {
          return `<button type="button" class="btn secondary block payroll-submit-locked" id="payrollSubmitRequestBtn" data-payday-locked="${paydayOfMonth}" style="margin-top:4px;">🔒 사장님께 이번 급여 제출하기</button>`;
        }
        return `<button class="btn secondary block" id="payrollSubmitRequestBtn" style="margin-top:4px;" ${cycleShifts.length === 0 ? "disabled" : ""}>사장님께 이번 급여 제출하기</button>`;
      })();

  return `
    <div class="card payroll-payslip-hero">
      <div class="payroll-payslip-store">MMTH | ${cycleLabel}</div>
      <div class="payroll-payslip-net">${Math.round(net).toLocaleString()}원 <span class="tag submitted">실수령액</span></div>
      <div class="payroll-payslip-payday">${nextPaydayLabel()}</div>
    </div>
    <div class="card">
      <div class="row-between"><strong>${sumIcon("plus")}지급 합계</strong><strong>${Math.round(gross).toLocaleString()}원</strong></div>
      ${row("근무 수당", totals.base)}
      <div class="payroll-payslip-sub">${(hourlyWage || 0).toLocaleString()}원 × ${totals.hours.toFixed(1)}시간(${cycleShifts.length}일)</div>
      ${row("야간 수당", totals.night)}
      ${row("연장 수당", totals.overtime)}
      ${row("휴일 수당", totals.holiday)}
      ${row("추가 수당", totals.extra)}
    </div>
    <div class="card">
      <div class="row-between"><strong>${sumIcon("minus")}공제 합계 (${insuranceType === "4das" ? "4대보험" : "3.3%"})</strong><strong>${deduction.total.toLocaleString()}원</strong></div>
      ${deduction.rows.map((r) => row(r.label, r.amount)).join("")}
    </div>
    ${submitSectionHtml}`;
}

function render() {
  if (!rootEl) return;
  const { start, end } = cycleBounds(cycleOffset);
  const cycleLabel = formatCycleLabel(start, end);
  const cycleShifts = shiftsInCycle(start, end);
  const gross = cycleShifts.reduce((s, it) => s + computeShiftPay(it, hourlyWage).total, 0);
  const net = gross - computeDeduction(gross, insuranceType).total;
  const isPayday = paydayOfMonth != null && new Date().getDate() === paydayOfMonth;

  let html = `
    ${isPayday ? `<div class="payroll-payday-banner">💰 월급날입니다! 사장님께 급여내역을 제출하세요</div>` : ""}
    <div class="card payroll-summary-card">
      <div class="row-between">
        <div class="payroll-store-label">MMTH</div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end;">
          <button class="payroll-settings-btn" id="payrollSettingsBtn">⚙️ 정산일 ${payCycleStartDay}일</button>
          <button class="payroll-settings-btn" id="payrollPaydayBtn">💰 ${paydayOfMonth ? `월급날 ${paydayOfMonth}일` : "월급날 등록"}</button>
          <button class="payroll-settings-btn" id="payrollBankBtn">🏦 ${bankName ? escapeHtml(bankName) : "계좌 등록"}</button>
        </div>
      </div>
      <div class="payroll-total-amount">${Math.round(net).toLocaleString()}원</div>
    </div>
    ${view !== "attendance" && view !== "schedule" ? `
    <div class="payroll-cycle-nav">
      <button class="payroll-cycle-arrow" id="payrollCyclePrev">‹</button>
      <span class="payroll-cycle-label">${cycleLabel}</span>
      <button class="payroll-cycle-arrow" id="payrollCycleNext">›</button>
    </div>` : ""}
    <div class="seg payroll-view-tabs">
      <button type="button" class="${view === "list" ? "active" : ""}" data-payroll-view="list">근무내역</button>
      <button type="button" class="${view === "payslip" ? "active" : ""}" data-payroll-view="payslip">급여명세서</button>
      <button type="button" class="${view === "attendance" ? "active" : ""}" data-payroll-view="attendance">출퇴근기록</button>
      <button type="button" class="${view === "schedule" ? "active" : ""}" data-payroll-view="schedule">스케줄</button>
    </div>`;

  if (view === "list") {
    html += `
      <div class="row-between" style="margin:14px 0 8px;">
        <div style="font-weight:800;">나의 근무</div>
        <button class="btn gold" id="payrollAddBtn" style="padding:6px 12px; font-size:12px;">+ 등록</button>
      </div>
      ${myShiftCalendarHtml()}
      ${shiftCalDayOverlayHtml()}`;
  } else if (view === "payslip") {
    html += payslipHtml(cycleShifts, cycleLabel);
  } else if (view === "schedule") {
    ensureScheduleStarted();
    html += scheduleTabHtml();
  } else {
    html += attendanceTabHtml();
  }

  if (showForm) html += formHtml();
  if (editingShiftId) html += editShiftHtml();

  rootEl.innerHTML = html;
  wireScheduleEvents();

  document.getElementById("payrollSettingsBtn").addEventListener("click", editPayCycleStartDay);
  document.getElementById("payrollPaydayBtn").addEventListener("click", editPaydayOfMonth);
  document.getElementById("payrollBankBtn").addEventListener("click", editBankInfo);
  const cyclePrevBtn = document.getElementById("payrollCyclePrev");
  const cycleNextBtn = document.getElementById("payrollCycleNext");
  if (cyclePrevBtn) cyclePrevBtn.addEventListener("click", () => { cycleOffset -= 1; render(); });
  if (cycleNextBtn) cycleNextBtn.addEventListener("click", () => { cycleOffset += 1; render(); });
  rootEl.querySelectorAll("[data-payroll-view]").forEach((el) => {
    el.addEventListener("click", () => { view = el.dataset.payrollView; render(); });
  });
  const shiftCalPrevBtn = document.getElementById("shiftCalPrevMonth");
  const shiftCalNextBtn = document.getElementById("shiftCalNextMonth");
  if (shiftCalPrevBtn) {
    shiftCalPrevBtn.addEventListener("click", () => {
      shiftCalMonth -= 1;
      if (shiftCalMonth < 0) { shiftCalMonth = 11; shiftCalYear -= 1; }
      render();
    });
  }
  if (shiftCalNextBtn) {
    shiftCalNextBtn.addEventListener("click", () => {
      shiftCalMonth += 1;
      if (shiftCalMonth > 11) { shiftCalMonth = 0; shiftCalYear += 1; }
      render();
    });
  }
  rootEl.querySelectorAll("[data-shift-cal-day]").forEach((el) => {
    el.addEventListener("click", () => openShiftCalDay(el.dataset.shiftCalDay));
  });
  const shiftCalDayOverlay = document.getElementById("shiftCalDayOverlay");
  if (shiftCalDayOverlay) {
    shiftCalDayOverlay.addEventListener("click", (e) => { if (e.target === shiftCalDayOverlay) closeShiftCalDay(); });
    document.getElementById("shiftCalDayCloseBtn").addEventListener("click", closeShiftCalDay);
    shiftCalDayOverlay.querySelectorAll("[data-shift-cal-delete]").forEach((el) => {
      el.addEventListener("click", () => deleteShift(el.dataset.shiftCalDelete));
    });
    shiftCalDayOverlay.querySelectorAll("[data-shift-cal-edit]").forEach((el) => {
      el.addEventListener("click", () => {
        const shift = shifts.find((s) => s.id === el.dataset.shiftCalEdit);
        if (shift) openEditShift(shift);
      });
    });
  }
  const submitRequestBtn = document.getElementById("payrollSubmitRequestBtn");
  if (submitRequestBtn) {
    submitRequestBtn.addEventListener("click", () => {
      const lockedDay = submitRequestBtn.dataset.paydayLocked;
      if (lockedDay) {
        toast(`오늘은 월급날이 아니에요 (매달 ${lockedDay}일에 제출할 수 있어요)`);
        return;
      }
      submitPayrollRequest();
    });
  }
  const viewSubmittedBtn = document.getElementById("payrollViewSubmittedBtn");
  if (viewSubmittedBtn) viewSubmittedBtn.addEventListener("click", () => { submittedDetailOpen = !submittedDetailOpen; render(); });
  const addBtn = document.getElementById("payrollAddBtn");
  if (addBtn) addBtn.addEventListener("click", openForm);
  const attPrevBtn = document.getElementById("attCalPrevMonth");
  const attNextBtn = document.getElementById("attCalNextMonth");
  if (attPrevBtn) {
    attPrevBtn.addEventListener("click", () => {
      attCalMonth -= 1;
      if (attCalMonth < 0) { attCalMonth = 11; attCalYear -= 1; }
      loadAttendanceForMonth();
      render();
    });
  }
  if (attNextBtn) {
    attNextBtn.addEventListener("click", () => {
      attCalMonth += 1;
      if (attCalMonth > 11) { attCalMonth = 0; attCalYear += 1; }
      loadAttendanceForMonth();
      render();
    });
  }

  const overlay = document.getElementById("payrollFormOverlay");
  if (overlay) {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) { showForm = false; render(); } });
    document.getElementById("payrollFormCloseBtn").addEventListener("click", () => { showForm = false; render(); });
    document.getElementById("payrollFormWage").addEventListener("input", (e) => { formWage = e.target.value; });
    const dateSummaryBtn = document.getElementById("payrollDateSummaryBtn");
    if (dateSummaryBtn) dateSummaryBtn.addEventListener("click", () => { showDatePicker = !showDatePicker; render(); });
    const calPrevBtn = document.getElementById("calPrevMonth");
    const calNextBtn = document.getElementById("calNextMonth");
    if (calPrevBtn) {
      calPrevBtn.addEventListener("click", () => {
        calMonth -= 1;
        if (calMonth < 0) { calMonth = 11; calYear -= 1; }
        render();
      });
    }
    if (calNextBtn) {
      calNextBtn.addEventListener("click", () => {
        calMonth += 1;
        if (calMonth > 11) { calMonth = 0; calYear += 1; }
        render();
      });
    }
    rootEl.querySelectorAll("[data-form-date]").forEach((el) => {
      el.addEventListener("click", () => {
        const d = el.dataset.formDate;
        if (formDates.has(d)) formDates.delete(d);
        else formDates.add(d);
        render();
      });
    });
    document.getElementById("payrollFormStartHour").addEventListener("change", (e) => { formStartHour = e.target.value; });
    document.getElementById("payrollFormStartMin").addEventListener("change", (e) => { formStartMin = e.target.value; });
    document.getElementById("payrollFormEndHour").addEventListener("change", (e) => { formEndHour = e.target.value; });
    document.getElementById("payrollFormEndMin").addEventListener("change", (e) => { formEndMin = e.target.value; });
    document.getElementById("payrollFormBreak").addEventListener("input", (e) => { formBreak = e.target.value; });
    document.getElementById("payrollFormNight").addEventListener("change", (e) => { formNightPct = Number(e.target.value); });
    document.getElementById("payrollFormOvertime").addEventListener("change", (e) => { formOvertimePct = Number(e.target.value); });
    document.getElementById("payrollFormHoliday").addEventListener("change", (e) => { formHolidayPct = Number(e.target.value); });
    document.getElementById("payrollFormExtra").addEventListener("input", (e) => { formExtra = e.target.value; });
    rootEl.querySelectorAll("[data-insurance-type]").forEach((el) => {
      el.addEventListener("click", () => { formInsuranceType = el.dataset.insuranceType; render(); });
    });
    document.getElementById("payrollFormSubmitBtn").addEventListener("click", submitForm);
  }

  const editOverlay = document.getElementById("payrollEditOverlay");
  if (editOverlay) {
    editOverlay.addEventListener("click", (e) => { if (e.target === editOverlay) closeEditShift(); });
    document.getElementById("payrollEditCloseBtn").addEventListener("click", closeEditShift);
    const editDateSummaryBtn = document.getElementById("payrollEditDateSummaryBtn");
    if (editDateSummaryBtn) editDateSummaryBtn.addEventListener("click", () => { editShowDatePicker = !editShowDatePicker; render(); });
    const editCalPrevBtn = document.getElementById("editCalPrevMonth");
    const editCalNextBtn = document.getElementById("editCalNextMonth");
    if (editCalPrevBtn) {
      editCalPrevBtn.addEventListener("click", () => {
        editCalMonth -= 1;
        if (editCalMonth < 0) { editCalMonth = 11; editCalYear -= 1; }
        render();
      });
    }
    if (editCalNextBtn) {
      editCalNextBtn.addEventListener("click", () => {
        editCalMonth += 1;
        if (editCalMonth > 11) { editCalMonth = 0; editCalYear += 1; }
        render();
      });
    }
    rootEl.querySelectorAll("[data-edit-date]").forEach((el) => {
      el.addEventListener("click", () => {
        editDates = new Set([el.dataset.editDate]);
        render();
      });
    });
    document.getElementById("payrollEditStartHour").addEventListener("change", (e) => { editStartHour = e.target.value; });
    document.getElementById("payrollEditStartMin").addEventListener("change", (e) => { editStartMin = e.target.value; });
    document.getElementById("payrollEditEndHour").addEventListener("change", (e) => { editEndHour = e.target.value; });
    document.getElementById("payrollEditEndMin").addEventListener("change", (e) => { editEndMin = e.target.value; });
    document.getElementById("payrollEditBreak").addEventListener("input", (e) => { editBreak = e.target.value; });
    document.getElementById("payrollEditSaveBtn").addEventListener("click", saveEditShift);
  }
}

function ensureStarted() {
  if (started) return;
  started = true;
  const today = new Date();
  attCalYear = today.getFullYear();
  attCalMonth = today.getMonth();
  onSnapshot(doc(db, "accounts", account.phone), (snap) => {
    const data = snap.data() || {};
    hourlyWage = data.hourlyWage || 0;
    payCycleStartDay = data.payCycleStartDay || 1;
    paydayOfMonth = data.paydayOfMonth || null;
    insuranceType = data.insuranceType || "33";
    bankName = data.bankName || "";
    bankAccountNumber = data.bankAccountNumber || "";
    render();
  });
  onSnapshot(collection(db, "accounts", account.phone, "shifts"), (snap) => {
    shifts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  onSnapshot(query(collection(db, "payrollRequests"), where("staffPhone", "==", account.phone)), (snap) => {
    myPayrollRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  loadAttendanceForMonth();
}

// ---- 사장님용: 직원 급여 제출 수신함 ----

let adminStarted = false;
let adminRequests = []; // 전체 payrollRequests — live
let adminOpenGroup = null; // 상세를 펼쳐서 보고 있는 직원 전화번호
let adminTodayAttendance = []; // 오늘 전 직원 출퇴근 도장 — live (collectionGroup)

// ---- 사장님용: 전 직원 출퇴근 캘린더 (과거 기록을 누가·언제 찍었는지 한눈에) ----
let adminAttCalYear = 0;
let adminAttCalMonth = 0; // 0-indexed
let adminAttendanceAll = []; // 지금 보고 있는 달의 전 직원 출퇴근 기록 — live
let adminAttUnsub = null;
let adminAttSelectedDate = null; // 상세 보기 대상 날짜 — null이면 달력만 표시

function loadAdminAttendanceForMonth() {
  if (adminAttUnsub) { adminAttUnsub(); adminAttUnsub = null; }
  const monthStart = ymd(new Date(adminAttCalYear, adminAttCalMonth, 1));
  const monthEnd = ymd(new Date(adminAttCalYear, adminAttCalMonth + 1, 0));
  adminAttUnsub = onSnapshot(
    query(collectionGroup(db, "attendance"), where("date", ">=", monthStart), where("date", "<=", monthEnd), orderBy("date")),
    (snap) => {
      adminAttendanceAll = snap.docs.map((d) => ({ id: d.id, staffPhone: d.ref.parent.parent.id, ...d.data() }));
      renderAdmin();
    }
  );
}

function openAdminAttDay(dateStr) {
  adminAttSelectedDate = dateStr;
  renderAdmin();
}

function closeAdminAttDay() {
  adminAttSelectedDate = null;
  renderAdmin();
}

function adminAttendanceCalendarHtml() {
  const firstDow = new Date(adminAttCalYear, adminAttCalMonth, 1).getDay();
  const totalDays = daysInMonth(adminAttCalYear, adminAttCalMonth + 1);
  const byDate = new Map();
  for (const r of adminAttendanceAll) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const todayDateStr = ymd(new Date());

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  return `
    <div class="payroll-calendar">
      <div class="payroll-calendar-header">
        <button type="button" class="icon-btn" id="adminAttCalPrevMonth">‹</button>
        <strong>${adminAttCalYear}년 ${adminAttCalMonth + 1}월</strong>
        <button type="button" class="icon-btn" id="adminAttCalNextMonth">›</button>
      </div>
      <div class="payroll-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="payroll-calendar-grid payroll-schedule-grid">
        ${cells.map((d) => {
          if (d === null) return `<div class="payroll-schedule-cell muted"></div>`;
          const dt = new Date(adminAttCalYear, adminAttCalMonth, d);
          const dateStr = ymd(dt);
          const isToday = dateStr === todayDateStr;
          const isRed = isRedDate(dateStr, dt.getDay());
          const names = [...new Set((byDate.get(dateStr) || []).map((r) => r.staffPhone))]
            .map((phone) => (byDate.get(dateStr) || []).find((r) => r.staffPhone === phone))
            .sort((a, b) => (a.staffName || "").localeCompare(b.staffName || "", "ko"));
          return `
            <button type="button" class="payroll-schedule-cell ${isToday ? "today" : ""}" data-admin-att-day="${dateStr}">
              <div class="payroll-schedule-daynum ${isRed ? "red-date" : ""}">${d}</div>
              <div class="payroll-schedule-chips">
                ${names.map((r) => {
                  const c = staffChipColor(r.staffPhone);
                  return `<span class="schedule-chip" style="background:${c.bg}; color:${c.fg};">${escapeHtml(r.staffName || "")}</span>`;
                }).join("")}
              </div>
            </button>`;
        }).join("")}
      </div>
    </div>`;
}

function adminAttDayOverlayHtml() {
  if (!adminAttSelectedDate) return "";
  const records = adminAttendanceAll
    .filter((r) => r.date === adminAttSelectedDate)
    .sort((a, b) => (a.staffName || "").localeCompare(b.staffName || "", "ko") || a.time.localeCompare(b.time));
  return `
    <div class="payroll-form-overlay" id="adminAttDayOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">${formatShiftDateLabel(adminAttSelectedDate)} 출퇴근</div>
          <button class="payroll-form-close-btn" id="adminAttDayCloseBtn" aria-label="닫기">✕</button>
        </div>
        ${records.length === 0 ? `<div class="empty" style="margin-top:12px;">찍힌 출퇴근 도장이 없어요.</div>` : `
        <div class="payroll-shift-list" style="margin:14px 0;">
          ${records.map((r) => `
            <div class="payroll-shift-row">
              ${avatarHtml(r.staffPhone, r.staffName, 32)}
              <div class="row-between" style="flex:1; min-width:0;">
                <span class="payroll-shift-date">${escapeHtml(r.staffName || "")}</span>
                <span class="payroll-shift-time" style="margin-top:0;">${stampLabel(r)}</span>
              </div>
            </div>`).join("")}
        </div>`}
      </div>
    </div>`;
}

function ensureAdminAttStarted() {
  if (adminAttCalYear) return;
  const today = new Date();
  adminAttCalYear = today.getFullYear();
  adminAttCalMonth = today.getMonth();
  loadAdminAttendanceForMonth();
}

function wireAdminAttEvents() {
  const prevBtn = document.getElementById("adminAttCalPrevMonth");
  const nextBtn = document.getElementById("adminAttCalNextMonth");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      adminAttCalMonth -= 1;
      if (adminAttCalMonth < 0) { adminAttCalMonth = 11; adminAttCalYear -= 1; }
      loadAdminAttendanceForMonth();
      renderAdmin();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      adminAttCalMonth += 1;
      if (adminAttCalMonth > 11) { adminAttCalMonth = 0; adminAttCalYear += 1; }
      loadAdminAttendanceForMonth();
      renderAdmin();
    });
  }
  document.querySelectorAll("[data-admin-att-day]").forEach((el) => {
    el.addEventListener("click", () => openAdminAttDay(el.dataset.adminAttDay));
  });
  const dayOverlay = document.getElementById("adminAttDayOverlay");
  if (dayOverlay) {
    dayOverlay.addEventListener("click", (e) => { if (e.target === dayOverlay) closeAdminAttDay(); });
    document.getElementById("adminAttDayCloseBtn").addEventListener("click", closeAdminAttDay);
  }
}

function tsMillisOf(ts) {
  if (!ts) return Date.now();
  return typeof ts.toDate === "function" ? ts.toDate().getTime() : ts.seconds * 1000;
}

function groupRequestsByStaff(list) {
  const byPhone = new Map();
  for (const r of list) {
    if (!byPhone.has(r.staffPhone)) byPhone.set(r.staffPhone, []);
    byPhone.get(r.staffPhone).push(r);
  }
  return [...byPhone.entries()]
    .map(([phone, reqs]) => {
      const sorted = [...reqs].sort((a, b) => tsMillisOf(b.createdAt) - tsMillisOf(a.createdAt));
      return { phone, name: sorted[0].staffName, requests: sorted, lastAt: tsMillisOf(sorted[0].createdAt) };
    })
    .sort((a, b) => b.lastAt - a.lastAt);
}

async function deletePayrollRequest(id) {
  if (!confirm("이 급여 제출 기록을 삭제할까요? (처리 완료했을 때 지우면 돼요)")) return;
  await deleteDoc(doc(db, "payrollRequests", id));
  toast("삭제했어요");
}

// 체크(✔) 표시는 검정, 출근/퇴근 글자만 초록/빨강으로 색을 입힌다.
function stampLabel(r) {
  const cls = r.type === "in" ? "stamp-check-in" : "stamp-check-out";
  const label = r.type === "in" ? "출근" : "퇴근";
  return `<span class="stamp-check">✔</span> <span class="${cls}">${label}</span> ${r.time}`;
}

function todayAttendanceHtml() {
  if (adminTodayAttendance.length === 0) {
    return `<div class="empty">오늘 찍힌 출퇴근 도장이 없어요.</div>`;
  }
  const sorted = [...adminTodayAttendance].sort((a, b) => tsMillisOf(b.createdAt) - tsMillisOf(a.createdAt));
  return sorted.map((r) => `
    <div class="payroll-shift-row">
      ${avatarHtml(r.staffPhone, r.staffName, 32)}
      <div class="row-between" style="flex:1; min-width:0;">
        <span class="payroll-shift-date">${escapeHtml(r.staffName || "")}</span>
        <span class="payroll-shift-time" style="margin-top:0;">${stampLabel(r)}</span>
      </div>
    </div>`).join("");
}

function renderAdmin() {
  if (!rootEl) return;
  const groups = groupRequestsByStaff(adminRequests);
  const todayLabel = formatShiftDateLabel(ymd(new Date()));
  ensureScheduleStarted();
  ensureAdminAttStarted();
  let html = `
    <div class="category-title row-between"><span>🕐 오늘의 출퇴근</span><span style="font-size:12px; font-weight:600; color:var(--muted);">${todayLabel}</span></div>
    <div class="card">${todayAttendanceHtml()}</div>
    <div class="category-title">🗓️ 출퇴근 기록 캘린더</div>
    ${adminAttendanceCalendarHtml()}
    ${adminAttDayOverlayHtml()}
    <div class="category-title">📅 근무 스케줄</div>
    ${scheduleTabHtml()}
    <div class="category-title">💰 월급날 급여 제출함</div>
    <div class="card"><div style="font-size:13px; color:var(--muted);">직원들이 월급날 제출한 근무내역·실수령액이 여기 직원별로 모여요.</div></div>`;

  if (groups.length === 0) {
    html += `<div class="card"><div class="empty">아직 제출된 급여 요청이 없어요.</div></div>`;
  } else {
    for (const g of groups) {
      const open = adminOpenGroup === g.phone;
      html += `
        <div class="card">
          <button type="button" class="row-between payroll-admin-group-head" data-admin-group-toggle="${g.phone}">
            <span style="display:flex; align-items:center; gap:8px;">
              ${avatarHtml(g.phone, g.name, 28)}
              <div>
                <strong>${escapeHtml(g.name)}</strong>
                ${g.requests[0].bankName && g.requests[0].bankAccountNumber ? `<div style="font-size:11px; color:var(--muted);">🏦 ${escapeHtml(g.requests[0].bankName)} ${escapeHtml(g.requests[0].bankAccountNumber)}</div>` : ""}
              </div>
            </span>
            <span style="font-size:12px; color:var(--muted);">제출 ${g.requests.length}건 ${open ? "︿" : "⌄"}</span>
          </button>
          ${open ? g.requests.map((r) => `
            <div class="payroll-admin-request">
              <div class="row-between">
                <div>
                  <div style="font-weight:700;">${escapeHtml(r.cycleLabel)}</div>
                  <div style="font-size:11px; color:var(--muted); margin-top:2px;">${r.shifts ? r.shifts.length : 0}일 근무 · ${r.insuranceType === "4das" ? "4대보험" : "3.3%"} 공제</div>
                </div>
                <div style="font-weight:800; color:var(--gold);">${(r.net || 0).toLocaleString()}원</div>
              </div>
              <div class="payroll-admin-detail">
                ${r.bankName && r.bankAccountNumber ? `<div class="row-between payroll-payslip-line"><span>🏦 입금 계좌</span><span>${escapeHtml(r.bankName)} ${escapeHtml(r.bankAccountNumber)}</span></div>` : ""}
                <div class="row-between payroll-payslip-line"><span>${sumIcon("plus")}지급 합계</span><span>${(r.gross || 0).toLocaleString()}원</span></div>
                <div class="row-between payroll-payslip-line"><span>${sumIcon("minus")}공제 합계</span><span>${(r.deductionTotal || 0).toLocaleString()}원</span></div>
                <div class="payroll-admin-shift-header">근무 내역</div>
                ${(r.shifts || []).map((s) => `
                  <div class="row-between payroll-admin-shift-line">
                    <span>${formatShiftDateLabel(s.date)} ${s.startTime}~${s.endTime}${s.breakMinutes ? ` (휴게 ${s.breakMinutes}분)` : ""}${s.extraAllowance ? ` · 추가수당 ${s.extraAllowance.toLocaleString()}원` : ""}</span>
                    <span>${(s.pay || 0).toLocaleString()}원</span>
                  </div>`).join("")}
                <div style="display:flex; gap:8px; margin-top:8px;">
                  <button type="button" class="btn secondary" style="padding:6px 12px; font-size:12px;" data-admin-request-image="${r.id}">🖼️ 이미지로 저장</button>
                  <button type="button" class="payroll-shift-delete-btn" data-admin-request-delete="${r.id}">삭제</button>
                </div>
              </div>
            </div>`).join("") : ""}
        </div>`;
    }
  }

  rootEl.innerHTML = html;
  rootEl.querySelectorAll("[data-admin-group-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      const phone = el.dataset.adminGroupToggle;
      adminOpenGroup = adminOpenGroup === phone ? null : phone;
      renderAdmin();
    });
  });
  rootEl.querySelectorAll("[data-admin-request-delete]").forEach((el) => {
    el.addEventListener("click", () => deletePayrollRequest(el.dataset.adminRequestDelete));
  });
  rootEl.querySelectorAll("[data-admin-request-image]").forEach((el) => {
    el.addEventListener("click", () => {
      const req = adminRequests.find((r) => r.id === el.dataset.adminRequestImage);
      if (req) downloadPayrollImage(req);
    });
  });
  wireAdminAttEvents();
  wireScheduleEvents();
}

// 세무소 제출용 — 제출된 급여 내역 하나를 이미지(PNG) 한 장으로 그려서
// 다운로드한다. 화면을 그대로 캡처하는 대신 캔버스에 직접 그리는 이유는
// 라이브러리(html2canvas 등) 추가 없이 이 값들만으로 깔끔한 레이아웃을
// 만들 수 있어서다.
function downloadPayrollImage(req) {
  const width = 640;
  const padding = 32;
  const lineHeight = 24;
  const deductionRows = req.deductionRows || [];
  const shifts = req.shifts || [];
  const height = 250 + deductionRows.length * lineHeight + shifts.length * lineHeight + 40;

  const scale = 2; // 레티나 화면에서도 선명하게
  const canvas = document.createElement("canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  let y = padding;
  ctx.fillStyle = "#1f1f1f";
  ctx.font = "800 20px sans-serif";
  ctx.fillText("MMTH 급여내역", padding, y);
  y += 14;
  ctx.strokeStyle = "#e5ded2";
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 32;

  ctx.font = "700 15px sans-serif";
  ctx.fillStyle = "#1f1f1f";
  ctx.fillText(`${req.staffName || ""}님 · ${req.cycleLabel || ""}`, padding, y);
  y += 34;

  ctx.font = "800 26px sans-serif";
  ctx.fillStyle = "#d9774a";
  ctx.fillText(`실수령액 ${(req.net || 0).toLocaleString()}원`, padding, y);
  y += 38;

  ctx.font = "700 14px sans-serif";
  ctx.fillStyle = "#1f1f1f";
  ctx.fillText(`지급 합계   ${(req.gross || 0).toLocaleString()}원`, padding, y);
  y += lineHeight;
  ctx.fillText(`공제 합계 (${req.insuranceType === "4das" ? "4대보험" : "3.3%"})   ${(req.deductionTotal || 0).toLocaleString()}원`, padding, y);
  y += lineHeight + 4;

  ctx.font = "13px sans-serif";
  ctx.fillStyle = "#6b6b66";
  deductionRows.forEach((row) => {
    ctx.fillText(`· ${row.label}   ${(row.amount || 0).toLocaleString()}원`, padding + 8, y);
    y += lineHeight;
  });

  y += 14;
  ctx.strokeStyle = "#e5ded2";
  ctx.beginPath();
  ctx.moveTo(padding, y);
  ctx.lineTo(width - padding, y);
  ctx.stroke();
  y += 28;

  ctx.font = "700 14px sans-serif";
  ctx.fillStyle = "#1f1f1f";
  ctx.fillText("근무 내역", padding, y);
  y += lineHeight;

  ctx.font = "13px sans-serif";
  shifts.forEach((s) => {
    ctx.textAlign = "left";
    ctx.fillStyle = "#1f1f1f";
    ctx.fillText(`${formatShiftDateLabel(s.date)} ${s.startTime}~${s.endTime}`, padding, y);
    ctx.textAlign = "right";
    ctx.fillText(`${(s.pay || 0).toLocaleString()}원`, width - padding, y);
    y += lineHeight;
  });

  ctx.textAlign = "left";
  y += 16;
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "#9a9690";
  ctx.fillText(`제출: ${formatSubmittedAt(req.createdAt)}`, padding, y);

  const link = document.createElement("a");
  link.download = `${req.staffName || "직원"}_급여_${req.cycleStart || ""}.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function ensureAdminStarted() {
  if (adminStarted) return;
  adminStarted = true;
  onSnapshot(query(collection(db, "payrollRequests"), orderBy("createdAt", "desc")), (snap) => {
    adminRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAdmin();
  });
  // collectionGroup — 모든 직원의 accounts/{phone}/attendance 서브컬렉션을
  // 한 번에 훑어서 오늘 날짜인 도장만 모아온다.
  const todayStr = ymd(new Date());
  onSnapshot(query(collectionGroup(db, "attendance"), where("date", "==", todayStr)), (snap) => {
    adminTodayAttendance = snap.docs.map((d) => ({ id: d.id, staffPhone: d.ref.parent.parent.id, ...d.data() }));
    renderAdmin();
  });
}

export function mountPayrollBoard(el, acc) {
  rootEl = el;
  account = acc;
  if (acc.role === "owner") {
    ensureAdminStarted();
    renderAdmin();
  } else {
    ensureStarted();
    render();
  }
}

// ---- 출퇴근 도장 (홈 화면 상단, 프로필 카드 안에 항상 떠 있는 위젯) ----
// 급여대장(근무시간·시급 계산)은 어디까지나 직원이 직접 입력해서 관리하는
// 것으로 두고, 이 도장은 그것과 완전히 분리된 별도의 출퇴근 기록용이다 —
// 도장 하나 깜빡 안 찍었다고 근무시간 계산 자체가 통째로 날아가는 일이
// 없도록. 찍을 때마다 accounts/{phone}/attendance에 기록 하나가 남고
// (달력에 표시), 사장님에게 알림이 간다.
let clockRootEl = null;
let clockAccount = { name: "", phone: "" };
let clockStarted = false;
let lastClockType = null; // "in" | "out" | null — 버튼을 출근/퇴근 중 뭘 보여줄지만 결정
let clockSubmitting = false; // 저장 중 연타로 도장이 중복 찍히는 걸 막는 잠금

function timeNowStr() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

async function recordAttendanceStamp(type) {
  // 저장 중엔 버튼이 바로 안 바뀌어서(서버 응답 대기), 반응이 없다고 여러 번
  // 연타하면 도장이 그만큼 중복으로 찍혔다 — 저장이 끝날 때까지 잠가서 막는다.
  if (clockSubmitting) return;
  clockSubmitting = true;
  renderClockWidget();
  try {
    const stampDate = ymd(new Date());
    const time = timeNowStr();
    await addDoc(collection(db, "accounts", clockAccount.phone, "attendance"), {
      type,
      date: stampDate,
      time,
      staffName: clockAccount.name,
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "accounts", clockAccount.phone), { lastClockType: type });
    toast(`${time} ${type === "in" ? "출근" : "퇴근"} 도장 찍었어요`);
  } finally {
    clockSubmitting = false;
    renderClockWidget();
  }
}

function renderClockWidget() {
  if (!clockRootEl) return;
  const disabledAttr = clockSubmitting ? "disabled" : "";
  clockRootEl.innerHTML = lastClockType === "in"
    ? `
      <div class="clock-widget">
        <div class="clock-widget-status">🟢 출근 중</div>
        <button class="btn urgent block" id="clockOutBtn" ${disabledAttr}>${clockSubmitting ? "저장 중..." : "🔴 퇴근 도장 찍기"}</button>
      </div>`
    : `
      <div class="clock-widget">
        <button class="btn normal block" id="clockInBtn" ${disabledAttr}>${clockSubmitting ? "저장 중..." : "🕐 출근 도장 찍기"}</button>
      </div>`;
  const inBtn = clockRootEl.querySelector("#clockInBtn");
  const outBtn = clockRootEl.querySelector("#clockOutBtn");
  if (inBtn) inBtn.addEventListener("click", () => recordAttendanceStamp("in"));
  if (outBtn) outBtn.addEventListener("click", () => recordAttendanceStamp("out"));
}

function ensureClockStarted() {
  if (clockStarted) return;
  clockStarted = true;
  onSnapshot(doc(db, "accounts", clockAccount.phone), (snap) => {
    const data = snap.data() || {};
    lastClockType = data.lastClockType || null;
    renderClockWidget();
  });
}

export function mountClockWidget(el, acc) {
  clockRootEl = el;
  clockAccount = acc;
  ensureClockStarted();
  renderClockWidget();
}

// ---- 출퇴근 기록 캘린더 (급여대장 탭의 세 번째 서브탭) ----

let attCalYear = 0;
let attCalMonth = 0; // 0-indexed
let attendanceRecords = []; // 지금 보고 있는 달의 출퇴근 기록 — live
let attUnsub = null;

function loadAttendanceForMonth() {
  if (attUnsub) { attUnsub(); attUnsub = null; }
  const monthStart = ymd(new Date(attCalYear, attCalMonth, 1));
  const monthEnd = ymd(new Date(attCalYear, attCalMonth + 1, 0));
  attUnsub = onSnapshot(
    query(
      collection(db, "accounts", account.phone, "attendance"),
      where("date", ">=", monthStart),
      where("date", "<=", monthEnd),
      orderBy("date")
    ),
    (snap) => {
      attendanceRecords = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
    }
  );
}

// 캘린더 따로, 출퇴근 목록 따로 두지 않고 실제 달력 앱처럼 해당 요일 칸
// 안에 그날의 출퇴근 도장을 작은 칩으로 바로 붙여 보여준다.
function attendanceCalendarHtml() {
  const firstDow = new Date(attCalYear, attCalMonth, 1).getDay();
  const totalDays = daysInMonth(attCalYear, attCalMonth + 1);
  const byDate = new Map();
  for (const r of attendanceRecords) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }
  const todayDateStr = ymd(new Date());

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  return `
    <div class="payroll-calendar">
      <div class="payroll-calendar-header">
        <button type="button" class="icon-btn" id="attCalPrevMonth">‹</button>
        <strong>${attCalYear}년 ${attCalMonth + 1}월</strong>
        <button type="button" class="icon-btn" id="attCalNextMonth">›</button>
      </div>
      <div class="payroll-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="payroll-calendar-grid payroll-attendance-grid">
        ${cells.map((d) => {
          if (d === null) return `<div class="payroll-attendance-cell muted"></div>`;
          const dt = new Date(attCalYear, attCalMonth, d);
          const dateStr = ymd(dt);
          const isToday = dateStr === todayDateStr;
          const isRed = isRedDate(dateStr, dt.getDay());
          const records = (byDate.get(dateStr) || []).sort((a, b) => a.time.localeCompare(b.time));
          return `
            <div class="payroll-attendance-cell ${isToday ? "today" : ""}">
              <div class="payroll-attendance-daynum ${isRed ? "red-date" : ""}">${d}</div>
              <div class="payroll-attendance-stamps">
                ${records.map((r) => `<span class="payroll-attendance-chip ${r.type === "in" ? "chip-in" : "chip-out"}">${r.time}</span>`).join("")}
              </div>
            </div>`;
        }).join("")}
      </div>
    </div>`;
}

function attendanceTabHtml() {
  return attendanceCalendarHtml();
}

// ---- 근무 스케줄표 (급여관리 탭의 네 번째 서브탭 — 직원/사장 공용) ----
// 개인 근무기록(shifts)과 달리 이건 팀 전체가 함께 보는 공유 일정이라
// accounts 하위가 아니라 최상위 schedules 컬렉션에 저장한다. 한 달 전체를
// 한 번에 봐야 해서(day별 서브컬렉션이면 리스너가 최대 31개 필요) 문서마다
// date 필드를 두고 범위 쿼리 한 번으로 불러온다 — 급여대장 shifts와 같은 방식.
const SHIFT_TYPES = ["오픈", "오픈미들", "미들마감", "마감", "풀타임"];
const SHIFT_TYPE_CLASS = {
  "오픈": "shift-open",
  "오픈미들": "shift-openmid",
  "미들마감": "shift-midclose",
  "마감": "shift-close",
  "풀타임": "shift-full",
};

// 캘린더 칸의 이름 칩은 근무 유형이 아니라 "누구인지"가 한눈에 보여야
// 해서, 전화번호 기준으로 항상 같은 사람은 항상 같은 색이 나오게 고른다
// (요일이 바뀌어도 흔들리지 않는 고정 색).
const STAFF_CHIP_PALETTE = [
  { bg: "var(--normal-soft)", fg: "var(--normal)" },
  { bg: "var(--sky-soft)", fg: "var(--sky)" },
  { bg: "var(--toggle-blue-soft)", fg: "var(--toggle-blue)" },
  { bg: "var(--urgent-soft)", fg: "var(--urgent)" },
  { bg: "var(--gold-soft)", fg: "var(--gold)" },
  { bg: "var(--navy-soft)", fg: "var(--navy)" },
];

function staffChipColor(phone) {
  // 계정 목록 안에서의 순번으로 색을 배정하면(해시와 달리) 등록된 사람
  // 수만큼은 서로 겹치지 않는 걸 보장할 수 있다 — 해시 방식은 유리/진우처럼
  // 우연히 같은 나머지가 나오면 색이 겹쳤었다.
  const idx = [...staffAccountsList].map((a) => a.phone).sort().indexOf(phone);
  if (idx >= 0) return STAFF_CHIP_PALETTE[idx % STAFF_CHIP_PALETTE.length];
  let hash = 0;
  const key = phone || "";
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return STAFF_CHIP_PALETTE[hash % STAFF_CHIP_PALETTE.length];
}

let scheduleStarted = false;
let scheduleEntries = []; // 지금 보고 있는 달의 스케줄 — live
let scheduleCalYear = 0;
let scheduleCalMonth = 0; // 0-indexed
let scheduleUnsub = null;
let scheduleSelectedDate = null; // 상세/추가 대상 날짜 — null이면 달력만 표시
let showScheduleForm = false;
let scheduleFormShiftType = "오픈";
let scheduleFormStaffPhone = "";
let scheduleFormStaffName = "";
let scheduleFormStartHour = "";
let scheduleFormStartMin = "";
let scheduleFormEndHour = "";
let scheduleFormEndMin = "";
let editingScheduleId = null; // null이면 새 근무 추가, 값이 있으면 그 근무를 수정 중
let staffAccountsList = []; // {phone, name} — 담당자 선택용, 최초 진입 시 한 번만 로드

// 요일 반복 등록 — 하루하루 따로 누를 필요 없이, 이 달 안에서 선택한
// 요일(들)에 한 번에 등록한다.
let showRecurringForm = false;
let recurringWeekdays = new Set(); // 0(일)~6(토)
let recurringShiftType = "오픈";
let recurringStaffPhone = "";
let recurringStaffName = "";
let recurringStartHour = "";
let recurringStartMin = "";
let recurringEndHour = "";
let recurringEndMin = "";

// 직원 개인 화면(render)과 사장님 화면(renderAdmin) 양쪽에서 다 쓰는 공용
// 기능이라, 지금 어느 쪽이 마운트돼 있는지에 맞는 렌더 함수를 다시 불러준다.
function rerenderCurrent() {
  if (account.role === "owner") renderAdmin();
  else render();
}

function loadScheduleForMonth() {
  if (scheduleUnsub) { scheduleUnsub(); scheduleUnsub = null; }
  const monthStart = ymd(new Date(scheduleCalYear, scheduleCalMonth, 1));
  const monthEnd = ymd(new Date(scheduleCalYear, scheduleCalMonth + 1, 0));
  scheduleUnsub = onSnapshot(
    query(collection(db, "schedules"), where("date", ">=", monthStart), where("date", "<=", monthEnd), orderBy("date")),
    (snap) => {
      scheduleEntries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      rerenderCurrent();
    }
  );
}

async function loadStaffAccountsList() {
  if (staffAccountsList.length > 0) return;
  const snap = await getDocs(collection(db, "accounts"));
  staffAccountsList = snap.docs.map((d) => ({ phone: d.id, name: d.data().name || "" }));
  rerenderCurrent();
}

function ensureScheduleStarted() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  const today = new Date();
  scheduleCalYear = today.getFullYear();
  scheduleCalMonth = today.getMonth();
  loadScheduleForMonth();
  loadStaffAccountsList();
}

function openScheduleDay(dateStr) {
  scheduleSelectedDate = dateStr;
  showScheduleForm = false;
  rerenderCurrent();
}

function closeScheduleDay() {
  scheduleSelectedDate = null;
  showScheduleForm = false;
  rerenderCurrent();
}

function openScheduleForm(entry) {
  if (entry) {
    editingScheduleId = entry.id;
    scheduleFormShiftType = entry.shiftType;
    scheduleFormStaffPhone = entry.staffPhone;
    scheduleFormStaffName = entry.staffName || "";
    const [sh, sm] = (entry.startTime || "").split(":");
    const [eh, em] = (entry.endTime || "").split(":");
    scheduleFormStartHour = sh !== undefined ? String(Number(sh)) : "";
    scheduleFormStartMin = sm !== undefined ? String(Number(sm)) : "";
    scheduleFormEndHour = eh !== undefined ? String(Number(eh)) : "";
    scheduleFormEndMin = em !== undefined ? String(Number(em)) : "";
  } else {
    editingScheduleId = null;
    scheduleFormShiftType = "오픈";
    scheduleFormStaffPhone = "";
    scheduleFormStaffName = "";
    scheduleFormStartHour = "";
    scheduleFormStartMin = "";
    scheduleFormEndHour = "";
    scheduleFormEndMin = "";
  }
  showScheduleForm = true;
  rerenderCurrent();
}

function cancelScheduleForm() {
  editingScheduleId = null;
  showScheduleForm = false;
  rerenderCurrent();
}

async function submitScheduleEntry() {
  if (!scheduleFormStaffPhone) {
    toast("담당자를 선택해주세요");
    return;
  }
  const startTime = scheduleFormStartHour !== "" && scheduleFormStartMin !== "" ? `${pad2(scheduleFormStartHour)}:${pad2(scheduleFormStartMin)}` : "";
  const endTime = scheduleFormEndHour !== "" && scheduleFormEndMin !== "" ? `${pad2(scheduleFormEndHour)}:${pad2(scheduleFormEndMin)}` : "";
  if (!startTime || !endTime) {
    toast("근무 시간을 입력해주세요");
    return;
  }
  if (editingScheduleId) {
    await updateDoc(doc(db, "schedules", editingScheduleId), {
      shiftType: scheduleFormShiftType,
      staffPhone: scheduleFormStaffPhone,
      staffName: scheduleFormStaffName,
      startTime,
      endTime,
    });
    toast("근무를 수정했어요");
  } else {
    await addDoc(collection(db, "schedules"), {
      date: scheduleSelectedDate,
      shiftType: scheduleFormShiftType,
      staffPhone: scheduleFormStaffPhone,
      staffName: scheduleFormStaffName,
      startTime,
      endTime,
      createdAt: serverTimestamp(),
    });
    toast("근무를 등록했어요");
  }
  editingScheduleId = null;
  showScheduleForm = false;
  rerenderCurrent();
}

// 등록(새 근무 추가)은 직원/사장님 누구나 할 수 있게 열어두지만, 이미 등록된
// 근무를 고치거나 지우는 건 본인 근무가 아닌 이상 함부로 건드리면 안 된다 —
// 사장님은 전체를 관리할 수 있고, 직원은 본인 이름으로 된 근무만 수정/삭제할
// 수 있다(다른 직원의 근무는 손댈 수 없음).
function canEditScheduleEntry(e) {
  return account.role === "owner" || e.staffPhone === account.phone;
}

async function deleteScheduleEntry(id) {
  const entry = scheduleEntries.find((e) => e.id === id);
  if (entry && !canEditScheduleEntry(entry)) {
    toast("본인 근무만 삭제할 수 있어요");
    return;
  }
  if (!confirm("이 근무 일정을 삭제할까요?")) return;
  await deleteDoc(doc(db, "schedules", id));
  toast("삭제했어요");
}

function scheduleCalendarHtml() {
  const firstDow = new Date(scheduleCalYear, scheduleCalMonth, 1).getDay();
  const totalDays = daysInMonth(scheduleCalYear, scheduleCalMonth + 1);
  const byDate = new Map();
  for (const e of scheduleEntries) {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  }
  const todayDateStr = ymd(new Date());

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);

  return `
    <div class="payroll-calendar">
      <div class="payroll-calendar-header">
        <button type="button" class="icon-btn" id="scheduleCalPrevMonth">‹</button>
        <strong>${scheduleCalYear}년 ${scheduleCalMonth + 1}월</strong>
        <button type="button" class="icon-btn" id="scheduleCalNextMonth">›</button>
      </div>
      <div class="payroll-calendar-weekdays">${WEEKDAYS.map((w) => `<span>${w}</span>`).join("")}</div>
      <div class="payroll-calendar-grid payroll-schedule-grid">
        ${cells.map((d) => {
          if (d === null) return `<div class="payroll-schedule-cell muted"></div>`;
          const dt = new Date(scheduleCalYear, scheduleCalMonth, d);
          const dateStr = ymd(dt);
          const isToday = dateStr === todayDateStr;
          const isRed = isRedDate(dateStr, dt.getDay());
          // 사람 기준(이름)으로 정렬해서, 같은 날 여러 명이 있어도 그
          // 순서가 요일마다 뒤바뀌지 않고 항상 고정되게 한다.
          const entries = [...(byDate.get(dateStr) || [])].sort((a, b) =>
            (a.staffName || "").localeCompare(b.staffName || "", "ko")
          );
          return `
            <button type="button" class="payroll-schedule-cell ${isToday ? "today" : ""}" data-schedule-day="${dateStr}">
              <div class="payroll-schedule-daynum ${isRed ? "red-date" : ""}">${d}</div>
              <div class="payroll-schedule-chips">
                ${entries.map((e) => {
                  const c = staffChipColor(e.staffPhone);
                  return `<span class="schedule-chip" style="background:${c.bg}; color:${c.fg};">${escapeHtml(e.staffName || "")}</span>`;
                }).join("")}
              </div>
            </button>`;
        }).join("")}
      </div>
    </div>`;
}

function scheduleFormHtml() {
  return `
    <div class="field" style="margin-top:14px;">
      <label>근무 유형</label>
      <div class="schedule-type-row">
        ${SHIFT_TYPES.map((t) => `<button type="button" class="schedule-type-btn ${SHIFT_TYPE_CLASS[t]} ${scheduleFormShiftType === t ? "active" : ""}" data-schedule-type="${t}">${t}</button>`).join("")}
      </div>
    </div>
    <div class="field">
      <label>담당자</label>
      <select id="scheduleStaffSelect">
        <option value="">선택하세요</option>
        ${staffAccountsList.map((a) => `<option value="${a.phone}" ${scheduleFormStaffPhone === a.phone ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
      </select>
    </div>
    <div class="field" style="margin-bottom:0;">
      <label>근무 시간</label>
      <div class="payroll-time-row">
        ${timeSelectHtml("scheduleFormStart", scheduleFormStartHour, scheduleFormStartMin)}
        <span>-</span>
        ${timeSelectHtml("scheduleFormEnd", scheduleFormEndHour, scheduleFormEndMin)}
      </div>
    </div>
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn secondary" id="scheduleFormCancelBtn" style="flex:1;">취소</button>
      <button class="btn gold" id="scheduleSubmitBtn" style="flex:2;">${editingScheduleId ? "수정 완료" : "등록"}</button>
    </div>`;
}

function scheduleDayOverlayHtml() {
  if (!scheduleSelectedDate) return "";
  const entries = [...scheduleEntries]
    .filter((e) => e.date === scheduleSelectedDate)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  return `
    <div class="payroll-form-overlay" id="scheduleDayOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">${formatShiftDateLabel(scheduleSelectedDate)} 근무</div>
          <button class="payroll-form-close-btn" id="scheduleDayCloseBtn" aria-label="닫기">✕</button>
        </div>
        ${entries.length === 0 ? `<div class="empty" style="margin-top:12px;">등록된 근무가 없어요.</div>` : `
        <div class="payroll-shift-list" style="margin:14px 0;">
          ${entries.map((e) => `
            <div class="payroll-shift-row">
              <span class="schedule-chip ${SHIFT_TYPE_CLASS[e.shiftType] || ""}">${escapeHtml(e.shiftType)}</span>
              <div class="payroll-shift-info">
                <div class="payroll-shift-date">${escapeHtml(e.staffName || "")}</div>
                <div class="payroll-shift-time">${e.startTime}~${e.endTime}</div>
              </div>
              ${canEditScheduleEntry(e) ? `
              <button class="payroll-shift-edit-btn" data-schedule-edit="${e.id}">수정</button>
              <button class="payroll-shift-delete-btn" data-schedule-delete="${e.id}">삭제</button>` : ""}
            </div>`).join("")}
        </div>`}
        ${showScheduleForm ? scheduleFormHtml() : `<button class="btn gold block" id="scheduleAddEntryBtn" style="margin-top:10px;">+ 근무 추가</button>`}
      </div>
    </div>`;
}

function openRecurringForm() {
  recurringWeekdays = new Set();
  recurringShiftType = "오픈";
  recurringStaffPhone = "";
  recurringStaffName = "";
  recurringStartHour = "";
  recurringStartMin = "";
  recurringEndHour = "";
  recurringEndMin = "";
  showRecurringForm = true;
  rerenderCurrent();
}

function closeRecurringForm() {
  showRecurringForm = false;
  rerenderCurrent();
}

async function submitRecurringSchedule() {
  if (recurringWeekdays.size === 0) {
    toast("반복할 요일을 선택해주세요");
    return;
  }
  if (!recurringStaffPhone) {
    toast("담당자를 선택해주세요");
    return;
  }
  const startTime = recurringStartHour !== "" && recurringStartMin !== "" ? `${pad2(recurringStartHour)}:${pad2(recurringStartMin)}` : "";
  const endTime = recurringEndHour !== "" && recurringEndMin !== "" ? `${pad2(recurringEndHour)}:${pad2(recurringEndMin)}` : "";
  if (!startTime || !endTime) {
    toast("근무 시간을 입력해주세요");
    return;
  }

  const totalDays = daysInMonth(scheduleCalYear, scheduleCalMonth + 1);
  const dates = [];
  for (let d = 1; d <= totalDays; d++) {
    const dt = new Date(scheduleCalYear, scheduleCalMonth, d);
    if (recurringWeekdays.has(dt.getDay())) dates.push(ymd(dt));
  }
  if (dates.length === 0) {
    toast("선택한 요일에 해당하는 날짜가 이 달엔 없어요");
    return;
  }
  if (!confirm(`${scheduleCalYear}년 ${scheduleCalMonth + 1}월, ${dates.length}개 날짜에 등록할까요?`)) return;

  await Promise.all(
    dates.map((d) =>
      addDoc(collection(db, "schedules"), {
        date: d,
        shiftType: recurringShiftType,
        staffPhone: recurringStaffPhone,
        staffName: recurringStaffName,
        startTime,
        endTime,
        createdAt: serverTimestamp(),
      })
    )
  );
  toast(`${dates.length}개 날짜에 등록했어요`);
  showRecurringForm = false;
  rerenderCurrent();
}

function recurringFormOverlayHtml() {
  return `
    <div class="payroll-form-overlay" id="recurringFormOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">요일 반복 등록 (${scheduleCalYear}년 ${scheduleCalMonth + 1}월)</div>
          <button class="payroll-form-close-btn" id="recurringFormCloseBtn" aria-label="닫기">✕</button>
        </div>
        <div class="field" style="margin-top:14px;">
          <label>반복할 요일 (복수 선택 가능)</label>
          <div class="schedule-weekday-row">
            ${WEEKDAYS.map((w, i) => `<button type="button" class="schedule-weekday-btn ${recurringWeekdays.has(i) ? "active" : ""}" data-recurring-weekday="${i}">${w}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>근무 유형</label>
          <div class="schedule-type-row">
            ${SHIFT_TYPES.map((t) => `<button type="button" class="schedule-type-btn ${SHIFT_TYPE_CLASS[t]} ${recurringShiftType === t ? "active" : ""}" data-recurring-type="${t}">${t}</button>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>담당자</label>
          <select id="recurringStaffSelect">
            <option value="">선택하세요</option>
            ${staffAccountsList.map((a) => `<option value="${a.phone}" ${recurringStaffPhone === a.phone ? "selected" : ""}>${escapeHtml(a.name)}</option>`).join("")}
          </select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label>근무 시간</label>
          <div class="payroll-time-row">
            ${timeSelectHtml("recurringFormStart", recurringStartHour, recurringStartMin)}
            <span>-</span>
            ${timeSelectHtml("recurringFormEnd", recurringEndHour, recurringEndMin)}
          </div>
        </div>
        <button class="btn gold block" id="recurringSubmitBtn" style="margin-top:16px;">이 달에 반복 등록</button>
      </div>
    </div>`;
}

function scheduleTabHtml() {
  return `
    ${scheduleCalendarHtml()}
    <button class="btn secondary block" id="scheduleRecurringBtn" style="margin-top:10px;">+ 요일 반복 등록</button>
    ${scheduleDayOverlayHtml()}
    ${showRecurringForm ? recurringFormOverlayHtml() : ""}`;
}

function wireScheduleEvents() {
  const prevBtn = document.getElementById("scheduleCalPrevMonth");
  const nextBtn = document.getElementById("scheduleCalNextMonth");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      scheduleCalMonth -= 1;
      if (scheduleCalMonth < 0) { scheduleCalMonth = 11; scheduleCalYear -= 1; }
      loadScheduleForMonth();
      rerenderCurrent();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      scheduleCalMonth += 1;
      if (scheduleCalMonth > 11) { scheduleCalMonth = 0; scheduleCalYear += 1; }
      loadScheduleForMonth();
      rerenderCurrent();
    });
  }
  document.querySelectorAll("[data-schedule-day]").forEach((el) => {
    el.addEventListener("click", () => openScheduleDay(el.dataset.scheduleDay));
  });
  const dayOverlay = document.getElementById("scheduleDayOverlay");
  if (dayOverlay) {
    dayOverlay.addEventListener("click", (e) => { if (e.target === dayOverlay) closeScheduleDay(); });
    document.getElementById("scheduleDayCloseBtn").addEventListener("click", closeScheduleDay);
    document.querySelectorAll("[data-schedule-delete]").forEach((el) => {
      el.addEventListener("click", () => deleteScheduleEntry(el.dataset.scheduleDelete));
    });
    document.querySelectorAll("[data-schedule-edit]").forEach((el) => {
      el.addEventListener("click", () => {
        const found = scheduleEntries.find((e) => e.id === el.dataset.scheduleEdit);
        if (found && canEditScheduleEntry(found)) openScheduleForm(found);
      });
    });
    const addEntryBtn = document.getElementById("scheduleAddEntryBtn");
    if (addEntryBtn) addEntryBtn.addEventListener("click", () => openScheduleForm());
    const cancelBtn = document.getElementById("scheduleFormCancelBtn");
    if (cancelBtn) cancelBtn.addEventListener("click", cancelScheduleForm);
    document.querySelectorAll("[data-schedule-type]").forEach((el) => {
      el.addEventListener("click", () => { scheduleFormShiftType = el.dataset.scheduleType; rerenderCurrent(); });
    });
    const staffSelect = document.getElementById("scheduleStaffSelect");
    if (staffSelect) {
      staffSelect.addEventListener("change", (e) => {
        scheduleFormStaffPhone = e.target.value;
        const found = staffAccountsList.find((a) => a.phone === e.target.value);
        scheduleFormStaffName = found ? found.name : "";
      });
    }
    const startHour = document.getElementById("scheduleFormStartHour");
    const startMin = document.getElementById("scheduleFormStartMin");
    const endHour = document.getElementById("scheduleFormEndHour");
    const endMin = document.getElementById("scheduleFormEndMin");
    if (startHour) startHour.addEventListener("change", (e) => { scheduleFormStartHour = e.target.value; });
    if (startMin) startMin.addEventListener("change", (e) => { scheduleFormStartMin = e.target.value; });
    if (endHour) endHour.addEventListener("change", (e) => { scheduleFormEndHour = e.target.value; });
    if (endMin) endMin.addEventListener("change", (e) => { scheduleFormEndMin = e.target.value; });
    const submitBtn = document.getElementById("scheduleSubmitBtn");
    if (submitBtn) submitBtn.addEventListener("click", submitScheduleEntry);
  }

  const recurringBtn = document.getElementById("scheduleRecurringBtn");
  if (recurringBtn) recurringBtn.addEventListener("click", openRecurringForm);
  const recurringOverlay = document.getElementById("recurringFormOverlay");
  if (recurringOverlay) {
    recurringOverlay.addEventListener("click", (e) => { if (e.target === recurringOverlay) closeRecurringForm(); });
    document.getElementById("recurringFormCloseBtn").addEventListener("click", closeRecurringForm);
    document.querySelectorAll("[data-recurring-weekday]").forEach((el) => {
      el.addEventListener("click", () => {
        const day = Number(el.dataset.recurringWeekday);
        if (recurringWeekdays.has(day)) recurringWeekdays.delete(day);
        else recurringWeekdays.add(day);
        rerenderCurrent();
      });
    });
    document.querySelectorAll("[data-recurring-type]").forEach((el) => {
      el.addEventListener("click", () => { recurringShiftType = el.dataset.recurringType; rerenderCurrent(); });
    });
    const recurringStaffSelect = document.getElementById("recurringStaffSelect");
    if (recurringStaffSelect) {
      recurringStaffSelect.addEventListener("change", (e) => {
        recurringStaffPhone = e.target.value;
        const found = staffAccountsList.find((a) => a.phone === e.target.value);
        recurringStaffName = found ? found.name : "";
      });
    }
    const rStartHour = document.getElementById("recurringFormStartHour");
    const rStartMin = document.getElementById("recurringFormStartMin");
    const rEndHour = document.getElementById("recurringFormEndHour");
    const rEndMin = document.getElementById("recurringFormEndMin");
    if (rStartHour) rStartHour.addEventListener("change", (e) => { recurringStartHour = e.target.value; });
    if (rStartMin) rStartMin.addEventListener("change", (e) => { recurringStartMin = e.target.value; });
    if (rEndHour) rEndHour.addEventListener("change", (e) => { recurringEndHour = e.target.value; });
    if (rEndMin) rEndMin.addEventListener("change", (e) => { recurringEndMin = e.target.value; });
    const recurringSubmitBtn = document.getElementById("recurringSubmitBtn");
    if (recurringSubmitBtn) recurringSubmitBtn.addEventListener("click", submitRecurringSchedule);
  }
}
