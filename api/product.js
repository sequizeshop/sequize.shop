
const ALLOWED_LIMITS = new Set([12, 24, 36, 48]);

module.exports = async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "s-maxage=300, stale-while-revalidate=600"
  );

  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      message: "Only GET requests are allowed."
    });
  }

  try {
    const rawLimit = Number.parseInt(req.query?.limit || "24", 10);
    const limit = ALLOWED_LIMITS.has(rawLimit) ? rawLimit : 24;

    const search = typeof req.query?.search === "string"
      ? req.query.search.trim().slice(0, 100)
      : "";

    const category = typeof req.query?.category === "string"
      ? req.query.category.trim().toLowerCase().slice(0, 80)
      : "";

    let endpoint = "https://dummyjson.com/products";

    if (search) {
      endpoint += `/search?q=${encodeURIComponent(search)}&limit=${limit}`;
    } else if (category) {
      endpoint += `/category/${encodeURIComponent(category)}?limit=${limit}`;
    } else {
      endpoint += `?limit=${limit}`;
    }

    const upstream = await fetch(endpoint, {
      headers: {
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(12000)
    });

    if (!upstream.ok) {
      return res.status(502).json({
        success: false,
        message: "Product provider se data nahi mila. Dobara try karein."
      });
    }

    const result = await upstream.json();

    const products = Array.isArray(result.products)
      ? result.products.map(product => ({
          id: Number(product.id),
          title: String(product.title || "Untitled product"),
          description: String(product.description || ""),
          price: Number(product.price) || 0,
          discountPercentage: Number(product.discountPercentage) || 0,
          rating: Number(product.rating) || 0,
          category: String(product.category || "other"),
          thumbnail: String(product.thumbnail || ""),
          images: Array.isArray(product.images)
            ? product.images.map(String)
            : []
        }))
      : [];

    return res.status(200).json({
      success: true,
      total: Number(result.total) || products.length,
      products
    });
  } catch (error) {
    console.error("Products API error:", error);

    return res.status(502).json({
      success: false,
      message: "Products abhi load nahi ho rahe. Thodi der baad try karein."
    });
  }
};
