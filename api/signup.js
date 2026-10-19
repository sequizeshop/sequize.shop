const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

function getDatabase() {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!raw) {
      throw new Error("Firebase credentials are not configured");
    }

    const serviceAccount = JSON.parse(raw);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL:
        "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app",
    });
  }

  return admin.database();
}

function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

function emailKey(email) {
  return crypto
    .createHash("sha256")
    .update(normalizeEmail(email))
    .digest("hex");
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Method not allowed",
    });
  }

  try {
    const { name, email, password } = req.body || {};

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({
        success: false,
        message: "Name, email and password are required",
      });
    }

    const cleanName = name.trim();
    const cleanEmail = normalizeEmail(email);

    if (cleanName.length < 2 || cleanName.length > 80) {
      return res.status(400).json({
        success: false,
        message: "Name must be 2 to 80 characters",
      });
    }

    if (
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email address",
      });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: "Password must be 8 to 72 characters",
      });
    }

    const db = getDatabase();
    const key = emailKey(cleanEmail);

    // Block check happens before account creation.
    const blockedSnapshot = await db
      .ref(`blockedUsers/${key}/blocked`)
      .get();

    if (blockedSnapshot.val() === true) {
      return res.status(403).json({
        success: false,
        message: "This account is not allowed to register",
      });
    }

    const existingUser = await db
      .ref(`userEmails/${key}`)
      .get();

    if (existingUser.exists()) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userRef = db.ref("users").push();
    const uid = userRef.key;

    // Reserve the normalized email key atomically.
    const emailReservation = await db
      .ref(`userEmails/${key}`)
      .transaction((current) => {
        return current === null ? uid : undefined;
      });

    if (!emailReservation.committed) {
      return res.status(409).json({
        success: false,
        message: "An account with this email already exists",
      });
    }

    try {
      await userRef.set({
        uid,
        name: cleanName,
        email: cleanEmail,
        passwordHash,
        createdAt: Date.now(),
        status: "active",
      });
    } catch (error) {
      await db.ref(`userEmails/${key}`).remove();
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: {
        uid,
        name: cleanName,
        email: cleanEmail,
      },
    });
  } catch (error) {
    console.error("Signup API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create account right now",
    });
  }
};
