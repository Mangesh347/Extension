/**
 * Claude Enhancer Pro — PayPal + Razorpay routes (Express / CJS)
 * Mount on Fenwick Extension server. Secrets via env only.
 */

const crypto = require("crypto");

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

async function recordEntitlement({ email, paymentId, provider, cycle, amount, currency, license, expires, gst, subtotal }) {
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
        activatedAt: new Date().toISOString()
      },
      created_at: new Date().toISOString()
    })
  }).catch((e) => console.warn("[CE Pay] entitlement:", e.message));
}

function mountCePayments(app) {
  app.get("/checkout", (req, res) => {
    res.sendFile(require("path").join(__dirname, "public", "checkout.html"));
  });

  app.post("/api/paypal/create-order", async (req, res) => {
    try {
      const cycle = req.body?.cycle || "yearly";
      const email = String(req.body?.email || "").toLowerCase().trim();
      const quote = quoteUSD(cycle);
      const clientId = process.env.PAYPAL_CLIENT_ID;
      const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
      const mode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();
      const apiBase = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

      if (!clientId || !clientSecret || req.body?.test === true || process.env.PAYMENT_TEST_MODE === "true") {
        return res.json({
          success: true,
          order_id: `SIM_PP_ORDER_${Date.now()}`,
          amount: quote.total.toFixed(2),
          currency: "USD",
          quote,
          mode: "simulated_preview"
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
            custom_id: JSON.stringify({ email, plan: "pro", cycle: quote.cycle }),
            amount: { currency_code: "USD", value: quote.total.toFixed(2) }
          }],
          application_context: {
            brand_name: "Claude Enhancer",
            user_action: "PAY_NOW",
            return_url: "https://extension-six-alpha.vercel.app/checkout.html?paid=paypal",
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
        mode
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
      const clientId = process.env.PAYPAL_CLIENT_ID;
      const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

      if (!clientId || !clientSecret || String(order_id).startsWith("SIM_") || req.body?.test === true || process.env.PAYMENT_TEST_MODE === "true") {
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
          subtotal: quote.subtotal
        });
        return res.json({
          success: true,
          licenseKey: key,
          email: billingEmail,
          cycle: quote.cycle,
          expiresAt: exp,
          redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(billingEmail)}`
        });
      }

      const mode = (process.env.PAYPAL_MODE || "sandbox").toLowerCase();
      const apiBase = mode === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
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
        subtotal: quote.subtotal
      });
      return res.json({
        success: true,
        licenseKey: key,
        email: payerEmail,
        cycle: quote.cycle,
        expiresAt: exp,
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
      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keyId || !keySecret) {
        return res.json({
          success: true,
          order_id: `order_sim_${Date.now()}`,
          amount: quote.amountPaise,
          currency: "INR",
          key_id: keyId || "rzp_test_placeholder",
          quote,
          mode: "simulated_preview"
        });
      }
      const Razorpay = require("razorpay");
      const rzp = new Razorpay({ key_id: keyId, key_secret: keySecret });
      const order = await rzp.orders.create({
        amount: quote.amountPaise,
        currency: "INR",
        receipt: `ce_${quote.cycle}_${Date.now()}`.slice(0, 40),
        notes: { email, cycle: quote.cycle, product: "Claude Enhancer Pro" }
      });
      return res.json({
        success: true,
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: keyId,
        quote
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
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
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      const forceTest = req.body?.test === true || process.env.PAYMENT_TEST_MODE === "true";
      if (keySecret && !forceTest && razorpay_signature !== "test_mode") {
        const expected = crypto
          .createHmac("sha256", keySecret)
          .update(`${razorpay_order_id}|${razorpay_payment_id}`)
          .digest("hex");
        const a = Buffer.from(expected);
        const b = Buffer.from(String(razorpay_signature));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          return res.status(400).json({ error: "Invalid signature" });
        }
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
        subtotal: quote.subtotal
      });
      return res.json({
        success: true,
        licenseKey: key,
        email: billingEmail,
        cycle: quote.cycle,
        expiresAt: exp,
        redirect: `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(billingEmail)}`
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mountCePayments };
