const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// ===================== helpers =====================
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

function safeDecode(str) {
  const s = String(str ?? "");
  // Handles "America%2FVancouver" -> "America/Vancouver"
  try {
    return s.includes("%") ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}

function isValidISODateYYYYMMDD(dateStr) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [y, m, d] = dateStr.split("-").map((n) => Number(n));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function assertValidTimeZoneOrFallback(tzRaw) {
  const tz = safeDecode(tzRaw || "").trim();
  if (!tz) return "America/Vancouver";
  try {
    // Throws RangeError if invalid
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return "America/Vancouver";
  }
}

function formatYYYYMMDDInTZ(dateObj, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA yields YYYY-MM-DD nicely
  return dtf.format(dateObj);
}

// Rough “days between” using UTC midnights for YYYY-MM-DD
function diffDays(dateA_YYYYMMDD, dateB_YYYYMMDD) {
  const [ay, am, ad] = dateA_YYYYMMDD.split("-").map(Number);
  const [by, bm, bd] = dateB_YYYYMMDD.split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((a - b) / (24 * 60 * 60 * 1000));
}

// Calculate an approximate UTC range for a local date in a timezone.
// We use "noon" offset to avoid DST edge weirdness (good enough for schedule windows).
function utcRangeForLocalDate(dateYYYYMMDD, timeZone) {
  const [y, m, d] = dateYYYYMMDD.split("-").map(Number);

  // Offset at UTC noon for that date
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offsetMin = getTimeZoneOffsetMinutes(noonUTC, timeZone);

  // Start of local day in UTC (approx)
  const startUTCms = Date.UTC(y, m - 1, d, 0, 0, 0) - offsetMin * 60 * 1000;
  const endUTCms = startUTCms + 24 * 60 * 60 * 1000 - 1;

  return { fromDate: new Date(startUTCms).toISOString(), toDate: new Date(endUTCms).toISOString() };
}

// Standard offset trick
function getTimeZoneOffsetMinutes(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
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

  // If date is e.g. 12:00 UTC, and local shows 04:00, then asUTC - dateUTC is offset
  const dateUTC = date.getTime();
  return Math.round((asUTC - dateUTC) / 60000);
}

// Deterministic pseudo-random based on seed (so same date => same schedule)
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Build a realistic mocked schedule that changes by date
function buildMockSchedule({ studioKey, timezone, dateYYYYMMDD }) {
  const seed = hashStringToSeed(`${studioKey}|${timezone}|${dateYYYYMMDD}`);
  const rnd = mulberry32(seed);

  const instructors = ["Sam", "Jordan", "Riley", "Taylor", "Avery", "Casey", "Morgan"];
  const classNames = [
    "Hot Yoga",
    "Warm Flow",
    "Power Flow",
    "Yin & Restore",
    "Hot Pilates",
    "Sculpt",
    "Mobility + Stretch",
  ];

  // Base time slots (local times)
  const weekdaySlots = ["06:00", "07:30", "09:00", "12:00", "17:00", "18:30", "20:00"];
  const weekendSlots = ["08:00", "09:30", "11:00", "12:30", "16:30", "18:00"];

  // Determine weekday/weekend from the date (UTC-based is fine for mock pattern)
  const [y, m, d] = dateYYYYMMDD.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sun .. 6 Sat
  const slots = dow === 0 || dow === 6 ? weekendSlots : weekdaySlots;

  // Pick how many classes today
  const minClasses = dow === 0 || dow === 6 ? 4 : 5;
  const maxClasses = dow === 0 || dow === 6 ? 6 : 7;
  const classCount = minClasses + Math.floor(rnd() * (maxClasses - minClasses + 1));

  // Choose slots (deterministically)
  const chosenSlots = [];
  const slotPool = [...slots];
  while (chosenSlots.length < classCount && slotPool.length) {
    const idx = Math.floor(rnd() * slotPool.length);
    chosenSlots.push(slotPool.splice(idx, 1)[0]);
  }
  chosenSlots.sort(); // chronological

  const { fromDate, toDate } = utcRangeForLocalDate(dateYYYYMMDD, timezone);

  // Convert local time HH:MM into an ISO timestamp in UTC-ish way for consistent output.
  // For mock, we’ll set approximate UTC timestamps by taking the local-day UTC start and adding minutes.
  const dayStartUTC = new Date(fromDate).getTime();

  const classes = chosenSlots.map((hhmm, i) => {
    const [hh, mm] = hhmm.split(":").map(Number);
    const startMin = hh * 60 + mm;

    // Duration: 60–75 minutes
    const dur = rnd() < 0.7 ? 60 : 75;
    const endMin = startMin + dur;

    const startDateTime = new Date(dayStartUTC + startMin * 60000).toISOString();
    const endDateTime = new Date(dayStartUTC + endMin * 60000).toISOString();

    const name = classNames[Math.floor(rnd() * classNames.length)];
    const instructor = instructors[Math.floor(rnd() * instructors.length)];

    return {
      id: `mock_${dateYYYYMMDD.replace(/-/g, "")}_${i + 1}`,
      name: `${name} (Mock)`,
      startDateTime,
      endDateTime,
      instructor,
      bookable: true,
      location: studioKey,
    };
  });

  return {
    studioKey,
    timezone,
    date: dateYYYYMMDD,
    range: { from: fromDate, to: toDate },
    classes,
  };
}

// ===================== route =====================
app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault often sends query params)
  const actionRaw = pickFirst(req.body?.action, req.query?.action);
  const studioKeyRaw = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezoneRaw = pickFirst(req.body?.timezone, req.query?.timezone);
  const source = pickFirst(req.body?.source, req.query?.source);

  // NEW: optional date parameter (YYYY-MM-DD)
  const dateParamRaw = pickFirst(req.body?.date, req.query?.date);

  // Normalize
  const action = String(actionRaw || "").trim();
  const studioKey = String(studioKeyRaw || "").trim() || "unknown_studio";
  const timezone = assertValidTimeZoneOrFallback(timezoneRaw);

  const dateParam = dateParamRaw ? String(dateParamRaw).trim() : undefined;

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  // Mode (we’re staying in mock for Option A)
  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase(); // mock | web (future)
  const maxDaysAhead = Number(process.env.DAYS_AHEAD_MAX || 14);

  // Compute “today” in the studio timezone
  const todayInTZ = formatYYYYMMDDInTZ(new Date(), timezone);

  // Determine requested date (default: today)
  let requestedDate = todayInTZ;
  if (dateParam) {
    if (!isValidISODateYYYYMMDD(dateParam)) {
      return res.status(400).json({
        ok: false,
        debugId,
        error: "Invalid date format. Use YYYY-MM-DD",
        got: dateParam,
      });
    }
    requestedDate = dateParam;
  }

  const daysAhead = diffDays(requestedDate, todayInTZ); // requested - today
  // We allow: today (0) through +maxDaysAhead
  if (daysAhead > maxDaysAhead) {
    return res.status(200).json({
      ok: true,
      debugId,
      action,
      mode: "mock",
      studioKey,
      timezone,
      source,
      date: requestedDate,
      limited: true,
      message: `I can provide schedules up to ${maxDaysAhead} days ahead. Please choose a date within the next two weeks.`,
      meta: { today: todayInTZ, daysAhead, maxDaysAhead },
      schedule: buildMockSchedule({ studioKey, timezone, dateYYYYMMDD: todayInTZ }),
    });
  }
  if (daysAhead < 0) {
    return res.status(200).json({
      ok: true,
      debugId,
      action,
      mode: "mock",
      studioKey,
      timezone,
      source,
      date: requestedDate,
      limited: true,
      message: `I can provide schedules from today onward. Please choose today or a future date.`,
      meta: { today: todayInTZ, daysAhead, maxDaysAhead },
      schedule: buildMockSchedule({ studioKey, timezone, dateYYYYMMDD: todayInTZ }),
    });
  }

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
  console.log(`[${debugId}] parsed:`, {
    action,
    studioKey,
    timezone,
    source,
    dateParam: dateParam || null,
    requestedDate,
    todayInTZ,
    daysAhead,
    maxDaysAhead,
  });

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

  // get_schedule (MOCK, date-aware)
  if (action === "get_schedule") {
    const schedule = buildMockSchedule({
      studioKey,
      timezone,
      dateYYYYMMDD: requestedDate,
    });

    return res.status(200).json({
      ok: true,
      action,
      mode: "mock",
      studioKey,
      timezone,
      source,
      date: requestedDate,
      meta: { today: todayInTZ, daysAhead, maxDaysAhead },
      schedule,
      debugId,
    });
  }

  // get_schedule_web (we keep it, but for Option A it returns the same mock schedule)
  // This keeps your existing GHL tests working without relying on the widget.
  if (action === "get_schedule_web") {
    const schedule = buildMockSchedule({
      studioKey,
      timezone,
      dateYYYYMMDD: requestedDate,
    });

    return res.status(200).json({
      ok: true,
      action,
      mode: "mock_web_placeholder",
      note: "Web/widget fetching is disabled in Option A. This returns a date-aware mocked schedule until Mindbody API credentials arrive.",
      studioKey,
      timezone,
      source,
      date: requestedDate,
      meta: { today: todayInTZ, daysAhead, maxDaysAhead },
      schedule,
      debugId,
    });
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






