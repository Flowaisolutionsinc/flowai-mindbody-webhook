/**
 * Flow AI – Mindbody Webhook (Mock + Live Ready)
 * - POST /ghl/mindbody
 * - Actions:
 *    - ping
 *    - get_schedule
 *    - book_class
 *    - cancel_class
 *    - find_client
 *    - create_client
 *
 * Mode:
 *   MINDBODY_MODE=mock | live
 *
 * Mindbody env (works with your existing Railway vars):
 *   MINDBODY_API_KEY            (used as Mindbody "Api-Key" header)
 *   MINDBODY_BASE_URL           (default https://api.mindbodyonline.com/public/v6)
 *   MINDBODY_SITE_ID            (5744527)
 *   MINDBODY_USERNAME           (Oxygen staff / integration login)  <-- tomorrow
 *   MINDBODY_PASSWORD           (Oxygen staff / integration login)  <-- tomorrow
 *
 * Optional:
 *   GHL_SECRET                  (if set, require Authorization: Bearer <GHL_SECRET>)
 *   TZ                          (default timezone fallback)
 *   DAYS_AHEAD_MAX              (default 14)
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

function env(name, fallback = "") {
  const v = process.env[name];
  if (v === undefined || v === null) return fallback;
  return String(v).trim();
}

function nowISO() {
  return new Date().toISOString();
}

// ---------------------------
// Date handling
// ---------------------------

function getTodayISOInTZ(timeZone) {
  const tz = decodeMaybe(timeZone) || env("TZ", "America/Vancouver");
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

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function resolveDatePhraseToISO(datePhraseRaw, timeZone) {
  const tz = decodeMaybe(timeZone) || env("TZ", "America/Vancouver");
  const todayISO = getTodayISOInTZ(tz);

  const phrase = decodeMaybe(datePhraseRaw).trim().toLowerCase();
  if (!phrase) return { ok: false, reason: "missing date phrase" };

  if (phrase === "today") return { ok: true, requestedDate: todayISO, todayISO, daysAhead: 0 };
  if (phrase === "tomorrow") return { ok: true, requestedDate: addDaysISO(todayISO, 1), todayISO, daysAhead: 1 };

  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) {
    const daysAhead = Math.round(
      (Date.parse(phrase + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );
    return { ok: true, requestedDate: phrase, todayISO, daysAhead };
  }

  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const wdIndex = weekdays.indexOf(phrase);
  if (wdIndex !== -1) {
    const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" });
    const todayName = dtf.format(new Date()).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);
    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;
    const requestedDate = addDaysISO(todayISO, delta);
    return { ok: true, requestedDate, todayISO, daysAhead: delta };
  }

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
  const tz = decodeMaybe(timeZone) || env("TZ", "America/Vancouver");
  const dt = new Date(dateISO + "T12:00:00Z"); // avoids off-by-one weekday issues
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

// ---------------------------
// Mock builders
// ---------------------------

function buildMockSchedule(dateISO) {
  return [
    { id: `mock_${dateISO.replaceAll("-", "")}_1`, name: "Hot Yoga (Mock)", time: "6:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${dateISO.replaceAll("-", "")}_2`, name: "Hot Pilates (Mock)", time: "9:00 AM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${dateISO.replaceAll("-", "")}_3`, name: "Warm Yin (Mock)", time: "12:00 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${dateISO.replaceAll("-", "")}_4`, name: "Hot Yoga (Mock)", time: "5:30 PM", instructor: "Mock Instructor", bookable: true },
    { id: `mock_${dateISO.replaceAll("-", "")}_5`, name: "Hot Sculpt (Mock)", time: "7:00 PM", instructor: "Mock Instructor", bookable: true },
  ];
}

function buildScheduleSay(spokenDateLabel, classes) {
  if (!classes || classes.length === 0) {
    return `I couldn’t find any classes for ${spokenDateLabel}. Would you like a different date?`;
  }
  const parts = classes.map((c) => `${c.time} — ${c.name}`);
  return `Here are the classes for ${spokenDateLabel}: ${parts.join(", ")}. Which class would you like to book?`;
}

// ---------------------------
// Security: optional GHL secret
// ---------------------------

function verifyGhlSecret(req) {
  const expected = env("GHL_SECRET", "");
  if (!expected) return { ok: true }; // not enforced

  const auth = safeString(req.headers["authorization"]);
  const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (!token || token !== expected) return { ok: false, reason: "Unauthorized (bad GHL secret)" };
  return { ok: true };
}

// ---------------------------
// Mindbody (Live)
// ---------------------------

function getMindbodyConfig() {
  // Use your existing vars:
  const apiKey = env("MINDBODY_API_KEY", ""); // Mindbody "Api-Key" header
  const siteId = env("MINDBODY_SITE_ID", "5744527");
  const baseUrl = env("MINDBODY_BASE_URL", "https://api.mindbodyonline.com/public/v6");

  const username = env("MINDBODY_USERNAME", "");
  const password = env("MINDBODY_PASSWORD", "");

  return { apiKey, siteId, baseUrl, username, password };
}

let TOKEN_CACHE = { accessToken: null, expiresAtMs: 0 };

async function getMindbodyAccessToken(cfg) {
  const now = Date.now();
  if (TOKEN_CACHE.accessToken && TOKEN_CACHE.expiresAtMs - 30_000 > now) return TOKEN_CACHE.accessToken;

  if (!cfg.username || !cfg.password) {
    throw new Error("Missing MINDBODY_USERNAME / MINDBODY_PASSWORD (Oxygen staff login required).");
  }
  if (!cfg.apiKey) {
    throw new Error("Missing MINDBODY_API_KEY (Mindbody Api-Key header).");
  }
  if (!cfg.siteId) {
    throw new Error("Missing MINDBODY_SITE_ID.");
  }

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/usertoken/issue`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
    },
    body: JSON.stringify({ Username: cfg.username, Password: cfg.password }),
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody token error: ${msg}`);
  }

  const accessToken =
    json?.AccessToken || json?.access_token || json?.token || json?.Token || null;

  const expiresIn = Number(json?.ExpiresIn || json?.expires_in || 0) || 0;

  if (!accessToken) {
    throw new Error(`Mindbody token response missing AccessToken. Raw: ${text.slice(0, 300)}`);
  }

  TOKEN_CACHE.accessToken = accessToken;
  TOKEN_CACHE.expiresAtMs = Date.now() + (expiresIn ? expiresIn * 1000 : 20 * 60 * 1000);

  return accessToken;
}

function toMindbodyTimeWindow(dateISO) {
  return { start: `${dateISO}T00:00:00`, end: `${dateISO}T23:59:59` };
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
      time = !Number.isNaN(dt.getTime())
        ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(dt)
        : String(startDateTime);
    }

    const instructor = c?.Staff?.Name || c?.Staff?.FirstName || c?.InstructorName || "";

    const id = c?.Id || c?.ClassId || c?.ClassScheduleId || c?.ClassInstanceId || `class_${Math.random().toString(16).slice(2)}`;

    const bookable =
      typeof c?.IsAvailable === "boolean" ? c.IsAvailable :
      typeof c?.Bookable === "boolean" ? c.Bookable :
      true;

    out.push({ id, name, time: time || "Time TBD", instructor, bookable });
  }
  return out;
}

async function fetchMindbodyScheduleForDate(cfg, dateISO) {
  const token = await getMindbodyAccessToken(cfg);
  const { start, end } = toMindbodyTimeWindow(dateISO);

  const url = new URL(`${cfg.baseUrl.replace(/\/$/, "")}/class/classes`);
  url.searchParams.set("StartDateTime", start);
  url.searchParams.set("EndDateTime", end);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody schedule error: ${msg}`);
  }

  const rawClasses = json?.Classes || json?.classes || json?.Items || json?.items || json || [];
  return { raw: json, classes: normalizeMindbodyClasses(rawClasses) };
}

// Booking placeholders (safe now, we’ll finalize tomorrow after live payloads)
async function liveBookClass(_cfg, _payload) {
  throw new Error("Booking is staged but not enabled yet. Once we confirm live booking endpoints + required fields, we’ll turn this on.");
}

async function liveCancelClass(_cfg, _payload) {
  throw new Error("Cancel is staged but not enabled yet. Once we confirm live cancel endpoints + required fields, we’ll turn this on.");
}

async function liveFindClient(_cfg, _payload) {
  throw new Error("Client lookup is staged but not enabled yet. Once live, we’ll confirm the correct search method (email/phone) and enable.");
}

async function liveCreateClient(_cfg, _payload) {
  throw new Error("Client create is staged but not enabled yet. Once live, we’ll confirm required fields and enable.");
}

// ---------------------------
// Route
// ---------------------------

app.post("/ghl/mindbody", async (req, res) => {
  const sec = verifyGhlSecret(req);
  if (!sec.ok) {
    return respondJSON(res, {
      success: false,
      say: "",
      text: "",
      results: { say: "", text: "" },
      error: sec.reason,
      data: { ts: nowISO() },
    });
  }

  const q = req.query || {};
  const b = req.body || {};

  const action = decodeMaybe(q.action ?? b.action).trim() || "ping";
  const studioKey = decodeMaybe(q.studioKey ?? b.studioKey).trim() || "oxygen_roundhouse";
  const timezone = decodeMaybe(q.timezone ?? b.timezone).trim() || env("TZ", "America/Vancouver");
  const source = decodeMaybe(q.source ?? b.source).trim() || "agencyvault";

  const mode = (env("MINDBODY_MODE", "mock") || "mock").toLowerCase();

  const dateParamRaw = q.date ?? b.date ?? q.dateParam ?? b.dateParam ?? q.datePhrase ?? b.datePhrase;
  const datePhraseRaw = decodeMaybe(dateParamRaw).trim();

  // booking/client params (optional)
  const classId = decodeMaybe(q.classId ?? b.classId).trim();
  const clientId = decodeMaybe(q.clientId ?? b.clientId).trim();
  const email = decodeMaybe(q.email ?? b.email).trim();
  const phone = decodeMaybe(q.phone ?? b.phone).trim();
  const firstName = decodeMaybe(q.firstName ?? b.firstName).trim();
  const lastName = decodeMaybe(q.lastName ?? b.lastName).trim();
  const cancelReason = decodeMaybe(q.cancelReason ?? b.cancelReason).trim();

  console.log("--------------------------------------------------");
  console.log("POST /ghl/mindbody", { mode });
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
      data: { action, mode, studioKey, timezone, source, ts: nowISO() },
    });
  }

  // ---------------------------
  // Schedule
  // ---------------------------
  if (action === "get_schedule" || action === "get_schedule_web" || action === "get_schedule_by_date") {
    const resolved = resolveDatePhraseToISO(datePhraseRaw || "today", timezone);

    if (!resolved.ok) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: `Could not parse date: ${resolved.reason}`,
        data: { action, mode, studioKey, timezone, source, datePhraseRaw, ts: nowISO() },
      });
    }

    const requestedDate = resolved.requestedDate;
    const spokenDate = buildSpokenDateLabel(requestedDate, timezone);

    // mock guard
    const maxDaysAhead = Number(env("DAYS_AHEAD_MAX", "14")) || 14;
    if (mode !== "live" && resolved.daysAhead > maxDaysAhead) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: `Date is too far ahead for mock mode (max ${maxDaysAhead} days).`,
        data: { action, mode, studioKey, timezone, source, requestedDate, daysAhead: resolved.daysAhead, maxDaysAhead, ts: nowISO() },
      });
    }

    if (mode !== "live") {
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
          spokenDate,
          schedule: { classes },
          ts: nowISO(),
        },
      });
    }

    // live
    try {
      const cfg = getMindbodyConfig();
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
          spokenDate,
          schedule: { classes },
          ts: nowISO(),
        },
      });
    } catch (err) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Mindbody live error",
        data: { action: "get_schedule", mode: "live_error", studioKey, timezone, source, datePhraseRaw, ts: nowISO() },
      });
    }
  }

  // ---------------------------
  // Booking (mock now, live staged)
  // ---------------------------

  if (action === "book_class") {
    if (mode !== "live") {
      const say = `You’re booked (mock)! I can also text you a confirmation link if needed.`;
      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "book_class",
          mode: "mock",
          studioKey,
          timezone,
          source,
          classId: classId || "mock_class",
          client: { clientId, email, phone, firstName, lastName },
          confirmationId: `mock_confirm_${Date.now()}`,
          ts: nowISO(),
        },
      });
    }

    try {
      const cfg = getMindbodyConfig();
      await liveBookClass(cfg, { classId, clientId, email, phone, firstName, lastName });
      // (Tomorrow we’ll replace liveBookClass with real calls and a real confirmation message.)
      const say = `Your booking request was received.`;
      return respondJSON(res, { success: true, say, text: say, results: { say, text: say }, data: { action: "book_class", mode: "live", ts: nowISO() } });
    } catch (err) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Booking error",
        data: { action: "book_class", mode: "live_error", studioKey, ts: nowISO() },
      });
    }
  }

  if (action === "cancel_class") {
    if (mode !== "live") {
      const say = `Cancelled (mock). Anything else I can help with?`;
      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "cancel_class",
          mode: "mock",
          studioKey,
          timezone,
          source,
          classId: classId || "mock_class",
          cancelReason,
          ts: nowISO(),
        },
      });
    }

    try {
      const cfg = getMindbodyConfig();
      await liveCancelClass(cfg, { classId, clientId, email, phone, cancelReason });
      const say = `Your class has been cancelled.`;
      return respondJSON(res, { success: true, say, text: say, results: { say, text: say }, data: { action: "cancel_class", mode: "live", ts: nowISO() } });
    } catch (err) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Cancel error",
        data: { action: "cancel_class", mode: "live_error", studioKey, ts: nowISO() },
      });
    }
  }

  // ---------------------------
  // Client lookup / create (mock now, live staged)
  // ---------------------------

  if (action === "find_client") {
    if (mode !== "live") {
      const found = Boolean(email || phone);
      const say = found ? `Found your profile (mock).` : `What email or phone number is your account under?`;
      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "find_client",
          mode: "mock",
          studioKey,
          input: { email, phone },
          found,
          clientId: found ? `mock_client_${(email || phone).replace(/[^a-z0-9]/gi, "").slice(0, 12)}` : "",
          ts: nowISO(),
        },
      });
    }

    try {
      const cfg = getMindbodyConfig();
      await liveFindClient(cfg, { email, phone });
      const say = `Found your profile.`;
      return respondJSON(res, { success: true, say, text: say, results: { say, text: say }, data: { action: "find_client", mode: "live", ts: nowISO() } });
    } catch (err) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Find client error",
        data: { action: "find_client", mode: "live_error", studioKey, ts: nowISO() },
      });
    }
  }

  if (action === "create_client") {
    if (mode !== "live") {
      const ok = Boolean(firstName && lastName && (email || phone));
      const say = ok ? `Perfect — I’ve created your profile (mock).` : `To create your profile, I just need your first name, last name, and either email or phone.`;
      return respondJSON(res, {
        success: true,
        say,
        text: say,
        results: { say, text: say },
        data: {
          action: "create_client",
          mode: "mock",
          studioKey,
          input: { firstName, lastName, email, phone },
          created: ok,
          clientId: ok ? `mock_client_${Date.now()}` : "",
          ts: nowISO(),
        },
      });
    }

    try {
      const cfg = getMindbodyConfig();
      await liveCreateClient(cfg, { firstName, lastName, email, phone });
      const say = `Your profile has been created.`;
      return respondJSON(res, { success: true, say, text: say, results: { say, text: say }, data: { action: "create_client", mode: "live", ts: nowISO() } });
    } catch (err) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Create client error",
        data: { action: "create_client", mode: "live_error", studioKey, ts: nowISO() },
      });
    }
  }

  // Unknown action
  return respondJSON(res, {
    success: false,
    say: "",
    text: "",
    results: { say: "", text: "" },
    error: `Unknown action: ${action}`,
    data: { action, mode, studioKey, timezone, source, ts: nowISO() },
  });
});

app.get("/", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
