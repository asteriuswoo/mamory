// 공유하기 view — mounted/unmounted by app-shell.js. shareboard.js already
// keeps its own Firestore listener alive as a module-level singleton (it has
// to, since the nav badge on the bottom tab bar needs it running even while
// this view isn't the active tab) and safely re-renders into whichever root
// element it's given, so there's nothing to unsubscribe here on unmount.
import { mountShareBoard } from "./shareboard.js";

export function mount(account) {
  document.getElementById("pageSub").textContent = "품절 자재 · 특이사항 공유";
  mountShareBoard(document.getElementById("shareBoardRoot"), { name: account.name, phone: account.phone });
}

export function unmount() {}
