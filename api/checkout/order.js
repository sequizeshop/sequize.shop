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
 * Create an Auto Upi payment using the existing checkout API.
 * The gateway secret is never sent to the browser.
 */
async function createPayment(req, res, session) {
  const gatewayUrl = process.env.PAYMENT_GATEWAY_URL;
  const gatewaySecret = process.env.SHOPPY_GATEWAY_SECRET;

  if (!gatewayUrl || !gatewaySecret) {
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

  const snapshot = await db
    .ref(`users/${uid}/orders/${orderId}`)
    .get();

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

  const baseUrl = gatewayUrl.replace(/\/+$/, "");

  const response = await fetch(`${baseUrl}/api/payments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "x-shoppy-gateway-secret": gatewaySecret
    },
    body: JSON.stringify({
      orderId,
      userId: uid
    }),
    signal: AbortSignal.timeout(25000)
  });

  const result = await response.json().catch(() => ({}));

  if (
    !response.ok ||
    result.success !== true ||
    typeof result.paymentUrl !== "string" ||
    !result.paymentUrl.startsWith("https://autoupi.in/pay/") ||
    typeof result.paymentId !== "string"
  ) {
    console.error(
      "Gateway payment creation failed:",
      response.status
    );

    return sendError(
      res,
      response.status >= 400 && response.status < 500
        ? response.status
        : 502,
      result.message || "Unable to start payment."
    );
  }

  return res.status(200).json({
    success: true,
    orderId: result.orderId,
    paymentId: result.paymentId,
    amount: result.amount,
    payableAmount: result.payableAmount,
    currency: result.currency,
    paymentUrl: result.paymentUrl,
    status: result.status
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
