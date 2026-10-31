// api/orders.js
//
// My Orders API. Poora order system yahin hai:
//  - GET  /api/orders              -> logged-in user ke saare orders
//  - GET  /api/orders?orderId=XYZ  -> ek order ki details (order details page)
//  - POST /api/orders              -> body: { action: "cancel", orderId } -> order cancel
//
// Har order ke saath:
//      paymentLabel / paymentTone -> price ke baju ka tag: Paid / Not paid ...
//      statusLabel / statusTone   -> Waiting to confirm / Confirmed / Delivered / Cancelled
//      canContinuePayment         -> "Continue to payment" button dikhana hai ya nahi
//      canCancel                  -> "Cancel order" button dikhana hai ya nahi
//      tracking                   -> timeline (times neeche SETTINGS mein badal sakte ho)

const crypto = require("crypto");
const { getSession } = require("../lib/auth");
const { getDatabase, syncPayment } = require("../lib/cashfree");

/* =====================================================================
 *  SETTINGS — delivery ka time yahin se badlo (sab kuch MINUTES mein)
 *
 *  Timeline:  Order placed --> Confirmed --> Shipped --> Delivered
 *
 *  Kuch useful values:  30 = aadha ghanta | 60 = 1 ghanta
 *                       120 = 2 ghante    | 1440 = 1 din
 *
 *  Sirf in 3 numbers ko badalna hai, baaki sab apne aap adjust ho jata hai
 *  (My Orders page, Order details page, countdown, "Delivered in ..." text).
 * ===================================================================== */

// Order place (ya payment) hone ke kitne minute baad "Confirmed" hoga
const CONFIRM_AFTER_MIN = 10;

// "Confirmed" hone ke kitne minute baad "Shipped" hoga
const SHIP_AFTER_MIN = 30;

// "Shipped" hone ke kitne minute baad "Delivered" hoga
const DELIVER_AFTER_MIN = 120;

/* ===================== SETTINGS khatam ===================== */

const MIN_MS = 60 * 1000;

const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // sirf pichhle 7 din ke pending orders
const MAX_SYNC = 5;
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/* ---------- Status rules ---------- */

const PAID_PAYMENT = ["PAID", "SUCCESS", "SUCCESSFUL", "COMPLETED", "CAPTURED"];
const FAILED = ["FAILED", "EXPIRED", "USER_DROPPED"];
const CANCELLED = ["CANCELLED", "CANCELED"];
const REFUNDED = ["REFUNDED"];
const DELIVERED_ORDER = ["DELIVERED", "COMPLETED"];

function norm(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
}

function toMs(value) {
  if (value === undefined || value === null || value === "") return 0;

  const n =
    typeof value === "number" || /^\d+$/.test(String(value))
      ? Number(value)
      : Date.parse(value);

  return Number.isFinite(n) && n > 0 ? n : 0;
}

/*
 * Ek order ka payment tag, status tag, tracking aur cancel permission.
 * Tone: "paid" (green) | "warn" (amber) | "failed" (red) | "" (grey)
 */
function describeOrder(order, now) {
  const pay = norm(order.paymentStatus || "PENDING");
  const ord = norm(order.orderStatus || "PENDING");

  const paid = PAID_PAYMENT.includes(pay);
  const cancelled = CANCELLED.includes(pay) || CANCELLED.includes(ord);
  const refunded = REFUNDED.includes(pay) || REFUNDED.includes(ord);
  const failed = !paid && (FAILED.includes(pay) || FAILED.includes(ord));
  const delivered = DELIVERED_ORDER.includes(ord);

  // Price ke baju mein chhota tag (price ka rang bhi isi se)
  let paymentLabel;
  let paymentTone;

  if (refunded) {
    paymentLabel = "Refunded";
    paymentTone = "";
  } else if (paid) {
    paymentLabel = "Paid";
    paymentTone = "paid";
  } else if (failed) {
    paymentLabel = "Payment failed";
    paymentTone = "failed";
  } else {
    paymentLabel = "Not paid";
    paymentTone = "failed";
  }

  const canContinuePayment =
    pay === "PENDING" && !cancelled && !failed && !refunded && !delivered;

  // Cancel: shipped hone se pehle tak (unpaid order kabhi bhi cancel ho sakta hai)
  let canCancel =
    !paid && !cancelled && !failed && !refunded && !delivered && pay === "PENDING";

  // Status tag (Waiting to confirm / Confirmed / Delivered) + tracking
  let statusLabel = "";
  let statusTone = "";
  let tracking = null;

  if (!cancelled && !failed && !refunded) {
    // Timeline payment hone ke time se chalti hai (paidAt na ho to order ke time se)
    const startAt = (paid && toMs(order.paidAt)) || toMs(order.createdAt);

    if (startAt) {
      // Times upar SETTINGS se aate hain
      const confirmAt = startAt + CONFIRM_AFTER_MIN * MIN_MS;
      const shipAt = confirmAt + SHIP_AFTER_MIN * MIN_MS;
      const endAt = shipAt + DELIVER_AFTER_MIN * MIN_MS;

      tracking = {
        active: paid,
        forceDelivered: paid && delivered,
        // Order placed, Confirmed, Shipped, Delivered
        milestones: [startAt, confirmAt, shipAt, endAt],
        startAt,
        endAt,
        note: paid ? "" : "Delivery starts after payment is confirmed."
      };

      if (paid) {
        canCancel = !delivered && now < shipAt;

        if (delivered || now >= endAt) {
          statusLabel = "Delivered";
          statusTone = "paid";
        } else if (now >= confirmAt) {
          statusLabel = "Confirmed";
          statusTone = "paid";
        } else {
          statusLabel = "Waiting to confirm";
          statusTone = "warn";
        }
      }
    }
  }

  if (cancelled) {
    statusLabel = "Cancelled";
    statusTone = "failed";

    // Paisa aa chuka tha to refund baaki hai
    if (paid) {
      paymentLabel = "Refund pending";
      paymentTone = "";
    }
  }

  return {
    paymentLabel,
    paymentTone,
    statusLabel,
    statusTone,
    canContinuePayment,
    canCancel,
    tracking
  };
}

/* ---------- Image proxy (same logic as api/products.js) ---------- */

const IMAGE_PROXY_PATH = "/img/";
const OLD_PROXY_PREFIX = "https://apisequizeshoplite-two.vercel.app/api/image/";
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;

function proxyImage(url) {
  if (typeof url !== "string" || !url) return "";
  if (url.startsWith(IMAGE_PROXY_PATH) || url.startsWith(OLD_PROXY_PREFIX)) return url;
  try {
    if (new URL(url).protocol !== "https:") return url;
  } catch {
    return url;
  }

  const secret = process.env.IMAGE_PROXY_SECRET;
  if (!secret) throw new Error("IMAGE_PROXY_SECRET environment variable is missing.");

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.createHmac("sha256", key).update(url).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64url");

  return IMAGE_PROXY_PATH + token + ".jpg";
}

function itemProductId(item) {
  const id = String(item.productId ?? item.id ?? item.product_id ?? "");
  return PRODUCT_ID_PATTERN.test(id) ? id : "";
}

function itemOwnImage(item) {
  return (
    item.thumbnail ||
    item.image ||
    item.imageUrl ||
    (Array.isArray(item.images) ? item.images[0] : "") ||
    ""
  );
}

/*
 * Har item mein `thumbnail` set karo.
 * Pehle item ki apni image, nahi ho to products/<id> se.
 * Koi bhi error aaye to orders list phir bhi normal load hoti hai.
 */
async function addItemImages(db, orders) {
  const ids = new Set();

  orders.forEach(order => {
    if (!Array.isArray(order.items)) return;
    order.items.forEach(item => {
      if (item && typeof item === "object" && !itemOwnImage(item)) {
        const id = itemProductId(item);
        if (id) ids.add(id);
      }
    });
  });

  const catalog = {};

  await Promise.all(
    [...ids].map(async id => {
      try {
        const snap = await db.ref("products").child(id).once("value");
        const p = snap.val();
        if (p && typeof p === "object") {
          catalog[id] =
            p.thumbnail || (Array.isArray(p.images) ? p.images[0] : "") || "";
        }
      } catch (error) {
        console.warn("Product image lookup failed:", id, error.message);
      }
    })
  );

  orders.forEach(order => {
    if (!Array.isArray(order.items)) return;

    order.items = order.items.map(item => {
      if (!item || typeof item !== "object") return item;

      const raw = itemOwnImage(item) || catalog[itemProductId(item)] || "";
      if (!raw) return item;

      try {
        return { ...item, thumbnail: proxyImage(raw) };
      } catch (error) {
        console.warn("Image proxy skipped:", error.message);
        return item;
      }
    });
  });
}

/* ---------- Orders ---------- */

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
        !CANCELLED.includes(norm(o.orderStatus)) &&
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

/* ---------- Single order ---------- */

async function readSingleOrder(db, uid, orderId) {
  let orders = await readOrders(db, uid);
  let order = orders.find(o => o.orderId === orderId);
  if (!order) return null;

  // Is order ka payment Cashfree se verify karo
  try {
    if (await syncPendingOrders(db, [order])) {
      orders = await readOrders(db, uid);
      order = orders.find(o => o.orderId === orderId) || order;
    }
  } catch (error) {
    console.warn("Order sync skipped:", error.message);
  }

  try {
    await addItemImages(db, [order]);
  } catch (error) {
    console.warn("Item images skipped:", error.message);
  }

  return order;
}

/* ---------- Cancel ---------- */

async function cancelOrder(db, uid, orderId) {
  // Cancel se pehle ek baar payment verify karo (paisa aa chuka ho to unpaid cancel na ho)
  const current = await readSingleOrder(db, uid, orderId);
  if (!current) return { status: 404, message: "Order not found." };

  const now = Date.now();

  if (!describeOrder(current, now).canCancel) {
    return { status: 409, message: "This order can no longer be cancelled." };
  }

  const update = { orderStatus: "CANCELLED", cancelledAt: now };

  // Unpaid order ka payment bhi band karo
  if (!PAID_PAYMENT.includes(norm(current.paymentStatus))) {
    update.paymentStatus = "CANCELLED";
  }

  await db
    .ref("users")
    .child(uid)
    .child("orders")
    .child(orderId)
    .update(update);

  return { status: 200 };
}

function readBody(req) {
  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  return body && typeof body === "object" ? body : {};
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;

  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
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

    /* ----- POST: cancel order ----- */
    if (req.method === "POST") {
      if (!sameOrigin(req)) {
        return res.status(403).json({
          success: false,
          message: "Request blocked."
        });
      }

      const body = readBody(req);
      const orderId = String(body.orderId || "");

      if (body.action !== "cancel" || !ORDER_ID_PATTERN.test(orderId)) {
        return res.status(400).json({
          success: false,
          message: "Invalid request."
        });
      }

      const result = await cancelOrder(db, uid, orderId);

      if (result.status !== 200) {
        return res.status(result.status).json({
          success: false,
          message: result.message
        });
      }

      return res.status(200).json({
        success: true,
        message: "Your order has been cancelled."
      });
    }

    /* ----- GET: single order ----- */
    const orderId = new URL(req.url, "http://localhost").searchParams.get("orderId");

    if (orderId !== null) {
      if (!ORDER_ID_PATTERN.test(orderId)) {
        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      const order = await readSingleOrder(db, uid, orderId);

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      const now = Date.now();

      return res.status(200).json({
        success: true,
        serverTime: now,
        order: { ...order, ...describeOrder(order, now) }
      });
    }

    /* ----- GET: all orders ----- */
    let orders = await readOrders(db, uid);

    try {
      const changed = await syncPendingOrders(db, orders);
      if (changed) orders = await readOrders(db, uid);
    } catch (error) {
      console.warn("Pending order sync skipped:", error.message);
    }

    try {
      await addItemImages(db, orders);
    } catch (error) {
      console.warn("Item images skipped:", error.message);
    }

    // Har order ka apna alag status + tracking
    const now = Date.now();
    orders = orders.map(order => ({ ...order, ...describeOrder(order, now) }));

    return res.status(200).json({
      success: true,
      total: orders.length,
      serverTime: now,
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
