// api/products.js
const crypto = require("crypto");
const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const INR_RATE = 85;

function isValidProductId(id) {
  return typeof id === "string" && PRODUCT_ID_PATTERN.test(id);
}

function generateProductId() {
  return crypto.randomBytes(20).toString("hex");
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

/* DummyJSON product -> first-time record saved in Firebase */
function mapProduct(product, customId) {
  const originalPriceUSD = Math.max(0, validNumber(product.price, 0));
  const price = Number((originalPriceUSD * INR_RATE).toFixed(2));

  return {
    id: customId,
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
    stock: Math.max(0, validNumber(product.stock, 0))
  };
}

/* Any Firebase record (synced or admin-added) -> public catalog format */
function toPublic(p, id) {
  const price = Math.max(0, validNumber(p.price, 0));
  const images = Array.isArray(p.images) ? p.images.filter(Boolean) : [];
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
    thumbnail: p.thumbnail || images[0] || "",
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
    const sourceMapRef = db.ref("productSourceMap");
    const productsRef = db.ref("products");

    const [prodSnap, mapSnap, removedSnap] = await Promise.all([
      productsRef.once("value"),
      sourceMapRef.once("value"),
      db.ref("removedProducts").once("value")
    ]);

    const stored = prodSnap.val() || {};
    const mappings = mapSnap.val() || {};
    const removed = removedSnap.val() || {};

    // DummyJSON is only used to seed missing products. If it fails, we still serve Firebase.
    let sourceProducts = [];
    try {
      const response = await fetch("https://dummyjson.com/products?limit=0");
      if (response.ok) {
        const result = await response.json();
        sourceProducts = Array.isArray(result.products) ? result.products : [];
      }
    } catch (err) {
      console.error("DummyJSON unavailable:", err);
    }

    const updates = {};

    await Promise.all(
      sourceProducts.map(async product => {
        const sourceId = String(product.id || "");
        if (!/^\d+$/.test(sourceId)) return;

        let customId = mappings[sourceId];

        if (!isValidProductId(customId)) {
          const candidateId = generateProductId();
          const tx = await sourceMapRef.child(sourceId).transaction(cur =>
            isValidProductId(cur) ? cur : candidateId
          );
          customId = tx.snapshot ? tx.snapshot.val() : null;
        }

        if (!isValidProductId(customId)) {
          throw new Error(`Could not create a valid ID for source product ${sourceId}.`);
        }

        if (removed[customId]) return;           // admin deleted it
        if (stored[customId]) return;            // keep admin edits, do not overwrite

        const record = { ...mapProduct(product, customId), sourceId };
        updates[customId] = record;
        stored[customId] = record;
      })
    );

    if (Object.keys(updates).length > 0) {
      await productsRef.update(updates);
    }

    // Everything in Firebase (synced + admin-added), newest admin products first
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
