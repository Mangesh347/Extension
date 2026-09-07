/**
 * Claude Enhancer Pro — PayPal + Razorpay routes
 * PayPal: TEST/LIVE via PAYMENT_TEST_MODE. Razorpay: LIVE keys only (no sim/test).
 */

const crypto = require("crypto");
const path = require("path");

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
  // Ignore leftover template placeholders from ENV_PASTE.txt
  if (!s || /paste_here|YOUR_PROJECT|xxxxx|optional/i.test(s)) return "";
  return s;
}

/** true = PayPal sandbox; Razorpay is always LIVE keys for this project */
function isTestMode() {
  return String(process.env.PAYMENT_TEST_MODE || "true").toLowerCase() !== "false";
}

/**
 * PayPal: TEST vs LIVE by PAYMENT_TEST_MODE.
 * Razorpay: LIVE only (RAZORPAY_LIVE_* or RAZORPAY_KEY_*) — no test keys.
 */
function getPaymentCreds() {
  const test = isTestMode();

  const razorpayKeyId =
    envTrim("RAZORPAY_LIVE_KEY_ID") ||
    envTrim("RAZORPAY_KEY_ID") ||
    "";
  const razorpayKeySecret =
    envTrim("RAZORPAY_LIVE_KEY_SECRET") ||
    envTrim("RAZORPAY_KEY_SECRET") ||
    "";

  if (test) {
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
        usingLiveKeys: String(razorpayKeyId).startsWith("rzp_live_")
      }
    };
  }

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
      usingLiveKeys: String(razorpayKeyId).startsWith("rzp_live_")
    }
  };
}

/** Create Razorpay order via REST (no npm razorpay package needed on Vercel) */
async function createRazorpayOrderRest({ keyId, keySecret, amountPaise, receipt, notes }) {
  const id = String(keyId || "").trim();
  const secret = String(keySecret || "").trim();
  if (!id.startsWith("rzp_")) {
    throw new Error("Invalid Razorpay Key ID — must start with rzp_live_ (set RAZORPAY_LIVE_KEY_ID on Vercel)");
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
    // #region agent log
    fetch('http://127.0.0.1:7652/ingest/113581e5-ff03-4b98-9529-daa3d76e3789',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a325af'},body:JSON.stringify({sessionId:'a325af',runId:'rzp',hypothesisId:'R1',location:'cePaymentRoutes.js:createRazorpayOrderRest',message:'Razorpay auth/order failed',data:{status:res.status,keyPrefix:id.slice(0,12),err:String(msg).slice(0,120)},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
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
  if (!url || !key || !email) return;
  await fetch(`${url}/rest/v1/entitlement_events`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json"
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
  }).catch((e) => console.warn("[CE Pay] entitlement:", e.message));
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
        await recordEntitlement({
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
          redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(billingEmail)}`
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
      await recordEntitlement({
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
        redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(payerEmail)}`
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

      // Razorpay is LIVE-only — never simulate / never use rzp_test
      if (!keyId || !keySecret) {
        return res.status(503).json({
          error: "Razorpay live credentials missing. Set RAZORPAY_LIVE_KEY_ID + RAZORPAY_LIVE_KEY_SECRET on Vercel."
        });
      }
      if (!String(keyId).startsWith("rzp_live_")) {
        return res.status(503).json({
          error: "Razorpay must use a live key (rzp_live_…). Remove test keys from Vercel."
        });
      }

      const order = await createRazorpayOrderRest({
        keyId,
        keySecret,
        amountPaise: quote.amountPaise,
        receipt: `ce_${quote.cycle}_${Date.now()}`.slice(0, 40),
        notes: { email, cycle: quote.cycle, product: "Claude Enhancer Pro", mode: "live" }
      });

      // #region agent log
      fetch('http://127.0.0.1:7652/ingest/113581e5-ff03-4b98-9529-daa3d76e3789',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'a325af'},body:JSON.stringify({sessionId:'a325af',runId:'post-fix',hypothesisId:'R2',location:'cePaymentRoutes.js:create-order',message:'Live Razorpay order created',data:{orderPrefix:String(order.id||'').slice(0,12),keyPrefix:String(keyId).slice(0,12),amount:order.amount},timestamp:Date.now()})}).catch(()=>{});
      // #endregion

      return res.json({
        success: true,
        order_id: order.id,
        amount: order.amount,
        currency: order.currency || "INR",
        key_id: keyId,
        quote,
        payment_mode: "live",
        razorpay_live_keys: true
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
        return res.status(503).json({ error: "Razorpay live secret missing" });
      }
      // Reject any leftover test/sim payloads
      if (
        String(razorpay_order_id).startsWith("order_sim_") ||
        razorpay_signature === "test_mode" ||
        req.body?.simulate === true
      ) {
        return res.status(400).json({ error: "Simulated Razorpay payments are disabled. Use live checkout only." });
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
      await recordEntitlement({
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
        test: false
      });
      return res.json({
        success: true,
        licenseKey: key,
        email: billingEmail,
        cycle: quote.cycle,
        expiresAt: exp,
        payment_mode: "live",
        redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(billingEmail)}`
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountCePayments, getPaymentCreds, isTestMode };
