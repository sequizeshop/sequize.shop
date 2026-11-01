// Public product JSON API and server-rendered SEO product page.
const crypto = require("node:crypto");
const admin = require("firebase-admin");
const DATABASE_URL = "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";
const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const INR_RATE = 85;
const DEFAULT_IMAGE = "https://i.ibb.co/93kQCKxT/20261019-120246.png";
const IMAGE_PROXY_PATH = "/img/";
const OLD_PROXY_PREFIX = "https://apisequizeshoplite-two.vercel.app/api/image";
const SITE_URL = "https://www.sequize.shop";

function proxyImage(url) {
  if (typeof url !== "string" || !url) return "";
  if (url.startsWith(IMAGE_PROXY_PATH) || url.startsWith(OLD_PROXY_PREFIX)) return url;
  let parsed; try { parsed = new URL(url); } catch { return url; }
  if (parsed.protocol !== "https:") return "";
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
  let account; try { account = JSON.parse(value); } catch { throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid JSON."); }
  if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(account), databaseURL: DATABASE_URL });
  return admin.database();
}
function validNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function publicSpecs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    const label = String(key).trim(); if (!label || val == null || typeof val === "object") continue;
    const text = String(val).trim(); if (text) out[label] = text;
  }
  return out;
}
function toPublic(p, id) {
  const price = Math.max(0, validNumber(p.price, 0));
  const images = Array.isArray(p.images) ? p.images.filter(Boolean).map(proxyImage) : [];
  const stock = Math.max(0, validNumber(p.stock, 0));
  return {
    id, title: p.title || "", description: p.description || "", price, originalPrice: price,
    originalPriceUSD: Math.max(0, validNumber(p.originalPriceUSD, price / INR_RATE)), discountPercentage: 0,
    rating: validNumber(p.rating, 0), category: p.category || "other", brand: p.brand || "", sku: p.sku || "",
    thumbnail: proxyImage(p.thumbnail) || images[0] || "", images, tags: Array.isArray(p.tags) ? p.tags : [],
    availabilityStatus: p.availabilityStatus || (stock > 0 ? "In Stock" : "Out of Stock"), stock,
    weight: p.weight == null ? null : validNumber(p.weight, 0), dimensions: p.dimensions || null,
    warrantyInformation: p.warrantyInformation || "", shippingInformation: p.shippingInformation || "",
    returnPolicy: p.returnPolicy || "", minimumOrderQuantity: Math.max(1, validNumber(p.minimumOrderQuantity, 1)),
    specifications: publicSpecs(p.specifications), reviews: Array.isArray(p.reviews) ? p.reviews : [],
    createdAt: validNumber(p.createdAt, 0)
  };
}
async function findProduct(db, rawId) {
  let id = String(rawId || "").trim();
  if (/^\\d+$/.test(id)) {
    const mapped = (await db.ref("productSourceMap").child(id).once("value")).val();
    if (typeof mapped === "string") id = mapped;
  }
  if (!PRODUCT_ID_PATTERN.test(id)) return null;
  const [snap, removed] = await Promise.all([
    db.ref("products").child(id).once("value"), db.ref("removedProducts").child(id).once("value")
  ]);
  const data = snap.val(); if (!data || typeof data !== "object" || removed.val()) return null;
  return { id, product: toPublic(data, id) };
}
const esc = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
function setMeta(html, id, value, attr = "content") {
  const safe = id;
  const re = new RegExp(`<((?:meta|link)\\b[^>]*\\bid="${safe}"[^>]*?)\\s${attr}="[^"]*"([^>]*>)`, "i");
  return html.replace(re, (_, before, after) => `<${before} ${attr}="${esc(value)}"${after}`);
}
function makeSchema(p, id, image, canonical) {
  const inStock = Number(p.stock) > 0 && String(p.availabilityStatus || "").toLowerCase() !== "out of stock";
  const schema = { "@context": "https://schema.org", "@type": "Product", name: String(p.title || "Product"),
    description: String(p.description || `Explore ${p.title || "this product"} on Sequize.`).slice(0, 5000),
    sku: String(p.sku || id), category: String(p.category || "Products"), image: [image],
    offers: { "@type": "Offer", url: canonical, priceCurrency: "INR", price: Math.max(0, validNumber(p.price, 0)).toFixed(2),
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", itemCondition: "https://schema.org/NewCondition" } };
  if (p.brand) schema.brand = { "@type": "Brand", name: String(p.brand) };
  return schema;
}
async function sendProductPage(req, res, db) {
  const response = await fetch(`${SITE_URL}/product-template.html`);
  if (!response.ok) throw new Error(`product-template.html unavailable (HTTP ${response.status})`);
  let html = await response.text();
  const rawId = (req.query && (req.query.id || req.query.productId || req.query.pid)) || "";
  const found = await findProduct(db, rawId);
  if (!found) {
    html = html.replace("</head>", '<meta name="robots" content="noindex, nofollow"></head>');
    res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("Cache-Control", "no-store");
    return res.status(404).send(html);
  }
  const p = found.product;
  const title = `${p.title || "Product"} | Buy Online at Sequize`;
  const description = String(p.description || `Buy ${p.title} online at Sequize.`).replace(/\s+/g, " ").trim().slice(0, 300);
  const canonical = `${SITE_URL}/product?id=${encodeURIComponent(found.id)}`;
  let image = p.thumbnail || (p.images && p.images[0]) || DEFAULT_IMAGE;
  if (image.startsWith("/")) image = SITE_URL + image;
  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = setMeta(html, "metaDescription", description);
  html = setMeta(html, "canonicalUrl", canonical, "href");
  html = setMeta(html, "ogTitle", title); html = setMeta(html, "ogDescription", description);
  html = setMeta(html, "ogUrl", canonical); html = setMeta(html, "ogImage", image);
  html = setMeta(html, "ogImageAlt", p.title); html = setMeta(html, "twitterTitle", title);
  html = setMeta(html, "twitterDescription", description); html = setMeta(html, "twitterImage", image);
  html = html.replace(/<meta property="og:image:(?:width|height)"[^>]*>\s*/gi, "");
  const jsonLd = `<script id="product-jsonld" type="application/ld+json">${JSON.stringify(makeSchema(p, found.id, image, canonical)).replace(/</g, "\\u003c")}</script>`;
  html = html.replace("</head>", `${jsonLd}\n</head>`);
  res.setHeader("Content-Type", "text/html; charset=utf-8"); res.setHeader("X-Robots-Tag", "index, follow");
  res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
  return res.status(200).send(html);
}
module.exports = async function handler(req, res) {
  if (req.method !== "GET") { res.setHeader("Allow", "GET"); return res.status(405).json({ success: false, message: "Method not allowed." }); }
  try {
    const db = initializeFirebase();
    if (String(req.query && req.query.page || "") === "1") return await sendProductPage(req, res, db);
    const id = (req.query && (req.query.id || req.query.productId || req.query.pid)) || "";
    if (!String(id).trim()) return res.status(400).json({ success: false, message: "Product id is required." });
    const found = await findProduct(db, id);
    if (!found) return res.status(404).json({ success: false, message: "Product not found." });
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({ success: true, product: found.product, ...found.product });
  } catch (error) {
    console.error("Product API error:", error);
    return res.status(502).json({ success: false, message: "Product load nahi ho paya. Dobara try karein." });
  }
};
