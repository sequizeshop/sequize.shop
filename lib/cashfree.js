const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const API_VERSION = "2023-08-01";

function getDatabase() {
  if (!admin.apps.length) {
    const text = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!text) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");

    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(text)),
      databaseURL: DATABASE_URL
    });
  }

  return admin.database();
}

function cashfreeBase() {
  return (process.env.CASHFREE_ENV || "").trim() === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

function cashfreeHeaders() {
  const id = (process.env.CASHFREE_APP_ID || "").trim();
  const secret = (process.env.CASHFREE_SECRET_KEY || "").trim();

  if (!id || !secret) throw new Error("Cashfree keys are missing.");

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-client-id": id,
    "x-client-secret": secret,
    "x-api-version": API_VERSION
  };
}

async function cashfreeGet(path) {
  const response = await fetch(cashfreeBase() + path, {
    headers: cashfreeHeaders(),
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

/*
 * Verify the Cashfree order directly.
 * Returns ADVANCE_PAID | PENDING | FAILED.
 * A successful advance is never treated as full order payment.
 */
async function syncPayment(db, cfOrderId) {
  const indexRef = db.ref(`paymentIndex/${cfOrderId}`);
  const indexSnap = await indexRef.get();

  if (!indexSnap.exists()) {
    console.error("[sync] paymentIndex missing for", cfOrderId);
    return "FAILED";
  }

  const index = indexSnap.val();
  const { ok, status: httpStatus, data: cf } = await cashfreeGet(
    `/orders/${encodeURIComponent(cfOrderId)}`
  );

  if (!ok) {
    console.error("[sync] Cashfree read failed", cfOrderId, httpStatus, cf.message || "");
    throw new Error("Could not read order from Cashfree.");
  }

  const status = String(cf.order_status || "").toUpperCase();
  console.log("[sync]", cfOrderId, "cashfree status:", status);

  if (status === "PAID") {
    const paidPaise = Math.round(Number(cf.order_amount) * 100);

    if (paidPaise !== Number(index.amountPaise)) {
      console.error("[sync] amount mismatch", cfOrderId, paidPaise, index.amountPaise);
      await indexRef.update({ status: "AMOUNT_MISMATCH", updatedAt: Date.now() });
      return "FAILED";
    }

    const orderRef = db.ref(`users/${index.uid}/orders/${index.orderId}`);
    const currentOrder = (await orderRef.get()).val();

    if (!currentOrder) throw new Error("Original order could not be found.");

    const expectedAdvanceINR = Number.isFinite(Number(currentOrder.advanceAmountINR))
      ? Number(currentOrder.advanceAmountINR)
      : Math.min(600, Number(currentOrder.totalINR) || 0);
    const expectedAdvancePaise = Math.round(expectedAdvanceINR * 100);

    if (expectedAdvancePaise !== paidPaise) {
      console.error("[sync] saved advance amount mismatch", cfOrderId, expectedAdvancePaise, paidPaise);
      await indexRef.update({ status: "AMOUNT_MISMATCH", updatedAt: Date.now() });
      return "FAILED";
    }

    const codAmountINR = Number.isFinite(Number(currentOrder.codAmountINR))
      ? Number(currentOrder.codAmountINR)
      : Math.max(0, Number(currentOrder.totalINR || 0) - expectedAdvanceINR);

    /* Transaction prevents verify + webhook racing each other. */
    await orderRef.transaction(order => {
      if (!order) return;
      if (order.paymentStatus === "PENDING") {
        return {
          ...order,
          paymentStatus: "ADVANCE_PAID",
          orderStatus: "CONFIRMED",
          paymentMethod: "PARTIAL_ONLINE_COD",
          paymentId: cfOrderId,
          advancePaidINR: expectedAdvanceINR,
          codAmountINR,
          codPaymentStatus: codAmountINR > 0 ? "PENDING" : "NOT_REQUIRED",
          paidAt: Date.now(),
          updatedAt: Date.now()
        };
      }
      return order;
    });

    const finalOrder = (await orderRef.get()).val();
    if (!finalOrder || !["ADVANCE_PAID", "PAID"].includes(finalOrder.paymentStatus)) {
      throw new Error("Advance payment could not be confirmed.");
    }

    await indexRef.update({ status: "ADVANCE_PAID", updatedAt: Date.now() });
    return "ADVANCE_PAID";
  }

  if (status === "ACTIVE") {
    const pay = await cashfreeGet(
      `/orders/${encodeURIComponent(cfOrderId)}/payments`
    );
    const list = Array.isArray(pay.data) ? pay.data : [];
    const pending = list.some(
      payment => String(payment.payment_status).toUpperCase() === "PENDING"
    );
    return pending ? "PENDING" : "FAILED";
  }

  await indexRef.update({ status, updatedAt: Date.now() });
  return "FAILED";
}

module.exports = {
  getDatabase,
  cashfreeBase,
  cashfreeHeaders,
  syncPayment
};
