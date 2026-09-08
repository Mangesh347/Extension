# Test-mode checkout (PayPal + Razorpay)

Site: https://extension-six-alpha.vercel.app/checkout.html  
Code: `C:\Users\Lenovo\Projects\Extension`

## Prices (match extension)

| Plan | Base USD | + 18% GST |
|------|----------|-----------|
| Monthly | **$4** | $4.72 |
| Yearly | **$40** | $47.20 |
| Lifetime | **$80** | $94.40 |

Razorpay charges the INR equivalent (`INR_USD_RATE`, default 83.5).

## Master switch

```
PAYMENT_TEST_MODE=true   ← test (sandbox / rzp_test)
PAYMENT_TEST_MODE=false  ← live (real money)
```

## Vercel env (test)

Set these on the Vercel project for **extension-six-alpha**, then **Redeploy**:

```
PAYMENT_TEST_MODE=true
ALLOW_SIMULATED_CHECKOUT=true

PAYPAL_TEST_CLIENT_ID=...
PAYPAL_TEST_CLIENT_SECRET=...

RAZORPAY_TEST_KEY_ID=rzp_test_...
RAZORPAY_TEST_KEY_SECRET=...

# Keep live keys filled but unused until you flip the switch
PAYPAL_LIVE_CLIENT_ID=...
PAYPAL_LIVE_CLIENT_SECRET=...
RAZORPAY_LIVE_KEY_ID=rzp_live_...
RAZORPAY_LIVE_KEY_SECRET=...

SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
ENTITLEMENT_SECRET=...
```

**Important:** Your local `.env` still has `RAZORPAY_TEST_KEY_ID=rzp_test_paste_here` placeholders. Paste real **Test mode** keys from [Razorpay Dashboard → Test Mode → API Keys](https://dashboard.razorpay.com/app/keys).

## How to verify test payments

### 1) Config health check
Open: https://extension-six-alpha.vercel.app/api/config  

Expect something like:
- `payment_test_mode: true`
- `paypal_ready: true`
- `razorpay_ready: true`
- `razorpay_using_test_keys: true`
- `prices: { proMonthly: 4, proYearly: 40, lifetime: 80 }`

### 2) PayPal sandbox
1. Open https://extension-six-alpha.vercel.app/checkout.html?cycle=yearly  
2. Banner should say **TEST MODE**  
3. Enter a billing email you use in the extension  
4. Click **PayPal** → sandbox login (create sandbox buyers at [developer.paypal.com](https://developer.paypal.com/dashboard/accounts))  
5. Approve → return → “Payment verified”  
6. In Claude, sign into the extension with that **same email** → Pro should unlock  

### 3) Razorpay test
1. Same checkout page, prefer **INR** currency (or click Razorpay — it switches to INR)  
2. Use Razorpay test cards, e.g. `4111 1111 1111 1111`, any future expiry, any CVV  
3. UPI test flows work in Razorpay test mode too  
4. After success, same email → extension Pro unlock  

### 4) When moving to live
1. Confirm live keys are set on Vercel  
2. Set `PAYMENT_TEST_MODE=false`  
3. Redeploy  
4. Banner becomes **LIVE MODE**  
5. Do one small real payment and revoke/refund if needed  

## Local smoke test (optional)

```bash
cd C:\Users\Lenovo\Projects\Extension
npm install
node server.js
# open http://localhost:3000/checkout.html
```
