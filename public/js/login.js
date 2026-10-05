import { fetchAccount, registerAccount, setStaffPin, getOwnerPin, setOwnerPinDoc, getAccessCode, normalizePhone } from "./auth.js";
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
let pendingOwnerAccount = null;
let pendingStaffAccount = null;
let isCreatingPin = false; // owner registration: reusing the shared owner PIN vs creating it
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
    const existing = await fetchAccount(phone);
    if (existing) {
      if (existing.role === "owner") {
        pendingOwnerAccount = existing;
        const realPin = await getOwnerPin();
        ownerLoginLabel.textContent = realPin
          ? "사장님 계정이에요. PIN을 입력하세요"
          : "PIN이 아직 없어요. 지금 입력하는 숫자가 새 PIN이 됩니다 (4자리 이상)";
        phoneStep.classList.remove("show");
        ownerLoginBox.classList.add("show");
        ownerLoginPin.focus();
      } else {
        pendingStaffAccount = existing;
        isCreatingStaffLoginPin = !existing.pin;
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
      pendingPhone = phone;
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
    const realPin = await getOwnerPin();
    if (!realPin) {
      // No PIN has ever been set (e.g. an owner account from before PIN creation
      // existed) — treat this entry as creating it now.
      await setOwnerPinDoc(pin);
      setAccount(pendingOwnerAccount);
      goTo("owner");
      return;
    }
    if (pin === realPin) {
      setAccount(pendingOwnerAccount);
      goTo("owner");
      return;
    }
    toast("PIN이 올바르지 않아요");
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
      await setStaffPin(pendingStaffAccount.phone, pin);
      setAccount({ ...pendingStaffAccount, pin });
      goTo("staff");
      return;
    }
    if (pin === pendingStaffAccount.pin) {
      setAccount(pendingStaffAccount);
      goTo("staff");
      return;
    }
    toast("PIN이 올바르지 않아요");
    staffLoginPin.value = "";
  } finally {
    staffLoginConfirm.disabled = false;
  }
});

async function verifyAccessCode() {
  const entered = accessCodeInput.value.trim();
  const realCode = await getAccessCode();
  if (!realCode) {
    toast("아직 가입 코드가 설정되지 않았어요. 사장님에게 문의해주세요");
    return false;
  }
  if (entered !== realCode) {
    toast("가입 코드가 올바르지 않아요");
    return false;
  }
  return true;
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
  isCreatingPin = true;
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
  if (!ok) {
    pickOwner.disabled = false;
    return;
  }
  const existingPin = await getOwnerPin();
  pickOwner.disabled = false;
  pendingRole = "owner";
  isCreatingPin = !existingPin;

  if (isCreatingPin) {
    pinBoxLabel.textContent = "아직 사장님 PIN이 없어요. 새로 만들어주세요 (숫자 4자리 이상)";
    pinConfirmInput.style.display = "block";
    pinInput.placeholder = "새 PIN";
    pinConfirm.textContent = "PIN 만들고 시작하기";
  } else {
    pinBoxLabel.textContent = "사장님 PIN을 입력하세요";
    pinConfirmInput.style.display = "none";
    pinInput.placeholder = "PIN";
    pinConfirm.textContent = "가입 완료";
  }

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

  if (pendingRole === "staff") {
    // 항상 새로 만드는 개인 PIN이라 확인 입력과 일치하는지만 본다.
    const confirmPin = pinConfirmInput.value.trim();
    if (pin !== confirmPin) {
      toast("PIN이 서로 달라요. 다시 입력해주세요");
      pinInput.value = "";
      pinConfirmInput.value = "";
      return;
    }
    const account = await registerAccount({ phone: pendingPhone, name, role: "staff", pin });
    setAccount(account);
    // 신규 가입 직후에만 모리가 탭을 소개해주는 온보딩을 띄운다 — 이미
    // 계정 있는 사람의 재로그인(goTo("staff"))과는 분리된, 여기뿐인 경로라
    // 따로 추측할 필요 없이 정확히 "방금 가입한 사람"만 잡아낼 수 있다.
    location.href = "staff.html?onboarding=1";
    return;
  }

  if (isCreatingPin) {
    const confirmPin = pinConfirmInput.value.trim();
    if (pin !== confirmPin) {
      toast("PIN이 서로 달라요. 다시 입력해주세요");
      pinInput.value = "";
      pinConfirmInput.value = "";
      return;
    }
    await setOwnerPinDoc(pin);
  } else {
    const realPin = await getOwnerPin();
    if (!realPin || pin !== realPin) {
      toast("PIN이 올바르지 않아요");
      pinInput.value = "";
      return;
    }
  }

  const account = await registerAccount({ phone: pendingPhone, name, role: "owner" });
  setAccount(account);
  goTo("owner");
}

pinConfirm.addEventListener("click", confirmRegisterPin);
pinInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && pinConfirmInput.style.display === "none") confirmRegisterPin(); });
pinConfirmInput.addEventListener("keydown", (e) => { if (e.key === "Enter") confirmRegisterPin(); });
ownerLoginPin.addEventListener("keydown", (e) => { if (e.key === "Enter") ownerLoginConfirm.click(); });
staffLoginPin.addEventListener("keydown", (e) => { if (e.key === "Enter" && staffLoginPinConfirm.style.display === "none") staffLoginConfirm.click(); });
staffLoginPinConfirm.addEventListener("keydown", (e) => { if (e.key === "Enter") staffLoginConfirm.click(); });
phoneInput.addEventListener("keydown", (e) => { if (e.key === "Enter") phoneNext.click(); });
