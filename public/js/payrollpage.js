// 급여대장(사장님용) view — mounted/unmounted by app-shell.js. 사장님 계정은
// role이 항상 "owner"라서 payroll.js의 mountPayrollBoard가 자동으로 직원
// 급여 요청 수신함 화면을 붙여준다(개인 근무 기록 화면이 아니라).
import { mountPayrollBoard } from "./payroll.js";

export function mount(account) {
  document.getElementById("pageSub").textContent = "직원 출퇴근 · 급여 제출함";
  mountPayrollBoard(document.getElementById("payrollBoardRoot"), { name: account.name, phone: account.phone, role: account.role, storeId: account.storeId });
}

export function unmount() {}
