
module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");

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

    const response = await fetch("https://dummyjson.com/products?limit=0");

    if (!response.ok) {
      throw new Error("Product provider is unavailable.");
    }

    const result = await response.json();
    let products = Array.isArray(result.products) ? result.products : [];

    if (search) {
      products = products.filter(product => {
        const searchable = [
          product.title,
          product.description,
          product.category,
          product.brand,
          ...(Array.isArray(product.tags) ? product.tags : [])
        ].join(" ").toLowerCase();

        return searchable.includes(search);
      });
    }

    if (category) {
      products = products.filter(
        product => String(product.category || "").toLowerCase() === category
      );
    }

    const mappedProducts = products.map(product => ({
      id: product.id,
      title: product.title,
      description: product.description,
      price: Number((Number(product.price || 0) * INR_RATE).toFixed(2)),
      originalPriceUSD: Number(product.price || 0),
      discountPercentage: Number(product.discountPercentage || 0),
      rating: Number(product.rating || 0),
      category: product.category || "other",
      brand: product.brand || "",
      sku: product.sku || "",
      thumbnail: product.thumbnail || "",
      images: Array.isArray(product.images) ? product.images : [],
      tags: Array.isArray(product.tags) ? product.tags : [],
      availabilityStatus: product.availabilityStatus || "",
      stock: Number(product.stock || 0)
    }));

    return res.status(200).json({
      success: true,
      total: mappedProducts.length,
      currency: "INR",
      exchangeRate: INR_RATE,
      products: mappedProducts
    });
  } catch (error) {
    console.error("Products API error:", error);

    return res.status(502).json({
      success: false,
      message: "Products load nahi ho paaye. Dobara try karein."
    });
  }
};
