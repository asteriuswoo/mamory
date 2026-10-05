// 뷰포트의 user-scalable=no만으로는 iOS Safari에서 두 손가락 핀치줌을 완전히
// 막지 못해서, 제스처 이벤트 자체를 막는다 — 목록을 스크롤하다 손가락이
// 두 개 닿으면 의도치 않게 살짝 확대됐다가 다시 축소해야 하는 불편이 있었다.
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener("gesturechange", (e) => e.preventDefault());

if ("serviceWorker" in navigator) {
  let swReg = null;

  // updateViaCache: "none" makes the browser bypass HTTP cache when checking
  // sw.js itself for changes, regardless of any Cache-Control on that file.
  navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
    swReg = reg;
    // Force an immediate check for a new sw.js instead of waiting for the
    // browser's normal (slow, throttled) background check. Combined with
    // skipWaiting()/clients.claim() in sw.js, this lets an already-installed
    // home-screen app pick up a new deploy the next time it's opened.
    reg.update().catch(() => {});
  }).catch(() => {});

  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloaded) return;
    reloaded = true;
    location.reload();
  });

  // A home-screen PWA is usually resumed from a frozen background state
  // rather than freshly loaded, so the check above (which only runs once,
  // at load time) is often never re-run. Re-check every time the app comes
  // back to the foreground instead.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && swReg) {
      swReg.update().catch(() => {});
    }
  });
}

window.forceAppRefresh = function () {
  if ("caches" in window) {
    caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
  }
  location.reload();
};

// 모바일 키보드가 올라오면 입력창이 가려지거나, 밑에 깔린 목록(검색 결과,
// 댓글 목록 등)이 잘 안 보인다는 피드백이 있어서 입력창에 포커스가 가면
// 잠깐 기다렸다가 화면 중앙쯤 보이도록 스크롤한다 — 어느 화면의
// input/textarea든 공통으로 적용되게 여기(모든 페이지에서 로드되는
// 스크립트)에 둔다.
//
// 원래는 "빈 공간 탭하면 키보드 내려가게" 하는 전역 touchstart 리스너도
// 같이 있었는데, 그걸 추가한 직후부터 홈화면 설치 앱(standalone PWA)에서
// 사진첨부(네이티브 포토 피커)가 "사진을 로드할 수 없음"으로 실패하는
// 문제가 생겼다 — 모든 터치마다 끼어드는 document 레벨 touchstart 리스너가
// iOS의 더 엄격한 standalone 웹뷰 제스처 신뢰 체인을 건드려서, 뒤이은
// input.click()이 "진짜 사용자 제스처"로 인정 안 되는 것으로 추정된다.
// 버튼/사진첨부처럼 중요한 네이티브 상호작용을 건드릴 수 있어 제거했다.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!el.matches || !el.matches("input, textarea")) return;
  setTimeout(() => {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 300);
});

// 홈화면에 추가한(standalone) PWA는 브라우저 주소창이 없어서 크롬/사파리의
// 기본 "당겨서 새로고침" 제스처도 같이 사라진다 — 그래서 화면 맨 위에서
// 아래로 당기면 새로고침되는 동작을 직접 만든다. 페이지 맨 위(scrollTop
// 0)에서 시작한 드래그만 인정해서 평소 스크롤과 안 겹치게 한다.
//
// 발주 트렌드·근무 등록 같은 바텀시트(.payroll-form-sheet)는 X 버튼과는
// 별개로 아래로 스와이프해도 닫히게 해달라는 요청이 있어서, 같은 터치
// 제스처를 여기서 함께 처리한다 — 터치가 시작된 지점이 열려있는 시트
// 안인지 페이지 맨 위인지를 touchstart에서 한 번만 판정해 "sheet" 모드와
// "refresh" 모드로 나누면, 손 하나의 제스처가 둘 다를 동시에 건드리는
// 충돌 없이 깔끔하게 갈린다.
(function setupTouchGestures() {
  const REFRESH_DISTANCE = 170; // 이만큼 당기면 손을 떼는 순간 새로고침 — 살짝 스크롤/핀치줌 중 실수로 안 걸리게 넉넉하게 잡음
  const REFRESH_INDICATOR_HEIGHT = 84; // 텍스트만 있을 때보다 더 여유 있게 — 로딩 그림이 들어갈 공간
  const SHEET_DISMISS_DISTANCE = 80; // 이만큼 시트를 내리면 손을 떼는 순간 닫힘

  let mode = null; // "refresh" | "sheet" | null
  let startY = null;
  let thresholdCrossed = false; // 새로고침 기준선을 넘는 "그 순간"에만 한 번 진동하기 위한 플래그
  let sheetEl = null;

  // iOS Safari는 Vibration API 자체를 지원하지 않아(홈화면에 추가해도 동일)
  // 이 기기에서는 조용히 아무 일도 안 일어난다 — 안드로이드에서만 느껴진다.
  function vibrateOnce(ms) {
    if (navigator.vibrate) navigator.vibrate(ms);
  }

  const indicator = document.createElement("div");
  indicator.id = "pullRefreshIndicator";
  indicator.innerHTML = `<div class="pull-refresh-spinner"></div><div class="pull-refresh-text">아래로 당겨서 새로고침</div>`;
  document.body.appendChild(indicator);
  const spinner = indicator.querySelector(".pull-refresh-spinner");
  const text = indicator.querySelector(".pull-refresh-text");

  function pageScrollTop() {
    return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  // 핀치줌처럼 손가락이 두 개 이상 닿으면 즉시 제스처를 무효화한다 — 그대로
  // 두면 확대/축소하려고 짚은 첫 손가락의 Y좌표 변화를 당겨서-새로고침으로
  // 오인해서, 줌을 할 때마다 새로고침이 걸리는 원인이 됐다.
  function cancelGesture() {
    if (mode === "sheet" && sheetEl) {
      sheetEl.style.transition = "transform .15s ease";
      sheetEl.style.transform = "";
    } else if (mode === "refresh") {
      indicator.style.transition = "transform .12s ease";
      indicator.style.transform = `translateY(-${REFRESH_INDICATOR_HEIGHT}px)`;
    }
    mode = null;
    sheetEl = null;
    startY = null;
  }

  document.addEventListener("touchstart", (e) => {
    if (e.touches.length > 1) {
      cancelGesture();
      return;
    }
    const sheet = e.target.closest(".payroll-form-sheet");
    if (sheet && (sheet.scrollTop || 0) === 0) {
      mode = "sheet";
      sheetEl = sheet;
      sheetEl.style.transition = "none"; // 드래그 중엔 손가락을 바로 따라가야 자연스럽다
    } else if (pageScrollTop() === 0) {
      mode = "refresh";
      indicator.style.transition = "none";
      spinner.classList.remove("spinning");
    } else {
      mode = null;
      sheetEl = null;
    }
    startY = e.touches[0].clientY;
    thresholdCrossed = false;
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (e.touches.length > 1) {
      cancelGesture();
      return;
    }
    if (!mode || startY === null) return;
    const dy = e.touches[0].clientY - startY;

    if (mode === "sheet") {
      sheetEl.style.transform = dy > 0 ? `translateY(${dy}px)` : "";
      return;
    }

    if (dy <= 0) {
      indicator.style.transform = `translateY(-${REFRESH_INDICATOR_HEIGHT}px)`;
      thresholdCrossed = false;
      return;
    }
    const progress = Math.min(dy / REFRESH_DISTANCE, 1);
    indicator.style.transform = `translateY(${(progress - 1) * REFRESH_INDICATOR_HEIGHT}px)`;
    spinner.style.transform = `rotate(${progress * 360}deg)`;
    if (progress >= 1) {
      text.textContent = "놓으면 새로고침";
      if (!thresholdCrossed) {
        thresholdCrossed = true; // 당기는 도중 기준선을 막 넘은 순간에만 한 번 울린다
        vibrateOnce(12);
      }
    } else {
      text.textContent = "아래로 당겨서 새로고침";
      thresholdCrossed = false; // 다시 기준선 아래로 내려가면, 또 넘을 때 다시 울릴 수 있게 리셋
    }
  }, { passive: true });

  document.addEventListener("touchend", (e) => {
    if (!mode || startY === null) return;
    const dy = e.changedTouches[0].clientY - startY;

    if (mode === "sheet") {
      sheetEl.style.transition = "transform .15s ease";
      if (dy >= SHEET_DISMISS_DISTANCE) {
        sheetEl.style.transform = "";
        const closeBtn = sheetEl.querySelector(".payroll-form-close-btn");
        if (closeBtn) closeBtn.click();
        else {
          const overlay = sheetEl.closest(".payroll-form-overlay");
          if (overlay) overlay.click();
        }
      } else {
        sheetEl.style.transform = "";
      }
      mode = null;
      sheetEl = null;
      startY = null;
      return;
    }

    indicator.style.transition = "transform .12s ease"; // 손 뗀 뒤 스냅 애니메이션 복원
    if (dy >= REFRESH_DISTANCE) {
      text.textContent = "새로고침 중...";
      indicator.style.transform = "translateY(0)";
      spinner.style.transform = "";
      spinner.classList.add("spinning");
      window.forceAppRefresh();
    } else {
      indicator.style.transform = `translateY(-${REFRESH_INDICATOR_HEIGHT}px)`;
    }
    mode = null;
    startY = null;
  }, { passive: true });
})();
