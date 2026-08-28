const crypto = require('crypto');
const db = require('./db');

let cachedIpv4List = null;
let lastIpFetchTime = 0;
const IP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch and cache Paddle Live Webhook IP CIDRs dynamically from https://api.paddle.com/ips
 */
async function fetchPaddleLiveIPs() {
  const now = Date.now();
  if (cachedIpv4List && now - lastIpFetchTime < IP_CACHE_TTL) {
    return cachedIpv4List;
  }

  try {
    const res = await fetch('https://api.paddle.com/ips');
    if (res.ok) {
      const json = await res.json();
      const cidrs = json.data?.ipv4_cidrs || [];
      // Extract pure IP strings from /32 CIDRs
      cachedIpv4List = cidrs.map(c => c.split('/')[0].trim());
      lastIpFetchTime = now;
      console.log(`[Paddle Webhook] Updated Paddle Live IP allowlist (${cachedIpv4List.length} IPs):`, cachedIpv4List);
      return cachedIpv4List;
    }
  } catch (err) {
    console.warn('[Paddle Webhook] Failed to fetch live IP list from https://api.paddle.com/ips:', err.message);
  }

  // Fallback defaults if network is offline
  return cachedIpv4List || ['34.237.3.244', '34.195.105.136', '34.232.58.13', '35.155.119.135', '34.212.5.7', '52.11.166.252'];
}

/**
 * Validate incoming request IP against Paddle Live IPs
 */
async function isPaddleIpAllowed(clientIp, isProduction = false) {
  // Always allow localhost / private IPs during development and sandbox testing
  if (!isProduction || clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1' || !clientIp) {
    return true;
  }

  const cleanIp = clientIp.replace('::ffff:', '').trim();
  const allowedIps = await fetchPaddleLiveIPs();
  return allowedIps.includes(cleanIp);
}

/**
 * Verify Paddle Webhook Signature using HMAC SHA-256
 * Conforms to Paddle v2 Signature Specification:
 * Header: Paddle-Signature: ts=1680000000;h1=hash... (or t=...;h=...)
 * Signed payload: "${ts}:${rawBody}"
 */
function verifyPaddleSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader || !secretKey || !rawBody) {
    return {
      isValid: false,
      error: 'Missing required parameters: signature header, secret key, or raw request body'
    };
  }

  // Parse header components
  const parts = signatureHeader.split(';');
  const headerMap = {};
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx !== -1) {
      const k = part.substring(0, idx).trim();
      const v = part.substring(idx + 1).trim();
      headerMap[k] = v;
    }
  }

  const timestamp = headerMap['ts'] || headerMap['t'];
  const signature = headerMap['h1'] || headerMap['h'] || headerMap['v1'];

  if (!timestamp || !signature) {
    return {
      isValid: false,
      error: `Invalid Paddle-Signature format. Expected ts= and h1=, got: ${signatureHeader}`
    };
  }

  // Build signed payload
  const signedPayload = `${timestamp}:${rawBody}`;

  // Compute HMAC SHA256 with signing secret
  const computedHash = crypto
    .createHmac('sha256', secretKey)
    .update(signedPayload, 'utf8')
    .digest('hex');

  try {
    const computedBuf = Buffer.from(computedHash, 'hex');
    const signatureBuf = Buffer.from(signature, 'hex');

    if (computedBuf.length !== signatureBuf.length) {
      return { isValid: false, error: 'Signature length mismatch' };
    }

    const isMatch = crypto.timingSafeEqual(computedBuf, signatureBuf);
    return { isValid: isMatch, error: isMatch ? null : 'Computed signature does not match' };
  } catch (err) {
    return { isValid: false, error: `Signature comparison error: ${err.message}` };
  }
}

/**
 * Process a verified Paddle Webhook Event
 * Handlers are idempotent and upsert records keyed on Paddle IDs
 */
async function processWebhookEvent(event) {
  const eventId = event.event_id || event.id;
  const eventType = event.event_type || event.eventType;
  const data = event.data || {};
  const occurredAt = event.occurred_at || new Date().toISOString();

  console.log(`[Paddle Webhook] Processing event: ${eventType} (Event ID: ${eventId})`);

  // 1. Handle Customer Events
  if (eventType === 'customer.created' || eventType === 'customer.updated') {
    if (data.id && data.email) {
      const customer = db.upsertCustomer({
        customerId: data.id,
        email: data.email,
        name: data.name || null,
        createdAt: data.created_at || occurredAt,
        updatedAt: data.updated_at || occurredAt
      });
      console.log(`[Paddle Webhook] Synced customer: ${customer.customer_id} (${customer.email})`);
    }
  }

  // 2. Handle Subscription Events
  else if (
    eventType === 'subscription.created' ||
    eventType === 'subscription.updated' ||
    eventType === 'subscription.activated' ||
    eventType === 'subscription.trialing' ||
    eventType === 'subscription.past_due' ||
    eventType === 'subscription.paused' ||
    eventType === 'subscription.resumed' ||
    eventType === 'subscription.canceled'
  ) {
    const subscriptionId = data.id;
    const customerId = data.customer_id;
    const status = data.status;
    const firstItem = Array.isArray(data.items) && data.items.length > 0 ? data.items[0] : {};
    const priceId = firstItem.price?.id || firstItem.price_id || 'unknown';
    const productId = firstItem.product?.id || firstItem.price?.product_id || firstItem.product_id || 'unknown';
    
    const scheduledChange = data.scheduled_change || null;
    const scheduledChangeAction = scheduledChange ? scheduledChange.action : null;
    const scheduledChangeAt = scheduledChange ? (scheduledChange.effective_at || scheduledChange.action_at_date) : null;
    const managementUrls = data.management_urls || null;

    if (subscriptionId && customerId) {
      // Ensure customer record exists if customer details or email are present
      if (data.customer?.email) {
        db.upsertCustomer({
          customerId: customerId,
          email: data.customer.email,
          name: data.customer.name || null,
          createdAt: data.customer.created_at || occurredAt,
          updatedAt: occurredAt
        });
      }

      const subscription = db.upsertSubscription({
        subscriptionId,
        customerId,
        status,
        priceId,
        productId,
        scheduledChangeAction,
        scheduledChangeAt,
        managementUrls,
        createdAt: data.created_at || occurredAt,
        updatedAt: data.updated_at || occurredAt
      });

      console.log(`[Paddle Webhook] Synced subscription: ${subscription.subscription_id} (Status: ${subscription.status}, Customer: ${subscription.customer_id})`);
    }
  }

  // 3. Handle Transaction Events (One-time Lifetime & Recurring Fulfillment)
  else if (eventType === 'transaction.completed' || eventType === 'transaction.paid') {
    const customerId = data.customer_id;
    const subscriptionId = data.subscription_id;
    const items = data.items || [];
    const customerEmail = data.customer?.email || data.details?.customer?.email;

    if (customerId && customerEmail) {
      db.upsertCustomer({
        customerId: customerId,
        email: customerEmail,
        name: data.customer?.name || null,
        createdAt: occurredAt,
        updatedAt: occurredAt
      });
    }

    // Check line items for Lifetime purchase (or one-time catalog items)
    for (const item of items) {
      const priceId = item.price?.id || item.price_id;
      const productId = item.product?.id || item.price?.product_id || 'pro_lifetime';

      // Check if price is configured as Lifetime or non-recurring
      const configuredLifetime = process.env.PADDLE_PRICE_LIFETIME;
      if (priceId === configuredLifetime || priceId === 'pri_01m0fh9dz24xy9gp99q8zm2f62' || !subscriptionId) {
        if (customerId) {
          db.upsertEntitlement({
            customerId: customerId,
            type: 'lifetime',
            productId: productId,
            priceId: priceId,
            isActive: true,
            createdAt: occurredAt,
            updatedAt: occurredAt
          });
          console.log(`[Paddle Webhook] Granted perpetual Lifetime access to customer: ${customerId}`);
        }
      }
    }

    // If recurring transaction with subscription_id, ensure subscription is active
    if (subscriptionId && customerId) {
      const firstItem = items[0] || {};
      const priceId = firstItem.price?.id || firstItem.price_id || 'unknown';
      const productId = firstItem.product?.id || firstItem.price?.product_id || 'unknown';

      db.upsertSubscription({
        subscriptionId: subscriptionId,
        customerId: customerId,
        status: data.status === 'completed' ? 'active' : 'trialing',
        priceId: priceId,
        productId: productId,
        updatedAt: occurredAt
      });
      console.log(`[Paddle Webhook] Confirmed subscription ${subscriptionId} for transaction ${data.id}`);
    }
  } else {
    console.log(`[Paddle Webhook] Ignored non-fulfillment event type: ${eventType}`);
  }

  // Record event ID for idempotency tracking
  if (eventId) {
    db.recordProcessedEvent(eventId, eventType);
  }

  return { success: true, eventType, eventId };
}

module.exports = {
  fetchPaddleLiveIPs,
  isPaddleIpAllowed,
  verifyPaddleSignature,
  processWebhookEvent
};
