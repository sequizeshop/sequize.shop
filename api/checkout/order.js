export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  return res.status(501).json({
    success: false,
    message:
      "Order creation is not enabled yet. Server-side authentication, cart, product prices and address validation must be implemented first."
  });
}
