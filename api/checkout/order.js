const admin = require("firebase-admin");
const { getSession } = require("../../lib/auth");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const USD_TO_INR = 85;

function getDatabase() {
  if (!admin.apps.length) {
    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    }

    const serviceAccount = JSON.parse(serviceAccountText);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: DATABASE_URL
    });
  }

  return admin.database();
}

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
 * Create a YouPI PG payment for an existing order.
 *
 * The amount always comes from the order stored in the database
 * (verified on the server), never from the browser.
 *
 * Required environment variables (Vercel):
 *   YOUPI_API_URL      e.g. https://youpi-pg-4n2w.onrender.com
 *   YOUPI_MERCHANT_ID  optional - if empty, the gateway uses its default merchant
 */
async function createPayment(req, res, session) {
  const gatewayUrl = process.env.YOUPI_API_URL;
  const merchantId = (process.env.YOUPI_MERCHANT_ID || "").trim();

  if (!gatewayUrl) {
    return sendError(
      res,
      500,
      "Payment gateway is not configured."
    );
  }

  const orderId =
    typeof req.body?.orderId === "string"
      ? req.body.orderId.trim()
      : "";

  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orderId)) {
    return sendError(res, 400, "Valid order ID is required.");
  }

  const db = getDatabase();
  const uid = String(session.uid);

  const orderRef = db.ref(`users/${uid}/orders/${orderId}`);
  const snapshot = await orderRef.get();

  if (!snapshot.exists()) {
    return sendError(res, 404, "Order not found.");
  }

  const order = snapshot.val();

  if (
    order.orderId !== orderId ||
    String(order.userId) !== uid
  ) {
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

  // Integer paise avoids any floating point drift.
  const amountPaise = Math.round(Number(order.totalINR) * 100);

  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return sendError(res, 400, "Invalid order amount.");
  }

  const baseUrl = gatewayUrl.replace(/\/+$/, "");

  // Every attempt gets its own reference, so a retry after an
  // expired or failed attempt never clashes with the earlier one.
  // The webhook maps the paymentId back to the real order.
  const gatewayOrderId = `${orderId}_${Date.now().toString(36)}`;

  let response;
  let result = {};

  // The gateway can answer with a short-lived 500 (for example while its
  // single database file is busy). Creating a payment is safe to repeat with
  // the same reference, so retry a couple of times before giving up.
  const MAX_ATTEMPTS = 3;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      response = await fetch(`${baseUrl}/api/v1/payments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          ...(merchantId ? { "X-Merchant-Id": merchantId } : {})
        },
        body: JSON.stringify({
          orderId: gatewayOrderId,
          amount: (amountPaise / 100).toFixed(2),
          currency: "INR",
          description: `Shoppy order ${orderId}`,
          metadata: {
            shoppyOrderId: orderId,
            userId: uid
          }
        }),
        signal: AbortSignal.timeout(20000)
      });
    } catch (error) {
      console.error("Gateway request failed:", error.message);

      return sendError(
        res,
        502,
        "Payment gateway is not reachable. Please try again."
      );
    }

    result = await response.json().catch(() => ({}));

    if (response.status < 500 || attempt === MAX_ATTEMPTS) break;

    console.warn(
      `Gateway answered ${response.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying.`
    );

    await new Promise(resolve => setTimeout(resolve, 1200 * attempt));
  }

  if (response.status === 409) {
    return sendError(
      res,
      409,
      result.message ||
        "You already have an active payment on another device. Finish or cancel it first."
    );
  }

  if (
    !response.ok ||
    typeof result.paymentId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(result.paymentId)
  ) {
    console.error(
      "Gateway payment creation failed:",
      response.status,
      result.error || result.message || ""
    );

    return sendError(
      res,
      response.status >= 400 && response.status < 500
        ? response.status
        : 502,
      result.message || result.error || "Unable to start payment."
    );
  }

  const paymentId = result.paymentId;
  const now = Date.now();

  // Remember which order this payment belongs to. The webhook uses
  // this record to find the order and to check the paid amount.
  await db.ref(`paymentIndex/${paymentId}`).set({
    uid,
    orderId,
    // The gateway may add its own suffix to a reused reference; the webhook
    // compares against whatever reference the gateway actually used.
    gatewayOrderId: String(result.orderId || gatewayOrderId),
    amountPaise,
    status: String(result.status || "INITIATED"),
    createdAt: now,
    updatedAt: now
  });

  await orderRef.update({
    lastPaymentId: paymentId,
    updatedAt: now
  });

  return res.status(200).json({
    success: true,
    orderId,
    paymentId,
    amount: (amountPaise / 100).toFixed(2),
    currency: "INR",
    // Built from our own configured URL, not taken from the response.
    checkoutUrl: `${baseUrl}/checkout/${paymentId}`,
    status: result.status || "INITIATED"
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendError(res, 405, "Method not allowed.");
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

    /*
     * Payment initiation and order creation share this API,
     * keeping the Serverless Function count lower.
     */
    if (req.body?.action === "create-payment") {
      return await createPayment(req, res, session);
    }

    const addressId =
      typeof req.body?.addressId === "string"
        ? req.body.addressId.trim()
        : "";

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(addressId)) {
      return sendError(
        res,
        400,
        "A valid address ID is required."
      );
    }

    const db = getDatabase();
    const uid = String(session.uid);

    // Verify that the address belongs to the signed-in user.
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

    // Read the cart from the database, not from the browser.
    const cartSnapshot = await db
      .ref(`users/${uid}/cart/items`)
      .get();

    const savedItems = cartSnapshot.val();

    if (
      !savedItems ||
      typeof savedItems !== "object" ||
      Array.isArray(savedItems)
    ) {
      return sendError(res, 400, "Your cart is empty.");
    }

    const entries = Object.entries(savedItems);

    if (entries.length === 0 || entries.length > 50) {
      return sendError(
        res,
        400,
        "Your cart is empty or too large."
      );
    }

    const items = [];
    let totalUSD = 0;

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

      const unitPriceUSD = getVerifiedPrice(product);

      const lineTotalUSD = Number(
        (unitPriceUSD * quantity).toFixed(2)
      );

      items.push({
        productId,
        title: product.title.slice(0, 200),
        quantity,
        unitPriceUSD: Number(unitPriceUSD.toFixed(2)),
        lineTotalUSD
      });

      totalUSD = Number(
        (totalUSD + lineTotalUSD).toFixed(2)
      );
    }

    if (!Number.isFinite(totalUSD) || totalUSD <= 0) {
      return sendError(res, 400, "Order total is invalid.");
    }

    const totalINR = Number(
      (totalUSD * USD_TO_INR).toFixed(2)
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
