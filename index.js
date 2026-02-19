/**
 * FlowAI Mindbody Webhook (GHL Custom Action)
 * - Single endpoint: POST /ghl/mindbody
 * - Uses query params (GHL sends params in querystring)
 * - Supports mocked schedule with date parsing + 14-day cap
 * - Returns "say/text" in multiple locations to satisfy different wrappers:
 *   top-level say/text AND results.say/results.text
 */

const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// -------- Helpers --------

function safeStr(v) {
  if (v === undefined || v === null) return "";
  return String(v);
}

function decodeMaybeTwice(v) {
  // Handles cases like America%252FVancouver (double-encoded)
  let s = safeStr(v);
  try {
    const once = decodeURIComponent(s);
    try {
      const twice = decodeURIComponent(once);
      return twice;
    } catch {
      return once;
    }
  } catch {
    return s;
  }
}

function isValidIanaTimeZone(tz) {
  try {
    // Will throw if invalid
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function ymdFromDateInTZ(date, timeZone) {
  // Returns YYYY-MM-DD for "date" formatted in a given timezone
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDaysUTC(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function parseDatePhraseToYMD(datePhraseRaw, timeZone) {
  // Goal: accept "tomorrow", "today", "Friday", "Feb 21", "2026-02-21", "the 14th", etc.
  // For now: support
  // - YYYY-MM-DD (direct)
  // - today / tomorrow
  // - anything Date.parse can handle (best effort)
  const raw = safeStr(datePhraseRaw).trim();
  if (!raw) return { ok: false, reason: "missing_date" };

  // YYYY-MM-DD exact
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: true, ymd: raw, normalized: raw, method: "ymd" };
  }

  const lower = raw.toLowerCase();

  const now = new Date();
  // "today" and "tomorrow" are in studio TZ
  if (lower === "today") {
    const ymd = ymdFromDateInTZ(now, timeZone);
    return { ok: true, ymd, normalized: "today", method: "keyword" };
  }
  if (lower === "tomorrow") {
    // Add 1 day from "today in TZ"
    // We approximate by adding 1 day UTC then formatting in TZ
    const tomorrow = addDaysUTC(now, 1);
    const ymd = ymdFromDateInTZ(tomorrow, timeZone);
    return { ok: true, ymd, normalized: "tomorrow", method: "keyword" };
  }

  // Best-effort Date.parse (works for "February 20th, 2026", "Feb 21 2026", etc.)
  const parsedMs = Date.parse(raw);
  if (!Number.isNaN(parsedMs)) {
    const d = new Date(parsedMs);
    const ymd = ymdFromDateInTZ(d, timeZone);
    return { ok: true, ymd, normalized: raw, method: "dateparse" };
  }

  // If it's something like "Friday" we can't safely resolve without a real NLP lib.
  // We'll return not ok and let the agent ask "this Friday or next Friday?"
  return { ok: false, reason: "unresolved_phrase", phrase: raw };
}

function diffDaysYMD(fromYMD, toYMD) {
  // diff in whole days: to - from
  const [fy, fm, fd] = fromYMD.split("-").map(Number);
  const [ty, tm, td] = toYMD.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

function mockClassesForDay(ymd) {
  // Simple deterministic mock (same times every day)
  // You can swap this later for real Mindbody calls.
  const classes = [
    { id: `mock_${ymd.replace(/-/g, "")}_1`, name: "Hot Yoga (Mock)", time: "6:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${ymd.replace(/-/g, "")}_2`, name: "Hot Pilates (Mock)", time: "9:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${ymd.replace(/-/g, "")}_3`, name: "Warm Yin (Mock)", time: "12:00 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${ymd.replace(/-/g, "")}_4`, name: "Hot Yoga (Mock)", time: "5:30 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${ymd.replace(/-/g, "")}_5`, name: "Hot Sculpt (Mock)", time: "7:00 PM", instructor: "Mock Instructor", bookable: true },
  ];
  return classes;
}

function buildScheduleSay(ymd, timeZone, datePhraseRaw) {
  // Convert ymd -> a nice spoken date label
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const spoken = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);

  const classes = mockClassesForDay(ymd);
  const line = classes
    .map((c) => `${c.time} — ${c.name}`)
    .join(", ");

  return {
    spokenDate: spoken,
    say: `Here are the classes for ${spoken}: ${line}. Which class would you like to book?`,
    classes,
    datePhraseRaw,
  };
}

// Standard response wrapper (IMPORTANT)
function respondOK(res, payload) {
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(payload));
}

function respondFail(res, message, data = {}) {
  const payload = {
    success: false,
    say: message || "",
    text: message || "",
    results: {
      say: message || "",
      text: message || "",
    },
    data,
  };
  respondOK(res, payload);
}

// -------- Route --------

app.post("/ghl/mindbody", (req, res) => {
  // GHL sends params in querystring; allow body fallback too
  const q = req.query || {};
  const b = req.body || {};

  const action = safeStr(q.action || b.action || "").trim();
  const studioKey = safeStr(q.studioKey || b.studioKey || "").trim();
  const source = safeStr(q.source || b.source || "").trim();

  // Decode timezone safely (handles double encoding)
  const timezoneRaw = q.timezone || b.timezone || "America/Vancouver";
  const timezone = decodeMaybeTwice(timezoneRaw);

  const dateParamRaw = q.date || b.date || "";
  const datePhraseRaw = safeStr(dateParamRaw).trim();

  const debugId = Math.random().toString(16).slice(2);

  // Log inbound
  console.log("--------------------------------------------------");
  console.log(`[${debugId}] POST /ghl/mindbody`);
  console.log(`[${debugId}] headers:`, {
    "content-type": req.headers["content-type"],
    authorization: req.headers["authorization"] ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });
  console.log(`[${debugId}] query:`, q);
  console.log(`[${debugId}] body:`, b);

  if (!action) {
    return respondFail(res, "Missing action parameter.", { debugId });
  }

  // Validate timezone (fallback to America/Vancouver if invalid)
  let tz = timezone;
  if (!isValidIanaTimeZone(tz)) {
    console.log(`[${debugId}] Invalid timezone received:`, timezone, "-> fallback America/Vancouver");
    tz = "America/Vancouver";
  }

  // ---- Actions ----

  if (action === "get_schedule") {
    // Enforce 14-day cap
    const maxDaysAhead = 14;

    const todayInTZ = ymdFromDateInTZ(new Date(), tz);

    const parsed = parseDatePhraseToYMD(datePhraseRaw, tz);
    console.log(`[${debugId}] parsed:`, {
      action,
      studioKey,
      timezone: tz,
      source,
      datePhrase: datePhraseRaw,
      todayInTZ,
      parsed,
      maxDaysAhead,
    });

    if (!parsed.ok) {
      // If ambiguous like "Friday", return a message the agent will read
      const msg =
        parsed.reason === "unresolved_phrase"
          ? `I can pull schedules for a specific date. Just to confirm—did you mean this ${parsed.phrase} or next ${parsed.phrase}?`
          : "I didn’t catch the date you wanted. What day should I check?";
      return respondOK(res, {
        success: true,
        say: msg,
        text: msg,
        results: { say: msg, text: msg },
        debugId,
        data: {
          action,
          mode: "mock",
          studioKey,
          timezone: tz,
          source,
          datePhraseRaw,
          todayInTZ,
          maxDaysAhead,
          parsed,
        },
      });
    }

    const requestedYMD = parsed.ymd;
    const daysAhead = diffDaysYMD(todayInTZ, requestedYMD);

    if (daysAhead < 0) {
      return respondOK(res, {
        success: true,
        say: `I can help with upcoming classes. What future day would you like to check?`,
        text: `I can help with upcoming classes. What future day would you like to check?`,
        results: {
          say: `I can help with upcoming classes. What future day would you like to check?`,
          text: `I can help with upcoming classes. What future day would you like to check?`,
        },
        debugId,
        data: {
          action,
          mode: "mock",
          studioKey,
          timezone: tz,
          source,
          datePhraseRaw,
          todayInTZ,
          requestedDate: requestedYMD,
          daysAhead,
          maxDaysAhead,
        },
      });
    }

    if (daysAhead > maxDaysAhead) {
      const msg = `I can only pull schedules up to ${maxDaysAhead} days ahead. What day within the next ${maxDaysAhead} days would you like?`;
      return respondOK(res, {
        success: true,
        say: msg,
        text: msg,
        results: { say: msg, text: msg },
        debugId,
        data: {
          action,
          mode: "mock",
          studioKey,
          timezone: tz,
          source,
          datePhraseRaw,
          todayInTZ,
          requestedDate: requestedYMD,
          daysAhead,
          maxDaysAhead,
        },
      });
    }

    const built = buildScheduleSay(requestedYMD, tz, datePhraseRaw);

    const payload = {
      success: true,

      // IMPORTANT: Provide these at top-level AND results.*
      say: built.say,
      text: built.say,
      results: {
        say: built.say,
        text: built.say,
      },

      debugId,

      // Extra data the agent doesn't need, but useful for debugging
      data: {
        action,
        mode: "mock",
        studioKey,
        timezone: tz,
        source,
        datePhraseRaw,
        requestedDate: requestedYMD,
        todayInTZ,
        daysAhead,
        maxDaysAhead,
        schedule: {
          studioKey,
          timezone: tz,
          date: requestedYMD,
          spokenDate: built.spokenDate,
          classes: built.classes,
        },
      },
    };

    console.log(`[${debugId}] response success=true (say length=${payload.say.length})`);
    return respondOK(res, payload);
  }

  if (action === "get_pricing_offers") {
    const msg = "Pricing is currently in setup mode. Please hold one moment while I connect you with the front desk.";
    return respondOK(res, {
      success: true,
      say: msg,
      text: msg,
      results: { say: msg, text: msg },
      debugId,
      data: { action, mode: "mock", studioKey, timezone: tz, source },
    });
  }

  if (action === "book_class") {
    const msg = "Booking is still being finalized. I can connect you with the front desk to book you in right now—do you want me to connect you?";
    return respondOK(res, {
      success: true,
      say: msg,
      text: msg,
      results: { say: msg, text: msg },
      debugId,
      data: { action, mode: "mock", studioKey, timezone: tz, source, received: { query: q, body: b } },
    });
  }

  return respondFail(res, `Unknown action: ${action}`, { debugId, action });
});

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});





