const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
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
// 모두에게 알림. 받는 사람의 역할(사장/직원)에 따라 열어줄 페이지가 다르고,
// @멘션된 사람에게는 "이미 모두에게 가는 일반 알림"을 중복으로 또 보내는
// 대신 제목만 "~님이 회원님을 언급했어요"로 바꿔서 구분되게 보낸다.
exports.notifyOnNewShareNote = onDocumentCreated("shares/{date}/items/{itemId}", async (event) => {
  const item = event.data.data();
  if (item.type !== "note" && item.type !== "soldout") return;
  const accSnap = await db.collection("accounts").get();
  const isSoldout = item.type === "soldout";
  const defaultTitle = isSoldout ? "품절 공유 알림" : "공유해요 알림";
  const body = `${item.staffName ? item.staffName + "님: " : ""}${item.content || ""}${isSoldout ? " 품절됐어요" : ""}`;
  const mentionedPhones = new Set(item.mentions || []);
  const sends = [];
  accSnap.forEach((docSnap) => {
    if (docSnap.id === item.staffPhone) return;
    const data = docSnap.data();
    const tokens = tokensOf(data.fcmTokens);
    if (tokens.length === 0) return;
    const role = data.role === "owner" ? "owner" : "staff";
    const mentioned = !isSoldout && (item.mentionsAll || mentionedPhones.has(docSnap.id));
    sends.push(sendToTokens(tokens, {
      title: mentioned ? `${item.staffName ? item.staffName + "님이 " : ""}회원님을 언급했어요` : defaultTitle,
      body,
      link: shareLinkForRole(role),
    }));
  });
  await Promise.all(sends);
});

// 공유하기 > 레시피(레시피변경/단종)에 새 글이 올라오면 작성자를 제외한
// 모두에게 알림 — 공유해요/품절공유와 같은 패턴. 단종 소식은 제목만
// 다르게 보내서 구분되게 한다.
exports.notifyOnNewRecipe = onDocumentCreated("recipes/{recipeId}", async (event) => {
  const recipe = event.data.data();
  const isDisco = recipe.status === "discontinued";
  const title = isDisco ? "🔴 메뉴 단종 알림" : "📖 레시피 등록 알림";
  const body = `${recipe.staffName ? recipe.staffName + "님: " : ""}${recipe.menuName || ""}${isDisco ? " 단종됐어요" : " 레시피가 등록됐어요"}`;
  const accSnap = await db.collection("accounts").get();
  const sends = [];
  accSnap.forEach((docSnap) => {
    if (docSnap.id === recipe.staffPhone) return;
    const tokens = tokensOf(docSnap.data().fcmTokens);
    if (tokens.length === 0) return;
    const role = docSnap.data().role === "owner" ? "owner" : "staff";
    sends.push(sendToTokens(tokens, { title, body, link: shareLinkForRole(role) }));
  });
  await Promise.all(sends);
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
// 댓글(답글)은 멘션 여부로 수신 범위가 갈린다 — @이름으로 특정 인원을
// 콕 집어 멘션했으면 그 사람(들)에게만 "언급했어요" 알림이 가고, 멘션 없이
// 쓴 일반 댓글은 작성자를 뺀 전원에게 알림이 간다(원글 작성자만 받던
// 예전 방식에서 확장됨).
exports.notifyOnNewReply = onDocumentUpdated("shares/{date}/items/{itemId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const beforeReplies = before.replies || [];
  const afterReplies = after.replies || [];
  if (afterReplies.length <= beforeReplies.length) return;
  const newReply = afterReplies[afterReplies.length - 1];
  if (!newReply || !newReply.staffPhone) return;

  const body = `${newReply.staffName ? newReply.staffName + "님: " : ""}${newReply.content || ""} (댓글)`;
  const mentionedPhones = new Set(newReply.mentions || []);
  const hasMention = newReply.mentionsAll || mentionedPhones.size > 0;

  const accSnap = await db.collection("accounts").get();
  const sends = [];
  accSnap.forEach((docSnap) => {
    if (docSnap.id === newReply.staffPhone) return;
    const mentioned = newReply.mentionsAll || mentionedPhones.has(docSnap.id);
    if (hasMention && !mentioned) return;
    const data = docSnap.data();
    const tokens = tokensOf(data.fcmTokens);
    if (tokens.length === 0) return;
    const role = data.role === "owner" ? "owner" : "staff";
    sends.push(sendToTokens(tokens, {
      title: mentioned ? `${newReply.staffName ? newReply.staffName + "님이 " : ""}회원님을 언급했어요` : "공유해요 알림",
      body,
      link: shareLinkForRole(role),
    }));
  });
  await Promise.all(sends);
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
// 꿀단지는 "사장님"이 주문완료했다는 걸로 버는 먹이라, 이제는 공용
// meta/mascot 문서가 아니라 오너 역할 계정들의 accounts 문서에 개인적으로
// 쌓는다 — 그래야 이 가게의 먹이 알림이 사장님 화면에만 뜨고 직원들
// 화면엔 안 뜬다(레벨/경험치는 여전히 meta/mascot에 공유로 남는다).
exports.awardHoneyOnOrderBatch = onDocumentCreated("checks/{date}/orderBatches/{batchId}", async (event) => {
  const date = event.params.date;
  if (date !== kstDateStr(new Date())) return; // only same-day completion counts

  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  await Promise.all(
    ownersSnap.docs.map((ownerDoc) =>
      db.runTransaction(async (tx) => {
        const snap = await tx.get(ownerDoc.ref);
        const data = snap.exists ? snap.data() : {};
        const count = data.honeyCountDate === date ? data.honeyCount || 0 : 0;
        if (count >= 2) return; // 오늘 이미 2번 받았음
        tx.set(
          ownerDoc.ref,
          { pendingHoney: (data.pendingHoney || 0) + 1, honeyCount: count + 1, honeyCountDate: date },
          { merge: true }
        );
      })
    )
  );
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
// 정산 시작일(급여 계산 기간)과 실제 월급 지급일은 별개다 — 직원마다 정산
// 종료일 바로 다음날 받기도 하고, 정산 기간과 무관한 고정 날짜(예: 매달
// 15일)에 받기도 한다. 그래서 여기서는 cycleBounds 계산을 흉내내지 않고,
// 각 직원이 payroll.js에서 직접 등록한 paydayOfMonth(1~28)와 오늘의 날짜만
// 비교한다 — 한국 기준 "오늘 며칠인지"만 필요하므로 kstDateStr 문자열에서
// day 부분만 뽑아 쓰면 충분하다.
function kstDayOfMonth() {
  return Number(kstDateStr(new Date()).split("-")[2]);
}

// 직원이 등록한 월급날에만: 그 직원 본인에게 "월급날이에요" 알림을,
// 사장님에게는 "OO님 급여 지급날입니다" 알림을 보낸다. 급여 제출 여부와
// 무관하게 날짜만으로 판단 — 제출 알림(notifyOwnerOnPayrollRequest)과는
// 별개다. 월급날을 아직 등록하지 않은 계정은 대상에서 제외된다.
exports.notifyPayday = onSchedule({ schedule: "0 9 * * *", timeZone: "Asia/Seoul" }, async () => {
  const todayDay = kstDayOfMonth();
  const accSnap = await db.collection("accounts").get();

  const owners = [];
  const staffOnPayday = [];
  accSnap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data.role === "owner") {
      owners.push(data);
      return;
    }
    if (data.paydayOfMonth && data.paydayOfMonth === todayDay) {
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

// ---- 시재등록 정기 알림 (평일 11시/14시/18시) ----
// 그 시각에 근무표(schedules)상 근무 중인 직원에게만 "시재 등록해주세요"
// 알림을 보낸다 — 매장에 아무도 없는데 알림이 가는 일이 없도록, 전체
// 직원이 아니라 근무표 기준으로 그 시간을 포함하는 근무가 있는 사람만 추린다.
async function notifyScheduledCashReminder(hour) {
  const today = kstDateStr(new Date());
  const timeStr = `${String(hour).padStart(2, "0")}:00`;
  const schedSnap = await db.collection("schedules").where("date", "==", today).get();
  const onDutyPhones = new Set();
  schedSnap.forEach((docSnap) => {
    const d = docSnap.data();
    if (d.staffPhone && d.startTime && d.endTime && d.startTime <= timeStr && d.endTime > timeStr) {
      onDutyPhones.add(d.staffPhone);
    }
  });
  if (onDutyPhones.size === 0) return;
  const accSnaps = await Promise.all([...onDutyPhones].map((p) => db.collection("accounts").doc(p).get()));
  await Promise.all(
    accSnaps
      .filter((s) => s.exists)
      .map((s) => {
        const data = s.data();
        return sendToTokens(tokensOf(data.fcmTokens), {
          title: "시재 등록 알림",
          body: `${timeStr} 시재를 등록해주세요`,
          link: registerLinkForRole(data.role),
        });
      })
  );
}

exports.notifyCashRegister11am = onSchedule({ schedule: "0 11 * * 1-5", timeZone: "Asia/Seoul" }, () => notifyScheduledCashReminder(11));
exports.notifyCashRegister2pm = onSchedule({ schedule: "0 14 * * 1-5", timeZone: "Asia/Seoul" }, () => notifyScheduledCashReminder(14));
exports.notifyCashRegister6pm = onSchedule({ schedule: "0 18 * * 1-5", timeZone: "Asia/Seoul" }, () => notifyScheduledCashReminder(18));

// ---- 근무표 출근 전날 알림 (매일 밤 9시) ----
// 내일(KST) 날짜로 등록된 근무표 항목을 모아, 각자 본인에게만 "내일 근무예요"
// 알림을 보낸다 — 다른 직원의 스케줄까지 알 필요는 없으므로 본인 항목만.
exports.notifyTomorrowShift = onSchedule({ schedule: "0 21 * * *", timeZone: "Asia/Seoul" }, async () => {
  const tomorrow = kstDateStr(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const schedSnap = await db.collection("schedules").where("date", "==", tomorrow).get();
  if (schedSnap.empty) return;
  await Promise.all(
    schedSnap.docs.map(async (docSnap) => {
      const d = docSnap.data();
      if (!d.staffPhone) return;
      const accSnap = await db.collection("accounts").doc(d.staffPhone).get();
      if (!accSnap.exists) return;
      const tokens = tokensOf(accSnap.data().fcmTokens);
      await sendToTokens(tokens, {
        title: "내일 근무 알림",
        body: `내일 ${d.shiftType || ""} ${d.startTime || ""}~${d.endTime || ""} 근무예요`,
        link: "/staff.html?view=payroll",
      });
    })
  );
});

// ---- 인류애 바사삭 등록 알림 ----
// 가볍게 공감하고 넘기는 게 목적인 기능이라, 작성자 본인을 뺀 전 직원(+사장님)
// 에게 바로 알림을 보낸다 — 공유해요처럼 역할별로 열어줄 페이지가 다를 필요가
// 없는 단일 화면 기능이라 링크도 /staff.html 하나로 고정.
exports.notifyOnHumanityCrack = onDocumentCreated("humanityCracks/{crackId}", async (event) => {
  const crack = event.data.data();
  const accSnap = await db.collection("accounts").get();
  const tokens = [];
  accSnap.forEach((doc) => {
    if (doc.id === crack.staffPhone) return;
    tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  await sendToTokens(tokens, {
    title: "💢 인류애 바사삭",
    body: `${crack.staffName ? crack.staffName + "님: " : ""}${crack.reason || ""}`,
    link: "/staff.html",
  });
});

// ---- 사진 저장(다운로드) 프록시 ----
// Storage 버킷에 CORS 설정이 없어서, 클라이언트가 사진 URL을 바로 fetch()해서
// 다운로드하려 하면 브라우저가 막아버린다(이미지를 <img>로 "보여주는" 건
// CORS 없이도 되지만, fetch로 바이트를 "읽어오는" 건 버킷의 CORS 설정이
// 필요하다). 서버(Admin SDK)는 이 제약이 없으니, 여기서 대신 받아
// Content-Disposition: attachment로 내려주면 클라이언트는 이 함수 주소만
// fetch하면 새 창 없이 바로 저장할 수 있다.
exports.downloadImage = onRequest({ cors: true }, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    res.status(400).send("path query parameter required");
    return;
  }
  try {
    const bucket = admin.storage().bucket();
    const file = bucket.file(filePath);
    const [buf] = await file.download();
    const [meta] = await file.getMetadata();
    res.set("Content-Type", meta.contentType || "application/octet-stream");
    res.set("Content-Disposition", `attachment; filename="mamory_${Date.now()}.jpg"`);
    res.send(buf);
  } catch (e) {
    res.status(500).send("download failed");
  }
});
