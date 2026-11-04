// 오늘의 노래 — 상단 헤더에 늘 떠있는 작은 뮤직바. 평일엔 진우→하린→유리
// 순서로, 주말엔 지안만 그날의 곡을 고를 수 있다(유튜브 검색 후 선택).
// 한 번 고르면 그날은 모두에게 같은 곡이 보이고, 탭하면 재생된다.
//
// 이 순서 제한은 지금 팀 규모에 맞춘 가벼운 장치라 — 나중에 매장/직원이
// 늘어나면 SONG_PICKER_* 설정을 통째로 지우거나 todaysPicker()가 항상
// null을 돌려주게만 바꾸면(= 누구나 고를 수 있게) 바로 없앨 수 있다.
import { db, doc, setDoc, onSnapshot } from "./firebase-init.js";
import { toast, escapeHtml, todayStr } from "./util.js";

const SEARCH_URL = "https://asia-northeast3-mmth-order.cloudfunctions.net/searchYoutube";

// 2026-11-03(화)부터 진우 시작 — 평일마다 한 명씩 넘어가고 주말은 건너뛴다.
// 화영님을 추가하면서 3일 주기 -> 4일 주기로 길이가 바뀌어, 기준 날짜를
// 이 변경이 적용되는 날로 다시 앵커링했다 — 안 그러면 나머지 세 명의
// 요일별 차례가 과거 기준 그대로 유지되지 않고 뒤섞여버린다(이미 Firestore에
// 저장된 지난 날짜들의 곡 기록 자체는 그대로라 영향 없음).
const SONG_PICKER_START_DATE = "2026-11-03";
const SONG_PICKER_WEEKDAY_ORDER = [
  { phone: "01064082901", name: "진우" },
  { phone: "01083477412", name: "하린" },
  { phone: "01038355240", name: "유리" },
  { phone: "01063285245", name: "화영" },
];
const SONG_PICKER_WEEKEND = { phone: "01071362938", name: "지안" };

function weekdayIndexSince(fromDateStr, toDateStr) {
  const from = new Date(`${fromDateStr}T00:00:00`);
  const to = new Date(`${toDateStr}T00:00:00`);
  let count = -1;
  const cur = new Date(from);
  while (cur <= to) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

function todaysPicker(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00`).getDay();
  if (dow === 0 || dow === 6) return SONG_PICKER_WEEKEND;
  const idx = weekdayIndexSince(SONG_PICKER_START_DATE, dateStr);
  const n = SONG_PICKER_WEEKDAY_ORDER.length;
  return SONG_PICKER_WEEKDAY_ORDER[((idx % n) + n) % n];
}

// "사장님"처럼 이름 자체에 이미 존칭이 들어있으면 "님"을 또 붙이지 않는다
// (사장님님이 되는 걸 막음).
function withHonorific(name) {
  return name.endsWith("님") ? name : `${name}님`;
}

let rootEl = null;
let account = { name: "", phone: "" };
let unsub = null;
let todaySong = null; // live
let searchQuery = "";
let searchResults = [];
let searching = false;
let playing = false;
let ytPlayer = null; // 유튜브 IFrame Player API 인스턴스 — 탭마다 iframe을 새로
                      // 만들면 처음부터 다시 재생되므로, 하나를 계속 재사용해야
                      // pauseVideo()/playVideo()로 "진짜" 일시정지·이어재생이 된다.
let hasStartedPlayback = false; // 실제로(무음 아닌) 재생을 시작한 적이 있는지

// 유튜브 IFrame Player API는 전역에 한 번만 로드하면 되고, 이미 로드돼 있으면
// 그대로 재사용한다. mountMusicBar 때 미리 호출해둬서 실제 재생 탭 시점엔
// 이미 로드가 끝나 있게 해, 제스처(탭) 직후 바로 플레이어를 만들 수 있다.
let ytApiPromise = null;
function loadYoutubeApi() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    const prevCb = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof prevCb === "function") prevCb();
      resolve();
    };
    if (!document.getElementById("youtubeIframeApiScript")) {
      const tag = document.createElement("script");
      tag.id = "youtubeIframeApiScript";
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    }
  });
  return ytApiPromise;
}

export function mountMusicBar(el, acc) {
  rootEl = el;
  account = acc;
  if (unsub) unsub();
  if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch (e) {} }
  ytPlayer = null;
  playerReadyPromise = null;
  playing = false;
  hasStartedPlayback = false;
  loadYoutubeApi();
  unsub = onSnapshot(doc(db, "stores", account.storeId, "songOfTheDay", todayStr()), (snap) => {
    todaySong = snap.exists() ? snap.data() : null;
    render();
    if (todaySong) loadYoutubeApi().then(ensurePlayer);
  });
  render();
}

// 모바일(특히 iOS)은 cross-origin iframe을 새로 만든 "첫 탭"에서는 autoplay가
// 음소거로 막히고, 그 뒤로 같은 플레이어에 JS API로 보내는 명령만 소리가
// 난다 — 실제로 "탭→바로 멈추고 다시 탭해야 들림"으로 확인된 현상이다.
// 그래서 곡이 정해지는 즉시(탭 전에) 무음 자동재생으로 플레이어를 미리
// 만들어두고, 사용자가 실제로 탭하는 순간엔 이미 존재하는 플레이어에
// unMute()+playVideo()만 호출한다 — 이게 바로 "두 번째 탭부터는 잘 되던"
// 그 경로라서, 모든 탭이 처음부터 그 경로를 타게 된다.
let playerReadyPromise = null; // new YT.Player()가 반환된 직후에도 내부적으론
                                // 아직 준비 전이라, onReady 전에 seekTo/unMute/
                                // playVideo를 호출하면 조용히 무시될 수 있다 —
                                // 탭 타이밍에 따라 "가끔 첫 탭에 안 들리는"
                                // 현상의 원인이 이거였을 수 있어, 반드시 이
                                // Promise를 기다린 뒤에만 명령을 보낸다.

function ensurePlayer() {
  if (ytPlayer || !todaySong) return;
  const wrap = document.getElementById("musicBarPlayerWrap");
  const slot = document.getElementById("musicBarPlayerSlot");
  if (!wrap || !slot) return;
  playerReadyPromise = new Promise((resolve) => {
    ytPlayer = new YT.Player(slot, {
      videoId: todaySong.videoId,
      width: 36,
      height: 36,
      playerVars: { autoplay: 1, mute: 1, playsinline: 1 },
      events: {
        onReady: (e) => {
          // 36x36짜리라 화질은 의미 없고, 최저 화질로 요청해두면 실제 탭
          // 시점까지 받아야 할 데이터가 훨씬 적어져서 "곡 고르자마자 바로
          // 탭" 같은 경우에도 버퍼링이 덜 걸린다.
          e.target.setPlaybackQuality("tiny");
          resolve();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) { playing = false; updatePlayIcon(); }
        },
      },
    });
  });
}

// 유튜브 검색 결과 제목에 &#39; 같은 HTML 엔티티가 그대로 섞여 올 때가 있어
// (예: 제목에 아포스트로피가 들어간 영상), escapeHtml()이 그 위에 한 번 더
// 이스케이프를 씌우면 &amp;#39; 처럼 깨져 보인다 — 저장/표시 전에 한 번
// 디코딩해서 "진짜 글자"로 되돌려둔다.
function decodeHtmlEntities(s) {
  const el = document.createElement("textarea");
  el.innerHTML = s || "";
  return el.value;
}

async function runSearch() {
  const q = searchQuery.trim();
  if (!q) return;
  searching = true;
  searchResults = [];
  render();
  try {
    const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    searchResults = (data.items || []).map((it) => ({
      ...it,
      title: decodeHtmlEntities(it.title),
      channelTitle: decodeHtmlEntities(it.channelTitle),
    }));
  } catch (e) {
    console.error(e);
    toast("검색에 실패했어요");
  } finally {
    searching = false;
    render();
  }
}

async function pickSong(item) {
  await setDoc(doc(db, "stores", account.storeId, "songOfTheDay", todayStr()), {
    videoId: item.videoId,
    title: item.title,
    channelTitle: item.channelTitle,
    thumbnail: item.thumbnail,
    setByPhone: account.phone,
    setByName: account.name,
    setAt: Date.now(),
  });
  searchQuery = "";
  searchResults = [];
  toast("오늘의 노래로 등록했어요 🎵");
}

function barHtml() {
  if (todaySong) {
    return `
      <div class="musicbar">
        <button type="button" class="musicbar-compact" id="musicBarPlayBtn">
          <img src="${todaySong.thumbnail}" alt="" class="musicbar-thumb" id="musicBarThumbImg" />
          <span class="musicbar-player-wrap" id="musicBarPlayerWrap">
            <span id="musicBarPlayerSlot"></span>
          </span>
          <div class="musicbar-info">
            <div class="musicbar-label">🎵 오늘의 노래 · ${escapeHtml(withHonorific(todaySong.setByName || ""))} 추천</div>
            <div class="musicbar-title">${escapeHtml(todaySong.title)}</div>
          </div>
          <span class="musicbar-play-icon" id="musicBarPlayIcon">${playing ? "⏸️" : "▶️"}</span>
        </button>
      </div>`;
  }

  const picker = todaysPicker(todayStr());
  const isMyTurn = picker.phone === account.phone;

  if (!isMyTurn) {
    return `
      <div class="musicbar">
        <div class="musicbar-waiting">🎵 오늘은 ${escapeHtml(withHonorific(picker.name))}이 오늘의 노래를 골라줄 차례예요</div>
      </div>`;
  }

  return `
    <div class="musicbar">
      <div class="musicbar-search-row">
        <input type="text" class="musicbar-search-input" id="musicBarSearchInput" placeholder="오늘의 노래 검색 (내 차례예요 🎵)" value="${escapeHtml(searchQuery)}" />
        <button type="button" class="musicbar-search-btn" id="musicBarSearchBtn">검색</button>
      </div>
      ${searching ? `<div class="musicbar-searching">검색 중...</div>` : ""}
      ${searchResults.length > 0 ? `
        <div class="musicbar-result-list">
          ${searchResults.map((it) => `
            <button type="button" class="musicbar-result-row" data-musicbar-pick="${it.videoId}">
              <img src="${it.thumbnail}" alt="" class="musicbar-thumb" />
              <div class="musicbar-info">
                <div class="musicbar-title">${escapeHtml(it.title)}</div>
                <div class="musicbar-channel">${escapeHtml(it.channelTitle)}</div>
              </div>
            </button>`).join("")}
        </div>` : ""}
    </div>`;
}

function updatePlayIcon() {
  const icon = document.getElementById("musicBarPlayIcon");
  if (icon) icon.textContent = playing ? "⏸️" : "▶️";
}

async function onPlayButtonClick() {
  if (playing) {
    if (ytPlayer) ytPlayer.pauseVideo();
    playing = false;
    updatePlayIcon();
    return;
  }
  await loadYoutubeApi();
  ensurePlayer();
  if (!ytPlayer) return;
  await playerReadyPromise; // onReady 전엔 명령이 조용히 무시될 수 있어 꼭 기다린다
  const wrap = document.getElementById("musicBarPlayerWrap");
  const img = document.getElementById("musicBarThumbImg");
  if (img) img.style.display = "none";
  if (wrap) wrap.style.display = "block";
  if (!hasStartedPlayback) {
    // 탭하기 전까지 무음으로 흘러가고 있었을 수 있으니, 실제로 들려줄 땐
    // 처음으로 되돌리고 음소거를 푼다 — 다만 곡을 고르자마자 거의 바로
    // 탭한 경우엔 아직 0초 근처라, 여기서 괜히 seekTo를 또 부르면 그 자체로
    // 다시 버퍼링을 유발할 수 있어 이미 거의 0초면 건너뛴다. 이후
    // 일시정지→재생은 이 분기를 타지 않아 멈춘 지점부터 이어서 재생된다.
    hasStartedPlayback = true;
    if (ytPlayer.getCurrentTime && ytPlayer.getCurrentTime() > 1) ytPlayer.seekTo(0, true);
    ytPlayer.unMute();
  }
  ytPlayer.playVideo();
  playing = true;
  updatePlayIcon();
}

function render() {
  if (!rootEl) return;
  rootEl.innerHTML = barHtml() + `<div class="musicbar-expiry-note">이 서비스는 11월 10일 부로 만료됩니다</div>`;

  const playBtn = document.getElementById("musicBarPlayBtn");
  if (playBtn) playBtn.addEventListener("click", onPlayButtonClick);

  const searchInput = document.getElementById("musicBarSearchInput");
  if (searchInput) {
    searchInput.addEventListener("input", (e) => { searchQuery = e.target.value; });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) runSearch();
    });
  }
  const searchBtn = document.getElementById("musicBarSearchBtn");
  if (searchBtn) searchBtn.addEventListener("click", runSearch);

  rootEl.querySelectorAll("[data-musicbar-pick]").forEach((el) => {
    el.addEventListener("click", () => {
      const item = searchResults.find((r) => r.videoId === el.dataset.musicbarPick);
      if (item) pickSong(item);
    });
  });
}
