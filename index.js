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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function isValidYMD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "").trim());
}

// ---- timezone-safe-ish day range helpers (no deps) ----
// We convert "YYYY-MM-DD in America/Vancouver" into UTC ISO start/end
function tzParts(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
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
  const out = {};
  for (const p of parts) {
    if (p.type !== "literal") out[p.type] = p.value;
  }
  return out;
}

// Returns offset minutes between UTC and the timezone at the given instant
function getTzOffsetMinutes(timeZone, date) {
  // format the date as if in timeZone, then interpret that formatted time as UTC
  const p = tzParts(timeZone, date);
  const asIfUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return (asIfUTC - date.getTime()) / 60000;
}

function zonedStartOfDayUTC(ymd, timeZone) {
  // Start with UTC midnight of that YMD, then shift by tz offset at that instant
  const [Y, M, D] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(Y, M - 1, D, 0, 0, 0));
  const offsetMin = getTzOffsetMinutes(timeZone, guess);
  // If timezone is behind UTC (e.g. Vancouver), offsetMin is negative; subtracting moves to correct UTC instant
  return new Date(guess.getTime() - offsetMin * 60000);
}

function zonedEndOfDayUTC(ymd, timeZone) {
  const start = zonedStartOfDayUTC(ymd, timeZone);
  // end = start + 24h - 1ms
  return new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
}

function todayYMDInTZ(timeZone) {
  const p = tzParts(timeZone, new Date());
  return `${p.year}-${p.month}-${p.day}`;
}

// Cap: don’t let users ask > N days ahead
function enforceMaxDaysAhead(targetYMD, timeZone, maxDaysAhead = 14) {
  const todayYMD = todayYMDInTZ(timeZone);
  const todayStart = zonedStartOfDayUTC(todayYMD, timeZone);
  const targetStart = zonedStartOfDayUTC(targetYMD, timeZone);
  const diffDays = Math.floor((targetStart.getTime() - todayStart.getTime()) / (24 * 60 * 60 * 1000));

  if (diffDays < 0) return { ok: true, diffDays }; // allow past? you can choose to block, but leaving OK is harmless
  if (diffDays > maxDaysAhead) return { ok: false, diffDays, maxDaysAhead };
  return { ok: true, diffDays };
}

// A small mocked schedule so your flows can keep moving even before parsing is done
function buildMockSchedule({ studioKey, timezone, ymd }) {
  const now = new Date();
  const plus1h = new Date(now.getTime() + 60 * 60 * 1000);
  const plus2h = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  return {
    studioKey,
    timezone,
    date: ymd,
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

// ---------------- widget fetch (web) ----------------
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
      // Do NOT set content-type manually. fetch will set correct boundary.
      "User-Agent": `flowai-webhook/${debugId}`,
    },
  });

  const text = await res.text();
  console.log(`[${debugId}] widget_fetch <- status=${res.status} ok=${res.ok} length=${text.length}`);

  return { status: res.status, ok: res.ok, text };
}

// --------- RSC extraction (best-effort, no deps) ---------
// We look for JSON objects that start with {"id":"cinst_..."} and contain "type":"Class"
function extractClassObjectsFromRsc(raw) {
  const text = String(raw || "");
  const results = [];

  const starts = [];
  let idx = 0;
  while (true) {
    const at = text.indexOf('{"id":"cinst_', idx);
    if (at === -1) break;
    starts.push(at);
    idx = at + 10;
  }

  for (const start of starts) {
    // try to find matching closing brace using a simple brace counter
    let i = start;
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (; i < text.length; i++) {
      const ch = text[i];

      if (inStr) {
        if (esc) {
          esc = false;
        } else if (ch === "\\") {
          esc = true;
        } else if (ch === '"') {
          inStr = false;
        }
        continue;
      } else {
        if (ch === '"') {
          inStr = true;
          continue;
        }
        if (ch === "{") depth++;
        if (ch === "}") depth--;

        if (depth === 0 && i > start) {
          const candidate = text.slice(start, i + 1);
          if (candidate.includes('"type":"Class"')) {
            try {
              const obj = JSON.parse(candidate);
              results.push(obj);
            } catch (_) {
              // ignore parsing failures
            }
          }
          break;
        }
      }
    }
  }

  // de-dupe by id
  const seen = new Set();
  return results.filter((o) => {
    if (!o?.id) return false;
    if (seen.has(o.id)) return false;
    seen.add(o.id);
    return true;
  });
}

function toCleanClasses(classObjs = []) {
  return classObjs.map((c) => ({
    id: c.id,
    name: c.name,
    startDateTime: c.startDateTime,
    endDateTime: c.endDateTime,
    duration: c.duration,
    capacity: c.capacity,
    numberRegistered: c.numberRegistered,
    bookable: c.bookable,
    waitlistable: c.waitlistable,
    cancelled: c.cancelled,
    instructor:
      Array.isArray(c.staff) && c.staff[0] && typeof c.staff[0] === "object"
        ? c.staff[0].displayLabel
        : undefined,
  }));
}

// ---------------- route ----------------
app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault sends query params)
  const action = pickFirst(req.body?.action, req.query?.action);
  const studioKey = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezone = pickFirst(req.body?.timezone, req.query?.timezone) || "America/Vancouver";
  const source = pickFirst(req.body?.source, req.query?.source);

  // NEW: optional date param (YYYY-MM-DD)
  const date = pickFirst(req.body?.date, req.query?.date);

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  // Mode
  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase(); // mock | web

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
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source, date });

  if (!expectedSecret) {
    return res.status(500).json({ ok: false, debugId, error: "Server missing GHL_SECRET env var" });
  }

  if (!incomingAuth || incomingAuth !== expectedSecret) {
    return res.status(401).json({ ok: false, debugId, error: "Unauthorized" });
  }

  if (!action) {
    return res.status(400).json({ ok: false, debugId, error: "Missing action" });
  }

  // Ping
  if (action === "ping") {
    return res.status(200).json({ ok: true, action, studioKey, timezone, source, message: "pong", debugId });
  }

  // Helper to compute date range
  function computeRange() {
    const targetYMD = isValidYMD(date) ? date : todayYMDInTZ(timezone);

    const gate = enforceMaxDaysAhead(targetYMD, timezone, 14);
    if (!gate.ok) {
      return {
        ok: false,
        targetYMD,
        error: `Date is too far out. I can check up to ${gate.maxDaysAhead} days ahead.`,
      };
    }

    const from = zonedStartOfDayUTC(targetYMD, timezone);
    const to = zonedEndOfDayUTC(targetYMD, timezone);

    return {
      ok: true,
      targetYMD,
      fromDate: from.toISOString(),
      toDate: to.toISOString(),
    };
  }

  // ---------------- get_schedule ----------------
  if (action === "get_schedule") {
    const r = computeRange();
    if (!r.ok) {
      return res.status(400).json({ ok: false, action, debugId, studioKey, timezone, source, error: r.error, date: r.targetYMD });
    }

    // safe default: mock unless MINDBODY_MODE=web
    if (mode !== "web") {
      const mock = buildMockSchedule({ studioKey, timezone, ymd: r.targetYMD });
      return res.status(200).json({
        ok: true,
        action,
        mode: "mock",
        studioKey,
        timezone,
        source,
        date: r.targetYMD,
        schedule: mock,
        debugId,
      });
    }

    try {
      const result = await fetchMindbodyWidgetSchedule({ fromDate: r.fromDate, toDate: r.toDate, debugId });

      const classesRaw = extractClassObjectsFromRsc(result.text);
      const classes = toCleanClasses(classesRaw);

      return res.status(200).json({
        ok: true,
        action,
        mode: "web",
        studioKey,
        timezone,
        source,
        date: r.targetYMD,
        widget: {
          status: result.status,
          ok: result.ok,
          rawLength: result.text.length,
        },
        schedule: {
          studioKey,
          timezone,
          date: r.targetYMD,
          range: { fromDate: r.fromDate, toDate: r.toDate },
          classes,
          classCount: classes.length,
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

  // ---------------- get_schedule_web (FORCED web test) ----------------
  if (action === "get_schedule_web") {
    const r = computeRange();
    if (!r.ok) {
      return res.status(400).json({ ok: false, action, debugId, studioKey, timezone, source, error: r.error, date: r.targetYMD });
    }

    try {
      const result = await fetchMindbodyWidgetSchedule({ fromDate: r.fromDate, toDate: r.toDate, debugId });

      const classesRaw = extractClassObjectsFromRsc(result.text);
      const classes = toCleanClasses(classesRaw);

      return res.status(200).json({
        ok: true,
        action,
        mode: "web_test",
        studioKey,
        timezone,
        source,
        date: r.targetYMD,
        widget: {
          status: result.status,
          ok: result.ok,
          rawLength: result.text.length,
        },
        schedule: {
          studioKey,
          timezone,
          date: r.targetYMD,
          range: { fromDate: r.fromDate, toDate: r.toDate },
          classes,
          classCount: classes.length,
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




