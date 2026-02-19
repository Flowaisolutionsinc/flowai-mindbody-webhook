// index.js
import express from "express";
import crypto from "crypto";

const app = express();

// --- Body parsers (IMPORTANT for AgencyVault) ---
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true })); // handles application/x-www-form-urlencoded

// Optional: if you ever get raw text bodies
app.use(express.text({ type: ["text/*"], limit: "1mb" }));

// --- Simple request logger (so Railway logs show requests) ---
app.use((req, res, next) => {
  const requestId =
    req.headers["x-debug-id"]?.toString() ||
    crypto.randomBytes(6).toString("hex");

  req.requestId = requestId;

  console.log("--------------------------------------------------");
  console.log(`[${requestId}] ${req.method} ${req.originalUrl}`);
  console.log(`[${requestId}] headers:`, {
    "content-type": req.headers["content-type"],
    authorization: req.headers["authorization"] ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });

  // Log body safely (avoid logging huge stuff)
  try {
    console.log(`[${requestId}] body:`, req.body);
  } catch (e) {
    console.log(`[${requestId}] body: [unprintable]`);
  }

  res.setHeader("x-debug-id", requestId);
  next();
});

// --- Helpers ---
function normalizeBearer(authHeader = "") {
  const raw = authHeader.trim();
  if (!raw) return "";
  // If it's already "Bearer xxx", return xxx
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // Otherwise treat the whole thing as the token
  return raw;
}

function requireAuth(req, res) {
  const expected = (process.env.GHL_SECRET || "").trim();
  if (!expected) {
    return res.status(500).json({
      ok: false,
      error: "server_misconfigured",
      message: "Missing GHL_SECRET env var in Railway",
      debugId: req.requestId,
    });
  }

  const provided = normalizeBearer(req.headers.authorization || "");
  if (!provided || provided !== expected) {
    return res.status(401).json({
      ok: false,
      error: "unauthorized",
      message:
        "Invalid or missing Authorization header. Provide Bearer token or raw token.",
      debugId: req.requestId,
    });
  }

  return null; // no error
}

// --- Routes ---
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).send("ok"));

app.post("/ghl/mindbody", (req, res) => {
  const authErr = requireAuth(req, res);
  if (authErr) return; // response already sent

  // Body may come as JSON, form fields, or even a string.
  // If it's a string that looks like JSON, parse it.
  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // keep as-is
    }
  }

  const action = body?.action;
  const studioKey = body?.studioKey;
  const timezone = body?.timezone;
  const source = body?.source;

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

  // Minimal actions for now
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

  // Stub for future actions
  if (action === "get_schedule" || action === "book_class" || action === "cancel_class") {
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
