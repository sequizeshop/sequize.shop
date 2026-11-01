"use strict";

// Public product JSON API + server-rendered SEO product page.
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
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  if (parsed.protocol !== "https:") return "";
  const secret = process.env.IMAGE_PROXY_SECRET;
  if (!secret) throw new Error("IMAGE_PROXY_SECRET environment variable is missing.");
  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.createHmac("sha256", key).update(url).digest().subarray(0, 12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(url, "utf8"), cipher.final()]);
  const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  return IMAGE_PROXY_PATH + token + ".jpg";
}

function initializeFirebase() {
  if (admin.apps.length) return admin.database();
  const value = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!value) throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  let account;
  try { account = JSON.parse(value); }
  catch { throw new Error("FIREBASE_SERVICE_ACCOUNT must contain valid JSON."); }
  if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
  admin.initializeApp({ credential: admin.credential.cert(account), databaseURL: DATABASE_URL });
  return admin.database();
}

function validNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function publicSpecs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output = {};
  for (const [key, val] of Object.entries(value)) {
    const label = String(key).trim();
    if (!label || val == null || typeof val === "object") continue;
    const text = String(val).trim();
    if (text) output[label] = text;
  }
  return output;
}

function toPublic(product, id) {
  const price = Math.max(0, validNumber(product.price, 0));
  const images = Array.isArray(product.images) ? product.images.filter(Boolean).map(proxyImage) : [];
  const stock = Math.max(0, validNumber(product.stock, 0));
  return {
    id,
    title: product.title || "",
    description: product.description || "",
    price,
    originalPrice: price,
    originalPriceUSD: Math.max(0, validNumber(product.originalPriceUSD, price / INR_RATE)),
    discountPercentage: 0,
    rating: validNumber(product.rating, 0),
    category: product.category || "other",
    brand: product.brand || "",
    sku: product.sku || "",
    thumbnail: proxyImage(product.thumbnail) || images[0] || "",
    images,
    tags: Array.isArray(product.tags) ? product.tags : [],
    availabilityStatus: product.availabilityStatus || (stock > 0 ? "In Stock" : "Out of Stock"),
    stock,
    weight: product.weight == null ? null : validNumber(product.weight, 0),
    dimensions: product.dimensions || null,
    warrantyInformation: product.warrantyInformation || "",
    shippingInformation: product.shippingInformation || "",
    returnPolicy: product.returnPolicy || "",
    minimumOrderQuantity: Math.max(1, validNumber(product.minimumOrderQuantity, 1)),
    specifications: publicSpecs(product.specifications),
    reviews: Array.isArray(product.reviews) ? product.reviews : [],
    createdAt: validNumber(product.createdAt, 0)
  };
}

async function findProduct(db, rawId) {
  let id = String(rawId || "").trim();
  if (/^\d+$/.test(id)) {
    const mapped = (await db.ref("productSourceMap").child(id).once("value")).val();
    if (typeof mapped === "string") id = mapped;
  }
  if (!PRODUCT_ID_PATTERN.test(id)) return null;
  const [snapshot, removed] = await Promise.all([
    db.ref("products").child(id).once("value"),
    db.ref("removedProducts").child(id).once("value")
  ]);
  const data = snapshot.val();
  if (!data || typeof data !== "object" || removed.val()) return null;
  return { id, product: toPublic(data, id) };
}

const esc = value => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

// Updates an existing meta/link tag by id regardless of attribute order.
function setMeta(html, id, value, attribute = "content") {
  const safeId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tagPattern = new RegExp(`<(?:(?:meta|link))\\b(?=[^>]*\\bid=["']${safeId}["'])[^>]*>`, "i");
  return html.replace(tagPattern, tag => {
    const attrPattern = new RegExp(`\\b${attribute}\\s*=\\s*(["'])[^"']*\\1`, "i");
    const replacement = `${attribute}="${esc(value)}"`;
    if (attrPattern.test(tag)) return tag.replace(attrPattern, replacement);
    return tag.replace(/>$/, ` ${replacement}>`);
  });
}

function makeSchema(product, id, image, canonical) {
  const inStock = Number(product.stock) > 0 && String(product.availabilityStatus || "").toLowerCase() !== "out of stock";
  const schema = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: String(product.title || "Product"),
    description: String(product.description || `Explore ${product.title || "this product"} on Sequize.`).slice(0, 5000),
    sku: String(product.sku || id),
    category: String(product.category || "Products"),
    image: [image],
    offers: {
      "@type": "Offer",
      url: canonical,
      priceCurrency: "INR",
      price: Math.max(0, validNumber(product.price, 0)).toFixed(2),
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition"
    }
  };
  if (product.brand) schema.brand = { "@type": "Brand", name: String(product.brand) };
  return schema;
}

function getRequestQuery(req) {
  const parsed = new URL(req.url || "/", SITE_URL);
  return {
    id: (req.query && (req.query.id || req.query.productId || req.query.pid)) || parsed.searchParams.get("id") || parsed.searchParams.get("productId") || parsed.searchParams.get("pid") || "",
    page: (req.query && req.query.page) || parsed.searchParams.get("page") || ""
  };
}

async function sendProductPage(req, res, db, rawId) {
  if (!String(rawId || "").trim()) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    return res.status(400).send("Product id is required.");
  }

  const found = await findProduct(db, rawId);
  if (!found) {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cache-Control", "no-store");
    return res.status(404).send("Product not found.");
  }

  const templateResponse = await fetch(`${SITE_URL}/product-template.html`, { redirect: "follow" });
  if (!templateResponse.ok) throw new Error(`product-template.html unavailable (HTTP ${templateResponse.status})`);
  let html = await templateResponse.text();
  const product = found.product;
  const title = `${product.title || "Product"} | Buy Online at Sequize`;
  const description = String(product.description || `Buy ${product.title} online at Sequize.`)
    .replace(/\s+/g, " ").trim().slice(0, 300);
  const canonical = `${SITE_URL}/product?id=${encodeURIComponent(found.id)}`;
  let image = product.thumbnail || (product.images && product.images[0]) || DEFAULT_IMAGE;
  if (image.startsWith("/")) image = SITE_URL + image;

  html = html.replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(title)}</title>`);
  html = setMeta(html, "metaDescription", description);
  html = setMeta(html, "canonicalUrl", canonical, "href");
  html = setMeta(html, "ogTitle", title);
  html = setMeta(html, "ogDescription", description);
  html = setMeta(html, "ogUrl", canonical);
  html = setMeta(html, "ogImage", image);
  html = setMeta(html, "ogImageAlt", product.title);
  html = setMeta(html, "twitterTitle", title);
  html = setMeta(html, "twitterDescription", description);
  html = setMeta(html, "twitterImage", image);
  html = html.replace(/<meta property="og:image:(?:width|height)"[^>]*>\s*/gi, "");

  // Remove any template-level Product schema before inserting this product's unique schema.
  html = html.replace(/<script\b[^>]*id=["']product-jsonld["'][^>]*>[\s\S]*?<\/script>/gi, "");
  const jsonLd = `<script id="product-jsonld" type="application/ld+json">${JSON.stringify(makeSchema(product, found.id, image, canonical)).replace(/</g, "\\u003c")}</script>`;
  html = html.replace(/<\/head>/i, `${jsonLd}\n</head>`);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("X-Robots-Tag", "index, follow");
  res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=300");
  return res.status(200).send(html);
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ success: false, message: "Method not allowed." });
  }

  try {
    const query = getRequestQuery(req);
    const db = initializeFirebase();
    if (String(query.page) === "1") return await sendProductPage(req, res, db, query.id);
    if (!String(query.id || "").trim()) {
      return res.status(400).json({ success: false, message: "Product id is required." });
    }
    const found = await findProduct(db, query.id);
    if (!found) return res.status(404).json({ success: false, message: "Product not found." });
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
    return res.status(200).json({ success: true, product: found.product, ...found.product });
  } catch (error) {
    console.error("Product API error:", error);
    return res.status(502).json({ success: false, message: "Product load nahi ho paya. Dobara try karein." });
  }
};
