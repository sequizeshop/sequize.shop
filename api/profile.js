const { db } = require("../lib/firebase");
const {
  getSession,
  emailHash,
  sendJson
} = require("../lib/auth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  try {
    const session = getSession(req);

    if (!session) {
      return sendJson(res, 401, {
        success: false,
        message: "Please sign in first.",
        redirect: "/login.html"
      });
    }

    const snapshot = await db.ref(`users/${session.uid}`).get();
    const user = snapshot.val();

    if (!user || user.status !== "active") {
      return sendJson(res, 401, {
        success: false,
        message: "Please sign in again.",
        redirect: "/login.html"
      });
    }

    const hash = emailHash(user.email);
    const blocked = await db.ref(`blockedUsers/${hash}/blocked`).get();

    if (blocked.val() === true) {
      return sendJson(res, 403, {
        success: false,
        message: "This account is unavailable."
      });
    }

    return sendJson(res, 200, {
      success: true,
      user: {
        uid: user.uid,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    console.error("Profile API error:", error);

    return sendJson(res, 500, {
      success: false,
      message: "Unable to load your profile."
    });
  }
};
