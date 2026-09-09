/**
 * pro_subscriptions — source of truth for free/pro by billing email.
 */

const crypto = require("crypto");

function hashEmail(email) {
  return crypto
    .createHash("sha256")
    .update(String(email || "").toLowerCase().trim())
    .digest("hex");
}

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, ok: Boolean(url && key) };
}

function isSubActive(row) {
  if (!row || row.status !== "active" || row.plan !== "pro") return false;
  if (!row.expires_at) return true; // lifetime
  return new Date(row.expires_at).getTime() > Date.now();
}

function summarizeSub(row, emailNorm) {
  if (!row || !isSubActive(row)) {
    return {
      plan: "free",
      paid: false,
      email: emailNorm || null,
      cycle: null,
      amount: null,
      currency: null,
      expiresAt: null,
      daysLeft: null,
      provider: null,
      paymentId: null,
      lifetime: false,
      licenseKey: null
    };
  }
  const expiresAt = row.expires_at || null;
  const lifetime = !expiresAt;
  let daysLeft = null;
  if (expiresAt) {
    daysLeft = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  }
  return {
    plan: "pro",
    paid: true,
    email: emailNorm || row.email,
    cycle: row.cycle || null,
    amount: row.amount != null ? Number(row.amount) : null,
    currency: row.currency || null,
    gst: row.gst != null ? Number(row.gst) : null,
    expiresAt,
    daysLeft: lifetime ? null : daysLeft,
    lifetime,
    provider: row.provider || null,
    paymentId: row.payment_id || null,
    licenseKey: row.license_key || null,
    activatedAt: row.updated_at || row.created_at || null
  };
}

async function upsertProSubscription({
  email,
  cycle,
  amount,
  currency,
  gst,
  expiresAt,
  provider,
  paymentId,
  licenseKey,
  test
}) {
  const { url, key, ok } = supabaseConfig();
  const emailNorm = String(email || "").toLowerCase().trim();
  if (!ok || !emailNorm.includes("@")) {
    return { ok: false, error: "missing_supabase_or_email" };
  }

  const nowIso = new Date().toISOString();
  const body = {
    email: emailNorm,
    email_hash: hashEmail(emailNorm),
    plan: "pro",
    cycle: cycle || "yearly",
    amount: amount != null ? amount : null,
    currency: currency || null,
    gst: gst != null ? gst : null,
    expires_at: expiresAt || null,
    provider: provider || null,
    payment_id: paymentId || null,
    license_key: licenseKey || null,
    status: "active",
    metadata: {
      paymentMode: test ? "test" : "live",
      activatedAt: nowIso
    },
    updated_at: nowIso,
    created_at: nowIso
  };

  const res = await fetch(`${url}/rest/v1/pro_subscriptions`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.warn("[CE Sub] upsert failed:", res.status, t.slice(0, 300));
    return { ok: false, status: res.status, error: t.slice(0, 300) };
  }

  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : rows;
  return { ok: true, row, summary: summarizeSub(row, emailNorm) };
}

async function findProSubscription(email) {
  const { url, key, ok } = supabaseConfig();
  const emailNorm = String(email || "").toLowerCase().trim();
  if (!ok || !emailNorm.includes("@")) return null;

  const res = await fetch(
    `${url}/rest/v1/pro_subscriptions?email=eq.${encodeURIComponent(emailNorm)}&select=*&limit=1`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      }
    }
  );
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  if (!isSubActive(row)) return null;
  return row;
}

async function expireDueSubscriptions() {
  const { url, key, ok } = supabaseConfig();
  if (!ok) return { ok: false, expired: 0 };
  const nowIso = new Date().toISOString();
  const listRes = await fetch(
    `${url}/rest/v1/pro_subscriptions?status=eq.active&expires_at=not.is.null&expires_at=lte.${encodeURIComponent(nowIso)}&select=email,expires_at,cycle&limit=200`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      }
    }
  );
  if (!listRes.ok) return { ok: false, expired: 0 };
  const rows = await listRes.json().catch(() => []);
  let expired = 0;
  for (const row of rows || []) {
    await fetch(
      `${url}/rest/v1/pro_subscriptions?email=eq.${encodeURIComponent(row.email)}`,
      {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          status: "expired",
          plan: "free",
          updated_at: nowIso
        })
      }
    );
    expired += 1;
  }
  return { ok: true, expired, rows: rows || [] };
}

module.exports = {
  hashEmail,
  supabaseConfig,
  upsertProSubscription,
  findProSubscription,
  summarizeSub,
  isSubActive,
  expireDueSubscriptions
};
