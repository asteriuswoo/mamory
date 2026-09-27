// 자재 관리 view — mounted/unmounted by app-shell.js. Same pattern as
// owner.js: DOM lookups and Firestore subscriptions are scoped inside
// mount()/unmount() since this module stays loaded across tab switches.
import {
  db,
  readyAuth,
  collection,
  doc,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from "./firebase-init.js";
import { getAccessCode, setAccessCodeDoc } from "./auth.js";
import { toast, escapeHtml, sortMaterials, sortByOrder, formatPhone } from "./util.js";
import { avatarHtml } from "./avatar.js";

let accessCodeField, accessCodeSaveBtn, staffAccountList, newSub, existingSubChips, newName, addBtn, listEl, subCategoryList, seedCard, seedBtn, mainCatSeg, tabBasic, tabFood, subcatOrderCard, subcatOrderList;

let myPhone = "";
let materialsUnsub = null;
let accountsUnsub = null;
let subcatUnsub = null;
let accountsCache = [];

function renderAccounts(accounts) {
  accountsCache = accounts;
  if (accounts.length === 0) {
    staffAccountList.innerHTML = `<div class="empty">등록된 계정이 없어요.</div>`;
    return;
  }
  const sorted = [...accounts].sort((a, b) => {
    if (a.role !== b.role) return a.role === "owner" ? -1 : 1;
    return (a.name || "").localeCompare(b.name || "");
  });
  staffAccountList.innerHTML = sorted
    .map(
      (acc) => `
        <div class="row-between" style="padding:9px 0; border-bottom:1px solid var(--border);">
          <div style="display:flex; align-items:center; gap:10px;">
            ${avatarHtml(acc.phone, acc.name, 32)}
            <div>
              <div style="font-weight:700; font-size:14px;">
                ${escapeHtml(acc.name)}님
                <span class="tag ${acc.role === "owner" ? "role-owner" : "role-staff"}" style="margin-left:4px;">${acc.role === "owner" ? "사장님" : "직원"}</span>
                ${acc.phone === myPhone ? `<span style="font-size:11px; color:var(--muted);">(나)</span>` : ""}
              </div>
              <div style="font-size:12px; color:var(--muted); margin-top:2px;">${formatPhone(acc.phone)}</div>
            </div>
          </div>
          ${acc.phone === myPhone ? "" : `<button class="icon-btn" data-del-account="${acc.phone}" style="color:var(--urgent);">삭제</button>`}
        </div>`
    )
    .join("");
  staffAccountList.querySelectorAll("[data-del-account]").forEach((el) => {
    el.addEventListener("click", async () => {
      const phone = el.dataset.delAccount;
      const acc = accountsCache.find((a) => a.phone === phone);
      if (!acc) return;
      if (!confirm(`'${acc.name}'님 계정을 삭제할까요? 이 번호로 다시 로그인하면 신규 가입으로 처리돼요.`)) return;
      await deleteDoc(doc(db, "accounts", phone));
      toast("계정을 삭제했어요");
    });
  });
}

let selectedMainCat = "기본자재";
let listFilterCat = "기본자재";
let subcategoryOrder = {}; // { 기본자재: string[], 식자재: string[] } from config/subcategoryOrder

const DEFAULT_MATERIALS = [
  // 기본자재 - 컵
  { name: "아이스S컵", mainCategory: "기본자재", subCategory: "컵" },
  { name: "아이스M컵", mainCategory: "기본자재", subCategory: "컵" },
  { name: "아이스L컵", mainCategory: "기본자재", subCategory: "컵" },
  { name: "핫S컵", mainCategory: "기본자재", subCategory: "컵" },
  { name: "핫M컵", mainCategory: "기본자재", subCategory: "컵" },
  { name: "핫L컵", mainCategory: "기본자재", subCategory: "컵" },
  // 기본자재 - 뚜껑
  { name: "일반돔뚜껑", mainCategory: "기본자재", subCategory: "뚜껑" },
  { name: "라지돔뚜껑", mainCategory: "기본자재", subCategory: "뚜껑" },
  { name: "핫뚜껑", mainCategory: "기본자재", subCategory: "뚜껑" },
  // 기본자재 - 빨대
  { name: "일반빨대", mainCategory: "기본자재", subCategory: "빨대" },
  { name: "스틱빨대", mainCategory: "기본자재", subCategory: "빨대" },
  // 기본자재 - 감열지
  { name: "감열지", mainCategory: "기본자재", subCategory: "감열지" },
  // 기본자재 - 냅킨
  { name: "냅킨", mainCategory: "기본자재", subCategory: "냅킨" },
  // 기본자재 - 원두
  { name: "일반원두", mainCategory: "기본자재", subCategory: "원두" },
  { name: "디카원두", mainCategory: "기본자재", subCategory: "원두" },
  // 기본자재 - 기타
  { name: "라텍스장갑", mainCategory: "기본자재", subCategory: "기타" },
  { name: "주방세제", mainCategory: "기본자재", subCategory: "기타" },
  { name: "핸드워시", mainCategory: "기본자재", subCategory: "기타" },
  { name: "가스켓", mainCategory: "기본자재", subCategory: "기타" },
  { name: "스팀행주", mainCategory: "기본자재", subCategory: "기타" },
  { name: "일반행주", mainCategory: "기본자재", subCategory: "기타" },

  // 식자재 - 파우더
  { name: "헤이즐넛P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "곡물P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "초코퍼지P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "체리콕P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "말차P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "토피넛P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "버터P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "믹스P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "요거트P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "민트초코P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "밀크쉐이크P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "자바칩P", mainCategory: "식자재", subCategory: "파우더" },
  { name: "립톤아이스티", mainCategory: "식자재", subCategory: "파우더" },
  // 식자재 - 시럽/소스
  { name: "슈가시럽", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "레몬밤", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "깔라만시", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "꿀", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "바닐라", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "아몬드", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "모카소스", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "솔티카라멜소스", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "솔티카라멜시럽", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "패션후르츠", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "장수오미자", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "블루베리", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "블루시럽", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "밤", mainCategory: "식자재", subCategory: "시럽/소스" },
  { name: "연유", mainCategory: "식자재", subCategory: "시럽/소스" },
  // 식자재 - 베이스
  { name: "자몽", mainCategory: "식자재", subCategory: "베이스" },
  { name: "한라봉", mainCategory: "식자재", subCategory: "베이스" },
  { name: "애플모과", mainCategory: "식자재", subCategory: "베이스" },
  { name: "밀크티", mainCategory: "식자재", subCategory: "베이스" },
  { name: "제로아이스티", mainCategory: "식자재", subCategory: "베이스" },
  { name: "유자", mainCategory: "식자재", subCategory: "베이스" },
  { name: "딸기잼", mainCategory: "식자재", subCategory: "베이스" },
  { name: "블루베리잼", mainCategory: "식자재", subCategory: "베이스" },
  { name: "레몬", mainCategory: "식자재", subCategory: "베이스" },
  // 식자재 - 디저트
  { name: "초코스콘", mainCategory: "식자재", subCategory: "디저트" },
  { name: "플레인스콘", mainCategory: "식자재", subCategory: "디저트" },
  { name: "마카다미아 쿠키", mainCategory: "식자재", subCategory: "디저트" },
  { name: "초코칩 쿠키", mainCategory: "식자재", subCategory: "디저트" },
  { name: "말차 초콜릿 쿠키", mainCategory: "식자재", subCategory: "디저트" },
  // 식자재 - 냉동
  { name: "냉동딸기", mainCategory: "식자재", subCategory: "냉동" },
  { name: "냉동베리", mainCategory: "식자재", subCategory: "냉동" },
  { name: "냉동망고", mainCategory: "식자재", subCategory: "냉동" },
  { name: "리얼스무디(배)", mainCategory: "식자재", subCategory: "냉동" },
  { name: "리얼스무디(망고)", mainCategory: "식자재", subCategory: "냉동" },
  { name: "리얼스무디(복숭아)", mainCategory: "식자재", subCategory: "냉동" },
  { name: "딸기요거트젤라또", mainCategory: "식자재", subCategory: "냉동" },
  { name: "바닐라젤라또", mainCategory: "식자재", subCategory: "냉동" },
  // 식자재 - 탄산
  { name: "사이다", mainCategory: "식자재", subCategory: "탄산" },
  { name: "탄산수", mainCategory: "식자재", subCategory: "탄산" },
  { name: "제로콜라", mainCategory: "식자재", subCategory: "탄산" },
  { name: "레드불", mainCategory: "식자재", subCategory: "탄산" },
];

let materials = [];

async function onAddBtnClick() {
  const name = newName.value.trim();
  const subCategory = newSub.value.trim() || "기타";
  if (!name) {
    toast("자재 이름을 입력해주세요");
    return;
  }
  await readyAuth;
  await addDoc(collection(db, "materials"), {
    name,
    mainCategory: selectedMainCat,
    subCategory,
    sortOrder: Date.now(),
    createdAt: serverTimestamp(),
  });
  newName.value = "";
  toast("자재를 추가했어요");
}

async function onSeedBtnClick() {
  await readyAuth;
  const base = Date.now();
  for (let i = 0; i < DEFAULT_MATERIALS.length; i++) {
    await addDoc(collection(db, "materials"), { ...DEFAULT_MATERIALS[i], sortOrder: base + i, createdAt: serverTimestamp() });
  }
  toast("기본 자재를 불러왔어요");
}

let editingId = null;

function startEdit(id) {
  editingId = id;
  render();
}

function cancelEdit() {
  editingId = null;
  render();
}

async function saveEdit(id, value) {
  const trimmed = value.trim();
  if (!trimmed) {
    toast("자재 이름을 입력해주세요");
    return;
  }
  await updateDoc(doc(db, "materials", id), { name: trimmed });
  editingId = null;
  toast("이름을 수정했어요");
  render();
}

async function removeMaterial(id) {
  const m = materials.find((x) => x.id === id);
  if (!m) return;
  if (!confirm(`'${m.name}'을(를) 삭제할까요?`)) return;
  await deleteDoc(doc(db, "materials", id));
  toast("삭제했어요");
}

async function moveMaterial(id, direction) {
  const m = materials.find((x) => x.id === id);
  if (!m) return;
  const siblings = sortMaterials(materials.filter((x) => x.subCategory === m.subCategory && x.mainCategory === m.mainCategory));
  const idx = siblings.findIndex((x) => x.id === id);
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= siblings.length) return;

  // Swap positions, then renumber the whole subcategory with fresh, guaranteed
  // -unique values. Older materials share a sortOrder fallback (same-second
  // creation time) often enough that a plain two-item swap can be a no-op —
  // renumbering everyone sidesteps that entirely.
  [siblings[idx], siblings[targetIdx]] = [siblings[targetIdx], siblings[idx]];
  const base = Date.now();
  await Promise.all(
    siblings.map((sib, i) => updateDoc(doc(db, "materials", sib.id), { sortOrder: base + i }))
  );
}

function renderSubList() {
  const cats = [...new Set(materials.filter((m) => m.mainCategory === selectedMainCat).map((m) => m.subCategory).filter(Boolean))];
  subCategoryList.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");

  existingSubChips.innerHTML = cats.length
    ? cats.map((c) => `<button type="button" class="subcat-chip" data-sub="${escapeHtml(c)}">${escapeHtml(c)}</button>`).join("")
    : `<span style="font-size:12px; color:var(--muted)">이 대분류엔 아직 소분류가 없어요. 위에 새 이름을 입력해서 만들어보세요.</span>`;
  existingSubChips.querySelectorAll("[data-sub]").forEach((el) => {
    el.addEventListener("click", () => {
      newSub.value = el.dataset.sub;
      newName.focus();
    });
  });
}

function subsInCurrentTab() {
  const names = [...new Set(materials.filter((m) => (m.mainCategory || "기본자재") === listFilterCat).map((m) => m.subCategory || "기타"))];
  return sortByOrder(names, subcategoryOrder[listFilterCat]);
}

function renderSubcatOrder() {
  const subs = subsInCurrentTab();
  subcatOrderCard.style.display = subs.length > 1 ? "block" : "none";
  subcatOrderList.innerHTML = subs
    .map(
      (sub, idx) => `
        <div class="admin-row">
          <div class="reorder-btns">
            <button class="icon-btn" data-subaction="up" data-sub="${escapeHtml(sub)}" ${idx === 0 ? "disabled" : ""}>▲</button>
            <button class="icon-btn" data-subaction="down" data-sub="${escapeHtml(sub)}" ${idx === subs.length - 1 ? "disabled" : ""}>▼</button>
          </div>
          <div style="flex:1"><div class="name">${escapeHtml(sub)}</div></div>
        </div>`
    )
    .join("");
  subcatOrderList.querySelectorAll('[data-subaction="up"]').forEach((el) =>
    el.addEventListener("click", () => moveSubcategory(el.dataset.sub, -1))
  );
  subcatOrderList.querySelectorAll('[data-subaction="down"]').forEach((el) =>
    el.addEventListener("click", () => moveSubcategory(el.dataset.sub, 1))
  );
}

async function moveSubcategory(subName, direction) {
  const subs = subsInCurrentTab();
  const idx = subs.indexOf(subName);
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= subs.length) return;
  [subs[idx], subs[targetIdx]] = [subs[targetIdx], subs[idx]];
  await setDoc(doc(db, "config", "subcategoryOrder"), { [listFilterCat]: subs }, { merge: true });
}

function render() {
  seedCard.style.display = materials.length === 0 ? "block" : "none";
  renderSubList();
  renderSubcatOrder();

  const inCat = materials.filter((m) => (m.mainCategory || "기본자재") === listFilterCat);

  if (inCat.length === 0) {
    listEl.innerHTML = `<div class="card"><div class="empty">이 분류에 등록된 자재가 없어요.</div></div>`;
    return;
  }

  const bySub = {};
  for (const m of inCat) {
    const sub = m.subCategory || "기타";
    if (!bySub[sub]) bySub[sub] = [];
    bySub[sub].push(m);
  }

  let html = "";
  for (const sub of sortByOrder(Object.keys(bySub), subcategoryOrder[listFilterCat])) {
    const list = sortMaterials(bySub[sub]);
    html += `
      <div class="subcat-title">
        <span>${escapeHtml(sub)}</span>
        <button class="subcat-add-btn" data-quick-add="${escapeHtml(sub)}" title="이 소분류에 자재 추가">+</button>
      </div>
      <div class="card">`;
    list.forEach((m, idx) => {
      if (m.id === editingId) {
        html += `
          <div class="admin-row">
            <input type="text" class="edit-name-input" data-id="${m.id}" value="${escapeHtml(m.name)}" style="flex:1;" />
            <button class="icon-btn" data-action="save-edit" data-id="${m.id}" style="color:var(--normal);">저장</button>
            <button class="icon-btn" data-action="cancel-edit" data-id="${m.id}">취소</button>
          </div>`;
      } else {
        html += `
          <div class="admin-row">
            <div class="reorder-btns">
              <button class="icon-btn" data-action="up" data-id="${m.id}" ${idx === 0 ? "disabled" : ""}>▲</button>
              <button class="icon-btn" data-action="down" data-id="${m.id}" ${idx === list.length - 1 ? "disabled" : ""}>▼</button>
            </div>
            <div style="flex:1">
              <div class="name">${escapeHtml(m.name)}</div>
            </div>
            <button class="icon-btn" data-action="edit" data-id="${m.id}">수정</button>
            <button class="icon-btn" data-action="delete" data-id="${m.id}">삭제</button>
          </div>`;
      }
    });
    html += `</div>`;
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll("[data-quick-add]").forEach((el) =>
    el.addEventListener("click", () => {
      // The add-form's own 대분류 선택은 목록 탭과 독립이라, 이 소분류가 속한
      // 탭으로 맞춰주지 않으면 엉뚱한 대분류에 추가돼버린다.
      selectedMainCat = listFilterCat;
      mainCatSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b.dataset.val === listFilterCat));
      renderSubList();
      newSub.value = el.dataset.quickAdd;
      newName.scrollIntoView({ behavior: "smooth", block: "center" });
      newName.focus();
    })
  );
  listEl.querySelectorAll('[data-action="edit"]').forEach((el) =>
    el.addEventListener("click", () => startEdit(el.dataset.id))
  );
  listEl.querySelectorAll('[data-action="cancel-edit"]').forEach((el) =>
    el.addEventListener("click", cancelEdit)
  );
  listEl.querySelectorAll('[data-action="save-edit"]').forEach((el) =>
    el.addEventListener("click", () => {
      const input = listEl.querySelector(`.edit-name-input[data-id="${el.dataset.id}"]`);
      saveEdit(el.dataset.id, input.value);
    })
  );
  const editInput = listEl.querySelector(".edit-name-input");
  if (editInput) {
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
    editInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) saveEdit(editInput.dataset.id, editInput.value);
      if (e.key === "Escape") cancelEdit();
    });
  }
  listEl.querySelectorAll('[data-action="delete"]').forEach((el) =>
    el.addEventListener("click", () => removeMaterial(el.dataset.id))
  );
  listEl.querySelectorAll('[data-action="up"]').forEach((el) =>
    el.addEventListener("click", () => moveMaterial(el.dataset.id, -1))
  );
  listEl.querySelectorAll('[data-action="down"]').forEach((el) =>
    el.addEventListener("click", () => moveMaterial(el.dataset.id, 1))
  );
}

export function mount(account) {
  myPhone = account.phone;

  document.getElementById("pageSub").textContent = "자재 카탈로그 관리";

  accessCodeField = document.getElementById("accessCodeField");
  accessCodeSaveBtn = document.getElementById("accessCodeSaveBtn");
  staffAccountList = document.getElementById("staffAccountList");
  newSub = document.getElementById("newSub");
  existingSubChips = document.getElementById("existingSubChips");
  newName = document.getElementById("newName");
  addBtn = document.getElementById("addBtn");
  listEl = document.getElementById("materialAdminList");
  subCategoryList = document.getElementById("subCategoryList");
  seedCard = document.getElementById("seedCard");
  seedBtn = document.getElementById("seedBtn");
  mainCatSeg = document.getElementById("mainCatSeg");
  tabBasic = document.getElementById("tabBasic");
  tabFood = document.getElementById("tabFood");
  subcatOrderCard = document.getElementById("subcatOrderCard");
  subcatOrderList = document.getElementById("subcatOrderList");

  selectedMainCat = "기본자재";
  listFilterCat = "기본자재";
  editingId = null;

  accessCodeSaveBtn.addEventListener("click", async () => {
    const code = accessCodeField.value.trim();
    if (!code) {
      toast("가입 코드를 입력해주세요");
      return;
    }
    accessCodeSaveBtn.disabled = true;
    try {
      await setAccessCodeDoc(code);
      toast("가입 코드가 저장됐어요");
    } finally {
      accessCodeSaveBtn.disabled = false;
    }
  });
  getAccessCode().then((code) => { if (code) accessCodeField.value = code; });

  mainCatSeg.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedMainCat = btn.dataset.val;
      mainCatSeg.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      renderSubList();
    });
  });

  tabBasic.addEventListener("click", () => { listFilterCat = "기본자재"; tabBasic.classList.add("active"); tabFood.classList.remove("active"); render(); });
  tabFood.addEventListener("click", () => { listFilterCat = "식자재"; tabFood.classList.add("active"); tabBasic.classList.remove("active"); render(); });

  addBtn.addEventListener("click", onAddBtnClick);
  seedBtn.addEventListener("click", onSeedBtnClick);

  materialsUnsub = onSnapshot(collection(db, "materials"), (snap) => {
    materials = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  });
  accountsUnsub = onSnapshot(collection(db, "accounts"), (snap) => {
    renderAccounts(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
  subcatUnsub = onSnapshot(doc(db, "config", "subcategoryOrder"), (snap) => {
    subcategoryOrder = snap.exists() ? snap.data() : {};
    render();
  });
}

export function unmount() {
  if (materialsUnsub) { materialsUnsub(); materialsUnsub = null; }
  if (accountsUnsub) { accountsUnsub(); accountsUnsub = null; }
  if (subcatUnsub) { subcatUnsub(); subcatUnsub = null; }
}
