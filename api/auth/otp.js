const crypto = require("node:crypto");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

/*
 * Email OTP: send + verify in ONE file.
 *   POST /api/auth/otp  { "action": "send",   "email": "a@b.com" }
 *   POST /api/auth/otp  { "action": "verify", "email": "a@b.com", "otp": "123456" }
 *
 * Sign-up API must call:  consumeEmailVerification(email)  (see bottom)
 *
 * Vercel env: GMAIL_USER, GMAIL_APP_PASSWORD, OTP_SECRET, FIREBASE_SERVICE_ACCOUNT
 */

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const OTP_TTL_MS = 10 * 60 * 1000;       // OTP valid for 10 minutes
const RESEND_COOLDOWN_MS = 60 * 1000;    // 1 OTP per 60 seconds
const MAX_SENDS_PER_HOUR = 5;            // per email
const MAX_WRONG_ATTEMPTS = 5;            // then the OTP is burned
const VERIFIED_TTL_MS = 15 * 60 * 1000;  // verified email can sign up within 15 min

const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

function getDatabase() {
  if (!admin.apps.length) {
    const text = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!text) throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(text)),
      databaseURL: DATABASE_URL
    });
  }
  return admin.database();
}

function normalizeEmail(value) {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : "";
}

// Firebase keys cannot contain "." so a hash of the email is used as key.
function emailKey(email) {
  return crypto.createHash("sha256").update(email).digest("hex");
}

function hashOtp(email, otp) {
  const secret = process.env.OTP_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("OTP_SECRET is missing or too short.");
  }
  return crypto.createHmac("sha256", secret).update(`${email}:${otp}`).digest("hex");
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

let transporter;
function getTransporter() {
  if (!transporter) {
    const user = process.env.GMAIL_USER;
    const pass = process.env.GMAIL_APP_PASSWORD;
    if (!user || !pass) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD missing.");
    transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  }
  return transporter;
}

async function sendOtpEmail(email, otp) {
  await getTransporter().sendMail({
    from: `"Shoppy" <${process.env.GMAIL_USER}>`,
    to: email,
    subject: "Your Shoppy verification code",
    text:
      `Your Shoppy verification code is ${otp}.\n` +
      `It is valid for 10 minutes. Do not share it with anyone.\n` +
      `If you did not request this, you can ignore this email.`,
    html:
      `<div style="font-family:Arial,sans-serif;max-width:420px">` +
      `<h2>Shoppy</h2><p>Your verification code is</p>` +
      `<p style="font-size:32px;letter-spacing:6px;font-weight:700">${otp}</p>` +
      `<p>Valid for 10 minutes. Do not share it with anyone.</p>` +
      `<p style="color:#777">If you did not request this, ignore this email.</p></div>`
  });
}

function fail(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

async function handleSend(req, res, email) {
  const db = getDatabase();
  const ref = db.ref(`emailOtps/${emailKey(email)}`);
  const now = Date.now();
  const otp = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  let blocked = null;

  // Atomic: cooldown + hourly limit are checked and the new OTP stored together.
  await ref.transaction(current => {
    blocked = null;
    const c = current || {};

    if (c.sentAt && now - c.sentAt < RESEND_COOLDOWN_MS) {
      blocked = {
        status: 429,
        message: "Please wait a minute before requesting another code.",
        retryAfter: Math.ceil((RESEND_COOLDOWN_MS - (now - c.sentAt)) / 1000)
      };
      return; // abort, keep current
    }

    const windowStart =
      c.windowStart && now - c.windowStart < 3600000 ? c.windowStart : now;
    const sendCount = windowStart === c.windowStart ? (c.sendCount || 0) : 0;

    if (sendCount >= MAX_SENDS_PER_HOUR) {
      blocked = { status: 429, message: "Too many codes requested. Please try again later." };
      return;
    }

    return {
      hash: hashOtp(email, otp),
      expiresAt: now + OTP_TTL_MS,
      attempts: 0,
      sentAt: now,
      windowStart,
      sendCount: sendCount + 1
    };
  });

  if (blocked) {
    return fail(res, blocked.status, blocked.message, { retryAfter: blocked.retryAfter });
  }

  try {
    await sendOtpEmail(email, otp);
  } catch (error) {
    console.error("OTP email failed:", error.message);
    await ref.remove().catch(() => {});
    return fail(res, 502, "Could not send the email. Please try again.");
  }

  return res.status(200).json({
    success: true,
    message: "Verification code sent to your email.",
    expiresInSeconds: OTP_TTL_MS / 1000,
    resendAfterSeconds: RESEND_COOLDOWN_MS / 1000
  });
}

async function handleVerify(req, res, email) {
  const otp = typeof req.body?.otp === "string" ? req.body.otp.trim() : "";

  if (!/^\d{6}$/.test(otp)) {
    return fail(res, 400, "Enter the 6-digit code sent to your email.");
  }

  const db = getDatabase();
  const key = emailKey(email);
  const ref = db.ref(`emailOtps/${key}`);
  const now = Date.now();
  let result = "none";

  await ref.transaction(current => {
    if (!current || !current.hash) {
      result = "none";
      return;
    }
    if (now > Number(current.expiresAt)) {
      result = "expired";
      return null;
    }
    if (Number(current.attempts) >= MAX_WRONG_ATTEMPTS) {
      result = "locked";
      return null;
    }
    if (safeEqualHex(current.hash, hashOtp(email, otp))) {
      result = "ok";
      return null; // OTP used up
    }
    result = "wrong";
    return { ...current, attempts: Number(current.attempts || 0) + 1 };
  });

  if (result === "ok") {
    await db.ref(`emailVerified/${key}`).set({
      verifiedAt: now,
      expiresAt: now + VERIFIED_TTL_MS
    });
    return res.status(200).json({
      success: true,
      message: "Email verified. You can complete sign up now."
    });
  }

  if (result === "wrong") return fail(res, 400, "Incorrect code. Please try again.");
  if (result === "locked") return fail(res, 429, "Too many wrong attempts. Request a new code.");
  return fail(res, 400, "Code expired or not found. Request a new code.");
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return fail(res, 405, "Method not allowed.");
  }

  const action = req.body?.action;
  const email = normalizeEmail(req.body?.email);

  if (action !== "send" && action !== "verify") {
    return fail(res, 400, 'action must be "send" or "verify".');
  }

  if (!email) {
    return fail(res, 400, "Please enter a valid email address.");
  }

  try {
    return action === "send"
      ? await handleSend(req, res, email)
      : await handleVerify(req, res, email);
  } catch (error) {
    console.error("otp error:", error.message);
    return fail(res, 500, "Something went wrong. Please try again.");
  }
}

/*
 * Use this in your SIGN-UP API, right before creating the account:
 *
 *   const { consumeEmailVerification } = require("./auth/otp");
 *   if (!(await consumeEmailVerification(email))) {
 *     return res.status(403).json({ success: false, message: "Please verify your email first." });
 *   }
 *
 * True only if this email was OTP-verified in the last 15 minutes.
 * One verification = one sign-up.
 */
async function consumeEmailVerification(email) {
  const clean = normalizeEmail(email);
  if (!clean) return false;

  const ref = getDatabase().ref(`emailVerified/${emailKey(clean)}`);
  let ok = false;

  await ref.transaction(current => {
    if (current && Number(current.expiresAt) > Date.now()) {
      ok = true;
      return null; // delete -> single use
    }
    ok = false;
    return current === null ? undefined : null; // clean an expired marker
  });

  return ok;
}

module.exports = handler;
module.exports.consumeEmailVerification = consumeEmailVerification;
