import { fetchAccount, lookupAccountForLogin, ownerLogin, staffLogin, staffCreatePinAndLogin, checkAccessCode, registerAccount, normalizePhone } from "./auth.js";
import { getAccount, setAccount, clearAccount, toast } from "./util.js";

const phoneStep = document.getElementById("phoneStep");
const phoneInput = document.getElementById("phoneInput");
const phoneNext = document.getElementById("phoneNext");

const ownerLoginBox = document.getElementById("ownerLoginBox");
const ownerLoginLabel = document.getElementById("ownerLoginLabel");
const ownerLoginPin = document.getElementById("ownerLoginPin");
const ownerLoginConfirm = document.getElementById("ownerLoginConfirm");

const staffLoginBox = document.getElementById("staffLoginBox");
const staffLoginLabel = document.getElementById("staffLoginLabel");
const staffLoginPin = document.getElementById("staffLoginPin");
const staffLoginPinConfirm = document.getElementById("staffLoginPinConfirm");
const staffLoginConfirm = document.getElementById("staffLoginConfirm");

const registerStep = document.getElementById("registerStep");
const nameInput = document.getElementById("nameInput");
const accessCodeInput = document.getElementById("accessCodeInput");
const pickStaff = document.getElementById("pickStaff");
const pickOwner = document.getElementById("pickOwner");
const pinBox = document.getElementById("pinBox");
const pinBoxLabel = document.getElementById("pinBoxLabel");
const pinInput = document.getElementById("pinInput");
const pinConfirmInput = document.getElementById("pinConfirmInput");
const pinConfirm = document.getElementById("pinConfirm");
const lockNote = document.getElementById("lockNote");

let pendingPhone = null;
let pendingRole = null; // "owner" | "staff" — which role is being registered in the pinBox step
let isCreatingStaffLoginPin = false; // existing staff account logging in but has no personal PIN yet

function goTo(role) {
  location.href = role === "owner" ? "owner.html" : "staff.html";
}

// If this device already has an account, re-check it's still valid so we can
// skip straight in — but the redirect itself waits for the splash tap below
// (see dismissSplash) so returning users still see the splash every time
// instead of it getting cut off by an instant navigation.
let autoLoginRole = null;
const autoLoginCheck = (async () => {
  const cached = getAccount();
  if (!cached || !cached.phone) return;
  lockNote.textContent = "로그인 확인 중...";
  try {
    const fresh = await fetchAccount(cached.phone);
    // 직원 계정인데 PIN이 없으면(캐시가 아직 이전 세션 기준) 자동 로그인시키지
    // 않고 아래 수동 로그인 흐름으로 넘겨서 PIN 등록을 거치게 한다.
    if (fresh && (fresh.role === "owner" || fresh.pin)) {
      setAccount(fresh);
      autoLoginRole = fresh.role;
      return;
    }
    clearAccount();
  } catch (e) {
    // network hiccup: let them log in manually below
  }
  lockNote.textContent = "전화번호로 등록하면 어떤 기기로 로그인해도 같은 화면이 떠요";
})();

document.getElementById("splashScreen").addEventListener("click", async function dismissSplash() {
  this.classList.add("hide");
  await autoLoginCheck;
  if (autoLoginRole) goTo(autoLoginRole);
}, { once: true });

phoneNext.addEventListener("click", async () => {
  const phone = normalizePhone(phoneInput.value);
  if (!/^010\d{8}$/.test(phone)) {
    toast("010으로 시작하는 11자리 번호를 입력해주세요");
    return;
  }
  phoneNext.disabled = true;
  phoneNext.textContent = "확인 중...";
  try {
    const info = await lookupAccountForLogin(phone);
    pendingPhone = phone;
    if (info.exists) {
      if (info.role === "owner") {
        ownerLoginLabel.textContent = info.hasPin
          ? "사장님 계정이에요. PIN을 입력하세요"
          : "PIN이 아직 없어요. 지금 입력하는 숫자가 새 PIN이 됩니다 (4자리 이상)";
        phoneStep.classList.remove("show");
        ownerLoginBox.classList.add("show");
        ownerLoginPin.focus();
      } else {
        isCreatingStaffLoginPin = !info.hasPin;
        if (isCreatingStaffLoginPin) {
          staffLoginLabel.textContent = "보안을 위해 본인만의 PIN을 새로 등록해주세요 (숫자 4자리 이상)";
          staffLoginPinConfirm.style.display = "block";
          staffLoginPin.placeholder = "새 PIN";
          staffLoginConfirm.textContent = "PIN 만들고 로그인";
        } else {
          staffLoginLabel.textContent = "PIN을 입력하세요";
          staffLoginPinConfirm.style.display = "none";
          staffLoginPin.placeholder = "PIN";
          staffLoginConfirm.textContent = "로그인";
        }
        phoneStep.classList.remove("show");
        staffLoginBox.classList.add("show");
        staffLoginPin.focus();
      }
    } else {
      phoneStep.classList.remove("show");
      registerStep.style.display = "block";
    }
  } catch (e) {
    toast("연결에 실패했어요. 잠시 후 다시 시도해주세요");
  } finally {
    phoneNext.disabled = false;
    phoneNext.textContent = "다음";
  }
});

ownerLoginConfirm.addEventListener("click", async () => {
  const pin = ownerLoginPin.value.trim();
  if (pin.length < 4) {
    toast("PIN은 숫자 4자리 이상으로 입력해주세요");
    return;
  }
  ownerLoginConfirm.disabled = true;
  try {
    const account = await ownerLogin(pendingPhone, pin);
    setAccount(account);
    goTo("owner");
  } catch (e) {
    toast(e.message || "PIN이 올바르지 않아요");
    ownerLoginPin.value = "";
  } finally {
    ownerLoginConfirm.disabled = false;
  }
});

staffLoginConfirm.addEventListener("click", async () => {
  const pin = staffLoginPin.value.trim();
  if (pin.length < 4) {
    toast("PIN은 숫자 4자리 이상으로 입력해주세요");
    return;
  }
  staffLoginConfirm.disabled = true;
  try {
    if (isCreatingStaffLoginPin) {
      const confirmPin = staffLoginPinConfirm.value.trim();
      if (pin !== confirmPin) {
        toast("PIN이 서로 달라요. 다시 입력해주세요");
        staffLoginPin.value = "";
        staffLoginPinConfirm.value = "";
        return;
      }
      const account = await staffCreatePinAndLogin(pendingPhone, pin);
      setAccount(account);
      goTo("staff");
      return;
    }
    const account = await staffLogin(pendingPhone, pin);
    setAccount(account);
    goTo("staff");
  } catch (e) {
    toast(e.message || "PIN이 올바르지 않아요");
    staffLoginPin.value = "";
  } finally {
    staffLoginConfirm.disabled = false;
  }
});

async function verifyAccessCode() {
  const entered = accessCodeInput.value.trim();
  if (!entered) {
    toast("가입 코드를 입력해주세요");
    return false;
  }
  try {
    const valid = await checkAccessCode(entered);
    if (!valid) toast("가입 코드가 올바르지 않아요");
    return valid;
  } catch (e) {
    toast("연결에 실패했어요. 잠시 후 다시 시도해주세요");
    return false;
  }
}

pickStaff.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    toast("이름을 입력해주세요");
    return;
  }
  pickStaff.disabled = true;
  const ok = await verifyAccessCode();
  pickStaff.disabled = false;
  if (!ok) return;

  // 직원은 (공유되는 사장님 PIN과 달리) 본인만의 PIN을 새로 만든다.
  pendingRole = "staff";
  pinBoxLabel.textContent = "본인만의 PIN을 만들어주세요 (숫자 4자리 이상)";
  pinConfirmInput.style.display = "block";
  pinInput.placeholder = "새 PIN";
  pinConfirm.textContent = "PIN 만들고 시작하기";
  pinBox.classList.add("show");
  pinInput.focus();
  pinBox.scrollIntoView({ behavior: "smooth", block: "center" });
});

pickOwner.addEventListener("click", async () => {
  const name = nameInput.value.trim();
  if (!name) {
    toast("이름을 입력해주세요");
    return;
  }
  pickOwner.disabled = true;
  const ok = await verifyAccessCode();
  pickOwner.disabled = false;
  if (!ok) return;

  // 이 매장에 사장님 PIN이 이미 있는지는 storeId를 먼저 알아야 서버에서나
  // 확인할 수 있어서(가입 코드로 매장을 가리기 전까진 비인증 상태로는
  // 알 길이 없다), 미리보기로 "새로 만드는지/기존 PIN인지"를 구분해 보여주는
  // 대신 — 실제 검증·생성은 registerAccount가 한 번에 서버에서 처리하고,
  // 여기선 오타 방지용으로 확인 입력만 받는다.
  pendingRole = "owner";
  pinBoxLabel.textContent = "사장님 PIN을 입력하세요 (매장에 처음 등록하는 사장님이면, 지금 입력한 값이 새 PIN이 됩니다)";
  pinConfirmInput.style.display = "block";
  pinInput.placeholder = "PIN";
  pinConfirm.textContent = "가입 완료";

  pinBox.classList.add("show");
  pinInput.focus();
  pinBox.scrollIntoView({ behavior: "smooth", block: "center" });
});

async function confirmRegisterPin() {
  const name = nameInput.value.trim();
  const pin = pinInput.value.trim();

  if (pin.length < 4) {
    toast("PIN은 숫자 4자리 이상으로 입력해주세요");
    return;
  }

  const confirmPin = pinConfirmInput.value.trim();
  if (pin !== confirmPin) {
    toast("PIN이 서로 달라요. 다시 입력해주세요");
    pinInput.value = "";
    pinConfirmInput.value = "";
    return;
  }

  const accessCode = accessCodeInput.value.trim();
  pinConfirm.disabled = true;
  try {
    const account = await registerAccount({ phone: pendingPhone, name, role: pendingRole, accessCode, pin });
    setAccount(account);
    if (pendingRole === "staff") {
      // 신규 가입 직후에만 모리가 탭을 소개해주는 온보딩을 띄운다 — 이미
      // 계정 있는 사람의 재로그인(goTo("staff"))과는 분리된, 여기뿐인 경로라
      // 따로 추측할 필요 없이 정확히 "방금 가입한 사람"만 잡아낼 수 있다.
      location.href = "staff.html?onboarding=1";
    } else {
      goTo("owner");
    }
  } catch (e) {
    toast(e.message || "가입에 실패했어요");
    pinInput.value = "";
    pinConfirmInput.value = "";
  } finally {
    pinConfirm.disabled = false;
  }
}

pinConfirm.addEventListener("click", confirmRegisterPin);
pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && pinConfirmInput.style.display === "none") confirmRegisterPin(); });
pinConfirmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRegisterPin(); });
ownerLoginPin.addEventListener("keydown", (e) => { if (e.key === "Enter") ownerLoginConfirm.click(); });
staffLoginPin.addEventListener("keydown", (e) => { if (e.key === "Enter" && staffLoginPinConfirm.style.display === "none") staffLoginConfirm.click(); });
staffLoginPinConfirm.addEventListener("keydown", (e) => { if (e.key === "Enter") staffLoginConfirm.click(); });
phoneInput.addEventListener("keydown", (e) => { if (e.key === "Enter") phoneNext.click(); });

// 로그인 화면은 html/body를 고정해서(스크롤 자체가 없음 — iOS 바운스
// 방지, index.html의 <head> 참고) 다른 화면들처럼 register-sw.js의
// scrollIntoView() 포커스 핸들러가 먹히지 않는다 — 스크롤할 대상 자체가
// 없기 때문. 그래서 키보드가 처음 올라올 때 입력창을 가려도 아무것도
// 못 움직이다가, 키보드가 이미 떠있는 상태로 다시 탭하면(브라우저의
// 네이티브 보정이 뒤늦게 걸리는 걸로 추정) 그제서야 보이는 현상이
// 생겼다. visualViewport로 키보드가 실제로 줄인 높이를 직접 재서,
// 포커스된 입력창이 그 안에 들어오도록 .role-hero를 위로 밀어 올린다.
(function setupLoginKeyboardAvoidance() {
  if (!window.visualViewport) return;
  const roleHero = document.querySelector(".role-hero");
  if (!roleHero) return;
  const vv = window.visualViewport;
  let focusedEl = null;

  function reposition() {
    if (!focusedEl) return;
    // 매번 원래(안 밀린) 위치 기준으로 다시 계산한다 — 이전에 적용한
    // translateY 값 위에 또 더하면(누적) resize 이벤트가 여러 번 걸릴 때
    // (키보드 애니메이션 도중 계속 발생) 매번 더 밀려서 과하게 올라간다.
    roleHero.style.transform = "";
    const rect = focusedEl.getBoundingClientRect();
    const visibleBottom = vv.height + vv.offsetTop;
    const overlap = rect.bottom - visibleBottom;
    roleHero.style.transform = overlap > 0 ? `translateY(-${overlap + 16}px)` : "";
  }

  document.addEventListener("focusin", (e) => {
    if (!e.target.matches || !e.target.matches("input, textarea")) return;
    focusedEl = e.target;
    roleHero.style.transition = "transform .2s ease";
    // 키보드 애니메이션이 끝나기 전에 재면 visualViewport.height가 아직
    // 줄어들기 전 값이라 잘못 계산된다 — resize 이벤트가 그 변화를
    // 실시간으로 계속 알려주므로 그쪽이 메인이고, 이건 이미 키보드가
    // 떠있는 상태에서 다른 입력창으로 옮겨가는 경우를 위한 즉시 보정.
    requestAnimationFrame(reposition);
  });

  document.addEventListener("focusout", (e) => {
    if (focusedEl !== e.target) return;
    focusedEl = null;
    roleHero.style.transform = "";
  });

  vv.addEventListener("resize", reposition);
  vv.addEventListener("scroll", reposition);
})();
