
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

    const serviceAccount = JSON.parse(serviceAccountText);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
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
  return typeof id === "string" && PRODUCT_ID_PATTERN.test(id);
}

function normalizeQuantity(value) {
  const quantity = Math.floor(Number(value));

  if (!Number.isFinite(quantity)) {
    return 1;
  }

  return Math.max(1, Math.min(99, quantity));
}

/*
  Cart prices remain in USD because the existing cart.html
  converts prices to INR using the exchange rate of 85.

  Product records store price in INR and originalPriceUSD in USD.
*/

function getCartPrice(savedProduct) {
  const originalPriceUSD = Number(savedProduct.originalPriceUSD);

  if (
    savedProduct.originalPriceUSD !== undefined &&
    savedProduct.originalPriceUSD !== null &&
    Number.isFinite(originalPriceUSD) &&
    originalPriceUSD >= 0
  ) {
    return originalPriceUSD;
  }

  const priceINR = Number(savedProduct.price);

  if (Number.isFinite(priceINR) && priceINR >= 0) {
    return Number((priceINR / USD_TO_INR).toFixed(2));
  }

  throw new Error("Saved product has an invalid price.");
}

function normalizeSavedCartItem(id, item) {
  if (!item || !isValidProductId(id)) {
    return null;
  }

  const price = Number(item.price);

  if (!Number.isFinite(price) || price < 0) {
    return null;
  }

  return {
    id,
    title: String(item.title || "Product"),
    price,
    thumbnail: String(item.thumbnail || ""),
    category: String(item.category || ""),
    quantity: normalizeQuantity(item.quantity)
  };
}

function formatItems(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value)
    .map(([id, item]) => normalizeSavedCartItem(id, item))
    .filter(Boolean);
}

function calculateTotals(items) {
  return {
    totalQuantity: items.reduce(
      (sum, item) => sum + item.quantity,
      0
    ),
    totalPrice: Number(
      items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      ).toFixed(2)
    )
  };
}

/*
  Resolve the product from Firebase.
  Never trust product title, price, image or category from the browser.
*/

async function getVerifiedProduct(db, productId) {
  if (!isValidProductId(productId)) {
    return null;
  }

  const snapshot = await db.ref("products").child(productId).once("value");

  if (!snapshot.exists()) {
    return null;
  }

  const savedProduct = snapshot.val();

  if (
    !savedProduct ||
    typeof savedProduct !== "object" ||
    !String(savedProduct.title || "").trim()
  ) {
    return null;
  }

  const price = getCartPrice(savedProduct);

  return {
    id: productId,
    title: String(savedProduct.title).slice(0, 200),
    price,
    thumbnail: String(savedProduct.thumbnail || "").slice(0, 2000),
    category: String(savedProduct.category || "").slice(0, 100)
  };
}

/* CART API */

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");

  if (!["GET", "POST", "PATCH", "DELETE"].includes(req.method)) {
    res.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return sendError(res, 405, "Method allowed nahi hai.");
  }

  try {
    /*
      Authentication:
      Existing Shoppy session cookie is required.
    */

    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(
        res,
        401,
        "Cart use karne ke liye pehle login karein."
      );
    }

    const db = getDatabase();

    const cartRef = db
      .ref("users")
      .child(String(session.uid))
      .child("cart")
      .child("items");

    /* GET: LOAD USER CART */

    if (req.method === "GET") {
      const snapshot = await cartRef.once("value");
      const items = formatItems(snapshot.val());

      return res.status(200).json({
        success: true,
        items,
        ...calculateTotals(items)
      });
    }

    /* POST: VERIFY AND ADD PRODUCT */

    if (req.method === "POST") {
      const body = req.body || {};
      const productId = String(body.id || "");

      if (!isValidProductId(productId)) {
        return sendError(res, 400, "Product ID valid nahi hai.");
      }

      const quantityToAdd = normalizeQuantity(body.quantity);

      const verifiedProduct = await getVerifiedProduct(db, productId);

      if (!verifiedProduct) {
        return sendError(
          res,
          404,
          "Yeh product available nahi hai ya product ID invalid hai."
        );
      }

      const itemRef = cartRef.child(verifiedProduct.id);

      const transaction = await itemRef.transaction(current => {
        const currentQuantity =
          current && Number.isFinite(Number(current.quantity))
            ? normalizeQuantity(current.quantity)
            : 0;

        return {
          id: verifiedProduct.id,
          title: verifiedProduct.title,
          price: verifiedProduct.price,
          thumbnail: verifiedProduct.thumbnail,
          category: verifiedProduct.category,
          quantity: Math.min(
            99,
            currentQuantity + quantityToAdd
          )
        };
      });

      if (!transaction.committed) {
        return sendError(
          res,
          409,
          "Cart update nahi ho paya. Dobara try karein."
        );
      }

      const savedItem = normalizeSavedCartItem(
        verifiedProduct.id,
        transaction.snapshot.val()
      );

      const snapshot = await cartRef.once("value");
      const items = formatItems(snapshot.val());

      return res.status(200).json({
        success: true,
        message: "Product cart mein save ho gaya.",
        item: savedItem,
        items,
        ...calculateTotals(items)
      });
    }

    /* PATCH: UPDATE PRODUCT QUANTITY */

    if (req.method === "PATCH") {
      const body = req.body || {};
      const productId = String(body.id || "");
      const quantity = Number(body.quantity);

      if (!isValidProductId(productId)) {
        return sendError(res, 400, "Product ID valid nahi hai.");
      }

      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > 99
      ) {
        return sendError(
          res,
          400,
          "Quantity 1 se 99 ke beech honi chahiye."
        );
      }

      const itemRef = cartRef.child(productId);
      const snapshot = await itemRef.once("value");

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Yeh product cart mein nahi mila."
        );
      }

      /*
        Refresh product details from Firebase before updating quantity.
      */

      const verifiedProduct = await getVerifiedProduct(db, productId);

      if (!verifiedProduct) {
        return sendError(
          res,
          404,
          "Yeh product ab available nahi hai."
        );
      }

      await itemRef.update({
        id: verifiedProduct.id,
        title: verifiedProduct.title,
        price: verifiedProduct.price,
        thumbnail: verifiedProduct.thumbnail,
        category: verifiedProduct.category,
        quantity
      });

      const updatedCart = await cartRef.once("value");
      const items = formatItems(updatedCart.val());

      return res.status(200).json({
        success: true,
        message: "Quantity update ho gayi.",
        items,
        ...calculateTotals(items)
      });
    }

    /* DELETE: REMOVE PRODUCT OR CLEAR CART */

    if (req.method === "DELETE") {
      const body = req.body || {};

      if (body.clear === true) {
        await cartRef.remove();

        return res.status(200).json({
          success: true,
          message: "Cart clear ho gaya.",
          items: [],
          totalQuantity: 0,
          totalPrice: 0
        });
      }

      const productId = String(body.id || "");

      if (!isValidProductId(productId)) {
        return sendError(res, 400, "Product ID valid nahi hai.");
      }

      await cartRef.child(productId).remove();

      const snapshot = await cartRef.once("value");
      const items = formatItems(snapshot.val());

      return res.status(200).json({
        success: true,
        message: "Product cart se remove ho gaya.",
        items,
        ...calculateTotals(items)
      });
    }
  } catch (error) {
    console.error("Cart API error:", error);

    return sendError(
      res,
      500,
      "Cart update nahi ho paya. Dobara try karein."
    );
  }
};
