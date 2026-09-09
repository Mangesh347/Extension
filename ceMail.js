/**
 * Transactional email (Resend) — important lifecycle only (receipt, welcome, ending, expired, renew).
 */

const CHECKOUT = "https://extension-six-alpha.vercel.app/checkout.html";

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

function cycleLabel(cycle) {
  if (cycle === "lifetime") return "Lifetime";
  if (cycle === "monthly") return "Monthly";
  return "Yearly";
}

function shell(title, bodyHtml) {
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111;line-height:1.5">
      <h1 style="font-size:22px;margin:0 0 12px">${title}</h1>
      ${bodyHtml}
      <p style="color:#888;font-size:12px;margin:28px 0 0">Claude Enhancer · Fenwick Labs</p>
    </div>`;
}

function cta(href, label) {
  return `<p style="margin:20px 0"><a href="${href}" style="display:inline-block;padding:12px 18px;background:#111;color:#fff;text-decoration:none;border-radius:8px;font-weight:600">${label}</a></p>`;
}

/** 1) Payment verified receipt */
async function sendPaymentReceiptEmail({
  email, cycle, expiresAt, licenseKey, amount, currency, provider, paymentId, gst, test
}) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };

  const endLabel = formatDate(expiresAt);
  const paid = money(amount, currency);
  const openUrl = `https://claude.ai/?ce_pro=1&email=${encodeURIComponent(to)}${licenseKey ? `&key=${encodeURIComponent(licenseKey)}` : ""}`;
  const subject = test
    ? `[Test] Receipt — Claude Enhancer Pro (${cycleLabel(cycle)})`
    : `Receipt — Claude Enhancer Pro (${cycleLabel(cycle)})`;

  const html = shell("Payment verified", `
      <p>Thanks — <strong>Pro</strong> is active for <strong>${to}</strong>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px;margin:16px 0">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Plan</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>Pro · ${cycleLabel(cycle)}</strong></td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Amount</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${paid}</strong>${gst != null ? " (incl. GST)" : ""}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Paid via</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right">${provider === "razorpay" ? "Razorpay" : "PayPal"}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eee;color:#666">Valid until</td><td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right"><strong>${endLabel}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666">Reference</td><td style="padding:8px 0;text-align:right;font-family:ui-monospace,monospace;font-size:12px">${paymentId || "—"}</td></tr>
      </table>
      <p>Open Claude with <strong>${to}</strong> — Pro unlocks automatically.</p>
      ${cta(openUrl, "Open Claude Enhancer Pro")}
      <p style="color:#666;font-size:13px">Up to 2 Chrome profiles.${test ? " Test-mode payment." : ""}</p>
  `);

  return sendMail({
    to,
    subject,
    html,
    text: `Pro (${cycleLabel(cycle)}) for ${to}. Paid ${paid}. Until ${endLabel}. Open: ${openUrl}`
  });
}

/** 2) Welcome when Pro first activates on Claude */
async function sendWelcomeOnClaudeEmail({ email, cycle, expiresAt }) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };
  const endLabel = formatDate(expiresAt);
  return sendMail({
    to,
    subject: "Welcome — Claude Enhancer Pro is on",
    html: shell("Welcome to Pro", `
      <p>You’re signed in as <strong>${to}</strong> and Pro is active.</p>
      <p>Plan: <strong>${cycleLabel(cycle)}</strong> · Valid until <strong>${endLabel}</strong></p>
      <p>Enjoy unlimited exports, all Prism veins, and Fun Mode critters.</p>
      ${cta("https://claude.ai", "Back to Claude")}
    `),
    text: `Pro active for ${to} until ${endLabel}.`
  });
}

/** 3) Renewal reminder (7d / 1d) */
async function sendRenewalReminderEmail({ email, cycle, expiresAt, daysLeft }) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };
  const endLabel = formatDate(expiresAt);
  const renewUrl = `${CHECKOUT}?cycle=${cycle || "yearly"}&email=${encodeURIComponent(to)}`;
  const when = daysLeft <= 1 ? "tomorrow" : `in ${Math.ceil(daysLeft)} days`;
  return sendMail({
    to,
    subject: `Pro ends ${when} — renew to keep access`,
    html: shell("Your Pro plan is ending soon", `
      <p>Hi — Pro for <strong>${to}</strong> (${cycleLabel(cycle)}) ends on <strong>${endLabel}</strong>.</p>
      <p>Renew now so unlimited exports and Fun Mode stay on.</p>
      ${cta(renewUrl, "Renew Pro")}
      <p style="color:#666;font-size:13px">Already renewed? You can ignore this.</p>
    `),
    text: `Pro ends ${endLabel}. Renew: ${renewUrl}`
  });
}

/** 4) Expired → Free */
async function sendExpiredEmail({ email, expiresAt }) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };
  const endLabel = formatDate(expiresAt);
  const renewUrl = `${CHECKOUT}?email=${encodeURIComponent(to)}`;
  return sendMail({
    to,
    subject: "Pro ended — you’re back on Free",
    html: shell("Pro access ended", `
      <p>Pro for <strong>${to}</strong> ended on <strong>${endLabel}</strong>. Claude Enhancer is on Free limits again.</p>
      ${cta(renewUrl, "Upgrade to Pro again")}
    `),
    text: `Pro ended ${endLabel}. Upgrade: ${renewUrl}`
  });
}

/** 5) Renewed / upgraded again */
async function sendRenewedEmail({ email, cycle, expiresAt, amount, currency }) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };
  return sendMail({
    to,
    subject: "Pro renewed — you’re all set",
    html: shell("Pro renewed", `
      <p>Payment received for <strong>${to}</strong>.</p>
      <p>Plan: <strong>${cycleLabel(cycle)}</strong> · ${money(amount, currency)} · until <strong>${formatDate(expiresAt)}</strong></p>
      ${cta("https://claude.ai/?ce_pro=1&email=" + encodeURIComponent(to), "Open Claude Enhancer Pro")}
    `),
    text: `Pro renewed for ${to} until ${formatDate(expiresAt)}.`
  });
}

/** 6) Lifetime thank-you */
async function sendLifetimeThanksEmail({ email, amount, currency }) {
  const to = String(email || "").toLowerCase().trim();
  if (!to.includes("@")) return { ok: false, error: "bad_email" };
  return sendMail({
    to,
    subject: "Lifetime Pro — thank you",
    html: shell("Lifetime Pro unlocked", `
      <p>Thank you for supporting Claude Enhancer. Lifetime Pro is active for <strong>${to}</strong>${amount != null ? ` (${money(amount, currency)})` : ""}.</p>
      ${cta("https://claude.ai/?ce_pro=1&email=" + encodeURIComponent(to), "Open Claude")}
    `),
    text: `Lifetime Pro active for ${to}.`
  });
}

module.exports = {
  sendMail,
  sendPaymentReceiptEmail,
  sendWelcomeOnClaudeEmail,
  sendRenewalReminderEmail,
  sendExpiredEmail,
  sendRenewedEmail,
  sendLifetimeThanksEmail,
  formatDate,
  CHECKOUT
};
