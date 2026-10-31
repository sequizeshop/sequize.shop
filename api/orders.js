// api/orders.js
//
// My Orders API. Poora order system yahin hai:
//  - Logged-in user ke orders Firebase se padhta hai.
//  - Recent pending payments ko Cashfree se verify karta hai.
//  - Har item ko working `thumbnail` deta hai (/img/ proxy URL).
//  - Har order ke liye alag status label + delivery tracking banata hai:
//      statusLabel / statusTone   -> "Paid and confirmed" etc.
//      canContinuePayment         -> "Continue to payment" button dikhana hai ya nahi
//      tracking                   -> 5 din ki delivery progress (order ke apne time se)

const crypto = require("crypto");
const { getSession } = require("../lib/auth");
const { getDatabase, syncPayment } = require("../lib/cashfree");

const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // sirf pichhle 7 din ke pending orders
const MAX_SYNC = 5;

const DELIVERY_DAYS = 5;
const DELIVERY_MS = DELIVERY_DAYS * 24 * 60 * 60 * 1000;

/* ---------- Status rules ---------- */

const PAID_PAYMENT = ["PAID", "SUCCESS", "SUCCESSFUL", "COMPLETED", "CAPTURED"];
const FAILED = ["FAILED", "EXPIRED", "USER_DROPPED"];
const CANCELLED = ["CANCELLED", "CANCELED"];
const REFUNDED = ["REFUNDED"];

// orderStatus jinko "confirmed" maana jaata hai
const CONFIRMED_ORDER = [
  "CONFIRMED", "PROCESSING", "PACKED", "SHIPPED",
  "OUT_FOR_DELIVERY", "DELIVERED", "COMPLETED"
];
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
 * Ek order ka label, tone aur tracking.
 * Tone: "paid" (green) | "warn" (amber) | "failed" (red) | "" (grey)
 */
function describeOrder(order) {
  const pay = norm(order.paymentStatus || "PENDING");
  const ord = norm(order.orderStatus || "PENDING");

  const paid = PAID_PAYMENT.includes(pay);
  const cancelled = CANCELLED.includes(pay) || CANCELLED.includes(ord);
  const refunded = REFUNDED.includes(pay) || REFUNDED.includes(ord);
  const failed = !paid && (FAILED.includes(pay) || FAILED.includes(ord));
  const confirmed = CONFIRMED_ORDER.includes(ord);
  const delivered = DELIVERED_ORDER.includes(ord);

  let statusLabel;
  let statusTone;

  if (refunded) {
    statusLabel = "Refunded";
    statusTone = "";
  } else if (cancelled) {
    statusLabel = "Cancelled";
    statusTone = "failed";
  } else if (failed) {
    statusLabel = "Payment failed";
    statusTone = "failed";
  } else if (paid && confirmed) {
    statusLabel = "Paid and confirmed";
    statusTone = "paid";
  } else if (paid) {
    statusLabel = "Paid and not confirmed";
    statusTone = "warn";
  } else {
    statusLabel = "Not paid";
    statusTone = "";
  }

  const canContinuePayment =
    pay === "PENDING" && !cancelled && !failed && !refunded && !delivered;

  // Delivery tracking: cancelled / failed / refunded orders ke liye nahi
  let tracking = null;

  if (!cancelled && !failed && !refunded) {
    // Progress payment hone ke time se chalti hai (paidAt na ho to order ke time se)
    const startAt = (paid && toMs(order.paidAt)) || toMs(order.createdAt);

    if (startAt) {
      const active = paid && confirmed;

      tracking = {
        active,
        forceDelivered: active && delivered,
        startAt,
        endAt: startAt + DELIVERY_MS,
        note: active
          ? ""
          : paid
            ? "Waiting for order confirmation."
            : "Delivery starts after payment is confirmed."
      };
    }
  }

  return { statusLabel, statusTone, canContinuePayment, tracking };
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
    orders = orders.map(order => ({ ...order, ...describeOrder(order) }));

    return res.status(200).json({
      success: true,
      total: orders.length,
      serverTime: Date.now(),
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
