const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

// -------------------------
// Helpers
// -------------------------
function getAuthToken(req) {
  // Accept either: "Bearer <token>" OR just "<token>"
  const h = req.headers["authorization"] || "";
  if (!h) return "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : h.trim();
}

function requireAuth(req, res, next) {
  const incoming = getAuthToken(req);
  const expected = (process.env.GHL_SECRET || "").trim();

  if (!expected) {
    return res.status(500).json({ error: "Server missing GHL_SECRET env var" });
  }

  if (!incoming || incoming !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

function loadStudioConfig(studioKey) {
  // Preferred: a JSON map so you can scale to 174 studios without redeploying code.
  // Example env var:
  // STUDIO_CONFIG_JSON = {
  //   "oxygen_roundhouse": { "siteId": 1, "timezone": "America/Vancouver" },
  //   "oxygen_kelowna": { "siteId": 2, "timezone": "America/Vancouver" }
  // }
  const raw = process.env.STUDIO_CONFIG_JSON;

  if (raw) {
    try {
      const map = JSON.parse(raw);
      if (map && map[studioKey]) return map[studioKey];
    } catch (e) {
      // fall through to defaults
      console.warn("STUDIO_CONFIG_JSON is not valid JSON");
    }
  }

  // Fallback single-studio config (fine for pilot)
  return {
    siteId: process.env.MINDBODY_SITE_ID ? Number(process.env.MINDBODY_SITE_ID) : undefined,
    timezone: process.env.DEFAULT_TIMEZONE || "America/Vancouver",
  };
}

// -------------------------
// Basic routes
// -------------------------
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).send("ok"));

// -------------------------
// Webhook route (THIS is what GHL hits)
// -------------------------
app.post("/ghl/mindbody", requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const action = body.action;
    const studioKey = body.studioKey;
    const timezone = body.timezone;

    if (!action) return res.status(400).json({ error: "Missing action" });
    if (!studioKey) return res.status(400).json({ error: "Missing studioKey" });
    if (!timezone) return res.status(400).json({ error: "Missing timezone" });

    const studioCfg = loadStudioConfig(studioKey);
    const siteId = studioCfg.siteId;

    // 1) PING (for testing the wiring)
    if (action === "ping") {
      return res.json({
        ok: true,
        action,
        studioKey,
        timezone,
        siteId: siteId ?? null,
        message: "Webhook reachable + authorized",
      });
    }

    // 2) GET_SCHEDULE (example)
    // IMPORTANT: Mindbody endpoints/auth can vary depending on your setup.
    // This is a sane starting structure. We can adjust the exact Mindbody URL/params once you confirm which endpoint you use.
    if (action === "get_schedule") {
      if (!siteId) {
        return res.status(500).json({ error: "Missing siteId for this studio (config not set)" });
      }

      // Expected inputs from GHL
      // (You can add these as Custom Action parameters)
      const startDate = body.startDate; // "2026-02-18"
      const endDate = body.endDate;     // "2026-02-25"

      if (!startDate || !endDate) {
        return res.status(400).json({ error: "Missing startDate or endDate" });
      }

      const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY; // your developer API key
      if (!MINDBODY_API_KEY) {
        return res.status(500).json({ error: "Server missing MINDBODY_API_KEY env var" });
      }

      const baseUrl = process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

      // NOTE: This endpoint path may need to be adjusted depending on which Mindbody schedule endpoint you’re using.
      // This code is built so we can swap the path/params easily without changing the overall architecture.
      const url = `${baseUrl}/class/classes`;

      const response = await axios.get(url, {
        headers: {
          "Api-Key": MINDBODY_API_KEY,
          "SiteId": String(siteId),
          "Content-Type": "application/json",
        },
        params: {
          StartDateTime: `${startDate}T00:00:00`,
          EndDateTime: `${endDate}T23:59:59`,
        },
        timeout: 15000,
      });

      return res.json({
        ok: true,
        action,
        studioKey,
        timezone,
        siteId,
        data: response.data,
      });
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("Webhook error:", err?.response?.data || err.message);
    return res.status(500).json({
      error: "Server error",
      details: err?.response?.data || err.message,
    });
  }
});

// -------------------------
// Start server
// -------------------------
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Listening on PORT: ${PORT}`);
});

// Graceful shutdown (Railway sends SIGTERM on deploy/restart)
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down gracefully...");
  server.close(() => process.exit(0));
});
