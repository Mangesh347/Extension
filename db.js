const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DB_DIR, 'database.json');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

// Initial DB schema
const initialSchema = {
  customers: {},
  subscriptions: {},
  entitlements: {},
  processedEvents: {}
};

// Load database from disk
function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const content = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Error loading database.json, initializing fresh store:', error);
  }
  return JSON.parse(JSON.stringify(initialSchema));
}

// Save database to disk atomically
function saveDB(data) {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tempFile, DB_FILE);
  } catch (error) {
    console.error('Error saving database.json:', error);
  }
}

// Database state
let db = loadDB();

// ---------------- CUSTOMERS TABLE ----------------
// Schema: customer_id (PK), email, name, created_at, updated_at
function upsertCustomer({ customerId, email, name = null, createdAt, updatedAt }) {
  if (!customerId || !email) {
    throw new Error('customerId and email are required for customer upsert');
  }

  const now = new Date().toISOString();
  const existing = db.customers[customerId] || {};

  db.customers[customerId] = {
    customer_id: customerId,
    email: email.toLowerCase().trim(),
    name: name || existing.name || null,
    created_at: createdAt || existing.created_at || now,
    updated_at: updatedAt || now
  };

  saveDB(db);
  return db.customers[customerId];
}

function getCustomer(customerId) {
  return db.customers[customerId] || null;
}

function getCustomerByEmail(email) {
  if (!email) return null;
  const normalized = email.toLowerCase().trim();
  return Object.values(db.customers).find(c => c.email === normalized) || null;
}

function getAllCustomers() {
  return Object.values(db.customers);
}

// ---------------- SUBSCRIPTIONS TABLE ----------------
// Schema: subscription_id (PK), customer_id (FK), status, price_id, product_id,
// scheduled_change_action, scheduled_change_at, created_at, updated_at
function upsertSubscription({
  subscriptionId,
  customerId,
  status,
  priceId,
  productId,
  scheduledChangeAction = null,
  scheduledChangeAt = null,
  managementUrls = null,
  createdAt,
  updatedAt
}) {
  if (!subscriptionId || !customerId) {
    throw new Error('subscriptionId and customerId are required for subscription upsert');
  }

  const now = new Date().toISOString();
  const existing = db.subscriptions[subscriptionId] || {};

  db.subscriptions[subscriptionId] = {
    subscription_id: subscriptionId,
    customer_id: customerId,
    status: status || existing.status || 'unknown',
    price_id: priceId || existing.price_id,
    product_id: productId || existing.product_id,
    scheduled_change_action: scheduledChangeAction !== undefined ? scheduledChangeAction : existing.scheduled_change_action || null,
    scheduled_change_at: scheduledChangeAt !== undefined ? scheduledChangeAt : existing.scheduled_change_at || null,
    management_urls: managementUrls || existing.management_urls || null,
    created_at: createdAt || existing.created_at || now,
    updated_at: updatedAt || now
  };

  saveDB(db);
  return db.subscriptions[subscriptionId];
}

function getSubscription(subscriptionId) {
  return db.subscriptions[subscriptionId] || null;
}

function getSubscriptionsByCustomerId(customerId) {
  if (!customerId) return [];
  return Object.values(db.subscriptions).filter(s => s.customer_id === customerId);
}

function getAllSubscriptions() {
  return Object.values(db.subscriptions);
}

// ---------------- ENTITLEMENTS / LIFETIME TABLE ----------------
// Schema: id (PK), customer_id, type, product_id, price_id, is_active, created_at, updated_at
function upsertEntitlement({
  id,
  customerId,
  type = 'lifetime',
  productId,
  priceId,
  isActive = true,
  createdAt,
  updatedAt
}) {
  const entitlementId = id || `ent_${customerId}_${productId || 'pro'}`;
  const now = new Date().toISOString();
  const existing = db.entitlements[entitlementId] || {};

  db.entitlements[entitlementId] = {
    id: entitlementId,
    customer_id: customerId,
    type: type,
    product_id: productId || existing.product_id,
    price_id: priceId || existing.price_id,
    is_active: isActive !== undefined ? isActive : true,
    created_at: createdAt || existing.created_at || now,
    updated_at: updatedAt || now
  };

  saveDB(db);
  return db.entitlements[entitlementId];
}

function getEntitlementsByCustomerId(customerId) {
  if (!customerId) return [];
  return Object.values(db.entitlements).filter(e => e.customer_id === customerId);
}

// ---------------- IDEMPOTENCY / EVENT LOG ----------------
function recordProcessedEvent(eventId, eventType) {
  if (!eventId) return;
  db.processedEvents[eventId] = {
    event_id: eventId,
    event_type: eventType,
    processed_at: new Date().toISOString()
  };
  saveDB(db);
}

function isEventProcessed(eventId) {
  return Boolean(db.processedEvents && db.processedEvents[eventId]);
}

// ---------------- ACCESS HELPER DECISION ENGINE ----------------
/**
 * Decides whether a customer currently grants paid access.
 * Rule: Treat 'active' AND 'trialing' as access-granting.
 * Do NOT revoke access just because a scheduled_change exists (e.g. scheduled cancel/pause at period end).
 * Only revoke when status is actually 'canceled' or 'paused'.
 * Lifetime entitlements grant perpetual access.
 */
function hasActiveAccess(customerId) {
  if (!customerId) {
    return { hasAccess: false, plan: 'free', status: 'no_customer', subscription: null };
  }

  // 1. Check lifetime access entitlements
  const entitlements = getEntitlementsByCustomerId(customerId);
  const lifetime = entitlements.find(e => e.type === 'lifetime' && e.is_active);
  if (lifetime) {
    return {
      hasAccess: true,
      plan: 'lifetime',
      status: 'lifetime_active',
      productId: lifetime.product_id,
      priceId: lifetime.price_id,
      subscription: null
    };
  }

  // 2. Check subscriptions
  const subscriptions = getSubscriptionsByCustomerId(customerId);
  
  // Sort latest updated first
  subscriptions.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  for (const sub of subscriptions) {
    // Treat 'active' AND 'trialing' as access-granting
    if (sub.status === 'active' || sub.status === 'trialing') {
      return {
        hasAccess: true,
        plan: 'pro',
        status: sub.status,
        scheduledChangeAction: sub.scheduled_change_action,
        scheduledChangeAt: sub.scheduled_change_at,
        subscriptionId: sub.subscription_id,
        productId: sub.product_id,
        priceId: sub.price_id,
        subscription: sub
      };
    }
  }

  // If any past subscription exists but now canceled/paused
  if (subscriptions.length > 0) {
    const latest = subscriptions[0];
    return {
      hasAccess: false,
      plan: 'free',
      status: latest.status,
      subscriptionId: latest.subscription_id,
      subscription: latest
    };
  }

  return { hasAccess: false, plan: 'free', status: 'none', subscription: null };
}

module.exports = {
  upsertCustomer,
  getCustomer,
  getCustomerByEmail,
  getAllCustomers,
  upsertSubscription,
  getSubscription,
  getSubscriptionsByCustomerId,
  getAllSubscriptions,
  upsertEntitlement,
  getEntitlementsByCustomerId,
  recordProcessedEvent,
  isEventProcessed,
  hasActiveAccess
};
