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

function safeDecode(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  try {
    // decode things like America%2FVancouver
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// ---------------- date parsing (supports natural phrases) ----------------
// We cap requests to maxDaysAhead (default 14) to match your plan.
function parseDatePhraseToISODate(datePhraseRaw, timezone, maxDaysAhead = 14) {
  const phrase = String(datePhraseRaw || "").trim().toLowerCase();
  if (!phrase) return null;

  // If already ISO date:
  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) return phrase;

  // We'll interpret relative phrases using "today in timezone"
  const todayISO = getTodayISOInTZ(timezone); // YYYY-MM-DD

  if (phrase === "today") return todayISO;
  if (phrase === "tomorrow") return addDaysISO(todayISO, 1);

  // weekday parsing: "friday", "next friday", "this friday"
  const weekdays = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  // normalize "next wednesday" etc
  const m = phrase.match(/^(next|this)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (m) {
    const qualifier = m[1] || ""; // next|this|""
    const dayName = m[2];
    const targetDow = weekdays[dayName];

    const base = new Date(todayISO + "T00:00:00Z"); // we'll compute offset by ISO arithmetic
    const todayDow = dayOfWeekISO(todayISO); // 0-6 (Sun-Sat)
    let delta = (targetDow - todayDow + 7) % 7;

    // If they said "friday" and it's friday today, delta would be 0 (today).
    // Usually callers mean upcoming; keep delta=0 as today. If you want next occurrence, say "next friday".
    if (qualifier === "next") {
      delta = delta === 0 ? 7 : delta + 7;
    }
    // "this friday" behaves like default.

    const iso = addDaysISO(todayISO, delta);
    return iso;
  }

  // simple "on the 14th" -> NOT supported without month context
  // (Agent should pass a clearer phrase; server returns null and we fall back)
  return null;
}

function addDaysISO(isoDate, days) {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeekISO(isoDate) {
  const d = new Date(isoDate + "T00:00:00Z");
  return d.getUTCDay(); // 0=Sun .. 6=Sat
}

function getTodayISOInTZ(timezone) {
  // Use Intl to get YYYY-MM-DD in the requested timezone
  // timezone must be a valid IANA name (America/Vancouver)
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = fmt.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function daysBetweenISO(fromISO, toISO) {
  const a = new Date(fromISO + "T00:00:00Z");
  const b = new Date(toISO + "T00:00:00Z");
  const diff = b.getTime() - a.getTime();
  return Math.round(diff / (24 * 60 * 60 * 1000));
}

// ---------------- mocked schedule (date-aware) ----------------
function buildMockSchedule({ studioKey, timezone, isoDate }) {
  // Create a few believable classes (mock)
  const base = `${isoDate}T`;
  return {
    studioKey,
    timezone,
    range: {
      from: `${isoDate}T00:00:00.000Z`,
      to: `${isoDate}T23:59:59.000Z`,
    },
    classes: [
      {
        id: "mock_0600",
        name: "Hot Yoga (Mock)",
        startDateTime: `${base}06:00:00.000Z`,
        endDateTime: `${base}07:00:00.000Z`,
        instructor: "Mock Instructor",
        bookable: true,
      },
      {
        id: "mock_1200",
        name: "Hot HIIT (Mock)",
        startDateTime: `${base}12:00:00.000Z`,
        endDateTime: `${base}13:00:00.000Z`,
        instructor: "Mock Instructor",
        bookable: true,
      },
      {
        id: "mock_1800",
        name: "Yin (Mock)",
        startDateTime: `${base}18:00:00.000Z`,
        endDateTime: `${base}19:00:00.000Z`,
        instructor: "Mock Instructor",
        bookable: true,
      },
    ],
  };
}

function buildSayFromSchedule(schedule, requestedPhrase, requestedISO) {
  const list = (schedule?.classes || []).map((c) => {
    // keep it simple: just show name + "start"
    // (In real mode you’ll format local time)
    const t = String(c.startDateTime || "").slice(11, 16);
    return `${t} — ${c.name}`;
  });

  if (!list.length) {
    return `I don’t see any classes listed for ${requestedPhrase || requestedISO || "that day"} right now.`;
  }

  return `Here are the classes for ${requestedPhrase || requestedISO}: ${list.join(", ")}.`;
}

// ---------------- widget fetch (web) ----------------
// (kept for later; you’re waiting on Production credentials)
async function fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId }) {
  const url = String(process.env.MINDBODY_WIDGET_URL || "").trim();
  const token = String(process.env.MINDBODY_WIDGET_TOKEN || "").trim();

  if (!url) throw new Error("Missing MINDBODY_WIDGET_URL env var");
  if (!token) throw new Error("Missing MINDBODY_WIDGET_TOKEN env var");

  const form = new FormData();
  form.append("1", token);
  form.append("0", JSON.stringify(["$@1", { fromDate, toDate }]));

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
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

  const actionRaw = pickFirst(req.body?.action, req.query?.action);
  const studioKeyRaw = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezoneRaw = pickFirst(req.body?.timezone, req.query?.timezone);
  const sourceRaw = pickFirst(req.body?.source, req.query?.source);
  const dateRaw = pickFirst(req.body?.date, req.query?.date);

  const action = String(actionRaw || "").trim();
  const studioKey = String(studioKeyRaw || "").trim();
  const timezone = safeDecode(timezoneRaw || "America/Vancouver") || "America/Vancouver";
  const source = String(sourceRaw || "").trim();
  const datePhrase = String(dateRaw || "").trim();

  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase(); // mock | web
  const maxDaysAhead = Number(process.env.MAX_DAYS_AHEAD || 14);

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
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source, datePhrase, maxDaysAhead });

  if (!expectedSecret) {
    return res.status(500).json({
      success: false,
      ok: false,
      debugId,
      error: "Server missing GHL_SECRET env var",
    });
  }

  if (!incomingAuth || incomingAuth !== expectedSecret) {
    return res.status(401).json({
      success: false,
      ok: false,
      debugId,
      error: "Unauthorized",
    });
  }

  if (!action) {
    return res.status(400).json({
      success: false,
      ok: false,
      debugId,
      error: "Missing action (send in JSON body or query string)",
    });
  }

  if (action === "ping") {
    return res.status(200).json({
      success: true,
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      say: "pong",
      text: "pong",
      debugId,
    });
  }

  // ---------------- get_schedule ----------------
  if (action === "get_schedule") {
    // Determine requested date
    const todayInTZ = getTodayISOInTZ(timezone);
    const requestedISO = parseDatePhraseToISODate(datePhrase || "today", timezone, maxDaysAhead);

    if (!requestedISO) {
      return res.status(200).json({
        success: false,
        ok: false,
        action,
        studioKey,
        timezone,
        source,
        error: "Could not understand the requested date. Try 'today', 'tomorrow', 'friday', or 'YYYY-MM-DD'.",
        debugId,
      });
    }

    const daysAhead = daysBetweenISO(todayInTZ, requestedISO);
    if (daysAhead < 0 || daysAhead > maxDaysAhead) {
      return res.status(200).json({
        success: false,
        ok: false,
        action,
        studioKey,
        timezone,
        source,
        error: `Date is outside the allowed range (0–${maxDaysAhead} days ahead).`,
        debugId,
      });
    }

    // MOCK mode (your current plan while waiting on Mindbody Prod creds)
    if (mode !== "web") {
      const schedule = buildMockSchedule({ studioKey, timezone, isoDate: requestedISO });
      const say = buildSayFromSchedule(schedule, datePhrase || requestedISO, requestedISO);

      return res.status(200).json({
        success: true,
        ok: true,
        action,
        mode: "mock",
        studioKey,
        timezone,
        source,
        date: requestedISO,
        say,
        text: say,
        results: { say, text: say }, // extra compatibility
        schedule,
        debugId,
      });
    }

    // WEB mode (optional, when you’re ready)
    try {
      const fromDate = new Date().toISOString();
      const toDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const result = await fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId });

      const say = result.ok
        ? `I pulled the schedule successfully for ${requestedISO}.`
        : `I couldn’t pull the schedule right now.`;

      return res.status(200).json({
        success: result.ok,
        ok: result.ok,
        action,
        mode: "web",
        studioKey,
        timezone,
        source,
        date: requestedISO,
        say,
        text: say,
        results: { say, text: say },
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
        success: false,
        ok: false,
        action,
        mode: "web",
        debugId,
        error: String(err?.message || err),
      });
    }
  }

  // Placeholder for booking later
  if (action === "book_class" || action === "cancel_class") {
    return res.status(200).json({
      success: true,
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      say: `${action} received (not implemented yet)`,
      text: `${action} received (not implemented yet)`,
      results: { say: `${action} received (not implemented yet)`, text: `${action} received (not implemented yet)` },
      debugId,
    });
  }

  return res.status(400).json({
    success: false,
    ok: false,
    debugId,
    error: `Unknown action: ${action}`,
    allowed: ["ping", "get_schedule", "book_class", "cancel_class"],
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));





