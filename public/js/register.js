// 등록해요 view — mounted/unmounted by app-shell.js. registerboard.js already
// keeps its own Firestore listeners alive as module-level singletons and
// safely re-renders into whichever root element it's given, so there's
// nothing to unsubscribe here on unmount.
import { mountRegisterBoard } from "./registerboard.js";

export function mount(account) {
  document.getElementById("pageSub").textContent = "시재 · 선결제 충전 등록";
  mountRegisterBoard(document.getElementById("registerBoardRoot"), { name: account.name, phone: account.phone, role: account.role });
}

export function unmount() {}
