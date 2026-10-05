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
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getMessaging, isSupported } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig, STORE_NAME, QUICK_ORDER_LINKS } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);
export { ref, uploadBytes, getDownloadURL };

// Caches Firestore reads in IndexedDB so a fresh PWA launch (e.g. from
// tapping a push notification) can paint cached data immediately instead of
// waiting on the network round-trip, then updates live once the real
// snapshot arrives — this is the main thing making cold opens feel slow.
// Fails silently in multi-tab sessions or unsupported browsers, where the
// app just falls back to network-only like before.
enableIndexedDbPersistence(db).catch(() => {});

// 모바일 브라우저는 앱이 한참 백그라운드에 있으면 JS 타이머/네트워크를
// 통째로 멈춰뒀다가 돌아왔을 때 Firestore의 실시간 연결(onSnapshot)을 제대로
// 되살리지 못하는 경우가 있다 — 화면엔 기본값/빈 목록만 보이고, 새로고침을
// 몇 번 하거나 앱을 껐다 켜야만 다시 정상으로 돌아오던 문제가 이것.
// 오래(1분+) 숨겨져 있다가 다시 보이면 네트워크를 껐다 켜서 이미 떠있는
// 모든 리스너가 서버와 새로 동기화하도록 강제한다.
let hiddenSinceMs = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenSinceMs = Date.now();
    return;
  }
  const wasHiddenLong = hiddenSinceMs && Date.now() - hiddenSinceMs > 60 * 1000;
  hiddenSinceMs = null;
  if (wasHiddenLong) {
    disableNetwork(db).then(() => enableNetwork(db)).catch(() => {});
  }
});

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

export const readyAuth = new Promise((resolve, reject) => {
  onAuthStateChanged(auth, (user) => {
    if (user) resolve(user);
  });
  signInAnonymously(auth).catch(reject);
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
