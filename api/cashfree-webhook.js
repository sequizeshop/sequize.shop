const crypto = require("crypto");
const { getDatabase, syncPayment } = require("../lib/cashfree");

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function validSignature(rawBody, timestamp, signature) {
  const secret = String(
    process.env.CASHFREE_SECRET_KEY || ""
  ).trim();

  if (!secret || !timestamp || !signature) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(String(timestamp) + rawBody)
    .digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));

  return (
    a.length === b.length &&
    crypto.timingSafeEqual(a, b)
  );
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

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

    let event;

    try {
      event = JSON.parse(rawBody);
    } catch (_) {
      return res.status(400).end();
    }

    const cfOrderId = event?.data?.order?.order_id;

    // Cashfree test ping or unrelated event.
    if (
      typeof cfOrderId !== "string" ||
      !cfOrderId.trim()
    ) {
      return res.status(200).end();
    }

    // Never trust webhook payment status or amount.
    // syncPayment fetches the current order directly from Cashfree,
    // checks the saved advance amount, and records ADVANCE_PAID.
    await syncPayment(
      getDatabase(),
      cfOrderId.trim()
    );

    return res.status(200).end();
  } catch (error) {
    console.error(
      "Cashfree webhook error:",
      error.message
    );

    // A 500 response lets Cashfree retry the webhook.
    return res.status(500).end();
  }
}

module.exports = handler;

// Signature verification requires the untouched raw request body.
module.exports.config = {
  api: {
    bodyParser: false
  }
};
