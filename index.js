/**
 * FlowAI Mindbody Webhook (Mock Schedule)
 * - Endpoint: POST /ghl/mindbody
 * - Query params:
 *    action: get_schedule (or get_schedule_web / get_schedule_by_date supported)
 *    studioKey: oxygen_roundhouse (required)
 *    timezone: America/Vancouver (required)  <-- handles encoded values too
 *    source: agencyvault (optional)
 *    date: any date phrase (optional) e.g. "tomorrow", "Friday", "2026-02-21", "February 20th, 2026"
 *
 * Returns:
 *  {
 *    success: true/false,
 *    say: "...",
 *    text: "...",
 *    results: { say: "...", text: "..." },
 *    debugId: "...",
 *    data: { ...debug payload... }
 *  }
 */

const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// -------- Helpers --------

function makeDebugId() {
  return crypto.randomBytes(6).toString("hex");
}

// Some platforms send encoded timezone like America%2FVancouver
function normalizeTimezone(tz) {
  if (!tz) return null;
  try {
    const decoded = decodeURIComponent(tz);
    return decoded;
  } catch {
    return tz;
  }
}

// Get "today" in a specific TZ as YYYY-MM-DD
function getTodayYMDInTZ(timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA yields YYYY-MM-DD
  return dtf.format(new Date());
}

function ymdToParts(ymd) {
  const [y, m, d] = ymd.split("-").map((x) => parseInt(x, 10));
  return { y, m, d };
}

function partsToYMD({ y, m, d }) {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Add days to a YYYY-MM-DD safely (using UTC noon)
function addDaysToYMD(ymd, daysToAdd) {
  const { y, m, d } = ymdToParts(ymd);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // noon UTC prevents day shift
  dt.setUTCDate(dt.getUTCDate() + daysToAdd);
  const yy = dt.getUTCFullYear();
  const mm = dt.getUTCMonth() + 1;
  const dd = dt.getUTCDate();
  return partsToYMD({ y: yy, m: mm, d: dd });
}

function clampDaysAhead(daysAhead, maxDaysAhead) {
  if (typeof daysAhead !== "number" || Number.isNaN(daysAhead)) return null;
  if (daysAhead < 0) return null;
  if (daysAhead > maxDaysAhead) return null;
  return daysAhead;
}

// Parse a few date phrase types -> returns { requestedDateYMD, datePhraseRaw, daysAhead }
function resolveDatePhraseToYMD({ datePhrase, timeZone, maxDaysAhead }) {
  const datePhraseRaw = (datePhrase || "").trim();

  const todayYMD = getTodayYMDInTZ(timeZone);

  // default if missing: today
  if (!datePhraseRaw) {
    return {
      requestedDateYMD: todayYMD,
      datePhraseRaw: "",
      daysAhead: 0,
    };
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePhraseRaw)) {
    const requestedDateYMD = datePhraseRaw;
    const daysAhead = diffDaysYMD(todayYMD, requestedDateYMD);
    return { requestedDateYMD, datePhraseRaw, daysAhead };
  }

  const lower = datePhraseRaw.toLowerCase();

  // today / tomorrow
  if (lower === "today") {
    return { requestedDateYMD: todayYMD, datePhraseRaw, daysAhead: 0 };
  }
  if (lower === "tomorrow") {
    const requestedDateYMD = addDaysToYMD(todayYMD, 1);
    return { requestedDateYMD, datePhraseRaw, daysAhead: 1 };
  }

  // Month name formats like "February 20th, 2026" or "Feb 20 2026"
  // We’ll parse loosely and then render to YMD in TZ using Intl
  const parsedFromMonthName = tryParseMonthNameDate(datePhraseRaw, timeZone);
  if (parsedFromMonthName) {
    const requestedDateYMD = parsedFromMonthName;
    const daysAhead = diffDaysYMD(todayYMD, requestedDateYMD);
    return { requestedDateYMD, datePhraseRaw, daysAhead };
  }

  // Weekday phrases: "friday", "this friday", "next friday"
  const weekdayResult = tryParseWeekday(datePhraseRaw, timeZone);
  if (weekdayResult) {
    const requestedDateYMD = weekdayResult;
    const daysAhead = diffDaysYMD(todayYMD, requestedDateYMD);
    return { requestedDateYMD, datePhraseRaw, daysAhead };
  }

  // If we can’t parse it, treat as failure
  return {
    requestedDateYMD: null,
    datePhraseRaw,
    daysAhead: null,
    error: `Unable to parse date phrase: "${datePhraseRaw}"`,
  };
}

// Difference in days between two YYYY-MM-DD (end - start), using UTC noon
function diffDaysYMD(startYMD, endYMD) {
  const a = ymdToParts(startYMD);
  const b = ymdToParts(endYMD);
  const dtA = new Date(Date.UTC(a.y, a.m - 1, a.d, 12, 0, 0));
  const dtB = new Date(Date.UTC(b.y, b.m - 1, b.d, 12, 0, 0));
  const ms = dtB.getTime() - dtA.getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function tryParseMonthNameDate(input, timeZone) {
  // Examples:
  // "February 20th, 2026"
  // "Feb 20, 2026"
  // "Feb 20 2026"
  const cleaned = input
    .replace(/(\d+)(st|nd|rd|th)/gi, "$1")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Try Date.parse on cleaned
  const ms = Date.parse(cleaned);
  if (Number.isNaN(ms)) return null;

  // Render that moment into YMD in the target TZ
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date(ms));
}

function tryParseWeekday(input, timeZone) {
  const lower = input.toLowerCase().trim();

  const weekdayMap = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };

  // normalize prefixes
  let mode = "next"; // default: next occurrence (including if today is that weekday -> next week)
  let word = lower;

  if (lower.startsWith("this ")) {
    mode = "this";
    word = lower.replace(/^this\s+/, "");
  } else if (lower.startsWith("next ")) {
    mode = "next";
    word = lower.replace(/^next\s+/, "");
  }

  // accept "fri" etc? (optional) — keep strict for now
  if (!(word in weekdayMap)) return null;

  const target = weekdayMap[word];

  // Determine today weekday in TZ
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" });
  const todayName = dtf.format(new Date()).toLowerCase();
  const today = weekdayMap[todayName];

  // Start from todayYMD in TZ
  const todayYMD = getTodayYMDInTZ(timeZone);

  // offset calculation
  let delta = (target - today + 7) % 7;

  if (mode === "this") {
    // If caller says "this friday" and today is Friday, we treat it as today (delta 0)
    // If today passed it (delta 0 means today), fine.
    // If today is after target, delta wraps to next week; that’s okay for "this" only if it’s still upcoming.
    // BUT "this friday" when today is Saturday -> delta becomes 6 days ahead (next Friday), which is okay.
    // We’ll accept.
  } else {
    // "friday" (default) / "next friday": if today is Friday, they mean next week
    if (delta === 0) delta = 7;
    if (mode === "next") {
      // If it's already a non-zero delta, "next friday" could mean +7 beyond upcoming Friday.
      // For simplicity: if delta > 0, add 7.
      // Example: today Monday, "next Friday" => upcoming Friday is 4 days; next Friday is 11 days.
      delta = delta + 7;
    }
  }

  return addDaysToYMD(todayYMD, delta);
}

function buildMockSchedule({ requestedDateYMD }) {
  // You can swap class mix later; keep stable for testing
  return {
    date: requestedDateYMD,
    classes: [
      {
        id: `mock_${requestedDateYMD.replace(/-/g, "")}_1`,
        name: "Hot Yoga (Mock)",
        time: "6:00 AM",
        instructor: "Mock Instructor",
        bookable: true,
      },
      {
        id: `mock_${requestedDateYMD.replace(/-/g, "")}_2`,
        name: "Hot Pilates (Mock)",
        time: "9:00 AM",
        instructor: "Mock Instructor",
        bookable: true,
      },
      {
        id: `mock_${requestedDateYMD.replace(/-/g, "")}_3`,
        name: "Warm Yin (Mock)",
        time: "12:00 PM",
        instructor: "Mock Instructor",
        bookable: true,
      },
      {
        id: `mock_${requestedDateYMD.replace(/-/g, "")}_4`,
        name: "Hot Yoga (Mock)",
        time: "5:30 PM",
        instructor: "Mock Instructor",
        bookable: true,
      },
      {
        id: `mock_${requestedDateYMD.replace(/-/g, "")}_5`,
        name: "Hot Sculpt (Mock)",
        time: "7:00 PM",
        instructor: "Mock Instructor",
        bookable: true,
      },
    ],
  };
}

function buildScheduleSay({ requestedDateYMD, timeZone, schedule }) {
  // IMPORTANT FIX:
  // Use UTC NOON for the requested YMD so timeZone conversion can’t roll the day backward.
  const { y, m, d } = ymdToParts(requestedDateYMD);
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)); // <-- FIX

  const spokenDate = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);

  const items = (schedule?.classes || []).map((c) => `${c.time} — ${c.name}`);
  const list = items.length ? items.join(", ") : "No classes found.";

  return `Here are the classes for ${spokenDate}: ${list}. Which class would you like to book?`;
}

// -------- Route --------

app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  const q = req.query || {};
  const body = req.body || {};

  // normalize incoming values
  const action = String(q.action || body.action || "").trim() || "get_schedule";
  const studioKey = String(q.studioKey || body.studioKey || "").trim();
  const source = String(q.source || body.source || "").trim() || "agencyvault";
  const timeZoneRaw = String(q.timezone || body.timezone || "").trim();
  const timeZone = normalizeTimezone(timeZoneRaw);

  const datePhrase = String(q.date || body.date || "").trim();

  const maxDaysAhead = 14;

  // Log a concise snapshot (Railway logs)
  console.log(`[${debugId}] POST /ghl/mindbody?action=${action}&studioKey=${studioKey}&timezone=${encodeURIComponent(timeZone || "")}&source=${source}&date=${encodeURIComponent(datePhrase)}`);
  console.log(`[${debugId}] headers:`, {
    "content-type": req.headers["content-type"],
    authorization: req.headers.authorization ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });

  // Validate required
  if (!studioKey) {
    return res.status(200).json({
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      debugId,
      error: "Missing studioKey",
      data: { action, studioKey, timeZone, source, datePhraseRaw: datePhrase },
    });
  }

  if (!timeZone) {
    return res.status(200).json({
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      debugId,
      error: "Missing timezone",
      data: { action, studioKey, timeZone, source, datePhraseRaw: datePhrase },
    });
  }

  // Validate timezone early (prevents Intl crash)
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch (e) {
    return res.status(200).json({
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      debugId,
      error: `Invalid timezone: ${timeZone}`,
      data: { action, studioKey, timeZone, source, datePhraseRaw: datePhrase },
    });
  }

  // Support multiple action names, but treat them the same for now
  const supported = new Set(["get_schedule", "get_schedule_web", "get_schedule_by_date"]);
  if (!supported.has(action)) {
    return res.status(200).json({
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      debugId,
      error: `Unsupported action: ${action}`,
      data: { action, studioKey, timeZone, source, datePhraseRaw: datePhrase },
    });
  }

  // Resolve date phrase -> YMD
  const resolved = resolveDatePhraseToYMD({
    datePhrase,
    timeZone,
    maxDaysAhead,
  });

  if (!resolved.requestedDateYMD) {
    return res.status(200).json({
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      debugId,
      error: resolved.error || "Unable to resolve date",
      data: {
        action,
        mode: "mock",
        studioKey,
        timeZone,
        source,
        datePhraseRaw: resolved.datePhraseRaw,
        requestedDate: null,
        todayInTZ: getTodayYMDInTZ(timeZone),
        daysAhead: resolved.daysAhead,
        maxDaysAhead,
      },
    });
  }

  // Enforce maxDaysAhead (14)
  const clamped = clampDaysAhead(resolved.daysAhead, maxDaysAhead);
  if (clamped === null) {
    return res.status(200).json({
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      debugId,
      error: `Date is out of range. Please request within ${maxDaysAhead} days.`,
      data: {
        action,
        mode: "mock",
        studioKey,
        timeZone,
        source,
        datePhraseRaw: resolved.datePhraseRaw,
        requestedDate: resolved.requestedDateYMD,
        todayInTZ: getTodayYMDInTZ(timeZone),
        daysAhead: resolved.daysAhead,
        maxDaysAhead,
      },
    });
  }

  // Mock schedule
  const schedule = buildMockSchedule({ requestedDateYMD: resolved.requestedDateYMD });

  const say = buildScheduleSay({
    requestedDateYMD: resolved.requestedDateYMD,
    timeZone,
    schedule,
  });

  const response = {
    success: true,
    say,
    text: say,
    results: { say, text: say },
    debugId,
    data: {
      action,
      mode: "mock",
      studioKey,
      timeZone,
      source,
      datePhraseRaw: resolved.datePhraseRaw,
      requestedDate: resolved.requestedDateYMD,
      todayInTZ: getTodayYMDInTZ(timeZone),
      daysAhead: clamped,
      maxDaysAhead,
      schedule,
    },
  };

  return res.status(200).json(response);
});

// Health
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});




