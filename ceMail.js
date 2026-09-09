/**
 * Transactional email (Resend). Used after verified PayPal / Razorpay capture.
 */

async function sendMail({ to, subject, html, text }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || "Claude Enhancer <billing@fenwicklabs.com>";

  if (!to || !subject) return { ok: false, error: "missing_to_or_subject" };

  if (!apiKey) {
    console.log(`[CE Mail] SKIP (no RESEND_API_KEY) to=${to} subject=${subject}`);
    return { ok: true, skipped: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from, to: [to], subject, html, text })
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn("[CE Mail] send failed:", res.status, body);
      return { ok: false, error: `resend_${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.warn("[CE Mail] error:", err.message);
    return { ok: false, error: err.message };
  }
}

function formatDate(iso) {
  if (!iso) return "Lifetime (never expires)";
  try {
    return new Date(iso).toLocaleDateString("en-IN", {
      year: "numeric",
      month: "long",
      day: "numeric"
    });
  } catch {
    return String(iso);
  }
}

function money(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return String(amount || "");
  const cur = String(currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);
  } catch {
    return `${cur} ${n.toFixed(2)}`;
  }
}

/**
 * Payment receipt + Pro welcome — sent only after payment is verified.
 */
async function sendPaymentReceiptEmail({
  email,
  cycle,
  expiresAt,
  licenseKey,
  amount,
  currency,
  provider,
  paymentId,
  gst,
  subtotal,
  test
}) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };

  const endLabel = formatDate(expiresAt);
  const cycleLabel = cycle === "lifetime" ? "Lifetime" : cycle === "monthly" ? "Monthly" : "Yearly";
  const paid = money(amount, currency);
  const providerLabel = provider === "razorpay" ? "Razorpay" : provider === "paypal" ? "PayPal" : String(provider || "Checkout");
  const openUrl = `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(to)}${licenseKey ? `&key=${encodeURIComponent(licenseKey)}` : ""}`;

  const subject = test
    ? `[Test] Claude Enhancer Pro receipt — ${cycleLabel}`
    : `Claude Enhancer Pro receipt — ${cycleLabel}`;

  const html = `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">
      <h1 style="font-size:22px;margin:0 0 12px">Payment verified</h1>
      <p style="margin:0 0 16px">Thanks — Claude Enhancer <strong>Pro</strong> is active for <strong>${to}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>Pro · ${cycleLabel}</strong></td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Amount paid</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${paid}</strong>${gst != null ? ` <span style="color:#666">(incl. GST)</span>` : ""}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Paid via</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${providerLabel}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Valid until</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${endLabel}</strong></td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Reference</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${paymentId || "—"}</td></tr>
      </table>
      <p style="margin:0 0 16px">Open Claude signed in with <strong>${to}</strong>. Claude Enhancer switches to <strong>Pro</strong> automatically — no license key to paste.</p>
      <p style="margin:0 0 24px">
        <a href="${openUrl}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">Open Claude Enhancer Pro</a>
      </p>
      <p style="color:#666;font-size:13px;margin:0">Pro works on up to 2 Chrome profiles with this email.${test ? " This was a test-mode payment." : ""}</p>
    </div>`;

  const text = [
    `Payment verified — Claude Enhancer Pro (${cycleLabel}) for ${to}.`,
    `Amount: ${paid}`,
    `Valid until: ${endLabel}`,
    `Open Claude with this Gmail to unlock Pro: ${openUrl}`
  ].join("\n");

  return sendMail({ to, subject, html, text });
}

module.exports = {
  sendMail,
  sendPaymentReceiptEmail,
  formatDate
};
