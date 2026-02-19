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

// Decode things like "America%2FVancouver"
function decodeMaybe(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  try {
    // decode once
    const once = decodeURIComponent(s);
    // sometimes it can be double-encoded in logs; decode twice safely
    return once.includes("%2F") || once.includes("%3A") ? decodeURIComponent(once) : once;
  } catch {
    return s;
  }
}

function isValidIanaTimeZone(tz) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function fmtDateInTZ(dateObj, tz) {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dateObj);
}

function fmtReadableDateInTZ(dateObj, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(dateObj);
}

function parseISODateOnly(s) {
  // YYYY-MM-DD
  const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, mo, d };
}

function dateOnlyToUtcNoon({ y, mo, d }) {
  // UTC noon avoids DST edge weirdness
  return new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
}

function addDays(dateObj, days) {
  return new Date(dateObj.getTime() + days * 24 * 60 * 60 * 1000);
}

function clampDaysAhead(todayUtcNoon, targetUtcNoon, maxDaysAhead) {
  const diffMs = targetUtcNoon.getTime() - todayUtcNoon.getTime();
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  return diffDays <= maxDaysAhead;
}

function weekdayIndex(name) {
  const n = String(name).toLowerCase();
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  };
  return map[n] ?? null;
}

function nextWeekdayUtcNoon(todayUtcNoon, tz, wantedIdx, forceNextWeek) {
  // Determine today's weekday in TZ
  const todayWeekdayName = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(todayUtcNoon);
  const todayIdx = weekdayIndex(todayWeekdayName);
  if (todayIdx === null) return null;

  let delta = (wantedIdx - todayIdx + 7) % 7;
  if (delta === 0 && forceNextWeek) delta = 7; // "next Friday"
  return addDays(todayUtcNoon, delta);
}

// Accepts: YYYY-MM-DD OR today/tomorrow OR weekday/next weekday OR "Feb 21" OR "14th"
function resolveDateParamToUtcNoon({ dateParamRaw, tz }) {
  const raw = String(dateParamRaw ?? "").trim();
  if (!raw) return { ok: true, kind: "default_today" };

  const lower = raw.toLowerCase();

  // ISO date
  const iso = parseISODateOnly(raw);
  if (iso) return { ok: true, kind: "iso", utcNoon: dateOnlyToUtcNoon(iso) };

  // today / tomorrow
  if (lower === "today") return { ok: true, kind: "today" };
  if (lower === "tomorrow") return { ok: true, kind: "tomorrow" };

  // next <weekday> or <weekday>
  const nextMatch = lower.match(/^next\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (nextMatch) return { ok: true, kind: "next_weekday", weekday: nextMatch[1], forceNextWeek: true };

  const wdMatch = lower.match(/^(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (wdMatch) return { ok: true, kind: "weekday", weekday: wdMatch[1], forceNextWeek: false };

  // "14th" / "14"
  const dayOnly = lower.match(/^(\d{1,2})(st|nd|rd|th)?$/);
  if (dayOnly) return { ok: true, kind: "day_of_month", day: Number(dayOnly[1]) };

  // "Feb 21" / "February 21" / etc
  // We’ll try parsing with current year, then next year if needed
  return { ok: true, kind: "date_text", text: raw };
}

function computeRequestedDate({ tz, dateParamRaw, maxDaysAhead }) {
  const now = new Date();
  const todayStr = fmtDateInTZ(now, tz);
  const todayParts = parseISODateOnly(todayStr);
  const todayUtcNoon = dateOnlyToUtcNoon(todayParts);

  const res = resolveDateParamToUtcNoon({ dateParamRaw, tz });
  if (!res.ok) return { ok: false, error: "Could not read date" };

  let targetUtcNoon = null;

  if (res.kind === "default_today" || res.kind === "today") {
    targetUtcNoon = todayUtcNoon;
  } else if (res.kind === "tomorrow") {
    targetUtcNoon = addDays(todayUtcNoon, 1);
  } else if (res.kind === "weekday" || res.kind === "next_weekday") {
    const idx = weekdayIndex(res.weekday);
    targetUtcNoon = nextWeekdayUtcNoon(todayUtcNoon, tz, idx, !!res.forceNextWeek);
  } else if (res.kind === "iso") {
    targetUtcNoon = res.utcNoon;
  } else if (res.kind === "day_of_month") {
    // pick this month if within window, else next month (still within 14 days)
    const y = todayParts.y;
    const mo = todayParts.mo;
    const d = res.day;

    const try1 = dateOnlyToUtcNoon({ y, mo, d });
    const try2 = dateOnlyToUtcNoon({
      y: mo === 12 ? y + 1 : y,
      mo: mo === 12 ? 1 : mo + 1,
      d,
    });

    // choose the earliest future date
    const candidates = [try1, try2].filter((x) => x.getTime() >= todayUtcNoon.getTime());
    targetUtcNoon = candidates.sort((a, b) => a.getTime() - b.getTime())[0] || try2;
  } else if (res.kind === "date_text") {
    // Parse with current year if missing; if past, try next year
    const y = todayParts.y;
    let dt = new Date(Date.parse(`${res.text} ${y}`));
    if (Number.isNaN(dt.getTime())) dt = new Date(Date.parse(res.text));
    if (Number.isNaN(dt.getTime())) return { ok: false, error: `Unrecognized date: ${res.text}` };

    // normalize to the date in TZ (strip time)
    const dateStr = fmtDateInTZ(dt, tz);
    const parts = parseISODateOnly(dateStr);
    targetUtcNoon = dateOnlyToUtcNoon(parts);

    if (targetUtcNoon.getTime() < todayUtcNoon.getTime()) {
      // try next year
      const dt2 = new Date(Date.parse(`${res.text} ${y + 1}`));
      if (!Number.isNaN(dt2.getTime())) {
        const dateStr2 = fmtDateInTZ(dt2, tz);
        const parts2 = parseISODateOnly(dateStr2);
        targetUtcNoon = dateOnlyToUtcNoon(parts2);
      }
    }
  }

  if (!targetUtcNoon) return { ok: false, error: "Could not compute requested date" };

  const requestedDate = fmtDateInTZ(targetUtcNoon, tz);
  const daysAhead = Math.floor(
    (targetUtcNoon.getTime() - todayUtcNoon.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (daysAhead < 0) {
    return { ok: false, error: "That date is in the past." };
  }

  if (!clampDaysAhead(todayUtcNoon, targetUtcNoon, maxDaysAhead)) {
    return {
      ok: false,
      error: `I can only check schedules up to ${maxDaysAhead} days ahead.`,
      daysAhead,
      requestedDate,
    };
  }

  return { ok: true, todayInTZ: todayStr, requestedDate, daysAhead, targetUtcNoon };
}

// A mocked schedule (14-day capable)
function buildMockScheduleForDate({ studioKey, timezone, requestedDate }) {
  // simple predictable mock
  const classes = [
    { time: "6:00 AM", name: "Hot Yoga" },
    { time: "9:00 AM", name: "Hot Pilates" },
    { time: "12:00 PM", name: "Warm Yin" },
    { time: "5:30 PM", name: "Hot Yoga" },
    { time: "7:00 PM", name: "Hot Sculpt" },
  ];

  return {
    studioKey,
    timezone,
    date: requestedDate,
    classes: classes.map((c, i) => ({
      id: `mock_${requestedDate.replaceAll("-", "")}_${i + 1}`,
      name: `${c.name} (Mock)`,
      time: c.time,
      instructor: "Mock Instructor",
      bookable: true,
    })),
  };
}

function buildScheduleSay({ requestedDateReadable, schedule }) {
  if (!schedule?.classes?.length) {
    return `I don’t see any classes listed for ${requestedDateReadable}.`;
  }
  const list = schedule.classes
    .map((c) => `${c.time} — ${c.name}`)
    .join(", ");
  return `Here are the classes for ${requestedDateReadable}: ${list}. Which class would you like to book?`;
}

// ---------------- widget fetch (web) ----------------
// (kept for later; not required for mock)
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

  return { status: res.status, ok: res.ok, text };
}

// ---------------- route ----------------
app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault sends query params)
  const action = pickFirst(req.body?.action, req.query?.action);
  const studioKey = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezoneRaw = pickFirst(req.body?.timezone, req.query?.timezone);
  const source = pickFirst(req.body?.source, req.query?.source);
  const dateParamRaw = pickFirst(req.body?.date, req.query?.date);

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  // Mode
  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase(); // mock | web | live (future)

  // Decode timezone safely
  const timezone = decodeMaybe(timezoneRaw) || "America/Vancouver";
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
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source, dateParamRaw });

  if (!expectedSecret) {
    return res.status(500).json({
      success: false,
      say: "Server is missing configuration.",
      debugId,
      error: "Server missing GHL_SECRET env var",
    });
  }

  if (!incomingAuth || incomingAuth !== expectedSecret) {
    return res.status(401).json({
      success: false,
      say: "Unauthorized.",
      debugId,
      error: "Unauthorized",
    });
  }

  if (!action) {
    return res.status(400).json({
      success: false,
      say: "Missing action.",
      debugId,
      error: "Missing action (send in JSON body or query string)",
    });
  }

  if (!isValidIanaTimeZone(timezone)) {
    return res.status(400).json({
      success: false,
      say: "Invalid timezone provided.",
      debugId,
      error: `Invalid time zone specified: ${timezone}`,
    });
  }

  // Ping
  if (action === "ping") {
    return res.status(200).json({
      success: true,
      say: "pong",
      debugId,
      data: { action, studioKey, timezone, source },
    });
  }

  // ---------------- get_schedule ----------------
  if (action === "get_schedule") {
    const computed = computeRequestedDate({
      tz: timezone,
      dateParamRaw,
      maxDaysAhead,
    });

    if (!computed.ok) {
      return res.status(200).json({
        success: false,
        say: computed.error || "I couldn’t understand that date.",
        debugId,
        data: {
          action,
          studioKey,
          timezone,
          source,
          dateParamRaw,
          maxDaysAhead,
          ...computed,
        },
      });
    }

    const requestedDateReadable = fmtReadableDateInTZ(computed.targetUtcNoon, timezone);

    // mock schedule (default)
    if (mode !== "web") {
      const schedule = buildMockScheduleForDate({
        studioKey,
        timezone,
        requestedDate: computed.requestedDate,
      });

      return res.status(200).json({
        success: true,
        say: buildScheduleSay({ requestedDateReadable, schedule }),
        debugId,
        data: {
          action,
          mode: "mock",
          studioKey,
          timezone,
          source,
          dateParamRaw,
          requestedDate: computed.requestedDate,
          todayInTZ: computed.todayInTZ,
          daysAhead: computed.daysAhead,
          maxDaysAhead,
          schedule,
        },
      });
    }

    // web mode (kept for later; currently just shows widget preview)
    try {
      // If you want: use requestedDate -> requestedDate+1 to fetch a 24h window
      const fromDate = `${computed.requestedDate}T00:00:00`;
      const toDate = `${computed.requestedDate}T23:59:59`;

      const result = await fetchMindbodyWidgetSchedule({ fromDate, toDate, debugId });

      return res.status(200).json({
        success: true,
        say: `I pulled the schedule data for ${requestedDateReadable}.`,
        debugId,
        data: {
          action,
          mode: "web",
          studioKey,
          timezone,
          source,
          dateParamRaw,
          requestedDate: computed.requestedDate,
          todayInTZ: computed.todayInTZ,
          daysAhead: computed.daysAhead,
          maxDaysAhead,
          widget: {
            status: result.status,
            ok: result.ok,
            rawLength: result.text.length,
            preview: result.text.slice(0, 500),
          },
        },
      });
    } catch (err) {
      return res.status(200).json({
        success: false,
        say: "I couldn’t pull the live schedule right now.",
        debugId,
        data: {
          action,
          mode: "web",
          error: String(err?.message || err),
        },
      });
    }
  }

  // Placeholder for next actions
  if (action === "book_class" || action === "cancel_class") {
    return res.status(200).json({
      success: true,
      say: `${action} received (not implemented yet).`,
      debugId,
      data: { action, studioKey, timezone, source },
    });
  }

  return res.status(400).json({
    success: false,
    say: "Unknown action.",
    debugId,
    error: `Unknown action: ${action}`,
    allowed: ["ping", "get_schedule", "book_class", "cancel_class"],
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));







