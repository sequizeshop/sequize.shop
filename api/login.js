const bcrypt = require("bcryptjs");
const { db } = require("../lib/firebase");
const {
  setSessionCookie,
  emailHash,
  sendJson
} = require("../lib/auth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const { email, password } = req.body || {};

    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      email.length > 254 ||
      password.length > 72
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter a valid email and password."
      });
    }

    const cleanEmail = email.trim().toLowerCase();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return sendJson(res, 400, {
        success: false,
        message: "Invalid email or password."
      });
    }

    const hash = emailHash(cleanEmail);

    const blocked = await db.ref(`blockedUsers/${hash}/blocked`).get();

    if (blocked.val() === true) {
      return sendJson(res, 403, {
        success: false,
        message: "This account is unavailable."
      });
    }

    const mappingSnapshot = await db.ref(`userEmails/${hash}`).get();
    const mapping = mappingSnapshot.val();

    if (!mapping || mapping.status !== "active" || !mapping.uid) {
      return sendJson(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    const userSnapshot = await db.ref(`users/${mapping.uid}`).get();
    const user = userSnapshot.val();

    if (
      !user ||
      user.status !== "active" ||
      typeof user.passwordHash !== "string"
    ) {
      return sendJson(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    const passwordMatches = await bcrypt.compare(
      password,
      user.passwordHash
    );

    if (!passwordMatches) {
      return sendJson(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    setSessionCookie(res, user.uid);

    return sendJson(res, 200, {
      success: true,
      message: "Login successful.",
      redirect: "/profile.html",
      user: {
        uid: user.uid,
        name: user.name,
        email: user.email
      }
    });
  } catch (error) {
    console.error("Login API error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "Unable to sign in right now. Please try again."
    });
  }
};
