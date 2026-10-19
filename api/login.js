
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
    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      !email.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    const cleanEmail = normalizeEmail(email);

    if (
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail) ||
      password.length > 72
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const db = getDatabase();
    const key = emailKey(cleanEmail);

    // Check whether this account is blocked.
    const blockedSnapshot = await db
      .ref(`blockedUsers/${key}/blocked`)
      .get();

    if (blockedSnapshot.val() === true) {
      return res.status(403).json({
        success: false,
        message: "This account is not allowed to log in",
      });
    }

    // Resolve email hash to UID, matching signup.js.
    const emailSnapshot = await db
      .ref(`userEmails/${key}`)
      .get();

    if (!emailSnapshot.exists()) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const uid = emailSnapshot.val();

    if (typeof uid !== "string" || !uid) {
      throw new Error("Invalid email index in database");
    }

    const userSnapshot = await db
      .ref(`users/${uid}`)
      .get();

    if (!userSnapshot.exists()) {
      throw new Error("User record missing for email index");
    }

    const user = userSnapshot.val();

    if (
      user.email !== cleanEmail ||
      user.status !== "active" ||
      typeof user.passwordHash !== "string"
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Return only public user information.
    return res.status(200).json({
      success: true,
      message: "Login successful",
      redirect: "/index.html",
      user: {
        uid: user.uid || uid,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login API error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to log in right now",
    });
  }
};
