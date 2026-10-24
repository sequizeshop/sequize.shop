"use strict";

const crypto = require("crypto");

const { db } = require("../lib/firebase");

const {
  getSession,
  emailHash,
  sendJson
} = require("../lib/auth");

/* =========================================
   CASHFREE CONFIGURATION
========================================= */

const CASHFREE_API_VERSION = "2023-08-01";

function cashfreeBase() {
  return (process.env.CASHFREE_ENV || "").trim() === "production"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";
}

function cashfreeHeaders() {
  const appId = (process.env.CASHFREE_APP_ID || "").trim();
  const secret = (process.env.CASHFREE_SECRET_KEY || "").trim();

  if (!appId || !secret) {
    throw new Error("Cashfree credentials are not configured.");
  }

  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-client-id": appId,
    "x-client-secret": secret,
    "x-api-version": CASHFREE_API_VERSION
  };
}

async function cashfreeRequest(path, method = "GET", body = null) {
  const response = await fetch(cashfreeBase() + path, {
    method,
    headers: cashfreeHeaders(),
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(
      "Cashfree API error:",
      response.status,
      data
    );

    throw new Error(
      "Cashfree payment service is temporarily unavailable."
    );
  }

  return data;
}

/* =========================================
   MEMBERSHIP PLANS
========================================= */

const MEMBERSHIP_PLANS = {
  trial: {
    name: "3-Day Trial",
    amount: 1,
    durationDays: 3,
    trial: true
  },

  monthly: {
    name: "Monthly",
    amount: 149,
    durationDays: 30,
    trial: false
  },

  quarterly: {
    name: "3 Months",
    amount: 299,
    durationDays: 90,
    trial: false
  },

  yearly: {
    name: "1 Year",
    amount: 699,
    durationDays: 365,
    trial: false
  }
};

/* =========================================
   GENERAL HELPERS
========================================= */

function normalizePhone(phone) {
  return String(phone || "").replace(/\D/g, "");
}

function validPhone(phone) {
  return /^[6-9]\d{9}$/.test(phone);
}

function activeMembership(membership) {
  return Boolean(
    membership &&
    membership.status === "active" &&
    Number(membership.expiresAt) > Date.now()
  );
}

/* =========================================
   EXISTING AUTHENTICATION
   Preserve session and blocked-user checks
========================================= */

async function getAuthenticatedUser(req) {
  const session = getSession(req);

  if (!session) {
    const error = new Error("Please sign in first.");

    error.status = 401;
    error.redirect = "/login.html";

    throw error;
  }

  const snapshot = await db
    .ref(`users/${session.uid}`)
    .get();

  const user = snapshot.val();

  if (!user || user.status !== "active") {
    const error = new Error("Please sign in again.");

    error.status = 401;
    error.redirect = "/login.html";

    throw error;
  }

  if (user.email) {
    const hash = emailHash(user.email);

    const blocked = await db
      .ref(`blockedUsers/${hash}/blocked`)
      .get();

    if (blocked.val() === true) {
      const error = new Error(
        "This account is unavailable."
      );

      error.status = 403;

      throw error;
    }
  }

  return {
    uid: session.uid,
    user
  };
}

/* =========================================
   MEMBERSHIP STATUS
========================================= */

async function getMembership(uid) {
  const membershipRef = db.ref(
    `users/${uid}/membership`
  );

  const snapshot = await membershipRef.get();

  const membership = snapshot.val() || {};

  if (activeMembership(membership)) {
    return membership;
  }

  if (membership.status === "active") {
    await membershipRef.update({
      status: "expired",
      updatedAt: Date.now()
    });

    membership.status = "expired";
  }

  return membership;
}

/* =========================================
   CREATE MEMBERSHIP PAYMENT
========================================= */

async function createMembershipPayment(uid, user, body) {
  const planId = String(body.plan || "").toLowerCase();

  const plan = MEMBERSHIP_PLANS[planId];

  if (!plan) {
    const error = new Error(
      "Please select a valid membership plan."
    );

    error.status = 400;

    throw error;
  }

  const phone = normalizePhone(body.phone);

  if (!validPhone(phone)) {
    const error = new Error(
      "Please enter a valid 10-digit mobile number."
    );

    error.status = 400;

    throw error;
  }

  const membershipRef = db.ref(
    `users/${uid}/membership`
  );

  const membershipSnapshot = await membershipRef.get();

  const membership = membershipSnapshot.val() || {};

  /* Trial can only be used once */

  if (plan.trial && membership.trialUsed === true) {
    const error = new Error(
      "Your one-time trial has already been used."
    );

    error.status = 400;

    throw error;
  }

  const email = String(user.email || "").trim();

  if (!email) {
    const error = new Error(
      "Your account does not have an email address."
    );

    error.status = 400;

    throw error;
  }

  const paymentId =
    "shoppy_mem_" +
    crypto.randomUUID().replace(/-/g, "");

  const amountPaise = Math.round(
    plan.amount * 100
  );

  const paymentRef = db.ref(
    `membershipPayments/${paymentId}`
  );

  const paymentRecord = {
    paymentId: paymentId,
    uid: uid,

    plan: planId,
    planName: plan.name,

    amount: plan.amount,
    amountPaise: amountPaise,

    durationDays: plan.durationDays,
    trial: plan.trial,

    status: "CREATING",

    createdAt: Date.now()
  };

  await paymentRef.set(paymentRecord);

  try {
    const siteUrl = (
      process.env.SITE_URL || ""
    ).trim().replace(/\/+$/, "");

    const orderBody = {
      order_id: paymentId,

      order_amount: plan.amount,

      order_currency: "INR",

      customer_details: {
        customer_id: uid,

        customer_name: String(
          user.name || "Shoppy Customer"
        ).slice(0, 100),

        customer_email: email,

        customer_phone: phone
      },

      order_note:
        `Shoppy Premium Membership - ${plan.name}`
    };

    if (siteUrl) {
      orderBody.order_meta = {
        return_url:
          `${siteUrl}/membership.html` +
          `?paymentId=${encodeURIComponent(paymentId)}`
      };
    }

    const order = await cashfreeRequest(
      "/orders",
      "POST",
      orderBody
    );

    if (!order.payment_session_id) {
      throw new Error(
        "Cashfree did not return a payment session."
      );
    }

    await paymentRef.update({
      status: "PENDING",

      cashfreeOrderId:
        order.order_id || paymentId,

      updatedAt: Date.now()
    });

    return {
      success: true,

      paymentId: paymentId,

      paymentSessionId:
        order.payment_session_id,

      plan: plan.name,

      amount: plan.amount,

      paymentStatus: "PENDING"
    };
  } catch (error) {
    await paymentRef.update({
      status: "CREATE_FAILED",
      updatedAt: Date.now()
    });

    throw error;
  }
}

/* =========================================
   VERIFY MEMBERSHIP PAYMENT
========================================= */

async function verifyMembershipPayment(uid, paymentId) {
  if (
    typeof paymentId !== "string" ||
    !/^shoppy_mem_[a-f0-9]+$/i.test(paymentId)
  ) {
    const error = new Error(
      "Invalid membership payment ID."
    );

    error.status = 400;

    throw error;
  }

  const paymentRef = db.ref(
    `membershipPayments/${paymentId}`
  );

  const paymentSnapshot = await paymentRef.get();

  const payment = paymentSnapshot.val();

  if (!payment || payment.uid !== uid) {
    const error = new Error(
      "Membership payment was not found."
    );

    error.status = 404;

    throw error;
  }

  if (payment.status === "AMOUNT_MISMATCH") {
    return {
      success: true,
      paymentStatus: "AMOUNT_MISMATCH"
    };
  }

  /*
   * Check Cashfree's server-side order status.
   * Frontend success alone never activates membership.
   */

  const cashfreeOrder = await cashfreeRequest(
    `/orders/${encodeURIComponent(paymentId)}`
  );

  const orderStatus = String(
    cashfreeOrder.order_status || ""
  ).toUpperCase();

  if (orderStatus !== "PAID") {
    if (
      orderStatus === "EXPIRED" ||
      orderStatus === "TERMINATED"
    ) {
      await paymentRef.update({
        status: "FAILED",
        updatedAt: Date.now()
      });

      return {
        success: true,
        paymentStatus: "FAILED"
      };
    }

    return {
      success: true,
      paymentStatus: "PENDING"
    };
  }

  /*
   * Verify amount and currency before activation.
   */

  const paidPaise = Math.round(
    Number(cashfreeOrder.order_amount) * 100
  );

  if (
    !Number.isFinite(paidPaise) ||
    paidPaise !== Number(payment.amountPaise) ||
    String(
      cashfreeOrder.order_currency || ""
    ).toUpperCase() !== "INR"
  ) {
    await paymentRef.update({
      status: "AMOUNT_MISMATCH",
      updatedAt: Date.now()
    });

    return {
      success: true,
      paymentStatus: "AMOUNT_MISMATCH"
    };
  }

  /*
   * Transaction protects against activating the
   * same payment more than once.
   */

  const membershipRef = db.ref(
    `users/${uid}/membership`
  );

  const now = Date.now();

  const transaction = await membershipRef.transaction(
    current => {
      current = current || {};

      const processedPayments =
        current.processedPayments || {};

      if (processedPayments[paymentId]) {
        return current;
      }

      /*
       * A trial that was already consumed cannot
       * be activated again.
       */

      if (
        payment.trial &&
        current.trialUsed === true
      ) {
        return;
      }

      const currentExpiry =
        current.status === "active" &&
        Number(current.expiresAt) > now
          ? Number(current.expiresAt)
          : now;

      const expiresAt =
        currentExpiry +
        Number(payment.durationDays) *
        24 * 60 * 60 * 1000;

      current.status = "active";

      current.plan = payment.plan;
      current.planName = payment.planName;

      current.startedAt = currentExpiry;
      current.expiresAt = expiresAt;

      current.updatedAt = now;

      current.lastPaymentId = paymentId;
      current.lastPaymentStatus = "PAID";

      current.processedPayments = processedPayments;
      current.processedPayments[paymentId] = true;

      if (payment.trial) {
        current.trialUsed = true;
      }

      return current;
    }
  );

  if (!transaction.committed) {
    await paymentRef.update({
      status: "ACTIVATION_CONFLICT",
      updatedAt: Date.now()
    });

    return {
      success: true,
      paymentStatus: "FAILED",
      message:
        "Membership could not be activated. Please contact support."
    };
  }

  const finalMembership =
    transaction.snapshot.val();

  if (
    !finalMembership ||
    !finalMembership.processedPayments ||
    !finalMembership.processedPayments[paymentId]
  ) {
    return {
      success: true,
      paymentStatus: "FAILED"
    };
  }

  /*
   * Mark the payment record only after membership
   * activation has been confirmed.
   */

  await paymentRef.update({
    status: "PAID",
    paidAt: now,
    updatedAt: now
  });

  return {
    success: true,
    paymentStatus: "PAID",
    membership: finalMembership
  };
}

/* =========================================
   MAIN PROFILE API
   Existing GET + additional POST actions
========================================= */

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  try {
    /*
     * Existing authentication and account checks
     * apply to both profile and membership actions.
     */

    const { uid, user } =
      await getAuthenticatedUser(req);

    /* -----------------------------------------
       EXISTING GET PROFILE API
       Original fields preserved.
       Membership is additional data.
    ----------------------------------------- */

    if (req.method === "GET") {
      const membership = await getMembership(uid);

      return sendJson(res, 200, {
        success: true,

        user: {
          uid: user.uid,
          name: user.name,
          email: user.email,
          createdAt: user.createdAt
        },

        membership: {
          active: activeMembership(membership),

          status:
            membership.status || "inactive",

          plan:
            membership.plan || null,

          planName:
            membership.planName || null,

          startedAt:
            membership.startedAt || null,

          expiresAt:
            membership.expiresAt || null,

          trialUsed:
            membership.trialUsed === true
        }
      });
    }

    /* -----------------------------------------
       ADDITIONAL POST API ACTIONS
    ----------------------------------------- */

    if (req.method === "POST") {
      let body = req.body;

      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          body = {};
        }
      }

      body =
        body && typeof body === "object"
          ? body
          : {};

      /*
       * Create Cashfree membership payment.
       */

      if (
        body.action === "create-membership-payment"
      ) {
        const result =
          await createMembershipPayment(
            uid,
            user,
            body
          );

        return sendJson(res, 200, result);
      }

      /*
       * Verify Cashfree payment and activate
       * membership after server-side verification.
       */

      if (
        body.action === "verify-membership-payment"
      ) {
        const result =
          await verifyMembershipPayment(
            uid,
            body.paymentId
          );

        return sendJson(res, 200, result);
      }

      return sendJson(res, 400, {
        success: false,
        message: "Unknown profile action."
      });
    }

    res.setHeader("Allow", "GET, POST");

    return sendJson(res, 405, {
      success: false,
      message: "Method not allowed."
    });
  } catch (error) {
    console.error(
      "Profile API error:",
      error
    );

    return sendJson(
      res,
      error.status || 500,
      {
        success: false,

        message:
          error.message ||
          "Unable to process your request.",

        ...(error.redirect
          ? { redirect: error.redirect }
          : {})
      }
    );
  }
};
