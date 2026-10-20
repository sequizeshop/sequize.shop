

const admin = require("firebase-admin");
const { getSession } = require("../lib/auth");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

function getDatabase() {
  if (!admin.apps.length) {
    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(serviceAccountText)
      ),
      databaseURL: DATABASE_URL
    });
  }

  return admin.database();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const session = await getSession(req);

    if (!session || !session.uid) {
      return res.status(401).json({
        success: false,
        message: "Please log in to view your orders."
      });
    }

    const db = getDatabase();
    const snapshot = await db
      .ref("users")
      .child(String(session.uid))
      .child("orders")
      .once("value");

    const savedOrders = snapshot.val();

    const orders = savedOrders &&
      typeof savedOrders === "object" &&
      !Array.isArray(savedOrders)
      ? Object.entries(savedOrders).map(([key, value]) => ({
          ...(value && typeof value === "object" ? value : {}),
          orderId: key
        }))
      : [];

    orders.sort((a, b) =>
      Number(b.createdAt || 0) - Number(a.createdAt || 0)
    );

    return res.status(200).json({
      success: true,
      total: orders.length,
      orders
    });
  } catch (error) {
    console.error("My Orders API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to load orders right now."
    });
  }
};
