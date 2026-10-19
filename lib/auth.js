const crypto = require("crypto");

const COOKIE_NAME = "shop_session";
const SESSION_DURATION = 7 * 24 * 60 * 60;

function getSecret() {
  const secret = process.env.SESSION_SECRET;

  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 bytes");
  }

  return secret;
}

function sign(value) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(value)
    .digest("base64url");
}

function createSession(user) {
  const now = Math.floor(Date.now() / 1000);

  const payload = Buffer.from(
    JSON.stringify({
      uid: user.uid,
      iat: now,
      exp: now + SESSION_DURATION
    })
  ).toString("base64url");

  return `${payload}.${sign(payload)}`;
}

function verifySession(token) {
  if (typeof token !== "string" || token.length > 4096) {
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payload, signature] = parts;

  try {
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);

    if (
      expected.length !== received.length ||
      !crypto.timingSafeEqual(expected, received)
    ) {
      return null;
    }

    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    );

    const now = Math.floor(Date.now() / 1000);

    if (
      typeof data.uid !== "string" ||
      !data.uid ||
      !Number.isFinite(data.exp) ||
      data.exp <= now
    ) {
      return null;
    }

    return data;
  } catch {
    return null;
  }
}

async function setSessionCookie(res, user) {
  if (!user || typeof user.uid !== "string" || !user.uid) {
    throw new Error("Valid user information is required for the session");
  }

  const token = createSession(user);
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DURATION}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure =
    process.env.NODE_ENV === "production" ? "; Secure" : "";

  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function getSession(req) {
  const cookieHeader = req.headers.cookie || "";

  const item = cookieHeader
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE_NAME}=`));

  if (!item) return null;

  const token = item.slice(COOKIE_NAME.length + 1);

  return verifySession(token);
}

function emailHash(email) {
  return crypto
    .createHash("sha256")
    .update(email.trim().toLowerCase())
    .digest("hex");
}

function sendJson(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

module.exports = {
  setSessionCookie,
  clearSessionCookie,
  getSession,
  emailHash,
  sendJson
};
