// 공유하기 (품절 공유 / 공유해요) — 직원 화면(staff.js)과 사장님 화면(share.js)에서
// 공통으로 쓰는 렌더링/데이터 모듈. mountShareBoard(el, account)로 붙여 쓴다.
import { db, collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, getDocs, serverTimestamp, arrayUnion, arrayRemove, storage, ref, uploadBytes, getDownloadURL } from "./firebase-init.js";
import { todayStr, dateStrDaysAgo, formatDateLabel, formatTimeLabel, toast, escapeHtml, resizeImageFile } from "./util.js";
import { avatarHtml, watchAccounts } from "./avatar.js";

const date = todayStr();
const recentDates = Array.from({ length: 7 }, (_, i) => dateStrDaysAgo(i));

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
      ? `<textarea class="edit-textarea" data-edit-input="${it.id}" rows="3">${val}</textarea>`
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
      <div class="name">${isToday && isNewToMe(it) ? `<span class="tag new">N</span>` : ""}${escapeHtml(it.content)}</div>
      <div class="who">${formatDateLabel(shareDate)}${formatTimeLabel(it.createdAt) ? ` · ${formatTimeLabel(it.createdAt)}` : ""}</div>
    </div>`;
}

async function saveShareEdit(id, value) {
  const text = (value || "").trim();
  if (!text) {
    toast("내용을 입력해주세요");
    return;
  }
  await updateDoc(doc(db, "shares", shareDate, "items", id), { content: text });
  const it = shareItems.find((x) => x.id === id);
  if (it) it.content = text; // past dates have no live listener to pick this up otherwise
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
  it.reactions = newReactions;
  render();
}

// Replies live as a plain array on the parent note (not a subcollection) so
// they ride along on the same listener — serverTimestamp() can't be used
// inside an array element, so each reply just stamps a client-side ms clock.
// Which items currently have their reply textbox expanded — starts closed
// for everything so opening the board doesn't show an input under every
// note; a "댓글달기" button reveals it on demand instead.
const openReplyFor = new Set();

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
                <input type="text" class="reply-edit-input" data-reply-edit-input="${key}" value="${escapeHtml(editingReplies.get(key))}" />
                <button class="reply-cancel-btn" data-reply-edit-cancel="${key}">취소</button>
                <button class="reply-save-btn" data-reply-edit-save="${key}">저장</button>
              </div>
            </div>
          </div>`;
        }
        return `
        <div class="reply-row">
          ${avatarHtml(r.staffPhone, r.staffName, 18)}
          <div class="reply-body">
            <span class="reply-who">${escapeHtml(r.staffName || "")}님</span><span class="reply-content">${escapeHtml(r.content)}</span>
            ${mine ? `<div class="reply-actions"><button class="reply-edit-btn" data-reply-edit="${key}">수정</button><button class="reply-delete-btn" data-reply-delete-item="${it.id}" data-reply-delete-idx="${idx}">삭제</button></div>` : ""}
          </div>
        </div>`;
      })
      .join("")}</div>`;
  }
  if (openReplyFor.has(it.id)) {
    html += `
      <div class="reply-input-row">
        <input type="text" class="reply-input" data-reply-for="${it.id}" placeholder="답글 달기" />
        <button class="reply-send-btn" data-reply-send="${it.id}">등록</button>
      </div>`;
  } else {
    html += `<button class="reply-toggle-btn" data-reply-toggle="${it.id}">댓글달기</button>`;
  }
  return html;
}

async function addReply(itemId, content) {
  const text = (content || "").trim();
  if (!text) {
    toast("답글 내용을 입력해주세요");
    return;
  }
  const reply = { content: text, staffName: account.name, staffPhone: account.phone, createdAt: Date.now() };
  await updateDoc(doc(db, "shares", shareDate, "items", itemId), {
    replies: arrayUnion(reply),
  });
  const it = shareItems.find((x) => x.id === itemId);
  if (it) it.replies = [...(it.replies || []), reply]; // see toggleReaction's comment — past dates have no live listener
  render();
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
  it.replies = newReplies; // past dates have no live listener to pick this up otherwise
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
  it.replies = it.replies.filter((_, i) => i !== idx); // past dates have no live listener to pick this up otherwise
  render();
}

let rootEl = null;
let account = { name: "", phone: "" };
let started = false;

let shareDate = date;
let shareItems = [];
let shareTodayItems = []; // always-live today's items, independent of which day is being browsed
const chipCounts = {};
const chipUnseen = {}; // date -> true if that date has any item this viewer hasn't seen yet
const chipHasSoldout = {}; // date -> true if that date has any 품절 share (drives the "어제 품절 해제" reminder)

function canDeleteShare(it) {
  // Legacy items with no staffPhone stamped can't be attributed — allow
  // deletion rather than permanently locking them.
  return !it.staffPhone || it.staffPhone === account.phone;
}

function isNewToMe(it) {
  return !(it.seenBy || []).includes(account.phone);
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

function render() {
  if (!rootEl) return;
  const isToday = shareDate === date;
  const yesterdayDateStr = dateStrDaysAgo(1);
  const soldoutList = sortByTime(shareItems.filter((it) => it.type === "soldout"));
  const noteList = sortByTime(shareItems.filter((it) => it.type === "note"));

  markSeen(shareItems, shareDate);

  let html = `
    <div class="card">
      <div class="field" style="margin:0">
        <label>최근 7일</label>
        <div class="day-chip-row" id="shareDayChips"></div>
      </div>
    </div>

    <div class="category-title">품절 공유<span class="sub">${soldoutList.length}건</span></div>
    <div class="card">`;

  if (isToday && chipHasSoldout[yesterdayDateStr]) {
    html += `<button class="soldout-reminder-banner" id="soldoutReminderBtn">오늘 물류가 왔다면 탭해서 확인 후 관련 메뉴 품절해제해주세요😊</button>`;
  }

  if (soldoutList.length === 0) {
    html += `<div class="empty">공유된 품절 자재가 없어요.</div>`;
  } else {
    for (const it of soldoutList) {
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
        <input type="text" id="soldoutInput" placeholder="품절된 자재 이름" style="flex:1;" />
        <button class="btn gold" id="soldoutAddBtn" style="white-space:nowrap;">공유</button>
      </div>`;
  }
  html += `</div>`;

  html += `
    <div class="category-title">공유해요<span class="sub">${noteList.length}건</span></div>
    <div class="card">`;
  if (noteList.length === 0) {
    html += `<div class="empty">공유된 특이사항이 없어요.</div>`;
  } else {
    for (const it of noteList) {
      html += `
        <div class="item-row">
          <div class="post-head">
            <div class="post-avatar-col">
              ${avatarHtml(it.staffPhone, it.staffName, 36)}
              <div class="post-author-name">${escapeHtml(it.staffName || "")}</div>
            </div>
            ${postTopRowHtml(it, isToday)}
          </div>
          <div class="post-body">
            ${it.photoUrl ? `<a href="${it.photoUrl}" target="_blank" rel="noopener"><img src="${it.photoUrl}" class="note-photo-thumb" alt="첨부 사진" /></a>` : ""}
            ${reactionRow(it, postActionsHtml(it))}
            ${repliesHtml(it)}
          </div>
        </div>`;
    }
  }
  if (isToday) {
    html += `
      <div style="margin-top:12px;">
        <textarea id="noteInput" rows="3" placeholder="근무 중이 아닌 직원도 볼 수 있게 특이사항을 남겨주세요" style="width:100%;">${escapeHtml(noteDraftText)}</textarea>
        <div class="photo-attach-row">
          <input type="file" accept="image/*" id="noteImageInput" style="display:none;" />
          ${notePhotoUrl ? `
            <div class="photo-preview">
              <a href="${notePhotoUrl}" target="_blank" rel="noopener"><img src="${notePhotoUrl}" alt="첨부 사진" /></a>
              <button class="photo-remove-btn" id="noteImageRemoveBtn">✕</button>
            </div>` : `<button class="photo-add-btn" id="noteImageAddBtn">📷 사진 첨부</button>`}
        </div>
        <button class="btn gold block" id="noteAddBtn" style="margin-top:8px;">공유하기</button>
      </div>`;
  }
  html += `</div>`;

  rootEl.innerHTML = html;
  wireShareDayChips();

  const soldoutInput = rootEl.querySelector("#soldoutInput");
  const soldoutAddBtn = rootEl.querySelector("#soldoutAddBtn");
  if (soldoutAddBtn) {
    soldoutAddBtn.addEventListener("click", () => addShareItem("soldout", soldoutInput.value));
    // isComposing guards against IME text (한글 등) firing Enter's keydown
    // twice — once to finalize the composed character, once for real —
    // which would otherwise post the same entry twice.
    soldoutInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) addShareItem("soldout", soldoutInput.value); });
  }
  const noteInput = rootEl.querySelector("#noteInput");
  if (noteInput) {
    noteInput.addEventListener("input", (e) => { noteDraftText = e.target.value; });
  }
  const noteImageInput = rootEl.querySelector("#noteImageInput");
  const noteImageAddBtn = rootEl.querySelector("#noteImageAddBtn");
  const noteImageRemoveBtn = rootEl.querySelector("#noteImageRemoveBtn");
  if (noteImageAddBtn) noteImageAddBtn.addEventListener("click", () => noteImageInput.click());
  if (noteImageInput) noteImageInput.addEventListener("change", (e) => onNotePhotoSelected(e.target.files[0]));
  if (noteImageRemoveBtn) noteImageRemoveBtn.addEventListener("click", () => { notePhotoUrl = ""; render(); });
  const noteAddBtn = rootEl.querySelector("#noteAddBtn");
  if (noteAddBtn) {
    noteAddBtn.addEventListener("click", async () => {
      const text = noteDraftText.trim();
      if (!text) {
        toast("내용을 입력해주세요");
        return;
      }
      await addShareItem("note", text, notePhotoUrl);
      noteDraftText = "";
      notePhotoUrl = "";
      render();
    });
  }
  const soldoutReminderBtn = rootEl.querySelector("#soldoutReminderBtn");
  if (soldoutReminderBtn) soldoutReminderBtn.addEventListener("click", () => loadShareDate(yesterdayDateStr));
  rootEl.querySelectorAll("[data-share-remove]").forEach((el) => {
    el.addEventListener("click", () => deleteShareItem(el.dataset.shareRemove));
  });
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
    el.addEventListener("click", () => addReply(itemId, input.value));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) addReply(itemId, input.value);
    });
  });
  rootEl.querySelectorAll("[data-reply-delete-item]").forEach((el) => {
    el.addEventListener("click", () => deleteReplyAt(el.dataset.replyDeleteItem, Number(el.dataset.replyDeleteIdx)));
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
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) saveReplyEdit(key, input.value);
    });
  });
  rootEl.querySelectorAll("[data-reply-edit-cancel]").forEach((el) => {
    el.addEventListener("click", () => {
      editingReplies.delete(el.dataset.replyEditCancel);
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
        chipUnseen[d] = snap.docs.some((doc) => !(doc.data().seenBy || []).includes(account.phone));
        chipHasSoldout[d] = snap.docs.some((doc) => doc.data().type === "soldout");
        // Today's own render depends on yesterday's chipHasSoldout (the
        // reminder banner), not just the date currently being browsed.
        if (shareDate === d || (shareDate === date && d === dateStrDaysAgo(1))) render();
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

async function addShareItem(type, content, photoUrl) {
  const text = (content || "").trim();
  if (!text) {
    toast(type === "soldout" ? "품절된 자재 이름을 입력해주세요" : "내용을 입력해주세요");
    return;
  }
  await addDoc(collection(db, "shares", date, "items"), {
    type,
    content: text,
    photoUrl: photoUrl || "",
    staffName: account.name,
    staffPhone: account.phone,
    seenBy: [account.phone],
    createdAt: serverTimestamp(),
  });
  toast("공유했어요");
}

// Draft state for the "공유해요" composer — kept outside render() so
// re-rendering (e.g. from an unrelated reaction elsewhere) doesn't wipe
// whatever the user is mid-typing or already attached.
let noteDraftText = "";
let notePhotoUrl = "";

async function onNotePhotoSelected(file) {
  if (!file) return;
  toast("사진 업로드 중...");
  try {
    const blob = await resizeImageFile(file);
    const path = `notePhotos/${date}/share_${account.phone}_${Date.now()}.jpg`;
    const fileRef = ref(storage, path);
    await uploadBytes(fileRef, blob, { contentType: "image/jpeg" });
    notePhotoUrl = await getDownloadURL(fileRef);
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

const badgeListeners = [];

function notifyBadgeListeners() {
  badgeListeners.forEach((cb) => cb(getTodayUnseenCount(account.phone)));
}

function ensureStarted() {
  if (started) return;
  started = true;
  onSnapshot(collection(db, "shares", date, "items"), (snap) => {
    shareTodayItems = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    chipCounts[date] = shareTodayItems.length;
    chipUnseen[date] = shareTodayItems.some((it) => !(it.seenBy || []).includes(account.phone));
    if (shareDate === date) shareItems = shareTodayItems;

    render();
    notifyBadgeListeners();
  });
  loadAllShareChipCounts();
}

export function mountShareBoard(el, acc) {
  rootEl = el;
  account = acc;
  ensureStarted();
  watchAccounts(render);
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
