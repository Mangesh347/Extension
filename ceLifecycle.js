/**
 * Subscription lifecycle: expire Pros past expiresAt, send 7d/1d reminders.
 * Mounted on Extension Vercel as GET/POST /api/cron/subscription-lifecycle
 * Auth: Authorization: Bearer $CRON_SECRET
 */

const crypto = require("crypto");
const {
  sendRenewalReminderEmail,
  sendExpiredEmail,
  CHECKOUT
} = require("./ceMail");

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, ok: Boolean(url && key) };
}

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret));
  } catch {
    return false;
  }
}

async function runLifecycle() {
  const { url, key, ok } = supabaseConfig();
  if (!ok) return { ok: false, error: "Supabase not configured" };

  const now = Date.now();
  const listRes = await fetch(
    `${url}/rest/v1/entitlement_events?status=eq.active&select=id,user_id,payment_id,metadata&order=created_at.desc&limit=500`,
    {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      }
    }
  );
  if (!listRes.ok) return { ok: false, error: "list_failed", status: listRes.status };

  const rows = await listRes.json().catch(() => []);
  let expired = 0;
  let reminded = 0;

  for (const row of rows || []) {
    const meta = row.metadata || {};
    const expiresAt = meta.expiresAt;
    if (!expiresAt) continue; // lifetime
    const expMs = new Date(expiresAt).getTime();
    const email = String(meta.email || "").toLowerCase().trim();
    if (!email) continue;

    if (expMs <= now) {
      await fetch(`${url}/rest/v1/entitlement_events?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          status: "expired",
          metadata: { ...meta, expiredAt: new Date().toISOString(), expiredMailSent: true }
        })
      });
      if (row.user_id) {
        await fetch(`${url}/rest/v1/profiles?user_id=eq.${encodeURIComponent(row.user_id)}`, {
          method: "PATCH",
          headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ plan: "free", updated_at: new Date().toISOString() })
        }).catch(() => {});
      }
      if (!meta.expiredMailSent) {
        await sendExpiredEmail({ email, expiresAt });
      }
      expired += 1;
      continue;
    }

    const daysLeft = (expMs - now) / (24 * 60 * 60 * 1000);
    const send7 = daysLeft <= 7 && daysLeft > 6 && !meta.remind7d;
    const send1 = daysLeft <= 1 && daysLeft > 0 && !meta.remind1d;
    if (send7 || send1) {
      await sendRenewalReminderEmail({
        email,
        cycle: meta.cycle,
        expiresAt,
        daysLeft
      });
      const patch = { ...meta };
      if (send1) patch.remind1d = true;
      if (send7) patch.remind7d = true;
      await fetch(`${url}/rest/v1/entitlement_events?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ metadata: patch })
      });
      reminded += 1;
    }
  }

  return { ok: true, expired, reminded, checkout: CHECKOUT };
}

function mountCeLifecycle(app) {
  const handler = async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!authorized(req)) return res.status(401).json({ error: "Unauthorized" });
    try {
      const result = await runLifecycle();
      return res.status(result.ok ? 200 : 500).json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  };
  app.get("/api/cron/subscription-lifecycle", handler);
  app.post("/api/cron/subscription-lifecycle", handler);
}

module.exports = { mountCeLifecycle, runLifecycle };
