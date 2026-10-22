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

  if (!id || !secret) {
    throw new Error("Cashfree keys are missing.");
  }

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
 * Cashfree se payment ki sachchai poochho aur order update karo.
 * Browser ya webhook ke payload par bharosa nahi karta.
 * Returns: "PAID" | "PENDING" | "FAILED"
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

    // Seedha get + update. Webhook aur verify ek saath chalein to bhi
    // dono same values likhte hain, isliye koi nuksan nahi.
    const currentOrder = (await orderRef.get()).val();

    if (currentOrder && currentOrder.paymentStatus === "PENDING") {
      await orderRef.update({
        paymentStatus: "PAID",
        orderStatus: "CONFIRMED",
        paymentId: cfOrderId,
        paidAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    const finalOrder = (await orderRef.get()).val();
    console.log("[sync] final paymentStatus:", finalOrder && finalOrder.paymentStatus);

    // Order sach me PAID nahi hua to success mat dikhao
    if (!finalOrder || finalOrder.paymentStatus !== "PAID") {
      throw new Error("Order could not be marked as paid.");
    }

    await indexRef.update({ status: "PAID", updatedAt: Date.now() });
    return "PAID";
  }

  if (status === "ACTIVE") {
    const pay = await cashfreeGet(
      `/orders/${encodeURIComponent(cfOrderId)}/payments`
    );
    const list = Array.isArray(pay.data) ? pay.data : [];
    const pending = list.some(
      p => String(p.payment_status).toUpperCase() === "PENDING"
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
