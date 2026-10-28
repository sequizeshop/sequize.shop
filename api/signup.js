const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { db } = require("../lib/firebase");

const {
  setSessionCookie,
  clearSessionCookie,
  emailHash,
  sendJson,
  getSession
} = require("../lib/auth");

const { consumeEmailVerification } = require("./auth/otp");

module.exports = async function handler(req, res) {
  // POST requests only.
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  const action = req.body?.action;

  /*
   * REGISTER NOTIFICATION TOKEN
   *
   * Called by signup.html after notification permission
   * is granted and Firebase generates an FCM token.
   */
  if (action === "save-fcm-token") {
    try {
      const session = await getSession(req);
      const sessionUid = session?.uid || session?.user?.uid;

      if (!sessionUid) {
        return sendJson(res, 401, {
          success: false,
          message: "Please sign in before registering notifications."
        });
      }

      const rawToken = req.body?.fcmToken;

      if (
        typeof rawToken !== "string" ||
        rawToken.trim().length < 20 ||
        rawToken.trim().length > 4096 ||
        /[\u0000-\u001F\u007F]/.test(rawToken)
      ) {
        return sendJson(res, 400, {
          success: false,
          message: "Invalid notification token."
        });
      }

      const token = rawToken.trim();

      const tokenHash = crypto
        .createHash("sha256")
        .update(token)
        .digest("hex");

      const tokenRef = db.ref(
        `users/${sessionUid}/notificationTokens/${tokenHash}`
      );

      const existing = await tokenRef.get();
      const now = new Date().toISOString();

      await tokenRef.set({
        token,
        platform: "web",
        enabled: true,
        createdAt: existing.val()?.createdAt || now,
        updatedAt: now
      });

      return sendJson(res, 200, {
        success: true,
        message: "Notification token registered."
      });
    } catch (error) {
      console.error("FCM token registration error:", error);

      return sendJson(res, 500, {
        success: false,
        message: "Unable to register notifications right now."
      });
    }
  }

  /*
   * LOGOUT
   */
  if (action === "logout") {
    clearSessionCookie(res);

    return sendJson(res, 200, {
      success: true,
      message: "Logged out successfully.",
      redirect: "/login.html"
    });
  }

  /*
   * SIGNUP
   */
  let reservedEmailHash = null;
  let uid = null;

  try {
    const { name, email, password } = req.body || {};

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
    if (cleanName.length < 2 || cleanName.length > 80) {
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
    if (password.length < 8 || password.length > 72) {
      return sendJson(res, 400, {
        success: false,
        message: "Password must be between 8 and 72 characters."
      });
    }

    const hash = emailHash(cleanEmail);
    reservedEmailHash = hash;

    // Check blocked accounts.
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

    const emailRef = db.ref(`userEmails/${hash}`);

    // Reserve email atomically.
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

    // Verify email OTP.
    const verified = await consumeEmailVerification(cleanEmail);

    if (!verified) {
      await emailRef.remove().catch(() => {});
      reservedEmailHash = null;

      return sendJson(res, 403, {
        success: false,
        message: "Please verify your email first."
      });
    }

    // Hash password.
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user without overwriting any notification token
    // that may be registered later.
    await db.ref(`users/${uid}`).set({
      uid,
      name: cleanName,
      email: cleanEmail,
      passwordHash,
      createdAt: new Date().toISOString(),
      status: "active"
    });

    // Mark email active.
    await emailRef.set({
      uid,
      status: "active"
    });

    // Create session.
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

    // Clean up an incomplete registration when possible.
    if (reservedEmailHash && uid) {
      try {
        const ref = db.ref(`userEmails/${reservedEmailHash}`);
        const snapshot = await ref.get();

        if (snapshot.val()?.uid === uid) {
          await ref.remove();
          await db.ref(`users/${uid}`).remove();
        }
      } catch (cleanupError) {
        console.error("Signup cleanup error:", cleanupError);
      }
    }

    return sendJson(res, 500, {
      success: false,
      message:
        "Unable to create your account right now. Please try again."
    });
  }
};
