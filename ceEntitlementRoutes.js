/**
 * Claude Enhancer — email-bound Pro entitlement API
 * GET /api/user/token  — issues HMAC plan token (extension sync)
 * GET /api/user/access — lightweight Pro check by session email
 */

const crypto = require("crypto");

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
  const { url, key, ok } = supabaseConfig();
  if (!ok) return null;

  const keyClean = String(licenseKey || "").trim().toUpperCase();
  const emailNorm = String(email || "").toLowerCase().trim();

  if (keyClean) {
    const byKey = await fetch(
      `${url}/rest/v1/entitlement_events?status=eq.active&metadata->>licenseKey=eq.${encodeURIComponent(keyClean)}&select=id,user_id,email_hash,status,metadata,created_at&order=created_at.desc&limit=5`,
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
    return findActiveEntitlement(null, emailNorm);
  }
  return null;
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
  const res = await fetch(
    `${url}/rest/v1/entitlement_events?or=(user_id.eq.${encodeURIComponent(userId || "")},email_hash.eq.${encodeURIComponent(emailHash)})&status=eq.active&select=id,metadata,created_at&order=created_at.desc&limit=5`,
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
      return res.status(200).json({
        ok: true,
        entitlementToken,
        plan: "pro",
        email: billingEmail ? maskEmail(billingEmail) : null,
        expiresAt,
        cycle: entitlement.metadata?.cycle || null,
        licenseKey: entitlement.metadata?.licenseKey || licenseKey || null,
        expiresIn: 4 * 60 * 60 * 1000
      });
    } catch (err) {
      console.error("[CE Activate]", err);
      return res.status(500).json({ ok: false, plan: "free", error: err.message || "Activation failed" });
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
