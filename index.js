/**
 * Flow AI – Mindbody Webhook (Mock + Live)
 * - POST /ghl/mindbody
 *
 * Actions:
 *   - ping
 *   - get_schedule
 *   - book_class
 *   - (stubbed) cancel_class
 *
 * ENV expected (Railway):
 *   MINDBODY_MODE=mock|live
 *   MINDBODY_API_KEY               (Mindbody "Api-Key" header)
 *   MINDBODY_SITE_ID               (e.g. 5744527 for Roundhouse)
 *   MINDBODY_BASE_URL              (default: https://api.mindbodyonline.com/public/v6)
 *
 * Optional (future multi-studio):
 *   STUDIO_CONFIG_JSON             (map studioKey -> siteId, timezone, etc)
 *
 * Returns voice-agent-friendly payload:
 *  { success, say, text, results:{say,text}, data:{...} }
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
  const s = safeString(v);
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s.replace(/\+/g, " ");
  }
}

function respondJSON(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
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

// Parse date phrases to ISO date
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
    const daysAhead = Math.round(
      (Date.parse(phrase + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );
    return { ok: true, requestedDate: phrase, todayISO, daysAhead };
  }

  // Weekday handling
  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const wdIndex = weekdays.indexOf(phrase);
  if (wdIndex !== -1) {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
    const todayName = dtf.format(now).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);

    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;
    const requestedDate = addDaysISO(todayISO, delta);
    return { ok: true, requestedDate, todayISO, daysAhead: delta };
  }

  // Natural date parsing
  const cleaned = phrase.replace(/(\d+)(st|nd|rd|th)/g, "$1");
  const parsed = Date.parse(cleaned);
  if (!Number.isNaN(parsed)) {
    const dt = new Date(parsed);
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

function buildSpokenDateLabel(dateISO, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const dt = new Date(dateISO + "T12:00:00Z"); // avoids label shift bugs
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

function buildScheduleSay(spokenDateLabel, classes) {
  if (!classes || classes.length === 0) {
    return `I couldn’t find any classes for ${spokenDateLabel}. Would you like a different date?`;
  }
  const parts = classes.map((c) => `${c.time} — ${c.name}`);
  return `Here are the classes for ${spokenDateLabel}: ${parts.join(", ")}. Which class would you like to book?`;
}

// ---------------------------
// MOCK schedule
// ---------------------------
function buildMockSchedule(requestedDate) {
  return [
    { id: `mock_${requestedDate.replaceAll("-", "")}_1`, name: "Hot Yoga (Mock)", time: "6:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_2`, name: "Hot Pilates (Mock)", time: "9:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_3`, name: "Warm Yin (Mock)", time: "12:00 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_4`, name: "Hot Yoga (Mock)", time: "5:30 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${requestedDate.replaceAll("-", "")}_5`, name: "Hot Sculpt (Mock)", time: "7:00 PM", instructor: "Mock Instructor", bookable: true },
  ];
}

// ---------------------------
// Mindbody LIVE
// ---------------------------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return String(v).trim();
}

function getMindbodyConfig() {
  const mode = (requireEnv("MINDBODY_MODE") || "mock").toLowerCase();
  const apiKey = requireEnv("MINDBODY_API_KEY"); // your Railway MINDBODY_API_KEY
  const siteId = requireEnv("MINDBODY_SITE_ID"); // per-location site id
  const baseUrl = requireEnv("MINDBODY_BASE_URL") || "https://api.mindbodyonline.com/public/v6";
  return { mode, apiKey, siteId, baseUrl };
}

function toMindbodyTimeWindow(dateISO) {
  return {
    start: `${dateISO}T00:00:00`,
    end: `${dateISO}T23:59:59`,
  };
}

function normalizeMindbodyClasses(rawClasses) {
  const out = [];
  for (const c of rawClasses || []) {
    const name =
      c?.ClassDescription?.Name ||
      c?.ClassDescription?.Description ||
      c?.Name ||
      c?.Description ||
      "Class";

    const startDateTime =
      c?.StartDateTime ||
      c?.startDateTime ||
      c?.StartTime ||
      c?.startTime ||
      null;

    let time = "";
    if (startDateTime) {
      const dt = new Date(startDateTime);
      if (!Number.isNaN(dt.getTime())) {
        time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(dt);
      } else {
        time = String(startDateTime);
      }
    }

    const instructor = c?.Staff?.Name || c?.Staff?.FirstName || c?.InstructorName || "";
    const id =
      c?.Id ||
      c?.ClassId ||
      c?.ClassScheduleId ||
      c?.ClassInstanceId ||
      `class_${Math.random().toString(16).slice(2)}`;

    const bookable =
      typeof c?.IsAvailable === "boolean" ? c.IsAvailable :
      typeof c?.Bookable === "boolean" ? c.Bookable :
      true;

    out.push({ id: String(id), name, time: time || "Time TBD", instructor: instructor || "", bookable });
  }
  return out;
}

async function fetchJsonOrText(resp) {
  const text = await resp.text();
  try {
    return { ok: resp.ok, status: resp.status, json: JSON.parse(text), text };
  } catch {
    return { ok: resp.ok, status: resp.status, json: null, text };
  }
}

async function fetchMindbodyScheduleForDate(cfg, dateISO) {
  const { start, end } = toMindbodyTimeWindow(dateISO);

  const url = new URL(`${cfg.baseUrl.replace(/\/$/, "")}/class/classes`);
  url.searchParams.set("StartDateTime", start);
  url.searchParams.set("EndDateTime", end);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
  });

  const parsed = await fetchJsonOrText(resp);
  if (!parsed.ok) {
    const msg = parsed?.json?.Error?.Message || parsed?.json?.Message || parsed.text || `HTTP ${parsed.status}`;
    throw new Error(`Mindbody schedule error (${parsed.status}): ${msg}`);
  }

  const raw =
    parsed.json?.Classes ||
    parsed.json?.classes ||
    parsed.json?.Items ||
    parsed.json?.items ||
    parsed.json ||
    [];

  return { raw: parsed.json, classes: normalizeMindbodyClasses(raw) };
}

// Client add (creates if new; if duplicate, Mindbody may error — we handle by surfacing cleanly)
async function addClient(cfg, { firstName, lastName, email, phone }) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/client/addclient`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      FirstName: firstName,
      LastName: lastName,
      Email: email,
      MobilePhone: phone || "",
    }),
  });

  const parsed = await fetchJsonOrText(resp);
  if (!parsed.ok) {
    const msg = parsed?.json?.Error?.Message || parsed?.json?.Message || parsed.text || `HTTP ${parsed.status}`;
    throw new Error(`Mindbody addclient error (${parsed.status}): ${msg}`);
  }

  const clientId = parsed?.json?.Clients?.[0]?.Id || parsed?.json?.Client?.Id || null;
  if (!clientId) {
    throw new Error(`Mindbody addclient response missing client id.`);
  }

  return { clientId, raw: parsed.json };
}

async function addClientToClass(cfg, { clientId, classId }) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/class/addclienttoclass`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ClientId: Number(clientId),
      ClassId: Number(classId),
    }),
  });

  const parsed = await fetchJsonOrText(resp);
  if (!parsed.ok) {
    const msg = parsed?.json?.Error?.Message || parsed?.json?.Message || parsed.text || `HTTP ${parsed.status}`;
    throw new Error(`Mindbody booking error (${parsed.status}): ${msg}`);
  }

  return { raw: parsed.json };
}

// ---------------------------
// Route
// ---------------------------
app.post("/ghl/mindbody", async (req, res) => {
  const q = req.query || {};
  const b = req.body || {};

  const action = decodeMaybe(q.action ?? b.action).trim() || "ping";
  const studioKey = decodeMaybe(q.studioKey ?? b.studioKey).trim() || "oxygen_roundhouse";
  const timezone = decodeMaybe(q.timezone ?? b.timezone).trim() || "America/Vancouver";
  const source = decodeMaybe(q.source ?? b.source).trim() || "agencyvault";
  const dateParamRaw = q.date ?? b.date ?? q.dateParam ?? b.dateParam ?? q.datePhrase ?? b.datePhrase;
  const datePhraseRaw = decodeMaybe(dateParamRaw).trim();

  console.log("--------------------------------------------------");
  console.log("POST /ghl/mindbody");
  console.log("action:", action);
  console.log("query:", q);
  console.log("body:", b);

  // PING
  if (action === "ping") {
    return respondJSON(res, {
      success: true,
      say: "pong",
      text: "pong",
      results: { say: "pong", text: "pong" },
      data: { action, studioKey, timezone, source },
    });
  }

  // GET SCHEDULE
  if (action === "get_schedule" || action === "get_schedule_web" || action === "get_schedule_by_date") {
    const resolved = resolveDatePhraseToISO(datePhraseRaw || "today", timezone);
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

    const cfg = getMindbodyConfig();

    // MOCK mode
    if (cfg.mode !== "live") {
      const requestedDate = resolved.requestedDate;
      const spokenDate = buildSpokenDateLabel(requestedDate, timezone);
      const classes = buildMockSchedule(requestedDate);
      const say = buildScheduleSay(spokenDate, classes);

      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "get_schedule",
          mode: "mock",
          studioKey,
          timezone,
          source,
          requestedDate,
          schedule: { studioKey, timezone, date: requestedDate, spokenDate, classes },
        },
      });
    }

    // LIVE mode
    if (!cfg.apiKey || !cfg.siteId || !cfg.baseUrl) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: "Mindbody LIVE not configured. Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
        data: { action: "get_schedule", mode: "live_unconfigured", studioKey, timezone, source },
      });
    }

    try {
      const requestedDate = resolved.requestedDate;
      const spokenDate = buildSpokenDateLabel(requestedDate, timezone);

      const schedule = await fetchMindbodyScheduleForDate(cfg, requestedDate);
      const classes = schedule.classes;

      const say = buildScheduleSay(spokenDate, classes);

      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "get_schedule",
          mode: "live",
          studioKey,
          timezone,
          source,
          requestedDate,
          schedule: { studioKey, timezone, date: requestedDate, spokenDate, classes },
        },
      });
    } catch (err) {
      console.log("Mindbody live error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Mindbody live error",
        data: { action: "get_schedule", mode: "live_error", studioKey, timezone, source, datePhraseRaw },
      });
    }
  }

  // BOOK CLASS (LIVE)
  if (action === "book_class") {
    const cfg = getMindbodyConfig();

    if (cfg.mode !== "live") {
      return respondJSON(res, {
        success: false,
        say: "Booking is not available in mock mode.",
        text: "Booking is not available in mock mode.",
        results: { say: "Booking is not available in mock mode.", text: "Booking is not available in mock mode." },
        data: { action, mode: cfg.mode },
      });
    }

    if (!cfg.apiKey || !cfg.siteId || !cfg.baseUrl) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: "Mindbody LIVE not configured. Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
        data: { action: "book_class", mode: "live_unconfigured" },
      });
    }

    // Inputs (from custom action variables)
    const classId = decodeMaybe(q.classId ?? b.classId).trim();
    const firstName = decodeMaybe(q.firstName ?? b.firstName).trim();
    const lastName = decodeMaybe(q.lastName ?? b.lastName).trim();
    const email = decodeMaybe(q.email ?? b.email).trim();
    const phone = decodeMaybe(q.phone ?? b.phone).trim();

    // Required for clean booking
    if (!classId || !firstName || !lastName || !email) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: "Missing required booking fields (classId, firstName, lastName, email).",
        data: { classId, firstName, lastName, email, phone },
      });
    }

    try {
      // 1) Add client (new client path). If Mindbody rejects duplicates, we will surface the error cleanly.
      const client = await addClient(cfg, { firstName, lastName, email, phone });

      // 2) Add client to class
      const booking = await addClientToClass(cfg, { clientId: client.clientId, classId });

      const say = `You're booked! I've reserved your spot. You'll receive a confirmation email shortly.`;

      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "book_class",
          mode: "live",
          studioKey,
          timezone,
          source,
          classId,
          clientId: client.clientId,
          clientRaw: client.raw,
          bookingRaw: booking.raw,
        },
      });
    } catch (err) {
      console.log("Mindbody booking error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Booking failed.",
        data: { action: "book_class", mode: "live_error", studioKey, timezone, source, classId, email },
      });
    }
  }

  // CANCEL CLASS (stub for now)
  if (action === "cancel_class") {
    return respondJSON(res, {
      success: false,
      say: "Cancel is not enabled yet.",
      text: "Cancel is not enabled yet.",
      results: { say: "Cancel is not enabled yet.", text: "Cancel is not enabled yet." },
      data: { action, studioKey, timezone, source },
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
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
