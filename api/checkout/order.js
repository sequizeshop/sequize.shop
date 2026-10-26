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

const ADMIN_API_BASE =
  "https://apisequizeshoplite.vercel.app";

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

function roundMoney(value) {
  return Number(Number(value).toFixed(2));
}

/*
 * Product prices are verified from Firebase.
 * This matches the existing cart's USD conversion.
 */
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
    return roundMoney(inr / USD_TO_INR);
  }

  throw new Error("Invalid product price.");
}

function getSiteUrl(req) {
  const configured = String(
    process.env.SITE_URL || ""
  ).trim().replace(/\/+$/, "");

  return configured || `https://${req.headers.host}`;
}

/*
 * Customer email:
 * 1. Authenticated session
 * 2. Firebase user record
 */
async function getCustomerEmail(db, uid, session) {
  const fromSession = String(
    session?.email ||
    session?.user?.email ||
    ""
  ).trim().toLowerCase();

  if (fromSession) {
    return fromSession;
  }

  for (const path of [
    `Users/${uid}`,
    `users/${uid}`
  ]) {
    try {
      const snapshot = await db.ref(path).get();

      if (!snapshot.exists()) {
        continue;
      }

      const user = snapshot.val();

      const email = String(
        user?.email ||
        user?.Email ||
        user?.profile?.email ||
        ""
      ).trim().toLowerCase();

      if (email) {
        return email;
      }
    } catch (error) {
      console.warn(
        "Unable to read customer email:",
        error.message
      );
    }
  }

  return "";
}

/*
 * Load taxes and discounts from the same admin APIs
 * used by the cart page.
 *
 * There are no hardcoded tax or discount fallbacks.
 */
async function loadPricingSettings(db, uid, session) {
  const email = await getCustomerEmail(
    db,
    uid,
    session
  );

  const discountURL =
    `${ADMIN_API_BASE}/api/admin/discounts` +
    (
      email
        ? `?email=${encodeURIComponent(email)}`
        : ""
    );

  const [taxResponse, discountResponse] =
    await Promise.all([
      fetch(`${ADMIN_API_BASE}/api/admin/taxes`, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10000)
      }),

      fetch(discountURL, {
        method: "GET",
        headers: {
          Accept: "application/json"
        },
        cache: "no-store",
        signal: AbortSignal.timeout(10000)
      })
    ]);

  const [taxData, discountData] =
    await Promise.all([
      taxResponse.json().catch(() => ({})),
      discountResponse.json().catch(() => ({}))
    ]);

  if (
    !taxResponse.ok ||
    taxData.success !== true ||
    !Array.isArray(taxData.taxes)
  ) {
    throw new Error(
      "Admin tax settings could not be loaded."
    );
  }

  if (
    !discountResponse.ok ||
    discountData.success !== true ||
    !Array.isArray(discountData.discounts)
  ) {
    throw new Error(
      "Admin discount settings could not be loaded."
    );
  }

  /*
   * Match the cart's tax validation.
   */
  const taxes = taxData.taxes.filter(tax =>
    tax &&
    String(tax.title || "").trim() &&
    Number.isFinite(Number(tax.percent)) &&
    Number(tax.percent) >= 0 &&
    Number(tax.percent) <= 100
  ).map(tax => ({
    id: String(tax.id || tax.key || ""),
    title: String(tax.title),
    percent: Number(tax.percent)
  }));

  /*
   * Match the cart's eligible discount filtering.
   */
  const discounts = discountData.discounts.filter(item =>
    item &&
    Number(item.percent) > 0 &&
    Number(item.percent) <= 100
  );

  /*
   * Same rule as getAppliedDiscount() in the cart.
   */
  discounts.sort(
    (a, b) => Number(b.percent) - Number(a.percent)
  );

  return {
    taxes,
    discount: discounts[0] || null
  };
}

/*
 * Load only the current authenticated user's order.
 */
async function loadOwnOrder(db, uid, orderId) {
  const orderRef = db.ref(
    `users/${uid}/orders/${orderId}`
  );

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
 * Send a payment notification only once per final status.
 */
async function sendPaymentNotification(
  db,
  uid,
  order,
  status
) {
  try {
    if (
      status !== "PAID" &&
      status !== "FAILED"
    ) {
      return;
    }

    const orderId = String(order.orderId);

    const amount = Number(
      order.totalINR
    ).toFixed(2);

    const paid = status === "PAID";

    const notificationId =
      `${paid ? "payment_success" : "payment_failed"}_${orderId}`;

    const notification = paid
      ? {
          title: "Order placed successfully 🎉",
          message:
            `Dear Shoppy user, your order (${orderId}) ` +
            `worth ₹${amount} has been placed successfully. ` +
            "Thank you for shopping with Shoppy!",
          category: "orders",
          type: "success",
          read: false,
          createdAt: Date.now(),
          orderId,
          source: "payment"
        }
      : {
          title: "Payment not completed",
          message:
            `Dear Shoppy user, payment for your order (${orderId}) ` +
            `worth ₹${amount} was not completed. ` +
            "Please try again to complete your purchase. " +
            "If any amount was deducted, allow time for the " +
            "payment status to update.",
          category: "payments",
          type: "warning",
          read: false,
          createdAt: Date.now(),
          orderId,
          source: "payment"
        };

    await db
      .ref(`Notifications/${uid}/${notificationId}`)
      .transaction(current =>
        current !== null
          ? undefined
          : notification
      );

  } catch (error) {
    console.error(
      "Payment notification error:",
      error.message
    );
  }
}

/*
 * STEP 1: Create Cashfree payment session.
 *
 * Use only the saved order total.
 * Do not calculate taxes or discounts again here.
 */
async function createPayment(req, res, session) {
  const orderId =
    typeof req.body?.orderId === "string"
      ? req.body.orderId.trim()
      : "";

  if (!ID_PATTERN.test(orderId)) {
    return sendError(
      res,
      400,
      "Valid order ID is required."
    );
  }

  const db = getDatabase();
  const uid = String(session.uid);

  const {
    orderRef,
    order
  } = await loadOwnOrder(
    db,
    uid,
    orderId
  );

  if (!order) {
    return sendError(
      res,
      404,
      "Order not found."
    );
  }

  if (
    order.currency !== "INR" ||
    !Number.isFinite(Number(order.totalINR)) ||
    Number(order.totalINR) <= 0
  ) {
    return sendError(
      res,
      400,
      "Invalid order amount."
    );
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
   * Use the exact saved total. No second discount or tax.
   */
  const amountPaise = Math.round(
    Number(order.totalINR) * 100
  );

  if (
    !Number.isInteger(amountPaise) ||
    amountPaise <= 0
  ) {
    return sendError(
      res,
      400,
      "Invalid order amount."
    );
  }

  const addressSnapshot = await db
    .ref(
      `users/${uid}/addresses/${order.addressId}`
    )
    .get();

  const address = addressSnapshot.val() || {};

  const phone = String(
    address.phone || ""
  ).replace(/\D/g, "").slice(-10);

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
      notify_url:
        `${getSiteUrl(req)}/api/cashfree-webhook`
    },

    order_note:
      `Shoppy order ${orderId}`.slice(0, 200)
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

    result = await response
      .json()
      .catch(() => ({}));

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
      response.status >= 400 &&
      response.status < 500
        ? 400
        : 502,
      "Unable to start payment. Please try again."
    );
  }

  const now = Date.now();

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
    amount: (amountPaise / 100).toFixed(2),
    currency: "INR"
  });
}

/*
 * STEP 2: Verify payment with the server.
 */
async function verifyPayment(req, res, session) {
  const orderId =
    typeof req.body?.orderId === "string"
      ? req.body.orderId.trim()
      : "";

  if (!ID_PATTERN.test(orderId)) {
    return sendError(
      res,
      400,
      "Valid order ID is required."
    );
  }

  const db = getDatabase();
  const uid = String(session.uid);

  const { order } = await loadOwnOrder(
    db,
    uid,
    orderId
  );

  if (!order) {
    return sendError(
      res,
      404,
      "Order not found."
    );
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
    return res.status(200).json({
      success: true,
      paymentStatus: "PENDING"
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

/*
 * STEP 3: Create an order from the authenticated user's cart.
 */
async function createOrder(req, res, session) {
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

  /*
   * Validate delivery address.
   */
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

  /*
   * Load the authenticated user's cart.
   */
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
  let subtotalUSD = 0;

  /*
   * Re-read every product price from Firebase.
   * Browser-submitted prices are not trusted.
   */
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

    let unitPriceUSD;

    try {
      unitPriceUSD = roundMoney(
        getVerifiedPrice(product)
      );
    } catch (_) {
      return sendError(
        res,
        409,
        "A product has an invalid price."
      );
    }

    const lineTotalUSD = roundMoney(
      unitPriceUSD * quantity
    );

    items.push({
      productId,
      title: product.title.slice(0, 200),
      quantity,
      unitPriceUSD,
      lineTotalUSD
    });

    subtotalUSD = roundMoney(
      subtotalUSD + lineTotalUSD
    );
  }

  if (
    !Number.isFinite(subtotalUSD) ||
    subtotalUSD <= 0
  ) {
    return sendError(
      res,
      400,
      "Order subtotal is invalid."
    );
  }

  /*
   * Load the same admin-managed pricing settings
   * used by the cart page.
   *
   * If settings cannot load, stop checkout rather
   * than charging a different amount.
   */
  let pricing;

  try {
    pricing = await loadPricingSettings(
      db,
      uid,
      session
    );
  } catch (error) {
    console.error(
      "Pricing settings unavailable:",
      error.message
    );

    return sendError(
      res,
      503,
      "Current taxes and discounts could not be loaded. Please try again."
    );
  }

  /*
   * Apply the selected discount exactly once.
   */
  const discount = pricing.discount;

  const discountPercent = discount
    ? Number(discount.percent) || 0
    : 0;

  const discountUSD = roundMoney(
    subtotalUSD * discountPercent / 100
  );

  const discountedSubtotalUSD = Math.max(
    0,
    roundMoney(subtotalUSD - discountUSD)
  );

  /*
   * Calculate every currently configured tax.
   * A new admin tax appears automatically.
   */
  const taxes = pricing.taxes.map(tax => {
    const percent = Number(tax.percent) || 0;

    const amountUSD = roundMoney(
      discountedSubtotalUSD * percent / 100
    );

    return {
      id: tax.id,
      title: tax.title,
      percent,
      amountUSD,
      amountINR: roundMoney(
        amountUSD * USD_TO_INR
      )
    };
  });

  const subtotalINR = roundMoney(
    subtotalUSD * USD_TO_INR
  );

  const discountINR = roundMoney(
    discountUSD * USD_TO_INR
  );

  const taxTotalUSD = roundMoney(
    taxes.reduce(
      (sum, tax) => sum + tax.amountUSD,
      0
    )
  );

  const taxTotalINR = roundMoney(
    taxes.reduce(
      (sum, tax) => sum + tax.amountINR,
      0
    )
  );

  /*
   * Use the sum of the displayed INR components,
   * so the saved total matches the displayed breakdown.
   */
  const totalINR = roundMoney(
    subtotalINR - discountINR + taxTotalINR
  );

  const totalUSD = roundMoney(
    totalINR / USD_TO_INR
  );

  if (
    !Number.isFinite(totalINR) ||
    totalINR <= 0
  ) {
    return sendError(
      res,
      400,
      "Order total is invalid."
    );
  }

  /*
   * Save the complete verified order.
   */
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

    subtotalUSD,
    subtotalINR,

    discount: discount
      ? {
          id: String(
            discount.id ||
            discount.key ||
            ""
          ),
          title: String(
            discount.title ||
            "Discount"
          ),
          percent: discountPercent,
          amountUSD: discountUSD,
          amountINR: discountINR
        }
      : null,

    taxes,
    taxTotalUSD,
    taxTotalINR,

    totalUSD,
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

      subtotalUSD: order.subtotalUSD,
      subtotalINR: order.subtotalINR,

      discount: order.discount,

      taxes: order.taxes,
      taxTotalUSD: order.taxTotalUSD,
      taxTotalINR: order.taxTotalINR,

      totalUSD: order.totalUSD,
      totalINR: order.totalINR,

      paymentStatus: order.paymentStatus,
      orderStatus: order.orderStatus
    }
  });
}

/*
 * Main API handler.
 */
module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "private, no-store"
  );

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
      return await createPayment(
        req,
        res,
        session
      );
    }

    if (req.body?.action === "verify-payment") {
      return await verifyPayment(
        req,
        res,
        session
      );
    }

    return await createOrder(
      req,
      res,
      session
    );

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
