const admin = require("firebase-admin");
const { getSession } = require("../lib/auth");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

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

function normalizeItem(item) {
  return {
    id: Number(item.id),
    title: String(item.title || "Product").slice(0, 200),
    price: Number(item.price),
    thumbnail: String(item.thumbnail || "").slice(0, 2000),
    quantity: Math.max(
      1,
      Math.min(99, Math.floor(Number(item.quantity) || 1))
    )
  };
}

function validProduct(item) {
  return (
    item &&
    Number.isSafeInteger(Number(item.id)) &&
    Number(item.id) > 0 &&
    Number.isFinite(Number(item.price)) &&
    Number(item.price) >= 0 &&
    typeof item.title === "string" &&
    item.title.trim().length > 0
  );
}

function formatItems(value) {
  if (!value || typeof value !== "object") {
    return [];
  }

  return Object.values(value)
    .filter(item => item && Number(item.id) > 0)
    .map(item => ({
      id: Number(item.id),
      title: String(item.title || "Product"),
      price: Number(item.price) || 0,
      thumbnail: String(item.thumbnail || ""),
      quantity: Math.max(
        1,
        Math.min(99, Math.floor(Number(item.quantity) || 1))
      )
    }));
}

/* CART API */

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store");

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

      const totalQuantity = items.reduce(
        (sum, item) => sum + item.quantity,
        0
      );

      const totalPrice = items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      );

      return res.status(200).json({
        success: true,
        items,
        totalQuantity,
        totalPrice
      });
    }

    /* POST: ADD PRODUCT */

    if (req.method === "POST") {
      const body = req.body || {};

      if (!validProduct(body)) {
        return sendError(
          res,
          400,
          "Product information valid nahi hai."
        );
      }

      const product = normalizeItem(body);

      const itemRef = cartRef.child(String(product.id));

      let savedItem;

      /*
        Transaction prevents two simultaneous requests
        from overwriting each other's quantity updates.
      */

      const transaction = await itemRef.transaction(current => {
        if (current) {
          return {
            id: product.id,
            title: product.title,
            price: product.price,
            thumbnail: product.thumbnail,
            quantity: Math.min(
              99,
              Math.max(1, Number(current.quantity) || 1) + 1
            )
          };
        }

        return {
          ...product,
          quantity: 1
        };
      });

      savedItem = transaction.snapshot.val();

      const snapshot = await cartRef.once("value");
      const items = formatItems(snapshot.val());

      const totalQuantity = items.reduce(
        (sum, item) => sum + item.quantity,
        0
      );

      return res.status(200).json({
        success: true,
        message: "Product cart mein save ho gaya.",
        item: savedItem,
        items,
        totalQuantity
      });
    }

    /* PATCH: UPDATE PRODUCT QUANTITY */

    if (req.method === "PATCH") {
      const body = req.body || {};

      const id = Number(body.id);
      const quantity = Math.floor(Number(body.quantity));

      if (!Number.isSafeInteger(id) || id <= 0) {
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

      const itemRef = cartRef.child(String(id));

      const snapshot = await itemRef.once("value");

      if (!snapshot.exists()) {
        return sendError(
          res,
          404,
          "Yeh product cart mein nahi mila."
        );
      }

      await itemRef.update({ quantity });

      const updatedCart = await cartRef.once("value");
      const items = formatItems(updatedCart.val());

      return res.status(200).json({
        success: true,
        message: "Quantity update ho gayi.",
        items,
        totalQuantity: items.reduce(
          (sum, item) => sum + item.quantity,
          0
        ),
        totalPrice: items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0
        )
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

      const id = Number(body.id);

      if (!Number.isSafeInteger(id) || id <= 0) {
        return sendError(
          res,
          400,
          "Product ID valid nahi hai."
        );
      }

      await cartRef.child(String(id)).remove();

      const snapshot = await cartRef.once("value");
      const items = formatItems(snapshot.val());

      return res.status(200).json({
        success: true,
        message: "Product cart se remove ho gaya.",
        items,
        totalQuantity: items.reduce(
          (sum, item) => sum + item.quantity,
          0
        ),
        totalPrice: items.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0
        )
      });
    }

    res.setHeader("Allow", "GET, POST, PATCH, DELETE");

    return sendError(res, 405, "Method allowed nahi hai.");

  } catch (error) {
    console.error("Cart API error:", error);

    return sendError(
      res,
      500,
      "Cart update nahi ho paya. Dobara try karein."
    );
  }
};
