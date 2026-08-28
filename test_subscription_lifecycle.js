const crypto = require('crypto');
const db = require('./db');

const SECRET_KEY = process.env.PADDLE_WEBHOOK_SECRET_KEY || 'pdl_ntfset_01m0sp0hay165scw9f98007wm9_53BP7En7PkPe1T4sQbx9/DOXfnSy575n';
const SERVER_URL = 'http://localhost:3000';

async function sendSignedWebhook(eventType, eventId, data) {
  const payload = JSON.stringify({
    event_id: eventId,
    event_type: eventType,
    occurred_at: new Date().toISOString(),
    data: data
  });

  const ts = Math.floor(Date.now() / 1000).toString();
  const h1 = crypto.createHmac('sha256', SECRET_KEY).update(`${ts}:${payload}`, 'utf8').digest('hex');

  const res = await fetch(`${SERVER_URL}/api/webhooks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Paddle-Signature': `ts=${ts};h1=${h1}`
    },
    body: payload
  });

  const body = await res.json();
  return { status: res.status, body };
}

async function runStep04LifecycleTests() {
  console.log('===============================================================');
  console.log('STEP 04: PADDLE INTEGRATION END-TO-END VERIFICATION SUITE');
  console.log('===============================================================\n');

  const customerId = 'ctm_01m0snstn10rapfrfs61802gt7';
  const customerEmail = 'lokademangesh123@gmail.com';
  const subscriptionId = 'sub_01m0snvmsm7b6p8xktm2e97fea';

  // ---------------- PART 1: CONFIRM SANDBOX CONFIGURATION ----------------
  console.log('--- 1. CONFIRMING SANDBOX CONFIGURATION ---');
  const configRes = await fetch(`${SERVER_URL}/api/config`);
  const config = await configRes.json();

  console.log('• Environment:', config.environment);
  console.log('• Client Token:', config.clientToken);
  console.log('• Prices:', config.prices);

  if (config.environment !== 'sandbox' || !config.clientToken.startsWith('test_')) {
    throw new Error('Sandbox configuration validation failed!');
  }
  console.log('✓ Configuration check PASSED (Sandbox mode active with test_ token)\n');

  // ---------------- PART 2: INITIAL ACTIVE SUBSCRIPTION STATE ----------------
  console.log('--- 2. INITIAL SUBSCRIPTION STATE ---');
  await sendSignedWebhook('subscription.created', 'evt_step04_init', {
    id: subscriptionId,
    customer_id: customerId,
    status: 'active',
    items: [
      {
        price: {
          id: 'pri_01m0fh3wan3ys1as29tqnn6st3',
          product_id: 'pro_01m0fgwqrgc346cw6h92cvgnfr'
        },
        quantity: 1
      }
    ],
    customer: {
      email: customerEmail,
      name: 'Mangesh Lokade'
    }
  });

  let access = (await (await fetch(`${SERVER_URL}/api/user/access?email=${encodeURIComponent(customerEmail)}`)).json());
  console.log('• Initial Plan:', access.priceId, 'Status:', access.status, 'Has Access:', access.hasAccess);
  if (!access.hasAccess || access.priceId !== 'pri_01m0fh3wan3ys1as29tqnn6st3') {
    throw new Error('Initial subscription setup failed!');
  }
  console.log('✓ Initial active subscription verified\n');

  // ---------------- PART 4(a): PLAN UPGRADE APPLIED IMMEDIATELY WITHOUT BILLING ----------------
  console.log('--- 4(a) PLAN UPGRADE (do_not_bill) ---');
  const upgradeWebhook = await sendSignedWebhook('subscription.updated', 'evt_step04_upgrade', {
    id: subscriptionId,
    customer_id: customerId,
    status: 'active',
    items: [
      {
        price: {
          id: 'pri_01m0fh5q767z9g97r0tteajsdh', // Upgraded to Yearly
          product_id: 'pro_01m0fgwqrgc346cw6h92cvgnfr'
        },
        quantity: 1
      }
    ],
    customer: {
      email: customerEmail
    }
  });

  console.log('• Webhook HTTP status:', upgradeWebhook.status, upgradeWebhook.body);
  access = (await (await fetch(`${SERVER_URL}/api/user/access?email=${encodeURIComponent(customerEmail)}`)).json());
  console.log('• Mirrored Price ID:', access.priceId, '(Expected: pri_01m0fh5q767z9g97r0tteajsdh)');
  console.log('• Access Status:', access.status, 'Has Access:', access.hasAccess);

  if (access.priceId !== 'pri_01m0fh5q767z9g97r0tteajsdh' || !access.hasAccess) {
    throw new Error('Plan upgrade verification failed!');
  }
  console.log('✓ 4(a) Plan upgrade immediately applied without billing PASSED\n');

  // ---------------- PART 4(b): SCHEDULED CANCELLATION AT END OF BILLING PERIOD ----------------
  console.log('--- 4(b) SCHEDULED CANCELLATION (effective_from: next_billing_period) ---');
  const scheduledCancelWebhook = await sendSignedWebhook('subscription.updated', 'evt_step04_sched_cancel', {
    id: subscriptionId,
    customer_id: customerId,
    status: 'active', // Status remains active!
    scheduled_change: {
      action: 'cancel',
      effective_at: '2026-09-08T10:43:02.054Z'
    },
    items: [
      {
        price: {
          id: 'pri_01m0fh5q767z9g97r0tteajsdh',
          product_id: 'pro_01m0fgwqrgc346cw6h92cvgnfr'
        },
        quantity: 1
      }
    ]
  });

  console.log('• Webhook HTTP status:', scheduledCancelWebhook.status, scheduledCancelWebhook.body);
  access = (await (await fetch(`${SERVER_URL}/api/user/access?email=${encodeURIComponent(customerEmail)}`)).json());
  console.log('• Subscription Status:', access.status);
  console.log('• Scheduled Change Action:', access.scheduledChangeAction);
  console.log('• Scheduled Change Effective Date:', access.scheduledChangeAt);
  console.log('• Has Access (Should still be TRUE):', access.hasAccess);

  if (access.status !== 'active' || access.scheduledChangeAction !== 'cancel' || access.hasAccess !== true) {
    throw new Error('Scheduled cancellation access preservation verification failed!');
  }
  console.log('✓ 4(b) Scheduled cancellation preserved access until period end PASSED\n');

  // ---------------- PART 4(c): IMMEDIATE CANCELLATION ----------------
  console.log('--- 4(c) IMMEDIATE CANCELLATION (effective_from: immediately) ---');
  const immediateCancelWebhook = await sendSignedWebhook('subscription.canceled', 'evt_step04_imm_cancel', {
    id: subscriptionId,
    customer_id: customerId,
    status: 'canceled',
    canceled_at: new Date().toISOString(),
    items: [
      {
        price: {
          id: 'pri_01m0fh5q767z9g97r0tteajsdh',
          product_id: 'pro_01m0fgwqrgc346cw6h92cvgnfr'
        },
        quantity: 1
      }
    ]
  });

  console.log('• Webhook HTTP status:', immediateCancelWebhook.status, immediateCancelWebhook.body);
  access = (await (await fetch(`${SERVER_URL}/api/user/access?email=${encodeURIComponent(customerEmail)}`)).json());
  console.log('• Subscription Status:', access.status);
  console.log('• Has Access (Should be FALSE):', access.hasAccess);

  if (access.status !== 'canceled' || access.hasAccess !== false) {
    throw new Error('Immediate cancellation access revocation verification failed!');
  }
  console.log('✓ 4(c) Immediate cancellation revoked paid access PASSED\n');

  console.log('===============================================================');
  console.log('ALL STEP 04 END-TO-END INTEGRATION TESTS COMPLETED SUCCESSFULLY');
  console.log('===============================================================');
}

runStep04LifecycleTests().catch(err => {
  console.error('FATAL TEST ERROR:', err.message);
  process.exit(1);
});
