const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// --- helpers ---
function normalizeAuth(authHeaderRaw = "") {
  const raw = String(authHeaderRaw || "").trim();
  if (!raw) return "";
  // Accept either "token" or "Bearer token"
  return raw.toLowerCase().startsWith("bearer ")
    ? raw.slice(7).trim()
    : raw;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function decodeMaybe(v) {
  if (v === undefined || v === null) return v;
  const s = String(v);
  try {
    return s.includes("%") ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}

function makeDebugId() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Math.random().toString(16).slice(2, 10)
  );
}

function isoNow() {
  return new Date().toISOString();
}

function isoPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function requireEnv(name) {
  const v = String(process.env[name] || "").trim();
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

// --- Mindbody: Classes endpoint ---
async function mindbodyGetClasses({ startDateTime, endDateTime }) {
  const baseUrl = String(process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6")
    .trim()
    .replace(/\/+$/, "");

  const apiKey = requireEnv("MINDBODY_API_KEY");
  const siteId = requireEnv("MINDBODY_SITE_ID");

  const url = `${baseUrl}/class/classes`;

  const headers = {
    "Api-Key": apiKey,
    "SiteId": siteId,
    "Content-Type": "application/json",
  };

  // Mindbody expects StartDateTime / EndDateTime
  const params = {
    StartDateTime: startDateTime,
    EndDateTime: endDateTime,
  };

  const resp = await axios.get(url, { headers, params, timeout: 20000 });
  return resp.data;
}

// --- routes ---
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault often sends query params)
  const action = pickFirst(req.body?.action, req.query?.action);
  const studioKey = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezoneRaw = pickFirst(req.body?.timezone, req.query?.timezone);
  const source = pickFirst(req.body?.source, req.query?.source);
  const timezone = decodeMaybe(timezoneRaw);

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  console.log("--------------------------------------------------");
  console.log(`[${debugId}] ${req.method} ${req.originalUrl}`);
  console.log(`[${debugId}] headers:`, {
    "content-type": req.headers["content-type"],
    authorization: req.headers.authorization ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });
  console.log(`[${debugId}] body:`, req.body);
  console.log(`[${debugId}] query:`, req.query);
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source });

  if (!expectedSecret) {
    return res.status(500).json({
      ok: false,
      debugId,
      error: "Server missing GHL_SECRET env var",
    });
  }

  if (!incomingAuth || incomingAuth !== expectedSecret) {
    return res.status(401).json({
      ok: false,
      debugId,
      error: "Unauthorized",
    });
  }

  if (!action) {
    return res.status(400).json({
      ok: false,
      debugId,
      error: "Missing action (send in JSON body or query string)",
    });
  }

  // --- action: ping ---
  if (action === "ping") {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      message: "pong",
      debugId,
    });
  }

  // --- action: get_schedule (Mindbody classes) ---
  if (action === "get_schedule") {
    try {
      // You can pass these in the custom action (body or query).
      // If you don’t, we default to NOW -> +7 days.
      const startDateTime = pickFirst(req.body?.startDateTime, req.query?.startDateTime) || isoNow();
      const endDateTime =
        pickFirst(req.body?.endDateTime, req.query?.endDateTime) ||
        isoPlusDays(pickFirst(req.body?.days, req.query?.days) || 7);

      const data = await mindbodyGetClasses({ startDateTime, endDateTime });

      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        range: { startDateTime, endDateTime },
        mindbody: data,
        debugId,
      });
    } catch (err) {
      console.log(`[${debugId}] get_schedule error:`, err?.message || err);

      // axios error helpers
      const status = err?.response?.status;
      const mbData = err?.response?.data;

      return res.status(500).json({
        ok: false,
        action,
        studioKey,
        timezone,
        source,
        debugId,
        error: "get_schedule failed",
        detail: err?.message || String(err),
        mindbodyStatus: status || null,
        mindbodyError: mbData || null,
      });
    }
  }

  // placeholders for later
  if (action === "book_class" || action === "cancel_class") {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      message: `${action} received (not implemented yet)`,
      debugId,
    });
  }

  return res.status(400).json({
    ok: false,
    debugId,
    error: `Unknown action: ${action}`,
    allowed: ["ping", "get_schedule", "book_class", "cancel_class"],
  });
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

