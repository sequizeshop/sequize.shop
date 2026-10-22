const crypto = require("crypto");
const { getDatabase, syncPayment } = require("../lib/cashfree");

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function validSignature(rawBody, timestamp, signature) {
  const secret = process.env.CASHFREE_SECRET_KEY;
  if (!secret || !timestamp || !signature) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp + rawBody)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));

  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }

  try {
    const rawBody = await getRawBody(req);

    if (
      !validSignature(
        rawBody,
        req.headers["x-webhook-timestamp"],
        req.headers["x-webhook-signature"]
      )
    ) {
      return res.status(401).end();
    }

    const event = JSON.parse(rawBody);
    const cfOrderId = event?.data?.order?.order_id;

    // Test ping ya unknown event: bas 200 do
    if (typeof cfOrderId !== "string" || !cfOrderId) {
      return res.status(200).end();
    }

    // Payload par bharosa nahi: Cashfree se dobara confirm karke order update karo
    await syncPayment(getDatabase(), cfOrderId);

    return res.status(200).end();
  } catch (error) {
    console.error("Cashfree webhook error:", error.message);
    // 500 dene par Cashfree baad me dobara try karega
    return res.status(500).end();
  }
}

module.exports = handler;

// Signature ke liye raw body chahiye, isliye body parser band hai
module.exports.config = { api: { bodyParser: false } };
