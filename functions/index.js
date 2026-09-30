const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Collocated with the Firestore database (asia-northeast3 / Seoul) to match
// the triggers' region and avoid cross-region hops.
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

// Client stores fcmTokens as {id, token} (id = a per-device id, so
// re-registering replaces this device's entry instead of piling up a new
// one every time the SW updates and reissues a token). Older entries may
// still be plain strings from before that change — support both shapes.
function tokensOf(fcmTokens) {
  return (fcmTokens || []).map((t) => (typeof t === "string" ? t : t.token)).filter(Boolean);
}

// Drops tokens FCM reports as dead (uninstalled/unregistered) so accounts
// don't accumulate stale tokens forever.
async function removeTokens(deadTokens) {
  if (deadTokens.length === 0) return;
  const snap = await db.collection("accounts").get();
  const batch = db.batch();
  let changed = false;
  snap.forEach((doc) => {
    const existing = doc.data().fcmTokens || [];
    const filtered = existing.filter((t) => {
      const tok = typeof t === "string" ? t : t.token;
      return !deadTokens.includes(tok);
    });
    if (filtered.length !== existing.length) {
      batch.update(doc.ref, { fcmTokens: filtered });
      changed = true;
    }
  });
  if (changed) await batch.commit();
}

// `link` is the page the notification should open when tapped — carried in
// the data payload (read by sw.js's own notificationclick handler) since
// this app sends data-only messages and renders notifications itself, so
// FCM's built-in webpush.fcmOptions.link auto-open never applies here.
async function sendToTokens(tokens, notification) {
  const validTokens = [...new Set(tokens)].filter(Boolean);
  if (validTokens.length === 0) return;
  try {
    const resp = await messaging.sendEachForMulticast({
      tokens: validTokens,
      // data-only (no top-level `notification` field): sending a
      // `notification` payload makes the browser auto-display its own
      // default banner in ADDITION to whatever our service worker's
      // onBackgroundMessage renders — this was the actual cause of every
      // push showing up twice. With data-only, the SW is the sole renderer.
      data: { title: notification.title, body: notification.body, link: notification.link || "/" },
      webpush: {
        fcmOptions: { link: notification.link || "/" },
      },
    });
    const dead = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (
          code === "messaging/registration-token-not-registered" ||
          code === "messaging/invalid-registration-token"
        ) {
          dead.push(validTokens[i]);
        }
      }
    });
    await removeTokens(dead);
  } catch (e) {
    console.error("sendToTokens failed", e);
  }
}

// The share board lives at a different URL depending on the viewer's role
// (owner-side app-shell has a real share.html; staff.html has an in-page
// "share" view instead) — so a single "공유해요" event's recipients need
// per-role links, not one link for everybody.
function shareLinkForRole(role) {
  return role === "owner" ? "/share.html" : "/staff.html?view=share";
}

// 새 발주 요청이 제출되면 사장님(들)에게 알림. 직원이 "발주 요청하기"를 한 번
//누르면 담아둔 자재 수만큼 checks/{date}/items 문서가 생기는데, 예전에는 이
// 컬렉션을 직접 구독해서 자재 개수만큼 알림이 우르르 갔다 — 대신 제출 시점에
// staff.js가 별도로 남기는 requestBatches 문서(제출 묶음 1건당 1개) 를
// 구독해서, 제출할 때마다 딱 한 번만 알림이 가도록 한다.
exports.notifyOwnerOnNewRequest = onDocumentCreated("checks/{date}/requestBatches/{batchId}", async (event) => {
  const batch = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const tokens = [];
  ownersSnap.forEach((doc) => tokens.push(...tokensOf(doc.data().fcmTokens)));
  await sendToTokens(tokens, {
    title: "자재발주 요청",
    body: `${batch.staffName ? batch.staffName + "님이 " : ""}자재 발주 요청을 보냈습니다`,
    link: "/owner.html",
  });
});

// 사장님이 주문완료 체크 후 "제출"을 누르면 요청한 직원에게 알림. 예전에는
// checks/{date}/items 를 직접 구독해서 항목 개수만큼 알림이 우르르 갔는데,
// 이제는 제출 시점에 owner.js가 직원별로 남기는 orderBatches 문서(제출
// 1건당 직원 1명당 1개)를 구독해서, 제출할 때마다 직원당 딱 한 번만 알림이
// 가도록 한다.
exports.notifyStaffOnOrdered = onDocumentCreated("checks/{date}/orderBatches/{batchId}", async (event) => {
  const batch = event.data.data();
  if (!batch.staffPhone) return;
  const accSnap = await db.collection("accounts").doc(batch.staffPhone).get();
  if (!accSnap.exists) return;
  const tokens = tokensOf(accSnap.data().fcmTokens);
  await sendToTokens(tokens, {
    title: "사장님의 주문완료 알림",
    body: "사장님이 자재 주문을 완료했습니다",
    link: "/staff.html?view=cart",
  });
});

// 공유하기 > 공유해요 또는 품절공유에 새 글이 올라오면 작성자를 제외한
// 모두에게 알림. 받는 사람의 역할(사장/직원)에 따라 열어줄 페이지가
// 다르므로 토큰을 역할별로 나눠 두 번(필요하면) 보낸다.
exports.notifyOnNewShareNote = onDocumentCreated("shares/{date}/items/{itemId}", async (event) => {
  const item = event.data.data();
  if (item.type !== "note" && item.type !== "soldout") return;
  const accSnap = await db.collection("accounts").get();
  const tokensByRole = { owner: [], staff: [] };
  accSnap.forEach((doc) => {
    if (doc.id === item.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    tokensByRole[role].push(...tokensOf(doc.data().fcmTokens));
  });
  const isSoldout = item.type === "soldout";
  const title = isSoldout ? "품절 공유 알림" : "공유해요 알림";
  const body = `${item.staffName ? item.staffName + "님: " : ""}${item.content || ""}${isSoldout ? " 품절됐어요" : ""}`;
  await Promise.all(
    Object.keys(tokensByRole).map((role) =>
      sendToTokens(tokensByRole[role], { title, body, link: shareLinkForRole(role) })
    )
  );
});

// 등록해요 > 시재 등록에 새 기록이 쌓이면 등록한 사람을 제외한 모두에게
// 알림 — 선결제 충전 등록(topups)은 알림 대상이 아니라 시재 entries만 구독.
function registerLinkForRole(role) {
  return role === "owner" ? "/register.html" : "/staff.html?view=register";
}

exports.notifyOnNewCashEntry = onDocumentCreated("cashRegister/{date}/entries/{entryId}", async (event) => {
  const entry = event.data.data();
  const accSnap = await db.collection("accounts").get();
  const tokensByRole = { owner: [], staff: [] };
  accSnap.forEach((doc) => {
    if (doc.id === entry.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    tokensByRole[role].push(...tokensOf(doc.data().fcmTokens));
  });
  const body = `${entry.staffName ? entry.staffName + "님이 " : ""}시재 ${(entry.total || 0).toLocaleString()}원을 등록했습니다`;
  await Promise.all(
    Object.keys(tokensByRole).map((role) =>
      sendToTokens(tokensByRole[role], { title: "시재 등록 알림", body, link: registerLinkForRole(role) })
    )
  );
});

// 출근기록 > 급여대장에서 직원이 월급 제출하면 사장님에게만 알림 — 다른
// 직원들은 서로의 급여 정보를 알 필요가 없으므로 owner 역할 계정에만 보낸다.
exports.notifyOwnerOnPayrollRequest = onDocumentCreated("payrollRequests/{requestId}", async (event) => {
  const req = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const tokens = [];
  ownersSnap.forEach((doc) => tokens.push(...tokensOf(doc.data().fcmTokens)));
  await sendToTokens(tokens, {
    title: "급여 제출 알림",
    body: `${req.staffName ? req.staffName + "님이 " : ""}${req.cycleLabel || ""} 급여를 제출했습니다`,
    link: "/staff.html?view=payroll",
  });
});

// 출퇴근 도장은 급여 계산과 무관한 별도 출근 확인용 — 직원이 도장을 찍을
// 때마다 사장님에게만 알림 (도장 찍은 본인이 사장님이면 자기 자신에게는
// 안 보낸다).
exports.notifyOwnerOnAttendanceStamp = onDocumentCreated("accounts/{phone}/attendance/{stampId}", async (event) => {
  const stamp = event.data.data();
  const phone = event.params.phone;
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const tokens = [];
  ownersSnap.forEach((doc) => {
    if (doc.id === phone) return;
    tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  const label = stamp.type === "in" ? "출근" : "퇴근";
  await sendToTokens(tokens, {
    title: "출퇴근 알림",
    body: `${stamp.staffName ? stamp.staffName + "님이 " : ""}${stamp.time || ""} ${label} 도장을 찍었습니다`,
    link: "/staff.html?view=payroll",
  });
});

// 대댓글은 새 문서가 아니라 부모 글의 replies 배열에 arrayUnion으로 추가되는
// 업데이트라서, 위 onDocumentCreated는 이 경우를 못 잡는다 — 그래서 댓글을
// 달아도 알림이 전혀 가지 않았던 것. replies 배열이 늘어난 업데이트만 골라
// 마지막으로 추가된 댓글을, 원글 작성자 본인에게만(자기 글에 자기가 달면 제외)
// 알림 — 스레드의 다른 참여자에게는 가지 않는다.
exports.notifyOnNewReply = onDocumentUpdated("shares/{date}/items/{itemId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const beforeReplies = before.replies || [];
  const afterReplies = after.replies || [];
  if (afterReplies.length <= beforeReplies.length) return;
  const newReply = afterReplies[afterReplies.length - 1];
  if (!newReply || !after.staffPhone || newReply.staffPhone === after.staffPhone) return;

  const authorAccSnap = await db.collection("accounts").doc(after.staffPhone).get();
  if (!authorAccSnap.exists) return;
  const tokens = tokensOf(authorAccSnap.data().fcmTokens);
  const body = `${newReply.staffName ? newReply.staffName + "님: " : ""}${newReply.content || ""} (댓글)`;
  await sendToTokens(tokens, {
    title: "공유해요 알림",
    body,
    link: shareLinkForRole(authorAccSnap.data().role),
  });
});

// 이모지 리액션(좋아요 등)이 새로 눌리면 원글 작성자에게 "OO님이 좋아요를
// 눌렀습니다" 형태로 알림. reactions.{key}는 arrayUnion으로 추가되는 전화번호
// 배열이라, before/after를 비교해 새로 추가된 번호만 골라낸다.
const REACTION_LABELS = { heart: "하트", sad: "속상해요", awesome: "최고예요" };

// 받침 유무에 따라 을/를 조사를 고른다 (한글 완성형 코드포인트 % 28 === 0 이면 받침 없음).
function withEulReul(word) {
  const last = word[word.length - 1];
  const code = last.charCodeAt(0) - 0xac00;
  const hasBatchim = code >= 0 && code <= 11171 && code % 28 !== 0;
  return `${word}${hasBatchim ? "을" : "를"}`;
}

// KST calendar-day string, matching the client's own todayStr()/date-key logic.
function kstDateStr(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

// 모리 키우기: 사장님이 주문완료 체크 후 제출(= orderBatches 문서 생성)할
// 때마다 꿀단지 1개씩 적립 — 직원 쪽 체크베리/주먹밥과 똑같이 하루 최대
// 2번까지만 적립된다(제출을 잘게 쪼개서 꿀단지를 우르르 받아내는 걸 막기
// 위함). 다만 하루라도 지나서 처리한 배치는(= 이 트리거가 도는 날짜가
// 오늘이 아니면) 아예 인정하지 않는다 — 과거 날짜 발주를 뒤늦게 몰아서
// 처리해도 꿀단지가 쌓이지 않도록.
exports.awardHoneyOnOrderBatch = onDocumentCreated("checks/{date}/orderBatches/{batchId}", async (event) => {
  const date = event.params.date;
  if (date !== kstDateStr(new Date())) return; // only same-day completion counts

  const mascotRef = db.collection("meta").doc("mascot");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(mascotRef);
    const data = snap.exists ? snap.data() : {};
    const count = data.honeyCountDate === date ? data.honeyCount || 0 : 0;
    if (count >= 2) return; // 오늘 이미 2번 받았음
    tx.set(
      mascotRef,
      { honeyJars: (data.honeyJars || 0) + 1, honeyCount: count + 1, honeyCountDate: date },
      { merge: true }
    );
  });
});

exports.notifyOnNewReaction = onDocumentUpdated("shares/{date}/items/{itemId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const beforeReactions = before.reactions || {};
  const afterReactions = after.reactions || {};

  let reactorPhone = null;
  let reactionKey = null;
  for (const key of Object.keys(afterReactions)) {
    const beforeList = beforeReactions[key] || [];
    const afterList = afterReactions[key] || [];
    const added = afterList.find((p) => !beforeList.includes(p));
    if (added) {
      reactorPhone = added;
      reactionKey = key;
      break;
    }
  }
  if (!reactorPhone || !after.staffPhone || reactorPhone === after.staffPhone) return;

  const reactorSnap = await db.collection("accounts").doc(reactorPhone).get();
  const reactorName = reactorSnap.exists ? reactorSnap.data().name : "누군가";
  const authorAccSnap = await db.collection("accounts").doc(after.staffPhone).get();
  if (!authorAccSnap.exists) return;
  const tokens = tokensOf(authorAccSnap.data().fcmTokens);
  const label = REACTION_LABELS[reactionKey] || "리액션";
  await sendToTokens(tokens, {
    title: "공유해요 알림",
    body: `${reactorName}님이 ${withEulReul(label)} 눌렀습니다`,
    link: shareLinkForRole(authorAccSnap.data().role),
  });
});

// ---- 월급날 알림 (매일 오전 9시) ----
// payroll.js의 cycleBounds() 로직을 그대로 옮겨온 것 — 클라이언트는 브라우저의
// 로컬(=한국) 시간으로 년/월/일을 계산하는데, 서버의 new Date()는 UTC라서
// 그대로 쓰면 날짜가 어긋난다. kstDateStr로 한국 날짜를 문자열로 구한 뒤
// 그 값으로 "가짜 로컬" Date를 만들면, 이후의 getFullYear/getMonth/getDate
// 계산이 클라이언트와 동일하게 맞아떨어진다.
function kstTodayAsLocalDate() {
  const [y, m, d] = kstDateStr(new Date()).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addMonths(d, n) {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function cycleEnd(payCycleStartDay, today) {
  let anchor = new Date(today.getFullYear(), today.getMonth(), payCycleStartDay);
  if (anchor > today) anchor = addMonths(anchor, -1);
  const nextAnchor = addMonths(anchor, 1);
  return addDays(nextAnchor, -1);
}

// 직원별 정산 주기 마지막 날(=월급날)에만: 그 직원 본인에게 "월급날이에요"
// 알림을, 사장님에게는 "OO님 급여 지급날입니다" 알림을 보낸다. 급여 제출
// 여부와 무관하게 날짜만으로 판단 — 제출 알림(notifyOwnerOnPayrollRequest)과는
// 별개다.
exports.notifyPayday = onSchedule({ schedule: "0 9 * * *", timeZone: "Asia/Seoul" }, async () => {
  const today = kstTodayAsLocalDate();
  const accSnap = await db.collection("accounts").get();

  const owners = [];
  const staffOnPayday = [];
  accSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.role === "owner") {
      owners.push(data);
      return;
    }
    const end = cycleEnd(data.payCycleStartDay || 1, today);
    if (ymdLocal(end) === ymdLocal(today)) {
      staffOnPayday.push({ phone: docSnap.id, name: data.name, fcmTokens: data.fcmTokens });
    }
  });
  if (staffOnPayday.length === 0) return;

  const ownerTokens = [];
  owners.forEach((o) => ownerTokens.push(...tokensOf(o.fcmTokens)));

  await Promise.all([
    ...staffOnPayday.map((s) =>
      sendToTokens(tokensOf(s.fcmTokens), {
        title: "월급날 알림",
        body: "오늘은 월급날이에요! 사장님께 급여내역을 제출해보세요",
        link: "/staff.html?view=payroll",
      })
    ),
    ...staffOnPayday.map((s) =>
      sendToTokens(ownerTokens, {
        title: "급여 지급일 알림",
        body: `${s.name || "직원"}님 급여 지급날입니다!`,
        link: "/staff.html?view=payroll",
      })
    ),
  ]);
});

// 직원이 매번 조사해서 담지 않아도, 이틀에 한 번씩 자동으로 정상발주 상태로
// 요청되는 고정 자재. 시작일부터 이틀 간격(diff % 2 === 0)으로만 해당 날짜에
// 문서를 만든다 — .create()라서 그날 이미 (사람이 직접 담았든, 이 함수가
// 이미 만들었든) 같은 자재 문서가 있으면 조용히 건너뛰고 덮어쓰지 않는다.
const FIXED_INTERVAL_START = "2026-09-30";
const FIXED_INTERVAL_MATERIALS = [
  { id: "Yj417CXCvshydcGjEHbZ", materialName: "홀더(미듐)", mainCategory: "기본자재", subCategory: "홀더/캐리어" },
  { id: "EHwg6H31nXzpSszsfgsy", materialName: "홀더(라지)", mainCategory: "기본자재", subCategory: "홀더/캐리어" },
  { id: "S8M3b87BMOeMoIU1gSJ9", materialName: "일반우유", mainCategory: "식자재", subCategory: "우유옵션" },
];

function kstDaysBetween(dateStr, fromStr) {
  return Math.round((new Date(`${dateStr}T00:00:00Z`) - new Date(`${fromStr}T00:00:00Z`)) / 86400000);
}

// checks/{date}/items에 바로 제출해버리지 않고 checks/{date}/autoPending에만
// 담아둔다 — 직원 담은 목록(cart)에 "자동" 표시로 나타나서, 직원이 직접
// 확인하고 제출(또는 필요없으면 취소)해야 실제로 사장님께 전달된다. 그래서
// 여기서는 알림도 안 보낸다 — 실제 제출은 staff.js의 submitCategory가
// 담당하고, 그때 평소처럼 requestBatches/알림/먹이가 생긴다.
exports.autoRequestFixedMaterials = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Asia/Seoul" },
  async () => {
    const today = kstDateStr(new Date());
    const diff = kstDaysBetween(today, FIXED_INTERVAL_START);
    if (diff < 0 || diff % 2 !== 0) return; // 아직 시작 전이거나, 이틀 주기가 아닌 날

    for (const m of FIXED_INTERVAL_MATERIALS) {
      const ref = db.collection("checks").doc(today).collection("autoPending").doc(m.id);
      try {
        await ref.create({
          materialName: m.materialName,
          mainCategory: m.mainCategory,
          subCategory: m.subCategory,
          urgency: "normal",
          note: "",
          qty: "",
          photoUrl: "",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        // 이미 그날 담아둔 적 있음 — 건드리지 않는다.
      }
    }
  }
);
