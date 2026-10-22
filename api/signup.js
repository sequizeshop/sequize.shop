const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { db } = require("../lib/firebase");

const {
  setSessionCookie,
  clearSessionCookie,
  emailHash,
  sendJson
} = require("../lib/auth");

const { consumeEmailVerification } = require("./auth/otp");

module.exports = async function handler(req, res) {

  // Only POST requests are allowed.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  /*
   * LOGOUT ACTION
   *
   * This action runs before the signup process.
   * It clears the existing session cookie.
   */
  const action = req.body?.action;

  if (action === "logout") {

    clearSessionCookie(res);

    return sendJson(res, 200, {
      success: true,
      message: "Logged out successfully.",
      redirect: "/login.html"
    });
  }

  /*
   * SIGNUP PROCESS
   *
   * Existing registration flow is preserved.
   */

  let reservedEmailHash = null;
  let uid = null;

  try {

    const { name, email, password } = req.body || {};

    // Validate required fields.
    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter your name, email and password."
      });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    // Validate name.
    if (
      cleanName.length < 2 ||
      cleanName.length > 80
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Name must be between 2 and 80 characters."
      });
    }

    // Validate email.
    if (
      cleanEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Please enter a valid email address."
      });
    }

    // Validate password.
    if (
      password.length < 8 ||
      password.length > 72
    ) {
      return sendJson(res, 400, {
        success: false,
        message: "Password must be between 8 and 72 characters."
      });
    }

    const hash = emailHash(cleanEmail);

    reservedEmailHash = hash;

    // Check whether this account is blocked.
    const blocked = await db
      .ref(`blockedUsers/${hash}/blocked`)
      .get();

    if (blocked.val() === true) {
      return sendJson(res, 403, {
        success: false,
        message: "This account cannot be registered."
      });
    }

    uid = crypto.randomUUID();

    /*
     * Reserve the email atomically.
     * This prevents duplicate registrations.
     */
    const emailRef = db.ref(`userEmails/${hash}`);

    const reservation = await emailRef.transaction(current => {

      if (current !== null) {
        return;
      }

      return {
        uid,
        status: "pending"
      };

    });

    if (!reservation.committed) {

      reservedEmailHash = null;

      return sendJson(res, 409, {
        success: false,
        message: "An account with this email may already exist."
      });
    }

    /*
     * Verify email OTP.
     * Verification is single-use and valid for 15 minutes,
     * according to the existing OTP implementation.
     */
    const verified = await consumeEmailVerification(cleanEmail);

    if (!verified) {

      await emailRef.remove().catch(() => {});

      reservedEmailHash = null;

      return sendJson(res, 403, {
        success: false,
        message: "Please verify your email first."
      });
    }

    // Hash password securely.
    const passwordHash = await bcrypt.hash(password, 12);

    // Create the user in Firebase.
    await db.ref(`users/${uid}`).set({
      uid,
      name: cleanName,
      email: cleanEmail,
      passwordHash,
      createdAt: new Date().toISOString(),
      status: "active"
    });

    // Mark the email reservation as active.
    await emailRef.set({
      uid,
      status: "active"
    });

    // Create the login session.
    await setSessionCookie(res, {
      uid,
      email: cleanEmail,
      name: cleanName
    });

    return sendJson(res, 201, {
      success: true,
      message: "Account created successfully.",
      redirect: "/profile.html",
      user: {
        uid,
        name: cleanName,
        email: cleanEmail
      }
    });

  } catch (error) {

    console.error("Signup API error:", error);

    /*
     * Clean up an incomplete registration where possible.
     */
    if (reservedEmailHash && uid) {

      try {

        const ref = db.ref(
          `userEmails/${reservedEmailHash}`
        );

        const snapshot = await ref.get();

        if (snapshot.val()?.uid === uid) {

          await ref.remove();

          await db.ref(`users/${uid}`).remove();

        }

      } catch (cleanupError) {

        console.error(
          "Signup cleanup error:",
          cleanupError
        );

      }
    }

    return sendJson(res, 500, {
      success: false,
      message:
        "Unable to create your account right now. Please try again."
    });

  }
};
