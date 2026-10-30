// api/products.js
//
// Home page products API.
//  - Products are ALWAYS loaded from Firebase (products/).
//  - DummyJSON is used only ONCE: the first time, every DummyJSON product is
//    saved into Firebase. After that, DummyJSON is never called again.
//  - Admin-added products live in the same products/ node, so they show up too.

const crypto = require("crypto");
const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const INR_RATE = 85;
const SEED_LOCK_PATH = "meta/dummyJsonSeedLock";
const SEED_DONE_PATH = "meta/dummyJsonSeeded";
const SEED_LOCK_TIMEOUT = 2 * 60 * 1000; // stale lock is ignored after 2 minutes

// NEW: image proxy settings
const IMAGE_PROXY_BASE = "https://apisequizeshoplite.vercel.app";

// NEW: original image URL -> encrypted proxy URL (domain hidden)
function proxyImage(url) {
  if (typeof url !== "string" || !url) return "";
  if (url.startsWith(IMAGE_PROXY_BASE)) return url; // already proxied
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

  return IMAGE_PROXY_BASE + "/api/image/" + token + ".jpg";
}

function isValidProductId(id) {
  return typeof id === "string" && PRODUCT_ID_PATTERN.test(id);
}

function generateProductId() {
  return crypto.randomBytes(20).toString("hex"); // 40 chars
}

function initializeFirebase() {
  if (admin.apps.length) return admin.database();

  const value = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!value) throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing.");

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(value);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid JSON.");
  }
  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });
  return admin.database();
}

function validNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/* DummyJSON product -> record saved in Firebase (one time) */
function mapDummyProduct(product, customId, now) {
  const originalPriceUSD = Math.max(0, validNumber(product.price, 0));
  const price = Number((originalPriceUSD * INR_RATE).toFixed(2));

  const record = {
    title: product.title || "",
    description: product.description || "",
    price,
    originalPrice: price,
    originalPriceUSD,
    discountPercentage: 0,
    rating: validNumber(product.rating, 0),
    category: product.category || "other",
    brand: product.brand || "",
    sku: product.sku || "",
    thumbnail: product.thumbnail || "",
    images: Array.isArray(product.images) ? product.images : [],
    tags: Array.isArray(product.tags) ? product.tags : [],
    availabilityStatus: product.availabilityStatus || "",
    stock: Math.max(0, validNumber(product.stock, 0)),
    weight: product.weight == null ? null : validNumber(product.weight, 0),
    dimensions: product.dimensions && typeof product.dimensions === "object" ? product.dimensions : null,
    warrantyInformation: product.warrantyInformation || "",
    shippingInformation: product.shippingInformation || "",
    returnPolicy: product.returnPolicy || "",
    minimumOrderQuantity: Math.max(1, validNumber(product.minimumOrderQuantity, 1)),
    reviews: Array.isArray(product.reviews) ? product.reviews : [],
    sourceId: String(product.id),
    createdAt: now,
    updatedAt: now
  };

  // Firebase does not accept undefined; null removes the key
  Object.keys(record).forEach(k => {
    if (record[k] === undefined) record[k] = null;
    if (Array.isArray(record[k]) && !record[k].length) record[k] = null;
  });
  return record;
}

/* Firebase record -> public catalog format */
function toPublic(p, id) {
  const price = Math.max(0, validNumber(p.price, 0));
  const images = Array.isArray(p.images) ? p.images.filter(Boolean).map(proxyImage) : []; // CHANGED
  const stock = Math.max(0, validNumber(p.stock, 0));

  return {
    id,
    title: p.title || "",
    description: p.description || "",
    price,
    originalPrice: price,
    originalPriceUSD: Math.max(0, validNumber(p.originalPriceUSD, price / INR_RATE)),
    discountPercentage: 0,
    rating: validNumber(p.rating, 0),
    category: p.category || "other",
    brand: p.brand || "",
    sku: p.sku || "",
    thumbnail: proxyImage(p.thumbnail) || images[0] || "", // CHANGED
    images,
    tags: Array.isArray(p.tags) ? p.tags : [],
    availabilityStatus: p.availabilityStatus || (stock > 0 ? "In Stock" : "Out of Stock"),
    stock,
    weight: p.weight == null ? null : validNumber(p.weight, 0),
    dimensions: p.dimensions || null,
    warrantyInformation: p.warrantyInformation || "",
    shippingInformation: p.shippingInformation || "",
    returnPolicy: p.returnPolicy || "",
    minimumOrderQuantity: Math.max(1, validNumber(p.minimumOrderQuantity, 1)),
    reviews: Array.isArray(p.reviews) ? p.reviews : [],
    createdAt: validNumber(p.createdAt, 0)
  };
}

/*
 * One-time import: save ALL DummyJSON products into Firebase.
 * Existing Firebase products (and products deleted by admin) are never overwritten.
 * Returns true if the seed finished (or was already done).
 */
async function seedFromDummyJson(db) {
  const doneSnap = await db.ref(SEED_DONE_PATH).once("value");
  if (doneSnap.val() === true) return;

  // Lock so two simultaneous requests do not seed twice
  const lock = await db.ref(SEED_LOCK_PATH).transaction(cur => {
    if (cur && Date.now() - Number(cur) < SEED_LOCK_TIMEOUT) return; // someone else is seeding
    return Date.now();
  });
  if (!lock.committed) return;

  try {
    const response = await fetch("https://dummyjson.com/products?limit=0");
    if (!response.ok) throw new Error("DummyJSON unavailable (HTTP " + response.status + ").");
    const result = await response.json();
    const sourceProducts = Array.isArray(result.products) ? result.products : [];
    if (!sourceProducts.length) throw new Error("DummyJSON returned no products.");

    const [prodSnap, mapSnap, removedSnap] = await Promise.all([
      db.ref("products").once("value"),
      db.ref("productSourceMap").once("value"),
      db.ref("removedProducts").once("value")
    ]);
    const stored = prodSnap.val() || {};
    const mappings = mapSnap.val() || {};
    const removed = removedSnap.val() || {};

    const updates = {};
    const now = Date.now();

    sourceProducts.forEach(product => {
      const sourceId = String(product.id || "");
      if (!/^\d+$/.test(sourceId)) return;

      let customId = mappings[sourceId];
      if (!isValidProductId(customId)) {
        customId = generateProductId();
        updates["productSourceMap/" + sourceId] = customId;
      }

      if (removed[customId]) return; // admin deleted it, keep it deleted
      if (stored[customId]) return;  // already in Firebase, keep admin edits

      updates["products/" + customId] = mapDummyProduct(product, customId, now);
    });

    if (Object.keys(updates).length) {
      await db.ref().update(updates);
    }
    await db.ref(SEED_DONE_PATH).set(true);
  } catch (err) {
    console.error("DummyJSON seed failed (will retry on a later request):", err);
  } finally {
    await db.ref(SEED_LOCK_PATH).remove().catch(() => {});
  }
}

module.exports = async function handler(req, res) {
  // Short cache so newly added products show up quickly
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const category = String(req.query.category || "").trim().toLowerCase();

    const db = initializeFirebase();

    // First time only: copy every DummyJSON product into Firebase
    await seedFromDummyJson(db);

    // From here on, products come ONLY from Firebase
    const [prodSnap, removedSnap] = await Promise.all([
      db.ref("products").once("value"),
      db.ref("removedProducts").once("value")
    ]);
    const stored = prodSnap.val() || {};
    const removed = removedSnap.val() || {};

    let products = Object.keys(stored)
      .filter(id => isValidProductId(id) && !removed[id] && stored[id] && typeof stored[id] === "object")
      .map(id => toPublic(stored[id], id))
      .sort((a, b) => b.createdAt - a.createdAt);

    if (search) {
      products = products.filter(p =>
        [p.title, p.description, p.category, p.brand, ...p.tags]
          .join(" ")
          .toLowerCase()
          .includes(search)
      );
    }

    if (category) {
      products = products.filter(p => String(p.category || "").toLowerCase() === category);
    }

    return res.status(200).json({
      success: true,
      total: products.length,
      currency: "INR",
      exchangeRate: INR_RATE,
      products
    });
  } catch (error) {
    console.error("Products API error:", error);
    return res.status(502).json({
      success: false,
      message: "Products load nahi ho paaye. Dobara try karein."
    });
  }
};
