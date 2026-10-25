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
 * PAYMENT NOTIFICATIONS
 *
 * PAID   -> success notification
 * FAILED -> failure notification
 * PENDING -> no notification
 *
 * Uses a fixed notification ID for each order and result,
 * preventing duplicate notifications for the same result.
 */
async function sendPaymentNotification(db, uid, order, status) {
  try {
    if (status !== "PAID" && status !== "FAILED") {
      return;
    }

    const orderId = String(order.orderId);
    const amount = Number(order.totalINR).toFixed(2);

    let notificationId;
    let notification;

    if (status === "PAID") {
      notificationId = `payment_success_${orderId}`;

      notification = {
        title: "Order placed successfully 🎉",
        message:
          `Dear Shoppy user, your order (${orderId}) worth ₹${amount} has been placed successfully. Thank you for shopping with Shoppy!`,
        category: "orders",
        type: "success",
        read: false,
        createdAt: Date.now(),
        orderId,
        source: "payment"
      };
    } else {
      notificationId = `payment_failed_${orderId}`;

      notification = {
        title: "Payment not completed",
        message:
          `Dear Shoppy user, payment for your order (${orderId}) worth ₹${amount} was not completed. Please try again to complete your purchase. If any amount was deducted, please allow time for the payment status to update.`,
        category: "payments",
        type: "warning",
        read: false,
        createdAt: Date.now(),
        orderId,
        source: "payment"
      };
    }

    const notificationRef = db.ref(
      `Notifications/${uid}/${notificationId}`
    );

    await notificationRef.transaction(current => {
      if (current !== null) {
        return;
      }

      return notification;
    });
  } catch (error) {
    console.error(
      "Payment notification error:",
      error.message
    );
  }
}

/*
 * Create a Cashfree order (payment session) for an existing order.
 * The amount always comes from our database, never from the browser.
 *
 * The database order total already includes the 95% discount.
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

  const { orderRef, order } = await loadOwnOrder(
    db,
    uid,
    orderId
  );

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

  // Uses the discounted total saved in the database.
  const amountPaise = Math.round(
    Number(order.totalINR) * 100
  );

  if (
    !Number.isInteger(amountPaise) ||
    amountPaise <= 0
  ) {
    return sendError(res, 400, "Invalid order amount.");
  }

  // Cashfree needs the customer's phone (10 digits).
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

  // Every attempt gets its own Cashfree order ID.
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

      return sendError(
        res,
        502,
        "Payment gateway is not reachable. Please try again."
      );
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
      response.status >= 400 && response.status < 500
        ? 400
        : 502,
      "Unable to start payment. Please try again."
    );
  }

  const now = Date.now();

  // The webhook and verify step use this record to find the order.
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

  const { order } = await loadOwnOrder(
    db,
    uid,
    orderId
  );

  if (!order) {
    return sendError(res, 404, "Order not found.");
  }

  if (order.paymentStatus === "PAID") {
    await sendPaymentNotification(
      db,
      uid,
      order,
      "PAID"
    );

    return res.status(200).json({
      success: true,
      paymentStatus: "PAID"
    });
  }

  if (!order.lastPaymentId) {
    await sendPaymentNotification(
      db,
      uid,
      order,
      "FAILED"
    );

    return res.status(200).json({
      success: true,
      paymentStatus: "FAILED"
    });
  }

  const paymentStatus = await syncPayment(
    db,
    String(order.lastPaymentId)
  );

  await sendPaymentNotification(
    db,
    uid,
    order,
    paymentStatus
  );

  return res.status(200).json({
    success: true,
    paymentStatus
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendError(
      res,
      405,
      "Method not allowed."
    );
  }

  try {
    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(
        res,
        401,
        "Please log in to continue."
      );
    }

    if (req.body?.action === "create-payment") {
      return await createPayment(req, res, session);
    }

    if (req.body?.action === "verify-payment") {
      return await verifyPayment(req, res, session);
    }

    /* ---------- Create a new order from the cart ---------- */

    const addressId =
      typeof req.body?.addressId === "string"
        ? req.body.addressId.trim()
        : "";

    if (!ID_PATTERN.test(addressId)) {
      return sendError(
        res,
        400,
        "A valid address ID is required."
      );
    }

    const db = getDatabase();
    const uid = String(session.uid);

    const addressSnapshot = await db
      .ref(`users/${uid}/addresses/${addressId}`)
      .get();

    if (!addressSnapshot.exists()) {
      return sendError(
        res,
        404,
        "Delivery address not found."
      );
    }

    const address = addressSnapshot.val();

    const requiredFields = [
      "fullName",
      "phone",
      "pincode",
      "houseNumber",
      "area",
      "city",
      "state",
      "country"
    ];

    if (
      requiredFields.some(
        field =>
          typeof address[field] !== "string" ||
          !address[field].trim()
      )
    ) {
      return sendError(
        res,
        422,
        "Delivery address is incomplete."
      );
    }

    const cartSnapshot = await db
      .ref(`users/${uid}/cart/items`)
      .get();

    const savedItems = cartSnapshot.val();

    if (
      !savedItems ||
      typeof savedItems !== "object" ||
      Array.isArray(savedItems)
    ) {
      return sendError(
        res,
        400,
        "Your cart is empty."
      );
    }

    const entries = Object.entries(savedItems);

    if (
      entries.length === 0 ||
      entries.length > 50
    ) {
      return sendError(
        res,
        400,
        "Your cart is empty or too large."
      );
    }

    const items = [];

    let originalTotalUSD = 0;
    let discountedTotalUSD = 0;

    for (const [productId, cartItem] of entries) {
      if (!PRODUCT_ID_PATTERN.test(productId)) {
        return sendError(
          res,
          400,
          "Cart contains an invalid product."
        );
      }

      const quantity = Number(cartItem?.quantity);

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        return sendError(
          res,
          400,
          "Cart contains an invalid quantity."
        );
      }

      const productSnapshot = await db
        .ref(`products/${productId}`)
        .get();

      if (!productSnapshot.exists()) {
        return sendError(
          res,
          409,
          "A product in your cart is no longer available."
        );
      }

      const product = productSnapshot.val();

      if (
        !product ||
        typeof product.title !== "string" ||
        !product.title.trim()
      ) {
        return sendError(
          res,
          409,
          "A product has invalid details."
        );
      }

      // Original verified price from the database.
      const originalUnitPriceUSD = Number(
        getVerifiedPrice(product).toFixed(2)
      );

      // Apply the 95% discount to EACH product.
      const discountedUnitPriceUSD =
        getDiscountedPrice(originalUnitPriceUSD);

      // Calculate the discounted line total.
      const originalLineTotalUSD = Number(
        (
          originalUnitPriceUSD * quantity
        ).toFixed(2)
      );

      const discountedLineTotalUSD = Number(
        (
          discountedUnitPriceUSD * quantity
        ).toFixed(2)
      );

      items.push({
        productId,
        title: product.title.slice(0, 200),
        quantity,

        // Original price before discount.
        originalUnitPriceUSD,

        // Actual discounted unit price.
        unitPriceUSD: discountedUnitPriceUSD,

        // Original total for this product line.
        originalLineTotalUSD,

        // Actual discounted total for this product line.
        lineTotalUSD: discountedLineTotalUSD,

        discountPercent: DISCOUNT_PERCENT
      });

      originalTotalUSD = Number(
        (
          originalTotalUSD +
          originalLineTotalUSD
        ).toFixed(2)
      );

      discountedTotalUSD = Number(
        (
          discountedTotalUSD +
          discountedLineTotalUSD
        ).toFixed(2)
      );
    }

    if (
      !Number.isFinite(discountedTotalUSD) ||
      discountedTotalUSD <= 0
    ) {
      return sendError(
        res,
        400,
        "Order total is invalid."
      );
    }

    // The Cashfree payment amount is based on the discounted total.
    const totalINR = Number(
      (
        discountedTotalUSD * USD_TO_INR
      ).toFixed(2)
    );

    const originalTotalINR = Number(
      (
        originalTotalUSD * USD_TO_INR
      ).toFixed(2)
    );

    const discountAmountINR = Number(
      (
        originalTotalINR - totalINR
      ).toFixed(2)
    );

    const orderRef = db
      .ref(`users/${uid}/orders`)
      .push();

    const now = Date.now();

    const order = {
      orderId: orderRef.key,
      userId: uid,
      addressId,
      items,

      currency: "INR",
      exchangeRate: USD_TO_INR,

      // Original totals before discount.
      originalTotalUSD,
      originalTotalINR,

      // Discount information.
      discountPercent: DISCOUNT_PERCENT,
      discountAmountINR,

      // Final discounted totals.
      totalUSD: discountedTotalUSD,
      totalINR,

      paymentStatus: "PENDING",
      orderStatus: "PENDING_PAYMENT",

      createdAt: now,
      updatedAt: now
    };

    await orderRef.set(order);

    return res.status(201).json({
      success: true,
      message: "Order created. Payment is still pending.",

      order: {
        orderId: order.orderId,
        currency: order.currency,

        originalTotalINR: order.originalTotalINR,
        discountPercent: order.discountPercent,
        discountAmountINR: order.discountAmountINR,

        totalINR: order.totalINR,

        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus
      }
    });
  } catch (error) {
    console.error(
      "Checkout order API error:",
      error.message
    );

    return sendError(
      res,
      500,
      "Unable to process checkout right now. Please try again."
    );
  }
};
