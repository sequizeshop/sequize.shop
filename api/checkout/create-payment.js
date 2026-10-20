const { getSession, sendJson } = require("../../lib/auth");
const admin = require("firebase-admin");

const GATEWAY_URL = process.env.PAYMENT_GATEWAY_URL;
const SHOPPY_GATEWAY_SECRET = process.env.SHOPPY_GATEWAY_SECRET;

function getDatabase() {
  if (!admin.apps.length) {
    const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountRaw) {
      throw new Error("Firebase service account is not configured");
    }

    const serviceAccount = JSON.parse(serviceAccountRaw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL:
        "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app",
    });
  }

  return admin.database();
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendJson(res, 401, {
        success: false,
        message: "Please log in to continue",
      });
    }

    if (!GATEWAY_URL || !SHOPPY_GATEWAY_SECRET) {
      return sendJson(res, 500, {
        success: false,
        message: "Payment gateway is not configured",
      });
    }

    const { orderId } = req.body || {};

    if (
      typeof orderId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(orderId)
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Valid orderId is required",
      });
    }

    const database = getDatabase();

    const orderSnapshot = await database
      .ref(`users/${session.uid}/orders/${orderId}`)
      .get();

    if (!orderSnapshot.exists()) {
      return sendJson(res, 404, {
        success: false,
        message: "Order not found",
      });
    }

    const order = orderSnapshot.val();

    if (
      order.orderId !== orderId ||
      order.userId !== session.uid ||
      order.currency !== "INR" ||
      !Number.isFinite(order.totalINR) ||
      order.totalINR <= 0 ||
      order.paymentStatus !== "PENDING" ||
      order.orderStatus !== "PENDING_PAYMENT"
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Order is invalid or already processed",
      });
    }

    const response = await fetch(
      `${GATEWAY_URL.replace(/\/+$/, "")}/api/payments`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-shoppy-gateway-secret": SHOPPY_GATEWAY_SECRET,
        },
        body: JSON.stringify({
          orderId,
          userId: session.uid,
        }),
        signal: AbortSignal.timeout(25000),
      }
    );

    const result = await response.json();

    if (
      !response.ok ||
      result.success !== true ||
      typeof result.paymentUrl !== "string" ||
      !result.paymentUrl.startsWith("https://autoupi.in/pay/")
    ) {
      console.error("Gateway rejected payment creation:", response.status);

      return sendJson(res, response.status >= 400 && response.status < 500
        ? response.status
        : 502, {
        success: false,
        message: result.message || "Unable to start payment",
      });
    }

    return sendJson(res, 200, {
      success: true,
      orderId: result.orderId,
      paymentId: result.paymentId,
      amount: result.amount,
      payableAmount: result.payableAmount,
      currency: result.currency,
      paymentUrl: result.paymentUrl,
      status: result.status,
    });
  } catch (error) {
    console.error("Create payment error:", error.message);

    return sendJson(res, 500, {
      success: false,
      message: "Unable to start payment",
    });
  }
};
