const admin = require("firebase-admin");
const { getSession } = require("../../lib/auth");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

function initializeFirebase() {
  if (admin.apps.length) {
    return admin.app();
  }

  const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccountString) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  }

  let serviceAccount;

  try {
    serviceAccount = JSON.parse(serviceAccountString);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT is not valid JSON.");
  }

  return admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: DATABASE_URL
  });
}

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendError(res, 405, "Method not allowed.");
  }

  try {
    initializeFirebase();

    // Verify the signed-in user.
    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(res, 401, "Please log in to continue checkout.");
    }

    const addressId =
      typeof req.body?.addressId === "string"
        ? req.body.addressId.trim()
        : "";

    if (!addressId || !/^[A-Za-z0-9_-]{1,128}$/.test(addressId)) {
      return sendError(res, 400, "A valid address ID is required.");
    }

    const db = admin.database();

    // Only allow addresses belonging to this signed-in user.
    const addressRef = db.ref(
      `users/${session.uid}/addresses/${addressId}`
    );

    const addressSnapshot = await addressRef.get();

    if (!addressSnapshot.exists()) {
      return sendError(
        res,
        404,
        "This address was not found in your saved addresses."
      );
    }

    const address = addressSnapshot.val();

    // Ensure the saved address has the required delivery details.
    const requiredFields = [
      "fullName",
      "phone",
      "pincode",
      "houseNumber",
      "area",
      "city",
      "state",
      "country"
    ];

    const missingFields = requiredFields.filter(field => {
      return (
        typeof address[field] !== "string" ||
        !address[field].trim()
      );
    });

    if (missingFields.length) {
      return sendError(
        res,
        422,
        "This address is incomplete. Please edit it and save the required details."
      );
    }

    // Save the selected address reference server-side.
    // Do not accept address details from the browser.
    const checkoutRef = db.ref(
      `users/${session.uid}/checkout`
    );

    const now = Date.now();

    await checkoutRef.update({
      addressId,
      addressSelectedAt: now,
      updatedAt: now
    });

    return res.status(200).json({
      success: true,
      message: "Delivery address selected successfully.",
      addressId
    });

  } catch (error) {
    console.error("Checkout address API error:", error);

    return sendError(
      res,
      500,
      "Unable to select the delivery address right now. Please try again."
    );
  }
};
