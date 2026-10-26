// api/product.js

const admin = require("firebase-admin");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9]{40}$/;
const INR_RATE = 85;

function initializeFirebase() {
  if (admin.apps.length) {
    return admin.database();
  }

  const serviceAccountValue =
    process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccountValue) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT environment variable is missing."
    );
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(
      serviceAccountValue
    );
  } catch {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT must contain valid JSON."
    );
  }

  if (serviceAccount.private_key) {
    serviceAccount.private_key =
      serviceAccount.private_key.replace(/\\n/g, "\n");
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });

  return admin.database();
}

function validNumber(value, fallback = 0) {
  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : fallback;
}

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "public, max-age=0, s-maxage=60"
  );

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  const rawId = req.query?.id;

  if (
    typeof rawId !== "string" ||
    !PRODUCT_ID_PATTERN.test(rawId)
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid product ID is required."
    });
  }

  try {
    const db = initializeFirebase();

    // Look up only the exact persistent custom product ID.
    const productSnapshot = await db
      .ref("products")
      .child(rawId)
      .once("value");

    if (!productSnapshot.exists()) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    const savedProduct = productSnapshot.val();

    if (
      !savedProduct ||
      typeof savedProduct !== "object" ||
      !savedProduct.sourceId ||
      !/^\d+$/.test(String(savedProduct.sourceId))
    ) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    // Resolve provider details using the source ID stored in Firebase.
    let sourceProduct = {};

    try {
      const response = await fetch(
        `https://dummyjson.com/products/${encodeURIComponent(
          String(savedProduct.sourceId)
        )}`
      );

      if (response.ok) {
        const fetchedProduct = await response.json();

        if (
          fetchedProduct &&
          String(fetchedProduct.id) ===
            String(savedProduct.sourceId)
        ) {
          sourceProduct = fetchedProduct;
        }
      }
    } catch (error) {
      console.error(
        "Product provider request failed:",
        error.message
      );
    }

    const savedPrice = Number(savedProduct.price);

    const sourcePrice = Number(
      (
        validNumber(sourceProduct.price, 0) *
        INR_RATE
      ).toFixed(2)
    );

    /*
     * Firebase is the primary source for the saved INR price.
     * The provider price is only a fallback.
     */
    const originalPrice =
      Number.isFinite(savedPrice) && savedPrice >= 0
        ? savedPrice
        : sourcePrice;

    const product = {
      // Always return the persistent custom product ID.
      id: rawId,

      title:
        savedProduct.title ||
        sourceProduct.title ||
        "",

      description:
        savedProduct.description ||
        sourceProduct.description ||
        "",

      category:
        savedProduct.category ||
        sourceProduct.category ||
        "",

      brand:
        savedProduct.brand ||
        sourceProduct.brand ||
        "Generic",

      // No automatic discount is applied.
      price: originalPrice,

      originalPrice: originalPrice,

      originalPriceUSD: validNumber(
        savedProduct.originalPriceUSD,
        validNumber(sourceProduct.price, 0)
      ),

      /*
       * Do not trust old stored discountPercentage values or the
       * provider's default discount percentage.
       *
       * Admin discounts must be validated and applied separately
       * when the admin discount integration is implemented.
       */
      discountPercentage: 0,

      rating: validNumber(
        savedProduct.rating,
        validNumber(sourceProduct.rating, 0)
      ),

      stock: Math.max(
        0,
        validNumber(
          savedProduct.stock,
          validNumber(sourceProduct.stock, 0)
        )
      ),

      availabilityStatus:
        savedProduct.availabilityStatus ||
        sourceProduct.availabilityStatus ||
        "",

      thumbnail:
        savedProduct.thumbnail ||
        sourceProduct.thumbnail ||
        "",

      images: Array.isArray(savedProduct.images)
        ? savedProduct.images
        : Array.isArray(sourceProduct.images)
          ? sourceProduct.images
          : [],

      tags: Array.isArray(savedProduct.tags)
        ? savedProduct.tags
        : Array.isArray(sourceProduct.tags)
          ? sourceProduct.tags
          : [],

      sku:
        savedProduct.sku ||
        sourceProduct.sku ||
        "",

      weight: sourceProduct.weight ?? null,

      dimensions:
        sourceProduct.dimensions || null,

      warrantyInformation:
        sourceProduct.warrantyInformation || "",

      shippingInformation:
        sourceProduct.shippingInformation || "",

      returnPolicy:
        sourceProduct.returnPolicy || "",

      minimumOrderQuantity:
        validNumber(
          sourceProduct.minimumOrderQuantity,
          1
        ) || 1,

      reviews: Array.isArray(sourceProduct.reviews)
        ? sourceProduct.reviews.map(review => ({
            rating: validNumber(review.rating),

            comment: String(
              review.comment || ""
            ),

            date: review.date || "",

            reviewerName: String(
              review.reviewerName || "Customer"
            ),

            reviewerEmail: String(
              review.reviewerEmail || ""
            )
          }))
        : []
    };

    if (!product.title) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    return res.status(200).json({
      success: true,
      product
    });
  } catch (error) {
    console.error(
      "Product API error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Something went wrong while loading the product."
    });
  }
};
