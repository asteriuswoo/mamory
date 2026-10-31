import { db, readyAuth, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "./firebase-init.js";
import { getAccount, setAccount, clearAccount, normalizePhone } from "./util.js";
import { removeDeviceTokenOnLogout } from "./push.js";

export async function fetchAccount(phone) {
  await readyAuth;
  const snap = await getDoc(doc(db, "accounts", phone));
  return snap.exists() ? snap.data() : null;
}

// storeId를 "mmth"로 고정 — 1단계 마이그레이션 이후 가입한 계정에
// storeId가 안 찍히던 버그(2026-10-30, 강화영님 계정에서 발견)의 임시
// 패치. 2단계(로그인 구조 전환, Task #63)에서 이 함수 자체가 Cloud
// Function 호출로 교체되면서 가입코드로 실제 storeId를 조회하는 방식으로
// 바뀔 예정 — 그 전까지, 매장이 하나뿐인 지금은 이렇게 고정값으로
// 막아둔다. 두 번째 매장이 생기기 전에 반드시 Task #63로 교체할 것.
export async function registerAccount({ phone, name, role, pin }) {
  await readyAuth;
  const account = { phone, name, role, storeId: "mmth", createdAt: serverTimestamp() };
  if (pin) account.pin = pin;
  await setDoc(doc(db, "accounts", phone), account);
  return { phone, name, role, storeId: "mmth", ...(pin ? { pin } : {}) };
}

// 직원 계정 전용 개인 PIN — 사장님 PIN(config/ownerPin, 전체 공유)과 달리
// 계정마다 따로 저장돼서, 번호만 알면 남의 계정에 그대로 들어가던 문제를
// 막는다. 아직 PIN이 없는(=이 기능 이전에 가입한) 계정은 로그인 시
// login.js가 자동으로 등록을 요구한다.
export async function setStaffPin(phone, pin) {
  await readyAuth;
  await updateDoc(doc(db, "accounts", phone), { pin, pinUpdatedAt: serverTimestamp() });
}

// The owner PIN is not hardcoded anywhere in the app. Whoever registers as
// "사장님" first creates it, and it's stored in Firestore so every later
// owner login/registration checks against that same value.
export async function getOwnerPin() {
  await readyAuth;
  const snap = await getDoc(doc(db, "config", "ownerPin"));
  return snap.exists() ? snap.data().pin : null;
}

export async function setOwnerPinDoc(pin) {
  await readyAuth;
  await setDoc(doc(db, "config", "ownerPin"), { pin, updatedAt: serverTimestamp() });
}

// Staff/owner sign-up gate: new phone numbers can only create an account if
// they know this code. Existing accounts are never affected — only checked
// at the "처음 뵙네요" registration step. The owner sets/rotates it from the
// 자재 관리 page; it starts unset until the owner configures one there.
export async function getAccessCode() {
  await readyAuth;
  const snap = await getDoc(doc(db, "config", "accessCode"));
  return snap.exists() ? snap.data().code : null;
}

export async function setAccessCodeDoc(code) {
  await readyAuth;
  await setDoc(doc(db, "config", "accessCode"), { code, updatedAt: serverTimestamp() });
}

// Call at the top of staff.html / owner.html / admin.html.
// Returns the locally cached account once Firebase Auth is actually ready,
// without waiting on the second round-trip (the account doc fetch) — that
// doc re-check still happens, just in the background (see below).
//
// readyAuth itself MUST still be awaited here, not skipped: every onSnapshot
// listener the rest of the page sets up right after this resolves depends on
// request.auth already being attached. A listener that's established before
// auth attaches gets a real PERMISSION_DENIED from Firestore's security
// rules (not a "retry once you're signed in" — Firestore doesn't retry those
// on its own) and stays dead even after auth completes a moment later — every
// list on the page silently shows empty forever. That's exactly what a
// previous version of this function did by skipping readyAuth entirely, and
// it broke live for a real user (empty 자재/시재/공유 lists, looked exactly
// like a network outage) before this comment was written to explain why it
// can never happen again. readyAuth itself is normally near-instant (cached
// anon session) so this still avoids the slow part (the account getDoc).
export async function requireAccount(expectedRole) {
  const cached = getAccount();
  if (!cached || !cached.phone) {
    location.replace("index.html");
    return null;
  }
  await readyAuth;
  verifyAccountInBackground(expectedRole, cached);
  return cached;
}

async function verifyAccountInBackground(expectedRole, cached) {
  let fresh;
  try {
    fresh = await fetchAccount(cached.phone);
  } catch (e) {
    // Offline or Firestore unreachable: keep using the cached copy, nothing to correct.
    return;
  }

  if (!fresh) {
    clearAccount();
    location.replace("index.html");
    return;
  }

  // 이 기능 배포 전부터 로그인돼 있던 직원 기기는 PIN이 없으므로, 캐시된
  // 세션을 지우고 index.html로 돌려보내 번호+PIN 등록을 다시 거치게 한다.
  // (사장님 계정은 PIN이 accounts 문서가 아니라 config/ownerPin에 따로
  // 있으므로 이 검사에서 제외.)
  if (fresh.role === "staff" && !fresh.pin) {
    clearAccount();
    location.replace("index.html");
    return;
  }

  setAccount(fresh);

  // Owner accounts can also open the staff ordering flow (to submit their
  // own requests on a day they're working solo) — staff accounts still
  // can't reach owner-only pages, since that check stays a strict equality.
  const allowed = fresh.role === expectedRole || (expectedRole === "staff" && fresh.role === "owner");
  if (!allowed) {
    location.replace(fresh.role === "owner" ? "owner.html" : "staff.html");
  }
}

export async function logout() {
  // 로그아웃해도 이 기기의 알림 토큰이 그대로 남아있으면, 나중에 다른
  // 기기로 또 로그인했을 때 두 기기 모두에 같은 알림이 두 번 가버린다 —
  // 로그아웃 시점에 이 기기 몫만 지워둔다.
  const acc = getAccount();
  if (acc && acc.phone) await removeDeviceTokenOnLogout(acc.phone);
  clearAccount();
  location.href = "index.html";
}

export { normalizePhone };
