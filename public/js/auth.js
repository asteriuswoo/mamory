import { db, readyAuth, doc, getDoc, signInWithCustomToken, signOut, auth, callable } from "./firebase-init.js";
import { getAccount, setAccount, clearAccount, normalizePhone } from "./util.js";
import { removeDeviceTokenOnLogout } from "./push.js";

// 2단계(로그인 구조 전환): PIN 비교는 이제 전부 서버(Cloud Functions,
// Admin SDK)에서만 일어난다 — 클라이언트는 입력값을 넘기고 결과(성공 시
// 커스텀 토큰)만 받는다. 예전엔 사장님 PIN/가입코드를 먼저 Firestore에서
// 읽어와 브라우저에서 비교했는데, 그러면 입력이 틀려도 진짜 PIN 값은 이미
// 브라우저로 전송된 뒤였다.
const lookupAccountForLoginFn = callable("lookupAccountForLogin");
const ownerLoginFn = callable("ownerLogin");
const staffLoginFn = callable("staffLogin");
const staffCreatePinAndLoginFn = callable("staffCreatePinAndLogin");
const checkAccessCodeFn = callable("checkAccessCode");
const registerAccountFn = callable("registerAccount");
const rotateAccessCodeFn = callable("rotateAccessCode");
const getCurrentAccessCodeFn = callable("getCurrentAccessCode");

export async function fetchAccount(phone) {
  await readyAuth;
  const snap = await getDoc(doc(db, "accounts", phone));
  return snap.exists() ? snap.data() : null;
}

// 로그인 전(아직 인증 안 된) 단계에서 "이 번호가 가입됐는지/역할/개인 PIN이
// 있는지"만 돌려준다 — PIN 값 자체는 절대 안 준다. accounts/{phone}을
// 비인증 상태로 직접 읽을 수 없게 된 지금, login.js가 전화번호 입력
// 직후 이 함수로 대체했다.
export async function lookupAccountForLogin(phone) {
  const res = await lookupAccountForLoginFn({ phone });
  return res.data;
}

async function signInWithToken(token, account) {
  await signInWithCustomToken(auth, token);
  return account;
}

export async function ownerLogin(phone, pin) {
  const res = await ownerLoginFn({ phone, pin });
  return signInWithToken(res.data.token, res.data.account);
}

export async function staffLogin(phone, pin) {
  const res = await staffLoginFn({ phone, pin });
  return signInWithToken(res.data.token, res.data.account);
}

// 이 기능 배포 전부터 있던(=개인 PIN이 아직 없는) 직원 계정이 처음
// 로그인할 때, PIN 생성 + 로그인을 한 번에 처리한다.
export async function staffCreatePinAndLogin(phone, pin) {
  const res = await staffCreatePinAndLoginFn({ phone, pin });
  return signInWithToken(res.data.token, res.data.account);
}

// 가입 화면에서 PIN 입력 전에 가입 코드 유효성만 미리 확인.
export async function checkAccessCode(code) {
  const res = await checkAccessCodeFn({ code });
  return res.data.valid;
}

export async function registerAccount({ phone, name, role, accessCode, pin }) {
  const res = await registerAccountFn({ phone, name, role, accessCode, pin });
  return signInWithToken(res.data.token, res.data.account);
}

// 사장님 전용 — 가입 코드 변경.
export async function rotateAccessCode(newCode) {
  const res = await rotateAccessCodeFn({ newCode });
  return res.data.code;
}

// 사장님 전용 — 자재관리 화면이 현재 가입 코드를 미리 채워 보여주기 위한 읽기.
export async function getCurrentAccessCode() {
  const res = await getCurrentAccessCodeFn();
  return res.data.code;
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
// can never happen again.
//
// 2단계부터는 익명 로그인이 없어서 readyAuth가 "세션 없음"(null)으로도
// 끝날 수 있다 — 재방문 기기는 이전 로그인 때 받은 커스텀 토큰 세션을
// Firebase가 알아서 복원해주니 보통 거의 즉시 끝나지만, 혹시라도 복원이
// 막혀 영원히 안 끝나는 경우를 대비해 8초 타임아웃을 둔다.
export async function requireAccount(expectedRole) {
  const cached = getAccount();
  if (!cached || !cached.phone) {
    location.replace("index.html");
    return null;
  }
  const user = await Promise.race([
    readyAuth,
    new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
  ]);
  if (!user) {
    // 세션이 복원 안 됨(기기 데이터 삭제, 토큰 만료 등) — 다시 로그인하게 한다.
    clearAccount();
    location.replace("index.html");
    return null;
  }
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
  // 이제 로그인 세션 자체가 storeId/role 권한을 담고 있어서(예전 익명
  // 세션과 달리), 매장 공용 기기에서 로그아웃 후에도 세션이 남아있으면
  // 다음 사람이 그 권한을 그대로 이어받는 실제 노출 위험이 된다.
  await signOut(auth).catch(() => {});
  location.href = "index.html";
}

export { normalizePhone };
