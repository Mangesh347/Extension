const dotenv = require('dotenv');
const db = require('./db');

dotenv.config();

/**
 * Mint or retrieve an authenticated Paddle Customer Portal Session
 * Fully hosted by Paddle for subscription management, payment method updates, invoice downloads, and cancellations.
 */
async function createCustomerPortalSession(customerId, subscriptionIds = []) {
  if (!customerId) {
    throw new Error('Customer ID is required to create a customer portal session');
  }

  const apiKey = process.env.PADDLE_API_KEY;
  const isSandbox = (process.env.PADDLE_ENVIRONMENT || 'sandbox').toLowerCase() === 'sandbox';
  const baseUrl = isSandbox ? 'https://sandbox-api.paddle.com' : 'https://api.paddle.com';

  // 1. If API key is configured, mint a fresh dynamic session
  if (apiKey) {
    const payload = {};
    if (Array.isArray(subscriptionIds) && subscriptionIds.length > 0) {
      payload.subscription_ids = subscriptionIds;
    }

    try {
      const response = await fetch(`${baseUrl}/customers/${customerId}/portal-sessions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      if (response.ok) {
        const json = await response.json();
        const generalUrl = json.data?.urls?.general?.overview;
        const subUrl = json.data?.urls?.subscriptions?.[0]?.update_subscription_payment_method;
        const portalUrl = generalUrl || subUrl;

        return {
          id: json.data?.id,
          url: portalUrl,
          urls: json.data?.urls
        };
      } else {
        const errorText = await response.text();
        console.warn(`[Portal Service] Dynamic portal session request returned ${response.status}: ${errorText}`);
      }
    } catch (apiErr) {
      console.warn('[Portal Service] Dynamic session API request failed, checking stored management URLs:', apiErr.message);
    }
  }

  // 2. Check stored authenticated management URLs from customer's active subscriptions
  const subscriptions = db.getSubscriptionsByCustomerId(customerId);
  for (const sub of subscriptions) {
    if (sub.management_urls) {
      const directUrl = sub.management_urls.overview || 
                        sub.management_urls.update_payment_method || 
                        sub.management_urls.cancel;
      if (directUrl) {
        return {
          url: directUrl,
          urls: sub.management_urls,
          isStoredUrl: true
        };
      }
    }
  }

  // 3. Fallback to your official Live Hosted Customer Portal link
  const livePortalLink = process.env.PADDLE_CUSTOMER_PORTAL_URL || 'https://customer-portal.paddle.com/cpl_01m0fg5ec1wrkp49mb9t95pex4';
  return {
    url: livePortalLink,
    isHostedLink: true
  };
}

module.exports = {
  createCustomerPortalSession
};
