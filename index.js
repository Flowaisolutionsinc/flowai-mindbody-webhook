/**
 * Flow AI – Mindbody Webhook (Mock Mode)
 * - POST /ghl/mindbody
 * - Accepts query params (or body) for:
 *    action, studioKey, timezone, source, date
 * - Always returns a response that voice agent platforms reliably surface:
 *    { success, say, text, results: { say, text }, data: {...} }
 */

const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

// ---------------------------
// Helpers
// ---------------------------

function safeString(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function decodeMaybe(v) {
  // Handles values like "America%2FVancouver" or "February%2020th%2C%202026"
  const s = safeString(v);
  try {
    // also converts "+" into spaces if it came from querystring encoding
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s.replace(/\+/g, " ");
  }
}

// Get YYYY-MM-DD "today" in a given IANA timezone using Intl parts
function getTodayISOInTZ(timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA gives YYYY-MM-DD ordering when formatted, but to be safe use parts:
  const parts = dtf.formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

// Add N days to a YYYY-MM-DD string
function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Very forgiving date phrase parser for MOCK mode.
// Supports:
// - "today", "tomorrow"
// - "YYYY-MM-DD"
// - "February 20th, 2026" (or without comma)
// - weekday names ("friday") => next occurrence
function resolveDatePhraseToISO(datePhraseRaw, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const todayISO = getTodayISOInTZ(tz);

  const phrase = decodeMaybe(datePhraseRaw).trim().toLowerCase();
  if (!phrase) return { ok: false, reason: "missing date phrase" };

  if (phrase === "today") {
    return { ok: true, requestedDate: todayISO, todayISO, daysAhead: 0 };
  }
  if (phrase === "tomorrow") {
    return { ok: true, requestedDate: addDaysISO(todayISO, 1), todayISO, daysAhead: 1 };
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) {
    // compute daysAhead roughly (UTC-based, fine for mock gating)
    const daysAhead = Math.round(
      (Date.parse(phrase + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );
    return { ok: true, requestedDate: phrase, todayISO, daysAhead };
  }

  // Weekday handling
  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const wdIndex = weekdays.indexOf(phrase);
  if (wdIndex !== -1) {
    // find next occurrence of that weekday from today in tz
    const now = new Date();
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
    const todayName = dtf.format(now).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);

    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7; // "friday" means next friday, not today
    const requestedDate = addDaysISO(todayISO, delta);
    return { ok: true, requestedDate, todayISO, daysAhead: delta };
  }

  // Natural date parsing (e.g., "February 20th, 2026")
  // Strip ordinal suffixes: 1st, 2nd, 3rd, 4th...
  const cleaned = phrase.replace(/(\d+)(st|nd|rd|th)/g, "$1");
  const parsed = Date.parse(cleaned);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
    // Convert parsed date into an ISO date (YYYY-MM-DD)
    const yy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    const requestedDate = `${yy}-${mm}-${dd}`;

    const daysAhead = Math.round(
      (Date.parse(requestedDate + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );

    return { ok: true, requestedDate, todayISO, daysAhead };
  }

  return { ok: false, reason: `unrecognized date phrase: "${datePhraseRaw}"` };
}

function buildMockSchedule(requestedDate) {
  // predictable mock classes based on date
  // (same set each day; you can randomize later)
  return [
    { id: `mock_${requestedDate.replaceAll("-", "")}_1`, name: "Hot Yoga (Mock)", time: "6:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_2`, name: "Hot Pilates (Mock)", time: "9:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_3`, name: "Warm Yin (Mock)", time: "12:00 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_4`, name: "Hot Yoga (Mock)", time: "5:30 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_5`, name: "Hot Sculpt (Mock)", time: "7:00 PM", instructor: "Mock Instructor", bookable: true },
  ];
}

function buildScheduleSay(spokenDateLabel, classes) {
  const parts = classes.map((c) => `${c.time} — ${c.name}`);
  return `Here are the classes for ${spokenDateLabel}: ${parts.join(", ")}. Which class would you like to book?`;
}

function buildSpokenDateLabel(dateISO, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  // Format dateISO as long weekday/month/day/year in TZ
  // Build a Date from ISO in UTC and then format in TZ (good enough for label)
  const dt = new Date(dateISO + "T00:00:00Z");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

function respondJSON(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
}

// ---------------------------
// Route
// ---------------------------

app.post("/ghl/mindbody", (req, res) => {
  // Merge query + body (support both)
  const q = req.query || {};
  const b = req.body || {};

  const action = decodeMaybe(q.action ?? b.action).trim() || "ping";
  const studioKey = decodeMaybe(q.studioKey ?? b.studioKey).trim() || "oxygen_roundhouse";
  const timezone = decodeMaybe(q.timezone ?? b.timezone).trim() || "America/Vancouver";
  const source = decodeMaybe(q.source ?? b.source).trim() || "agencyvault";

  // IMPORTANT: date might be "tomorrow" OR "February 20th, 2026" OR "2026-02-21"
  const dateParamRaw = q.date ?? b.date ?? q.dateParam ?? b.dateParam ?? q.datePhrase ?? b.datePhrase;
  const datePhraseRaw = decodeMaybe(dateParamRaw).trim();

  // basic logs (Railway)
  console.log("--------------------------------------------------");
  console.log("POST /ghl/mindbody");
  console.log("headers:", {
    "content-type": req.headers["content-type"],
    authorization: req.headers["authorization"] ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });
  console.log("query:", q);
  console.log("body:", b);

  if (action === "ping") {
    return respondJSON(res, {
      success: true,
      say: "pong",
      text: "pong",
      results: { say: "pong", text: "pong" },
      data: { action, studioKey, timezone, source },
    });
  }

  if (action === "get_schedule" || action === "get_schedule_web" || action === "get_schedule_by_date") {
    // For mock mode gating
    const maxDaysAhead = 14;

    const resolved = resolveDatePhraseToISO(datePhraseRaw || "today", timezone);
    console.log("parsed:", {
      action,
      studioKey,
      timezone,
      source,
      datePhrase: datePhraseRaw,
      ...resolved,
      maxDaysAhead,
    });

    if (!resolved.ok) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: `Could not parse date: ${resolved.reason}`,
        data: { action, studioKey, timezone, source, datePhraseRaw },
      });
    }

    if (resolved.daysAhead > maxDaysAhead) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: `Date is too far ahead for mock mode (max ${maxDaysAhead} days).`,
        data: { action, studioKey, timezone, source, datePhraseRaw, ...resolved, maxDaysAhead },
      });
    }

    const requestedDate = resolved.requestedDate;
    const spokenDate = buildSpokenDateLabel(requestedDate, timezone);
    const classes = buildMockSchedule(requestedDate);

    const say = buildScheduleSay(spokenDate, classes);

    return respondJSON(res, {
      success: true,
      say,
      text: say,
      // VERY IMPORTANT: many platforms expose only "results"
      results: { say, text: say },
      data: {
        action: "get_schedule",
        mode: "mock",
        studioKey,
        timezone,
        source,
        datePhraseRaw,
        requestedDate,
        todayInTZ: resolved.todayISO,
        daysAhead: resolved.daysAhead,
        maxDaysAhead,
        schedule: {
          studioKey,
          timezone,
          date: requestedDate,
          spokenDate,
          classes,
        },
      },
    });
  }

  // Unknown action
  return respondJSON(res, {
    success: false,
    say: "",
    text: "",
    results: { say: "", text: "" },
    error: `Unknown action: ${action}`,
    data: { action, studioKey, timezone, source, datePhraseRaw },
  });
});

app.get("/", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});




