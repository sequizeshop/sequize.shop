// api/product.js

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      message: "Method not allowed."
    });
  }

  const rawId = req.query?.id;
  const productId = Number(rawId);

  if (
    rawId === undefined ||
    rawId === null ||
    String(rawId).trim() === "" ||
    !Number.isSafeInteger(productId) ||
    productId <= 0
  ) {
    return res.status(400).json({
      success: false,
      message: "A valid product ID is required."
    });
  }

  try {
    const response = await fetch(
      `https://dummyjson.com/products/${productId}`
    );

    if (response.status === 404) {
      return res.status(404).json({
        success: false,
        message: "Product not found."
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        success: false,
        message: "Unable to fetch product information."
      });
    }

    const product = await response.json();

    if (!product || !product.id || !product.title) {
      return res.status(502).json({
        success: false,
        message: "Invalid product information received."
      });
    }

    return res.status(200).json({
      success: true,

      product: {
        id: product.id,
        title: product.title,
        description: product.description || "",
        category: product.category || "",
        brand: product.brand || "Generic",

        price: Number(product.price) || 0,
        discountPercentage:
          Number(product.discountPercentage) || 0,

        rating: Number(product.rating) || 0,
        stock: Number(product.stock) || 0,

        availabilityStatus:
          product.availabilityStatus || "",

        thumbnail: product.thumbnail || "",
        images: Array.isArray(product.images)
          ? product.images
          : [],

        tags: Array.isArray(product.tags)
          ? product.tags
          : [],

        sku: product.sku || "",
        weight: product.weight ?? null,
        dimensions: product.dimensions || null,

        warrantyInformation:
          product.warrantyInformation || "",

        shippingInformation:
          product.shippingInformation || "",

        returnPolicy:
          product.returnPolicy || "",

        minimumOrderQuantity:
          Number(product.minimumOrderQuantity) || 1,

        reviews: Array.isArray(product.reviews)
          ? product.reviews.map(review => ({
              rating: Number(review.rating) || 0,
              comment: String(review.comment || ""),
              date: review.date || "",
              reviewerName:
                String(review.reviewerName || "Customer"),
              reviewerEmail:
                String(review.reviewerEmail || "")
            }))
          : []
      }
    });
  } catch (error) {
    console.error("Product API error:", error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong while loading the product."
    });
  }
};
