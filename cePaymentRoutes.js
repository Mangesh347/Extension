/**
 * Claude Enhancer Pro — PayPal + Razorpay routes
 * Both gateways follow PAYMENT_TEST_MODE:
 *   true  → PayPal sandbox + Razorpay rzp_test_* keys
 *   false → PayPal live + Razorpay rzp_live_* keys
 * Prices: $4 / $40 / $80 + 18% GST (matches extension).
 */

const crypto = require("crypto");
const path = require("path");
const { sendPaymentReceiptEmail, sendLifetimeThanksEmail } = require("./ceMail");

const GST_RATE = 0.18;
const PLANS = {
  monthly: { priceUSD: 4, days: 30, desc: "Claude Enhancer Pro — Monthly" },
  yearly: { priceUSD: 40, days: 365, desc: "Claude Enhancer Pro — Yearly" },
  lifetime: { priceUSD: 80, days: null, desc: "Claude Enhancer Pro — Lifetime" }
};
const INR_RATE = Number(process.env.INR_USD_RATE || 83.5);

function round2(n) {
  return Math.round(n * 100) / 100;
}

function quoteUSD(cycle) {
  const plan = PLANS[cycle] || PLANS.yearly;
  const subtotal = plan.priceUSD;
  const gst = round2(subtotal * GST_RATE);
  return {
    cycle: cycle in PLANS ? cycle : "yearly",
    subtotal,
    gst,
    total: round2(subtotal + gst),
    desc: plan.desc,
    days: plan.days
  };
}

function quoteINR(cycle) {
  const usd = quoteUSD(cycle);
  const subtotal = round2(usd.subtotal * INR_RATE);
  const gst = round2(subtotal * GST_RATE);
  const total = round2(subtotal + gst);
  return { ...usd, currency: "INR", subtotal, gst, total, amountPaise: Math.round(total * 100) };
}

function expiresAt(cycle) {
  const plan = PLANS[cycle] || PLANS.yearly;
  if (!plan.days) return null;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + plan.days);
  return d.toISOString();
}

function licenseKey() {
  const s = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `CE-PRO-${s()}-${s()}-${s()}`;
}

function hashEmail(email) {
  return crypto.createHash("sha256").update(String(email || "").toLowerCase().trim()).digest("hex");
}

function envTrim(name) {
  const v = process.env[name];
  if (v == null) return "";
  const s = String(v).trim();
  if (!s || /paste_here|YOUR_PROJECT|xxxxx|optional/i.test(s)) return "";
  return s;
}

/** true = sandbox / test keys for PayPal + Razorpay.
 * Hard lock: live payments require ALLOW_LIVE_PAYMENTS=true AND PAYMENT_TEST_MODE=false.
 * Until you flip ALLOW_LIVE_PAYMENTS, everything stays in TEST mode.
 */
function isTestMode() {
  const allowLive = String(process.env.ALLOW_LIVE_PAYMENTS || "false").toLowerCase() === "true";
  if (!allowLive) return true;
  return String(process.env.PAYMENT_TEST_MODE || "true").toLowerCase() !== "false";
}

/**
 * Resolve PayPal + Razorpay credentials from PAYMENT_TEST_MODE.
 * Never returns live Razorpay keys while isTestMode() is true.
 */
function getPaymentCreds() {
  const test = isTestMode();

  if (test) {
    let razorpayKeyId = envTrim("RAZORPAY_TEST_KEY_ID");
    let razorpayKeySecret = envTrim("RAZORPAY_TEST_KEY_SECRET");

    // Only accept generic KEY_ID if it is already a test key — never live
    const genericId = envTrim("RAZORPAY_KEY_ID");
    const genericSecret = envTrim("RAZORPAY_KEY_SECRET");
    if (!razorpayKeyId && genericId.startsWith("rzp_test_")) {
      razorpayKeyId = genericId;
      razorpayKeySecret = razorpayKeySecret || genericSecret;
    }

    // Explicitly ignore live keys in test mode (do not fall back)
    if (razorpayKeyId.startsWith("rzp_live_")) {
      razorpayKeyId = "";
      razorpayKeySecret = "";
    }

    return {
      test: true,
      label: "test",
      paypal: {
        clientId: envTrim("PAYPAL_TEST_CLIENT_ID") || envTrim("PAYPAL_CLIENT_ID"),
        clientSecret: envTrim("PAYPAL_TEST_CLIENT_SECRET") || envTrim("PAYPAL_CLIENT_SECRET"),
        apiMode: "sandbox",
        apiBase: "https://api-m.sandbox.paypal.com"
      },
      razorpay: {
        keyId: razorpayKeyId,
        keySecret: razorpayKeySecret,
        usingLiveKeys: false,
        usingTestKeys: String(razorpayKeyId).startsWith("rzp_test_")
      }
    };
  }

  const razorpayKeyId =
    envTrim("RAZORPAY_LIVE_KEY_ID") ||
    (envTrim("RAZORPAY_KEY_ID").startsWith("rzp_live_") ? envTrim("RAZORPAY_KEY_ID") : "") ||
    "";
  const razorpayKeySecret =
    envTrim("RAZORPAY_LIVE_KEY_SECRET") ||
    (String(razorpayKeyId).startsWith("rzp_live_") ? envTrim("RAZORPAY_KEY_SECRET") : "") ||
    "";

  return {
    test: false,
    label: "live",
    paypal: {
      clientId: envTrim("PAYPAL_LIVE_CLIENT_ID") || envTrim("PAYPAL_CLIENT_ID"),
      clientSecret: envTrim("PAYPAL_LIVE_CLIENT_SECRET") || envTrim("PAYPAL_CLIENT_SECRET"),
      apiMode: "live",
      apiBase: "https://api-m.paypal.com"
    },
    razorpay: {
      keyId: razorpayKeyId,
      keySecret: razorpayKeySecret,
      usingLiveKeys: String(razorpayKeyId).startsWith("rzp_live_"),
      usingTestKeys: false
    }
  };
}

/** Create Razorpay order via REST (test or live key) */
async function createRazorpayOrderRest({ keyId, keySecret, amountPaise, receipt, notes }) {
  const id = String(keyId || "").trim();
  const secret = String(keySecret || "").trim();
  if (!id.startsWith("rzp_test_") && !id.startsWith("rzp_live_")) {
    throw new Error("Invalid Razorpay Key ID — must start with rzp_test_ or rzp_live_");
  }
  const auth = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      receipt,
      notes: notes || {}
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.description || data?.error?.reason || data?.message || `Razorpay order failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

function allowSimulated() {
  return String(process.env.ALLOW_SIMULATED_CHECKOUT || "true").toLowerCase() !== "false";
}

async function recordEntitlement({ email, paymentId, provider, cycle, amount, currency, license, expires, gst, subtotal, test }) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !email) {
    console.warn("[CE Pay] entitlement skip — missing SUPABASE_URL / SERVICE_ROLE_KEY / email");
    // #region agent log
    fetch("http://127.0.0.1:7652/ingest/113581e5-ff03-4b98-9529-daa3d76e3789", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a325af" },
      body: JSON.stringify({
        sessionId: "a325af",
        runId: "pro-unlock",
        hypothesisId: "P2",
        location: "cePaymentRoutes.js:recordEntitlement",
        message: "Entitlement write skipped",
        data: { hasUrl: !!url, hasKey: !!key, hasEmail: !!email, provider },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch(`${url}/rest/v1/entitlement_events`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        event_type: "payment_captured",
        payment_id: paymentId,
        email_hash: hashEmail(email),
        status: "active",
        metadata: {
          provider,
          plan: "pro",
          cycle,
          amount,
          currency,
          gst,
          subtotal,
          licenseKey: license,
          expiresAt: expires,
          email: String(email).toLowerCase().trim(),
          paymentMode: test ? "test" : "live",
          activatedAt: new Date().toISOString()
        },
        created_at: new Date().toISOString()
      })
    });
    // #region agent log
    fetch("http://127.0.0.1:7652/ingest/113581e5-ff03-4b98-9529-daa3d76e3789", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "a325af" },
      body: JSON.stringify({
        sessionId: "a325af",
        runId: "pro-unlock",
        hypothesisId: "P2",
        location: "cePaymentRoutes.js:recordEntitlement",
        message: "Entitlement write result",
        data: {
          ok: res.ok,
          status: res.status,
          provider,
          email: String(email).toLowerCase().trim().replace(/^(.{2}).*(@.*)$/, "$1***$2"),
          cycle
        },
        timestamp: Date.now()
      })
    }).catch(() => {});
    // #endregion
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn("[CE Pay] entitlement insert failed:", res.status, t.slice(0, 200));
      return { ok: false, status: res.status };
    }

    /* Keep profiles.plan in sync when this email already has a Supabase auth user */
    try {
      const authRes = await fetch(
        `${url}/auth/v1/admin/users?filter=${encodeURIComponent(String(email).toLowerCase().trim())}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } }
      );
      if (authRes.ok) {
        const data = await authRes.json();
        const userId = data?.users?.[0]?.id;
        if (userId) {
          const nowIso = new Date().toISOString();
          await fetch(`${url}/rest/v1/profiles`, {
            method: "POST",
            headers: {
              apikey: key,
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              Prefer: "resolution=merge-duplicates"
            },
            body: JSON.stringify({
              user_id: userId,
              email: String(email).toLowerCase().trim(),
              plan: "pro",
              plan_started_at: nowIso,
              cycle_start_date: nowIso,
              updated_at: nowIso,
              created_at: nowIso
            })
          });
          const providerNorm =
            String(provider || "").includes("paypal") ? "paypal" :
            String(provider || "").includes("razorpay") ? "razorpay" : null;
          if (providerNorm && paymentId) {
            await fetch(`${url}/rest/v1/payments`, {
              method: "POST",
              headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                "Content-Type": "application/json",
                Prefer: "resolution=merge-duplicates"
              },
              body: JSON.stringify({
                user_id: userId,
                provider: providerNorm,
                provider_payment_id: paymentId,
                amount: amount != null ? amount : null,
                currency: currency || null,
                status: "verified",
                plan_purchased: cycle || "yearly",
                verified_at: nowIso
              })
            });
          }
        }
      }
    } catch (profileErr) {
      console.warn("[CE Pay] profile upgrade after payment:", profileErr.message);
    }

    return { ok: true };
  } catch (e) {
    console.warn("[CE Pay] entitlement:", e.message);
    return { ok: false, error: e.message };
  }
}

/** After payment verified: write Supabase + email receipt. Never blocks unlock on mail failure. */
async function fulfillProPurchase(args) {
  const recorded = await recordEntitlement(args);
  let mail = { ok: false };
  try {
    if (args.cycle === "lifetime") {
      mail = await sendLifetimeThanksEmail({
        email: args.email,
        amount: args.amount,
        currency: args.currency
      });
    } else {
      mail = await sendPaymentReceiptEmail({
        email: args.email,
        cycle: args.cycle,
        expiresAt: args.expires,
        licenseKey: args.license,
        amount: args.amount,
        currency: args.currency,
        provider: args.provider,
        paymentId: args.paymentId,
        gst: args.gst,
        test: args.test
      });
    }
    // If this email already had a prior entitlement, also send "renewed" (best-effort)
    if (args.cycle !== "lifetime" && recorded?.ok) {
      /* receipt already covers first purchase; skip duplicate renewed */
    }
  } catch (err) {
    console.warn("[CE Pay] receipt email:", err.message);
  }
  return { recorded, mail };
}

function mountCePayments(app) {
  app.get("/checkout", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "checkout.html"));
  });

  app.post("/api/paypal/create-order", async (req, res) => {
    try {
      const cycle = req.body?.cycle || "yearly";
      const email = String(req.body?.email || "").toLowerCase().trim();
      const quote = quoteUSD(cycle);
      const creds = getPaymentCreds();
      const { clientId, clientSecret, apiBase, apiMode } = creds.paypal;
      const wantSim = req.body?.simulate === true || (!clientId || !clientSecret);

      if (wantSim) {
        if (!allowSimulated() && !creds.test) {
          return res.status(503).json({ error: "PayPal live credentials missing" });
        }
        return res.json({
          success: true,
          order_id: `SIM_PP_ORDER_${Date.now()}`,
          amount: quote.total.toFixed(2),
          currency: "USD",
          quote,
          mode: "simulated_preview",
          payment_mode: creds.label
        });
      }

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials"
      });
      if (!tokenRes.ok) return res.status(502).json({ error: "PayPal OAuth failed" });
      const { access_token } = await tokenRes.json();

      const orderRes = await fetch(`${apiBase}/v2/checkout/orders`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            description: `${quote.desc} (incl. GST)`,
            custom_id: JSON.stringify({ email, plan: "pro", cycle: quote.cycle, mode: creds.label }),
            amount: { currency_code: "USD", value: quote.total.toFixed(2) }
          }],
          application_context: {
            brand_name: "Claude Enhancer",
            user_action: "PAY_NOW",
            return_url: `https://extension-six-alpha.vercel.app/checkout.html?paid=paypal&mode=${creds.label}`,
            cancel_url: "https://extension-six-alpha.vercel.app/checkout.html?cancel=1"
          }
        })
      });
      const orderData = await orderRes.json();
      if (!orderRes.ok) return res.status(orderRes.status).json({ error: orderData.message || "Order failed" });
      const approve = (orderData.links || []).find((l) => l.rel === "approve")?.href;
      return res.json({
        success: true,
        order_id: orderData.id,
        amount: quote.total.toFixed(2),
        currency: "USD",
        quote,
        approve_url: approve || null,
        mode: apiMode,
        payment_mode: creds.label
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/paypal/capture-order", async (req, res) => {
    try {
      const { order_id, email = "", cycle = "yearly" } = req.body || {};
      if (!order_id) return res.status(400).json({ error: "order_id required" });
      const quote = quoteUSD(cycle);
      const exp = expiresAt(cycle);
      const key = licenseKey();
      const billingEmail = String(email || "").toLowerCase().trim();
      const creds = getPaymentCreds();
      const { clientId, clientSecret, apiBase } = creds.paypal;
      const isSim = String(order_id).startsWith("SIM_") || req.body?.simulate === true;

      if (isSim || !clientId || !clientSecret) {
        const fulfilled = await fulfillProPurchase({
          email: billingEmail,
          paymentId: order_id,
          provider: "paypal",
          cycle: quote.cycle,
          amount: quote.total,
          currency: "USD",
          license: key,
          expires: exp,
          gst: quote.gst,
          subtotal: quote.subtotal,
          test: creds.test
        });
        return res.json({
          success: true,
          licenseKey: key,
          email: billingEmail,
          cycle: quote.cycle,
          expiresAt: exp,
          payment_mode: creds.label,
          receiptEmailed: Boolean(fulfilled.mail?.ok && !fulfilled.mail?.skipped),
          redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(billingEmail)}&key=${encodeURIComponent(key)}`
        });
      }

      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
      const tokenRes = await fetch(`${apiBase}/v1/oauth2/token`, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials"
      });
      const { access_token } = await tokenRes.json();
      const captureRes = await fetch(`${apiBase}/v2/checkout/orders/${order_id}/capture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" }
      });
      const captureData = await captureRes.json();
      if (!captureRes.ok || captureData.status !== "COMPLETED") {
        return res.status(402).json({ error: "Payment not completed", details: captureData });
      }
      const payerEmail = billingEmail || captureData.payer?.email_address?.toLowerCase?.() || "";
      const fulfilled = await fulfillProPurchase({
        email: payerEmail,
        paymentId: captureData.id || order_id,
        provider: "paypal",
        cycle: quote.cycle,
        amount: quote.total,
        currency: "USD",
        license: key,
        expires: exp,
        gst: quote.gst,
        subtotal: quote.subtotal,
        test: creds.test
      });
      return res.json({
        success: true,
        licenseKey: key,
        email: payerEmail,
        cycle: quote.cycle,
        expiresAt: exp,
        payment_mode: creds.label,
        receiptEmailed: Boolean(fulfilled.mail?.ok && !fulfilled.mail?.skipped),
        redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(payerEmail)}&key=${encodeURIComponent(key)}`
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/razorpay/create-order", async (req, res) => {
    try {
      const cycle = req.body?.cycle || "yearly";
      const email = String(req.body?.email || "").toLowerCase().trim();
      const quote = quoteINR(cycle);
      const creds = getPaymentCreds();
      const { keyId, keySecret } = creds.razorpay;
      const expectPrefix = creds.test ? "rzp_test_" : "rzp_live_";

      if (!keyId || !keySecret) {
        return res.status(503).json({
          error: creds.test
            ? "Razorpay TEST credentials missing. Set RAZORPAY_TEST_KEY_ID + RAZORPAY_TEST_KEY_SECRET on Vercel."
            : "Razorpay LIVE credentials missing. Set RAZORPAY_LIVE_KEY_ID + RAZORPAY_LIVE_KEY_SECRET on Vercel."
        });
      }
      if (!String(keyId).startsWith(expectPrefix)) {
        return res.status(503).json({
          error: creds.test
            ? "PAYMENT_TEST_MODE=true requires a Razorpay test key (rzp_test_…)."
            : "PAYMENT_TEST_MODE=false requires a Razorpay live key (rzp_live_…)."
        });
      }

      const order = await createRazorpayOrderRest({
        keyId,
        keySecret,
        amountPaise: quote.amountPaise,
        receipt: `ce_${quote.cycle}_${Date.now()}`.slice(0, 40),
        notes: {
          email,
          cycle: quote.cycle,
          product: "Claude Enhancer Pro",
          mode: creds.label
        }
      });

      return res.json({
        success: true,
        order_id: order.id,
        amount: order.amount,
        currency: order.currency || "INR",
        key_id: keyId,
        quote,
        payment_mode: creds.label,
        razorpay_live_keys: !!creds.razorpay.usingLiveKeys,
        razorpay_test_keys: !!creds.razorpay.usingTestKeys
      });
    } catch (err) {
      console.error("[Razorpay create-order]", err);
      return res.status(500).json({ error: err.message || "Razorpay order failed" });
    }
  });

  app.post("/api/razorpay/verify-payment", async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        email = "",
        cycle = "yearly"
      } = req.body || {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ error: "Missing payment fields" });
      }

      const creds = getPaymentCreds();
      const { keySecret } = creds.razorpay;
      if (!keySecret) {
        return res.status(503).json({
          error: creds.test ? "Razorpay TEST secret missing" : "Razorpay LIVE secret missing"
        });
      }

      // Soft-block obvious fake payloads (still allow real test checkout)
      if (razorpay_signature === "test_mode" && !String(razorpay_order_id).startsWith("order_")) {
        return res.status(400).json({ error: "Invalid simulated payload" });
      }

      const expected = crypto
        .createHmac("sha256", keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      const a = Buffer.from(expected);
      const b = Buffer.from(String(razorpay_signature));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(400).json({ error: "Invalid signature" });
      }

      const quote = quoteINR(cycle);
      const exp = expiresAt(cycle);
      const key = licenseKey();
      const billingEmail = String(email || "").toLowerCase().trim();
      const fulfilled = await fulfillProPurchase({
        email: billingEmail,
        paymentId: razorpay_payment_id,
        provider: "razorpay",
        cycle: quote.cycle,
        amount: quote.total,
        currency: "INR",
        license: key,
        expires: exp,
        gst: quote.gst,
        subtotal: quote.subtotal,
        test: creds.test
      });
      return res.json({
        success: true,
        licenseKey: key,
        email: billingEmail,
        cycle: quote.cycle,
        expiresAt: exp,
        payment_mode: creds.label,
        receiptEmailed: Boolean(fulfilled.mail?.ok && !fulfilled.mail?.skipped),
        redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(billingEmail)}&key=${encodeURIComponent(key)}`
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountCePayments, getPaymentCreds, isTestMode, quoteUSD, quoteINR, PLANS };
