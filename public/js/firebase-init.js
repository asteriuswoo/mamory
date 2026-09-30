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
  where,
  arrayUnion,
  arrayRemove,
  runTransaction,
  increment,
  enableIndexedDbPersistence,
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
  where,
  arrayUnion,
  arrayRemove,
  runTransaction,
  increment,
};
