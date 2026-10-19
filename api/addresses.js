
const admin = require("firebase-admin");
const { getSession } = require("../lib/auth");

const DATABASE_URL =
  "https://shoppy-c289d-default-rtdb.asia-southeast1.firebasedatabase.app";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE"];
const ADDRESS_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const ADDRESS_TYPES = ["Home", "Work", "Other"];

const FIELD_LIMITS = {
  fullName: 100,
  phone: 20,
  alternatePhone: 20,
  pincode: 6,
  postOffice: 120,
  houseNumber: 150,
  building: 150,
  area: 200,
  landmark: 200,
  city: 100,
  district: 100,
  state: 100,
  country: 100,
  deliveryInstructions: 500
};

/* FIREBASE INITIALIZATION */

function getDatabase() {
  if (!admin.apps.length) {
    const serviceAccountText =
      process.env.FIREBASE_SERVICE_ACCOUNT;

    if (!serviceAccountText) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT is missing.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(
        JSON.parse(serviceAccountText)
      ),
      databaseURL: DATABASE_URL
    });
  }

  return admin.database();
}

/* RESPONSE HELPERS */

function sendError(res, status, message) {
  return res.status(status).json({
    success: false,
    message
  });
}

function getRequestBody(req) {
  if (
    req.body &&
    typeof req.body === "object" &&
    !Array.isArray(req.body)
  ) {
    return req.body;
  }

  return {};
}

function cleanString(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function isValidAddressId(id) {
  return (
    typeof id === "string" &&
    ADDRESS_ID_PATTERN.test(id)
  );
}

function getAddressId(body) {
  return cleanString(body.id, 128);
}

/* ADDRESS VALIDATION */

function validateAddress(body) {
  const address = {};

  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    address[field] = cleanString(body[field], limit);
  }

  address.isDefault = body.isDefault === true;

  address.addressType = ADDRESS_TYPES.includes(body.addressType)
    ? body.addressType
    : "Home";

  const requiredFields = [
    ["fullName", "Full name required hai."],
    ["phone", "Mobile number required hai."],
    ["pincode", "PIN code required hai."],
    ["postOffice", "Post office select karein."],
    ["houseNumber", "House/flat number required hai."],
    ["area", "Area/locality required hai."],
    ["city", "City required hai."],
    ["state", "State required hai."],
    ["country", "Country required hai."]
  ];

  for (const [field, message] of requiredFields) {
    if (!address[field]) {
      return { error: message };
    }
  }

  if (
    address.fullName.length < 2 ||
    address.fullName.length > 100
  ) {
    return {
      error: "Full name 2 se 100 characters ke beech hona chahiye."
    };
  }

  if (!/^[6-9]\d{9}$/.test(address.phone)) {
    return {
      error: "Valid 10-digit Indian mobile number enter karein."
    };
  }

  if (
    address.alternatePhone &&
    !/^[6-9]\d{9}$/.test(address.alternatePhone)
  ) {
    return {
      error: "Alternate mobile number valid nahi hai."
    };
  }

  if (!/^\d{6}$/.test(address.pincode)) {
    return {
      error: "PIN code 6 digits ka hona chahiye."
    };
  }

  if (
    address.alternatePhone &&
    address.alternatePhone === address.phone
  ) {
    address.alternatePhone = "";
  }

  return { address };
}

/* FORMAT ADDRESS LIST */

function formatAddresses(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return [];
  }

  return Object.entries(value)
    .filter(([id, item]) => (
      isValidAddressId(id) &&
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      item.id === id
    ))
    .map(([id, item]) => ({
      id,
      fullName: String(item.fullName || ""),
      phone: String(item.phone || ""),
      alternatePhone: String(item.alternatePhone || ""),
      pincode: String(item.pincode || ""),
      postOffice: String(item.postOffice || ""),
      houseNumber: String(item.houseNumber || ""),
      building: String(item.building || ""),
      area: String(item.area || ""),
      landmark: String(item.landmark || ""),
      city: String(item.city || ""),
      district: String(item.district || ""),
      state: String(item.state || ""),
      country: String(item.country || ""),
      deliveryInstructions: String(
        item.deliveryInstructions || ""
      ),
      addressType: ADDRESS_TYPES.includes(item.addressType)
        ? item.addressType
        : "Home",
      isDefault: item.isDefault === true,
      createdAt: Number(item.createdAt) || 0,
      updatedAt: Number(item.updatedAt) || 0
    }))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) {
        return a.isDefault ? -1 : 1;
      }

      return b.createdAt - a.createdAt;
    });
}

/* ADDRESS API */

module.exports = async function handler(req, res) {
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  res.setHeader("Cache-Control", "private, no-store");

  if (!ALLOWED_METHODS.includes(req.method)) {
    res.setHeader(
      "Allow",
      ALLOWED_METHODS.join(", ")
    );

    return sendError(
      res,
      405,
      "Ye request method allowed nahi hai."
    );
  }

  try {
    /* AUTHENTICATION */

    const session = await getSession(req);

    if (!session || !session.uid) {
      return sendError(
        res,
        401,
        "Addresses manage karne ke liye pehle login karein."
      );
    }

    const db = getDatabase();

    const addressesRef = db
      .ref("users")
      .child(String(session.uid))
      .child("addresses");

    /* GET: LOAD SAVED ADDRESSES */

    if (req.method === "GET") {
      const snapshot = await addressesRef.once("value");
      const addresses = formatAddresses(snapshot.val());

      return res.status(200).json({
        success: true,
        total: addresses.length,
        addresses
      });
    }

    const body = getRequestBody(req);

    /* POST: SAVE A NEW ADDRESS */

    if (req.method === "POST") {
      const validation = validateAddress(body);

      if (validation.error) {
        return sendError(res, 400, validation.error);
      }

      const address = validation.address;
      const addressRef = addressesRef.push();
      const id = addressRef.key;
      const now = Date.now();

      /*
       * Use a transaction when marking an address as default
       * so existing addresses are unset in the same update.
       */
      if (address.isDefault) {
        const result = await addressesRef.transaction(current => {
          const all = (
            current &&
            typeof current === "object" &&
            !Array.isArray(current)
          )
            ? current
            : {};

          const updated = {};

          for (const [existingId, existing] of Object.entries(all)) {
            if (
              existing &&
              typeof existing === "object" &&
              !Array.isArray(existing)
            ) {
              updated[existingId] = {
                ...existing,
                isDefault: false
              };
            } else {
              updated[existingId] = existing;
            }
          }

          updated[id] = {
            id,
            ...address,
            createdAt: now,
            updatedAt: now
          };

          return updated;
        });

        if (!result.committed) {
          return sendError(
            res,
            409,
            "Address save nahi ho paya. Dobara try karein."
          );
        }
      } else {
        await addressRef.set({
          id,
          ...address,
          createdAt: now,
          updatedAt: now
        });
      }

      const savedSnapshot = await addressRef.once("value");

      return res.status(201).json({
        success: true,
        message: "Address successfully save ho gaya.",
        address: savedSnapshot.val()
      });
    }

    /* PUT: UPDATE AN EXISTING ADDRESS */

    if (req.method === "PUT") {
      const id = getAddressId(body);

      if (!isValidAddressId(id)) {
        return sendError(
          res,
          400,
          "Valid address ID required hai."
        );
      }

      const validation = validateAddress(body);

      if (validation.error) {
        return sendError(res, 400, validation.error);
      }

      const addressRef = addressesRef.child(id);
      const existingSnapshot = await addressRef.once("value");

      if (!existingSnapshot.exists()) {
        return sendError(res, 404, "Address nahi mila.");
      }

      const existing = existingSnapshot.val();

      if (
        !existing ||
        typeof existing !== "object" ||
        existing.id !== id
      ) {
        return sendError(res, 404, "Address nahi mila.");
      }

      const address = validation.address;
      const now = Date.now();

      if (address.isDefault) {
        const result = await addressesRef.transaction(current => {
          if (
            !current ||
            typeof current !== "object" ||
            !current[id] ||
            current[id].id !== id
          ) {
            return;
          }

          const updated = {};

          for (const [existingId, item] of Object.entries(current)) {
            if (
              item &&
              typeof item === "object" &&
              !Array.isArray(item)
            ) {
              updated[existingId] = {
                ...item,
                isDefault: false
              };
            } else {
              updated[existingId] = item;
            }
          }

          updated[id] = {
            ...updated[id],
            ...address,
            id,
            createdAt: Number(existing.createdAt) || now,
            updatedAt: now
          };

          return updated;
        });

        if (!result.committed) {
          return sendError(
            res,
            409,
            "Address update nahi ho paya. Dobara try karein."
          );
        }
      } else {
        await addressRef.update({
          ...address,
          id,
          isDefault: false,
          createdAt: Number(existing.createdAt) || now,
          updatedAt: now
        });
      }

      const updatedSnapshot = await addressRef.once("value");

      return res.status(200).json({
        success: true,
        message: "Address successfully update ho gaya.",
        address: updatedSnapshot.val()
      });
    }

    /* DELETE: REMOVE AN ADDRESS */

    if (req.method === "DELETE") {
      const id = getAddressId(body);

      if (!isValidAddressId(id)) {
        return sendError(
          res,
          400,
          "Valid address ID required hai."
        );
      }

      const addressRef = addressesRef.child(id);
      const snapshot = await addressRef.once("value");

      if (!snapshot.exists()) {
        return sendError(res, 404, "Address nahi mila.");
      }

      await addressRef.remove();

      const updatedSnapshot = await addressesRef.once("value");
      const addresses = formatAddresses(updatedSnapshot.val());

      return res.status(200).json({
        success: true,
        message: "Address delete ho gaya.",
        total: addresses.length,
        addresses
      });
    }
  } catch (error) {
    console.error("Addresses API error:", error);

    return sendError(
      res,
      500,
      "Address operation complete nahi ho paya. Dobara try karein."
    );
  }
};
