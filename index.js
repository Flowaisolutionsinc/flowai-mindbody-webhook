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

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

// A small mocked schedule so your flows can keep moving even before parsing is done
function buildMockSchedule({ studioKey, timezone, fromDate, toDate }) {
  const now = new Date();
  const plus1h = new Date(now.getTime() + 60 * 60 * 1000);
  const plus2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  return {
    studioKey,
    timezone,
    range: {
      from: fromDate || now.toISOString(),
      to: toDate || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
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

// ---- Timezone helpers (no extra deps) ----
// Returns offset minutes between UTC and the provided IANA timezone at a given instant.
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
  for (const p of parts) map[p.type] = p.value;

  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );

  // Positive if timezone is ahead of UTC, negative if behind.
  return (asUTC - date.getTime()) / 60000;
}

// Convert a "wall clock" datetime in a timezone into a UTC Date.
// (Good enough for day-boundaries & DST; uses offset at a guess instant.)
function zonedWallTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMin = getTimeZoneOffsetMinutes(guessUtc, timeZone);
  return new Date(guessUtc.getTime() - offsetMin * 60000);
}

// Build ISO range for a specific YYYY-MM-DD in a timezone:
// from = start of that day (00:00:00.000) in tz, converted to UTC ISO
// to   = end of that day (23:59:59.999) in tz, converted to UTC ISO
function rangeForDateInTZ(dateStrYYYYMMDD, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStrYYYYMMDD || "").trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const startUtc = zonedWallTimeToUtc({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);

  // next day start in tz -> UTC, then subtract 1ms
  const nextDay = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
  const nextY = nextDay.getUTCFullYear();
  const nextM = nextDay.getUTCMonth() + 1;
  const nextD = nextDay.getUTCDate();

  const nextStartUtc = zonedWallTimeToUtc({ year: nextY, month: nextM, day: nextD, hour: 0, minute: 0, second: 0 }, timeZone);
  const endUtc = new Date(nextStartUtc.getTime() - 1);

  return { fromDate: startUtc.toISOString(), toDate: endUtc.toISOString() };
}

// Default range: now -> +24h
function defaultDateRangeISO() {
  const from = new Date();
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { fromDate: from.toISOString(), toDate: to.toISOString() };
}

// Cap: today -> today + N days (N <= 14)
function rangeFromTodayDaysAhead(timeZone, daysAhead) {
  const now = new Date();
  // Get "today" in timezone by formatting, then build a range from that day's start.
  const dtf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const todayStr = dtf.format(now); // YYYY-MM-DD
  const startRange = rangeForDateInTZ(todayStr, timeZone);
  if (!startRange) return defaultDateRangeISO();

  // end = start of (today + daysAhead) day in tz, minus 1ms
  const [y, m, d] = todayStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const endDay = new Date(base.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const endStr = `${endDay.getUTCFullYear()}-${String(endDay.getUTCMonth() + 1).padStart(2, "0")}-${String(endDay.getUTCDate()).padStart(2, "0")}`;

  const endStart = rangeForDateInTZ(endStr, timeZone);
  if (!endStart) return startRange;

  return { fromDate: startRange.fromDate, toDate: new Date(new Date(endStart.fromDate).getTime() - 1).toISOString() };
}

// ---------------- widget fetch (web) ----------------
// Uses Node 18+ built-in fetch + FormData (no new npm deps)
async function fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId }) {
  const url = String(process.env.MINDBODY_WIDGET_URL || "").trim();
  const token = String(process.env.MINDBODY_WIDGET_TOKEN || "").trim();

  if (!url) throw new Error("Missing MINDBODY_WIDGET_URL env var");
  if (!token) throw new Error("Missing MINDBODY_WIDGET_TOKEN env var");

  const form = new FormData();
  form.append("1", token);
  form.append("0", JSON.stringify(["$@1", { fromDate, toDate }]));

  console.log(`[${debugId}] widget_fetch -> POST ${url}`);
  console.log(`[${debugId}] widget_fetch -> range:`, { fromDate, toDate });

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
      "User-Agent": `flowai-webhook/${debugId}`,
    },
  });

  const text = await res.text();

  console.log(`[${debugId}] widget_fetch <- status=${res.status} ok=${res.ok} length=${text.length}`);

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
  const timezone = pickFirst(req.body?.timezone, req.query?.timezone) || "America/Vancouver";
  const source = pickFirst(req.body?.source, req.query?.source);

  // NEW: date + optional daysAhead
  const date = pickFirst(req.body?.date, req.query?.date); // YYYY-MM-DD
  const daysAhead = clampInt(pickFirst(req.body?.daysAhead, req.query?.daysAhead), 1, 14, 14);

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
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source, date, daysAhead });

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

  // Build range:
  // - If date is provided: fetch THAT DAY (00:00 to 23:59:59.999 in timezone)
  // - Else: fetch today -> today+daysAhead (cap 14)
  const dateRange =
    date ? rangeForDateInTZ(date, timezone) : rangeFromTodayDaysAhead(timezone, daysAhead);

  if (!dateRange) {
    return res.status(400).json({
      ok: false,
      debugId,
      error: "Invalid date format. Use YYYY-MM-DD (example: 2026-02-21).",
    });
  }

  // ---------------- get_schedule (mock by default) ----------------
  if (action === "get_schedule") {
    // stay safe: mock unless MINDBODY_MODE=web
    if (mode !== "web") {
      const mock = buildMockSchedule({ studioKey, timezone, ...dateRange });
      return res.status(200).json({
        ok: true,
        action,
        mode: "mock",
        studioKey,
        timezone,
        source,
        date,
        daysAhead,
        range: dateRange,
        schedule: mock,
        debugId,
      });
    }

    // If mode=web, use widget fetch
    try {
      const result = await fetchMindbodyWidgetSchedule({ ...dateRange, debugId });

      return res.status(200).json({
        ok: true,
        action,
        mode: "web",
        studioKey,
        timezone,
        source,
        date,
        daysAhead,
        range: dateRange,
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
      const result = await fetchMindbodyWidgetSchedule({ ...dateRange, debugId });

      return res.status(200).json({
        ok: true,
        action,
        mode: "web_test",
        studioKey,
        timezone,
        source,
        date,
        daysAhead,
        range: dateRange,
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





