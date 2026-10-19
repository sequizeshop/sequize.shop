
const ALLOWED_LIMITS = new Set([12, 24, 36, 48]);

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      message: "Method not allowed."
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

    const endpoint = search
      ? `https://dummyjson.com/products/search?q=${encodeURIComponent(search)}&limit=${limit}`
      : category
        ? `https://dummyjson.com/products/category/${encodeURIComponent(category)}?limit=${limit}`
        : `https://dummyjson.com/products?limit=${limit}`;

    const upstream = await fetch(endpoint, {
      headers: { Accept: "application/json" }
    });

    if (!upstream.ok) {
      throw new Error(`Products provider returned ${upstream.status}`);
    }

    const result = await upstream.json();

    const products = Array.isArray(result.products)
      ? result.products.map(product => ({
          id: product.id,
          title: product.title || "Untitled product",
          description: product.description || "",
          price: Number(product.price) || 0,
          discountPercentage: Number(product.discountPercentage) || 0,
          rating: Number(product.rating) || 0,
          category: product.category || "other",
          thumbnail: product.thumbnail || "",
          images: Array.isArray(product.images) ? product.images : []
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
      message: "Products abhi load nahi ho pa rahe. Thodi der baad try karein."
    });
  }
};
