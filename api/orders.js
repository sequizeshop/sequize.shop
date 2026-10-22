const { getSession } = require("../lib/auth");
const { getDatabase, syncPayment } = require("../lib/cashfree");

const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // sirf pichhle 7 din ke pending orders
const MAX_SYNC = 5;

async function readOrders(db, uid) {
  const snapshot = await db
    .ref("users")
    .child(uid)
    .child("orders")
    .once("value");

  const saved = snapshot.val();

  const orders =
    saved && typeof saved === "object" && !Array.isArray(saved)
      ? Object.entries(saved).map(([key, value]) => ({
          ...(value && typeof value === "object" ? value : {}),
          orderId: key
        }))
      : [];

  orders.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  return orders;
}

/*
 * Pending orders ko Cashfree se verify karo.
 * Agar paisa aa chuka hai to order PAID ho jata hai (tab band hone ya
 * webhook late aane par bhi). Error aaye to orders list phir bhi load hoti hai.
 */
async function syncPendingOrders(db, orders) {
  const now = Date.now();

  const pending = orders
    .filter(
      o =>
        o.paymentStatus === "PENDING" &&
        o.lastPaymentId &&
        now - Number(o.createdAt || 0) < SYNC_WINDOW_MS
    )
    .slice(0, MAX_SYNC);

  if (pending.length === 0) return false;

  const results = await Promise.allSettled(
    pending.map(o => syncPayment(db, String(o.lastPaymentId)))
  );

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.warn("Order sync failed:", pending[i].orderId, r.reason?.message);
    }
  });

  return results.some(r => r.status === "fulfilled" && r.value === "PAID");
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
    const uid = String(session.uid);

    let orders = await readOrders(db, uid);

    try {
      const changed = await syncPendingOrders(db, orders);
      if (changed) orders = await readOrders(db, uid);
    } catch (error) {
      console.warn("Pending order sync skipped:", error.message);
    }

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
