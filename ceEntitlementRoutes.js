/**
 * Claude Enhancer — email-bound Pro entitlement API
 * GET /api/user/token  — issues HMAC plan token (extension sync)
 * GET /api/user/access — lightweight Pro check by session email
 */

const crypto = require("crypto");
const {
  findProSubscription,
  summarizeSub,
  upsertProSubscription,
  isSubActive
} = require("./ceSubscriptions");

const DEVICE_LIMIT = 2;

function hashEmail(email) {
  return crypto
    .createHash("sha256")
    .update(String(email || "").toLowerCase().trim())
    .digest("hex");
}

function maskEmail(email) {
  if (!email || typeof email !== "string") return "unknown";
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const visible = local.length > 2 ? local.slice(0, 2) : local.slice(0, 1);
  return `${visible}***@${domain}`;
}

function supabaseConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { url, key, ok: Boolean(url && key) };
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Device-ID"
  );
}

function isActiveEntitlementRow(row) {
  if (!row || row.status === "revoked") return false;
  const exp = row.metadata?.expiresAt;
  if (!exp) return true;
  return new Date(exp).getTime() > Date.now();
}

async function findEntitlementByLicenseOrEmail(licenseKey, email) {
  const emailNorm = String(email || "").toLowerCase().trim();

  // Primary source of truth: pro_subscriptions
  if (emailNorm) {
    const sub = await findProSubscription(emailNorm);
    if (sub) {
      return {
        id: `sub:${sub.email}`,
        user_id: null,
        email_hash: sub.email_hash,
        payment_id: sub.payment_id,
        status: sub.status,
        metadata: {
          email: sub.email,
          plan: "pro",
          cycle: sub.cycle,
          amount: sub.amount,
          currency: sub.currency,
          gst: sub.gst,
          expiresAt: sub.expires_at,
          provider: sub.provider,
          licenseKey: sub.license_key,
          activatedAt: sub.updated_at
        },
        created_at: sub.created_at,
        _from: "pro_subscriptions"
      };
    }
  }

  const { url, key, ok } = supabaseConfig();
  if (!ok) return null;

  const keyClean = String(licenseKey || "").trim().toUpperCase();

  if (keyClean) {
    // Check pro_subscriptions by license
    const { url: u2, key: k2 } = supabaseConfig();
    const byLic = await fetch(
      `${u2}/rest/v1/pro_subscriptions?license_key=eq.${encodeURIComponent(keyClean)}&status=eq.active&select=*&limit=1`,
      {
        headers: {
          apikey: k2,
          Authorization: `Bearer ${k2}`,
          Accept: "application/json"
        }
      }
    );
    if (byLic.ok) {
      const rows = await byLic.json().catch(() => []);
      const sub = Array.isArray(rows) ? rows[0] : null;
      if (sub && isSubActive(sub)) {
        return {
          id: `sub:${sub.email}`,
          user_id: null,
          email_hash: sub.email_hash,
          payment_id: sub.payment_id,
          status: sub.status,
          metadata: {
            email: sub.email,
            plan: "pro",
            cycle: sub.cycle,
            amount: sub.amount,
            currency: sub.currency,
            expiresAt: sub.expires_at,
            provider: sub.provider,
            licenseKey: sub.license_key
          },
          created_at: sub.created_at,
          _from: "pro_subscriptions"
        };
      }
    }

    const byKey = await fetch(
      `${url}/rest/v1/entitlement_events?status=eq.active&metadata->>licenseKey=eq.${encodeURIComponent(keyClean)}&select=id,user_id,email_hash,status,metadata,created_at,payment_id&order=created_at.desc&limit=5`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json"
        }
      }
    );
    if (byKey.ok) {
      const rows = await byKey.json().catch(() => []);
      for (const row of rows || []) {
        if (!isActiveEntitlementRow(row)) continue;
        if (emailNorm) {
          const metaEmail = String(row.metadata?.email || "").toLowerCase().trim();
          const hashMatch = row.email_hash === hashEmail(emailNorm);
          if (metaEmail && metaEmail !== emailNorm && !hashMatch) continue;
        }
        return row;
      }
    }
  }

  if (emailNorm) {
    const byHash = await findActiveEntitlement(null, emailNorm);
    if (byHash) return byHash;

    const byMeta = await fetch(
      `${url}/rest/v1/entitlement_events?status=eq.active&metadata->>email=eq.${encodeURIComponent(emailNorm)}&select=id,user_id,email_hash,status,metadata,created_at,payment_id&order=created_at.desc&limit=5`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json"
        }
      }
    );
    if (byMeta.ok) {
      const rows = await byMeta.json().catch(() => []);
      for (const row of rows || []) {
        if (isActiveEntitlementRow(row)) return row;
      }
    }
  }
  return null;
}

function entitlementSummary(row, emailNorm) {
  if (!row) {
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
      lifetime: false
    };
  }
  const meta = row.metadata || {};
  const expiresAt = meta.expiresAt || null;
  const lifetime = !expiresAt;
  let daysLeft = null;
  if (expiresAt) {
    daysLeft = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  }
  return {
    plan: "pro",
    paid: true,
    email: maskEmail(meta.email || emailNorm),
    cycle: meta.cycle || null,
    amount: meta.amount != null ? meta.amount : null,
    currency: meta.currency || null,
    gst: meta.gst != null ? meta.gst : null,
    expiresAt,
    daysLeft: lifetime ? null : daysLeft,
    lifetime,
    provider: meta.provider || null,
    paymentId: row.payment_id || null,
    licenseKey: meta.licenseKey || null,
    activatedAt: meta.activatedAt || row.created_at || null
  };
}

async function upgradeProfileByEmail(email, cycle) {
  const { url, key, ok } = supabaseConfig();
  if (!ok || !email) return;
  try {
    const authRes = await fetch(
      `${url}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!authRes.ok) return;
    const data = await authRes.json();
    const userId = data?.users?.[0]?.id;
    if (!userId) return;
    const nowIso = new Date().toISOString();
    await fetch(`${url}/rest/v1/profiles?user_id=eq.${encodeURIComponent(userId)}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      body: JSON.stringify({
        plan: "pro",
        email,
        plan_started_at: nowIso,
        updated_at: nowIso
      })
    });
    // Upsert if missing
    await fetch(`${url}/rest/v1/profiles`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        user_id: userId,
        email,
        plan: "pro",
        plan_started_at: nowIso,
        cycle_start_date: nowIso,
        updated_at: nowIso,
        created_at: nowIso
      })
    });
    return userId;
  } catch (err) {
    console.warn("[CE Activate] profile upgrade:", err.message);
  }
}

async function verifySupabaseToken(token) {
  const { url, key, ok } = supabaseConfig();
  if (!ok) throw new Error("Supabase server config missing");
  const res = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: key, Authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Supabase rejected token: ${res.status}`);
  return res.json();
}

async function findActiveEntitlement(userId, email) {
  const { url, key, ok } = supabaseConfig();
  if (!ok || !email) return null;

  const emailHash = hashEmail(email);
  const filter = userId
    ? `or=(user_id.eq.${encodeURIComponent(userId)},email_hash.eq.${encodeURIComponent(emailHash)})`
    : `email_hash=eq.${encodeURIComponent(emailHash)}`;
  const res = await fetch(
    `${url}/rest/v1/entitlement_events?${filter}&status=eq.active&select=id,user_id,email_hash,payment_id,status,metadata,created_at&order=created_at.desc&limit=5`,
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
  if (!Array.isArray(rows) || !rows.length) return null;

  const now = Date.now();
  for (const row of rows) {
    const exp = row.metadata?.expiresAt;
    if (!exp) return row;
    if (new Date(exp).getTime() > now) return row;
  }
  return null;
}

async function enforceDeviceLimit(userId, deviceId) {
  const { url, key, ok } = supabaseConfig();
  if (!ok || !userId || !deviceId) return { allowed: true, deviceCount: 0, skipped: true };

  const windowStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    await fetch(`${url}/rest/v1/device_sessions`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates"
      },
      body: JSON.stringify({
        user_id: userId,
        device_id: deviceId,
        last_seen: new Date().toISOString()
      })
    });

    const listRes = await fetch(
      `${url}/rest/v1/device_sessions?user_id=eq.${encodeURIComponent(userId)}&last_seen=gte.${windowStart}&select=device_id`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Accept: "application/json"
        }
      }
    );
    const rows = listRes.ok ? await listRes.json().catch(() => []) : [];
    const unique = new Set((rows || []).map((r) => r.device_id));
    const deviceCount = unique.size;
    return { allowed: deviceCount <= DEVICE_LIMIT, deviceCount, limit: DEVICE_LIMIT };
  } catch (err) {
    console.warn("[CE Device] fail-open:", err.message);
    return { allowed: true, deviceCount: 0, warning: "device_check_failed" };
  }
}

function issueEntitlementToken(userId, plan, deviceId, expiresAt) {
  const secret = process.env.ENTITLEMENT_SECRET;
  const TOKEN_TTL_MS = 4 * 60 * 60 * 1000;
  const payload = {
    userId,
    plan,
    deviceId: deviceId || null,
    subExpiresAt: expiresAt || null,
    iat: Date.now(),
    exp: Date.now() + TOKEN_TTL_MS
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret || "missing")
    .update(payloadB64)
    .digest("hex");
  return `${payloadB64}.${sig}`;
}

function mountCeEntitlements(app) {
  app.options("/api/user/token", (req, res) => {
    cors(res);
    return res.status(204).end();
  });
  app.options("/api/user/activate-license", (req, res) => {
    cors(res);
    return res.status(204).end();
  });
  app.options("/api/user/access", (req, res) => {
    cors(res);
    return res.status(204).end();
  });

  app.options("/api/user/grant-pro", (req, res) => {
    cors(res);
    return res.status(204).end();
  });

  app.options("/api/user/plan-status", (req, res) => {
    cors(res);
    return res.status(204).end();
  });

  /**
   * GET /api/user/plan-status?email=
   * Deep verify: has this Gmail paid? cycle, amount, expiry → free or pro.
   */
  app.get("/api/user/plan-status", async (req, res) => {
    cors(res);
    try {
      const email = String(req.query.email || "").toLowerCase().trim();
      if (!email.includes("@")) {
        return res.status(400).json({ ok: false, plan: "free", error: "email required" });
      }
      const { ok: supabaseOk } = supabaseConfig();
      if (!supabaseOk) {
        return res.status(503).json({ ok: false, plan: "free", error: "Supabase not configured" });
      }

      const sub = await findProSubscription(email);
      if (sub) {
        return res.json({ ok: true, ...summarizeSub(sub, email), source: "pro_subscriptions" });
      }

      const row = await findEntitlementByLicenseOrEmail("", email);
      const summary = entitlementSummary(row, email);
      return res.json({ ok: true, ...summary, source: row ? "entitlement_events" : "none" });
    } catch (err) {
      return res.status(500).json({ ok: false, plan: "free", error: err.message });
    }
  });

  /**
   * POST /api/user/grant-pro
   * Repair / manual grant after verified payment. Auth: Bearer CRON_SECRET
   * Body: { email, cycle, amount?, currency?, provider?, paymentId?, expiresAt? }
   */
  app.post("/api/user/grant-pro", async (req, res) => {
    cors(res);
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!secret || token !== secret) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    try {
      const email = String(req.body?.email || "").toLowerCase().trim();
      const cycle = req.body?.cycle || "monthly";
      if (!email.includes("@")) return res.status(400).json({ ok: false, error: "email required" });

      let expiresAt = req.body?.expiresAt || null;
      if (!expiresAt && cycle === "monthly") {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + 30);
        expiresAt = d.toISOString();
      } else if (!expiresAt && cycle === "yearly") {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() + 365);
        expiresAt = d.toISOString();
      }

      const license =
        req.body?.licenseKey ||
        `CE-PRO-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();

      const sub = await upsertProSubscription({
        email,
        cycle,
        amount: req.body?.amount ?? null,
        currency: req.body?.currency || "USD",
        gst: req.body?.gst ?? null,
        expiresAt: cycle === "lifetime" ? null : expiresAt,
        provider: req.body?.provider || "manual",
        paymentId: req.body?.paymentId || `GRANT_${Date.now()}`,
        licenseKey: license,
        test: !!req.body?.test
      });

      return res.json({
        ok: Boolean(sub.ok),
        ...summarizeSub(sub.row, email),
        licenseKey: license,
        error: sub.error || null
      });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * POST /api/user/activate-license
   * Verify payment in Supabase by license key + billing email, then issue Pro token.
   * Works without a Supabase auth session (signed-out / guest Chrome profile).
   */
  app.post("/api/user/activate-license", async (req, res) => {
    cors(res);
    try {
      const licenseKey = String(req.body?.licenseKey || req.body?.key || "")
        .trim()
        .toUpperCase();
      const email = String(req.body?.email || "")
        .toLowerCase()
        .trim();
      const deviceId =
        String(req.body?.deviceId || req.headers["x-device-id"] || "")
          .trim()
          .slice(0, 64) || null;

      if (!licenseKey && !email) {
        return res.status(400).json({
          ok: false,
          plan: "free",
          error: "Provide the license key and/or billing email from checkout."
        });
      }

      const { ok: supabaseOk } = supabaseConfig();
      if (!supabaseOk) {
        return res.status(503).json({
          ok: false,
          plan: "free",
          error: "Payment verification unavailable — Supabase not configured."
        });
      }

      const entitlement = await findEntitlementByLicenseOrEmail(licenseKey, email);
      if (!entitlement) {
        return res.status(404).json({
          ok: false,
          plan: "free",
          error: "No successful payment found for this email/license. Finish checkout first."
        });
      }

      const billingEmail =
        String(entitlement.metadata?.email || email || "")
          .toLowerCase()
          .trim() || null;
      const expiresAt = entitlement.metadata?.expiresAt || null;
      const userId =
        entitlement.user_id ||
        (billingEmail ? `email:${hashEmail(billingEmail)}` : `license:${hashEmail(licenseKey || "unknown")}`);

      if (entitlement.user_id || billingEmail) {
        await upgradeProfileByEmail(billingEmail, entitlement.metadata?.cycle);
      }

      if (entitlement.user_id && deviceId) {
        const device = await enforceDeviceLimit(entitlement.user_id, deviceId);
        if (!device.allowed) {
          return res.status(200).json({
            ok: false,
            entitlementToken: issueEntitlementToken(userId, "free", deviceId, null),
            plan: "free",
            reason: "device_limit_exceeded",
            deviceCount: device.deviceCount,
            deviceLimit: DEVICE_LIMIT,
            message: "Pro is limited to 2 Chrome profiles per paid email."
          });
        }
      }

      const entitlementToken = issueEntitlementToken(userId, "pro", deviceId, expiresAt);
      const summary = entitlementSummary(entitlement, billingEmail);
      return res.status(200).json({
        ok: true,
        entitlementToken,
        plan: "pro",
        email: billingEmail ? maskEmail(billingEmail) : null,
        expiresAt,
        cycle: entitlement.metadata?.cycle || null,
        amount: entitlement.metadata?.amount ?? null,
        currency: entitlement.metadata?.currency || null,
        provider: entitlement.metadata?.provider || null,
        daysLeft: summary.daysLeft,
        lifetime: summary.lifetime,
        licenseKey: entitlement.metadata?.licenseKey || licenseKey || null,
        expiresIn: 4 * 60 * 60 * 1000
      });
    } catch (err) {
      console.error("[CE Activate]", err);
      return res.status(500).json({ ok: false, plan: "free", error: err.message || "Activation failed" });
    }
  });

  app.options("/api/user/pro-welcome", (req, res) => {
    cors(res);
    return res.status(204).end();
  });

  /**
   * POST /api/user/pro-welcome — once when extension first shows Pro for this email
   */
  app.post("/api/user/pro-welcome", async (req, res) => {
    cors(res);
    try {
      const email = String(req.body?.email || "").toLowerCase().trim();
      if (!email.includes("@")) return res.status(400).json({ ok: false, error: "email required" });
      const row = await findEntitlementByLicenseOrEmail("", email);
      if (!row || !isActiveEntitlementRow(row)) {
        return res.json({ ok: false, plan: "free", sent: false });
      }
      const meta = row.metadata || {};
      if (meta.welcomeOnClaudeSent) {
        return res.json({ ok: true, plan: "pro", sent: false, already: true });
      }
      const { sendWelcomeOnClaudeEmail } = require("./ceMail");
      await sendWelcomeOnClaudeEmail({
        email,
        cycle: meta.cycle,
        expiresAt: meta.expiresAt
      });
      const { url, key } = supabaseConfig();
      await fetch(`${url}/rest/v1/entitlement_events?id=eq.${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ metadata: { ...meta, welcomeOnClaudeSent: true } })
      });
      return res.json({ ok: true, plan: "pro", sent: true });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get("/api/user/token", async (req, res) => {
    cors(res);
    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;
      if (!token) return res.status(401).json({ error: "Authorization required." });

      const deviceId = String(req.headers["x-device-id"] || "")
        .trim()
        .slice(0, 64) || null;

      let verifiedUser;
      try {
        verifiedUser = await verifySupabaseToken(token);
      } catch {
        return res.status(401).json({ error: "Invalid or expired session." });
      }

      const userId = verifiedUser.id;
      const userEmail = String(verifiedUser.email || "").toLowerCase().trim();

      const device = await enforceDeviceLimit(userId, deviceId);
      if (!device.allowed) {
        // #region agent log
        fetch("http://127.0.0.1:7652/ingest/113581e5-ff03-4b98-9529-daa3d76e3789", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "a325af"
          },
          body: JSON.stringify({
            sessionId: "a325af",
            runId: "pro-unlock",
            hypothesisId: "P3",
            location: "ceEntitlementRoutes.js:token",
            message: "Device limit blocked Pro",
            data: { email: maskEmail(userEmail), deviceCount: device.deviceCount },
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion
        return res.status(200).json({
          entitlementToken: issueEntitlementToken(userId, "free", deviceId, null),
          plan: "free",
          reason: "device_limit_exceeded",
          deviceCount: device.deviceCount,
          deviceLimit: DEVICE_LIMIT,
          message: "Pro is limited to 2 Chrome profiles per paid email."
        });
      }

      const entitlement = await findActiveEntitlement(userId, userEmail);
      const hasAccess = Boolean(entitlement);
      const expiresAt = entitlement?.metadata?.expiresAt || null;
      const plan = hasAccess ? "pro" : "free";
      const entitlementToken = issueEntitlementToken(userId, plan, deviceId, expiresAt);

      // #region agent log
      fetch("http://127.0.0.1:7652/ingest/113581e5-ff03-4b98-9529-daa3d76e3789", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Debug-Session-Id": "a325af"
        },
        body: JSON.stringify({
          sessionId: "a325af",
          runId: "pro-unlock",
          hypothesisId: "P1",
          location: "ceEntitlementRoutes.js:token",
          message: "Entitlement token issued",
          data: {
            email: maskEmail(userEmail),
            plan,
            hasEntitlement: hasAccess,
            cycle: entitlement?.metadata?.cycle || null
          },
          timestamp: Date.now()
        })
      }).catch(() => {});
      // #endregion

      return res.status(200).json({
        entitlementToken,
        plan,
        expiresAt,
        deviceCount: device.deviceCount,
        deviceLimit: DEVICE_LIMIT,
        expiresIn: 4 * 60 * 60 * 1000
      });
    } catch (err) {
      console.error("[CE Token]", err);
      return res.status(500).json({ error: err.message || "Token failed" });
    }
  });

  // Replace legacy stub: session-aware access check
  app.get("/api/user/access", async (req, res) => {
    cors(res);
    try {
      const authHeader = req.headers.authorization || "";
      const bearer = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;

      let email = String(req.query.email || "").toLowerCase().trim();
      let userId = null;

      if (bearer) {
        try {
          const user = await verifySupabaseToken(bearer);
          userId = user.id;
          email = String(user.email || email).toLowerCase().trim();
        } catch {
          return res.status(401).json({ hasAccess: false, plan: "free", error: "Invalid session" });
        }
      }

      if (!email) {
        return res.json({ hasAccess: false, plan: "free", status: "no_email" });
      }

      const entitlement = await findActiveEntitlement(userId, email);
      const hasAccess = Boolean(entitlement);
      return res.json({
        hasAccess,
        plan: hasAccess ? "pro" : "free",
        status: hasAccess ? "active" : "none",
        expiresAt: entitlement?.metadata?.expiresAt || null,
        cycle: entitlement?.metadata?.cycle || null,
        email: maskEmail(email)
      });
    } catch (err) {
      return res.status(500).json({ hasAccess: false, plan: "free", error: err.message });
    }
  });
}

module.exports = {
  mountCeEntitlements,
  findActiveEntitlement,
  findEntitlementByLicenseOrEmail,
  hashEmail,
  DEVICE_LIMIT
};
