const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
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

// 새 발주 요청이 제출되면 사장님(들)에게 알림.
exports.notifyOwnerOnNewRequest = onDocumentCreated("checks/{date}/items/{itemId}", async (event) => {
  const item = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const tokens = [];
  ownersSnap.forEach((doc) => tokens.push(...tokensOf(doc.data().fcmTokens)));
  await sendToTokens(tokens, {
    title: "자재발주 요청",
    body: `${item.staffName ? item.staffName + "님 · " : ""}${item.materialName || ""}`,
    link: "/owner.html",
  });
});

// 사장님이 주문완료 처리하면(false -> true 전환 시점) 요청한 직원에게 알림.
exports.notifyStaffOnOrdered = onDocumentUpdated("checks/{date}/items/{itemId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.ordered || !after.ordered || !after.staffPhone) return;
  const accSnap = await db.collection("accounts").doc(after.staffPhone).get();
  if (!accSnap.exists) return;
  const tokens = tokensOf(accSnap.data().fcmTokens);
  await sendToTokens(tokens, {
    title: "사장님의 주문완료 알림",
    body: after.materialName || "",
    link: "/staff.html?view=cart",
  });
});

// 공유하기 > 공유해요에 새 글이 올라오면 작성자를 제외한 모두에게 알림.
// 받는 사람의 역할(사장/직원)에 따라 열어줄 페이지가 다르므로 토큰을 역할별로
// 나눠 두 번(필요하면) 보낸다.
exports.notifyOnNewShareNote = onDocumentCreated("shares/{date}/items/{itemId}", async (event) => {
  const item = event.data.data();
  if (item.type !== "note") return;
  const accSnap = await db.collection("accounts").get();
  const tokensByRole = { owner: [], staff: [] };
  accSnap.forEach((doc) => {
    if (doc.id === item.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    tokensByRole[role].push(...tokensOf(doc.data().fcmTokens));
  });
  const body = `${item.staffName ? item.staffName + "님: " : ""}${item.content || ""}`;
  await Promise.all(
    Object.keys(tokensByRole).map((role) =>
      sendToTokens(tokensByRole[role], { title: "공유해요 알림", body, link: shareLinkForRole(role) })
    )
  );
});

// 대댓글은 새 문서가 아니라 부모 글의 replies 배열에 arrayUnion으로 추가되는
// 업데이트라서, 위 onDocumentCreated는 이 경우를 못 잡는다 — 그래서 댓글을
// 달아도 알림이 전혀 가지 않았던 것. replies 배열이 늘어난 업데이트만 골라
// 마지막으로 추가된 댓글을 작성자를 제외한 모두에게 알림.
exports.notifyOnNewReply = onDocumentUpdated("shares/{date}/items/{itemId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  const beforeReplies = before.replies || [];
  const afterReplies = after.replies || [];
  if (afterReplies.length <= beforeReplies.length) return;
  const newReply = afterReplies[afterReplies.length - 1];
  if (!newReply) return;
  const accSnap = await db.collection("accounts").get();
  const tokensByRole = { owner: [], staff: [] };
  accSnap.forEach((doc) => {
    if (doc.id === newReply.staffPhone) return;
    const role = doc.data().role === "owner" ? "owner" : "staff";
    tokensByRole[role].push(...tokensOf(doc.data().fcmTokens));
  });
  const body = `${newReply.staffName ? newReply.staffName + "님: " : ""}${newReply.content || ""} (댓글)`;
  await Promise.all(
    Object.keys(tokensByRole).map((role) =>
      sendToTokens(tokensByRole[role], { title: "공유해요 알림", body, link: shareLinkForRole(role) })
    )
  );
});

// 이모지 리액션(좋아요 등)이 새로 눌리면 원글 작성자에게 "OO님이 좋아요를
// 눌렀습니다" 형태로 알림. reactions.{key}는 arrayUnion으로 추가되는 전화번호
// 배열이라, before/after를 비교해 새로 추가된 번호만 골라낸다.
const REACTION_LABELS = { heart: "하트", like: "좋아요", sad: "속상해요", awesome: "최고예요" };

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

// 모리 키우기: 오늘 올라온 발주 요청 전부를 그 당일에 주문완료하면 꿀단지 1개
// 적립. 하루라도 지나서 완료하면(= 이 트리거가 도는 날짜가 오늘이 아니면)
// 인정하지 않고, 이미 그 날짜로 적립된 적이 있으면(= earnedDates에 포함) 다시
// 주지 않는다 — 항목 여러 개를 순서대로 체크할 때마다 이 트리거가 반복
// 실행되므로 멱등성이 필요하다.
exports.awardHoneyOnAllOrdered = onDocumentUpdated("checks/{date}/items/{itemId}", async (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (before.ordered || !after.ordered) return; // only a fresh false->true completion

  const date = event.params.date;
  if (date !== kstDateStr(new Date())) return; // only same-day completion counts

  const itemsSnap = await db.collection("checks").doc(date).collection("items").get();
  if (itemsSnap.empty) return;
  const allOrdered = itemsSnap.docs.every((d) => d.data().ordered === true);
  if (!allOrdered) return;

  const mascotRef = db.collection("meta").doc("mascot");
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(mascotRef);
    const data = snap.exists ? snap.data() : {};
    const earnedDates = data.earnedDates || [];
    if (earnedDates.includes(date)) return; // already awarded for this date
    tx.set(
      mascotRef,
      {
        honeyJars: (data.honeyJars || 0) + 1,
        earnedDates: [...earnedDates, date].slice(-30),
      },
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
