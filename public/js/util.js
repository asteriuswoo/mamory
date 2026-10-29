// standalone PWA에서 사진첨부가 안 되던 건 multiple 속성 때문이 아니라
// 그 iOS 버전 자체의 WebKit 버그였다(iOS 업데이트로 해결 확인됨) — 그래서
// standalone일 때만 multiple을 빼던 임시 우회 로직은 제거하고, 항상 다중
// 선택을 허용한다.
export const MULTIPLE_FILE_ATTR = "multiple";

const STORE_TIMEZONE = "Asia/Seoul";

// Always compute "today" (and any date-shift) in the store's timezone, not the
// device's local timezone, so every phone agrees on the same calendar day
// regardless of where it's set up.
function kstParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: STORE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.year}-${map.month}-${map.day}`;
}

export function todayStr() {
  return kstParts(new Date());
}

export function dateStrDaysAgo(n) {
  const now = new Date();
  const shifted = new Date(now.getTime() - n * 86400000);
  return kstParts(shifted);
}

// 날짜 고정 공휴일만 — 설날/추석처럼 음력 기준으로 매년 날짜가 바뀌는
// 공휴일은 해마다 손으로 갱신해야 해서 목록에 없다. "MM-DD" 형식.
const KR_FIXED_HOLIDAYS = new Set([
  "01-01", // 신정
  "03-01", // 삼일절
  "05-05", // 어린이날
  "06-06", // 현충일
  "08-15", // 광복절
  "10-03", // 개천절
  "10-09", // 한글날
  "12-25", // 성탄절
]);

// 고정 공휴일이 토/일과 겹치면 다음 평일이 대체공휴일로 지정된다(2026년
// 10월 3일 개천절이 토요일이라 10월 5일 월요일이 대체공휴일인 것처럼) —
// 날짜 자체가 평일로 거슬러 올라가며 바로 전 주말 구간에 고정 공휴일이
// 있었는지만 보면 되고, 해마다 날짜가 바뀌는 음력 공휴일과 달리 이 규칙
// 자체는 매년 똑같아서 손으로 갱신할 필요가 없다.
function isSubstituteHoliday(dateStr) {
  const dow = new Date(dateStr + "T00:00:00").getDay();
  if (dow === 0 || dow === 6) return false;
  for (let back = 1; back <= 2; back++) {
    const d = new Date(dateStr + "T00:00:00");
    d.setDate(d.getDate() - back);
    if (d.getDay() !== 0 && d.getDay() !== 6) break; // 주말 구간을 벗어나면 그만
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    if (KR_FIXED_HOLIDAYS.has(`${mm}-${dd}`)) return true;
  }
  return false;
}

// 날짜 탭에 요일별 색을 입히기 위한 분류 — 평일은 "weekday", 주말·공휴일은
// "weekend"로 묶어서 같은 빨간 표시를 쓴다.
export function dayAccentClass(dateStr) {
  const [, m, d] = dateStr.split("-");
  const dow = new Date(dateStr + "T00:00:00").getDay(); // 0=일 ~ 6=토
  const isWeekend = dow === 0 || dow === 6;
  const isHoliday = KR_FIXED_HOLIDAYS.has(`${m}-${d}`) || isSubstituteHoliday(dateStr);
  return isWeekend || isHoliday ? "weekend" : "weekday";
}

export function formatDateLabel(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  return `${m}월 ${d}일 (${days[dt.getDay()]})`;
}

// Accepts a Firestore Timestamp, a plain {seconds} shape, or a raw millis
// number (used for things like reply timestamps that live inside an array
// field, where serverTimestamp() isn't allowed).
function tsToDate(ts) {
  if (typeof ts === "number") return new Date(ts);
  if (typeof ts.toDate === "function") return ts.toDate();
  return new Date(ts.seconds * 1000);
}

// "YYYY-MM-DD" (store timezone) for whichever calendar day a timestamp falls
// on — used to bucket a flat, non-date-scoped collection (e.g. topups) by
// day for day-chip browsing. A still-pending optimistic write (ts is falsy)
// is assumed to be "today", since it was just created locally.
export function dateStrOf(ts) {
  if (!ts) return todayStr();
  return kstParts(tsToDate(ts));
}

// createdAt is a Firestore Timestamp once the server has confirmed the write;
// right after an optimistic local write it's still null, so callers should
// expect "" until the next snapshot fills it in.
export function formatTimestampLabel(ts) {
  if (!ts) return "";
  const date = tsToDate(ts);
  return `${formatDateLabel(kstParts(date))} ${formatTimeLabel(ts)}`;
}

export function formatTimeLabel(ts) {
  if (!ts) return "";
  const date = tsToDate(ts);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: STORE_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

// navigator.clipboard.writeText() throws in a bunch of real-world mobile
// situations (PWA standalone context, a stale/lost document focus, older
// WebViews) even though copying itself is perfectly possible there — so on
// any failure, fall back to the old select-a-hidden-textarea + execCommand
// approach before actually telling the user it failed.
function legacyCopy(text) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.top = "-9999px";
  ta.style.left = "-9999px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

export async function copyText(text, successMsg = "복사했어요") {
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard api");
    await navigator.clipboard.writeText(text);
    toast(successMsg);
  } catch (e) {
    if (legacyCopy(text)) toast(successMsg);
    else toast("복사에 실패했어요. 직접 선택해서 복사해주세요");
  }
}

let toastTimer = null;
export function toast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
}

// 기존 toast()는 하단에서 올라오는 짧은 확인용 알림이고, 이건 그와 별개로
// 화면 상단에서 아래로 내려오는 응원 메시지용 배너(출퇴근 도장 등, 좀 더
// 눈에 띄고 머무는 시간도 긴 메시지에 쓴다).
let topBannerTimer = null;
export function showTopBanner(msg, duration = 2600) {
  let el = document.getElementById("topBanner");
  if (!el) {
    el = document.createElement("div");
    el.id = "topBanner";
    el.className = "top-banner";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(topBannerTimer);
  topBannerTimer = setTimeout(() => el.classList.remove("show"), duration);
}

// Bottom action-sheet with a list of option buttons + a cancel button.
// Resolves with the clicked option's index, or -1 if dismissed/cancelled.
// An option can also carry an `onClick` callback, which fires synchronously
// inside that button's own click handler — before the backdrop is even
// removed, with no Promise/await hop in between. That matters specifically
// for options that call `someFileInput.click()` to open the native photo
// picker: iOS (especially inside a standalone/home-screen PWA) can fail to
// treat a `.click()` called after an `await` as a trusted user gesture, so
// callers that need to open a native picker should do it from `onClick`
// rather than from the resolved index.
export function showActionSheet(options) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "sheet-backdrop";
    backdrop.innerHTML = `
      <div class="action-sheet">
        ${options.map((o, i) => `<button class="action-sheet-btn${o.danger ? " danger" : ""}" data-idx="${i}">${escapeHtml(o.label)}</button>`).join("")}
        <button class="action-sheet-cancel" data-cancel>취소</button>
      </div>`;
    document.body.appendChild(backdrop);
    function close(result) {
      backdrop.remove();
      resolve(result);
    }
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(-1); });
    backdrop.querySelector("[data-cancel]").addEventListener("click", () => close(-1));
    backdrop.querySelectorAll("[data-idx]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.idx);
        backdrop.remove();
        if (options[idx].onClick) options[idx].onClick();
        resolve(idx);
      });
    });
  });
}

// Centered confirm dialog with custom-labeled buttons (native confirm() can't
// relabel its buttons). Resolves true if the "yes" button was pressed.
export function confirmModal(message, yesLabel, noLabel) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "confirm-modal-backdrop";
    backdrop.innerHTML = `
      <div class="confirm-modal">
        <div class="confirm-modal-msg">${escapeHtml(message)}</div>
        <div class="confirm-modal-actions">
          <button class="confirm-modal-btn primary" data-yes>${escapeHtml(yesLabel)}</button>
          <button class="confirm-modal-btn secondary" data-no>${escapeHtml(noLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(backdrop);
    function close(result) {
      backdrop.remove();
      resolve(result);
    }
    backdrop.querySelector("[data-yes]").addEventListener("click", () => close(true));
    backdrop.querySelector("[data-no]").addEventListener("click", () => close(false));
  });
}

// In-page enlarged photo viewer — used for avatars, share-board post photos,
// etc. wherever a photo would otherwise open in a new tab. One overlay at a
// time; tapping the backdrop or the ✕ closes it.
//
// Accepts either a single image (openImageLightbox(src, alt), the original
// signature — every existing single-photo caller keeps working unchanged)
// or a swipeable group (openImageLightbox([{src,alt}, ...], startIndex)) —
// used when a post/reply has several photos, so viewers can swipe between
// them inside the lightbox instead of closing and reopening one at a time.
export function openImageLightbox(srcOrGroup, altOrIndex) {
  const group = Array.isArray(srcOrGroup) ? srcOrGroup : [{ src: srcOrGroup, alt: altOrIndex }];
  const startIndex = Math.max(0, Math.min(Array.isArray(srcOrGroup) ? (altOrIndex || 0) : 0, group.length - 1));

  const overlay = document.createElement("div");
  overlay.className = "img-lightbox-overlay";
  overlay.innerHTML = `
    <button class="img-lightbox-close" aria-label="닫기">✕</button>
    ${group.length > 1 ? `<div class="img-lightbox-count">${startIndex + 1} / ${group.length}</div>` : ""}
    <div class="img-lightbox-track">
      ${group.map((g) => `<div class="img-lightbox-slide">${
        g.type === "video"
          ? `<video src="${g.src}" class="img-lightbox-img" controls playsinline></video>`
          : `<img src="${g.src}" alt="${escapeHtml(g.alt || "")}" class="img-lightbox-img" />`
      }</div>`).join("")}
    </div>
    <button class="img-lightbox-save" type="button">💾 저장</button>
  `;
  const close = () => overlay.remove();
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay || e.target.closest(".img-lightbox-close") || e.target.classList.contains("img-lightbox-track") || e.target.classList.contains("img-lightbox-slide")) close();
  });

  const track = overlay.querySelector(".img-lightbox-track");
  const countEl = overlay.querySelector(".img-lightbox-count");
  const saveBtn = overlay.querySelector(".img-lightbox-save");
  let currentIndex = startIndex;
  const setSaveTarget = () => { saveBtn.onclick = () => saveImageToDevice(group[currentIndex].src); };
  setSaveTarget();

  if (group.length > 1) {
    track.addEventListener("scroll", () => {
      const idx = Math.round(track.scrollLeft / track.clientWidth);
      if (idx === currentIndex || idx < 0 || idx >= group.length) return;
      currentIndex = idx;
      countEl.textContent = `${currentIndex + 1} / ${group.length}`;
      setSaveTarget();
    }, { passive: true });
  }

  // Pinch-zoom only makes sense for photos — video already has its own
  // native controls/gestures and pinch-zooming it would fight them.
  overlay.querySelectorAll("img.img-lightbox-img").forEach(wirePinchZoom);

  document.body.appendChild(overlay);
  if (startIndex > 0) track.scrollLeft = startIndex * track.clientWidth; // 애니메이션 없이 바로 그 장으로
}

// 앱 전체는 user-scalable=no로 화면 자체의 핀치줌을 막아뒀지만(레이아웃이
// 밀리는 걸 방지), 라이트박스로 확대해서 보는 사진 한 장만큼은 두 손가락으로
// 더 크게 보고 싶을 수 있어서 — 이미지 엘리먼트에만 직접 transform(scale/
// translate)을 입혀서 "사진 자체만" 확대되게 한다(화면/레이아웃은 그대로).
// 손가락 1개로는 원래처럼 사진 사이를 옆으로 스와이프할 수 있어야 하므로,
// 확대돼 있을 때(scale>1)만 손가락 1개 드래그를 "사진 안에서 이동"으로
// 가로채고, 평소엔 그 네이티브 스와이프를 건드리지 않는다.
function wirePinchZoom(img) {
  let scale = 1, tx = 0, ty = 0;
  let startDist = 0, startScale = 1;
  let startTx = 0, startTy = 0, startX = 0, startY = 0;
  let panning = false;
  let lastTapAt = 0;

  function apply() {
    img.style.transform = scale === 1 ? "" : `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function resetZoom() {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  }

  function distanceOf(touches) {
    return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
  }

  img.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        startDist = distanceOf(e.touches);
        startScale = scale;
      } else if (e.touches.length === 1 && scale > 1) {
        e.preventDefault();
        panning = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startTx = tx;
        startTy = ty;
      }
    },
    { passive: false }
  );

  img.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && startDist > 0) {
        e.preventDefault();
        scale = Math.min(4, Math.max(1, startScale * (distanceOf(e.touches) / startDist)));
        apply();
      } else if (panning && e.touches.length === 1) {
        e.preventDefault();
        tx = startTx + (e.touches[0].clientX - startX);
        ty = startTy + (e.touches[0].clientY - startY);
        apply();
      }
    },
    { passive: false }
  );

  img.addEventListener("touchend", () => {
    panning = false;
    startDist = 0;
    if (scale <= 1.02) {
      resetZoom();
      return;
    }
    const now = Date.now();
    if (now - lastTapAt < 300) resetZoom(); // 더블탭하면 원래 크기로
    lastTapAt = now;
  });
}

// Storage 버킷에 CORS 설정이 없어서, 사진 URL을 브라우저에서 바로 fetch()하면
// "No 'Access-Control-Allow-Origin' header" 에러로 막힌다 — <img>로 그냥
// 보여주는 건 CORS 없이도 되지만, 바이트를 읽어와 저장하려면 버킷 CORS가
// 필요한데 그건 gsutil 같은 인프라 설정이라 앱 코드만으로는 바꿀 수 없다.
// 대신 downloadImage 함수(서버라 CORS 제약이 없다)를 프록시로 거쳐서
// 받아오면, 같은 바이트를 CORS 걱정 없이 가져올 수 있다.
const DOWNLOAD_PROXY_URL = "https://asia-northeast3-mmth-order.cloudfunctions.net/downloadImage";

function storagePathFromUrl(url) {
  const m = url.match(/\/o\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

async function saveImageToDevice(src) {
  try {
    const path = storagePathFromUrl(src);
    const fetchUrl = path ? `${DOWNLOAD_PROXY_URL}?path=${encodeURIComponent(path)}` : src;
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob();
    // Extension/type now come from the actual blob instead of being
    // hardcoded to .jpg — saveImageToDevice also handles video attachments.
    const type = blob.type || "image/jpeg";
    const ext = type.split("/")[1]?.split(";")[0] || (type.startsWith("video/") ? "mp4" : "jpg");
    const filename = `mamory_${Date.now()}.${ext}`;
    const file = new File([blob], filename, { type });
    // 모바일 사파리는 <a download>를 블롭에 제대로 적용하지 않고, 대신
    // 파일 미리보기(QuickLook) 화면으로 아예 이동시켜버린다 — 누르자마자
    // "다른 페이지로 넘어간" 것처럼 느껴지는 게 이 때문. 파일 공유를 지원하는
    // 환경(iOS 15+ 등)에서는 그 자리에서 네이티브 공유시트를 띄우는 게
    // 훨씬 자연스럽다("이미지 저장"이 그 시트 안에 바로 있다). 지원 안
    // 하는 환경(대부분의 데스크톱 브라우저)에서만 기존 blob 앵커 다운로드로
    // 대체한다.
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file] });
      return;
    }
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch (e) {
    if (e.name !== "AbortError") toast("사진 저장에 실패했어요"); // 공유시트를 취소한 건 실패가 아니다
  }
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

// 이미 escapeHtml을 거친 문자열 위에서만 동작 — "&"가 "&amp;"로 바뀐 뒤라
// URL 안의 &(예: ?a=1&b=2)는 "&amp;amp;"처럼 보이지만, 그래도 하나의
// 유효한 URL 문자열로 매치/치환된다. href 속성값은 그대로 escaped 상태로
// 들어가므로 별도 이스케이프가 필요 없다.
export function linkifyUrls(escapedStr) {
  return escapedStr.replace(/https?:\/\/[^\s<]+/g, (url) => {
    // 문장 끝 구두점(마침표, 쉼표 등)이 URL에 딸려 들어가지 않게 분리
    const trailing = url.match(/[).,!?;:]+$/);
    const clean = trailing ? url.slice(0, -trailing[0].length) : url;
    const tail = trailing ? trailing[0] : "";
    return `<a href="${clean}" target="_blank" rel="noopener">${clean}</a>${tail}`;
  });
}

// 남은 예비 수량 라벨 — "없음"일 땐 "없음 남음"처럼 어색하게 붙이지 않고
// "예비 없음" 그대로, 그 외엔 "{수량} 남음" 형태로 표시한다.
export function qtyRemainingLabel(qty) {
  if (!qty) return "";
  return qty === "없음" ? "예비 없음" : `${qty} 남음`;
}

// 시스템 기본 🔔/🔕 이모지 대신, 앱의 골드/크림 톤과 둥근 느낌에 맞춘
// 손으로 그린 종 아이콘 — 알림 켜기 버튼(staff.js/owner.js)에서 innerHTML로
// 그대로 꽂아 쓴다.
export const NOTIFY_BELL_ON = `
<svg viewBox="0 0 24 24" width="17" height="17" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="notifyBellGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffd9a0"/>
      <stop offset="100%" stop-color="#f0a479"/>
    </linearGradient>
  </defs>
  <path d="M12 2.6c-1 0-1.7.8-1.7 1.7v.5C7.7 5.5 6 8 6 10.9v2.9c0 .8-.3 1.6-.9 2.1l-.7.7c-.7.6-.2 1.8.7 1.8h15.6c.9 0 1.4-1.1.7-1.8l-.7-.7c-.6-.5-.9-1.3-.9-2.1v-2.9c0-2.9-1.7-5.4-4.3-6.1v-.5c0-.9-.8-1.7-1.7-1.7z" fill="url(#notifyBellGrad)" stroke="#c97b4a" stroke-width="0.7" stroke-linejoin="round"/>
  <path d="M9.1 19.3a2.9 2.9 0 0 0 5.8 0z" fill="#c97b4a"/>
  <ellipse cx="9.3" cy="8.6" rx="1.5" ry="2.1" fill="#fff3df" opacity=".75" transform="rotate(-18 9.3 8.6)"/>
</svg>`;

export const NOTIFY_BELL_OFF = `
<svg viewBox="0 0 24 24" width="17" height="17" xmlns="http://www.w3.org/2000/svg">
  <path d="M12 2.6c-1 0-1.7.8-1.7 1.7v.5C7.7 5.5 6 8 6 10.9v2.9c0 .8-.3 1.6-.9 2.1l-.7.7c-.7.6-.2 1.8.7 1.8h15.6c.9 0 1.4-1.1.7-1.8l-.7-.7c-.6-.5-.9-1.3-.9-2.1v-2.9c0-2.9-1.7-5.4-4.3-6.1v-.5c0-.9-.8-1.7-1.7-1.7z" fill="#e4dfd4" stroke="#b8b3a8" stroke-width="0.7" stroke-linejoin="round"/>
  <path d="M9.1 19.3a2.9 2.9 0 0 0 5.8 0z" fill="#b8b3a8"/>
  <line x1="3.8" y1="20.2" x2="20.2" y2="3.8" stroke="#e2635a" stroke-width="2.1" stroke-linecap="round"/>
  <line x1="3.8" y1="20.2" x2="20.2" y2="3.8" stroke="#fff" stroke-width="0.7" stroke-linecap="round"/>
</svg>`;

export const URGENCY_LABEL = {
  normal: "여유",
  urgent: "긴급",
  soldout: "품절",
};

export const URGENCY_HINT = {
  normal: "2-3일 여유",
  urgent: "내일 당장 없음",
  soldout: "지금 재고 없음",
};

export const URGENCY_ORDER = ["normal", "urgent", "soldout"];

// 오늘 발주/담은 목록의 "모아보기" 섹션 캡션 — URGENCY_HINT보다 감정을 더 담아
// 사람 말투로 표현한 버전.
export const URGENCY_GROUP_CAPTION = {
  normal: "2~3일 뒤면 다 소진돼요😊",
  urgent: "당장 내일 사용할 분이 없어요😢",
  soldout: "품절돼서 못나가고 있어요😢",
};

export function normalizePhone(v) {
  return (v || "").replace(/\D/g, "");
}

export function formatPhone(digits) {
  const d = normalizePhone(digits);
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}

export function getAccount() {
  try {
    return JSON.parse(localStorage.getItem("cafe_account") || "null");
  } catch (e) {
    return null;
  }
}

export function setAccount(account) {
  localStorage.setItem("cafe_account", JSON.stringify(account));
}

export function clearAccount() {
  localStorage.removeItem("cafe_account");
}

// Materials are ordered manually by the owner (via up/down buttons in 자재
// 관리) rather than automatically. sortOrder is the source of truth once a
// material has one; older materials that predate this feature fall back to
// their creation time so they still get a stable, sensible position.
export function materialSortKey(m) {
  if (typeof m.sortOrder === "number") return m.sortOrder;
  if (m.createdAt && typeof m.createdAt.seconds === "number") return m.createdAt.seconds * 1000;
  return 0;
}

// Owner-configured subcategory display order (config/subcategoryOrder,
// { mainCategory: string[] }). Names not yet in the array sort after the
// ones that are, alphabetically among themselves.
export function sortByOrder(names, orderArray) {
  const rank = {};
  (orderArray || []).forEach((name, i) => { rank[name] = i; });
  return [...names].sort((a, b) => {
    const ai = rank[a] ?? 9999;
    const bi = rank[b] ?? 9999;
    if (ai !== bi) return ai - bi;
    return a.localeCompare(b);
  });
}

export function sortMaterials(list) {
  return [...list].sort((a, b) => {
    const subCmp = (a.subCategory || "").localeCompare(b.subCategory || "");
    if (subCmp !== 0) return subCmp;
    const keyCmp = materialSortKey(a) - materialSortKey(b);
    if (keyCmp !== 0) return keyCmp;
    return (a.name || "").localeCompare(b.name || "");
  });
}

// Downscales/re-encodes an attached photo before upload so a phone-camera
// shot (often several MB) doesn't turn into a slow upload or a big Storage bill.
export function resizeImageFile(file, maxDim = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error("이미지 변환 실패"));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("이미지 로드 실패")); };
    img.src = url;
  });
}
