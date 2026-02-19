// index.js (CommonJS - works with default Railway/Node settings)
const express = require("express");
const crypto = require("crypto");

const app = express();

// --- Body parsers (IMPORTANT for AgencyVault) ---
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.text({ type: ["text/*"], limit: "1mb" }));

// --- Request logger ---
app.use((req, res, next) => {
  const requestId =
    (req.headers["x-debug-id"] && String(req.headers["x-debug-id"])) ||
    crypto.randomBytes(6).toString("hex");

  req.requestId = requestId;

  console.log("--------------------------------------------------");
  console.log(`[${requestId}] ${req.method} ${req.originalUrl}`);
  console.log(`[${requestId}] headers:`, {
    "content-type": req.headers["content-type"],
    authorization: req.headers["authorization"] ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });

  try {
    console.log(`[${requestId}] body:`, req.body);
  } catch (e) {
    console.log(`[${requestId}] body: [unprintable]`);
  }

  res.setHeader("x-debug-id", requestId);
  next();
});

function normalizeBearer(authHeader = "") {
  const raw = String(authHeader || "").trim();
  if (!raw) return "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  return raw;
}

function requireAuth(req, res) {
  const expected = (process.env.GHL_SECRET || "").trim();
  if (!expected) {
    res.status(500).json({
      ok: false,
      error: "server_misconfigured",
      message: "Missing GHL_SECRET env var in Railway",
      debugId: req.requestId,
    });
    return true;
  }

  const provided = normalizeBearer(req.headers.authorization || "");
  if (!provided || provided !== expected) {
    res.status(401).json({
      ok: false,
      error: "unauthorized",
      message:
        "Invalid or missing Authorization header. Provide Bearer token or raw token.",
      debugId: req.requestId,
    });
    return true;
  }

  return false;
}

// --- Routes ---
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/ghl/mindbody", (req, res) => {
  if (requireAuth(req, res)) return;

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // keep as-is
    }
  }

  const action = body && body.action;
  const studioKey = body && body.studioKey;
  const timezone = body && body.timezone;
  const source = body && body.source;

  const missing = [];
  if (!action) missing.push("action");
  if (!studioKey) missing.push("studioKey");
  if (!timezone) missing.push("timezone");
  if (!source) missing.push("source");

  if (missing.length) {
    return res.status(400).json({
      ok: false,
      error: "bad_request",
      message: `Missing required fields: ${missing.join(", ")}`,
      received: { action, studioKey, timezone, source },
      debugId: req.requestId,
    });
  }

  if (action === "ping") {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      message: "pong",
      debugId: req.requestId,
    });
  }

  if (
    action === "get_schedule" ||
    action === "book_class" ||
    action === "cancel_class"
  ) {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      message: "stub_ok",
      debugId: req.requestId,
    });
  }

  return res.status(400).json({
    ok: false,
    error: "unsupported_action",
    message: `Unsupported action: ${action}`,
    allowed: ["ping", "get_schedule", "book_class", "cancel_class"],
    debugId: req.requestId,
  });
});

// --- Start ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
