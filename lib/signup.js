const getFirebaseAdmin = require("../lib/firebase");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

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
        message: "Name must be 2–80 characters",
      });
    }

    if (
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid email",
      });
    }

    if (password.length < 8 || password.length > 72) {
      return res.status(400).json({
        success: false,
        message: "Password must be 8–72 characters",
      });
    }

    const admin = getFirebaseAdmin();
    const db = admin.database();
    const key = emailKey(cleanEmail);

    // 1. Check whether this email is blocked.
    const blocked = await db
      .ref(`blockedUsers/${key}/blocked`)
      .get();

    if (blocked.val() === true) {
      return res.status(403).json({
        success: false,
        message: "Registration is not allowed",
      });
    }

    // 2. Check whether the email is already registered.
    const existing = await db.ref(`userEmails/${key}`).get();

    if (existing.exists()) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered",
      });
    }

    // 3. Hash the password.
    const passwordHash = await bcrypt.hash(password, 12);

    // 4. Reserve the email atomically to avoid duplicate accounts.
    const reservation = await db
      .ref(`userEmails/${key}`)
      .transaction((current) => current === null ? "pending" : undefined);

    if (!reservation.committed) {
      return res.status(409).json({
        success: false,
        message: "Email is already registered",
      });
    }

    const userRef = db.ref("users").push();

    try {
      await userRef.set({
        uid: userRef.key,
        name: cleanName,
        email: cleanEmail,
        passwordHash,
        status: "active",
        createdAt: Date.now(),
      });

      await db.ref(`userEmails/${key}`).set(userRef.key);
    } catch (error) {
      await Promise.all([
        userRef.remove(),
        db.ref(`userEmails/${key}`).remove(),
      ]);
      throw error;
    }

    return res.status(201).json({
      success: true,
      message: "Account created successfully",
      user: {
        uid: userRef.key,
        name: cleanName,
        email: cleanEmail,
      },
    });
  } catch (error) {
    console.error("Signup error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Unable to create account",
    });
  }
};
