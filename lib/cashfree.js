const admin = require("firebase-admin");
const crypto = require("crypto");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const API_VERSION = "2023-08-01";

function getDatabase() {
  if (!admin.apps.length) {
    const text = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!text) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    }

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

  return {
    ok: response.ok,
    status: response.status,
    data
  };
}

/*
 * Deterministic notification ID:
 * Same order and event = same notification ID.
 */
function makeNotificationId(type, orderId) {
  const hash = crypto
    .createHash("sha256")
    .update(String(orderId))
    .digest("hex")
    .slice(0, 32);

  return `${type}_${hash}`;
}

/*
 * Save a notification once.
 * Uses Firebase transaction to prevent duplicate records.
 */
async function createNotificationOnce(
  db,
  uid,
  notificationId,
  notification
) {
  if (
    typeof uid !== "string" ||
    !uid ||
    /[.#$\[\]/]/.test(uid)
  ) {
    throw new Error("Invalid customer UID for notification.");
  }

  const ref = db.ref(
    `Notifications/${uid}/${notificationId}`
  );

  const result = await ref.transaction(current => {
    if (current !== null) {
      return;
    }

    return notification;
  });

  return result.committed;
}

/*
 * Successful order notification.
 */
async function sendOrderPlacedNotification(
  db,
  uid,
  orderId,
  order
) {
  const notificationId = makeNotificationId(
    "order_placed",
    orderId
  );

  const amount = Number(
    order.totalINR ??
    order.totalAmount ??
    order.amount ??
    0
  );

  const notification = {
    title: "Order placed successfully 🎉",

    message:
      `Dear Shoppy user, your order (${orderId}) worth ₹${amount} ` +
      "has been placed successfully. Thank you for shopping with Shoppy!",

    category: "orders",
    type: "success",
    sender: "system",
    read: false,
    createdAt: Date.now(),
    orderId,

    data: {
      event: "order_placed",
      orderId,
      amount
    }
  };

  await createNotificationOnce(
    db,
    uid,
    notificationId,
    notification
  );
}

/*
 * Payment failure notification.
 * This does not cancel the order or change orderStatus.
 */
async function sendPaymentFailedNotification(
  db,
  uid,
  orderId,
  order
) {
  const notificationId = makeNotificationId(
    "payment_not_completed",
    orderId
  );

  const amount = Number(
    order.totalINR ??
    order.totalAmount ??
    order.amount ??
    0
  );

  const notification = {
    title: "Payment not completed",

    message:
      `Dear Shoppy user, payment for your order (${orderId}) ` +
      `worth ₹${amount} was not completed. ` +
      "Please try again to complete your purchase. " +
      "If any amount was deducted, please allow time for the payment status to update.",

    category: "payments",
    type: "warning",
    sender: "system",
    read: false,
    createdAt: Date.now(),
    orderId,

    data: {
      event: "payment_not_completed",
      orderId,
      amount
    }
  };

  await createNotificationOnce(
    db,
    uid,
    notificationId,
    notification
  );
}

/*
 * Cashfree payment verification.
 * Returns: PAID | PENDING | FAILED
 */
async function syncPayment(db, cfOrderId) {
  const indexRef = db.ref(`paymentIndex/${cfOrderId}`);
  const indexSnap = await indexRef.get();

  if (!indexSnap.exists()) {
    console.error("[sync] paymentIndex missing for", cfOrderId);
    return "FAILED";
  }

  const index = indexSnap.val();

  const {
    ok,
    status: httpStatus,
    data: cf
  } = await cashfreeGet(
    `/orders/${encodeURIComponent(cfOrderId)}`
  );

  if (!ok) {
    console.error(
      "[sync] Cashfree read failed",
      cfOrderId,
      httpStatus,
      cf.message || ""
    );

    throw new Error("Could not read order from Cashfree.");
  }

  const status = String(
    cf.order_status || ""
  ).toUpperCase();

  console.log(
    "[sync]",
    cfOrderId,
    "cashfree status:",
    status
  );

  const orderRef = db.ref(
    `users/${index.uid}/orders/${index.orderId}`
  );

  /*
   * CASE 1: Cashfree confirms payment is PAID.
   * Original order status logic is preserved.
   */
  if (status === "PAID") {
    const paidPaise = Math.round(
      Number(cf.order_amount) * 100
    );

    if (paidPaise !== Number(index.amountPaise)) {
      console.error(
        "[sync] amount mismatch",
        cfOrderId,
        paidPaise,
        index.amountPaise
      );

      await indexRef.update({
        status: "AMOUNT_MISMATCH",
        updatedAt: Date.now()
      });

      return "FAILED";
    }

    const currentOrder = (await orderRef.get()).val();

    if (!currentOrder) {
      throw new Error("Order not found in Firebase.");
    }

    /*
     * Original order update: unchanged.
     */
    if (currentOrder.paymentStatus === "PENDING") {
      await orderRef.update({
        paymentStatus: "PAID",
        orderStatus: "CONFIRMED",
        paymentId: cfOrderId,
        paidAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    const finalOrder = (await orderRef.get()).val();

    console.log(
      "[sync] final paymentStatus:",
      finalOrder && finalOrder.paymentStatus
    );

    if (
      !finalOrder ||
      finalOrder.paymentStatus !== "PAID"
    ) {
      throw new Error("Order could not be marked as paid.");
    }

    await indexRef.update({
      status: "PAID",
      updatedAt: Date.now()
    });

    /*
     * Notification only.
     * Does not change orderStatus or paymentStatus.
     */
    try {
      await sendOrderPlacedNotification(
        db,
        index.uid,
        index.orderId,
        finalOrder
      );
    } catch (error) {
      console.error(
        "[notification] order placed notification failed:",
        error.message
      );
    }

    return "PAID";
  }

  /*
   * CASE 2: Cashfree order is ACTIVE.
   * ACTIVE alone does not prove payment failure.
   */
  if (status === "ACTIVE") {
    const pay = await cashfreeGet(
      `/orders/${encodeURIComponent(cfOrderId)}/payments`
    );

    if (!pay.ok) {
      console.error(
        "[sync] Cashfree payments read failed",
        cfOrderId,
        pay.status
      );

      throw new Error(
        "Could not read Cashfree payment attempts."
      );
    }

    const list = Array.isArray(pay.data)
      ? pay.data
      : [];

    const paymentStatuses = list.map(payment =>
      String(payment.payment_status || "").toUpperCase()
    );

    /*
     * If an attempt is pending, don't send failure notification.
     */
    const hasPending = paymentStatuses.some(paymentStatus =>
      ["PENDING", "IN_PROGRESS"].includes(paymentStatus)
    );

    if (hasPending) {
      await indexRef.update({
        status: "PENDING",
        updatedAt: Date.now()
      });

      return "PENDING";
    }

    /*
     * Only explicit failed payment attempts trigger notification.
     */
    const failedStatuses = [
      "FAILED",
      "USER_DROPPED",
      "CANCELLED"
    ];

    const hasFailedAttempt = paymentStatuses.some(
      paymentStatus => failedStatuses.includes(paymentStatus)
    );

    if (!hasFailedAttempt) {
      await indexRef.update({
        status: "PENDING",
        updatedAt: Date.now()
      });

      return "PENDING";
    }

    const order = (await orderRef.get()).val();

    /*
     * Do not notify failure for an already-paid order.
     * Do not change the existing order status.
     */
    if (order && order.paymentStatus !== "PAID") {
      await indexRef.update({
        status: "FAILED",
        updatedAt: Date.now()
      });

      try {
        await sendPaymentFailedNotification(
          db,
          index.uid,
          index.orderId,
          order
        );
      } catch (error) {
        console.error(
          "[notification] payment failure notification failed:",
          error.message
        );
      }
    }

    return "FAILED";
  }

  /*
   * CASE 3: Cashfree checkout expired or terminated.
   * Notify only if the order has not been paid.
   * Original order data is not modified.
   */
  if (["EXPIRED", "TERMINATED"].includes(status)) {
    const order = (await orderRef.get()).val();

    if (order && order.paymentStatus === "PAID") {
      return "PAID";
    }

    await indexRef.update({
      status,
      updatedAt: Date.now()
    });

    if (order) {
      try {
        await sendPaymentFailedNotification(
          db,
          index.uid,
          index.orderId,
          order
        );
      } catch (error) {
        console.error(
          "[notification] payment failure notification failed:",
          error.message
        );
      }
    }

    return "FAILED";
  }

  /*
   * Unknown statuses are not automatically marked as failed.
   */
  await indexRef.update({
    status,
    updatedAt: Date.now()
  });

  return "PENDING";
}

module.exports = {
  getDatabase,
  cashfreeBase,
  cashfreeHeaders,
  syncPayment
};
