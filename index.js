/**
 * Flow AI – Mindbody Webhook (Production Mode)
 * - POST /ghl/mindbody
 * - Supports actions:
 *    - ping
 *    - get_schedule
 *
 * Expects Railway env vars:
 *   MINDBODY_API_KEY
 *   MINDBODY_SITE_ID=5744527
 *   MINDBODY_BASE_URL=https://api.mindbodyonline.com/public/v6
 *   MINDBODY_USERNAME   (Oxygen staff login - required for live token)
 *   MINDBODY_PASSWORD   (Oxygen staff login - required for live token)
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

  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) {
    const daysAhead = Math.round(
      (Date.parse(phrase + "T00:00:00Z") - Date.parse(todayISO + "T00:00:00Z")) / 86400000
    );
    return { ok: true, requestedDate: phrase, todayISO, daysAhead };
  }

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
  const dt = new Date(dateISO + "T12:00:00Z"); // noon UTC avoids label drift
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

function respondJSON(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
}

// ---------------------------
// Mindbody v6 (Production)
// ---------------------------

function requireEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return String(v).trim();
}

function getMindbodyConfig() {
  const apiKey = requireEnv("MINDBODY_API_KEY");
  const siteId = requireEnv("MINDBODY_SITE_ID") || "5744527";
  const baseUrl = requireEnv("MINDBODY_BASE_URL") || "https://api.mindbodyonline.com/public/v6";
  const username = requireEnv("MINDBODY_USERNAME");
  const password = requireEnv("MINDBODY_PASSWORD");
  return { apiKey, siteId, baseUrl, username, password };
}

let TOKEN_CACHE = { accessToken: null, expiresAtMs: 0 };

async function getMindbodyAccessToken(cfg) {
  const now = Date.now();
  if (TOKEN_CACHE.accessToken && TOKEN_CACHE.expiresAtMs - 30_000 > now) {
    return TOKEN_CACHE.accessToken;
  }

  if (!cfg.username || !cfg.password) {
    throw new Error("Missing MINDBODY_USERNAME / MINDBODY_PASSWORD (Oxygen staff login required).");
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

  const accessToken = json?.AccessToken || json?.access_token || json?.token || json?.Token || null;
  const expiresIn = Number(json?.ExpiresIn || json?.expires_in || 0) || 0;

  if (!accessToken) {
    throw new Error(`Mindbody token response missing AccessToken. Raw: ${text.slice(0, 500)}`);
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
      c?.Name ||
      "Class";

    const startDateTime = c?.StartDateTime || c?.startDateTime || null;

    let time = "";
    if (startDateTime) {
      const dt = new Date(startDateTime);
      time = !Number.isNaN(dt.getTime())
        ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(dt)
        : String(startDateTime);
    }

    const instructor =
      c?.Staff?.Name ||
      c?.InstructorName ||
      "";

    const id =
      c?.Id ||
      c?.ClassId ||
      c?.ClassScheduleId ||
      c?.ClassInstanceId ||
      `class_${Math.random().toString(16).slice(2)}`;

    out.push({
      id,
      name,
      time: time || "Time TBD",
      instructor: instructor || "",
      bookable: true,
    });
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
  return normalizeMindbodyClasses(rawClasses);
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

    if (!cfg.apiKey || !cfg.siteId || !cfg.baseUrl) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error:
          "Mindbody Production not configured. Set: MINDBODY_API_KEY, MINDBODY_SITE_ID=5744527, MINDBODY_BASE_URL.",
        data: { action: "get_schedule", mode: "live_unconfigured", studioKey, timezone, source },
      });
    }

    try {
      const requestedDate = resolved.requestedDate;
      const spokenDate = buildSpokenDateLabel(requestedDate, timezone);

      const classes = await fetchMindbodyScheduleForDate(cfg, requestedDate);
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
          classes,
        },
      });
    } catch (err) {
      return respondJSON(res, {
        success: false,
        say: "",
        text: "",
        results: { say: "", text: "" },
        error: err?.message || "Mindbody live error",
        data: { action: "get_schedule", mode: "live_error", studioKey, timezone, source },
      });
    }
  }

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


