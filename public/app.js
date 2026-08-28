// State and Configuration
let appConfig = {
  environment: 'sandbox',
  clientToken: '',
  prices: {
    proMonthly: 'pri_01m0fh3wan3ys1as29tqnn6st3',
    proYearly: 'pri_01m0fh5q767z9g97r0tteajsdh',
    lifetime: 'pri_01m0fh9dz24xy9gp99q8zm2f62'
  }
};

let activeBillingCycle = 'year'; // 'year' or 'month'
let localizedPriceMap = {};
let isPaddleInitialized = false;

// DOM Elements
const billingToggle = document.getElementById('billing-toggle');
const monthlyLabel = document.getElementById('monthly-label');
const yearlyLabel = document.getElementById('yearly-label');
const proPriceDisplay = document.getElementById('pro-price-display');
const proPeriodDisplay = document.getElementById('pro-period-display');
const proTrialDisplay = document.getElementById('pro-trial-display');
const lifetimePriceDisplay = document.getElementById('lifetime-price-display');
const btnBuyPro = document.getElementById('btn-buy-pro');
const btnBuyLifetime = document.getElementById('btn-buy-lifetime');
const locCountryBadge = document.getElementById('loc-country-badge');

// Fetch safe client-side config from server
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error(`Config fetch failed: ${res.statusText}`);
    const data = await res.json();
    appConfig = { ...appConfig, ...data };
    console.log('Client configuration loaded successfully:', {
      environment: appConfig.environment,
      hasToken: Boolean(appConfig.clientToken),
      prices: appConfig.prices
    });
  } catch (error) {
    console.warn('Could not fetch server config, using fallback sandbox defaults:', error);
  }
}

// Initialize Paddle.js
function initPaddle(customerId = null) {
  if (typeof Paddle === 'undefined') {
    console.error('Paddle.js failed to load from CDN.');
    return;
  }

  // Set sandbox mode only when configured for sandbox; live mode uses default production
  if (appConfig.environment === 'sandbox') {
    Paddle.Environment.set('sandbox');
  }

  const initOptions = {
    token: appConfig.clientToken || 'test_000b701cf737ed9bf96b5a35554',
    eventCallback: function (event) {
      console.log('Paddle Event received:', event.name, event.data);
      if (event.name === 'checkout.completed') {
        window.location.href = '/welcome';
      }
    }
  };

  // Paddle Retain support for churn prevention / subscription recovery
  if (customerId && customerId.startsWith('ctm_')) {
    initOptions.pwCustomer = { id: customerId };
  }

  Paddle.Initialize(initOptions);
  isPaddleInitialized = true;
  console.log(`Paddle.js v2 initialized successfully in [${appConfig.environment.toUpperCase()}] mode.`);

  // Fetch localized pricing via Paddle.PricePreview
  fetchLocalizedPrices();
}

// Fetch localized pricing with Paddle.PricePreview()
function fetchLocalizedPrices() {
  if (!isPaddleInitialized || typeof Paddle.PricePreview !== 'function') {
    return;
  }

  const items = [
    { priceId: appConfig.prices.proMonthly, quantity: 1 },
    { priceId: appConfig.prices.proYearly, quantity: 1 },
    { priceId: appConfig.prices.lifetime, quantity: 1 }
  ];

  Paddle.PricePreview({ items })
    .then((result) => {
      console.log('Paddle PricePreview Result:', result);
      
      const lineItems = result?.data?.details?.lineItems || 
                        result?.details?.lineItems || 
                        result?.data?.details?.line_items || 
                        [];

      const currencyCode = result?.data?.currencyCode || 
                           result?.currencyCode || 
                           result?.data?.details?.currencyCode || 
                           'USD';

      if (locCountryBadge) {
        locCountryBadge.textContent = `${currencyCode} (Auto-Localized)`;
      }

      lineItems.forEach((item) => {
        const priceId = item.price?.id || item.priceId || item.id;
        const formattedPrice = item.formattedTotals?.subtotal || 
                               item.formattedTotals?.total || 
                               item.formattedUnitTotals?.subtotal || 
                               item.formatted_totals?.subtotal || 
                               item.formatted_totals?.total;

        if (priceId && formattedPrice) {
          localizedPriceMap[priceId] = formattedPrice;
        }
      });

      // Update UI with localized prices
      updatePriceDisplay();
    })
    .catch((error) => {
      console.warn('PricePreview localization error (displaying default catalog prices):', error);
      if (locCountryBadge) {
        locCountryBadge.textContent = 'USD (Standard)';
      }
    });
}

// Update UI according to active billing cycle and price preview
function updatePriceDisplay() {
  const isYearly = activeBillingCycle === 'year';

  if (isYearly) {
    const yearlyPrice = localizedPriceMap[appConfig.prices.proYearly] || '$39.00';
    if (proPriceDisplay) proPriceDisplay.textContent = yearlyPrice;
    if (proPeriodDisplay) proPeriodDisplay.textContent = '/ year';
    if (proTrialDisplay) proTrialDisplay.textContent = '✓ Includes 15-day free trial (Save ~35%)';
    if (btnBuyPro) btnBuyPro.textContent = 'Start 15-Day Free Trial';
  } else {
    const monthlyPrice = localizedPriceMap[appConfig.prices.proMonthly] || '$4.99';
    if (proPriceDisplay) proPriceDisplay.textContent = monthlyPrice;
    if (proPeriodDisplay) proPeriodDisplay.textContent = '/ month';
    if (proTrialDisplay) proTrialDisplay.textContent = '✓ Includes 15-day free trial';
    if (btnBuyPro) btnBuyPro.textContent = 'Start 15-Day Free Trial';
  }

  const lifetimePrice = localizedPriceMap[appConfig.prices.lifetime] || '$59.00';
  if (lifetimePriceDisplay) {
    lifetimePriceDisplay.textContent = lifetimePrice;
  }
}

// Open Paddle Checkout Overlay with dynamic automatic global payment methods
window.openCheckout = function (priceId) {
  if (!priceId) {
    console.error('No priceId provided to openCheckout.');
    return;
  }

  if (typeof Paddle === 'undefined' || !isPaddleInitialized) {
    alert('Paddle checkout is initializing. Please try again in a moment.');
    return;
  }

  console.log('Opening Paddle Checkout Overlay for Price ID:', priceId);

  // Note: allowedPaymentMethods is intentionally omitted so Paddle automatically
  // provides all available global payment methods for customer location and currency,
  // including Cards, PayPal, Apple Pay, Google Pay, and localized regional payment methods.
  Paddle.Checkout.open({
    settings: {
      displayMode: 'overlay',
      theme: 'light',
      locale: 'en',
      successUrl: window.location.origin + '/welcome'
    },
    items: [
      {
        priceId: priceId,
        quantity: 1
      }
    ]
  });
};

// Convenience handler for Pro Checkout (Monthly or Yearly)
window.checkoutPro = function () {
  const priceId = activeBillingCycle === 'year' 
    ? appConfig.prices.proYearly 
    : appConfig.prices.proMonthly;
  window.openCheckout(priceId);
};

// Convenience handler for Lifetime Checkout
window.checkoutLifetime = function () {
  window.openCheckout(appConfig.prices.lifetime);
};

// Setup event listeners
function setupEventListeners() {
  if (billingToggle) {
    billingToggle.addEventListener('change', (e) => {
      activeBillingCycle = e.target.checked ? 'year' : 'month';
      if (activeBillingCycle === 'year') {
        yearlyLabel?.classList.add('active');
        monthlyLabel?.classList.remove('active');
      } else {
        monthlyLabel?.classList.add('active');
        yearlyLabel?.classList.remove('active');
      }
      updatePriceDisplay();
    });
  }

  monthlyLabel?.addEventListener('click', () => {
    if (billingToggle) {
      billingToggle.checked = false;
      billingToggle.dispatchEvent(new Event('change'));
    }
  });

  yearlyLabel?.addEventListener('click', () => {
    if (billingToggle) {
      billingToggle.checked = true;
      billingToggle.dispatchEvent(new Event('change'));
    }
  });
}

// App Initialization
async function initApp() {
  const yearSpan = document.getElementById('year');
  if (yearSpan) {
    yearSpan.textContent = new Date().getFullYear();
  }

  setupEventListeners();
  await loadConfig();
  initPaddle();
  updatePriceDisplay();
}

document.addEventListener('DOMContentLoaded', initApp);
