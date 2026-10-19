
const admin = require("firebase-admin");
const { getSession } = require("../lib/auth");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const USD_TO_INR = 85;

/* FIREBASE INITIALIZATION */

function getDatabase() {
  if (!admin.apps.length) {
    const serviceAccountText = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(serviceAccountText)
      ),
      databaseURL: DATABASE_URL
    });
  }

  return admin.database();
}

/* HELPERS */

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

function isValidProductId(id) {
  return (
    typeof id === "string" &&
    PRODUCT_ID_PATTERN.test(id)
  );
}

function getRequestBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  return {};
}

/* VERIFY PRODUCT FROM FIREBASE */

async function getVerifiedProduct(db, id) {
  if (!isValidProductId(id)) {
    return null;
  }

  const snapshot = await db
    .ref("products")
    .child(id)
    .once("value");

  if (!snapshot.exists()) {
    return null;
  }

  const product = snapshot.val();

  if (
    !product ||
    typeof product !== "object" ||
    !String(product.title || "").trim()
  ) {
    return null;
  }

  const priceINR = Number(product.price);

  if (!Number.isFinite(priceINR) || priceINR < 0) {
    return null;
  }

  const originalPriceUSD = Number(product.originalPriceUSD);

  const images = Array.isArray(product.images)
    ? product.images
    : [];

  return {
    id,
    title: String(product.title).trim().slice(0, 200),
    description: String(product.description || "").slice(0, 2000),
    price: priceINR,
    originalPriceUSD:
      Number.isFinite(originalPriceUSD) && originalPriceUSD >= 0
        ? originalPriceUSD
        : Number((priceINR / USD_TO_INR).toFixed(2)),
    thumbnail: String(
      product.thumbnail || images[0] || ""
    ).slice(0, 2000),
    category: String(product.category || "").slice(0, 100),
    rating: Number(product.rating) || 0,
    stock: Math.max(0, Number(product.stock) || 0)
  };
}

/* FORMAT WISHLIST */

function formatWishlist(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value)
    .filter(([id, item]) => (
      isValidProductId(id) &&
      item &&
      typeof item === "object" &&
      item.id === id
    ))
    .map(([id, item]) => ({
      id,
      title: String(item.title || "Product"),
      description: String(item.description || ""),
      price: Number(item.price) || 0,
      originalPriceUSD: Number(item.originalPriceUSD) || 0,
      thumbnail: String(item.thumbnail || ""),
      category: String(item.category || ""),
      rating: Number(item.rating) || 0,
      stock: Number(item.stock) || 0,
      addedAt: Number(item.addedAt) || 0
    }))
    .sort((a, b) => b.addedAt - a.addedAt);
}

/* WISHLIST API */

module.exports = async function handler(req, res) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader("Cache-Control", "private, no-store");

  if (!["GET", "POST", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, DELETE");

    return sendError(res, 405, "Method allowed nahi hai.");
  }

  try {
    /* AUTHENTICATION */

    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(
        res,
        401,
        "Wishlist use karne ke liye pehle login karein."
      );
    }

    const db = getDatabase();

    const wishlistRef = db
      .ref("users")
      .child(String(session.uid))
      .child("wishlist")
      .child("items");

    /* GET: LOAD WISHLIST FROM FIREBASE */

    if (req.method === "GET") {
      const snapshot = await wishlistRef.once("value");
      const items = formatWishlist(snapshot.val());

      return res.status(200).json({
        success: true,
        total: items.length,
        items
      });
    }

    const body = getRequestBody(req);

    /* DELETE: CLEAR OR REMOVE ONE ITEM */

    if (req.method === "DELETE") {
      if (body.clear === true) {
        await wishlistRef.remove();

        return res.status(200).json({
          success: true,
          message: "Wishlist clear ho gayi.",
          total: 0,
          items: []
        });
      }

      const id = String(body.id || "");

      if (!isValidProductId(id)) {
        return sendError(res, 400, "Product ID valid nahi hai.");
      }

      const itemRef = wishlistRef.child(id);

      await itemRef.remove();

      const snapshot = await wishlistRef.once("value");
      const items = formatWishlist(snapshot.val());

      return res.status(200).json({
        success: true,
        message: "Product wishlist se remove ho gaya.",
        total: items.length,
        items
      });
    }

    /* POST: ADD VERIFIED PRODUCT */

    if (req.method === "POST") {
      const id = String(body.id || "");

      if (!isValidProductId(id)) {
        return sendError(res, 400, "Product ID valid nahi hai.");
      }

      const product = await getVerifiedProduct(db, id);

      if (!product) {
        return sendError(
          res,
          404,
          "Product nahi mila ya product ID invalid hai."
        );
      }

      const itemRef = wishlistRef.child(id);

      /*
       * Transaction prevents simultaneous requests from creating
       * duplicate or overwriting an existing wishlist entry.
       */
      const transaction = await itemRef.transaction(current => {
        if (current !== null) {
          return;
        }

        return {
          ...product,
          addedAt: Date.now()
        };
      });

      const snapshot = await wishlistRef.once("value");
      const items = formatWishlist(snapshot.val());

      return res.status(200).json({
        success: true,
        message: transaction.committed
          ? "Product wishlist mein add ho gaya."
          : "Product pehle se wishlist mein hai.",
        alreadyExists: !transaction.committed,
        total: items.length,
        items
      });
    }
  } catch (error) {
    console.error("Wishlist API error:", error);

    return sendError(
      res,
      500,
      "Wishlist update nahi ho payi. Dobara try karein."
    );
  }
};
