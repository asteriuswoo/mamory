// Shared profile-photo module used by every page (staff/owner/admin/share) —
// keeps a single live map of phone -> {name, avatarUrl} so a photo change
// shows up everywhere a name is rendered, and centralizes the upload flow so
// there's exactly one place a user can set their own picture (the header).
import { db, doc, updateDoc, collection, onSnapshot, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { toast, escapeHtml, resizeImageFile } from "./util.js";

let accountsMap = {};
const listeners = [];
let started = false;

function ensureAccountsWatched() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, "accounts"), (snap) => {
    const next = {};
    snap.docs.forEach((d) => { next[d.id] = d.data(); });
    accountsMap = next;
    listeners.forEach((cb) => cb());
  });
}

// Notifies `cb` immediately and again every time any account's profile
// data changes, so callers can just re-render their own markup each time.
// Returns an unsubscribe function — callers that re-wire against a fresh DOM
// element on the same page (e.g. app-shell.js swapping views) should call it
// before re-registering, or the old callback keeps firing against a detached
// element forever.
export function watchAccounts(cb) {
  ensureAccountsWatched();
  listeners.push(cb);
  cb();
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

function initialOf(name) {
  return (name || "?").trim().charAt(0) || "?";
}

export function avatarHtml(phone, fallbackName, size) {
  ensureAccountsWatched();
  const acc = accountsMap[phone];
  const name = (acc && acc.name) || fallbackName || "";
  const url = acc && acc.avatarUrl;
  const dim = size || 32;
  if (url) {
    return `<img src="${url}" class="avatar-circle" style="width:${dim}px; height:${dim}px;" alt="${escapeHtml(name)}" />`;
  }
  return `<div class="avatar-circle avatar-fallback" style="width:${dim}px; height:${dim}px; font-size:${Math.round(dim * 0.4)}px;">${escapeHtml(initialOf(name))}</div>`;
}

export async function uploadAvatar(phone, file) {
  if (!file) return;
  toast("프로필 사진 업로드 중...");
  try {
    const blob = await resizeImageFile(file, 400, 0.85);
    // Fixed path per phone (not timestamped) — a new photo replaces the old
    // one instead of piling up in Storage.
    const fileRef = ref(storage, `avatars/${phone}.jpg`);
    await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
    const url = await getDownloadURL(fileRef);
    await updateDoc(doc(db, "accounts", phone), { avatarUrl: url });
    toast("프로필 사진을 설정했어요");
  } catch (e) {
    console.error(e);
    toast("프로필 사진 업로드에 실패했어요");
  }
}

// Renders "avatar + (이름님 / 역할 캡션)" inside `el` (the page header's
// #accountName) and makes the avatar itself the click target for changing
// the SIGNED-IN account's own photo. This is the one place a user sets
// their picture — everywhere else just displays avatarHtml() read-only.
// `roleLabel` (e.g. "사장님 계정"/"직원 계정") renders directly under the
// name rather than under the avatar, so it lines up with the name column.
export function wireAccountHeaderAvatar(el, account, roleLabel) {
  el.classList.add("account-header-row");
  return watchAccounts(() => {
    el.innerHTML = `
      ${avatarHtml(account.phone, account.name, 44)}
      <div>
        <div class="account-header-name">${escapeHtml(account.name)}님</div>
        ${roleLabel ? `<div class="account-header-role">${escapeHtml(roleLabel)}</div>` : ""}
      </div>
      <input type="file" accept="image/*" class="header-avatar-input" style="display:none;" />
    `;
    const avatarEl = el.querySelector(".avatar-circle");
    const input = el.querySelector(".header-avatar-input");
    avatarEl.classList.add("account-header-avatar");
    avatarEl.title = "탭해서 프로필 사진 변경";
    avatarEl.addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => uploadAvatar(account.phone, e.target.files[0]));
  });
}
