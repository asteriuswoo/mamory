// 출근기록 · 급여대장 — 직원 개인이 자기 시급/근무시간을 기록하고 급여를
// 자동 계산해보는 탭(하우머치류 앱 대체). 철저히 계정 개인 데이터라 본인
// 전화번호 하위 accounts/{phone}/shifts 에만 읽고 쓴다 — 다른 사람 근무는
// 아예 조회하지 않는다. mountPayrollBoard(el, account)로 붙여 쓴다.
//
// 사장님 계정에서는 이 탭이 완전히 다른 화면이 된다 — 본인 근무를 기록하는
// 게 아니라, 직원들이 월급날 제출한 급여 요청(payrollRequests)을 직원별로
// 모아 보여주는 수신함 역할만 한다.
import { db, collection, collectionGroup, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, where, serverTimestamp } from "./firebase-init.js";
import { toast, escapeHtml } from "./util.js";
import { avatarHtml } from "./avatar.js";

let rootEl = null;
let account = { name: "", phone: "" };
let started = false;

let hourlyWage = 0;
let payCycleStartDay = 1; // 1~28일 중 "이 날부터 다음달 이 날 전날까지"가 한 주기
let insuranceType = "33"; // "33" = 3.3% 사업소득세 공제, "4das" = 4대보험 공제
let shifts = []; // 전체 근무 기록 — live
let cycleOffset = 0; // 0 = 오늘이 속한 주기, -1 = 이전 주기, +1 = 다음 주기
let view = "list"; // list | payslip
let editMode = false;
let myPayrollRequests = []; // 내가 제출한 급여 요청 — live, 이미 제출한 기간인지 확인용
let submittedDetailOpen = false; // "제출한 내용 보기" 토글
let showForm = false;

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

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
          ${editShowDatePicker ? calendarHtml(editDates, editCalYear, editCalMonth, "editCalPrevMonth", "editCalNextMonth", "data-edit-date") : ""}
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

// ---- 렌더 ----

// 앞/뒤 달의 날짜를 흐리게라도 채워 넣는 이유 — 첫 주가 목/금/토처럼 늦게
// 시작하는 달은 첫 줄이 거의 텅 비어 보여서, 실제로는 줄 간격이 다 똑같은데
// "첫 주와 둘째 주 사이 공백이 유독 크다"는 착시가 생겼다. 실제 달력 앱들처럼
// 빈 칸을 이전/다음 달 숫자로 채우면 이 착시가 사라진다.
function calendarHtml(selectedDates, year, month, prevBtnId, nextBtnId, dateAttr) {
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
    cells.push({ d, muted: false, dateStr: ymd(new Date(year, month, d)) });
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
          return `<button type="button" class="payroll-calendar-cell ${active ? "active" : ""} ${isToday ? "today" : ""}" ${dateAttr}="${c.dateStr}">${c.d}</button>`;
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
          ${showDatePicker ? calendarHtml(formDates, calYear, calMonth, "calPrevMonth", "calNextMonth", "data-form-date") : ""}
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

function listHtml(cycleShifts) {
  if (cycleShifts.length === 0) {
    return `<div class="card"><div class="empty">이 기간에 등록된 근무가 없어요.</div></div>`;
  }
  const rows = cycleShifts.map((s) => {
    const pay = computeShiftPay(s, hourlyWage);
    return `
      <div class="payroll-shift-row ${editMode ? "payroll-shift-row-editable" : ""}" ${editMode ? `data-shift-edit="${s.id}"` : ""}>
        <div class="payroll-shift-info">
          <div class="payroll-shift-date">${formatShiftDateLabel(s.date)}</div>
          <div class="payroll-shift-time">${s.startTime}~${s.endTime}</div>
        </div>
        <div class="payroll-shift-pay">${Math.round(pay.total).toLocaleString()}원</div>
        ${editMode ? `<button class="payroll-shift-delete-btn" data-shift-delete="${s.id}">삭제</button>` : ""}
      </div>`;
  }).join("");
  return `<div class="card payroll-shift-list">${rows}</div>`;
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

function payslipHtml(cycleShifts, cycleLabel, payday) {
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
    </div>` : `<button class="btn secondary block" id="payrollSubmitRequestBtn" style="margin-top:4px;" ${cycleShifts.length === 0 ? "disabled" : ""}>사장님께 이번 급여 제출하기</button>`;

  return `
    <div class="card payroll-payslip-hero">
      <div class="payroll-payslip-store">MMTH | ${cycleLabel}</div>
      <div class="payroll-payslip-net">${Math.round(net).toLocaleString()}원 <span class="tag submitted">실수령액</span></div>
      <div class="payroll-payslip-payday">급여 지급일 ${pad2(payday.getMonth() + 1)}.${pad2(payday.getDate())}(${WEEKDAYS[payday.getDay()]})</div>
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
  const isPayday = ymd(new Date()) === ymd(cycleBounds(0).end);

  let html = `
    <div class="card payroll-summary-card">
      <div class="row-between">
        <div class="payroll-store-label">MMTH</div>
        <button class="payroll-settings-btn" id="payrollSettingsBtn">⚙️ 정산일 ${payCycleStartDay}일</button>
      </div>
      <div class="payroll-total-amount">${Math.round(net).toLocaleString()}원</div>
    </div>
    ${isPayday ? `<div class="payroll-payday-banner">💰 월급날입니다! 사장님께 급여내역을 제출하세요</div>` : ""}
    ${view !== "attendance" ? `
    <div class="payroll-cycle-nav">
      <button class="payroll-cycle-arrow" id="payrollCyclePrev">‹</button>
      <span class="payroll-cycle-label">${cycleLabel}</span>
      <button class="payroll-cycle-arrow" id="payrollCycleNext">›</button>
    </div>` : ""}
    <div class="seg payroll-view-tabs">
      <button type="button" class="${view === "list" ? "active" : ""}" data-payroll-view="list">근무내역</button>
      <button type="button" class="${view === "payslip" ? "active" : ""}" data-payroll-view="payslip">급여명세서</button>
      <button type="button" class="${view === "attendance" ? "active" : ""}" data-payroll-view="attendance">출퇴근기록</button>
    </div>`;

  if (view === "list") {
    html += `
      <div class="row-between" style="margin:14px 0 8px;">
        <div style="font-weight:800;">나의 근무</div>
        <div style="display:flex; gap:6px;">
          <button class="btn secondary" id="payrollEditToggleBtn" style="padding:6px 12px; font-size:12px;">${editMode ? "완료" : "✏️ 편집"}</button>
          <button class="btn gold" id="payrollAddBtn" style="padding:6px 12px; font-size:12px;">+ 등록</button>
        </div>
      </div>
      ${listHtml(cycleShifts)}`;
  } else if (view === "payslip") {
    html += payslipHtml(cycleShifts, cycleLabel, end);
  } else {
    html += attendanceTabHtml();
  }

  if (showForm) html += formHtml();
  if (editingShiftId) html += editShiftHtml();

  rootEl.innerHTML = html;

  document.getElementById("payrollSettingsBtn").addEventListener("click", editPayCycleStartDay);
  const cyclePrevBtn = document.getElementById("payrollCyclePrev");
  const cycleNextBtn = document.getElementById("payrollCycleNext");
  if (cyclePrevBtn) cyclePrevBtn.addEventListener("click", () => { cycleOffset -= 1; render(); });
  if (cycleNextBtn) cycleNextBtn.addEventListener("click", () => { cycleOffset += 1; render(); });
  rootEl.querySelectorAll("[data-payroll-view]").forEach((el) => {
    el.addEventListener("click", () => { view = el.dataset.payrollView; render(); });
  });
  const editToggleBtn = document.getElementById("payrollEditToggleBtn");
  if (editToggleBtn) editToggleBtn.addEventListener("click", () => { editMode = !editMode; if (!editMode) editingShiftId = null; render(); });
  rootEl.querySelectorAll("[data-shift-delete]").forEach((el) => {
    el.addEventListener("click", (e) => { e.stopPropagation(); deleteShift(el.dataset.shiftDelete); });
  });
  rootEl.querySelectorAll("[data-shift-edit]").forEach((el) => {
    el.addEventListener("click", () => {
      const shift = shifts.find((s) => s.id === el.dataset.shiftEdit);
      if (shift) openEditShift(shift);
    });
  });
  const submitRequestBtn = document.getElementById("payrollSubmitRequestBtn");
  if (submitRequestBtn) submitRequestBtn.addEventListener("click", submitPayrollRequest);
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
    insuranceType = data.insuranceType || "33";
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
      <div class="payroll-shift-info">
        <div class="payroll-shift-date">${escapeHtml(r.staffName || "")}</div>
        <div class="payroll-shift-time">${stampLabel(r)}</div>
      </div>
    </div>`).join("");
}

function renderAdmin() {
  if (!rootEl) return;
  const groups = groupRequestsByStaff(adminRequests);
  const todayLabel = formatShiftDateLabel(ymd(new Date()));
  let html = `
    <div class="category-title row-between"><span>🕐 오늘의 출퇴근</span><span style="font-size:12px; font-weight:600; color:var(--muted);">${todayLabel}</span></div>
    <div class="card">${todayAttendanceHtml()}</div>
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
              <strong>${escapeHtml(g.name)}</strong>
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
                <div class="row-between payroll-payslip-line"><span>${sumIcon("plus")}지급 합계</span><span>${(r.gross || 0).toLocaleString()}원</span></div>
                <div class="row-between payroll-payslip-line"><span>${sumIcon("minus")}공제 합계</span><span>${(r.deductionTotal || 0).toLocaleString()}원</span></div>
                <div class="payroll-admin-shift-header">근무 내역</div>
                ${(r.shifts || []).map((s) => `
                  <div class="row-between payroll-admin-shift-line">
                    <span>${formatShiftDateLabel(s.date)} ${s.startTime}~${s.endTime}${s.breakMinutes ? ` (휴게 ${s.breakMinutes}분)` : ""}${s.extraAllowance ? ` · 추가수당 ${s.extraAllowance.toLocaleString()}원` : ""}</span>
                    <span>${(s.pay || 0).toLocaleString()}원</span>
                  </div>`).join("")}
                <button type="button" class="payroll-shift-delete-btn" data-admin-request-delete="${r.id}" style="margin-top:8px;">삭제</button>
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

function timeNowStr() {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

async function recordAttendanceStamp(type) {
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
}

function renderClockWidget() {
  if (!clockRootEl) return;
  clockRootEl.innerHTML = lastClockType === "in"
    ? `
      <div class="clock-widget">
        <div class="clock-widget-status">🟢 출근 중</div>
        <button class="btn urgent block" id="clockOutBtn">🔴 퇴근 도장 찍기</button>
      </div>`
    : `
      <div class="clock-widget">
        <button class="btn normal block" id="clockInBtn">🕐 출근 도장 찍기</button>
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
          const dateStr = ymd(new Date(attCalYear, attCalMonth, d));
          const isToday = dateStr === todayDateStr;
          const records = (byDate.get(dateStr) || []).sort((a, b) => a.time.localeCompare(b.time));
          return `
            <div class="payroll-attendance-cell ${isToday ? "today" : ""}">
              <div class="payroll-attendance-daynum">${d}</div>
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
