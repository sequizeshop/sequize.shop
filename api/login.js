"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const admin = require("firebase-admin");
const { db } = require("../lib/firebase");
const {
  setSessionCookie,
  getSession
} = require("../lib/auth");

const REFERRAL_BACKEND_URL =
  "https://apisequizeshoplite.vercel.app/api/referrals/profile";

function sendJson(res, statusCode, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "private, no-store, max-age=0");

  return res.status(statusCode).json(data);
}

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

function hashEmail(email) {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/*
 * Referral profile handler.
 *
 * This is part of the existing login API.
 * It does not create a new API file.
 *
 * The UID comes only from the verified Shoppy session.
 * The browser cannot choose another user's UID.
 */
async function handleReferralProfile(req, res) {
  try {
    const session = await getSession(req);

    if (
      !session ||
      typeof session.uid !== "string" ||
      !session.uid.trim()
    ) {
      return sendJson(res, 401, {
        success: false,
        message:
          "Please sign in to your Shoppy account, then try again."
      });
    }

    const secret = process.env.REFERRAL_SERVICE_SECRET;

    if (
      typeof secret !== "string" ||
      Buffer.byteLength(secret, "utf8") < 32
    ) {
      console.error(
        "REFERRAL_SERVICE_SECRET is missing or too short in Shoppy."
      );

      return sendJson(res, 500, {
        success: false,
        message:
          "Referral service is not configured. Please try again later."
      });
    }

    const upstream = await fetch(REFERRAL_BACKEND_URL, {
      method: "POST",

      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`
      },

      body: JSON.stringify({
        uid: session.uid.trim()
      }),

      cache: "no-store"
    });

    const data = await upstream.json().catch(() => ({}));

    if (
      !upstream.ok ||
      data.success !== true ||
      !data.profile
    ) {
      console.error(
        "Referral backend profile request failed:",
        upstream.status,
        data.message || data.error || "Unknown error"
      );

      const statusCode =
        upstream.status >= 400 && upstream.status < 500
          ? upstream.status
          : 502;

      return sendJson(res, statusCode, {
        success: false,
        message:
          data.message ||
          data.error ||
          "Could not generate your referral link. Please try again."
      });
    }

    return sendJson(res, 200, {
      success: true,
      profile: data.profile
    });
  } catch (error) {
    console.error(
      "Referral profile proxy error:",
      error && error.message ? error.message : error
    );

    return sendJson(res, 500, {
      success: false,
      message:
        "Could not generate your referral link. Please try again."
    });
  }
}

/*
 * Google sign-in / sign-up handler.
 *
 * The browser sends a Firebase ID token obtained after the Google popup.
 * The server verifies it, then either signs in the existing account
 * (matched by verified email) or creates a new one, and finally issues
 * the normal Shoppy session cookie.
 */
async function handleGoogleLogin(req, res, body) {
  const idToken =
    typeof body.idToken === "string" ? body.idToken : "";

  if (!idToken || idToken.length > 4096) {
    return sendJson(res, 400, {
      success: false,
      message: "Google sign-in failed. Please try again."
    });
  }

  let decoded;

  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch {
    return sendJson(res, 401, {
      success: false,
      message: "Google sign-in failed. Please try again."
    });
  }

  if (
    !decoded.firebase ||
    decoded.firebase.sign_in_provider !== "google.com" ||
    !decoded.email ||
    decoded.email_verified !== true
  ) {
    return sendJson(res, 401, {
      success: false,
      message: "Your Google email could not be verified."
    });
  }

  const email = decoded.email.trim().toLowerCase();
  const emailHash = hashEmail(email);

  const blockedSnapshot = await db
    .ref(`blockedUsers/${emailHash}/blocked`)
    .get();

  if (blockedSnapshot.val() === true) {
    return sendJson(res, 403, {
      success: false,
      message: "This account is unavailable. Please contact support."
    });
  }

  const emailRef = db.ref(`userEmails/${emailHash}`);
  const mapping = (await emailRef.get()).val();

  let uid = null;
  let user = null;

  if (typeof mapping === "string" && mapping.length > 0) {
    uid = mapping;
  } else if (
    mapping &&
    typeof mapping === "object" &&
    !Array.isArray(mapping) &&
    mapping.status === "active" &&
    typeof mapping.uid === "string" &&
    mapping.uid.length > 0
  ) {
    uid = mapping.uid;
  } else if (mapping) {
    // Reservation exists but is not active yet (signup in progress).
    return sendJson(res, 409, {
      success: false,
      message: "Account setup is in progress. Please try again."
    });
  }

  if (uid) {
    // Existing account (email/password or Google): sign in.
    user = (await db.ref(`users/${uid}`).get()).val();

    if (!user || user.uid !== uid || user.status !== "active") {
      return sendJson(res, 401, {
        success: false,
        message: "Unable to sign in with Google."
      });
    }
  } else {
    // New account: reserve the email atomically, then create the user.
    uid = crypto.randomUUID();

    const reservation = await emailRef.transaction(current => {
      if (current !== null) {
        return;
      }

      return { uid, status: "pending" };
    });

    if (!reservation.committed) {
      return sendJson(res, 409, {
        success: false,
        message: "Please try again."
      });
    }

    user = {
      uid,
      name: (decoded.name || "").toString().trim().slice(0, 80),
      email,
      provider: "google",
      createdAt: new Date().toISOString(),
      status: "active"
    };

    try {
      await db.ref(`users/${uid}`).set(user);
      await emailRef.set({ uid, status: "active" });
    } catch (error) {
      await emailRef.remove().catch(() => {});
      await db.ref(`users/${uid}`).remove().catch(() => {});
      throw error;
    }
  }

  await setSessionCookie(res, {
    uid: user.uid,
    email: user.email,
    name: user.name || ""
  });

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
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const body = await readBody(req);

    /*
     * Referral page uses the same existing API.
     * No additional Shoppy backend file is required.
     */
    if (body.action === "referralProfile") {
      return await handleReferralProfile(req, res);
    }

    /*
     * Continue with Google (login + signup in one step).
     */
    if (body.action === "googleLogin") {
      return await handleGoogleLogin(req, res, body);
    }

    /*
     * Normal login starts below.
     * Existing login validation is preserved.
     */
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

    const emailHash = hashEmail(email);

    const mappingSnapshot = await db
      .ref(`userEmails/${emailHash}`)
      .get();

    const mapping = mappingSnapshot.val();

    let uid = null;

    if (typeof mapping === "string" && mapping.length > 0) {
      uid = mapping;
    } else if (
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

    const blockedSnapshot = await db
      .ref(`blockedUsers/${emailHash}/blocked`)
      .get();

    if (blockedSnapshot.val() === true) {
      return sendJson(res, 403, {
        success: false,
        message:
          "This account is unavailable. Please contact support."
      });
    }

    // Existing Shoppy session. No referral token is required.
    await setSessionCookie(res, {
      uid: user.uid,
      email: user.email,
      name: user.name || ""
    });

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
    console.error("Login API error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "A server error occurred. Please try again."
    });
  }
};
