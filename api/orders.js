// api/orders.js
//
// My Orders API. Poora order system yahin hai:
//  - Logged-in user ke orders Firebase se padhta hai.
//  - Recent pending payments ko Cashfree se verify karta hai.
//  - Har item ko working `thumbnail` deta hai (/img/ proxy URL).
//  - Har order ke liye alag status label + delivery tracking banata hai:
//      paymentLabel / paymentTone -> price ke baju ka tag: Paid / Not paid ...
//      statusLabel / statusTone   -> Waiting to confirm / Confirmed / Delivered
//      canContinuePayment         -> "Continue to payment" button dikhana hai ya nahi
//      tracking                   -> timeline: 10-20 min mein confirm, phir 3 din mein delivery

const crypto = require("crypto");
const { getSession } = require("../lib/auth");
const { getDatabase, syncPayment } = require("../lib/cashfree");

const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // sirf pichhle 7 din ke pending orders
const MAX_SYNC = 5;

/* ---------- Status rules ---------- */

const PAID_PAYMENT = ["PAID", "SUCCESS", "SUCCESSFUL", "COMPLETED", "CAPTURED"];
const FAILED = ["FAILED", "EXPIRED", "USER_DROPPED"];
const CANCELLED = ["CANCELLED", "CANCELED"];
const REFUNDED = ["REFUNDED"];
const DELIVERED_ORDER = ["DELIVERED", "COMPLETED"];

/*
 * Har order ki apni timeline (order ke time se shuru):
 *   Order placed -> Confirmed : 10 se 20 minute (har order ka apna fixed time)
 *   Confirmed -> Delivered    : 3 din (Shipped beech mein)
 * Confirm hone ka time sirf time se chalta hai, orderStatus se nahi.
 */
const CONFIRM_MIN_MS = 10 * 60 * 1000;
const CONFIRM_SPAN_MS = 10 * 60 * 1000;
const DELIVERY_MS = 3 * 24 * 60 * 60 * 1000;

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

// Same order = hamesha same time (10 se 20 minute ke beech)
function confirmDelay(orderId) {
  const n = crypto
    .createHash("md5")
    .update(String(orderId))
    .digest()
    .readUInt32BE(0);

  return CONFIRM_MIN_MS + (n % (CONFIRM_SPAN_MS + 1));
}

/*
 * Ek order ka payment tag, status tag aur tracking.
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

  // Status tag (Waiting to confirm / Confirmed / Delivered) + tracking
  let statusLabel = "";
  let statusTone = "";
  let tracking = null;

  if (!cancelled && !failed && !refunded) {
    // Timeline payment hone ke time se chalti hai (paidAt na ho to order ke time se)
    const startAt = (paid && toMs(order.paidAt)) || toMs(order.createdAt);

    if (startAt) {
      const confirmAt = startAt + confirmDelay(order.orderId);
      const shipAt = confirmAt + Math.round(DELIVERY_MS / 2);
      const endAt = confirmAt + DELIVERY_MS;

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
  }

  return {
    paymentLabel,
    paymentTone,
    statusLabel,
    statusTone,
    canContinuePayment,
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
