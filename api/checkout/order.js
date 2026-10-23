const { getSession } = require("../../lib/auth");

const {
  getDatabase,
  cashfreeBase,
  cashfreeHeaders,
  syncPayment
} = require("../../lib/cashfree");

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const USD_TO_INR = 85;

// 95% discount: customer pays 5% of the original price.
const DISCOUNT_PERCENT = 95;
const DISCOUNT_MULTIPLIER = (100 - DISCOUNT_PERCENT) / 100;

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

function getVerifiedPrice(product) {
  if (!product || typeof product !== "object") {
    throw new Error("Invalid product.");
  }

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
 * Customer pays only 5% of the original price.
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

  if (configured) {
    return configured;
  }

  const host = String(req.headers.host || "").trim();

  if (!host) {
    throw new Error("Website host is missing.");
  }

  // Prevent an unexpected Host header from controlling the webhook URL.
  if (
    !/^[a-zA-Z0-9.-]+(?::\d{1,5})?$/.test(host)
  ) {
    throw new Error("Invalid website host.");
  }

  return `https://${host}`;
}

/*
 * Load the order and make sure it belongs to the signed-in user.
 */
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
    !order ||
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
 * Create a Cashfree payment session for an existing order.
 * Amount is taken from the database, not from the browser.
 */
async function createPayment(req, res, session) {
  const orderId =
    typeof req.body?.orderId === "string"
      ? req.body.orderId.trim()
      : "";

  if (!ID_PATTERN.test(orderId)) {
    return sendError(res, 400, "Valid order ID is required.");
  }

  const db = getDatabase();
  const uid = String(session.uid);

  const {
    orderRef,
    order
  } = await loadOwnOrder(db, uid, orderId);

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

  // Already paid: never create another payment session.
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
    return sendError(
      res,
      409,
      "Order is invalid or already processed."
    );
  }

  /*
   * If a previous payment attempt exists, verify it first.
   * Do not create a duplicate attempt while the old one is pending.
   */
  if (order.lastPaymentId) {
    let previousStatus;

    try {
      previousStatus = await syncPayment(
        db,
        String(order.lastPaymentId)
      );
    } catch (error) {
      console.error(
        "Previous payment verification error:",
        error.message
      );

      return res.status(202).json({
        success: true,
        paymentPending: true,
        paymentStatus: "PENDING",
        orderId,
        message:
          "The previous payment is being verified. Please check the order status."
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

    // Verify the order again before creating another attempt.
    const refreshedSnapshot = await orderRef.get();
    const refreshedOrder = refreshedSnapshot.val();

    if (!refreshedOrder) {
      return sendError(res, 404, "Order not found.");
    }

    if (refreshedOrder.paymentStatus === "PAID") {
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
      return sendError(
        res,
        409,
        "Order is invalid or already processed."
      );
    }
  }

  const amountPaise = Math.round(
    Number(order.totalINR) * 100
  );

  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return sendError(res, 400, "Invalid order amount.");
  }

  // Load the delivery address to obtain the customer's phone number.
  const addressSnap = await db
    .ref(`users/${uid}/addresses/${order.addressId}`)
    .get();

  const address = addressSnap.val();

  const phone = String(address?.phone || "")
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

    order_amount: Number(
      (amountPaise / 100).toFixed(2)
    ),

    order_currency: "INR",

    customer_details: {
      customer_id: uid
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 50),

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

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    try {
      response = await fetch(
        `${cashfreeBase()}/orders`,
        {
          method: "POST",

          headers: cashfreeHeaders(),

          body: JSON.stringify(body),

          signal: AbortSignal.timeout(20000)
        }
      );
    } catch (error) {
      console.error(
        "Cashfree request failed:",
        error.message
      );

      /*
       * A network timeout can occur after Cashfree has created
       * an order. Do not assume that the request definitely failed.
       */
      return res.status(502).json({
        success: false,
        paymentStatus: "PENDING",
        orderId,
        message:
          "Payment gateway response is uncertain. Check the order status before trying again."
      });
    }

    result = await response.json().catch(() => ({}));

    if (
      response.status < 500 ||
      attempt === MAX_ATTEMPTS
    ) {
      break;
    }

    await new Promise(resolve =>
      setTimeout(resolve, 1200 * attempt)
    );
  }

  if (
    !response ||
    !response.ok ||
    typeof result.payment_session_id !== "string" ||
    !result.payment_session_id
  ) {
    console.error(
      "Cashfree order creation failed:",
      response?.status,
      result.code || "",
      result.message || ""
    );

    return sendError(
      res,
      response && response.status >= 400 &&
        response.status < 500
        ? 400
        : 502,
      "Unable to start payment. Please try again."
    );
  }

  const now = Date.now();

  /*
   * Save the payment index before returning the session to the browser.
   * The webhook and verification endpoint use this index.
   */
  await db
    .ref(`paymentIndex/${cfOrderId}`)
    .set({
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
 * Ask Cashfree for the real payment status.
 * Never trust a payment-success claim from the browser.
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

  const { order } = await loadOwnOrder(
    db,
    uid,
    orderId
  );

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

  /*
   * No payment attempt has been recorded yet.
   * Keep the status pending rather than falsely claiming failure.
   */
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

    // Read again in case the webhook updated the order concurrently.
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
        paymentStatus === "FAILED"
          ? "FAILED"
          : "PENDING",

      orderId
    });
  } catch (error) {
    console.error(
      "Payment verification error:",
      error.message
    );

    /*
     * If Cashfree is temporarily unavailable, do not mark
     * a potentially successful payment as failed.
     */
    return res.status(200).json({
      success: true,
      paymentStatus: "PENDING",
      orderId,
      message: "Payment status is still being verified."
    });
  }
}

/*
 * Main API handler.
 */
async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(
        res,
        401,
        "Please sign in to continue."
      );
    }

    const action =
      typeof req.body?.action === "string"
        ? req.body.action.trim()
        : "";

    if (action === "create-payment") {
      return await createPayment(req, res, session);
    }

    if (action === "verify-payment") {
      return await verifyPayment(req, res, session);
    }

    /*
     * This endpoint's new-order/cart creation flow is intentionally
     * not reconstructed here: its exact product/cart schema was not
     * included in the broken snippet. Do not create an incomplete
     * order from untrusted browser totals.
     */
    return sendError(
      res,
      400,
      "Invalid action. Use create-payment or verify-payment."
    );
  } catch (error) {
    console.error(
      "Checkout order API error:",
      error.message
    );

    return sendError(
      res,
      500,
      "Something went wrong while processing the payment."
    );
  }
}

module.exports = handler;
