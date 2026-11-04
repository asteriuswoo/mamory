import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  limit,
  where,
  arrayUnion,
  arrayRemove,
  runTransaction,
  writeBatch,
  increment,
  enableIndexedDbPersistence,
  disableNetwork,
  enableNetwork,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInWithCustomToken,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getMessaging, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig, STORE_NAME, QUICK_ORDER_LINKS } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
// 지정 안 하면 기본값(us-central1)으로 가서 실제 함수가 배포된
// asia-northeast3와 안 맞아 전부 404난다 — 반드시 명시해야 한다.
const functions = getFunctions(app, "asia-northeast3");
export { httpsCallable, signInWithCustomToken, signOut };
export function callable(name) {
  return httpsCallable(functions, name);
}
// 2026-10-12 밤: Firestore 연결 방식(롱폴링 강제)과 Auth 초기화 방식(iframe
// 회피, IndexedDB persistence)을 이것저것 바꿔가며 모바일 연결 문제를
// 쫓아봤는데, 결과가 그때그때 달라서(됐다 안 됐다) 오히려 더 불안정해진
// 것으로 보인다 — 원래 몇 주간 문제없이 쓰던 기본 설정(getFirestore/
// getAuth)으로 되돌린다. 자세한 경위는 TROUBLESHOOTING.md 참고.
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export { ref, uploadBytes, getDownloadURL };

// 2026-10-12 밤: enableIndexedDbPersistence()가 "누가 대표 탭인지" 추적하려고
// localStorage에 firestore_zombie_... 흔적을 남기는데, 홈화면에 설치한
// standalone 앱을 완전 종료(강제 종료라 정리할 틈이 없음)했다 재실행하는
// 걸 반복하면 그 흔적이 안 지워지고 계속 쌓이는 게 실제로 확인됐다 — 그
// 흔적이 쌓인 채로 다음 실행의 "대표 탭 선정"이 막히면서 Firestore 요청이
// 네트워크 시도조차 안 하고 영원히 멈추는 것으로 보인다. 이 앱은 상시
// 연결 상태로 쓰는 용도라 오프라인 캐시가 꼭 필요하지 않아서, 이 기능
// 자체를 끈다 — "흔적이 쌓인다"는 문제의 근본 원인 자체를 없앤다.
// enableIndexedDbPersistence(db).catch(() => {});

// 모바일 브라우저는 앱이 한참 백그라운드에 있으면 JS 타이머/네트워크를
// 통째로 멈춰뒀다가 돌아왔을 때 Firestore의 실시간 연결(onSnapshot)을 제대로
// 되살리지 못하는 경우가 있다 — 화면엔 기본값/빈 목록만 보이고, 새로고침을
// 몇 번 하거나 앱을 껐다 켜야만 다시 정상으로 돌아오던 문제가 이것.
// 오래(1분+) 숨겨져 있다가 다시 보이면 네트워크를 껐다 켜서 이미 떠있는
// 모든 리스너가 서버와 새로 동기화하도록 강제한다.
//
// visibilitychange 하나만 믿고 "숨겨진 시작 시점"을 거기서 찍었었는데,
// 홈화면에 설치한 standalone 앱(사파리 탭이 아니라)은 백그라운드로 갈 때
// 이 이벤트가 안 오는 경우가 실제로 있었다 — 그러면 "얼마나 오래
// 숨어있었는지" 자체를 영영 모르게 되어 재연결이 한 번도 안 걸렸다.
// 그래서 숨김 시작을 이벤트에 의존하지 않고, 몇 초마다 찍히는 하트비트로
// 판단한다: 탭/앱이 중단되면 setInterval도 같이 멈추니, 다시 돌아왔을 때
// (visibilitychange든 pageshow든 focus든 뭐가 됐든 먼저 오는 신호로) 마지막
// 하트비트와 지금 사이의 간격만 재면 실제로 얼마나 오래 멈춰있었는지 정확히
// 나온다.
let lastActiveMs = Date.now();
setInterval(() => { lastActiveMs = Date.now(); }, 5000);

function reconnectIfWasSuspendedLong() {
  const gap = Date.now() - lastActiveMs;
  lastActiveMs = Date.now();
  if (gap > 60 * 1000) {
    disableNetwork(db).then(() => enableNetwork(db)).catch(() => {});
  }
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) reconnectIfWasSuspendedLong();
});
window.addEventListener("pageshow", reconnectIfWasSuspendedLong);
window.addEventListener("focus", reconnectIfWasSuspendedLong);

// Web Push isn't available everywhere (notably most of iOS Safari unless the
// PWA is installed on 16.4+), so callers must await messagingReady before
// touching `messaging` — it stays null on unsupported browsers.
export let messaging = null;
export const messagingReady = isSupported()
  .then((supported) => {
    if (supported) messaging = getMessaging(app);
    return supported;
  })
  .catch(() => false);

export { STORE_NAME, QUICK_ORDER_LINKS };

// 2단계(로그인 구조 전환): 더 이상 익명 로그인으로 아무 세션이나 만들지
// 않는다 — 로그인/가입 시 서버(Cloud Functions)가 PIN을 직접 검증하고
// 발급해주는 커스텀 토큰으로만 세션이 생긴다. onAuthStateChanged의 첫
// 콜백이 "지금 복원 가능한 세션이 있는지"의 최종 답이라, 그 한 번만 받고
// 바로 resolve한다(세션이 없으면 null) — 재방문 기기는 Firebase가 그
// 전에 로그인했던 커스텀 토큰 세션을 알아서 복원해주므로 보통 거의 즉시
// 끝난다. 완전히 새 기기(세션 없음)는 null로 resolve되고, 그 경우
// requireAccount()가 로그인 화면으로 돌려보낸다.
export const readyAuth = new Promise((resolve) => {
  const unsub = onAuthStateChanged(auth, (user) => {
    unsub();
    resolve(user);
  });
});

export {
  collection,
  collectionGroup,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  query,
  orderBy,
  limit,
  where,
  arrayUnion,
  arrayRemove,
  runTransaction,
  writeBatch,
  increment,
};
