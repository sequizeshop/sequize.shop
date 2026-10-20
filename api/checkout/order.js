
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

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Method not allowed.");
  }

  try {
    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(res, 401, "Please log in to continue.");
    }

    const addressId =
      typeof req.body?.addressId === "string"
        ? req.body.addressId.trim()
        : "";

    if (!/^[A-Za-z0-9_-]{1,128}$/.test(addressId)) {
      return sendError(res, 400, "A valid address ID is required.");
    }

    const db = getDatabase();
    const uid = String(session.uid);

    // Verify that the chosen address belongs to this user.
    const addressSnapshot = await db
      .ref(`users/${uid}/addresses/${addressId}`)
      .get();

    if (!addressSnapshot.exists()) {
      return sendError(res, 404, "Delivery address not found.");
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
      return sendError(res, 422, "Delivery address is incomplete.");
    }

    // Read the signed-in user's server-side cart.
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
      return sendError(res, 400, "Your cart is empty or too large.");
    }

    const items = [];
    let totalUSD = 0;

    for (const [productId, cartItem] of entries) {
      if (!PRODUCT_ID_PATTERN.test(productId)) {
        return sendError(res, 400, "Cart contains an invalid product.");
      }

      const quantity = Number(cartItem?.quantity);

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        return sendError(res, 400, "Cart contains an invalid quantity.");
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
        return sendError(res, 409, "A product has invalid details.");
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

      totalUSD = Number((totalUSD + lineTotalUSD).toFixed(2));
    }

    if (!Number.isFinite(totalUSD) || totalUSD <= 0) {
      return sendError(res, 400, "Order total is invalid.");
    }

    const totalINR = Number((totalUSD * USD_TO_INR).toFixed(2));
    const orderRef = db.ref(`users/${uid}/orders`).push();
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
    console.error("Checkout order API error:", error.message);

    return sendError(
      res,
      500,
      "Unable to create your order right now. Please try again."
    );
  }
};
