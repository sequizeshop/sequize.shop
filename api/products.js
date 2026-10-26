const crypto = require("crypto");
const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;

function isValidProductId(id) {
  return typeof id === "string" && PRODUCT_ID_PATTERN.test(id);
}

function generateProductId() {
  return crypto.randomBytes(20).toString("hex");
}

function initializeFirebase() {
  if (admin.apps.length) return admin.database();

  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");

  const account = JSON.parse(raw);

  if (account.private_key) {
    account.private_key = account.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(account),
    databaseURL: DATABASE_URL
  });

  return admin.database();
}

function mapProduct(product, customId, INR_RATE) {
  const originalPrice = Number(
    (Number(product.price || 0) * INR_RATE).toFixed(2)
  );

  return {
    id: customId,
    title: product.title || "",
    description: product.description || "",
    price: Number((originalPrice * 0.4).toFixed(2)),
    originalPrice,
    originalPriceUSD: Number(product.price || 0),
    discountPercentage: 60,
    rating: Number(product.rating || 0),
    category: product.category || "other",
    brand: product.brand || "",
    sku: product.sku || "",
    thumbnail: product.thumbnail || "",
    images: Array.isArray(product.images) ? product.images : [],
    tags: Array.isArray(product.tags) ? product.tags : [],
    availabilityStatus: product.availabilityStatus || "",
    stock: Number(product.stock || 0)
  };
}

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=60, stale-while-revalidate=300"
  );

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const INR_RATE = 85;
    const search = String(req.query.search || "").trim().toLowerCase();
    const category = String(req.query.category || "").trim().toLowerCase();

    const db = initializeFirebase();
    const sourceMapRef = db.ref("productSourceMap");
    const productsRef = db.ref("products");

    const response = await fetch(
      "https://dummyjson.com/products?limit=0"
    );

    if (!response.ok) {
      throw new Error("Product provider is unavailable.");
    }

    const result = await response.json();
    const sourceProducts = Array.isArray(result.products)
      ? result.products
      : [];

    const mapSnapshot = await sourceMapRef.once("value");
    const existingMappings = mapSnapshot.val() || {};

    const productUpdates = {};
    const mappedProducts = [];

    await Promise.all(sourceProducts.map(async product => {
      const sourceId = String(product.id || "");

      if (!sourceId || !/^\d+$/.test(sourceId)) return;

      let customId = existingMappings[sourceId];

      if (!isValidProductId(customId)) {
        const candidateId = generateProductId();

        const transaction = await sourceMapRef
          .child(sourceId)
          .transaction(currentValue =>
            isValidProductId(currentValue)
              ? currentValue
              : candidateId
          );

        customId = transaction.snapshot.val();
      }

      if (!isValidProductId(customId)) {
        throw new Error(`Invalid product ID for ${sourceId}`);
      }

      const mappedProduct = mapProduct(
        product,
        customId,
        INR_RATE
      );

      // Database mein original price store hogi.
      // API response mein discounted price return hogi.
      productUpdates[customId] = {
        ...mappedProduct,
        price: mappedProduct.originalPrice,
        sourceId
      };

      mappedProducts.push(mappedProduct);
    }));

    if (Object.keys(productUpdates).length) {
      await productsRef.update(productUpdates);
    }

    let products = mappedProducts;

    if (search) {
      products = products.filter(product => {
        const searchable = [
          product.title,
          product.description,
          product.category,
          product.brand,
          ...(product.tags || [])
        ].join(" ").toLowerCase();

        return searchable.includes(search);
      });
    }

    if (category) {
      products = products.filter(
        product =>
          String(product.category || "").toLowerCase() === category
      );
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
