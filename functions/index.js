const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");

const YOUTUBE_API_KEY = defineSecret("YOUTUBE_API_KEY");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();
const visionClient = new vision.ImageAnnotatorClient();

// Collocated with the Firestore database (asia-northeast3 / Seoul) to match
// the triggers' region and avoid cross-region hops.
setGlobalOptions({ region: "asia-northeast3", maxInstances: 10 });

// 앱 밖(닫혀있을 때/백그라운드)에서 뜨는 실제 OS 알림도 포그라운드 배너와
// 똑같이 구분되게 — 특정 계정의 행동이면 그 사람 프로필 사진을, 익명/시스템
// 알림 중 발주 확인처럼 모리 이미지가 맞는 경우는 모리 이미지를 아이콘으로
// 띄운다. sw.js의 showNotification()은 icon에 어떤 URL이든 쓸 수 있어서
// (PWA라서 안 되는 게 아니다), 여기서 정해서 데이터에 실어 보내면 된다.
const SITE_ORIGIN = "https://mamory.web.app";
const MASCOT_ICON_BY_TYPE = {
  orderReminder: `${SITE_ORIGIN}/img/mascot/mascot-hungry.png`,
};

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
      // FCM data 필드는 전부 문자열이어야 해서, 없는 값은 null/undefined가
      // 아니라 빈 문자열로 보낸다 — 클라이언트는 빈 문자열을 "사람이 특정된
      // 알림 아님(시스템/익명)"으로 해석해 일반 배너로 그린다.
      data: {
        title: notification.title,
        body: notification.body,
        link: notification.link || "/",
        type: notification.type || "general",
        fromPhone: notification.fromPhone || "",
        fromName: notification.fromName || "",
        iconUrl: notification.iconUrl || "",
      },
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

// 실제 기기에 푸시가 도착했는지와 별개로, 받을 사람 계정마다 "이런 알림이
// 왔었다"는 기록을 accounts/{phone}/notifications 에 남긴다 — 권한/서비스
// 워커 문제로 푸시가 조용히 안 갈 때도(이번에 겪은 것처럼) 앱을 열면
// 알림 패널에서 놓친 내용을 볼 수 있게 하기 위해서다. 토큰이 하나도 없는
// 계정도 기록만큼은 남겨서(push가 아예 안 가더라도) 나중에라도 확인할 수
// 있다. 3일 지난 기록은 cleanupOldNotifications가 매일 정리한다.
async function notify(phones, tokens, notification) {
  const phoneList = [...new Set((Array.isArray(phones) ? phones : [phones]).filter(Boolean))];
  const jobs = [];
  if (phoneList.length > 0) {
    const batch = db.batch();
    phoneList.forEach((phone) => {
      const ref = db.collection("accounts").doc(phone).collection("notifications").doc();
      batch.set(ref, {
        title: notification.title,
        body: notification.body,
        link: notification.link || "/",
        type: notification.type || "general",
        // 특정 계정의 행동(댓글/답글/새 글 등)으로 생긴 알림이면 그 사람의
        // phone/name을 같이 남긴다 — 클라이언트가 포그라운드 배너를 그릴 때
        // 프로필 사진을 붙여서 보여줄 수 있게. 익명/시스템 알림은 비워둔다.
        fromPhone: notification.fromPhone || null,
        fromName: notification.fromName || null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });
    jobs.push(batch.commit());
  }
  if (tokens && tokens.length > 0) {
    // 앱이 닫혀있을 때 뜨는 실제 OS 알림도 포그라운드 배너와 똑같이
    // 구분되게 — 특정 계정의 행동이면 그 사람 프로필 사진을, 모리 아이콘이
    // 맞는 시스템 알림(발주 확인 등)은 모리 이미지를 아이콘으로 보낸다.
    let iconUrl = null;
    if (notification.fromPhone) {
      const fromSnap = await db.collection("accounts").doc(notification.fromPhone).get();
      iconUrl = (fromSnap.exists && fromSnap.data().avatarUrl) || null;
    } else if (MASCOT_ICON_BY_TYPE[notification.type]) {
      iconUrl = MASCOT_ICON_BY_TYPE[notification.type];
    }
    jobs.push(sendToTokens(tokens, { ...notification, iconUrl }));
  }
  await Promise.all(jobs);
}

// The share board lives at a different URL depending on the viewer's role
// (owner-side app-shell has a real share.html; staff.html has an in-page
// "share" view instead) — so a single "공유해요" event's recipients need
// per-role links, not one link for everybody. tab(옵션)을 주면 알림을 눌렀을
// 때 공유하기 화면만 열리는 게 아니라 해당 세그먼트 탭(소통해요/품절공유/
// 메뉴공유)까지 바로 넘어가도록 쿼리스트링에 stab을 함께 싣는다 —
// shareboard.js의 setInitialShareTab이 이 값을 읽어 적용한다. dateStr(옵션)은
// 그 글이 올라온 날짜("YYYY-MM-DD") — 오늘 글이 아니면(품절은 해제 전까지
// 이월되니 특히 자주 있다) 날짜칩도 그 날짜로 같이 옮겨가야 바로 보인다.
function shareLinkForRole(role, tab, dateStr) {
  const base = role === "owner" ? "/share.html" : "/staff.html?view=share";
  const params = [];
  if (tab) params.push(`stab=${tab}`);
  if (dateStr) params.push(`sdate=${dateStr}`);
  if (params.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${params.join("&")}`;
}

// 새 발주 요청이 제출되면 사장님(들)에게 알림. 직원이 "발주 요청하기"를 한 번
//누르면 담아둔 자재 수만큼 checks/{date}/items 문서가 생기는데, 예전에는 이
// 컬렉션을 직접 구독해서 자재 개수만큼 알림이 우르르 갔다 — 대신 제출 시점에
// staff.js가 별도로 남기는 requestBatches 문서(제출 묶음 1건당 1개) 를
// 구독해서, 제출할 때마다 딱 한 번만 알림이 가도록 한다.
exports.notifyOwnerOnNewRequest = onDocumentCreated("checks/{date}/requestBatches/{batchId}", async (event) => {
  const batch = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const phones = [];
  const tokens = [];
  ownersSnap.forEach((doc) => { phones.push(doc.id); tokens.push(...tokensOf(doc.data().fcmTokens)); });
  await notify(phones, tokens, {
    title: "자재발주 요청",
    body: `${batch.staffName ? batch.staffName + "님이 " : ""}자재 발주 요청을 보냈습니다`,
    link: "/owner.html",
    type: "request",
    fromPhone: batch.staffPhone,
    fromName: batch.staffName,
  });
});

// 담은 목록 화면의 "사장님께 알리기" 버튼 — 직원이 "오늘 미주문건이 아직
// 있다"는 걸 그냥 상기시키고 싶을 때 누른다. 누가 눌렀는지는 알림
// 내용에 일부러 안 담는다(익명 리마인더 용도) — Firestore 문서 자체에는
// staffPhone을 남겨두지만(나중에 남용 확인이 필요할 경우를 대비), 알림
// 텍스트에는 절대 안 드러낸다.
exports.notifyOwnerUnorderedReminder = onDocumentCreated("checks/{date}/unorderedNudges/{nudgeId}", async (event) => {
  const nudge = event.data.data();
  const n = nudge.count || 0;
  if (n <= 0) return;
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const phones = [];
  const tokens = [];
  ownersSnap.forEach((doc) => { phones.push(doc.id); tokens.push(...tokensOf(doc.data().fcmTokens)); });
  await notify(phones, tokens, {
    title: "발주 알림",
    body: `오늘 미주문건 ${n}개 있습니다!!`,
    link: "/owner.html",
    type: "request",
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
  await notify([batch.staffPhone], tokens, {
    title: "사장님의 주문완료 알림",
    body: "사장님이 자재 주문을 완료했습니다",
    link: "/staff.html?view=cart",
    type: "order",
  });
});

// 공유하기 > 공유해요 또는 품절공유에 새 글이 올라오면 작성자를 제외한
// 모두에게 알림. 받는 사람의 역할(사장/직원)에 따라 열어줄 페이지가 다르고,
// @멘션된 사람에게는 "이미 모두에게 가는 일반 알림"을 중복으로 또 보내는
// 대신 제목만 "~님이 회원님을 언급했어요"로 바꿔서 구분되게 보낸다.
// 댓글(notifyOnNewReply)과 같은 규칙: @멘션이 있으면 멘션된 사람에게만,
// 없으면 작성자를 뺀 전원에게 알림이 간다.
exports.notifyOnNewShareNote = onDocumentCreated("shares/{date}/items/{itemId}", async (event) => {
  const itemDate = event.params.date;
  const item = event.data.data();
  if (item.type !== "note" && item.type !== "soldout") return;
  const isSoldout = item.type === "soldout";
  const defaultTitle = isSoldout ? "품절 공유 알림" : "소통해요 알림";
  const body = `${item.staffName ? item.staffName + "님: " : ""}${item.content || ""}${isSoldout ? " 품절됐어요" : ""}`;
  const mentionedPhones = new Set(item.mentions || []);
  const hasMention = !isSoldout && (item.mentionsAll || mentionedPhones.size > 0);

  const accSnap = await db.collection("accounts").get();
  const sends = [];
  accSnap.forEach((docSnap) => {
    if (docSnap.id === item.staffPhone) return;
    const mentioned = !isSoldout && (item.mentionsAll || mentionedPhones.has(docSnap.id));
    if (hasMention && !mentioned) return;
    const data = docSnap.data();
    const role = data.role === "owner" ? "owner" : "staff";
    sends.push(notify([docSnap.id], tokensOf(data.fcmTokens), {
      title: mentioned ? `${item.staffName ? item.staffName + "님이 " : ""}회원님을 언급했어요` : defaultTitle,
      body,
      link: shareLinkForRole(role, isSoldout ? "soldout" : "note", itemDate),
      type: isSoldout ? "soldout" : "share",
      fromPhone: item.staffPhone,
      fromName: item.staffName,
    }));
  });
  await Promise.all(sends);
});

// 품절이 해제되면(resolved: false/없음 -> true) 처리한 사람을 제외한 모두에게
// 알림 — 품절 등록 때(notifyOnNewShareNote)와 짝을 이루는 알림이라, 자재가
// 다시 들어온 걸 다들 바로 알 수 있게 한다. 이미 해제된 항목의 문구만 다시
// 고치는 경우(resolved가 이미 true)는 제외 — 그때는 다시 알릴 내용이 없다.
exports.notifyOnSoldoutResolved = onDocumentUpdated("shares/{date}/items/{itemId}", async (event) => {
  const itemDate = event.params.date;
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (after.type !== "soldout" || before.resolved || !after.resolved) return;

  const body = `${after.resolvedByName ? after.resolvedByName + "님: " : ""}${after.content || ""} 해제됐어요`;
  const accSnap = await db.collection("accounts").get();
  const byRole = { owner: { phones: [], tokens: [] }, staff: { phones: [], tokens: [] } };
  accSnap.forEach((docSnap) => {
    if (docSnap.id === after.resolvedByPhone) return;
    const role = docSnap.data().role === "owner" ? "owner" : "staff";
    byRole[role].phones.push(docSnap.id);
    byRole[role].tokens.push(...tokensOf(docSnap.data().fcmTokens));
  });
  await Promise.all(
    Object.keys(byRole).map((role) =>
      notify(byRole[role].phones, byRole[role].tokens, { title: "품절 해제 알림", body, link: shareLinkForRole(role, "soldout", itemDate), type: "soldout", fromPhone: after.resolvedByPhone, fromName: after.resolvedByName })
    )
  );
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
  const byRole = { owner: { phones: [], tokens: [] }, staff: { phones: [], tokens: [] } };
  accSnap.forEach((docSnap) => {
    if (docSnap.id === recipe.staffPhone) return;
    const role = docSnap.data().role === "owner" ? "owner" : "staff";
    byRole[role].phones.push(docSnap.id);
    byRole[role].tokens.push(...tokensOf(docSnap.data().fcmTokens));
  });
  await Promise.all(
    Object.keys(byRole).map((role) =>
      notify(byRole[role].phones, byRole[role].tokens, { title, body, link: shareLinkForRole(role, "recipe"), type: isDisco ? "discontinued" : "recipe", fromPhone: recipe.staffPhone, fromName: recipe.staffName })
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
  const byRole = { owner: { phones: [], tokens: [] }, staff: { phones: [], tokens: [] } };
  accSnap.forEach((doc) => {
    if (doc.id === entry.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    byRole[role].phones.push(doc.id);
    byRole[role].tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  const body = `${entry.staffName ? entry.staffName + "님이 " : ""}시재 ${(entry.total || 0).toLocaleString()}원을 등록했습니다`;
  await Promise.all(
    Object.keys(byRole).map((role) =>
      notify(byRole[role].phones, byRole[role].tokens, { title: "시재 등록 알림", body, link: registerLinkForRole(role), type: "cash", fromPhone: entry.staffPhone, fromName: entry.staffName })
    )
  );
});

// 출근기록 > 급여대장에서 직원이 월급 제출하면 사장님에게만 알림 — 다른
// 직원들은 서로의 급여 정보를 알 필요가 없으므로 owner 역할 계정에만 보낸다.
exports.notifyOwnerOnPayrollRequest = onDocumentCreated("payrollRequests/{requestId}", async (event) => {
  const req = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const phones = [];
  const tokens = [];
  ownersSnap.forEach((doc) => { phones.push(doc.id); tokens.push(...tokensOf(doc.data().fcmTokens)); });
  await notify(phones, tokens, {
    title: "급여 제출 알림",
    body: `${req.staffName ? req.staffName + "님이 " : ""}${req.cycleLabel || ""} 급여를 제출했습니다`,
    link: "/staff.html?view=payroll",
    type: "payroll",
    fromPhone: req.staffPhone,
    fromName: req.staffName,
  });
});

// 출퇴근 도장은 급여 계산과 무관한 별도 출근 확인용 — 직원이 도장을 찍을
// 때마다 사장님에게만 알림 (도장 찍은 본인이 사장님이면 자기 자신에게는
// 안 보낸다).
exports.notifyOwnerOnAttendanceStamp = onDocumentCreated("accounts/{phone}/attendance/{stampId}", async (event) => {
  const stamp = event.data.data();
  const phone = event.params.phone;
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const phones = [];
  const tokens = [];
  ownersSnap.forEach((doc) => {
    if (doc.id === phone) return;
    phones.push(doc.id);
    tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  const label = stamp.type === "in" ? "출근" : "퇴근";
  await notify(phones, tokens, {
    title: "출퇴근 알림",
    body: `${stamp.staffName ? stamp.staffName + "님이 " : ""}${stamp.time || ""} ${label} 도장을 찍었습니다`,
    link: "/staff.html?view=payroll",
    type: "attendance",
    fromPhone: phone,
    fromName: stamp.staffName,
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
  const itemDate = event.params.date;
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
    const role = data.role === "owner" ? "owner" : "staff";
    sends.push(notify([docSnap.id], tokensOf(data.fcmTokens), {
      title: mentioned ? `${newReply.staffName ? newReply.staffName + "님이 " : ""}회원님을 언급했어요` : "소통해요 알림",
      body,
      link: shareLinkForRole(role, "note", itemDate),
      type: "share",
      fromPhone: newReply.staffPhone,
      fromName: newReply.staffName,
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
  const itemDate = event.params.date;
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
  await notify([after.staffPhone], tokens, {
    title: "소통해요 알림",
    body: `${reactorName}님이 ${withEulReul(label)} 눌렀습니다`,
    link: shareLinkForRole(authorAccSnap.data().role, "note", itemDate),
    type: "share",
    fromPhone: reactorPhone,
    fromName: reactorName,
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
      owners.push({ phone: docSnap.id, fcmTokens: data.fcmTokens });
      return;
    }
    if (data.paydayOfMonth && data.paydayOfMonth === todayDay) {
      staffOnPayday.push({ phone: docSnap.id, name: data.name, fcmTokens: data.fcmTokens });
    }
  });
  if (staffOnPayday.length === 0) return;

  const ownerPhones = owners.map((o) => o.phone);
  const ownerTokens = [];
  owners.forEach((o) => ownerTokens.push(...tokensOf(o.fcmTokens)));

  await Promise.all([
    ...staffOnPayday.map((s) =>
      notify([s.phone], tokensOf(s.fcmTokens), {
        title: "월급날 알림",
        body: "오늘은 월급날이에요! 사장님께 급여내역을 제출해보세요",
        link: "/staff.html?view=payroll",
        type: "payroll",
      })
    ),
    ...staffOnPayday.map((s) =>
      notify(ownerPhones, ownerTokens, {
        title: "급여 지급일 알림",
        body: `${s.name || "직원"}님 급여 지급날입니다!`,
        link: "/staff.html?view=payroll",
        type: "payroll",
        fromPhone: s.phone,
        fromName: s.name,
      })
    ),
  ]);
});

// 직원이 매번 조사해서 담지 않아도, 이틀에 한 번씩 자동으로 정상발주 상태로
// 요청되는 고정 자재. 시작일부터 이틀 간격(diff % 2 === 0)으로만 해당 날짜에
// 문서를 만든다 — .create()라서 그날 이미 (사람이 직접 담았든, 이 함수가
// 이미 만들었든) 같은 자재 문서가 있으면 조용히 건너뛰고 덮어쓰지 않는다.
// 자재 ID를 직접 하드코딩하는 대신 이름으로 매번 조회한다 — ID를 미리 알아둘
// 필요가 없어서 새 자재를 추가하기 쉽고, mainCategory/subCategory도 자재관리
// 쪽 실제 값을 그대로 따라가 어긋날 일이 없다.
const FIXED_INTERVAL_START = "2026-09-30";
const FIXED_INTERVAL_MATERIAL_NAMES = ["홀더(미듐)", "홀더(라지)", "일반우유", "디카원두", "일반원두"];

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

    for (const name of FIXED_INTERVAL_MATERIAL_NAMES) {
      const matSnap = await db.collection("materials").where("name", "==", name).limit(1).get();
      if (matSnap.empty) {
        console.warn(`autoRequestFixedMaterials: 자재관리에서 "${name}" 이름의 자재를 못 찾았어요 — 건너뜀`);
        continue;
      }
      const m = matSnap.docs[0];
      const data = m.data();
      const ref = db.collection("checks").doc(today).collection("autoPending").doc(m.id);
      try {
        await ref.create({
          materialName: data.name,
          mainCategory: data.mainCategory,
          subCategory: data.subCategory,
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
        return notify([s.id], tokensOf(data.fcmTokens), {
          title: "시재 등록 알림",
          body: `${timeStr} 시재를 등록해주세요`,
          link: registerLinkForRole(data.role),
          type: "cash",
        });
      })
  );
}

exports.notifyCashRegister11am = onSchedule({ schedule: "0 11 * * 1-5", timeZone: "Asia/Seoul" }, () => notifyScheduledCashReminder(11));
exports.notifyCashRegister2pm = onSchedule({ schedule: "0 14 * * 1-5", timeZone: "Asia/Seoul" }, () => notifyScheduledCashReminder(14));
exports.notifyCashRegister6pm = onSchedule({ schedule: "0 18 * * 1-5", timeZone: "Asia/Seoul" }, () => notifyScheduledCashReminder(18));

// ---- 발주 체크 알림 (일요일 제외 매일 오후 3시) ----
// 오늘 요청된 자재 중 하나라도 주문완료 체크가 안 됐거나(!ordered), 영수증이
// 하나도 안 붙어있으면(그날 전체 영수증도 없고 그 자재에 개별 첨부도 없음)
// 사장님에게 리마인드. 오늘 요청된 자재가 하나도 없으면(주문할 게 없음)
// 보낼 이유가 없어 건너뛴다.
exports.notifyOwnerOrderReminder = onSchedule({ schedule: "0 15 * * 1-6", timeZone: "Asia/Seoul" }, async () => {
  const today = kstDateStr(new Date());
  const itemsSnap = await db.collection("checks").doc(today).collection("items").get();
  if (itemsSnap.empty) return;

  const checkDocSnap = await db.collection("checks").doc(today).get();
  const hasDayReceipt = (checkDocSnap.exists && checkDocSnap.data().receiptPhotos || []).length > 0;

  const needsReminder = itemsSnap.docs.some((docSnap) => {
    const it = docSnap.data();
    if (!it.ordered) return true;
    const hasItemReceipt = hasDayReceipt || (it.ownerAttachedPhotos || []).length > 0;
    return !hasItemReceipt;
  });
  if (!needsReminder) return;

  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const phones = [];
  const tokens = [];
  ownersSnap.forEach((docSnap) => { phones.push(docSnap.id); tokens.push(...tokensOf(docSnap.data().fcmTokens)); });
  await notify(phones, tokens, {
    title: "발주 확인",
    body: "오늘 자재 주문 하셨나요? 모리가 기다리고 있어요",
    link: "/owner.html",
    type: "orderReminder",
  });
});

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
      await notify([d.staffPhone], tokens, {
        title: "내일 근무 알림",
        body: `내일 ${d.shiftType || ""} ${d.startTime || ""}~${d.endTime || ""} 근무예요`,
        link: "/staff.html?view=payroll",
        type: "schedule",
      });
    })
  );
});

// ---- 극한직업 일지 등록 알림 ----
// 가볍게 공감하고 넘기는 게 목적인 기능이라, 작성자 본인을 뺀 전 직원(+사장님)
// 에게 바로 알림을 보낸다 — 공유해요처럼 역할별로 열어줄 페이지가 다를 필요가
// 없는 단일 화면 기능이라 링크도 /staff.html 하나로 고정.
exports.notifyOnHumanityCrack = onDocumentCreated("humanityCracks/{crackId}", async (event) => {
  const crack = event.data.data();
  const accSnap = await db.collection("accounts").get();
  const phones = [];
  const tokens = [];
  accSnap.forEach((doc) => {
    if (doc.id === crack.staffPhone) return;
    phones.push(doc.id);
    tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  await notify(phones, tokens, {
    title: "💢 극한직업 일지",
    body: `${crack.staffName ? crack.staffName + "님: " : ""}${crack.reason || ""}`,
    link: "/staff.html",
    type: "humanity",
    fromPhone: crack.staffPhone,
    fromName: crack.staffName,
  });
});

// 공유해요의 답글(notifyOnNewReply)과 같은 규칙: @멘션이 있으면 멘션된
// 사람에게만, 없으면 작성자를 뺀 전원에게 알림이 간다.
exports.notifyOnNewHumanityReply = onDocumentUpdated("humanityCracks/{crackId}", async (event) => {
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
    sends.push(notify([docSnap.id], tokensOf(data.fcmTokens), {
      title: mentioned ? `${newReply.staffName ? newReply.staffName + "님이 " : ""}회원님을 언급했어요` : "💢 극한직업 일지 댓글",
      body,
      link: "/staff.html",
      type: "humanity",
      fromPhone: newReply.staffPhone,
      fromName: newReply.staffName,
    }));
  });
  await Promise.all(sends);
});

// ---- 단종 메뉴 공지 자동 정리 (매일 새벽 4시) ----
// 단종 소식은 "이제 안 만드는 메뉴" 공지라 직원들이 한 달 정도 보고 나면
// 더 들고 있을 필요가 없다 — 레시피 탭이 오래된 단종 공지로 계속 쌓이지
// 않도록, 등록된 지 30일 지난 status:"discontinued" 문서를 매일 정리한다.
// 변경(신메뉴/기존메뉴) 레시피는 계속 참고할 자료라 대상이 아니다.
exports.cleanupOldDiscontinuedRecipes = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snap = await db
    .collection("recipes")
    .where("status", "==", "discontinued")
    .where("createdAt", "<", cutoff)
    .get();
  if (snap.empty) return;
  const batch = db.batch();
  snap.docs.forEach((docSnap) => batch.delete(docSnap.ref));
  await batch.commit();
});

// ---- 오늘의 노래 미등록 알림 (매일 아침 6시) ----
// public/js/musicbar.js의 요일별 순서 로직을 서버에서도 그대로 재현해 "오늘
// 담당자가 누구인지" 판단한다 — 두 곳 로직이 갈라지면 안 되니 바뀔 땐 항상
// 같이 맞춰야 한다. 이미 등록돼 있으면(songOfTheDay/{today} 존재) 보내지
// 않는다.
const SONG_PICKER_START_DATE = "2026-10-07";
const SONG_PICKER_WEEKDAY_ORDER = [
  { phone: "01064082901", name: "진우" },
  { phone: "01083477412", name: "하린" },
  { phone: "01038355240", name: "유리" },
];
const SONG_PICKER_WEEKEND = { phone: "01071362938", name: "지안" };

function songPickerWeekdayIndexSince(fromDateStr, toDateStr) {
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

function todaysSongPicker(dateStr) {
  const dow = new Date(`${dateStr}T00:00:00`).getDay();
  if (dow === 0 || dow === 6) return SONG_PICKER_WEEKEND;
  const idx = songPickerWeekdayIndexSince(SONG_PICKER_START_DATE, dateStr);
  const n = SONG_PICKER_WEEKDAY_ORDER.length;
  return SONG_PICKER_WEEKDAY_ORDER[((idx % n) + n) % n];
}

exports.notifySongPickerMorning = onSchedule({ schedule: "0 6 * * *", timeZone: "Asia/Seoul" }, async () => {
  const today = kstDateStr(new Date());
  const songSnap = await db.collection("songOfTheDay").doc(today).get();
  if (songSnap.exists) return;
  const picker = todaysSongPicker(today);
  const accSnap = await db.collection("accounts").doc(picker.phone).get();
  if (!accSnap.exists) return;
  const data = accSnap.data();
  await notify([picker.phone], tokensOf(data.fcmTokens), {
    title: "🎵 오늘의 노래",
    body: "오늘의 노래를 아직 등록 안 하셨어요 — 검색해서 골라주세요",
    link: data.role === "owner" ? "/owner.html" : "/staff.html",
    type: "song",
  });
});

// ---- 알림내역 자동 정리 (매일 새벽 4시) ----
// 알림 패널은 "최근 3일"만 보여주면 충분한 용도라(최근에 뭘 놓쳤는지 확인
// 하는 게 목적이지 전체 이력 보관이 목적이 아니다), 3일 지난 기록은
// collectionGroup으로 모든 계정을 한 번에 훑어 지운다. Admin SDK라 보안
// 규칙과 무관하게 전체를 조회할 수 있다.
exports.cleanupOldNotifications = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const snap = await db.collectionGroup("notifications").where("createdAt", "<", cutoff).get();
  if (snap.empty) return;
  // batch는 최대 500건이라, 혹시 한 번에 넘치면 여러 배치로 나눠 처리한다.
  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 450) chunks.push(snap.docs.slice(i, i + 450));
  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
  }
});

// ---- 급여 제출함 월간 자동 리셋 (매월 1일 자정) ----
// 제출된 급여 요청은 날짜별로 안 나뉘고 하나의 컬렉션에 계속 쌓이기만
// 해서, 사장님이 입금 처리할 때마다 일일이 지우지 않으면 계속 늘어난다.
// 새 달이 시작되면 지난달 제출분은 이미 처리됐을 거라 보고, 과거 이력을
// 따로 보관할 필요 없이 전체를 비워서 급여 제출함을 깨끗한 상태로
// 시작하게 한다.
exports.resetPayrollRequestsMonthly = onSchedule({ schedule: "0 0 1 * *", timeZone: "Asia/Seoul" }, async () => {
  const snap = await db.collection("payrollRequests").get();
  if (snap.empty) return;
  const chunks = [];
  for (let i = 0; i < snap.docs.length; i += 450) chunks.push(snap.docs.slice(i, i + 450));
  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach((docSnap) => batch.delete(docSnap.ref));
    await batch.commit();
  }
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

// ---- 영수증 사진 글자 인식(OCR) ----
// 사장님이 "전체 영수증" 사진을 올리면, 그 사진에서 글자를 읽어서 어떤
// 자재가 찍혀 있는지 클라이언트(owner.js)가 자재 목록과 대조해 자동으로
// 체크할 수 있게 원문 텍스트만 돌려준다 — 매칭 판단은 클라이언트가 한다.
// Cloud Vision API 사용(월 1,000장까지 무료, 이후 1,000장당 약 1,500원 —
// 가게당 하루 한두 번 쓰는 용도라 보통 무료 한도 안에서 끝난다).
exports.extractReceiptText = onRequest({ cors: true }, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) {
    res.status(400).json({ text: "" });
    return;
  }
  try {
    const bucket = admin.storage().bucket();
    const file = bucket.file(filePath);
    const [buf] = await file.download();
    const [result] = await visionClient.textDetection({ image: { content: buf } });
    const text = (result.fullTextAnnotation && result.fullTextAnnotation.text) || "";
    res.json({ text });
  } catch (e) {
    console.error("영수증 OCR 실패", e);
    res.status(500).json({ text: "" });
  }
});

// ---- 오늘의 노래: 유튜브 검색 프록시 ----
// API 키를 클라이언트에 그대로 내려주지 않으려고 서버에서 대신 호출한다
// (키가 새어나가도 이 함수 하나만 막으면 되게). YouTube Data API는 하루
// 10,000 유닛까지 무료이고 검색 1번에 100 유닛이라, 하루 100번 검색까지는
// 무료 — 이 매장 규모에서 쓸 "오늘의 노래" 검색 용도로는 충분하다.
exports.searchYoutube = onRequest({ cors: true, secrets: [YOUTUBE_API_KEY] }, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) {
    res.status(400).json({ items: [] });
    return;
  }
  try {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=8&q=${encodeURIComponent(q)}&key=${YOUTUBE_API_KEY.value()}`;
    const r = await fetch(url);
    const data = await r.json();
    const items = (data.items || []).map((it) => ({
      videoId: it.id.videoId,
      title: it.snippet.title,
      channelTitle: it.snippet.channelTitle,
      thumbnail: (it.snippet.thumbnails && (it.snippet.thumbnails.default || {}).url) || "",
    }));
    res.json({ items });
  } catch (e) {
    console.error("유튜브 검색 실패", e);
    res.status(500).json({ items: [] });
  }
});
