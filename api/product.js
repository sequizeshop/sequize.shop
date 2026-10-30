// api/product.js
// Single product details. Reads ONLY from Firebase products/{id}.
// Works for admin-added products and for imported DummyJSON products.
//
// GET /api/product?id=<40-char id>   (productId= also accepted)
// A numeric DummyJSON id is also accepted and resolved through productSourceMap.

const crypto = require("crypto"); // NEW
const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const INR_RATE = 85;

// NEW: image proxy settings

// NEW: original image URL -> encrypted proxy URL (domain hidden)
// Images are served from our own domain: /img/<token>.jpg
// (vercel.json rewrites /img/* to the image-proxy project)
const IMAGE_PROXY_PATH = "/img/";
const OLD_PROXY_PREFIX = "https://apisequizeshoplite.vercel.app/api/image/";

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

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  try {
    let id = String(
      (req.query && (req.query.id || req.query.productId || req.query.pid)) || ""
    ).trim();

    if (!id) {
      return res.status(400).json({ success: false, message: "Product id is required." });
    }

    const db = initializeFirebase();

    // Numeric DummyJSON id -> custom id through productSourceMap
    if (/^\d+$/.test(id)) {
      const mapped = (await db.ref("productSourceMap").child(id).once("value")).val();
      if (typeof mapped === "string") id = mapped;
    }

    if (!PRODUCT_ID_PATTERN.test(id)) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const [snap, removedSnap] = await Promise.all([
      db.ref("products").child(id).once("value"),
      db.ref("removedProducts").child(id).once("value")
    ]);

    const data = snap.val();
    if (!data || typeof data !== "object" || removedSnap.val()) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    const product = toPublic(data, id);

    // Cache only successful responses (never cache a 404)
    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");

    // `product` for wrapped responses, top-level fields for flat ones
    return res.status(200).json({ success: true, product, ...product });
  } catch (error) {
    console.error("Product API error:", error);
    return res.status(502).json({
      success: false,
      message: "Product load nahi ho paya. Dobara try karein."
    });
  }
};
