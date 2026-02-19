const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// ---------------- helpers ----------------
function normalizeAuth(authHeaderRaw = "") {
  const raw = String(authHeaderRaw || "").trim();
  if (!raw) return "";
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function makeDebugId() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Math.random().toString(16).slice(2, 10)
  );
}

// A small mocked schedule so your flows can keep moving even before parsing is done
function buildMockSchedule({ studioKey, timezone }) {
  const now = new Date();
  const plus1h = new Date(now.getTime() + 60 * 60 * 1000);
  const plus2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  return {
    studioKey,
    timezone,
    range: {
      from: now.toISOString(),
      to: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    },
    classes: [
      {
        id: "mock_1",
        name: "Hot Yoga (Mock)",
        startDateTime: plus1h.toISOString(),
        endDateTime: plus2h.toISOString(),
        instructor: "Mock Instructor",
        bookable: true,
      },
    ],
  };
}

function defaultDateRangeISO() {
  const from = new Date();
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromDate: from.toISOString(), toDate: to.toISOString() };
}

// ---------------- widget fetch (web) ----------------
// Uses Node 18+ built-in fetch + FormData (no new npm deps)
async function fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId }) {
  const url = String(process.env.MINDBODY_WIDGET_URL || "").trim();
  const token = String(process.env.MINDBODY_WIDGET_TOKEN || "").trim();

  if (!url) throw new Error("Missing MINDBODY_WIDGET_URL env var");
  if (!token) throw new Error("Missing MINDBODY_WIDGET_TOKEN env var");

  // This matches what you saw in Chrome devtools payload:
  // field "1" = token string
  // field "0" = ["$@1",{"fromDate":"...","toDate":"..."}]
  const form = new FormData();
  form.append("1", token);
  form.append("0", JSON.stringify(["$@1", { fromDate, toDate }]));

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
      // Do NOT set content-type manually. fetch will set the correct boundary.
      "User-Agent": `flowai-webhook/${debugId}`,
    },
  });

  const text = await res.text();

  return {
    status: res.status,
    ok: res.ok,
    text,
  };
}

// ---------------- route ----------------
app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault sends query params)
  const action = pickFirst(req.body?.action, req.query?.action);
  const studioKey = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezone = pickFirst(req.body?.timezone, req.query?.timezone);
  const source = pickFirst(req.body?.source, req.query?.source);

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  // Mode
  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase(); // mock | web | live (future)

  console.log("--------------------------------------------------");
  console.log(`[${debugId}] ${req.method} ${req.originalUrl}`);
  console.log(`[${debugId}] mode: ${mode}`);
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

  // Ping
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

  // ---------------- get_schedule (mock by default) ----------------
  if (action === "get_schedule") {
    // stay safe: mock unless MINDBODY_MODE=web
    if (mode !== "web") {
      const mock = buildMockSchedule({ studioKey, timezone });
      return res.status(200).json({
        ok: true,
        action,
        mode: "mock",
        studioKey,
        timezone,
        source,
        schedule: mock,
        debugId,
      });
    }

    // If mode=web, use widget fetch
    try {
      const { fromDate, toDate } = defaultDateRangeISO();
      const result = await fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId });

      return res.status(200).json({
        ok: true,
        action,
        mode: "web",
        studioKey,
        timezone,
        source,
        widget: {
          status: result.status,
          ok: result.ok,
          rawLength: result.text.length,
          // we keep preview short so logs/responses don't explode
          preview: result.text.slice(0, 500),
        },
        debugId,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        action,
        mode: "web",
        debugId,
        error: String(err?.message || err),
      });
    }
  }

  // ---------------- get_schedule_web (FORCED web test, even if mode=mock) ----------------
  if (action === "get_schedule_web") {
    try {
      const { fromDate, toDate } = defaultDateRangeISO();
      const result = await fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId });

      return res.status(200).json({
        ok: true,
        action,
        mode: "web_test",
        studioKey,
        timezone,
        source,
        widget: {
          status: result.status,
          ok: result.ok,
          rawLength: result.text.length,
          preview: result.text.slice(0, 500),
        },
        debugId,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        action,
        mode: "web_test",
        debugId,
        error: String(err?.message || err),
      });
    }
  }

  // Placeholder for next actions
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
    allowed: ["ping", "get_schedule", "get_schedule_web", "book_class", "cancel_class"],
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));




