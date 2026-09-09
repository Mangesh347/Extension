const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const db = require('./db');
const { verifyPaddleSignature, processWebhookEvent, isPaddleIpAllowed } = require('./webhookHandler');
const { createCustomerPortalSession } = require('./portalService');
const { mountCePayments } = require('./cePaymentRoutes');
const { mountCeEntitlements } = require('./ceEntitlementRoutes');
const { mountCeLifecycle } = require('./ceLifecycle');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const IS_PROD = (process.env.PADDLE_ENVIRONMENT || '').toLowerCase() === 'production' || (process.env.PADDLE_ENVIRONMENT || '').toLowerCase() === 'live';

// ---------------- 1. WEBHOOK ENDPOINT (RAW BODY) ----------------
// IMPORTANT: Use express.raw({ type: 'application/json' }) BEFORE any express.json() middleware.
// Verification must happen against the exact raw bytes/string received from Paddle.
app.post(
  '/api/webhooks',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // 1. IP Allowlist verification (Paddle live IPv4 CIDRs from https://api.paddle.com/ips)
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const isAllowedIp = await isPaddleIpAllowed(clientIp, IS_PROD);
    if (!isAllowedIp) {
      console.warn(`[Paddle Webhook] Rejected unauthorized IP: ${clientIp}`);
      return res.status(403).json({ error: 'Forbidden: IP address not allowed' });
    }

    const signatureHeader = req.headers['paddle-signature'];
    const secretKey = process.env.PADDLE_WEBHOOK_SECRET_KEY || process.env.WEBHOOK_SECRET_KEY;

    if (!signatureHeader) {
      console.warn('[Paddle Webhook] Rejected: Missing Paddle-Signature header');
      return res.status(400).json({ error: 'Missing Paddle-Signature header' });
    }

    if (!secretKey) {
      console.error('[Paddle Webhook] Server misconfigured: Missing PADDLE_WEBHOOK_SECRET_KEY in environment');
      return res.status(500).json({ error: 'Webhook secret key not configured on server' });
    }

    const rawBody = req.body ? req.body.toString('utf8') : '';

    if (!rawBody) {
      console.warn('[Paddle Webhook] Rejected: Empty request body');
      return res.status(400).json({ error: 'Empty request body' });
    }

    // Verify signature
    const verification = verifyPaddleSignature(rawBody, signatureHeader, secretKey);

    if (!verification.isValid) {
      console.warn(`[Paddle Webhook] Signature verification failed: ${verification.error}`);
      // Returning 401/400 instructs Paddle that delivery failed so it can retry
      return res.status(401).json({ error: 'Invalid webhook signature', details: verification.error });
    }

    // Parse JSON payload after successful signature verification
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch (err) {
      console.error('[Paddle Webhook] Malformed JSON payload:', err.message);
      return res.status(400).json({ error: 'Malformed JSON payload' });
    }

    try {
      const result = await processWebhookEvent(payload);
      return res.status(200).json({ received: true, eventId: result.eventId, eventType: result.eventType });
    } catch (err) {
      console.error('[Paddle Webhook] Error processing event:', err);
      // Return 500 so Paddle retries if internal processing errors occur
      return res.status(500).json({ error: 'Internal processing error', message: err.message });
    }
  }
);

// Body parser for remaining standard API routes
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Claude Enhancer Pro — PayPal + Razorpay (+ GST) checkout APIs
mountCePayments(app);
// Email-bound Pro token / access (must be before catch-all *)
mountCeEntitlements(app);
mountCeLifecycle(app);

// ---------------- 2. CLIENT CONFIG ENDPOINT ----------------
// Safe public config (Client Token & Price IDs only — NO API Keys or Signing Secrets)
app.get('/api/config', (req, res) => {
  const { getPaymentCreds, isTestMode } = require('./cePaymentRoutes');
  const creds = getPaymentCreds();
  const test = isTestMode();
  const paypalReady = Boolean(creds.paypal.clientId && creds.paypal.clientSecret);
  const razorpayReady = Boolean(creds.razorpay.keyId && creds.razorpay.keySecret);
  const allowLive = String(process.env.ALLOW_LIVE_PAYMENTS || 'false').toLowerCase() === 'true';

  res.json({
    payment_test_mode: test,
    payment_mode: creds.label,
    allow_live_payments: allowLive,
    paypal_live: !test && paypalReady,
    razorpay_live: !test && !!creds.razorpay.usingLiveKeys,
    paypal_ready: paypalReady,
    razorpay_ready: razorpayReady,
    razorpay_using_live_keys: !!creds.razorpay.usingLiveKeys,
    razorpay_using_test_keys: !!creds.razorpay.usingTestKeys,
    paypal_client_id: creds.paypal.clientId || '',
    paypal_mode: creds.paypal.apiMode,
    razorpay_key_id: creds.razorpay.keyId
      ? String(creds.razorpay.keyId).slice(0, 12) + '…'
      : '',
    providers: ['paypal', 'razorpay'],
    gst_rate: 0.18,
    inr_usd_rate: Number(process.env.INR_USD_RATE || 95.12),
    plans: {
      monthly: { priceUSD: 4 },
      yearly: { priceUSD: 40 },
      lifetime: { priceUSD: 80 }
    },
    prices: {
      proMonthly: 4,
      proYearly: 40,
      lifetime: 80
    },
    checkout_url: 'https://extension-six-alpha.vercel.app/checkout.html',
    switch_to_live: 'Set ALLOW_LIVE_PAYMENTS=true and PAYMENT_TEST_MODE=false on Vercel, then redeploy',
    switch_to_test: 'Set ALLOW_LIVE_PAYMENTS=false (or omit) and PAYMENT_TEST_MODE=true, then redeploy'
  });
});

// ---------------- 3. ACCESS / ENTITLEMENT — see mountCeEntitlements() above
// (legacy Paddle DB stub removed; Pro is email_hash in Supabase entitlement_events)

// ---------------- 4. CUSTOMER PORTAL SESSION ENDPOINT ----------------
// Mints an authenticated Paddle Customer Portal session URL
app.post('/api/customer-portal', async (req, res) => {
  try {
    const { email, customerId } = req.body;

    // Resolve customer ID server-side from database / session
    let customer = null;
    if (customerId) {
      customer = db.getCustomer(customerId);
    }
    if (!customer && email) {
      customer = db.getCustomerByEmail(email);
    }

    if (!customer) {
      return res.status(404).json({
        error: 'Customer not found. Please ensure you have completed a checkout with this email address.'
      });
    }

    // Lookup customer subscriptions
    const subscriptions = db.getSubscriptionsByCustomerId(customer.customer_id);
    const subscriptionIds = subscriptions.map(s => s.subscription_id);

    // Mint portal session
    const session = await createCustomerPortalSession(customer.customer_id, subscriptionIds);
    res.json({
      success: true,
      customerId: customer.customer_id,
      url: session.url,
      urls: session.urls,
      isStoredUrl: session.isStoredUrl
    });
  } catch (error) {
    console.error('[API] Customer portal creation failed:', error.message);
    res.status(500).json({ error: 'Failed to create customer portal session', message: error.message });
  }
});

// ---------------- 5. IN-APP SUBSCRIPTION MANAGEMENT (CANCEL / PAUSE) ----------------
app.post('/api/subscription/cancel', (req, res) => {
  try {
    const { email, customerId, subscriptionId, effectiveFrom = 'next_billing_period' } = req.body;

    let customer = null;
    if (customerId) customer = db.getCustomer(customerId);
    if (!customer && email) customer = db.getCustomerByEmail(email);

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    const subscriptions = db.getSubscriptionsByCustomerId(customer.customer_id);
    const sub = subscriptionId 
      ? subscriptions.find(s => s.subscription_id === subscriptionId) 
      : subscriptions[0];

    if (!sub) {
      return res.status(404).json({ error: 'No active subscription found to cancel' });
    }

    if (effectiveFrom === 'immediately') {
      db.upsertSubscription({
        subscriptionId: sub.subscription_id,
        customerId: sub.customer_id,
        status: 'canceled',
        scheduledChangeAction: null,
        scheduledChangeAt: null,
        updatedAt: new Date().toISOString()
      });
    } else {
      // Schedule cancellation at end of billing cycle (access preserved until effective date)
      db.upsertSubscription({
        subscriptionId: sub.subscription_id,
        customerId: sub.customer_id,
        status: sub.status,
        scheduledChangeAction: 'cancel',
        scheduledChangeAt: new Date(Date.now() + 15 * 86400000).toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    const access = db.hasActiveAccess(customer.customer_id);
    res.json({
      success: true,
      message: effectiveFrom === 'immediately' ? 'Subscription canceled immediately' : 'Subscription scheduled to cancel at end of billing period',
      subscriptionId: sub.subscription_id,
      access
    });
  } catch (err) {
    console.error('[API] Cancel subscription error:', err);
    res.status(500).json({ error: 'Failed to cancel subscription', message: err.message });
  }
});

// ---------------- 5. DATABASE INSPECTION (ADMIN / DEMO) ----------------
app.get('/api/database/customers', (req, res) => {
  res.json({ customers: db.getAllCustomers() });
});

app.get('/api/database/subscriptions', (req, res) => {
  res.json({ subscriptions: db.getAllSubscriptions() });
});

// ---------------- 6. STATIC ASSETS & PAGES ----------------
app.use(express.static(path.join(__dirname, 'public')));

app.get('/checkout.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'checkout.html'));
});

app.get('/welcome', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

app.get('/account', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'account.html'));
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/refund', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'refund.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  const server = app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`Fenwick Labs Paddle Sandbox Server Active`);
    console.log(`Port: ${PORT} | Environment: ${process.env.PADDLE_ENVIRONMENT || 'sandbox'}`);
    console.log(`Webhook Endpoint: http://localhost:${PORT}/api/webhooks`);
    console.log(`Account & Portal: http://localhost:${PORT}/account`);
    console.log(`====================================================`);
  });
}

module.exports = app;
