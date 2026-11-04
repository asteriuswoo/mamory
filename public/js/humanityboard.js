// 극한직업 일지 (구 인류애 바사삭) — 직원 홈 화면과 사장님 화면 양쪽에서 같은 버튼/오버레이를
// 띄워 쓰는 공용 모듈. mountHumanityTrigger(triggerBtn, overlayRootEl, account)로
// 붙여 쓴다. 전역 로그(humanityCracks)라 업무 데이터와는 완전히 분리되어 있다.
import { db, collection, addDoc, deleteDoc, doc, updateDoc, onSnapshot, query, orderBy, serverTimestamp, arrayUnion, arrayRemove } from "./firebase-init.js";
import { toast, escapeHtml, formatTimeLabel, formatDateLabel, dateStrOf } from "./util.js";
import { avatarHtml, allAccounts } from "./avatar.js";

let overlayRoot = null;
let triggerBtnEl = null;
let account = { name: "", phone: "" };
let showOverlay = false;
let list = []; // 전체 기록 — live, createdAt 내림차순
let unsub = null;
let draft = "";
const openReplyFor = new Set();
// 실시간으로 새 글/반응이 들어올 때마다 다시 그리는데, 답글 입력창에 value
// 바인딩이 없으면 타이핑 중이던 내용이 날아간다 — id별로 기억해뒀다가 다시
// 그릴 때 그대로 복원한다 (공유해요 게시판에서 겪은 것과 같은 버그).
const replyDrafts = new Map();
// 답글도 공유해요 게시판처럼 @멘션을 지원한다 — 입력창이 글마다 따로 열려
// 있을 수 있어서 "@" 입력 중인지 상태를 id별로 따로 들고 있는다.
const replyMentionState = new Map(); // id -> { active, startIndex, query }

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

export function mountHumanityTrigger(triggerBtn, overlayRootEl, acc) {
  overlayRoot = overlayRootEl;
  triggerBtnEl = triggerBtn;
  account = acc;
  if (triggerBtn) triggerBtn.addEventListener("click", open);
  ensureStarted();
}

function ensureStarted() {
  if (unsub) return;
  unsub = onSnapshot(query(collection(db, "stores", account.storeId, "humanityCracks"), orderBy("createdAt", "desc")), (snap) => {
    list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderBadge();
    if (showOverlay) renderOverlay();
  });
}

function isNewToMe(it) {
  return !(it.seenBy || []).includes(account.phone);
}

// 오버레이를 열어서 피드를 보는 순간 "확인했다"로 치고, 그 시점에 쌓여있던
// 전부를 한 번에 seenBy 처리한다 — 공유해요 게시판과 달리 글 하나하나를
// 따로 클릭해서 열어보는 구조가 아니라 열면 다 보이는 가벼운 피드라서.
function markAllSeen() {
  list.forEach((it) => {
    if (isNewToMe(it)) {
      updateDoc(doc(db, "stores", account.storeId, "humanityCracks", it.id), { seenBy: arrayUnion(account.phone) }).catch(() => {});
    }
  });
}

function renderBadge() {
  if (!triggerBtnEl) return;
  let wrap = triggerBtnEl.querySelector(".humanity-badge-wrap");
  if (!wrap) {
    wrap = document.createElement("span");
    wrap.className = "humanity-badge-wrap";
    triggerBtnEl.appendChild(wrap);
  }
  const unseen = list.filter(isNewToMe).length;
  wrap.innerHTML = `
    ${list.length > 0 ? `<span class="humanity-count-badge">+${list.length}</span>` : ""}
    ${unseen > 0 ? `<span class="corner-badge">N</span>` : ""}
  `;
}

function open() {
  showOverlay = true;
  markAllSeen();
  renderBadge();
  renderOverlay();
}

function close() {
  showOverlay = false;
  renderOverlay();
}

async function submit() {
  const text = draft.trim();
  if (!text) {
    toast("무슨 일이 있었는지 적어주세요");
    return;
  }
  await addDoc(collection(db, "stores", account.storeId, "humanityCracks"), {
    reason: text,
    staffName: account.name,
    staffPhone: account.phone,
    seenBy: [account.phone],
    createdAt: serverTimestamp(),
  });
  draft = "";
  toast("기록했어요 😮‍💨");
  renderOverlay();
}

async function removeEntry(id) {
  const it = list.find((x) => x.id === id);
  if (!it || it.staffPhone !== account.phone) return;
  if (!confirm("삭제할까요?")) return;
  await deleteDoc(doc(db, "stores", account.storeId, "humanityCracks", id));
}

// 슬퍼요 하나뿐이라 토글(눌렀으면 취소, 안 눌렀으면 추가)로만 동작한다 —
// 공유해요 게시판의 하트/슬픔/최고처럼 여러 반응 중 하나를 고르는 구조가
// 아니라 단일 반응이라 더 단순하게 arrayUnion/arrayRemove만 쓴다.
async function toggleSad(id) {
  const it = list.find((x) => x.id === id);
  if (!it) return;
  const sadBy = it.sadBy || [];
  const mine = sadBy.includes(account.phone);
  await updateDoc(doc(db, "stores", account.storeId, "humanityCracks", id), {
    sadBy: mine ? arrayRemove(account.phone) : arrayUnion(account.phone),
  });
}

async function addReply(id, content) {
  const text = (content || "").trim();
  if (!text) {
    toast("댓글 내용을 입력해주세요");
    return;
  }
  const { mentions, mentionsAll } = extractMentions(text);
  const reply = { content: text, mentions, mentionsAll, staffName: account.name, staffPhone: account.phone, createdAt: Date.now() };
  await updateDoc(doc(db, "stores", account.storeId, "humanityCracks", id), { replies: arrayUnion(reply) });
  replyDrafts.delete(id);
  replyMentionState.delete(id);
  renderOverlay();
}

async function deleteReplyAt(id, idx) {
  const it = list.find((x) => x.id === id);
  const reply = it && it.replies && it.replies[idx];
  if (!reply) return;
  if (reply.staffPhone !== account.phone) {
    toast("본인이 작성한 댓글만 삭제할 수 있어요");
    return;
  }
  if (!confirm("댓글을 삭제할까요?")) return;
  await updateDoc(doc(db, "stores", account.storeId, "humanityCracks", id), { replies: arrayRemove(reply) });
}

function repliesHtml(it) {
  const replies = it.replies || [];
  let html = "";
  if (replies.length > 0) {
    html += `<div class="reply-list">${replies.map((r, idx) => {
      const mine = r.staffPhone === account.phone;
      return `
        <div class="reply-row">
          ${avatarHtml(r.staffPhone, r.staffName, 18)}
          <div class="reply-body">
            <span class="reply-who">${escapeHtml(r.staffName || "")}님</span><span class="reply-content">${highlightMentions(escapeHtml(r.content))}</span>
            ${mine ? `<div class="reply-actions"><button class="reply-delete-btn" data-humanity-reply-delete="${it.id}" data-humanity-reply-idx="${idx}">삭제</button></div>` : ""}
          </div>
        </div>`;
    }).join("")}</div>`;
  }
  if (openReplyFor.has(it.id)) {
    html += `
      <div class="reply-input-row">
        <textarea class="reply-input" rows="1" data-humanity-reply-for="${it.id}" placeholder="댓글 달기 (@이름으로 멘션, 엔터로 줄바꿈)">${escapeHtml(replyDrafts.get(it.id) || "")}</textarea>
        <button class="reply-send-btn" data-humanity-reply-send="${it.id}">등록</button>
      </div>
      <div class="mention-suggest-box" data-humanity-reply-mention-box="${it.id}"></div>`;
  } else {
    html += `<button class="reply-toggle-btn" data-humanity-reply-toggle="${it.id}">댓글달기</button>`;
  }
  return html;
}

function renderReplyMentionSuggestions(id) {
  const box = overlayRoot.querySelector(`[data-humanity-reply-mention-box="${id}"]`);
  if (!box) return;
  const state = replyMentionState.get(id);
  if (!state || !state.active) { box.innerHTML = ""; return; }
  const q = state.query.trim();
  const matches = mentionCandidates().filter((a) => !q || a.name.includes(q)).slice(0, 6);
  if (matches.length === 0) { box.innerHTML = ""; return; }
  box.innerHTML = matches.map((a) => `<button type="button" class="mention-suggest-btn" data-humanity-reply-mention-name="${escapeHtml(a.name)}">@${escapeHtml(a.name)}</button>`).join("");
  box.querySelectorAll("[data-humanity-reply-mention-name]").forEach((el) => {
    el.addEventListener("click", () => insertReplyMention(id, el.dataset.humanityReplyMentionName));
  });
}

function insertReplyMention(id, name) {
  const input = overlayRoot.querySelector(`.reply-input[data-humanity-reply-for="${id}"]`);
  if (!input) return;
  const state = replyMentionState.get(id) || { startIndex: 0 };
  const current = replyDrafts.get(id) || "";
  const cursor = input.selectionStart;
  const before = current.slice(0, state.startIndex);
  const after = current.slice(cursor);
  const newText = `${before}@${name} ${after}`;
  replyDrafts.set(id, newText);
  input.value = newText;
  const newCursor = before.length + name.length + 2;
  replyMentionState.set(id, { active: false, startIndex: -1, query: "" });
  renderReplyMentionSuggestions(id);
  input.focus();
  input.setSelectionRange(newCursor, newCursor);
}

function entryRowHtml(it) {
  const sadBy = it.sadBy || [];
  const mine = sadBy.includes(account.phone);
  return `
    <div class="humanity-row">
      ${avatarHtml(it.staffPhone, it.staffName, 30)}
      <div class="humanity-row-body">
        <div class="humanity-row-head"><strong>${escapeHtml(it.staffName || "익명")}</strong><span class="humanity-row-time">${formatTimeLabel(it.createdAt)}</span></div>
        <div class="humanity-row-text">${escapeHtml(it.reason || "")}</div>
        <button class="humanity-sad-btn ${mine ? "active" : ""}" data-humanity-sad="${it.id}">😢${sadBy.length > 0 ? ` ${sadBy.length}` : ""}</button>
        ${repliesHtml(it)}
      </div>
      ${it.staffPhone === account.phone ? `<button class="payroll-shift-delete-btn" data-humanity-delete="${it.id}">삭제</button>` : ""}
    </div>`;
}

// 리스트가 길어질수록 "그날그날" 흐름으로 보는 게 한눈에 들어오지, 달력으로
// 날짜 하나하나 눌러 들어가는 건 오히려 번거롭다는 피드백으로 캘린더에서
// 되돌렸다 — createdAt 내림차순 리스트에서 날짜가 바뀔 때마다 구분선만 끼워
// 넣는다.
function listHtml() {
  if (list.length === 0) return `<div class="empty" style="margin-top:12px;">아직 기록된 게 없어요.</div>`;
  let html = "";
  let lastDate = null;
  for (const it of list) {
    const d = dateStrOf(it.createdAt);
    if (d !== lastDate) {
      html += `<div class="humanity-date-header">${formatDateLabel(d)}</div>`;
      lastDate = d;
    }
    html += entryRowHtml(it);
  }
  return html;
}

function overlayHtml() {
  return `
    <div class="payroll-form-overlay" id="humanityOverlay">
      <div class="payroll-form-sheet">
        <div class="row-between">
          <div style="font-weight:800; font-size:16px;">💢 극한직업 일지</div>
          <button class="payroll-form-close-btn" id="humanityCloseBtn" aria-label="닫기">✕</button>
        </div>
        <div style="font-size:12px; color:var(--muted); margin:6px 0 14px;">오늘 극한직업 느낀 순간이 있었다면 짧게 남겨보세요. 다같이 볼 수 있어요.</div>
        <textarea id="humanityInput" class="humanity-input" placeholder="무슨 일이 있었나요?" rows="3">${escapeHtml(draft)}</textarea>
        <button class="btn gold block" id="humanitySubmitBtn" style="margin-top:8px;">기록하기</button>
        <div class="humanity-list" style="margin-top:16px;">${listHtml()}</div>
      </div>
    </div>`;
}

function renderOverlay() {
  if (!overlayRoot) return;
  overlayRoot.innerHTML = showOverlay ? overlayHtml() : "";
  wireOverlay();
}

function wireOverlay() {
  const overlay = document.getElementById("humanityOverlay");
  if (!overlay) return;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.getElementById("humanityCloseBtn").addEventListener("click", close);
  const input = document.getElementById("humanityInput");
  if (input) input.addEventListener("input", (e) => { draft = e.target.value; });
  const submitBtn = document.getElementById("humanitySubmitBtn");
  if (submitBtn) submitBtn.addEventListener("click", submit);

  overlay.querySelectorAll("[data-humanity-delete]").forEach((el) => {
    el.addEventListener("click", () => removeEntry(el.dataset.humanityDelete));
  });
  overlay.querySelectorAll("[data-humanity-sad]").forEach((el) => {
    el.addEventListener("click", () => toggleSad(el.dataset.humanitySad));
  });
  overlay.querySelectorAll("[data-humanity-reply-toggle]").forEach((el) => {
    el.addEventListener("click", () => {
      openReplyFor.add(el.dataset.humanityReplyToggle);
      renderOverlay();
      const replyInput = overlay.querySelector(`.reply-input[data-humanity-reply-for="${el.dataset.humanityReplyToggle}"]`);
      if (replyInput) replyInput.focus();
    });
  });
  overlay.querySelectorAll("[data-humanity-reply-send]").forEach((el) => {
    const id = el.dataset.humanityReplySend;
    const replyInput = overlay.querySelector(`.reply-input[data-humanity-reply-for="${id}"]`);
    el.addEventListener("click", () => addReply(id, replyInput.value));
    // 답글 입력창이 <textarea>라 엔터는 그냥 줄바꿈 — 등록은 오직 "등록"
    // 버튼으로만 한다(전엔 Enter가 바로 전송돼서, 여러 줄 쓰려고 엔터 치면
    // 의도와 다르게 중간에 등록돼버렸다). shareboard.js의 답글 입력창과
    // 동일한 패턴.
    replyInput.addEventListener("input", (e) => {
      replyDrafts.set(id, e.target.value);
      e.target.style.height = "auto";
      e.target.style.height = `${e.target.scrollHeight}px`;
      const cursor = e.target.selectionStart;
      const before = e.target.value.slice(0, cursor);
      const atIndex = before.lastIndexOf("@");
      if (atIndex !== -1 && !/\s/.test(before.slice(atIndex + 1))) {
        replyMentionState.set(id, { active: true, startIndex: atIndex, query: before.slice(atIndex + 1) });
      } else {
        replyMentionState.set(id, { active: false, startIndex: -1, query: "" });
      }
      renderReplyMentionSuggestions(id);
    });
  });
  overlay.querySelectorAll("[data-humanity-reply-delete]").forEach((el) => {
    el.addEventListener("click", () => deleteReplyAt(el.dataset.humanityReplyDelete, Number(el.dataset.humanityReplyIdx)));
  });
}
