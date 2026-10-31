// api/orders.js
//
// My Orders API.
//  - Reads the logged-in user's orders from Firebase.
//  - Verifies recent pending payments with Cashfree.
//  - NEW: every order item gets a working `thumbnail` (our own /img/ proxy URL),
//    taken from the item itself or, if missing, from products/<productId>.

const crypto = require("crypto");
const { getSession } = require("../lib/auth");
const { getDatabase, syncPayment } = require("../lib/cashfree");

const SYNC_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // sirf pichhle 7 din ke pending orders
const MAX_SYNC = 5;

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
