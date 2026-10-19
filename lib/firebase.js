const admin = require("firebase-admin");

function getFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (!serviceAccountJson) {
    throw new Error("Firebase credentials are not configured");
  }

  const serviceAccount = JSON.parse(serviceAccountJson);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL:
      "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app",
  });

  return admin;
}

module.exports = getFirebaseAdmin;
