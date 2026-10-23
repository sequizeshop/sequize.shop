const { getSession } = require("../../lib/auth");
const {
  getDatabase,
  cashfreeBase,
  cashfreeHeaders,
  syncPayment
} = require("../../lib/cashfree");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PRODUCT_ID_PATTERN = ID_PATTERN;

const USD_TO_INR = 85;

// 95% discount: customer pays only 5% of the original price.
const DISCOUNT_PERCENT = 95;
const DISCOUNT_MULTIPLIER = (100 - DISCOUNT_PERCENT) / 100;

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

function getVerifiedPrice(product) {
  const usd = Number(product.originalPriceUSD);

  if (
    product.originalPriceUSD !== undefined &&
    product.originalPriceUSD !== null &&
    Number.isFinite(usd) &&
    usd >= 0
  ) {
    return usd;
  }

  const inr = Number(product.price);

  if (Number.isFinite(inr) && inr >= 0) {
    return Number((inr / USD_TO_INR).toFixed(2));
  }

  throw new Error("Invalid product price.");
}

/*
 * Apply a 95% discount to the original product price.
 * The customer pays only 5% of the original price.
 */
function getDiscountedPrice(originalPriceUSD) {
  return Number(
    (originalPriceUSD * DISCOUNT_MULTIPLIER).toFixed(2)
  );
}

function getSiteUrl(req) {
  const configured = (process.env.SITE_URL || "")
    .trim()
    .replace(/\/+$/, "");

  return configured || `https://${req.headers.host}`;
}

/* Load the order and make sure it belongs to the signed-in user. */
async function loadOwnOrder(db, uid, orderId) {
  const orderRef = db.ref(`users/${uid}/orders/${orderId}`);
  const snapshot = await orderRef.get();

  if (!snapshot.exists()) {
    return {
      orderRef,
      order: null
    };
  }

  const order = snapshot.val();

  if (
    order.orderId !== orderId ||
    String(order.userId) !== uid
  ) {
    return {
      orderRef,
      order: null
    };
  }

  return {
    orderRef,
    order
  };
}

/*
 * Create a Cashfree order (payment session) for an existing order.
 * The amount always comes from our database, never from the browser.
 *
 * The database order total already includes the 95% discount.
 */

        ) {
    consasync function createPayment(req, res, session) {
  const orderId =
    typeof req.body?.orderId === "string"
      ? req.body.orderId.trim()
      : "";

  if (!ID_PATTERN.test(orderId)) {
    return sendError(res, 400, "Valid order ID is required.");
  }

  const db = getDatabase();
  const uid = String(session.uid);

  const { orderRef, order } = await loadOwnOrder(db, uid, orderId);

  if (!order) {
    return sendError(res, 404, "Order not found.");
  }

  if (
    order.currency !== "INR" ||
    !Number.isFinite(Number(order.totalINR)) ||
    Number(order.totalINR) <= 0
  ) {
    return sendError(res, 400, "Invalid order amount.");
  }

  if (order.paymentStatus === "PAID") {
    return res.status(200).json({
      success: true,
      paymentStatus: "PAID",
      orderId
    });
  }

  if (
    order.paymentStatus !== "PENDING" ||
    order.orderStatus !== "PENDING_PAYMENT"
  ) {
    return sendError(res, 409, "Order is invalid or already processed.");
  }

  /*
   * Agar pehle Cashfree payment attempt bana tha to uska status
   * pehle verify karo. Unknown/Pending status par naya attempt mat banao.
   */
  if (order.lastPaymentId) {
    let previousStatus;

    try {
      previousStatus = await syncPayment(db, String(order.lastPaymentId));
    } catch (error) {
      console.error("Previous payment verification error:", error.message);

      return res.status(202).json({
        success: true,
        paymentPending: true,
        paymentStatus: "PENDING",
        orderId,
        message: "The previous payment is being verified. Please check the order status."
      });
    }

    if (previousStatus === "PAID") {
      return res.status(200).json({
        success: true,
        paymentStatus: "PAID",
        orderId
      });
    }

    if (previousStatus === "PENDING") {
      return res.status(202).json({
        success: true,
        paymentPending: true,
        paymentStatus: "PENDING",
        orderId,
        message: "The previous payment is still processing."
      });
    }

    /*
     * Previous attempt FAILED ho tabhi aage naya attempt banega.
     * Final order status dobara check karo.
     */
    const refreshedSnapshot = await orderRef.get();
    const refreshedOrder = refreshedSnapshot.val();

    if (!refreshedOrder || refreshedOrder.paymentStatus === "PAID") {
      return res.status(200).json({
        success: true,
        paymentStatus: "PAID",
        orderId
      });
    }

    if (
      refreshedOrder.paymentStatus !== "PENDING" ||
      refreshedOrder.orderStatus !== "PENDING_PAYMENT"
    ) {
      return sendError(res, 409, "Order is invalid or already processed.");
    }
  }

  const amountPaise = Math.round(Number(order.totalINR) * 100);

  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return sendError(res, 400, "Invalid order amount.");
  }

  const addressSnap = await db
    .ref(`users/${uid}/addresses/${order.addressId}`)
    .get();

  const phone = String(addressSnap.val()?.phone || "")
    .replace(/\D/g, "")
    .slice(-10);

  if (phone.length !== 10) {
    return sendError(
      res,
      422,
      "Delivery address needs a valid 10-digit phone number."
    );
  }

  const cfOrderId =
    `${orderId}_${Date.now().toString(36)}`.slice(0, 50);

  const body = {
    order_id: cfOrderId,
    order_amount: Number((amountPaise / 100).toFixed(2)),
    order_currency: "INR",

    customer_details: {
      customer_id: uid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50),
      customer_phone: phone
    },

    order_meta: {
      notify_url: `${getSiteUrl(req)}/api/cashfree-webhook`
    },

    order_note: `Shoppy order ${orderId}`.slice(0, 200)
  };

  let response;
  let result = {};
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(`${cashfreeBase()}/orders`, {
        method: "POST",
        headers: cashfreeHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      console.error("Cashfree request failed:", error.message);

      return sendError(
        res,
        502,
        "Payment gateway is not reachable. Please try again."
      );
    }

    result = await response.json().catch(() => ({}));

    if (response.status < 500 || attempt === MAX_ATTEMPTS) break;

    await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
  }

  if (
    !response.ok ||
    typeof result.payment_session_id !== "string" ||
    !result.payment_session_id
  ) {
    console.error(
      "Cashfree order creation failed:",
      response.status,
      result.code || "",
      result.message || ""
    );

    return sendError(
      res,
      response.status >= 400 && response.status < 500 ? 400 : 502,
      "Unable to start payment. Please try again."
    );
  }

  const now = Date.now();

  /*
   * Index record first. If saving this record fails, do not return a
   * usable payment session to the browser.
   */
  await db.ref(`paymentIndex/${cfOrderId}`).set({
    uid,
    orderId,
    gatewayOrderId: cfOrderId,
    amountPaise,
    status: "INITIATED",
    createdAt: now,
    updatedAt: now
  });

  await orderRef.update({
    lastPaymentId: cfOrderId,
    updatedAt: now
  });

  return res.status(200).json({
    success: true,
    orderId,
    paymentId: cfOrderId,
    paymentSessionId: result.payment_session_id,
    paymentStatus: "PENDING",
    amount: (amountPaise / 100).toFixed(2),
    currency: "INR"
  });
}
/*
 * Ask Cashfree what really happened, then update our order.
 */
                async function verifyPayment(req, res, session) {
  const orderId =
    typeof req.body?.orderId === "string"
      ? req.body.orderId.trim()
      : "";

  if (!ID_PATTERN.test(orderId)) {
    return sendError(res, 400, "Valid order ID is required.");
  }

  const db = getDatabase();
  const uid = String(session.uid);

  const { order } = await loadOwnOrder(db, uid, orderId);

  if (!order) {
    return sendError(res, 404, "Order not found.");
  }

  if (order.paymentStatus === "PAID") {
    return res.status(200).json({
      success: true,
      paymentStatus: "PAID",
      orderId
    });
  }

  if (!order.lastPaymentId) {
    return res.status(200).json({
      success: true,
      paymentStatus: "PENDING",
      orderId
    });
  }

  try {
    const paymentStatus = await syncPayment(
      db,
      String(order.lastPaymentId)
    );

    /*
     * syncPayment ke result ko response dene se pehle order dobara padho.
     * Isse concurrent webhook update ka result bhi mil sakta hai.
     */
    const refreshed = await db
      .ref(`users/${uid}/orders/${orderId}`)
      .get();

    const finalOrder = refreshed.val();

    if (finalOrder?.paymentStatus === "PAID") {
      return res.status(200).json({
        success: true,
        paymentStatus: "PAID",
        orderId
      });
    }

    return res.status(200).json({
      success: true,
      paymentStatus:
        paymentStatus === "PENDING" ? "PENDING" : "FAILED",
      orderId
    });
  } catch (error) {
    console.error("Payment verification error:", error.message);

    /*
     * Cashfree unreachable hone par FAILED mat return karo.
     * Status abhi unknown hai, isliye PENDING return karo.
     */
    return res.status(200).json({
      success: true,
      paymentStatus: "PENDING",
      orderId,
      message: "Payment status is still being verified."
    });
  }
                }
