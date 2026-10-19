
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { db } = require("../lib/firebase");
const { setSessionCookie } = require("../lib/auth");

// Send JSON response
function sendJson(res, statusCode, data) {
  return res.status(statusCode).json(data);
}

// Read request body safely
async function readBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  let rawBody = "";

  for await (const chunk of req) {
    rawBody += chunk.toString();
  }

  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return {};
  }
}

// Normalize email and generate its SHA-256 hash
function hashEmail(email) {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

module.exports = async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const body = await readBody(req);

    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : "";

    const password =
      typeof body.password === "string"
        ? body.password
        : "";

    if (!email || !password) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter your email and password."
      });
    }

    if (email.length > 254 || password.length > 1024) {
      return sendJson(res, 400, {
        success: false,
        message: "Invalid email or password."
      });
    }

    // 1. Hash email to find its database mapping
    const emailHash = hashEmail(email);

    const mappingSnapshot = await db
      .ref(`userEmails/${emailHash}`)
      .get();

    const mapping = mappingSnapshot.val();

    let uid = null;

    // Support legacy format: userEmails/{hash} = "UID"
    if (typeof mapping === "string" && mapping.length > 0) {
      uid = mapping;
    }

    // Support current format: userEmails/{hash} = { uid, status }
    else if (
      mapping &&
      typeof mapping === "object" &&
      !Array.isArray(mapping) &&
      mapping.status === "active" &&
      typeof mapping.uid === "string" &&
      mapping.uid.length > 0
    ) {
      uid = mapping.uid;
    }

    if (!uid) {
      return sendJson(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    // 2. Retrieve the user record
    const userSnapshot = await db
      .ref(`users/${uid}`)
      .get();

    const user = userSnapshot.val();

    if (
      !user ||
      user.uid !== uid ||
      user.status !== "active" ||
      typeof user.passwordHash !== "string"
    ) {
      return sendJson(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    // 3. Verify password against the bcrypt hash
    let passwordMatches = false;

    try {
      passwordMatches = await bcrypt.compare(
        password,
        user.passwordHash
      );
    } catch {
      passwordMatches = false;
    }

    if (!passwordMatches) {
      return sendJson(res, 401, {
        success: false,
        message: "Invalid email or password."
      });
    }

    // 4. Check whether the account is blocked
    const blockedSnapshot = await db
      .ref(`blockedUsers/${emailHash}/blocked`)
      .get();

    if (blockedSnapshot.val() === true) {
      return sendJson(res, 403, {
        success: false,
        message: "This account is unavailable. Please contact support."
      });
    }

    // 5. Create the session cookie using lib/auth.js
    await setSessionCookie(res, {
      uid: user.uid,
      email: user.email,
      name: user.name || ""
    });

    // 6. Login successful
    return sendJson(res, 200, {
      success: true,
      message: "Login successful.",
      redirect: "/profile.html",
      user: {
        uid: user.uid,
        name: user.name || "",
        email: user.email
      }
    });
  } catch (error) {
    // Keep sensitive server details out of the response.
    console.error("Login API error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "A server error occurred. Please try again."
    });
  }
};
