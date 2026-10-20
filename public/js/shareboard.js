// 공유하기 (품절 공유 / 공유해요) — 직원 화면(staff.js)과 사장님 화면(share.js)에서
// 공통으로 쓰는 렌더링/데이터 모듈. mountShareBoard(el, account)로 붙여 쓴다.
import { db, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, getDocs, query, orderBy, serverTimestamp, arrayUnion, arrayRemove, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, dateStrOf, formatDateLabel, formatTimeLabel, formatTimestampLabel, toast, escapeHtml, resizeImageFile, dayAccentClass, openImageLightbox, MULTIPLE_FILE_ATTR } from "./util.js";
import { avatarHtml, watchAccounts, allAccounts } from "./avatar.js";

const date = todayStr();
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));
const carryoverDates = Array.from({ length: 4 }, (_, i) => dateStrDaysAgo(i));

// 품절공유/공유해요/레시피를 한 화면에 세로로 다 쌓아두면 댓글이 많이 달린
// 쪽이 길어질수록 다른 섹션이 점점 아래로 밀려서 찾기 어려워진다 — 세그먼트
// 탭으로 나눠서 한 번에 한 섹션만 보여준다. 새로고침해도 보던 탭 그대로
// 떠야 하니 sessionStorage에 남겨두고 시작할 때 복원한다.
const SHARE_TAB_KEY = "mamory_shareTab";
function loadShareTab() {
  try {
    const saved = sessionStorage.getItem(SHARE_TAB_KEY);
    return saved === "soldout" || saved === "note" || saved === "recipe" ? saved : "soldout";
  } catch (e) {
    return "soldout";
  }
}
function saveShareTab() {
  try {
    sessionStorage.setItem(SHARE_TAB_KEY, shareTab);
  } catch (e) {
    // sessionStorage 불가 환경이면 그냥 이번 로드는 기본 탭으로 넘어간다.
  }
}
let shareTab = loadShareTab(); // "soldout" | "note" | "recipe"

// 알림을 눌러 들어왔을 때(functions/index.js가 링크에 실어 보낸 ?stab=…)
// 저장된 탭 대신 그 알림이 가리키는 탭으로 바로 열리게 한다 — mountShareBoard
// 호출 전에 한 번만 불러 쓴다(staff.js/share.js).
export function setInitialShareTab(tab) {
  if (tab === "soldout" || tab === "note" || tab === "recipe") {
    shareTab = tab;
    saveShareTab();
  }
}

// 탭마다 "내가 마지막으로 그 탭을 본 시각" 이후 새 글/답글/레시피가
// 올라왔으면 N배지를 띄운다 — 기기(localStorage)에 계정별로 저장해서
// 새로고침해도 유지된다. 처음 설치하는 순간엔 과거 글들이 전부 "새 글"로
// 보이면 안 되니, 저장된 값이 없을 때는 지금 시각을 기준으로 삼는다.
const TAB_SEEN_KEY = "mamory_shareTabSeenAt";
let tabSeenAt = null;
// tab -> 이번에 그 탭에 들어와서 보기 시작한 시점에 얼려둔 tabSeenAt 값.
// 개별 답글의 N배지 판단 전용(아래 isReplyNewToMe) — render()마다 계속
// 갱신되는 tabSeenAt 자체를 기준으로 삼으면 비교 대상이 매번 "방금"이
// 돼버려서 절대 N이 안 뜬다.
let tabViewStartedAt = {};

function loadTabSeen() {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_SEEN_KEY) || "{}");
    return all[account.phone] || null;
  } catch (e) {
    return null;
  }
}

function saveTabSeen() {
  try {
    const all = JSON.parse(localStorage.getItem(TAB_SEEN_KEY) || "{}");
    all[account.phone] = tabSeenAt;
    localStorage.setItem(TAB_SEEN_KEY, JSON.stringify(all));
  } catch (e) {
    // localStorage 불가 환경이면 그냥 이번 세션만 배지가 덜 정확한 걸로 넘어간다.
  }
}

function ensureTabSeenInit() {
  if (tabSeenAt) return;
  tabSeenAt = loadTabSeen() || { soldout: Date.now(), note: Date.now(), recipe: Date.now() };
  saveTabSeen();
}

// createdAt은 Firestore Timestamp(게시물)일 수도, 그냥 ms 숫자(답글)일 수도
// 있다 — 서버 확정 전 낙관적 쓰기는 tsMillis()가 Infinity를 주는데, 그건
// "지금 막 생겼다"는 뜻이라 N배지 판단에선 오히려 적절하다(항상 더 최근으로 침).
function activityMs(ts) {
  if (typeof ts === "number") return ts;
  return tsMillis(ts);
}

// 날짜 칩 빨간 점(chipUnseen) 판단 — seenBy만 보면 "새 글"만 잡히고, 이미
// 본 글에 나중에 달린 "새 답글"은 못 잡는다(seenBy는 글 하나당 값이라
// 답글이 달려도 안 바뀐다). 그래서 오늘(사장님이 어제 글에 답글 다는 것처럼)
// 안 보던 날짜에 답글만 새로 달려도 그 날짜 밑에 점이 떠야 한다 — note
// 탭을 마지막으로 본 시각(tabSeenAt.note) 이후에 달린, 내가 안 쓴 답글이
// 있으면 그 글도 "안 본 것"으로 친다.
function itemHasUnseenActivity(data, myPhone) {
  if (!(data.seenBy || []).includes(myPhone)) return true;
  if (data.type === "note") {
    ensureTabSeenInit();
    const since = tabSeenAt.note || 0;
    return (data.replies || []).some((r) => r.staffPhone !== myPhone && activityMs(r.createdAt) > since);
  }
  return false;
}

function tabActivityMs(tab) {
  let max = 0;
  if (tab === "soldout") {
    shareTodayItems.filter((it) => it.type === "soldout").forEach((it) => {
      max = Math.max(max, activityMs(it.createdAt));
    });
  } else if (tab === "note") {
    shareTodayItems.filter((it) => it.type === "note").forEach((it) => {
      max = Math.max(max, activityMs(it.createdAt));
      (it.replies || []).forEach((r) => { max = Math.max(max, activityMs(r.createdAt)); });
    });
  } else if (tab === "recipe") {
    recipeList.forEach((r) => { max = Math.max(max, activityMs(r.createdAt)); });
  }
  return max;
}

function tabHasUnseen(tab) {
  if (tab === shareTab) return false; // 지금 보고 있는 탭은 당연히 안 띄운다
  ensureTabSeenInit();
  return tabActivityMs(tab) > (tabSeenAt[tab] || 0);
}

function tabNBadgeHtml(tab) {
  return tabHasUnseen(tab) ? `<span class="tab-n-badge">N</span>` : "";
}

// 첨부 사진을 새 탭으로 열지 않고 그 자리에서 확대해서 보여준다 — 게시글에
// 붙은 사진, 작성 중인 미리보기 사진 둘 다 대상.
let photoLightboxWired = false;
function ensurePhotoLightboxWired() {
  if (photoLightboxWired) return;
  photoLightboxWired = true;
  document.addEventListener("click", (e) => {
    const img = e.target.closest("img.share-photo-trigger");
    if (!img) return;
    // 같은 사진묶음(게시글 본문/답글/레시피 등 .receipt-photo-row 하나) 안의
    // 다른 사진들도 같이 모아서 넘겨주면, 라이트박스 안에서 닫았다 다시
    // 여는 것 없이 옆으로 스와이프해서 묶음 전체를 볼 수 있다.
    const group = Array.from(img.closest(".receipt-photo-row")?.querySelectorAll("img.share-photo-trigger") || [img]);
    const urls = group.map((el) => ({ src: el.src, alt: el.alt }));
    const startIndex = group.indexOf(img);
    openImageLightbox(urls, startIndex);
  });
}
ensurePhotoLightboxWired();

function dowLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return { dow: days[new Date(y, m - 1, d).getDay()], dnum: d };
}

function tsMillis(ts) {
  if (!ts) return Infinity; // optimistic write not yet confirmed by the server — sorts last for now
  return typeof ts.toDate === "function" ? ts.toDate().getTime() : ts.seconds * 1000;
}

function sortByTime(list) {
  return [...list].sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt));
}

const REACTIONS = [
  { key: "heart", emoji: "❤️" },
  { key: "sad", emoji: "😢" },
  { key: "awesome", emoji: "👏" },
];

function reactionRow(it, actionsHtml) {
  return `<div class="reaction-row">
    <div class="reaction-row-emojis">${REACTIONS.map((r) => {
      const list = (it.reactions && it.reactions[r.key]) || [];
      const mine = list.includes(account.phone);
      return `<button class="reaction-btn ${mine ? "active" : ""}" data-react-id="${it.id}" data-react-key="${r.key}">${r.emoji}${list.length > 0 ? ` ${list.length}` : ""}</button>`;
    }).join("")}</div>
    ${actionsHtml || ""}
  </div>`;
}

// Which top-level posts / replies are currently mid-edit — id (or
// "itemId:replyIdx" for replies) -> draft text, mirroring openReplyFor's
// pattern of tracking UI-only state outside render() so it survives re-renders.
const editingItems = new Map();
const editingReplies = new Map();

function postActionsHtml(it) {
  if (!canDeleteShare(it) || editingItems.has(it.id)) return "";
  return `<div class="post-actions">
    <button class="post-edit-btn" data-share-edit="${it.id}">수정</button>
    <button class="post-delete-btn" data-share-remove="${it.id}">삭제</button>
  </div>`;
}

function postTopRowHtml(it, isToday) {
  if (editingItems.has(it.id)) {
    const val = escapeHtml(editingItems.get(it.id));
    const field = it.type === "note"
      ? `<textarea class="edit-textarea" data-edit-input="${it.id}" rows="5">${val}</textarea>`
      : `<input type="text" class="edit-input" data-edit-input="${it.id}" value="${val}" />`;
    return `
      <div class="post-top-row edit-mode">
        <div class="edit-row">${field}</div>
        <div class="edit-btn-row">
          <button class="edit-cancel-btn" data-edit-cancel="${it.id}">취소</button>
          <button class="edit-save-btn" data-edit-save="${it.id}">저장</button>
        </div>
      </div>`;
  }
  return `
    <div class="post-top-row">
      <div class="name">${isToday && isNewToMe(it) ? `<span class="tag new">N</span>` : isToday && hasUnseenReply(it) ? `<span class="tag new">💬 N</span>` : ""}${it.isNotice ? `<span class="notice-badge">📢 공지</span> ` : ""}${highlightMentions(escapeHtml(it.content))}</div>
      <div class="who">${formatDateLabel(shareDate)}${formatTimeLabel(it.createdAt) ? ` · ${formatTimeLabel(it.createdAt)}` : ""}</div>
    </div>`;
}

// @멘션 자동완성 후보 — 본인은 멘션할 이유가 없으니 빼고, "모두"를 맨 앞에 둔다.
function mentionCandidates() {
  return [{ phone: "all", name: "모두" }, ...allAccounts().filter((a) => a.phone !== account.phone)];
}

// 작성 중인 텍스트에서 "@이름" 패턴을 뽑아 실제 계정과 매칭한다 — 등록 시
// 알림을 누구에게 보낼지 정하는 데 쓴다.
function extractMentions(text) {
  const accounts = allAccounts();
  const phones = new Set();
  let mentionsAll = false;
  const re = /@([^\s@]+)/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] === "모두") { mentionsAll = true; continue; }
    const found = accounts.find((a) => a.name === m[1]);
    if (found) phones.add(found.phone);
  }
  return { mentions: [...phones], mentionsAll };
}

// 이미 escapeHtml을 거친 문자열 위에서만 동작 — "@이름"이 실제 계정 이름과
// 일치할 때만 토글색 글씨로 감싼다(아무 @아무개나 다 색칠하면 오탐이 많다).
function highlightMentions(escapedContent) {
  const names = allAccounts().map((a) => a.name);
  return escapedContent.replace(/@([^\s<]+)/g, (full, name) => {
    if (name === "모두" || names.includes(name)) {
      return `<span class="mention-tag">@${name}</span>`;
    }
    return full;
  });
}

async function saveShareEdit(id, value) {
  const text = (value || "").trim();
  if (!text) {
    toast("내용을 입력해주세요");
    return;
  }
  await updateDoc(doc(db, "shares", shareDate, "items", id), { content: text });
  // Today has a live listener that already reflects this write — patching
  // the local copy too would just be redundant. Past dates have no
  // listener, so they still need the manual patch.
  if (shareDate !== date) {
    const it = shareItems.find((x) => x.id === id);
    if (it) it.content = text;
  }
  editingItems.delete(id);
  render();
  toast("수정했어요");
}

// 좋아요류 반응은 하트/슬픔/최고 중 하나만 고를 수 있다 — 고르면 같은 사람이
// 이전에 눌러둔 다른 반응은 자동으로 지운다.
async function toggleReaction(itemId, key) {
  const it = shareItems.find((x) => x.id === itemId);
  if (!it) return;
  const reactions = it.reactions || {};
  const mine = ((reactions[key] || [])).includes(account.phone);
  const updates = {};
  const newReactions = {};
  for (const r of REACTIONS) {
    const current = reactions[r.key] || [];
    if (r.key === key) {
      updates[`reactions.${key}`] = mine ? arrayRemove(account.phone) : arrayUnion(account.phone);
      newReactions[r.key] = mine ? current.filter((p) => p !== account.phone) : [...current, account.phone];
    } else if (current.includes(account.phone)) {
      updates[`reactions.${r.key}`] = arrayRemove(account.phone);
      newReactions[r.key] = current.filter((p) => p !== account.phone);
    } else {
      newReactions[r.key] = current;
    }
  }
  await updateDoc(doc(db, "shares", shareDate, "items", itemId), updates);
  // Today's list re-renders itself once the live listener catches this write
  // — but a browsed past date has no listener (loadShareDate is a one-time
  // getDocs), so without patching the local copy here, a reaction on an old
  // post never visibly toggles.
  if (shareDate !== date) it.reactions = newReactions;
  render();
}

// Replies live as a plain array on the parent note (not a subcollection) so
// they ride along on the same listener — serverTimestamp() can't be used
// inside an array element, so each reply just stamps a client-side ms clock.
// Which items currently have their reply textbox expanded — starts closed
// for everything so opening the board doesn't show an input under every
// note; a "댓글달기" button reveals it on demand instead.
const openReplyFor = new Set();
// 실시간으로 새 글/반응이 들어올 때마다 render()가 통째로 다시 그리는데,
// 답글 입력창에 value 바인딩이 없으면 그 순간 타이핑 중이던 내용이
// 날아간다 — itemId별로 입력 중인 텍스트를 여기 기억해뒀다가 다시 그릴 때
// 그대로 복원한다.
const replyDrafts = new Map();
// 답글도 본문처럼 @멘션 + 사진첨부를 지원한다 — itemId별로 업로드된(아직
// 전송 전) 사진 URL들과, "@" 입력 중인지 상태를 따로 들고 있는다(답글
// 입력창이 여러 개 동시에 열려 있을 수 있어서 글 하나짜리 상태로는 부족하다).
const replyDraftPhotos = new Map();
const replyMentionState = new Map(); // itemId -> { active, startIndex, query }

function replyPhotosHtml(photoUrls) {
  if (!photoUrls || photoUrls.length === 0) return "";
  return `<div class="receipt-photo-row note-photo-row" style="margin-top:4px;">${photoUrls.map((url) => `<img src="${url}" class="note-photo-thumb share-photo-trigger" alt="답글 사진" style="width:72px; height:72px;" />`).join("")}</div>`;
}

function repliesHtml(it) {
  const replies = it.replies || [];
  let html = "";
  if (replies.length > 0) {
    html += `<div class="reply-list">${replies
      .map((r, idx) => {
        const key = `${it.id}:${idx}`;
        const mine = r.staffPhone === account.phone;
        if (editingReplies.has(key)) {
          return `
          <div class="reply-row">
            ${avatarHtml(r.staffPhone, r.staffName, 18)}
            <div class="reply-body">
              <span class="reply-who">${escapeHtml(r.staffName || "")}님</span>
              <div class="reply-edit-row">
                <textarea class="reply-edit-input" data-reply-edit-input="${key}" rows="4">${escapeHtml(editingReplies.get(key))}</textarea>
                <div class="reply-edit-btn-row">
                  <button class="reply-cancel-btn" data-reply-edit-cancel="${key}">취소</button>
                  <button class="reply-save-btn" data-reply-edit-save="${key}">저장</button>
                </div>
              </div>
            </div>
          </div>`;
        }
        return `
        <div class="reply-row">
          ${avatarHtml(r.staffPhone, r.staffName, 18)}
          <div class="reply-body">
            <span class="reply-who">${isReplyNewToMe(r) ? `<span class="tag new">N</span> ` : ""}${escapeHtml(r.staffName || "")}님</span><span class="reply-content">${highlightMentions(escapeHtml(r.content))}</span>
            ${replyPhotosHtml(r.photoUrls)}
            ${mine ? `<div class="reply-actions"><button class="reply-edit-btn" data-reply-edit="${key}">수정</button><button class="reply-delete-btn" data-reply-delete-item="${it.id}" data-reply-delete-idx="${idx}">삭제</button></div>` : ""}
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }
  if (openReplyFor.has(it.id)) {
    const pendingPhotos = replyDraftPhotos.get(it.id) || [];
    html += `
      <div class="reply-input-row">
        <input type="text" class="reply-input" data-reply-for="${it.id}" placeholder="답글 달기 (@이름으로 멘션)" value="${escapeHtml(replyDrafts.get(it.id) || "")}" />
        <button class="reply-send-btn" data-reply-send="${it.id}">등록</button>
      </div>
      <div class="mention-suggest-box" data-reply-mention-box="${it.id}"></div>
      <div class="photo-attach-row" style="flex-wrap:wrap; margin-top:4px;">
        <input type="file" accept="image/*" data-reply-photo-input="${it.id}" ${MULTIPLE_FILE_ATTR} style="display:none;" />
        ${pendingPhotos.map((url, i) => `
          <div class="photo-preview">
            <img src="${url}" alt="첨부 사진" class="share-photo-trigger" />
            <button class="photo-remove-btn" data-reply-photo-remove="${it.id}" data-reply-photo-remove-idx="${i}">✕</button>
          </div>`).join("")}
        <button class="photo-add-btn" data-reply-photo-add="${it.id}">📷 사진 첨부</button>
      </div>`;
  } else {
    html += `<button class="reply-toggle-btn" data-reply-toggle="${it.id}">댓글달기</button>`;
  }
  return html;
}

async function onReplyPhotosSelected(itemId, files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `사진 ${files.length}장 업로드 중...` : "사진 업로드 중...");
  try {
    const urls = [];
    for (const file of files) {
      const blob = await resizeImageFile(file);
      const path = `notePhotos/${date}/reply_${account.phone}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      urls.push(await getDownloadURL(fileRef));
    }
    replyDraftPhotos.set(itemId, [...(replyDraftPhotos.get(itemId) || []), ...urls]);
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

function renderReplyMentionSuggestions(itemId) {
  const box = rootEl.querySelector(`[data-reply-mention-box="${itemId}"]`);
  if (!box) return;
  const state = replyMentionState.get(itemId);
  if (!state || !state.active) { box.innerHTML = ""; return; }
  const q = state.query.trim();
  const matches = mentionCandidates().filter((a) => !q || a.name.includes(q)).slice(0, 6);
  if (matches.length === 0) { box.innerHTML = ""; return; }
  box.innerHTML = matches.map((a) => `<button type="button" class="mention-suggest-btn" data-reply-mention-name="${escapeHtml(a.name)}">@${escapeHtml(a.name)}</button>`).join("");
  box.querySelectorAll("[data-reply-mention-name]").forEach((el) => {
    el.addEventListener("click", () => insertReplyMention(itemId, el.dataset.replyMentionName));
  });
}

function insertReplyMention(itemId, name) {
  const input = rootEl.querySelector(`.reply-input[data-reply-for="${itemId}"]`);
  if (!input) return;
  const state = replyMentionState.get(itemId) || { startIndex: 0 };
  const current = replyDrafts.get(itemId) || "";
  const cursor = input.selectionStart;
  const before = current.slice(0, state.startIndex);
  const after = current.slice(cursor);
  const newText = `${before}@${name} ${after}`;
  replyDrafts.set(itemId, newText);
  input.value = newText;
  const newCursor = before.length + name.length + 2;
  replyMentionState.set(itemId, { active: false, startIndex: -1, query: "" });
  renderReplyMentionSuggestions(itemId);
  input.focus();
  input.setSelectionRange(newCursor, newCursor);
}

// itemId별로 전송 중인지 추적 — 빠르게 오가는 대화 중 엔터/등록 버튼을
// 연타하면 앞선 요청이 끝나기도 전에 또 addReply가 불려서 같은(혹은 그
// 사이 더 입력된) 내용이 중복 등록될 수 있었다.
const replySending = new Set();

async function addReply(itemId, content, photoUrls) {
  if (replySending.has(itemId)) return;
  const text = (content || "").trim();
  const photos = photoUrls || [];
  if (!text && photos.length === 0) {
    toast("답글 내용을 입력해주세요");
    return;
  }
  replySending.add(itemId);
  try {
    const { mentions, mentionsAll } = extractMentions(text);
    const reply = {
      content: text,
      photoUrls: photos,
      mentions,
      mentionsAll,
      staffName: account.name,
      staffPhone: account.phone,
      createdAt: Date.now(),
    };
    await updateDoc(doc(db, "shares", shareDate, "items", itemId), {
      replies: arrayUnion(reply),
    });
    // Today's live listener already picks this write up on its own —
    // patching the local copy too (unconditionally, as this used to)
    // double-added it, showing the same reply twice until the next reload
    // corrected it. Only past dates (no listener) still need the manual patch.
    if (shareDate !== date) {
      const it = shareItems.find((x) => x.id === itemId);
      if (it) it.replies = [...(it.replies || []), reply];
    }
    replyDrafts.delete(itemId);
    replyDraftPhotos.delete(itemId);
    replyMentionState.delete(itemId);
    // render() silently no-ops while this input still has focus (true for
    // the Enter-key path, since Enter doesn't blur it) — without this, the
    // just-submitted text stayed sitting in the box looking unsent, so
    // staff would retype/resend and the same reply landed multiple times
    // with slightly different content each try.
    const input = rootEl && rootEl.querySelector(`.reply-input[data-reply-for="${itemId}"]`);
    if (input) input.value = "";
    render();
  } finally {
    replySending.delete(itemId);
  }
}

async function saveReplyEdit(key, value) {
  const [itemId, idxStr] = key.split(":");
  const idx = Number(idxStr);
  const it = shareItems.find((x) => x.id === itemId);
  const reply = it && it.replies && it.replies[idx];
  if (!reply) return;
  const text = (value || "").trim();
  if (!text) {
    toast("내용을 입력해주세요");
    return;
  }
  const newReplies = [...it.replies];
  newReplies[idx] = { ...reply, content: text };
  await updateDoc(doc(db, "shares", shareDate, "items", itemId), { replies: newReplies });
  if (shareDate !== date) it.replies = newReplies; // past dates have no live listener to pick this up otherwise
  editingReplies.delete(key);
  render();
  toast("수정했어요");
}

async function deleteReplyAt(itemId, idx) {
  const it = shareItems.find((x) => x.id === itemId);
  const reply = it && it.replies && it.replies[idx];
  if (!reply) return;
  if (reply.staffPhone !== account.phone) {
    toast("본인이 작성한 답글만 삭제할 수 있어요");
    return;
  }
  if (!confirm("답글을 삭제할까요?")) return;
  await updateDoc(doc(db, "shares", shareDate, "items", itemId), {
    replies: arrayRemove(reply),
  });
  if (shareDate !== date) it.replies = it.replies.filter((_, i) => i !== idx); // past dates have no live listener to pick this up otherwise
  render();
}

let rootEl = null;
let account = { name: "", phone: "" };
let started = false;

let shareDate = date;

// 알림이 가리키는 글이 오늘 게 아니라 며칠 전 거면(품절은 해제 전까지
// 계속 이월되니까 특히), 날짜칩도 그 날짜로 같이 옮겨가야 글이 바로
// 보인다 — "최근 7일" 안에 있는 날짜만 인정하고, 범위 밖이면 무시하고
// 오늘 날짜 그대로 둔다(그보다 오래된 글은 날짜칩 자체가 없으므로).
// started는 이미 watchUnseenCount()가 더 일찍 true로 만들어놔서(배지를
// 실시간으로 켜두려고 공유하기 탭을 열기 전부터 호출됨), mountShareBoard
// 쪽에서 "started였나"로는 첫 마운트를 구분 못 한다 — 그래서 따로 플래그를
// 둔다. shareDate는 여기서 바로 바꿔서 날짜칩이 처음부터 맞게 그려지고,
// 실제 데이터는 pendingDateLoad를 통해 mountShareBoard가 rootEl을 가진
// 뒤에 loadShareDate로 불러온다.
let pendingDateLoad = null;
export function setInitialShareDate(d) {
  if (d && recentDates.includes(d)) {
    shareDate = d;
    pendingDateLoad = d;
  }
}

let shareItems = [];
let shareTodayItems = []; // always-live today's items, independent of which day is being browsed
const chipCounts = {};
const chipUnseen = {}; // date -> true if that date has any item this viewer hasn't seen yet
const chipSoldoutItems = {}; // date -> [{id, date, content, resolved}] for that date's 품절 posts

// 아직 해제 처리 안 된(=resolved 아닌) 지난 날짜들의 품절 게시물을 전부 모은다
// — "어제" 하루만 보던 것과 달리, 며칠째 그대로여도 해제될 때까지 계속
// 오늘 체크리스트에 이월된다. 단, 너무 오래된 건 의미가 없으니 최근 4일치까지만
// 이월 대상으로 본다. 오늘 새로 올라온 품절은 아직 대상이 아니다.
function unresolvedCarryoverItems() {
  const out = [];
  carryoverDates.forEach((d) => {
    if (d === date) return;
    (chipSoldoutItems[d] || []).forEach((it) => {
      if (!it.resolved) out.push(it);
    });
  });
  return out;
}
const soldoutResolveChecked = new Set(); // item ids checked in today's "품절 해제" checklist, cleared after 제출
const soldoutResolveTextDraft = new Map(); // item id -> edited text (a bundled post like "A, B, C" often only has some items actually back)

function canDeleteShare(it) {
  // Legacy items with no staffPhone stamped can't be attributed — allow
  // deletion rather than permanently locking them.
  return !it.staffPhone || it.staffPhone === account.phone;
}

function isNewToMe(it) {
  return !(it.seenBy || []).includes(account.phone);
}

// 답글은 seenBy 같은 필드가 없어서(배열 안 항목이라 개별로 추적하기도
// 번거롭다), 탭 N배지에 이미 쓰는 "마지막으로 소통해요 탭을 본 시각"
// (tabSeenAt.note)보다 늦게 달린 답글이면 "아직 안 본 답글"로 본다 — 내가
// 쓴 답글은 당연히 제외.
function isReplyNewToMe(r) {
  if (r.staffPhone === account.phone) return false;
  ensureTabSeenInit();
  const since = "note" in tabViewStartedAt ? tabViewStartedAt.note : (tabSeenAt.note || 0);
  return activityMs(r.createdAt) > since;
}

function hasUnseenReply(it) {
  return (it.replies || []).some((r) => isReplyNewToMe(r));
}

// Opening the tab and looking at an item counts as "checking" it — the N
// badge (and the day-chip's unseen dot) clears itself rather than needing a
// separate dismiss action. Works for any date being browsed, not just today.
function markSeen(items, forDate) {
  items.forEach((it) => {
    if (isNewToMe(it)) {
      updateDoc(doc(db, "shares", forDate, "items", it.id), { seenBy: arrayUnion(account.phone) }).catch(() => {});
    }
  });
}

// 날짜칩으로 특정 날짜를 골라 보는 탭인데, "해제됨"만 그 선택과 무관하게
// 항상 최근 7일 전체를 한꺼번에 보여주면 날짜칩을 고르는 의미가 없다 —
// 그래서 지금 보고 있는 날짜(shareDate)에 "그날 해제된" 것만 추려서 보여준다.
// 원글은 다른 날 올라왔더라도(이월된 품절), 실제로 해제 처리한 날짜가
// shareDate와 같으면 여기 뜬다 — 그래서 원글 날짜 버킷(recentDates) 전체를
// 훑어보되, 걸러내는 기준은 resolvedAt 쪽이다.
function resolvedSoldoutItemsForDate(targetDate) {
  const out = [];
  recentDates.forEach((d) => {
    (chipSoldoutItems[d] || []).forEach((it) => {
      if (it.resolved && resolvedDateOf(it) === targetDate) out.push(it);
    });
  });
  // activityMs()는 resolvedAt이 아예 없는 걸 "방금 막 생긴 낙관적 쓰기"로
  // 보고 Infinity를 줘서 맨 앞으로 보내는데, 여기선 그게 아니라 이 필드가
  // 생기기 전에 해제된 옛 항목이라 "없으면 제일 오래된 것"으로 취급해야
  // 맞다 — 그래서 activityMs를 바로 쓰지 않고 없을 때 0으로 떨어뜨린다.
  const resolvedMs = (it) => (it.resolvedAt ? activityMs(it.resolvedAt) : 0);
  return out.sort((a, b) => resolvedMs(b) - resolvedMs(a));
}

// 해제됨 목록에 보여줄 날짜 — 원글이 "언제 올라왔는지"가 아니라 "언제
// 해제됐는지"를 기준으로 묶어야 한다. resolvedAt이 없는(이 필드가 생기기
// 전에 해제됐던) 옛 항목만 원글 날짜로 대체 표시한다.
function resolvedDateOf(it) {
  return it.resolvedAt ? dateStrOf(it.resolvedAt) : it.date;
}

function soldoutTabHtml(soldoutListAll, isToday) {
  const activeList = soldoutListAll.filter((it) => !it.resolved);
  let html = `
    <div class="category-title section-title-soldout">📦 품절 공유<span class="sub">${activeList.length}건</span></div>
    <div class="card section-soldout">`;

  const carryoverItems = isToday ? unresolvedCarryoverItems() : [];
  if (carryoverItems.length > 0) {
    html += `
      <div class="soldout-resolve-box">
        <div class="soldout-resolve-label">물류가 왔다면 확인 후 해당 메뉴를 체크하고(게시글이 여러 자재를 묶어 올린 거면 실제로 들어온 것만 남기게 문구를 고쳐도 돼요) 제출해주세요😊</div>
        ${carryoverItems.map((it) => `
          <div class="soldout-resolve-item">
            <input type="checkbox" data-soldout-resolve-check="${it.id}" ${soldoutResolveChecked.has(it.id) ? "checked" : ""} />
            <input type="text" class="soldout-resolve-input" data-soldout-resolve-text="${it.id}" value="${escapeHtml(soldoutResolveTextDraft.has(it.id) ? soldoutResolveTextDraft.get(it.id) : it.content)}" />
          </div>`).join("")}
        <button class="btn gold block" id="soldoutResolveSubmitBtn" style="margin-top:8px;">제출</button>
      </div>`;
  }

  if (activeList.length === 0) {
    html += `<div class="empty">공유된 품절 자재가 없어요.</div>`;
  } else {
    for (const it of activeList) {
      html += `
        <div class="item-row">
          <div class="post-head">
            <div class="post-avatar-col">
              ${avatarHtml(it.staffPhone, it.staffName, 36)}
              <div class="post-author-name">${escapeHtml(it.staffName || "")}</div>
            </div>
            ${postTopRowHtml(it, isToday)}
            ${postActionsHtml(it)}
          </div>
        </div>`;
    }
  }
  if (isToday) {
    html += `
      <div style="display:flex; gap:8px; margin-top:12px;">
        <input type="text" id="soldoutInput" list="soldoutMaterialList" placeholder="품절된 자재 이름" style="flex:1;" />
        <datalist id="soldoutMaterialList">${recentMaterialNames.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("")}</datalist>
        <button class="btn gold" id="soldoutAddBtn" style="white-space:nowrap;">공유</button>
      </div>`;
  }
  html += `</div>`;

  const resolved = resolvedSoldoutItemsForDate(shareDate);
  if (resolved.length > 0) {
    html += `
      <div class="category-title section-title-resolved">✅ 해제됨<span class="sub">${resolved.length}건</span></div>
      <div class="card section-resolved">`;
    resolved.forEach((it) => {
      html += `
        <div class="item-row">
          <div class="post-head">
            <div class="post-avatar-col">
              ${avatarHtml(it.resolvedByPhone || it.staffPhone, it.resolvedByName || it.staffName, 36)}
              <div class="post-author-name">${escapeHtml(it.resolvedByName || it.staffName || "")}</div>
            </div>
            <div class="post-top-row">
              <div class="name"><span class="soldout-resolved-highlight">${escapeHtml(it.content)}</span></div>
              <div class="who">${formatTimeLabel(it.createdAt) || ""}</div>
            </div>
          </div>
        </div>`;
    });
    html += `</div>`;
  }
  return html;
}

function noteTabHtml(noteList, isToday) {
  let html = `
    <div class="category-title section-title-note">💬 소통해요<span class="sub">${noteList.length}건</span></div>
    <div class="card section-note">`;
  if (noteList.length === 0) {
    html += `<div class="empty">공유된 특이사항이 없어요.</div>`;
  } else {
    for (const it of noteList) {
      html += `
        <div class="item-row ${it.isNotice ? "post-notice" : ""}">
          <div class="post-head">
            <div class="post-avatar-col">
              ${avatarHtml(it.staffPhone, it.staffName, 36)}
              <div class="post-author-name">${escapeHtml(it.staffName || "")}</div>
            </div>
            ${postTopRowHtml(it, isToday)}
          </div>
          <div class="post-body">
            ${sharePhotoUrlsOf(it).length > 0 ? `
            <div class="receipt-photo-row note-photo-row">
              ${sharePhotoUrlsOf(it).map((url) => `<img src="${url}" class="note-photo-thumb share-photo-trigger" alt="첨부 사진" />`).join("")}
            </div>` : ""}
            ${reactionRow(it, postActionsHtml(it))}
            ${repliesHtml(it)}
          </div>
        </div>`;
    }
  }
  if (isToday) {
    html += `
      <div style="margin-top:12px;">
        <label class="notice-toggle-row">
          <input type="checkbox" id="noteNoticeCheck" ${noteIsNotice ? "checked" : ""} />
          <span>📢 공지로 등록</span>
        </label>
        <textarea id="noteInput" rows="3" placeholder="근무 중이 아닌 직원도 볼 수 있게 특이사항을 남겨주세요 (@이름으로 멘션할 수 있어요)" style="width:100%;">${escapeHtml(noteDraftText)}</textarea>
        <div id="mentionSuggestBox" class="mention-suggest-box"></div>
        <div class="photo-attach-row" style="flex-wrap:wrap;">
          <input type="file" accept="image/*" id="noteImageInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
          ${notePhotoUrls.map((url, i) => `
            <div class="photo-preview">
              <img src="${url}" alt="첨부 사진" class="share-photo-trigger" />
              <button class="photo-remove-btn" data-note-photo-remove="${i}">✕</button>
            </div>`).join("")}
          <button class="photo-add-btn" id="noteImageAddBtn">📷 사진 첨부</button>
        </div>
        <button class="btn gold block" id="noteAddBtn" style="margin-top:8px;">공유하기</button>
      </div>`;
  }
  html += `</div>`;
  return html;
}

// render()는 매번 rootEl.innerHTML을 통째로 새로 그리는데, 이 화면의
// 글쓰기/답글수정/품절해제 입력창들이 전부 그 안에 같이 들어있다 — 그래서
// 다른 사람이 글을 쓰거나 반응을 누르는 등 shares/{date}/items에 어떤
// 변화가 생겨도(이 탭을 보는 모든 사람에게 실시간으로) render()가 돌면서
// 지금 타이핑 중인 입력창 DOM 자체가 통째로 날아갔다 — 모바일에서는 포커스를
// 잃는 순간 키보드도 같이 내려가 버린다. 지금 이 화면의 입력창에 포커스가
// 있는 동안은 다시 그리지 않고, 포커스가 빠지는 순간(focusout, 아래
// mountShareBoard에서 위임) 밀린 렌더를 한 번에 반영한다.
let renderSkippedWhileTyping = false;

function isTypingInShareInput() {
  const active = document.activeElement;
  return !!(rootEl && active && rootEl.contains(active) && (active.tagName === "INPUT" || active.tagName === "TEXTAREA"));
}

function render() {
  if (!rootEl) return;
  if (isTypingInShareInput()) {
    renderSkippedWhileTyping = true;
    return;
  }
  renderSkippedWhileTyping = false;
  const isToday = shareDate === date;
  const soldoutListAll = sortByTime(shareItems.filter((it) => it.type === "soldout"));
  // 최신 글이 바로 눈에 보여야 매번 스크롤을 안 내려도 되니까, 오래된 순
  // 정렬(sortByTime)을 뒤집어서 최신 글이 위로 오게 한다.
  const noteListAll = sortByTime(shareItems.filter((it) => it.type === "note")).reverse();
  const noteList = [...noteListAll.filter((it) => it.isNotice), ...noteListAll.filter((it) => !it.isNotice)];

  markSeen(shareItems, shareDate);

  ensureTabSeenInit();
  // 답글별 N배지(isReplyNewToMe)는 "이번에 들어와서 보기 시작한 시점"이
  // 고정돼 있어야 한다 — tabSeenAt을 render()마다 바로 지금 시각으로
  // 갱신해버리면, 그 값을 기준으로 "새 답글"을 판단하는 이 함수 안에서
  // 조차 이미 "방금"이 돼버려서 N이 뜰 틈이 없다. 그래서 이 탭에 들어온
  // 첫 렌더의 tabSeenAt 값을 tabViewStartedAt에 한 번 얼려두고, 답글 N
  // 판단은 그 얼린 값과 비교한다 — 탭을 벗어났다 다시 들어오면(아래
  // 세그먼트 탭 클릭 핸들러에서) 새로 얼린다.
  if (!(shareTab in tabViewStartedAt)) tabViewStartedAt[shareTab] = tabSeenAt[shareTab] || 0;

  // 지금 보고 있는 탭은 그 순간까지의 활동을 전부 본 걸로 쳐서 seenAt을
  // 계속 최신으로 유지한다 — 다른 탭으로 넘어간 뒤에도 "내가 마지막으로 본
  // 시점"이 정확하게 남아있게. (하단 탭/세그먼트 탭 N배지는 이 값을 그대로 쓴다.)
  tabSeenAt[shareTab] = Date.now();
  saveTabSeen();

  let html = `
    <div class="seg share-tab-seg">
      <button type="button" class="${shareTab === "note" ? "active" : ""}" data-share-tab="note">💬 소통해요${tabNBadgeHtml("note")}</button>
      <button type="button" class="${shareTab === "soldout" ? "active" : ""}" data-share-tab="soldout">📦 품절공유${tabNBadgeHtml("soldout")}</button>
      <button type="button" class="${shareTab === "recipe" ? "active" : ""}" data-share-tab="recipe">📖 메뉴공유${tabNBadgeHtml("recipe")}</button>
    </div>`;

  if (shareTab !== "recipe") {
    html += `
      <div class="card">
        <div class="field" style="margin:0">
          <label>최근 7일</label>
          <div class="day-chip-row" id="shareDayChips"></div>
        </div>
      </div>`;
  }

  if (shareTab === "soldout") html += soldoutTabHtml(soldoutListAll, isToday);
  else if (shareTab === "note") html += noteTabHtml(noteList, isToday);
  else html += recipeTabHtml();

  rootEl.innerHTML = html;
  if (shareTab !== "recipe") wireShareDayChips();

  rootEl.querySelectorAll("[data-share-tab]").forEach((el) => {
    el.addEventListener("click", () => {
      shareTab = el.dataset.shareTab;
      saveShareTab();
      // 이 탭에 "다시" 들어오는 거니, 답글 N배지 기준점(tabViewStartedAt)을
      // 지금 시점으로 새로 얼린다 — 안 지우면 세션 중 그 탭에 처음 들어왔던
      // 순간에 영원히 고정돼서, 이미 다 보고 나갔다 들어와도 배지가 절대
      // 안 사라지는 버그가 생긴다.
      delete tabViewStartedAt[shareTab];
      render();
    });
  });

  if (shareTab === "soldout") wireSoldoutTab();
  else if (shareTab === "note") wireNoteTab();
  else wireRecipeTab();
}

function wireSoldoutTab() {
  const soldoutInput = rootEl.querySelector("#soldoutInput");
  const soldoutAddBtn = rootEl.querySelector("#soldoutAddBtn");
  if (soldoutAddBtn) {
    soldoutAddBtn.addEventListener("click", () => addShareItem("soldout", soldoutInput.value));
    // isComposing guards against IME text (한글 등) firing Enter's keydown
    // twice — once to finalize the composed character, once for real —
    // which would otherwise post the same entry twice.
    soldoutInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) addShareItem("soldout", soldoutInput.value); });
  }
  rootEl.querySelectorAll("[data-soldout-resolve-check]").forEach((el) => {
    el.addEventListener("change", () => {
      const id = el.dataset.soldoutResolveCheck;
      if (el.checked) soldoutResolveChecked.add(id);
      else soldoutResolveChecked.delete(id);
    });
  });
  rootEl.querySelectorAll("[data-soldout-resolve-text]").forEach((el) => {
    el.addEventListener("input", () => {
      soldoutResolveTextDraft.set(el.dataset.soldoutResolveText, el.value);
    });
  });
  const soldoutResolveSubmitBtn = rootEl.querySelector("#soldoutResolveSubmitBtn");
  if (soldoutResolveSubmitBtn) {
    soldoutResolveSubmitBtn.addEventListener("click", async () => {
      const checkedItems = unresolvedCarryoverItems().filter((it) => soldoutResolveChecked.has(it.id));
      if (checkedItems.length === 0) {
        toast("품절 해제한 메뉴를 체크해주세요");
        return;
      }
      // 더 이상 공유해요에 "~품절 해제했습니다" 글을 따로 올리지 않는다 —
      // 원글 자체를 resolved로 바꾸고(문구를 고쳤으면 그 내용도 반영), 품절공유
      // 탭 안의 "해제됨" 구획에서 하이라이트로 보여주는 걸로 충분하다. 해제됨
      // 구획엔 원글 작성자 대신 "해제 처리한 사람"의 프로필을 보여주는 게
      // 맞아서 resolvedBy*도 같이 찍어두고, 표시되는 날짜/시각도 원글이
      // 작성된 때가 아니라 "진짜로 해제 처리한" resolvedAt 기준이어야 해서
      // 그것도 같이 찍는다 — 품절은 며칠 전에 올라왔어도 해제는 오늘 할 수
      // 있으니, 원글 날짜로 보여주면 언제 해제됐는지가 거짓으로 보인다.
      await Promise.all(checkedItems.map((it) => {
        const text = (soldoutResolveTextDraft.has(it.id) ? soldoutResolveTextDraft.get(it.id) : it.content).trim();
        return updateDoc(doc(db, "shares", it.date, "items", it.id), {
          resolved: true,
          content: text || it.content,
          resolvedByPhone: account.phone,
          resolvedByName: account.name,
          resolvedAt: serverTimestamp(),
        });
      }));
      // 로그를 다시 fetch하지 않아도 체크리스트에서 바로 사라지도록 캐시된
      // 항목 자체를 patch — chipSoldoutItems[it.date] 안의 같은 객체를
      // 참조하고 있어서 이렇게만 해도 다음 render()에 반영된다. resolvedAt은
      // serverTimestamp()라 로컬에선 바로 못 쓰니, replies의 클라이언트
      // 타임스탬프 패턴과 같이 지금 시각(ms)으로 대신 채워둔다 — 다음
      // getDocs 때 진짜 서버 값으로 덮어써진다.
      checkedItems.forEach((it) => {
        it.resolved = true;
        it.resolvedByPhone = account.phone;
        it.resolvedByName = account.name;
        it.resolvedAt = Date.now();
        soldoutResolveChecked.delete(it.id);
        soldoutResolveTextDraft.delete(it.id);
      });
      toast("해제 처리했어요");
      render();
    });
  }
  wireCommonPostActions();
}

function wireNoteTab() {
  const noteNoticeCheck = rootEl.querySelector("#noteNoticeCheck");
  if (noteNoticeCheck) {
    // 브라우저가 새로고침 시 체크박스를 (우리 HTML엔 checked 속성이 없는데도)
    // 자기 멋대로 이전 상태로 복원해둘 때가 있다 — 그 상태가 실제 전송될
    // noteIsNotice 값과 어긋나지 않도록, 그릴 때마다 우리가 들고 있는 값으로
    // 강제로 맞춰둔다.
    noteNoticeCheck.checked = noteIsNotice;
    noteNoticeCheck.addEventListener("change", (e) => { noteIsNotice = e.target.checked; });
  }
  const noteInput = rootEl.querySelector("#noteInput");
  if (noteInput) {
    noteInput.addEventListener("input", (e) => {
      noteDraftText = e.target.value;
      const cursor = e.target.selectionStart;
      const before = noteDraftText.slice(0, cursor);
      const atIndex = before.lastIndexOf("@");
      if (atIndex !== -1 && !/\s/.test(before.slice(atIndex + 1))) {
        mentionActive = true;
        mentionStartIndex = atIndex;
        mentionQuery = before.slice(atIndex + 1);
      } else {
        mentionActive = false;
      }
      renderMentionSuggestions();
    });
  }
  const noteImageInput = rootEl.querySelector("#noteImageInput");
  const noteImageAddBtn = rootEl.querySelector("#noteImageAddBtn");
  if (noteImageAddBtn) noteImageAddBtn.addEventListener("click", () => noteImageInput.click());
  if (noteImageInput) {
    noteImageInput.addEventListener("change", (e) => {
      onNotePhotosSelected(Array.from(e.target.files || []));
      e.target.value = "";
    });
  }
  rootEl.querySelectorAll("[data-note-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      notePhotoUrls.splice(Number(el.dataset.notePhotoRemove), 1);
      render();
    });
  });
  const noteAddBtn = rootEl.querySelector("#noteAddBtn");
  if (noteAddBtn) {
    noteAddBtn.addEventListener("click", async () => {
      const text = noteDraftText.trim();
      if (!text) {
        toast("내용을 입력해주세요");
        return;
      }
      const { mentions, mentionsAll } = extractMentions(text);
      await addShareItem("note", text, notePhotoUrls, { isNotice: noteIsNotice, mentions, mentionsAll });
      noteDraftText = "";
      notePhotoUrls = [];
      noteIsNotice = false;
      mentionActive = false;
      render();
    });
  }
  rootEl.querySelectorAll("[data-react-id]").forEach((el) => {
    el.addEventListener("click", () => toggleReaction(el.dataset.reactId, el.dataset.reactKey));
  });
  rootEl.querySelectorAll("[data-reply-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      openReplyFor.add(el.dataset.replyToggle);
      render();
      const input = rootEl.querySelector(`.reply-input[data-reply-for="${el.dataset.replyToggle}"]`);
      if (input) input.focus();
    });
  });
  rootEl.querySelectorAll("[data-reply-send]").forEach((el) => {
    const itemId = el.dataset.replySend;
    const input = rootEl.querySelector(`.reply-input[data-reply-for="${itemId}"]`);
    el.addEventListener("click", () => addReply(itemId, input.value, replyDraftPhotos.get(itemId) || []));
    input.addEventListener("input", (e) => {
      replyDrafts.set(itemId, e.target.value);
      const cursor = e.target.selectionStart;
      const before = e.target.value.slice(0, cursor);
      const atIndex = before.lastIndexOf("@");
      if (atIndex !== -1 && !/\s/.test(before.slice(atIndex + 1))) {
        replyMentionState.set(itemId, { active: true, startIndex: atIndex, query: before.slice(atIndex + 1) });
      } else {
        replyMentionState.set(itemId, { active: false, startIndex: -1, query: "" });
      }
      renderReplyMentionSuggestions(itemId);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) addReply(itemId, input.value, replyDraftPhotos.get(itemId) || []);
    });
  });
  rootEl.querySelectorAll("[data-reply-photo-add]").forEach((el) => {
    const itemId = el.dataset.replyPhotoAdd;
    el.addEventListener("click", () => {
      const input = rootEl.querySelector(`[data-reply-photo-input="${itemId}"]`);
      if (input) input.click();
    });
  });
  rootEl.querySelectorAll("[data-reply-photo-input]").forEach((el) => {
    const itemId = el.dataset.replyPhotoInput;
    el.addEventListener("change", (e) => {
      onReplyPhotosSelected(itemId, Array.from(e.target.files || []));
      e.target.value = "";
    });
  });
  rootEl.querySelectorAll("[data-reply-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      const itemId = el.dataset.replyPhotoRemove;
      const idx = Number(el.dataset.replyPhotoRemoveIdx);
      const arr = replyDraftPhotos.get(itemId) || [];
      arr.splice(idx, 1);
      replyDraftPhotos.set(itemId, arr);
      render();
    });
  });
  rootEl.querySelectorAll("[data-reply-delete-item]").forEach((el) => {
    el.addEventListener("click", () => deleteReplyAt(el.dataset.replyDeleteItem, Number(el.dataset.replyDeleteIdx)));
  });
  rootEl.querySelectorAll("[data-reply-edit]").forEach((el) => {
    el.addEventListener("click", () => {
      const key = el.dataset.replyEdit;
      const [itemId, idxStr] = key.split(":");
      const it = shareItems.find((x) => x.id === itemId);
      const reply = it && it.replies && it.replies[Number(idxStr)];
      if (!reply) return;
      editingReplies.set(key, reply.content);
      render();
      const input = rootEl.querySelector(`[data-reply-edit-input="${key}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  });
  rootEl.querySelectorAll("[data-reply-edit-save]").forEach((el) => {
    const key = el.dataset.replyEditSave;
    const input = rootEl.querySelector(`[data-reply-edit-input="${key}"]`);
    el.addEventListener("click", () => saveReplyEdit(key, input.value));
    // textarea라 Enter는 줄바꿈으로 써야 한다 — 더 이상 Enter로 바로
    // 저장되지 않는다("저장" 버튼을 눌러야 함).
  });
  rootEl.querySelectorAll("[data-reply-edit-cancel]").forEach((el) => {
    el.addEventListener("click", () => {
      editingReplies.delete(el.dataset.replyEditCancel);
      render();
    });
  });
  wireCommonPostActions();
}

// 품절공유/공유해요 둘 다 postActionsHtml(수정/삭제)을 공유하므로, 지금 떠
// 있는 탭에 맞게 한 번만 와이어링한다 — 다른 탭엔 해당 요소가 없으니 그냥
// 매치가 0건일 뿐 해롭지 않다.
function wireCommonPostActions() {
  rootEl.querySelectorAll("[data-share-remove]").forEach((el) => {
    el.addEventListener("click", () => deleteShareItem(el.dataset.shareRemove));
  });
  rootEl.querySelectorAll("[data-share-edit]").forEach((el) => {
    el.addEventListener("click", () => {
      const it = shareItems.find((x) => x.id === el.dataset.shareEdit);
      if (!it) return;
      editingItems.set(it.id, it.content);
      render();
      const input = rootEl.querySelector(`[data-edit-input="${it.id}"]`);
      if (input) {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    });
  });
  rootEl.querySelectorAll("[data-edit-save]").forEach((el) => {
    const id = el.dataset.editSave;
    const input = rootEl.querySelector(`[data-edit-input="${id}"]`);
    el.addEventListener("click", () => saveShareEdit(id, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing && input.tagName !== "TEXTAREA") saveShareEdit(id, input.value);
    });
  });
  rootEl.querySelectorAll("[data-edit-cancel]").forEach((el) => {
    el.addEventListener("click", () => {
      editingItems.delete(el.dataset.editCancel);
      render();
    });
  });
}

function wireShareDayChips() {
  const chipsEl = rootEl.querySelector("#shareDayChips");
  chipsEl.innerHTML = recentDates
    .map((d) => {
      const { dow, dnum } = dowLabel(d);
      const count = chipCounts[d] || 0;
      const active = d === shareDate;
      const unseen = !!chipUnseen[d];
      return `
        <button class="day-chip ${active ? "active" : ""}" data-sdate="${d}">
          <div class="dow">${d === date ? "오늘" : dow}</div>
          <div class="dnum">${dnum}</div>
          <div class="day-chip-underline ${dayAccentClass(d)}"></div>
          <div class="dcount">${count > 0 ? count + "건" : ""}</div>
          <div class="day-chip-dot-row">${unseen ? `<span class="day-chip-dot"></span>` : ""}</div>
        </button>`;
    })
    .join("");
  chipsEl.querySelectorAll("[data-sdate]").forEach((el) => {
    el.addEventListener("click", () => loadShareDate(el.dataset.sdate));
  });
}

async function loadShareDate(targetDate) {
  shareDate = targetDate;
  editingItems.clear();
  editingReplies.clear();
  if (targetDate === date) {
    shareItems = shareTodayItems;
    render();
    return;
  }
  try {
    const snap = await getDocs(collection(db, "shares", targetDate, "items"));
    shareItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    chipCounts[targetDate] = shareItems.length;
    // Selecting a past date's tab is itself the "I've checked this" action —
    // clear its dot right away rather than waiting on the markSeen() writes.
    chipUnseen[targetDate] = false;
  } catch (e) {
    shareItems = [];
  }
  render();
}

function loadAllShareChipCounts() {
  recentDates.forEach((d) => {
    if (d === date) return; // live count already tracked from onSnapshot
    getDocs(collection(db, "shares", d, "items"))
      .then((snap) => {
        chipCounts[d] = snap.size;
        chipUnseen[d] = snap.docs.some((doc) => itemHasUnseenActivity(doc.data(), account.phone));
        const soldoutDocs = snap.docs.filter((doc) => doc.data().type === "soldout");
        chipSoldoutItems[d] = soldoutDocs.map((doc) => ({ id: doc.id, date: d, content: doc.data().content, resolved: !!doc.data().resolved, staffName: doc.data().staffName, staffPhone: doc.data().staffPhone, resolvedByName: doc.data().resolvedByName, resolvedByPhone: doc.data().resolvedByPhone, resolvedAt: doc.data().resolvedAt, createdAt: doc.data().createdAt }));
        // Today's own render depends on every past day's chipSoldoutItems
        // (the carry-forward 품절 해제 checklist), not just the date
        // currently being browsed.
        if (shareDate === d || shareDate === date) render();
        else wireShareDayChipsIfMounted();
      })
      .catch(() => {});
  });
}

// Refresh just the day-chip row (e.g. after a background chip-count/unseen
// fetch resolves) without re-rendering the whole board and losing focus/
// scroll position if the viewer is mid-interaction elsewhere.
function wireShareDayChipsIfMounted() {
  if (rootEl && rootEl.querySelector("#shareDayChips")) wireShareDayChips();
}

async function addShareItem(type, content, photoUrls, options) {
  const text = (content || "").trim();
  if (!text) {
    toast(type === "soldout" ? "품절된 자재 이름을 입력해주세요" : "내용을 입력해주세요");
    return;
  }
  const opts = options || {};
  await addDoc(collection(db, "shares", date, "items"), {
    type,
    content: text,
    photoUrls: photoUrls && photoUrls.length > 0 ? photoUrls : [],
    isNotice: !!opts.isNotice,
    mentions: opts.mentions || [],
    mentionsAll: !!opts.mentionsAll,
    staffName: account.name,
    staffPhone: account.phone,
    seenBy: [account.phone],
    createdAt: serverTimestamp(),
  });
  toast("공유했어요");
}

// 옛 게시글은 photoUrl(단수) 필드 하나였고, 지금은 여러 장을 담는
// photoUrls(배열)로 바뀌었다 — 어느 쪽으로 저장됐든 한 번에 뽑아 쓰기 위한
// 헬퍼. 표시할 땐 항상 이 함수를 거친다.
function sharePhotoUrlsOf(it) {
  if (it.photoUrls && it.photoUrls.length > 0) return it.photoUrls;
  return it.photoUrl ? [it.photoUrl] : [];
}

// Draft state for the "공유해요" composer — kept outside render() so
// re-rendering (e.g. from an unrelated reaction elsewhere) doesn't wipe
// whatever the user is mid-typing or already attached.
let noteDraftText = "";
let notePhotoUrls = [];
let noteIsNotice = false;

// @멘션 자동완성 입력 상태 — "@"를 입력하는 순간부터 커서가 공백을 만날
// 때까지를 "멘션 입력 중"으로 보고, 후보 목록을 textarea 바로 아래에 띄운다.
let mentionActive = false;
let mentionStartIndex = -1;
let mentionQuery = "";

function renderMentionSuggestions() {
  const box = rootEl.querySelector("#mentionSuggestBox");
  if (!box) return;
  if (!mentionActive) { box.innerHTML = ""; return; }
  const q = mentionQuery.trim();
  const matches = mentionCandidates().filter((a) => !q || a.name.includes(q)).slice(0, 6);
  if (matches.length === 0) { box.innerHTML = ""; return; }
  box.innerHTML = matches.map((a) => `<button type="button" class="mention-suggest-btn" data-mention-name="${escapeHtml(a.name)}">@${escapeHtml(a.name)}</button>`).join("");
  box.querySelectorAll("[data-mention-name]").forEach((el) => {
    el.addEventListener("click", () => insertMention(el.dataset.mentionName));
  });
}

function insertMention(name) {
  const input = rootEl.querySelector("#noteInput");
  if (!input) return;
  const cursor = input.selectionStart;
  const before = noteDraftText.slice(0, mentionStartIndex);
  const after = noteDraftText.slice(cursor);
  const newText = `${before}@${name} ${after}`;
  noteDraftText = newText;
  input.value = newText;
  const newCursor = before.length + name.length + 2;
  mentionActive = false;
  renderMentionSuggestions();
  input.focus();
  input.setSelectionRange(newCursor, newCursor);
}

async function onNotePhotosSelected(files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `사진 ${files.length}장 업로드 중...` : "사진 업로드 중...");
  try {
    for (const file of files) {
      const blob = await resizeImageFile(file);
      const path = `notePhotos/${date}/share_${account.phone}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
      const fileRef = ref(storage, path);
      await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
      notePhotoUrls.push(await getDownloadURL(fileRef));
    }
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

async function deleteShareItem(id) {
  const it = shareItems.find((x) => x.id === id);
  if (!it) return;
  if (!canDeleteShare(it)) {
    toast("본인이 작성한 내용만 삭제할 수 있어요");
    return;
  }
  if (!confirm("삭제할까요?")) return;
  await deleteDoc(doc(db, "shares", shareDate, "items", id));
  // past dates have no live listener to pick this up otherwise
  shareItems = shareItems.filter((x) => x.id !== id);
  if (shareDate === date) shareTodayItems = shareTodayItems.filter((x) => x.id !== id);
  render();
  toast("삭제했어요");
}

// 품절 공유 입력창 자동완성용 — 자재선택 화면 검색과 같은 자재명을 써야
// 하니, 최근 발주 이력이 아니라 등록된 자재 목록 전체에서 이름을 끌어온다.
let recentMaterialNames = [];

async function loadRecentMaterialNames() {
  try {
    const snap = await getDocs(collection(db, "materials"));
    const labels = new Set();
    snap.forEach((doc) => {
      const m = doc.data();
      if (!m.name) return;
      // "레몬" 하나로 레몬베이스/레몬밤시럽이 다 걸리는데 datalist 후보엔
      // 자재명만 떠서 뭐가 뭔지 구분이 안 됐다 — 소분류를 이름 뒤에 바로
      // 묶어서 보여주면, 고를 때도 소분류가 같이 보이고 고른 뒤 입력창에도
      // 그대로 남아서 따로 덧붙여 적을 필요가 없다.
      labels.add(m.subCategory ? `${m.name} (${m.subCategory})` : m.name);
    });
    recentMaterialNames = [...labels].sort();
    render();
  } catch (e) {
    // 못 가져와도 품절 공유 자체는 직접 타이핑해서 쓸 수 있으니 조용히 넘어간다.
  }
}

const badgeListeners = [];

function notifyBadgeListeners() {
  badgeListeners.forEach((cb) => cb(getTodayUnseenCount(account.phone)));
}

function ensureStarted() {
  if (started) return;
  started = true;
  loadRecentMaterialNames();
  onSnapshot(collection(db, "shares", date, "items"), (snap) => {
    shareTodayItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    chipCounts[date] = shareTodayItems.length;
    chipUnseen[date] = shareTodayItems.some((it) => itemHasUnseenActivity(it, account.phone));
    if (shareDate === date) shareItems = shareTodayItems;

    render();
    notifyBadgeListeners();
  });
  loadAllShareChipCounts();
}

export function mountShareBoard(el, acc) {
  rootEl = el;
  account = acc;
  // 공유하기 화면에 새로 들어올 때마다(다른 탭 갔다가 돌아온 경우 포함)
  // 답글 N배지 기준점을 전부 새로 얼린다 — 세그먼트 탭 전환 클릭에서만
  // 지워주면, "화면 자체를 나갔다 다시 들어온" 경우엔 여전히 예전 기준점이
  // 남아있어서 이미 본 답글도 계속 N으로 뜨는 문제가 있었다.
  tabViewStartedAt = {};
  // 타이핑 중이라 미뤄둔 render()를, 입력창에서 포커스가 빠지는 순간(제출
  // 버튼을 눌렀든 다른 곳을 탭했든) 바로 따라잡는다. focusout은 버블링되는
  // 이벤트라 rootEl 하나에만 걸어도 그 안의 모든 입력창을 다 잡는다.
  // mountShareBoard는 매번 새로 생긴 rootEl에 대해서만 불리므로(이전
  // rootEl은 그대로 버려짐) 리스너가 중복으로 쌓이지 않는다.
  // setTimeout으로 한 틱 미루는 이유 — "제출" 버튼을 눌러서 포커스가
  // 빠진 경우, focusout이 click보다 먼저 발생한다. 여기서 바로 render()를
  // 돌리면 그 버튼 DOM이 click 이벤트가 도착하기 전에 통째로 바뀐 새
  // 버튼으로 교체돼버려서, 정작 그 탭이 아무 반응 없이 씹힌다 — click이
  // 마저 처리되고 난 다음 틱에 반영해야 한다.
  rootEl.addEventListener("focusout", () => {
    setTimeout(() => { if (renderSkippedWhileTyping) render(); }, 0);
  });
  ensureStarted();
  watchAccounts(render);
  // setInitialShareDate()는 main()이 끝나기 한참 전, rootEl도 아직 없을 때
  // 불려서 shareDate 변수만 미리 바꿔두고 render()는 조용히 no-op된다 —
  // 그 뒤 rootEl이 생긴 지금, pendingDateLoad가 남아있으면 그 날짜 데이터를
  // 실제로 불러온다(단순 재렌더가 아니라 Firestore에서 읽어와야 글이
  // 보인다). 한 번 쓰고 비워서 재렌더마다 중복 호출되지 않는다.
  if (pendingDateLoad) {
    const d = pendingDateLoad;
    pendingDateLoad = null;
    loadShareDate(d);
  }
}

// For pages that only want the "공유하기" nav tab's small unread-count badge
// (오늘 발주 / 자재 관리 nav, or the staff main-screen tile) without mounting
// the full board — e.g. before ever opening the tab.
export function watchUnseenCount(acc, onChange) {
  account = { ...account, ...acc };
  badgeListeners.push(onChange);
  ensureStarted();
  onChange(getTodayUnseenCount(account.phone));
}

export function getTodayShareCount() {
  return shareTodayItems.length;
}

export function getTodayUnseenCount(myPhone) {
  return shareTodayItems.filter((it) => !(it.seenBy || []).includes(myPhone)).length;
}

// 하단 탭(공유하기) N배지 전용 — 탭 안의 세그먼트별 "본 시각"(tabSeenAt)에
// 기대지 않고, 하단 탭 아이콘 자체를 탭하면 그 즉시 사라지는 훨씬 단순한
// 기준으로 둔다. 셋 중 아무 탭에서든 가장 최근 활동 시각이, 마지막으로
// 하단 탭을 눌러서 들어간 시각(markShareNavBadgeSeen)보다 늦으면 켠다.
const NAV_BADGE_SEEN_KEY = "mamory_shareNavBadgeSeenAt";

function loadNavBadgeSeenAt() {
  try {
    const all = JSON.parse(localStorage.getItem(NAV_BADGE_SEEN_KEY) || "{}");
    if (account.phone in all) return all[account.phone];
  } catch (e) {
    // localStorage 불가 환경 — 아래에서 지금 시각으로 새로 깔고 넘어간다.
  }
  // 처음 보는 계정/기기면 지금까지의 활동을 전부 "새 활동"으로 띄우지
  // 않도록 지금 시각을 기준점으로 깔아둔다.
  const now = Date.now();
  saveNavBadgeSeenAt(now);
  return now;
}

function saveNavBadgeSeenAt(ts) {
  try {
    const all = JSON.parse(localStorage.getItem(NAV_BADGE_SEEN_KEY) || "{}");
    all[account.phone] = ts;
    localStorage.setItem(NAV_BADGE_SEEN_KEY, JSON.stringify(all));
  } catch (e) {
    // localStorage 불가 환경이면 그냥 이번 세션만 배지가 덜 정확한 걸로 넘어간다.
  }
}

function latestShareActivityMs() {
  return Math.max(tabActivityMs("soldout"), tabActivityMs("note"), tabActivityMs("recipe"));
}

// 하단 탭(공유하기)을 탭하는 순간 호출 — 그 즉시 배지가 꺼지고, 그 뒤에
// 올라온 활동이 있을 때만 다시 켜진다.
export function markShareNavBadgeSeen() {
  saveNavBadgeSeenAt(Date.now());
}

export function hasUnseenShareActivity(myPhone) {
  return latestShareActivityMs() > loadNavBadgeSeenAt();
}

// ---- 메뉴 레시피 (공유하기 > 레시피 탭) ----
// 날짜별로 나뉘는 품절공유/공유해요와 달리 하루 단위 개념이 없는 카탈로그라,
// 별도의 flat 컬렉션(recipes)에 쌓아두고 등록일 역순으로 보여준다.
let recipeList = [];
let recipeUnsub = null;
let recipeDraftName = "";
let recipeDraftInstructions = "";
let recipeDraftStatus = null; // "new" | "existing" | null(아직 안 고름)
let recipePhotoUrls = [];

// 레시피변경(신메뉴/기존메뉴)과 단종 소식은 완전히 다른 용도라 레시피 탭
// 안에서도 또 한 번 세그먼트 탭으로 나눈다 — 둘 다 같은 recipes 컬렉션에
// status 필드로만 구분해 쌓이지만, 작성 폼과 목록은 서로 다르게 보여준다.
const RECIPE_SUB_TAB_KEY = "mamory_recipeSubTab";
function loadRecipeSubTab() {
  try {
    const saved = sessionStorage.getItem(RECIPE_SUB_TAB_KEY);
    return saved === "change" || saved === "discontinued" ? saved : "change";
  } catch (e) {
    return "change";
  }
}
function saveRecipeSubTab() {
  try {
    sessionStorage.setItem(RECIPE_SUB_TAB_KEY, recipeSubTab);
  } catch (e) {
    // sessionStorage 불가 환경이면 그냥 이번 로드는 기본 탭으로 넘어간다.
  }
}
let recipeSubTab = loadRecipeSubTab(); // "change" | "discontinued"
let discoDraftName = "";
let discoDraftNote = "";
let discoPhotoUrls = [];

// 등록 후에도 틀린 부분을 고칠 수 있어야 해서, 한 번에 하나씩만 수정 모드로
// 들어간다 — editingItems(품절/공유)와 같은 "id -> 수정 중" 패턴.
let editingRecipeId = null;
let editRecipeDraft = { menuName: "", instructions: "", status: null, photoUrls: [] };

function ensureRecipesStarted() {
  if (recipeUnsub) return;
  recipeUnsub = onSnapshot(query(collection(db, "recipes"), orderBy("createdAt", "desc")), (snap) => {
    recipeList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (shareTab === "recipe") render();
  });
}

async function uploadRecipePhotos(files) {
  const urls = [];
  for (const file of files) {
    const blob = await resizeImageFile(file);
    const path = `notePhotos/recipes/${account.phone}_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
    urls.push(await getDownloadURL(fileRef));
  }
  return urls;
}

async function onRecipePhotosSelected(files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `사진 ${files.length}장 업로드 중...` : "사진 업로드 중...");
  try {
    recipePhotoUrls.push(...(await uploadRecipePhotos(files)));
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

async function onEditRecipePhotosSelected(files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `사진 ${files.length}장 업로드 중...` : "사진 업로드 중...");
  try {
    editRecipeDraft.photoUrls.push(...(await uploadRecipePhotos(files)));
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

async function onDiscoPhotosSelected(files) {
  if (!files || files.length === 0) return;
  toast(files.length > 1 ? `사진 ${files.length}장 업로드 중...` : "사진 업로드 중...");
  try {
    discoPhotoUrls.push(...(await uploadRecipePhotos(files)));
    render();
    toast("사진을 첨부했어요");
  } catch (e) {
    console.error(e);
    toast("사진 업로드에 실패했어요");
  }
}

async function submitRecipe() {
  const menuName = recipeDraftName.trim();
  const instructions = recipeDraftInstructions.trim();
  if (!menuName) {
    toast("메뉴 이름을 입력해주세요");
    return;
  }
  if (!instructions) {
    toast("제조법을 입력해주세요");
    return;
  }
  if (!recipeDraftStatus) {
    toast("신메뉴/기존메뉴 상태를 선택해주세요");
    return;
  }
  await addDoc(collection(db, "recipes"), {
    menuName,
    instructions,
    status: recipeDraftStatus,
    photoUrls: recipePhotoUrls,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  recipeDraftName = "";
  recipeDraftInstructions = "";
  recipeDraftStatus = null;
  recipePhotoUrls = [];
  toast("레시피를 등록했어요");
  render();
}

// 단종은 "제조법"이 필요 없는, 메뉴 이름 + (선택) 사유 정도의 짧은 공지라
// 레시피변경과는 작성 폼 자체를 분리했다 — 같은 recipes 컬렉션에
// status:"discontinued"로 쌓여서 단종 탭에서만 걸러 보여준다.
async function submitDiscontinued() {
  const menuName = discoDraftName.trim();
  if (!menuName) {
    toast("메뉴 이름을 입력해주세요");
    return;
  }
  await addDoc(collection(db, "recipes"), {
    menuName,
    instructions: discoDraftNote.trim(),
    status: "discontinued",
    photoUrls: discoPhotoUrls,
    staffName: account.name,
    staffPhone: account.phone,
    createdAt: serverTimestamp(),
  });
  discoDraftName = "";
  discoDraftNote = "";
  discoPhotoUrls = [];
  toast("단종 소식을 공유했어요");
  render();
}

function startEditRecipe(id) {
  const r = recipeList.find((x) => x.id === id);
  if (!r || r.staffPhone !== account.phone) {
    toast("본인이 등록한 레시피만 수정할 수 있어요");
    return;
  }
  editingRecipeId = id;
  editRecipeDraft = {
    menuName: r.menuName,
    instructions: r.instructions,
    status: r.status || null,
    photoUrls: [...(r.photoUrls || [])],
  };
  render();
}

function cancelEditRecipe() {
  editingRecipeId = null;
  render();
}

async function saveEditRecipe() {
  const menuName = editRecipeDraft.menuName.trim();
  const instructions = editRecipeDraft.instructions.trim();
  const isDisco = editRecipeDraft.status === "discontinued";
  if (!menuName) {
    toast("메뉴 이름을 입력해주세요");
    return;
  }
  // 단종 항목은 제조법/상태 선택이 아예 없는 폼이라 그 둘은 검사하지 않는다.
  if (!isDisco && !instructions) {
    toast("제조법을 입력해주세요");
    return;
  }
  if (!isDisco && !editRecipeDraft.status) {
    toast("신메뉴/기존메뉴 상태를 선택해주세요");
    return;
  }
  await updateDoc(doc(db, "recipes", editingRecipeId), {
    menuName,
    instructions,
    status: editRecipeDraft.status,
    photoUrls: editRecipeDraft.photoUrls,
  });
  editingRecipeId = null;
  toast("수정했어요");
  render();
}

async function deleteRecipe(id) {
  const r = recipeList.find((x) => x.id === id);
  if (!r || r.staffPhone !== account.phone) {
    toast("본인이 등록한 레시피만 삭제할 수 있어요");
    return;
  }
  if (!confirm("이 레시피를 삭제할까요?")) return;
  await deleteDoc(doc(db, "recipes", id));
}

function recipeStatusBadgeHtml(status) {
  if (status === "new") return `<span class="recipe-status-badge new">NEW</span>`;
  if (status === "existing") return `<span class="recipe-status-badge existing">기존</span>`;
  if (status === "discontinued") return `<span class="recipe-status-badge discontinued">단종</span>`;
  return "";
}

function recipeStatusRowHtml(selected, dataAttr) {
  return `
    <div class="recipe-status-row">
      <button type="button" class="recipe-status-btn ${selected === "new" ? "active" : ""}" data-${dataAttr}="new">신메뉴</button>
      <button type="button" class="recipe-status-btn ${selected === "existing" ? "active" : ""}" data-${dataAttr}="existing">기존메뉴</button>
    </div>`;
}

function recipeCardHtml(r, idx) {
  if (editingRecipeId === r.id) {
    const isDisco = editRecipeDraft.status === "discontinued";
    return `
      <div class="recipe-card recipe-edit-form ${idx > 0 ? "recipe-card-divider" : ""}">
        <div class="field">
          <label>메뉴 이름</label>
          <input type="text" id="editRecipeNameInput" value="${escapeHtml(editRecipeDraft.menuName)}" />
        </div>
        ${isDisco ? "" : `
        <div class="field">
          <label>메뉴 상태</label>
          ${recipeStatusRowHtml(editRecipeDraft.status, "edit-recipe-status")}
        </div>`}
        <div class="field">
          <label>${isDisco ? "비고 (선택)" : "제조법"}</label>
          <textarea id="editRecipeInstructionsInput" rows="${isDisco ? 2 : 4}" placeholder="${isDisco ? "단종 사유 등 (선택)" : ""}">${escapeHtml(editRecipeDraft.instructions)}</textarea>
        </div>
        <div class="photo-attach-row" style="flex-wrap:wrap;">
          <input type="file" accept="image/*" id="editRecipePhotoInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
          ${editRecipeDraft.photoUrls.map((url, i) => `
            <div class="photo-preview">
              <img src="${url}" alt="첨부 사진" class="share-photo-trigger" />
              <button class="photo-remove-btn" data-edit-recipe-photo-remove="${i}">✕</button>
            </div>`).join("")}
          <button class="photo-add-btn" id="editRecipePhotoAddBtn">📷 사진 첨부</button>
        </div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button type="button" class="btn secondary" id="editRecipeCancelBtn" style="flex:1;">취소</button>
          <button type="button" class="btn gold" id="editRecipeSaveBtn" style="flex:1;">저장</button>
        </div>
      </div>`;
  }
  return `
    <div class="recipe-card ${idx > 0 ? "recipe-card-divider" : ""}">
      <div class="post-head">
        <div class="post-avatar-col">
          ${avatarHtml(r.staffPhone, r.staffName, 32)}
          <div class="post-author-name">${escapeHtml(r.staffName || "")}</div>
        </div>
        <div class="post-top-row">
          <div class="name">${recipeStatusBadgeHtml(r.status)}${escapeHtml(r.menuName)}</div>
          <div class="who">${formatTimestampLabel(r.createdAt)}</div>
        </div>
      </div>
      ${r.instructions ? `<div class="recipe-instructions">${escapeHtml(r.instructions).replace(/\n/g, "<br>")}</div>` : ""}
      ${(r.photoUrls || []).length > 0 ? `
      <div class="receipt-photo-row note-photo-row" style="margin-top:8px;">
        ${r.photoUrls.map((url) => `<img src="${url}" class="note-photo-thumb share-photo-trigger" alt="레시피 사진" />`).join("")}
      </div>` : ""}
      ${r.staffPhone === account.phone ? `
      <div class="post-actions" style="margin-top:6px;">
        <button class="post-edit-btn" data-recipe-edit="${r.id}">수정</button>
        <button class="post-delete-btn" data-recipe-delete="${r.id}">삭제</button>
      </div>` : ""}
    </div>`;
}

function recipeChangeTabHtml() {
  const list = recipeList.filter((r) => r.status !== "discontinued");
  let html = `
    <div class="category-title section-title-recipe">📖 레시피변경<span class="sub">${list.length}건</span></div>
    <div class="card section-recipe">
      <div class="field">
        <label>메뉴 이름</label>
        <input type="text" id="recipeNameInput" placeholder="예: 바닐라 라떼" value="${escapeHtml(recipeDraftName)}" />
      </div>
      <div class="field">
        <label>메뉴 상태</label>
        ${recipeStatusRowHtml(recipeDraftStatus, "recipe-status")}
      </div>
      <div class="field">
        <label>제조법</label>
        <textarea id="recipeInstructionsInput" rows="4" placeholder="순서대로 적어주세요">${escapeHtml(recipeDraftInstructions)}</textarea>
      </div>
      <div class="photo-attach-row" style="flex-wrap:wrap;">
        <input type="file" accept="image/*" id="recipePhotoInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
        ${recipePhotoUrls.map((url, i) => `
          <div class="photo-preview">
            <img src="${url}" alt="첨부 사진" class="share-photo-trigger" />
            <button class="photo-remove-btn" data-recipe-photo-remove="${i}">✕</button>
          </div>`).join("")}
        <button class="photo-add-btn" id="recipePhotoAddBtn">📷 사진 첨부</button>
      </div>
      <button class="btn gold block" id="recipeSubmitBtn" style="margin-top:8px;">레시피 등록</button>
    </div>`;

  if (list.length === 0) {
    html += `<div class="card"><div class="empty">아직 등록된 레시피가 없어요.</div></div>`;
  } else {
    html += `<div class="card section-recipe-list">`;
    list.forEach((r, idx) => { html += recipeCardHtml(r, idx); });
    html += `</div>`;
  }
  return html;
}

// 단종은 제조법이 필요 없는 짧은 공지라 레시피변경과 작성 폼 자체를
// 분리했다 — 메뉴 이름 + (선택) 비고 + 사진 정도만 받는다.
function recipeDiscontinuedTabHtml() {
  const list = recipeList.filter((r) => r.status === "discontinued");
  let html = `
    <div class="category-title section-title-recipe"><span class="dot soldout"></span>단종<span class="sub">${list.length}건</span></div>
    <div class="card section-recipe">
      <div class="field">
        <label>메뉴 이름</label>
        <input type="text" id="discoNameInput" placeholder="예: 바닐라 라떼" value="${escapeHtml(discoDraftName)}" />
      </div>
      <div class="field">
        <label>비고 (선택)</label>
        <textarea id="discoNoteInput" rows="2" placeholder="단종 사유 등 (선택)">${escapeHtml(discoDraftNote)}</textarea>
      </div>
      <div class="photo-attach-row" style="flex-wrap:wrap;">
        <input type="file" accept="image/*" id="discoPhotoInput" ${MULTIPLE_FILE_ATTR} style="display:none;" />
        ${discoPhotoUrls.map((url, i) => `
          <div class="photo-preview">
            <img src="${url}" alt="첨부 사진" class="share-photo-trigger" />
            <button class="photo-remove-btn" data-disco-photo-remove="${i}">✕</button>
          </div>`).join("")}
        <button class="photo-add-btn" id="discoPhotoAddBtn">📷 사진 첨부</button>
      </div>
      <button class="btn muted block" id="discoSubmitBtn" style="margin-top:8px;">단종 등록</button>
    </div>`;

  if (list.length === 0) {
    html += `<div class="card"><div class="empty">아직 등록된 단종 소식이 없어요.</div></div>`;
  } else {
    html += `<div class="card section-recipe-list">`;
    list.forEach((r, idx) => { html += recipeCardHtml(r, idx); });
    html += `</div>`;
  }
  return html;
}

function recipeTabHtml() {
  ensureRecipesStarted();
  let html = `
    <div class="seg recipe-sub-seg">
      <button type="button" class="${recipeSubTab === "change" ? "active" : ""}" data-recipe-sub-tab="change">레시피변경</button>
      <button type="button" class="${recipeSubTab === "discontinued" ? "active" : ""}" data-recipe-sub-tab="discontinued">단종</button>
    </div>`;
  html += recipeSubTab === "change" ? recipeChangeTabHtml() : recipeDiscontinuedTabHtml();
  return html;
}

function wireRecipeTab() {
  rootEl.querySelectorAll("[data-recipe-sub-tab]").forEach((el) => {
    el.addEventListener("click", () => { recipeSubTab = el.dataset.recipeSubTab; saveRecipeSubTab(); render(); });
  });
  const discoNameInput = rootEl.querySelector("#discoNameInput");
  if (discoNameInput) discoNameInput.addEventListener("input", (e) => { discoDraftName = e.target.value; });
  const discoNoteInput = rootEl.querySelector("#discoNoteInput");
  if (discoNoteInput) discoNoteInput.addEventListener("input", (e) => { discoDraftNote = e.target.value; });
  const discoPhotoInput = rootEl.querySelector("#discoPhotoInput");
  const discoPhotoAddBtn = rootEl.querySelector("#discoPhotoAddBtn");
  if (discoPhotoAddBtn) discoPhotoAddBtn.addEventListener("click", () => discoPhotoInput.click());
  if (discoPhotoInput) {
    discoPhotoInput.addEventListener("change", (e) => {
      onDiscoPhotosSelected(Array.from(e.target.files || []));
      e.target.value = "";
    });
  }
  rootEl.querySelectorAll("[data-disco-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      discoPhotoUrls.splice(Number(el.dataset.discoPhotoRemove), 1);
      render();
    });
  });
  const discoSubmitBtn = rootEl.querySelector("#discoSubmitBtn");
  if (discoSubmitBtn) discoSubmitBtn.addEventListener("click", submitDiscontinued);

  const nameInput = rootEl.querySelector("#recipeNameInput");
  if (nameInput) nameInput.addEventListener("input", (e) => { recipeDraftName = e.target.value; });
  const instrInput = rootEl.querySelector("#recipeInstructionsInput");
  if (instrInput) instrInput.addEventListener("input", (e) => { recipeDraftInstructions = e.target.value; });
  rootEl.querySelectorAll("[data-recipe-status]").forEach((el) => {
    el.addEventListener("click", () => { recipeDraftStatus = el.dataset.recipeStatus; render(); });
  });
  const photoInput = rootEl.querySelector("#recipePhotoInput");
  const photoAddBtn = rootEl.querySelector("#recipePhotoAddBtn");
  if (photoAddBtn) photoAddBtn.addEventListener("click", () => photoInput.click());
  if (photoInput) {
    photoInput.addEventListener("change", (e) => {
      onRecipePhotosSelected(Array.from(e.target.files || []));
      e.target.value = "";
    });
  }
  rootEl.querySelectorAll("[data-recipe-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      recipePhotoUrls.splice(Number(el.dataset.recipePhotoRemove), 1);
      render();
    });
  });
  const submitBtn = rootEl.querySelector("#recipeSubmitBtn");
  if (submitBtn) submitBtn.addEventListener("click", submitRecipe);
  rootEl.querySelectorAll("[data-recipe-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteRecipe(el.dataset.recipeDelete));
  });
  rootEl.querySelectorAll("[data-recipe-edit]").forEach((el) => {
    el.addEventListener("click", () => startEditRecipe(el.dataset.recipeEdit));
  });

  // 수정 폼 전용 와이어링 — 지금 떠 있는 레시피 카드 중 수정 모드인 게 있을
  // 때만 해당 요소들이 존재한다.
  const editNameInput = rootEl.querySelector("#editRecipeNameInput");
  if (editNameInput) editNameInput.addEventListener("input", (e) => { editRecipeDraft.menuName = e.target.value; });
  const editInstrInput = rootEl.querySelector("#editRecipeInstructionsInput");
  if (editInstrInput) editInstrInput.addEventListener("input", (e) => { editRecipeDraft.instructions = e.target.value; });
  rootEl.querySelectorAll("[data-edit-recipe-status]").forEach((el) => {
    el.addEventListener("click", () => { editRecipeDraft.status = el.dataset.editRecipeStatus; render(); });
  });
  const editPhotoInput = rootEl.querySelector("#editRecipePhotoInput");
  const editPhotoAddBtn = rootEl.querySelector("#editRecipePhotoAddBtn");
  if (editPhotoAddBtn) editPhotoAddBtn.addEventListener("click", () => editPhotoInput.click());
  if (editPhotoInput) {
    editPhotoInput.addEventListener("change", (e) => {
      onEditRecipePhotosSelected(Array.from(e.target.files || []));
      e.target.value = "";
    });
  }
  rootEl.querySelectorAll("[data-edit-recipe-photo-remove]").forEach((el) => {
    el.addEventListener("click", () => {
      editRecipeDraft.photoUrls.splice(Number(el.dataset.editRecipePhotoRemove), 1);
      render();
    });
  });
  const editCancelBtn = rootEl.querySelector("#editRecipeCancelBtn");
  if (editCancelBtn) editCancelBtn.addEventListener("click", cancelEditRecipe);
  const editSaveBtn = rootEl.querySelector("#editRecipeSaveBtn");
  if (editSaveBtn) editSaveBtn.addEventListener("click", saveEditRecipe);
}
