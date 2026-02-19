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

/**
 * Compute timezone offset (minutes) for a given Date instant in a given IANA tz.
 * Positive means tz is ahead of UTC.
 */
function getTimeZoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }

  // This "asUTC" treats the formatted local time as if it were UTC.
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  // Offset = (local-as-UTC) - actual UTC
  return (asUTC - date.getTime()) / 60000;
}

/**
 * Returns { fromDate, toDate } where:
 * - fromDate = start of "today" in the given timezone, expressed as UTC ISO string (Z)
 * - toDate   = end of "today" (23:59:59.999 local), expressed as UTC ISO string (Z)
 *
 * This matches what Mindbody's widget payload expects (midnight boundaries).
 */
function defaultDateRangeISO(timeZone) {
  const tz = timeZone || "America/Vancouver";

  // Get today's Y/M/D in the target timezone
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = dtf.formatToParts(new Date());
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const y = Number(map.year);
  const m = Number(map.month);
  const d = Number(map.day);

  // Start-of-day LOCAL -> convert to UTC instant
  // Start by creating an approximate UTC midnight, then correct by tz offset at that instant
  const approxUtcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const offsetMin = getTimeZoneOffsetMinutes(approxUtcMidnight, tz);
  const startUtc = new Date(approxUtcMidnight.getTime() - offsetMin * 60000);

  // End-of-day = start of next day minus 1 ms (in that timezone)
  const approxUtcNextMidnight = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0));
  const offsetMinNext = getTimeZoneOffsetMinutes(approxUtcNextMidnight, tz);
  const nextStartUtc = new Date(
    approxUtcNextMidnight.getTime() - offsetMinNext * 60000
  );
  const endUtc = new Date(nextStartUtc.getTime() - 1);

  return { fromDate: startUtc.toISOString(), toDate: endUtc.toISOString() };
}

// ---------------- widget fetch (web) ----------------
// Uses Node 18+ built-in fetch + FormData (no new npm deps)
async function fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId }) {
  const url = String(process.env.MINDBODY_WIDGET_URL || "").trim();
  const token = String(process.env.MINDBODY_WIDGET_TOKEN || "").trim();

  if (!url) throw new Error("Missing MINDBODY_WIDGET_URL env var");
  if (!token) throw new Error("Missing MINDBODY_WIDGET_TOKEN env var");

  // Matches Chrome payload:
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
  const mode = String(process.env.MINDBODY_MODE || "mock")
    .trim()
    .toLowerCase(); // mock | web | live (future)

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
      const range = defaultDateRangeISO(timezone);
      console.log(`[${debugId}] widget_fetch -> range:`, {
        timezone: timezone || "America/Vancouver",
        ...range,
      });
      console.log(
        `[${debugId}] widget_fetch -> POST ${String(
          process.env.MINDBODY_WIDGET_URL || ""
        ).trim()}`
      );

      const result = await fetchMindbodyWidgetSchedule({
        ...range,
        debugId,
      });

      console.log(
        `[${debugId}] widget_fetch <- status=${result.status} ok=${result.ok} length=${result.text.length}`
      );
      if (!result.ok) {
        console.log(
          `[${debugId}] widget_fetch <- head=`,
          result.text.slice(0, 300)
        );
      }

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
      const range = defaultDateRangeISO(timezone);
      console.log(`[${debugId}] widget_fetch -> range:`, {
        timezone: timezone || "America/Vancouver",
        ...range,
      });
      console.log(
        `[${debugId}] widget_fetch -> POST ${String(
          process.env.MINDBODY_WIDGET_URL || ""
        ).trim()}`
      );

      const result = await fetchMindbodyWidgetSchedule({
        ...range,
        debugId,
      });

      console.log(
        `[${debugId}] widget_fetch <- status=${result.status} ok=${result.ok} length=${result.text.length}`
      );
      if (!result.ok) {
        console.log(
          `[${debugId}] widget_fetch <- head=`,
          result.text.slice(0, 300)
        );
      }

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


