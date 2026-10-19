const {
  clearSessionCookie,
  sendJson
} = require("../lib/auth");

module.exports = function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  }

  clearSessionCookie(res);

  return sendJson(res, 200, {
    success: true,
    message: "Logged out successfully.",
    redirect: "/login.html"
  });
};
