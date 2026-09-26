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
      data: { title: notification.title, body: notification.body },
      webpush: {
        fcmOptions: { link: "/" },
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

// 새 발주 요청이 제출되면 사장님(들)에게 알림.
exports.notifyOwnerOnNewRequest = onDocumentCreated("checks/{date}/items/{itemId}", async (event) => {
  const item = event.data.data();
  const ownersSnap = await db.collection("accounts").where("role", "==", "owner").get();
  const tokens = [];
  ownersSnap.forEach((doc) => tokens.push(...tokensOf(doc.data().fcmTokens)));
  await sendToTokens(tokens, {
    title: "새 발주 요청이 왔어요",
    body: `${item.staffName ? item.staffName + "님 · " : ""}${item.materialName || ""}`,
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
    title: "사장님이 주문완료 처리했어요",
    body: after.materialName || "",
  });
});

// 공유하기 > 공유해요에 새 글이 올라오면 작성자를 제외한 모두에게 알림.
exports.notifyOnNewShareNote = onDocumentCreated("shares/{date}/items/{itemId}", async (event) => {
  const item = event.data.data();
  if (item.type !== "note") return;
  const accSnap = await db.collection("accounts").get();
  const tokens = [];
  accSnap.forEach((doc) => {
    if (doc.id === item.staffPhone) return;
    tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  await sendToTokens(tokens, {
    title: "새 공유 글이 올라왔어요",
    body: `${item.staffName ? item.staffName + "님: " : ""}${item.content || ""}`,
  });
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
  const tokens = [];
  accSnap.forEach((doc) => {
    if (doc.id === newReply.staffPhone) return;
    tokens.push(...tokensOf(doc.data().fcmTokens));
  });
  await sendToTokens(tokens, {
    title: "새 댓글이 달렸어요",
    body: `${newReply.staffName ? newReply.staffName + "님: " : ""}${newReply.content || ""}`,
  });
});
