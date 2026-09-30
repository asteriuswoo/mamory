import { db, readyAuth, doc, getDoc, setDoc, updateDoc, serverTimestamp } from "./firebase-init.js";
import { getAccount, setAccount, clearAccount, normalizePhone } from "./util.js";

export async function fetchAccount(phone) {
  await readyAuth;
  const snap = await getDoc(doc(db, "accounts", phone));
  return snap.exists() ? snap.data() : null;
}

export async function registerAccount({ phone, name, role, pin }) {
  await readyAuth;
  const account = { phone, name, role, createdAt: serverTimestamp() };
  if (pin) account.pin = pin;
  await setDoc(doc(db, "accounts", phone), account);
  return { phone, name, role, ...(pin ? { pin } : {}) };
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
// Re-validates the cached account against Firestore so role/name changes
// made by the owner (or account removal) always take effect on next load.
export async function requireAccount(expectedRole) {
  const cached = getAccount();
  if (!cached || !cached.phone) {
    location.replace("index.html");
    return null;
  }

  let fresh;
  try {
    fresh = await fetchAccount(cached.phone);
  } catch (e) {
    // Offline or Firestore unreachable: fall back to cached copy rather than locking the user out.
    fresh = cached;
  }

  if (!fresh) {
    clearAccount();
    location.replace("index.html");
    return null;
  }

  // 이 기능 배포 전부터 로그인돼 있던 직원 기기는 PIN이 없으므로, 캐시된
  // 세션을 지우고 index.html로 돌려보내 번호+PIN 등록을 다시 거치게 한다.
  // (사장님 계정은 PIN이 accounts 문서가 아니라 config/ownerPin에 따로
  // 있으므로 이 검사에서 제외.)
  if (fresh.role === "staff" && !fresh.pin) {
    clearAccount();
    location.replace("index.html");
    return null;
  }

  setAccount(fresh);

  // Owner accounts can also open the staff ordering flow (to submit their
  // own requests on a day they're working solo) — staff accounts still
  // can't reach owner-only pages, since that check stays a strict equality.
  const allowed = fresh.role === expectedRole || (expectedRole === "staff" && fresh.role === "owner");
  if (!allowed) {
    location.replace(fresh.role === "owner" ? "owner.html" : "staff.html");
    return null;
  }

  return fresh;
}

export function logout() {
  clearAccount();
  location.href = "index.html";
}

export { normalizePhone };
