// api/product.js
// 1) GET /api/product?id=<40-char id>          -> JSON (public, login NOT required)
// 2) GET /api/product?id=<id>&page=1           -> product.html with product meta tags
//    (vercel.json rewrites /product.html to this, so social apps / crawlers
//     see the real product image, title and description when a link is shared)

const crypto = require("crypto");
const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const INR_RATE = 85;
const DEFAULT_IMAGE = "https://i.ibb.co/93kQCKxT/20261019-120246.png";

const IMAGE_PROXY_PATH = "/img/";
const OLD_PROXY_PREFIX = "https://apisequizeshoplite-two.vercel.app/api/image";

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

function publicSpecs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  Object.keys(value).forEach(k => {
    const label = String(k).trim();
    const val = value[k];
    if (!label || val == null || typeof val === "object") return;
    const text = String(val).trim();
    if (text) out[label] = text;
  });
  return out;
}

function toPublic(p, id) {
  const price = Math.max(0, validNumber(p.price, 0));
  const images = Array.isArray(p.images) ? p.images.filter(Boolean).map(proxyImage) : [];
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
    thumbnail: proxyImage(p.thumbnail) || images[0] || "",
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
    specifications: publicSpecs(p.specifications),
    reviews: Array.isArray(p.reviews) ? p.reviews : [],
    createdAt: validNumber(p.createdAt, 0)
  };
}

/* Returns { id, product } or null when not found. */
async function findProduct(db, rawId) {
  let id = String(rawId || "").trim();

  if (/^\d+$/.test(id)) {
    const mapped = (await db.ref("productSourceMap").child(id).once("value")).val();
    if (typeof mapped === "string") id = mapped;
  }
  if (!PRODUCT_ID_PATTERN.test(id)) return null;

  const [snap, removedSnap] = await Promise.all([
    db.ref("products").child(id).once("value"),
    db.ref("removedProducts").child(id).once("value")
  ]);

  const data = snap.val();
  if (!data || typeof data !== "object" || removedSnap.val()) return null;
  return { id, product: toPublic(data, id) };
}

/* ---------- Share preview (meta tags) ---------- */

const esc = s =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function setMeta(html, id, value) {
  return html.replace(
    new RegExp('(<(?:meta|link)\\b[^>]*\\bid="' + id + '"[^>]*\\b(?:content|href)=")[^"]*(")'),
    (_, a, b) => a + esc(value) + b
  );
}

function getOrigin(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${host}`;
}

async function sendProductPage(req, res, db) {
  const origin = getOrigin(req);

  // The real page lives in /product-template.html (a static file).
  // /product.html itself has no file, so vercel.json can rewrite it to this API.
  const pageRes = await fetch(`${origin}/product-template.html`);
  if (!pageRes.ok) throw new Error("product-template.html not found (HTTP " + pageRes.status + ")");
  let html = await pageRes.text();

  try {
    const found = await findProduct(db, req.query.id);

    if (found) {
      const p = found.product;
      const title = `${p.title} — Sequize`;
      const description =
        String(p.description || `Explore ${p.title} on Sequize.`)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 200);

      let image = p.thumbnail || (p.images && p.images[0]) || "";
      if (image.startsWith("/")) image = origin + image;
      if (!image) image = DEFAULT_IMAGE;

      const url = `${origin}/product.html?id=${encodeURIComponent(found.id)}`;

      html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
      html = setMeta(html, "metaDescription", description);
      html = setMeta(html, "canonicalUrl", url);
      html = setMeta(html, "ogTitle", title);
      html = setMeta(html, "ogDescription", description);
      html = setMeta(html, "ogUrl", url);
      html = setMeta(html, "ogImage", image);
      html = setMeta(html, "ogImageAlt", p.title);
      html = setMeta(html, "twitterTitle", title);
      html = setMeta(html, "twitterDescription", description);
      html = setMeta(html, "twitterImage", image);

      // product images are not 1200x630, so remove the fixed size
      html = html.replace(/<meta property="og:image:(?:width|height)"[^>]*>\s*/g, "");
    }
  } catch (error) {
    console.error("Product meta error:", error);
    // normal product.html is still sent
  }

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return res.status(200).send(html);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  try {
    const rawId =
      (req.query && (req.query.id || req.query.productId || req.query.pid)) || "";

    const db = initializeFirebase();

    // Share-preview mode (called through the /product.html rewrite)
    if (String(req.query.page || "") === "1") {
      return await sendProductPage(req, res, db);
    }

    if (!String(rawId).trim()) {
      return res.status(400).json({ success: false, message: "Product id is required." });
    }

    // No login check here: guests can view product details.
    const found = await findProduct(db, rawId);
    if (!found) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({ success: true, product: found.product, ...found.product });
  } catch (error) {
    console.error("Product API error:", error);
    return res.status(502).json({
      success: false,
      message: "Product load nahi ho paya. Dobara try karein."
    });
  }
};
