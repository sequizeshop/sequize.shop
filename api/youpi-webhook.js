const crypto = require("node:crypto");
const admin = require("firebase-admin");

/*
 * YouPI PG webhook receiver.
 *
 * Needs the RAW request body to verify the HMAC signature, so Vercel's
 * automatic body parsing is turned off for this function only.
 *
 * Required environment variables (Vercel):
 *   YOUPI_WEBHOOK_SECRET   the merchant webhook secret
 *   FIREBASE_SERVICE_ACCOUNT
 */
module.exports.config = {
  api: {
    bodyParser: false
  }
};

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UTR_PATTERN = /^[A-Za-z0-9]{6,40}$/;

function getDatabase() {
  if (!admin.apps.length) {
    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountText)),
      databaseURL: DATABASE_URL
    });
  }

  return admin.database();
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function signatureIsValid(rawBody, headerValue, secret) {
  const received = String(headerValue || "");

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

async function flagForReview(db, uid, orderId, indexRef, reason, details) {
  const now = Date.now();

  console.error("Payment needs manual review:", reason, details);

  await db.ref(`users/${uid}/orders/${orderId}`).update({
    paymentReview: {
      reason,
      ...details,
      flaggedAt: now
    },
    updatedAt: now
  });

  await indexRef.update({
    status: "REVIEW",
    updatedAt: now
  });
}

async function handleSuccess(db, payload) {
  const paymentId = String(payload.paymentId || "");

  if (!ID_PATTERN.test(paymentId)) {
    return { status: 400, body: { error: "Invalid paymentId." } };
  }

  const indexRef = db.ref(`paymentIndex/${paymentId}`);
  const indexSnapshot = await indexRef.get();

  if (!indexSnapshot.exists()) {
    console.error("Webhook for unknown payment:", paymentId);

    // 404 lets the gateway retry in case the record is still being written.
    return { status: 404, body: { error: "Unknown payment." } };
  }

  const record = indexSnapshot.val();
  const { uid, orderId } = record;

  if (!ID_PATTERN.test(String(uid)) || !ID_PATTERN.test(String(orderId))) {
    return { status: 400, body: { error: "Corrupt payment record." } };
  }

  // The gateway reference must be the one we created for this attempt.
  if (String(payload.orderId) !== String(record.gatewayOrderId)) {
    await flagForReview(db, uid, orderId, indexRef, "ORDER_REFERENCE_MISMATCH", {
      paymentId,
      received: String(payload.orderId || "").slice(0, 200)
    });

    return { status: 200, body: { received: true, flagged: true } };
  }

  // The paid amount must equal the amount stored when the payment was created.
  const paidPaise = Number(payload.amountPaise);

  if (!Number.isInteger(paidPaise) || paidPaise !== Number(record.amountPaise)) {
    await flagForReview(db, uid, orderId, indexRef, "AMOUNT_MISMATCH", {
      paymentId,
      expectedPaise: Number(record.amountPaise),
      receivedPaise: Number.isFinite(paidPaise) ? paidPaise : null
    });

    return { status: 200, body: { received: true, flagged: true } };
  }

  // The same bank reference (UTR) must never pay two different orders.
  const utr = String(payload.utr || "").trim();

  if (utr) {
    if (!UTR_PATTERN.test(utr)) {
      await flagForReview(db, uid, orderId, indexRef, "INVALID_UTR", {
        paymentId
      });

      return { status: 200, body: { received: true, flagged: true } };
    }

    const utrResult = await db
      .ref(`utrIndex/${utr}`)
      .transaction(current => {
        if (current === null || current === undefined) {
          return { paymentId, orderId, uid, at: Date.now() };
        }

        // Already stored: leave it unchanged.
        return undefined;
      });

    if (!utrResult.committed) {
      const existing = utrResult.snapshot.val() || {};

      if (existing.paymentId !== paymentId) {
        await flagForReview(db, uid, orderId, indexRef, "DUPLICATE_UTR", {
          paymentId,
          utr
        });

        return { status: 200, body: { received: true, flagged: true } };
      }
    }
  }

  // Mark the order paid, once. A repeated webhook is harmless.
  const orderRef = db.ref(`users/${uid}/orders/${orderId}`);
  let outcome = "applied";

  const txn = await orderRef.transaction(current => {
    if (current === null || current === undefined) {
      outcome = "missing";
      return undefined;
    }

    if (current.paymentStatus === "PAID") {
      outcome = "already-paid";
      return undefined;
    }

    if (
      current.paymentStatus !== "PENDING" ||
      current.orderStatus !== "PENDING_PAYMENT"
    ) {
      outcome = "wrong-state";
      return undefined;
    }

    if (Math.round(Number(current.totalINR) * 100) !== paidPaise) {
      outcome = "total-changed";
      return undefined;
    }

    outcome = "applied";

    return {
      ...current,
      paymentStatus: "PAID",
      orderStatus: "CONFIRMED",
      paymentId,
      paymentUtr: utr || null,
      paidAmountPaise: paidPaise,
      paidAt: Date.now(),
      updatedAt: Date.now()
    };
  });

  if (outcome === "missing") {
    return { status: 404, body: { error: "Order not found." } };
  }

  if (outcome === "wrong-state" || outcome === "total-changed") {
    await flagForReview(db, uid, orderId, indexRef, "ORDER_NOT_PAYABLE", {
      paymentId,
      outcome
    });

    return { status: 200, body: { received: true, flagged: true } };
  }

  if (outcome === "applied" && txn.committed) {
    const now = Date.now();

    await indexRef.update({ status: "SUCCESS", utr: utr || null, updatedAt: now });

    // Remove only the items that were part of this paid order.
    const order = txn.snapshot.val() || {};
    const cartUpdates = {};

    (Array.isArray(order.items) ? order.items : []).forEach(item => {
      if (item && ID_PATTERN.test(String(item.productId))) {
        cartUpdates[`users/${uid}/cart/items/${item.productId}`] = null;
      }
    });

    if (Object.keys(cartUpdates).length) {
      await db.ref().update(cartUpdates);
    }
  }

  return { status: 200, body: { received: true } };
}

async function handleOtherEvent(db, payload) {
  const paymentId = String(payload.paymentId || "");

  if (!ID_PATTERN.test(paymentId)) {
    return { status: 200, body: { received: true } };
  }

  const indexRef = db.ref(`paymentIndex/${paymentId}`);
  const snapshot = await indexRef.get();

  if (snapshot.exists() && snapshot.val().status !== "SUCCESS") {
    // The order stays PENDING, so the customer can try again.
    await indexRef.update({
      status: String(payload.event).toUpperCase(),
      updatedAt: Date.now()
    });
  }

  return { status: 200, body: { received: true } };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const secret = process.env.YOUPI_WEBHOOK_SECRET;

  if (!secret) {
    console.error("YOUPI_WEBHOOK_SECRET is missing.");
    return res.status(500).json({ error: "Webhook is not configured." });
  }

  let rawBody;

  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    return res.status(413).json({ error: "Request body too large." });
  }

  if (!signatureIsValid(rawBody, req.headers["x-gateway-signature"], secret)) {
    return res.status(401).json({ error: "Invalid signature." });
  }

  // Reject very old or far-future deliveries when a timestamp is provided.
  const timestamp = Number(req.headers["x-gateway-timestamp"]);

  if (
    req.headers["x-gateway-timestamp"] &&
    (!Number.isFinite(timestamp) ||
      Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS)
  ) {
    return res.status(400).json({ error: "Stale or invalid timestamp." });
  }

  let payload;

  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch (error) {
    return res.status(400).json({ error: "Invalid JSON." });
  }

  try {
    const db = getDatabase();
    const event = String(payload.event || "").toUpperCase();

    const result =
      event === "SUCCESS"
        ? await handleSuccess(db, payload)
        : await handleOtherEvent(db, { ...payload, event });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("YouPI webhook error:", error.message);

    // 500 makes the gateway retry the delivery later.
    return res.status(500).json({ error: "Webhook processing failed." });
  }
};
