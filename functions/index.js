const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
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
exports.notifyOwnerOnNewRequest = onDocumentCreated("stores/{storeId}/checks/{date}/requestBatches/{batchId}", async (event) => {
  const storeId = event.params.storeId;
  const batch = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").where("storeId", "==", storeId).get();
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
exports.notifyOwnerUnorderedReminder = onDocumentCreated("stores/{storeId}/checks/{date}/unorderedNudges/{nudgeId}", async (event) => {
  const storeId = event.params.storeId;
  const nudge = event.data.data();
  const n = nudge.count || 0;
  if (n <= 0) return;
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").where("storeId", "==", storeId).get();
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
exports.notifyStaffOnOrdered = onDocumentCreated("stores/{storeId}/checks/{date}/orderBatches/{batchId}", async (event) => {
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
exports.notifyOnNewShareNote = onDocumentCreated("stores/{storeId}/shares/{date}/items/{itemId}", async (event) => {
  const storeId = event.params.storeId;
  const itemDate = event.params.date;
  const item = event.data.data();
  if (item.type !== "note" && item.type !== "soldout") return;
  const isSoldout = item.type === "soldout";
  const defaultTitle = isSoldout ? "품절 공유 알림" : "소통해요 알림";
  // 품절공유는 누가 올렸는지보다 품절 사실 자체가 중요해서 익명으로 보낸다
  // (소통해요는 대화라 누가 썼는지가 여전히 중요해 그대로 둔다).
  const body = isSoldout
    ? `${item.content || ""} 품절됐어요`
    : `${item.staffName ? item.staffName + "님: " : ""}${item.content || ""}`;
  const mentionedPhones = new Set(item.mentions || []);
  const hasMention = !isSoldout && (item.mentionsAll || mentionedPhones.size > 0);

  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
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
      ...(isSoldout ? {} : { fromPhone: item.staffPhone, fromName: item.staffName }),
    }));
  });
  await Promise.all(sends);
});

// 품절이 해제되면(resolved: false/없음 -> true) 처리한 사람을 제외한 모두에게
// 알림 — 품절 등록 때(notifyOnNewShareNote)와 짝을 이루는 알림이라, 자재가
// 다시 들어온 걸 다들 바로 알 수 있게 한다. 이미 해제된 항목의 문구만 다시
// 고치는 경우(resolved가 이미 true)는 제외 — 그때는 다시 알릴 내용이 없다.
exports.notifyOnSoldoutResolved = onDocumentUpdated("stores/{storeId}/shares/{date}/items/{itemId}", async (event) => {
  const storeId = event.params.storeId;
  const itemDate = event.params.date;
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (after.type !== "soldout" || before.resolved || !after.resolved) return;

  const body = `${after.resolvedByName ? after.resolvedByName + "님: " : ""}${after.content || ""} 해제됐어요`;
  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
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
exports.notifyOnNewRecipe = onDocumentCreated("stores/{storeId}/recipes/{recipeId}", async (event) => {
  const storeId = event.params.storeId;
  const recipe = event.data.data();
  const isDisco = recipe.status === "discontinued";
  const title = isDisco ? "🔴 메뉴 단종 알림" : "📖 레시피 등록 알림";
  // 누가 등록/단종했는지보다 메뉴 자체가 중요해서 익명으로 보낸다.
  const body = `${recipe.menuName || ""}${isDisco ? " 단종됐어요" : " 레시피가 등록됐어요"}`;
  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
  const byRole = { owner: { phones: [], tokens: [] }, staff: { phones: [], tokens: [] } };
  accSnap.forEach((docSnap) => {
    if (docSnap.id === recipe.staffPhone) return;
    const role = docSnap.data().role === "owner" ? "owner" : "staff";
    byRole[role].phones.push(docSnap.id);
    byRole[role].tokens.push(...tokensOf(docSnap.data().fcmTokens));
  });
  await Promise.all(
    Object.keys(byRole).map((role) =>
      notify(byRole[role].phones, byRole[role].tokens, { title, body, link: shareLinkForRole(role, "recipe"), type: isDisco ? "discontinued" : "recipe" })
    )
  );
});

// 등록해요 > 시재 등록 / 선결제 충전 등록에 새 기록이 쌓이면 등록한 사람을
// 제외한 모두에게 알림.
function registerLinkForRole(role) {
  return role === "owner" ? "/register.html" : "/staff.html?view=register";
}

exports.notifyOnNewCashEntry = onDocumentCreated("stores/{storeId}/cashRegister/{date}/entries/{entryId}", async (event) => {
  const storeId = event.params.storeId;
  const entry = event.data.data();
  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
  const byRole = { owner: { phones: [], tokens: [] }, staff: { phones: [], tokens: [] } };
  accSnap.forEach((doc) => {
    if (doc.id === entry.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    byRole[role].phones.push(doc.id);
    byRole[role].tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  // 누가 등록했는지보다 금액 자체가 중요해서 익명으로 보낸다.
  const body = `시재 ${(entry.total || 0).toLocaleString()}원을 등록했습니다`;
  await Promise.all(
    Object.keys(byRole).map((role) =>
      notify(byRole[role].phones, byRole[role].tokens, { title: "시재 등록 알림", body, link: registerLinkForRole(role), type: "cash" })
    )
  );
});

// 선결제 충전 등록 알림 — 누가 등록했는지는 밝히지 않고(익명), 어느
// 고객에게 충전됐는지만 모두에게 알린다(등록한 사람 본인 제외).
exports.notifyOnNewTopup = onDocumentCreated("stores/{storeId}/topups/{topupId}", async (event) => {
  const storeId = event.params.storeId;
  const topup = event.data.data();
  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
  const byRole = { owner: { phones: [], tokens: [] }, staff: { phones: [], tokens: [] } };
  accSnap.forEach((doc) => {
    if (doc.id === topup.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    byRole[role].phones.push(doc.id);
    byRole[role].tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  const body = `${topup.customerName || ""}에게 선결제 충전이 등록되었습니다`;
  await Promise.all(
    Object.keys(byRole).map((role) =>
      notify(byRole[role].phones, byRole[role].tokens, { title: "선결제 충전 알림", body, link: registerLinkForRole(role), type: "topup" })
    )
  );
});

// 출근기록 > 급여대장에서 직원이 월급 제출하면 사장님에게만 알림 — 다른
// 직원들은 서로의 급여 정보를 알 필요가 없으므로 owner 역할 계정에만 보낸다.
exports.notifyOwnerOnPayrollRequest = onDocumentCreated("stores/{storeId}/payrollRequests/{requestId}", async (event) => {
  const storeId = event.params.storeId;
  const req = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").where("storeId", "==", storeId).get();
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
  const actingAccSnap = await db.collection("accounts").doc(phone).get();
  const storeId = actingAccSnap.exists ? actingAccSnap.data().storeId : null;
  if (!storeId) return;
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").where("storeId", "==", storeId).get();
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
exports.notifyOnNewReply = onDocumentUpdated("stores/{storeId}/shares/{date}/items/{itemId}", async (event) => {
  const storeId = event.params.storeId;
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

  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
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

// "HH:MM" — 스케줄의 startTime/endTime과 같은 형식(payroll.js의 5분 단위
// 시각 선택기와 맞춰, 이 함수도 5분 간격으로만 돌리면 정확히 들어맞는다).
function kstTimeStr(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
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
exports.awardHoneyOnOrderBatch = onDocumentCreated("stores/{storeId}/checks/{date}/orderBatches/{batchId}", async (event) => {
  const storeId = event.params.storeId;
  const date = event.params.date;
  if (date !== kstDateStr(new Date())) return; // only same-day completion counts

  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").where("storeId", "==", storeId).get();
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

exports.notifyOnNewReaction = onDocumentUpdated("stores/{storeId}/shares/{date}/items/{itemId}", async (event) => {
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
// 매장별로 자재 목록이 따로라(stores/{storeId}/materials), 매장마다 돌며
// 각자의 자재 목록에서 이름을 찾아 각자의 checks에 담아준다.
exports.autoRequestFixedMaterials = onSchedule(
  { schedule: "0 8 * * *", timeZone: "Asia/Seoul" },
  async () => {
    const today = kstDateStr(new Date());
    const diff = kstDaysBetween(today, FIXED_INTERVAL_START);
    if (diff < 0 || diff % 2 !== 0) return; // 아직 시작 전이거나, 이틀 주기가 아닌 날

    const storesSnap = await db.collection("stores").get();
    for (const storeDoc of storesSnap.docs) {
      const storeId = storeDoc.id;
      for (const name of FIXED_INTERVAL_MATERIAL_NAMES) {
        const matSnap = await db.collection("stores").doc(storeId).collection("materials").where("name", "==", name).limit(1).get();
        if (matSnap.empty) {
          console.warn(`autoRequestFixedMaterials: ${storeId} 자재관리에서 "${name}" 이름의 자재를 못 찾았어요 — 건너뜀`);
          continue;
        }
        const m = matSnap.docs[0];
        const data = m.data();
        const ref = db.collection("stores").doc(storeId).collection("checks").doc(today).collection("autoPending").doc(m.id);
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
  }
);

// ---- 시재등록 정기 알림 (평일 11시/14시/18시) ----
// 그 시각에 근무표(schedules)상 근무 중인 직원에게만 "시재 등록해주세요"
// 알림을 보낸다 — 매장에 아무도 없는데 알림이 가는 일이 없도록, 전체
// 직원이 아니라 근무표 기준으로 그 시간을 포함하는 근무가 있는 사람만 추린다.
async function notifyScheduledCashReminder(hour) {
  const today = kstDateStr(new Date());
  const timeStr = `${String(hour).padStart(2, "0")}:00`;
  const schedSnap = await db.collectionGroup("schedules").where("date", "==", today).get();
  const onDutyPhones = new Set();
  schedSnap.forEach((docSnap) => {
    if (!docSnap.ref.path.startsWith("stores/")) return; // 마이그레이션 전 옛 평평한 경로 중복 데이터 무시
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
  const storesSnap = await db.collection("stores").get();
  await Promise.all(
    storesSnap.docs.map(async (storeDoc) => {
      const storeId = storeDoc.id;
      const storeRef = db.collection("stores").doc(storeId);
      const itemsSnap = await storeRef.collection("checks").doc(today).collection("items").get();
      if (itemsSnap.empty) return;

      const checkDocSnap = await storeRef.collection("checks").doc(today).get();
      const hasDayReceipt = (checkDocSnap.exists && checkDocSnap.data().receiptPhotos || []).length > 0;

      const needsReminder = itemsSnap.docs.some((docSnap) => {
        const it = docSnap.data();
        if (!it.ordered) return true;
        const hasItemReceipt = hasDayReceipt || (it.ownerAttachedPhotos || []).length > 0;
        return !hasItemReceipt;
      });
      if (!needsReminder) return;

      const ownersSnap = await db.collection("accounts").where("role", "==", "owner").where("storeId", "==", storeId).get();
      const phones = [];
      const tokens = [];
      ownersSnap.forEach((docSnap) => { phones.push(docSnap.id); tokens.push(...tokensOf(docSnap.data().fcmTokens)); });
      await notify(phones, tokens, {
        title: "발주 확인",
        body: "오늘 자재 주문 하셨나요? 모리가 기다리고 있어요",
        link: "/owner.html",
        type: "orderReminder",
      });
    })
  );
});

// ---- 근무표 출근 전날 알림 (매일 밤 9시) ----
// 내일(KST) 날짜로 등록된 근무표 항목을 모아, 각자 본인에게만 "내일 근무예요"
// 알림을 보낸다 — 다른 직원의 스케줄까지 알 필요는 없으므로 본인 항목만.
exports.notifyTomorrowShift = onSchedule({ schedule: "0 21 * * *", timeZone: "Asia/Seoul" }, async () => {
  const tomorrow = kstDateStr(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const schedSnap = await db.collectionGroup("schedules").where("date", "==", tomorrow).get();
  if (schedSnap.empty) return;
  await Promise.all(
    schedSnap.docs.map(async (docSnap) => {
      if (!docSnap.ref.path.startsWith("stores/")) return; // 마이그레이션 전 옛 평평한 경로 중복 데이터 무시
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

// ---- 출퇴근 도장 10분 전 알림 (5분마다) ----
// 직원들이 도장 찍는 걸 자꾸 깜빡해서, 오늘 스케줄상 출근/퇴근 10분 전인
// 사람에게 콕 집어 알려준다. 스케줄 시각 선택기가 5분 단위라(payroll.js
// timeSelectHtml), 이 함수도 정확히 5분마다 돌면 "지금+10분"이 항상 스케줄
// 시각과 정확히 맞아떨어진다 — 그래서 범위 비교 없이 문자열 그대로
// 비교해도 된다. 시점 하나(그 10분 전 순간)에만 한 번 걸리므로 중복 알림
// 걱정도 없다.
exports.notifyShiftStampReminder = onSchedule({ schedule: "*/5 * * * *", timeZone: "Asia/Seoul" }, async () => {
  const today = kstDateStr(new Date());
  const target = kstTimeStr(new Date(Date.now() + 10 * 60 * 1000));
  const schedSnap = await db.collectionGroup("schedules").where("date", "==", today).get();
  const hits = schedSnap.docs.filter((docSnap) => {
    if (!docSnap.ref.path.startsWith("stores/")) return false; // 마이그레이션 전 옛 평평한 경로 중복 데이터 무시
    const d = docSnap.data();
    return d.startTime === target || d.endTime === target;
  });
  if (hits.length === 0) return;
  await Promise.all(
    hits.map(async (docSnap) => {
      const d = docSnap.data();
      if (!d.staffPhone) return;
      const isStart = d.startTime === target;
      // Cloud Scheduler는 "최소 1번"만 보장해서, 가끔 같은 5분 틱이 두 번
      // 실행될 때가 있다 — 트랜잭션으로 "이 target 시각엔 이미 보냈다"는
      // 표시를 스케줄 문서에 선점해서, 먼저 들어온 실행만 알림을 보내고
      // 뒤이어 들어온 중복 실행은 조용히 건너뛴다.
      const markerField = isStart ? "startReminderSentAt" : "endReminderSentAt";
      const alreadySent = await db.runTransaction(async (tx) => {
        const fresh = await tx.get(docSnap.ref);
        if (!fresh.exists) return true;
        if (fresh.data()[markerField] === target) return true;
        tx.update(docSnap.ref, { [markerField]: target });
        return false;
      });
      if (alreadySent) return;
      const accSnap = await db.collection("accounts").doc(d.staffPhone).get();
      if (!accSnap.exists) return;
      await notify([d.staffPhone], tokensOf(accSnap.data().fcmTokens), {
        title: "⏰ 출퇴근 도장 알림",
        body: `10분 후 ${isStart ? "출근" : "퇴근"} 시간이에요 — 도장 찍는 거 잊지 마세요!`,
        link: "/staff.html?view=payroll",
        type: "attendance",
      });
    })
  );
});

// ---- 극한직업 일지 등록 알림 ----
// 가볍게 공감하고 넘기는 게 목적인 기능이라, 작성자 본인을 뺀 전 직원(+사장님)
// 에게 바로 알림을 보낸다 — 공유해요처럼 역할별로 열어줄 페이지가 다를 필요가
// 없는 단일 화면 기능이라 링크도 /staff.html 하나로 고정.
exports.notifyOnHumanityCrack = onDocumentCreated("stores/{storeId}/humanityCracks/{crackId}", async (event) => {
  const storeId = event.params.storeId;
  const crack = event.data.data();
  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
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
exports.notifyOnNewHumanityReply = onDocumentUpdated("stores/{storeId}/humanityCracks/{crackId}", async (event) => {
  const storeId = event.params.storeId;
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

  const accSnap = await db.collection("accounts").where("storeId", "==", storeId).get();
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
    .collectionGroup("recipes")
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

// 요일별 순번 자체가 이 매장 멤버 전화번호로 하드코딩돼 있어 애초에
// 매장 하나만 전제한 기능이라, storeId도 그 매장 고정값으로 둔다 — 다른
// 매장까지 지원하려면 이 순번 로직 자체를 매장별 설정으로 바꿔야 한다.
const SONG_PICKER_STORE_ID = "mmth";

exports.notifySongPickerMorning = onSchedule({ schedule: "0 6 * * *", timeZone: "Asia/Seoul" }, async () => {
  const today = kstDateStr(new Date());
  const songSnap = await db.collection("stores").doc(SONG_PICKER_STORE_ID).collection("songOfTheDay").doc(today).get();
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

// ---- 게시판 고정 자동 만료 (매일 새벽 4시) ----
// 고정(📌)은 "7일 지나도 계속 보존"이 목적이지 영구보존이 목적은 아니라서
// (매장이 늘수록 포인터가 끝없이 쌓이는 걸 막기 위해), 고정한 지 30일
// 지난 건 포인터만 지워서 게시판에서 빠지게 한다 — 원본 글 자체는 지우지
// 않는다, 그냥 다시 평범한 과거 글로 돌아갈 뿐이다.
exports.cleanupExpiredPinnedShareItems = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
  const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const snap = await db.collectionGroup("pinnedShareItems").where("pinnedAt", "<", cutoff).get();
  if (snap.empty) return;
  await Promise.all(
    snap.docs.map(async (docSnap) => {
      const { date } = docSnap.data();
      const storeId = docSnap.ref.parent.parent.id;
      await docSnap.ref.delete();
      if (date) {
        await db.collection("stores").doc(storeId).collection("shares").doc(date).collection("items").doc(docSnap.id)
          .update({ pinned: false })
          .catch(() => {}); // 원본 글이 이미 지워졌으면 그냥 넘어간다.
      }
    })
  );
});

// ---- 날짜별 운영 데이터 자동 정리 (자재요청목록/소통해요/시재등록) ----
// 매장이 늘수록 하루하루 쌓이는 날짜별 기록(stores/{storeId}/{top}/{date}/...)
// 이 끝없이 불어나는 걸 막는다. 날짜가 문서 ID라서 `collectionGroup(subName)`
// 으로 서브컬렉션 전체를 훑은 뒤 경로에서 날짜를 뽑아 기준일보다 오래된
// 것만 지운다 — checks/{date}, shares/{date} 같은 상위 날짜 문서는 항상
// 실제로 쓰이는 게 아니라서(예: shares/{date}는 아예 생성된 적이 없을 수도
// 있음) 하위 문서 기준으로 판단해야 빠짐없이 걸린다.
function dateFromCollectionGroupPath(path, topName) {
  const parts = path.split("/");
  const idx = parts.indexOf(topName);
  return idx !== -1 && idx + 1 < parts.length ? parts[idx + 1] : null;
}

async function deleteDocsInChunks(docs) {
  if (docs.length === 0) return;
  const chunks = [];
  for (let i = 0; i < docs.length; i += 450) chunks.push(docs.slice(i, i + 450));
  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
}

// topName의 날짜별 서브컬렉션들(subNames)에서 cutoffDateStr보다 오래된 걸
// 지우고, 상위 날짜 문서(stores/{storeId}/{topName}/{date})도 있으면 같이
// 지운다. skipIf(docSnap)가 true를 반환하면 그 문서는 보존한다(예: 고정된
// 소통해요 글).
async function cleanupOldDateBucketedDocs(topName, subNames, cutoffDateStr, skipIf) {
  for (const subName of subNames) {
    const snap = await db.collectionGroup(subName).get();
    const toDelete = snap.docs.filter((d) => {
      const date = dateFromCollectionGroupPath(d.ref.path, topName);
      if (!date || date >= cutoffDateStr) return false;
      if (skipIf && skipIf(d)) return false;
      return true;
    });
    await deleteDocsInChunks(toDelete);
  }
  const storesSnap = await db.collection("stores").get();
  for (const storeDoc of storesSnap.docs) {
    const parentSnap = await db.collection("stores").doc(storeDoc.id).collection(topName).get();
    const toDeleteParents = parentSnap.docs.filter((d) => d.id < cutoffDateStr);
    await deleteDocsInChunks(toDeleteParents);
  }
}

// 자재요청목록 — 90일 지난 건 순수 운영기록이라 더 들고 있을 필요가 없다.
exports.cleanupOldChecks = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
  const cutoff = kstDateStr(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  await cleanupOldDateBucketedDocs("checks", ["items", "requestBatches", "orderBatches", "autoPending", "unorderedNudges"], cutoff);
});

// 소통해요/품절공유/메뉴공유 글 — 90일 지나도 📌 고정해둔 글은 보존한다
// (게시판 기능과 짝을 이룸 — "계속 봐야 할 건 고정해두세요"가 전제).
exports.cleanupOldShares = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
  const cutoff = kstDateStr(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000));
  await cleanupOldDateBucketedDocs("shares", ["items"], cutoff, (d) => d.data().pinned === true);
});

// 시재등록 — 하루 단위로 리셋되는 기록이라(전날 시재가 오늘 계산에 안 쓰임)
// 7일이면 충분하다. 선결제(topups)는 여기 포함 안 됨 — 손님별 누적 충전액을
// 전체 기록 합산으로 계산하는 구조라, 오래된 기록을 지우면 잔액 계산이
// 틀어진다(그래서 의도적으로 삭제 대상에서 제외).
exports.cleanupOldCashRegister = onSchedule({ schedule: "0 4 * * *", timeZone: "Asia/Seoul" }, async () => {
  const cutoff = kstDateStr(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  await cleanupOldDateBucketedDocs("cashRegister", ["entries", "expenses"], cutoff);
});

// ---- 급여 제출함 월간 자동 리셋 (매월 1일 자정) ----
// 제출된 급여 요청은 날짜별로 안 나뉘고 하나의 컬렉션에 계속 쌓이기만
// 해서, 사장님이 입금 처리할 때마다 일일이 지우지 않으면 계속 늘어난다.
// 새 달이 시작되면 지난달 제출분은 이미 처리됐을 거라 보고, 과거 이력을
// 따로 보관할 필요 없이 전체를 비워서 급여 제출함을 깨끗한 상태로
// 시작하게 한다.
exports.resetPayrollRequestsMonthly = onSchedule({ schedule: "0 0 1 * *", timeZone: "Asia/Seoul" }, async () => {
  const snap = await db.collectionGroup("payrollRequests").get();
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
    const contentType = meta.contentType || "application/octet-stream";
    // 영상 첨부 지원 전엔 사진만 다뤄서 확장자를 .jpg로 고정해도 됐는데,
    // 이제 Content-Type에 맞는 확장자를 써야 저장된 파일이 올바르게 보인다.
    const ext = contentType.split("/")[1]?.split(";")[0] || "jpg";
    res.set("Content-Type", contentType);
    res.set("Content-Disposition", `attachment; filename="mamory_${Date.now()}.${ext}"`);
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

// ================================================================
// ---- 2단계: 로그인/가입 — PIN 검증을 서버(Admin SDK)에서만 한다 ----
// 지금까지는 사장님 PIN/가입코드를 클라이언트가 먼저 Firestore에서 읽어온
// 뒤 브라우저에서 비교했다 — 즉 입력한 PIN이 틀려도 진짜 PIN 값은 이미
// 브라우저로 전송된 뒤였다. 이제 비교 자체가 여기 서버 안에서 끝나고,
// 성공했을 때만 매장 정보(storeId)가 담긴 커스텀 토큰을 발급한다.
// Firestore 규칙은 이 토큰의 request.auth.token.storeId로 실제 매장을
// 가려낸다 — Firebase Auth UID는 전화번호를 그대로 쓴다(로그인 키라서).
// ================================================================

// 로그인 전(아직 인증 안 된) 단계에서 "이 번호가 가입됐는지/역할/개인
// PIN이 있는지"만 돌려준다 — PIN 값 자체는 절대 안 준다. 이전엔
// login.js가 accounts/{phone}을 직접 읽었는데, 이제 비인증 상태로는
// Firestore 규칙이 그 읽기를 막아서 이 함수가 그 자리를 대신한다.
exports.lookupAccountForLogin = onCall(async (req) => {
  const phone = ((req.data && req.data.phone) || "").toString();
  if (!/^010\d{8}$/.test(phone)) throw new HttpsError("invalid-argument", "전화번호 형식이 올바르지 않아요");
  const snap = await db.collection("accounts").doc(phone).get();
  if (!snap.exists) return { exists: false };
  const data = snap.data();
  if (data.role === "owner") {
    const pinSnap = data.storeId
      ? await db.collection("stores").doc(data.storeId).collection("config").doc("ownerPin").get()
      : null;
    return { exists: true, role: "owner", hasPin: !!(pinSnap && pinSnap.exists) };
  }
  return { exists: true, role: "staff", hasPin: !!data.pin };
});

exports.ownerLogin = onCall(async (req) => {
  const phone = ((req.data && req.data.phone) || "").toString();
  const pin = ((req.data && req.data.pin) || "").toString();
  if (pin.length < 4) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리 이상이어야 해요");
  const accSnap = await db.collection("accounts").doc(phone).get();
  if (!accSnap.exists || accSnap.data().role !== "owner") throw new HttpsError("not-found", "사장님 계정을 찾을 수 없어요");
  const acc = accSnap.data();
  const storeId = acc.storeId;
  if (!storeId) throw new HttpsError("failed-precondition", "매장 정보가 없는 계정이에요. 문의해주세요");

  const pinRef = db.collection("stores").doc(storeId).collection("config").doc("ownerPin");
  const pinSnap = await pinRef.get();
  if (!pinSnap.exists) {
    // 아직 한 번도 PIN을 만든 적 없는 매장(레거시) — 이번 입력을 새 PIN으로 생성.
    await pinRef.set({ pin, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  } else if (pinSnap.data().pin !== pin) {
    throw new HttpsError("permission-denied", "PIN이 올바르지 않아요");
  }

  const token = await admin.auth().createCustomToken(phone, { storeId, role: "owner", phone });
  return { token, account: { phone, name: acc.name, role: "owner", storeId } };
});

exports.staffLogin = onCall(async (req) => {
  const phone = ((req.data && req.data.phone) || "").toString();
  const pin = ((req.data && req.data.pin) || "").toString();
  if (pin.length < 4) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리 이상이어야 해요");
  const accSnap = await db.collection("accounts").doc(phone).get();
  if (!accSnap.exists || accSnap.data().role !== "staff") throw new HttpsError("not-found", "직원 계정을 찾을 수 없어요");
  const acc = accSnap.data();
  if (!acc.pin) throw new HttpsError("failed-precondition", "아직 개인 PIN이 없는 계정이에요");
  if (acc.pin !== pin) throw new HttpsError("permission-denied", "PIN이 올바르지 않아요");

  const token = await admin.auth().createCustomToken(phone, { storeId: acc.storeId, role: "staff", phone });
  return { token, account: { phone, name: acc.name, role: "staff", storeId: acc.storeId, pin: acc.pin } };
});

// 이 기능 배포 전부터 있던(=개인 PIN이 아직 없는) 직원 계정이 처음
// 로그인할 때, PIN 생성 + 로그인을 한 번에 처리한다.
exports.staffCreatePinAndLogin = onCall(async (req) => {
  const phone = ((req.data && req.data.phone) || "").toString();
  const pin = ((req.data && req.data.pin) || "").toString();
  if (pin.length < 4) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리 이상이어야 해요");
  const ref = db.collection("accounts").doc(phone);
  const accSnap = await ref.get();
  if (!accSnap.exists || accSnap.data().role !== "staff") throw new HttpsError("not-found", "직원 계정을 찾을 수 없어요");
  const acc = accSnap.data();
  if (acc.pin) throw new HttpsError("failed-precondition", "이미 개인 PIN이 등록된 계정이에요");

  await ref.update({ pin, pinUpdatedAt: admin.firestore.FieldValue.serverTimestamp() });
  const token = await admin.auth().createCustomToken(phone, { storeId: acc.storeId, role: "staff", phone });
  return { token, account: { phone, name: acc.name, role: "staff", storeId: acc.storeId, pin } };
});

// 가입 화면에서 PIN 입력 전에 코드가 맞는지만 미리 확인 — storeId는 안
// 준다(실제 가입은 registerAccount에서 한 번 더 서버가 직접 조회).
exports.checkAccessCode = onCall(async (req) => {
  const code = ((req.data && req.data.code) || "").toString().trim();
  if (!code) return { valid: false };
  const snap = await db.collection("accessCodes").doc(code).get();
  return { valid: snap.exists };
});

exports.registerAccount = onCall(async (req) => {
  const phone = ((req.data && req.data.phone) || "").toString();
  const name = ((req.data && req.data.name) || "").toString().trim();
  const role = req.data && req.data.role;
  const accessCode = ((req.data && req.data.accessCode) || "").toString().trim();
  const pin = ((req.data && req.data.pin) || "").toString();

  if (!/^010\d{8}$/.test(phone)) throw new HttpsError("invalid-argument", "전화번호 형식이 올바르지 않아요");
  if (!name) throw new HttpsError("invalid-argument", "이름을 입력해주세요");
  if (role !== "staff" && role !== "owner") throw new HttpsError("invalid-argument", "역할이 올바르지 않아요");
  if (pin.length < 4) throw new HttpsError("invalid-argument", "PIN은 숫자 4자리 이상이어야 해요");

  const accountRef = db.collection("accounts").doc(phone);
  const existing = await accountRef.get();
  if (existing.exists) throw new HttpsError("already-exists", "이미 등록된 번호예요");

  const codeSnap = await db.collection("accessCodes").doc(accessCode).get();
  if (!codeSnap.exists) throw new HttpsError("permission-denied", "가입 코드가 올바르지 않아요");
  const storeId = codeSnap.data().storeId;

  const account = { phone, name, role, storeId, createdAt: admin.firestore.FieldValue.serverTimestamp() };
  if (role === "staff") {
    account.pin = pin;
  } else {
    // 그 매장의 첫 사장님 가입이면 이번 입력이 그 매장의 사장님 PIN이
    // 되고, 이미 있으면 그 값과 일치해야 한다(매장당 공유 PIN 하나).
    const pinRef = db.collection("stores").doc(storeId).collection("config").doc("ownerPin");
    const pinSnap = await pinRef.get();
    if (!pinSnap.exists) {
      await pinRef.set({ pin, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    } else if (pinSnap.data().pin !== pin) {
      throw new HttpsError("permission-denied", "PIN이 올바르지 않아요");
    }
  }

  await accountRef.set(account);
  const token = await admin.auth().createCustomToken(phone, { storeId, role, phone });
  return { token, account: { phone, name, role, storeId, ...(role === "staff" ? { pin } : {}) } };
});

// 사장님 전용 — 가입 코드 변경. accessCodes/{old} 삭제 + {new} 생성 +
// stores/{storeId}/config/accessCode 갱신을 트랜잭션으로 한 번에.
exports.rotateAccessCode = onCall(async (req) => {
  if (!req.auth || req.auth.token.role !== "owner") throw new HttpsError("permission-denied", "사장님만 가능해요");
  const storeId = req.auth.token.storeId;
  const newCode = ((req.data && req.data.newCode) || "").toString().trim();
  if (!newCode) throw new HttpsError("invalid-argument", "가입 코드를 입력해주세요");

  await db.runTransaction(async (tx) => {
    const newCodeRef = db.collection("accessCodes").doc(newCode);
    const storeConfigRef = db.collection("stores").doc(storeId).collection("config").doc("accessCode");
    const [newCodeSnap, storeConfigSnap] = await Promise.all([tx.get(newCodeRef), tx.get(storeConfigRef)]);
    if (newCodeSnap.exists && newCodeSnap.data().storeId !== storeId) {
      throw new HttpsError("already-exists", "이미 다른 매장이 쓰고 있는 코드예요");
    }
    const oldCode = storeConfigSnap.exists ? storeConfigSnap.data().code : null;
    if (oldCode && oldCode !== newCode) tx.delete(db.collection("accessCodes").doc(oldCode));
    tx.set(newCodeRef, { storeId });
    tx.set(storeConfigRef, { code: newCode, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  });
  return { code: newCode };
});

// 사장님 전용 — 자재관리 화면이 현재 가입 코드를 미리 채워 보여주기 위한 읽기.
exports.getCurrentAccessCode = onCall(async (req) => {
  if (!req.auth || req.auth.token.role !== "owner") throw new HttpsError("permission-denied", "사장님만 가능해요");
  const storeId = req.auth.token.storeId;
  const snap = await db.collection("stores").doc(storeId).collection("config").doc("accessCode").get();
  return { code: snap.exists ? snap.data().code : null };
});
