
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader(
    "Cache-Control",
    "s-maxage=300, stale-while-revalidate=600"
  );

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");

    return res.status(405).json({
      success: false,
      message: "Only GET requests are allowed."
    });
  }

  try {
    const search =
      typeof req.query?.search === "string"
        ? req.query.search.trim().slice(0, 100)
        : "";

    const category =
      typeof req.query?.category === "string"
        ? req.query.category.trim().toLowerCase().slice(0, 80)
        : "";

    // limit=0 requests all products available from DummyJSON.
    let endpoint = "https://dummyjson.com/products?limit=0";

    if (search) {
      endpoint =
        `https://dummyjson.com/products/search?q=${encodeURIComponent(search)}&limit=0`;
    } else if (category) {
      endpoint =
        `https://dummyjson.com/products/category/${encodeURIComponent(category)}?limit=0`;
    }

    const upstream = await fetch(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });

    if (!upstream.ok) {
      console.error("Product provider status:", upstream.status);

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
          discountPercentage:
            Number(product.discountPercentage) || 0,
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
