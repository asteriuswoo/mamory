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

// Bottom action-sheet with a list of option buttons + a cancel button.
// Resolves with the clicked option's index, or -1 if dismissed/cancelled.
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
      btn.addEventListener("click", () => close(Number(btn.dataset.idx)));
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

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

export const URGENCY_LABEL = {
  normal: "정상 발주",
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
