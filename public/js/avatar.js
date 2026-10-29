// Shared profile-photo module used by every page (staff/owner/admin/share) —
// keeps a single live map of phone -> {name, avatarUrl} so a photo change
// shows up everywhere a name is rendered, and centralizes the upload flow so
// there's exactly one place a user can set their own picture (the header).
import { db, doc, updateDoc, collection, query, where, onSnapshot, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { toast, escapeHtml, resizeImageFile, showActionSheet, openImageLightbox } from "./util.js";

let accountsMap = {};
const listeners = [];
let started = false;
let myStoreId = null;

// 로그인 직후(app-shell.js/staff.js) 계정이 확인되는 시점에 한 번 호출해서
// storeId를 알려준다 — 이게 없으면 전체 매장 계정을 다 긁어오게 돼서
// (다른 매장 정보 누출), 새 firestore.rules에서는 쿼리 자체가 막힌다.
export function setAccountsStoreId(storeId) {
  myStoreId = storeId;
  ensureAccountsWatched();
}

function ensureAccountsWatched() {
  if (started || !myStoreId) return;
  started = true;
  onSnapshot(query(collection(db, "accounts"), where("storeId", "==", myStoreId)), (snap) => {
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

// @멘션 자동완성처럼 "전체 계정 목록"이 필요한 곳에서 쓴다 — ensureAccountsWatched()가
// 아직 안 돌았으면(=아무도 watchAccounts를 호출한 적 없으면) 시작시켜 둔다.
export function allAccounts() {
  ensureAccountsWatched();
  return Object.entries(accountsMap).map(([phone, data]) => ({ phone, name: data.name || "" }));
}

// allAccounts()는 멘션 자동완성용이라 {phone, name}만 주는데, 급여관리
// N배지처럼 role/paydayOfMonth 같은 다른 필드가 필요한 곳도 있다 — 이미 떠
// 있는 계정 실시간 캐시를 그대로 재사용해서 별도 리스너 없이 전체 필드를
// 돌려준다.
export function allAccountsFull() {
  ensureAccountsWatched();
  return Object.entries(accountsMap).map(([phone, data]) => ({ phone, ...data }));
}

function initialOf(name) {
  return (name || "?").trim().charAt(0) || "?";
}

// Tapping any *other* rendered avatar photo (share board posts, item rows,
// admin lists, etc.) opens an in-page enlarged view. The signed-in user's own
// header avatar is excluded — it already opens the change-photo action sheet
// via wireAccountHeaderAvatar below, and stacking a second click behavior on
// top of it would just be confusing.
let lightboxWired = false;
function ensureLightboxWired() {
  if (lightboxWired) return;
  lightboxWired = true;
  document.addEventListener("click", (e) => {
    const img = e.target.closest("img.avatar-circle");
    if (!img || img.closest(".account-header-avatar")) return;
    openImageLightbox(img.src, img.alt);
  });
}
ensureLightboxWired();

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
    // 28~32px짜리 작은 동그란 썸네일로만 쓰일 거라 생각해서 400px로
    // 줄였었는데, 탭하면 뜨는 확대 보기(라이트박스)도 이 똑같은 파일을
    // 그대로 키워서 보여주는 거라 흐릿하게 보였다 — 확대해도 선명하게
    // 보이도록 더 크게 저장한다.
    const blob = await resizeImageFile(file, 1000, 0.85);
    // Fixed path per phone (not timestamped) — a new photo replaces the old
    // one instead of piling up in Storage.
    const fileRef = ref(storage, `avatars/${phone}.jpg`);
    // Without an explicit cacheControl, Storage defaults to barely
    // cacheable — every avatarHtml() render (share board, admin list, item
    // rows) was re-downloading the same photo from scratch. An hour is
    // short enough that changing your photo still shows up promptly.
    await uploadBytes(fileRef, blob, { contentType: "image/jpeg", cacheControl: "public, max-age=3600" });
    const url = await getDownloadURL(fileRef);
    await updateDoc(doc(db, "accounts", phone), { avatarUrl: url });
    toast("프로필 사진을 설정했어요");
  } catch (e) {
    console.error(e);
    toast("프로필 사진 업로드에 실패했어요");
  }
}

// Clears a custom photo, reverting the avatar back to the name-initial
// fallback (avatarHtml() already treats a falsy avatarUrl as "no photo").
export async function resetAvatarToDefault(phone) {
  await updateDoc(doc(db, "accounts", phone), { avatarUrl: "" });
  toast("기본 이미지로 변경했어요");
}

async function editMyName(phone, currentName) {
  const next = (window.prompt("이름을 입력하세요", currentName) || "").trim();
  if (!next || next === currentName) return;
  await updateDoc(doc(db, "accounts", phone), { name: next });
  toast("이름을 변경했어요");
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
    // accountsMap은 가입할 때 성까지 붙여 "김진우"처럼 풀네임으로 입력한
    // 사람도 나중에 다른 사람들처럼 "진우"로 직접 고칠 수 있게, 실시간
    // 캐시에서 이름을 읽는다 — account.name(마운트 시점에 캡처된 값)만
    // 쓰면 방금 수정한 이름이 새로고침 전까지 안 보인다.
    const liveName = (accountsMap[account.phone] && accountsMap[account.phone].name) || account.name;
    el.innerHTML = `
      ${avatarHtml(account.phone, account.name, 44)}
      <div>
        <div class="account-header-name">
          ${escapeHtml(liveName)}님
          <button type="button" class="name-edit-btn" aria-label="이름 수정">✏️</button>
        </div>
        ${roleLabel ? `<div class="account-header-role">${escapeHtml(roleLabel)}</div>` : ""}
      </div>
      <input type="file" accept="image/*" capture="environment" class="header-avatar-camera-input" style="display:none;" />
      <input type="file" accept="image/*" class="header-avatar-gallery-input" style="display:none;" />
    `;
    const avatarEl = el.querySelector(".avatar-circle");
    const cameraInput = el.querySelector(".header-avatar-camera-input");
    const galleryInput = el.querySelector(".header-avatar-gallery-input");
    el.querySelector(".name-edit-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      editMyName(account.phone, liveName);
    });
    avatarEl.classList.add("account-header-avatar");
    avatarEl.title = "탭해서 프로필 사진 변경";
    avatarEl.addEventListener("click", async () => {
      // Two explicit options (camera / gallery) rather than handing the user
      // the browser's generic file picker, which also offers a "Choose File"
      // (Files app) option we don't want here.
      const choice = await showActionSheet([
        { label: "📷 사진 찍기", onClick: () => cameraInput.click() },
        { label: "🖼️ 갤러리에서 선택", onClick: () => galleryInput.click() },
        { label: "기본 이미지로 변경하기", danger: true },
      ]);
      if (choice === 2) resetAvatarToDefault(account.phone);
    });
    cameraInput.addEventListener("change", (e) => uploadAvatar(account.phone, e.target.files[0]));
    galleryInput.addEventListener("change", (e) => uploadAvatar(account.phone, e.target.files[0]));
  });
}
