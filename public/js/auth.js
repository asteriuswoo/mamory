import { db, readyAuth, doc, getDoc, setDoc, serverTimestamp } from "./firebase-init.js";
import { getAccount, setAccount, clearAccount, normalizePhone } from "./util.js";

export async function fetchAccount(phone) {
  await readyAuth;
  const snap = await getDoc(doc(db, "accounts", phone));
  return snap.exists() ? snap.data() : null;
}

export async function registerAccount({ phone, name, role }) {
  await readyAuth;
  const account = { phone, name, role, createdAt: serverTimestamp() };
  await setDoc(doc(db, "accounts", phone), account);
  return { phone, name, role };
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
