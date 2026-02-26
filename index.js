/**
 * Flow AI – Mindbody Webhook (Mock + Live)
 * - POST /ghl/mindbody
 *
 * Actions:
 *   - ping
 *   - get_schedule | get_schedule_web | get_schedule_by_date
 *   - book_class
 *   - cancel_class
 *
 * ENV expected (Railway):
 *   MINDBODY_MODE=mock|live   (defaults to live)
 *   MINDBODY_API_KEY
 *   MINDBODY_SITE_ID
 *   MINDBODY_BASE_URL (default: https://api.mindbodyonline.com/public/v6)
 *
 * Optional (booking/cancel often requires token):
 *   MINDBODY_TOKEN_USERNAME
 *   MINDBODY_TOKEN_PASSWORD
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

function normalizeTimeOfDay(v) {
  const s = decodeMaybe(v).trim().toLowerCase();
  if (!s) return null;
  if (s === "all") return null;
  if (["morning", "afternoon", "evening"].includes(s)) return s;
  return null;
}

/**
 * ✅ IMPORTANT:
 * Some platforms do NOT read `say` automatically.
 * This returns the same spoken text under multiple common keys.
 *
 * ✅ NEW:
 * Also sets `body` and `result` because some platforms surface tool output there.
 * Also sets `ok` because some platforms expect that convention.
 */
function respondJSON(res, payload) {
  const say = safeString(payload?.say);
  const text = safeString(payload?.text);
  const err = safeString(payload?.error);

  const spoken = say || text || err || "";

  const isSuccess = payload?.success === true;

  const finalPayload = {
    ...payload,

    // canonical fields
    success: isSuccess,
    ok: isSuccess,

    // your original fields (force spoken string)
    say: spoken,
    text: spoken,

    // common aliases other tools look for
    response: spoken,
    message: spoken,
    output: spoken,
    speech: spoken,

    // ✅ critical: some platforms surface output here
    body: spoken,
    result: spoken,

    // nested convention
    results: payload?.results || { say: spoken, text: spoken },

    data:
      payload?.data || payload?.data === 0
        ? payload.data
        : payload?.data,
  };

  console.log("RESPONDING:", finalPayload.success, finalPayload.response);

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(200).json(finalPayload);
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return String(v).trim();
}

function getMindbodyConfig() {
  const mode = (requireEnv("MINDBODY_MODE") || "live").toLowerCase();

  const apiKey = requireEnv("MINDBODY_API_KEY");
  const siteId = requireEnv("MINDBODY_SITE_ID");
  const baseUrl =
    requireEnv("MINDBODY_BASE_URL") ||
    "https://api.mindbodyonline.com/public/v6";

  const tokenUsername = requireEnv("MINDBODY_TOKEN_USERNAME");
  const tokenPassword = requireEnv("MINDBODY_TOKEN_PASSWORD");

  return { mode, apiKey, siteId, baseUrl, tokenUsername, tokenPassword };
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

function compareISO(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Parse date phrases to ISO date + optional timeOfDay extracted from phrase
function resolveDatePhraseToISO(datePhraseRaw, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const todayISO = getTodayISOInTZ(tz);

  const phraseRaw = decodeMaybe(datePhraseRaw).trim().toLowerCase();
  if (!phraseRaw) return { ok: false, reason: "missing date phrase" };

  // Backup: extract time-of-day words if someone still sends "tomorrow afternoon"
  let extractedTimeOfDay = null; // morning|afternoon|evening
  let phrase = phraseRaw;

  if (/\bmorning\b|\bearly\b/.test(phrase)) extractedTimeOfDay = "morning";
  if (/\bafternoon\b/.test(phrase)) extractedTimeOfDay = "afternoon";
  if (/\bevening\b|\btonight\b/.test(phrase)) extractedTimeOfDay = "evening";

  phrase = phrase
    .replace(/\b(morning|early|afternoon|evening|tonight)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (phrase === "today") {
    return {
      ok: true,
      requestedDate: todayISO,
      todayISO,
      daysAhead: 0,
      extractedTimeOfDay,
    };
  }
  if (phrase === "tomorrow") {
    return {
      ok: true,
      requestedDate: addDaysISO(todayISO, 1),
      todayISO,
      daysAhead: 1,
      extractedTimeOfDay,
    };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(phrase)) {
    const daysAhead = Math.round(
      (Date.parse(phrase + "T00:00:00Z") -
        Date.parse(todayISO + "T00:00:00Z")) /
        86400000
    );
    return { ok: true, requestedDate: phrase, todayISO, daysAhead, extractedTimeOfDay };
  }

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  const mThisNext = phrase.match(
    /^(this|next)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/
  );
  if (mThisNext) {
    const which = mThisNext[1];
    const wdName = mThisNext[2];
    const wdIndex = weekdays.indexOf(wdName);

    const now = new Date();
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    });
    const todayName = dtf.format(now).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);

    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;
    if (which === "next") delta += 7;

    const requestedDate = addDaysISO(todayISO, delta);
    return { ok: true, requestedDate, todayISO, daysAhead: delta, extractedTimeOfDay };
  }

  const wdIndex = weekdays.indexOf(phrase);
  if (wdIndex !== -1) {
    const now = new Date();
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    });
    const todayName = dtf.format(now).toLowerCase();
    const todayIdx = weekdays.indexOf(todayName);

    let delta = (wdIndex - todayIdx + 7) % 7;
    if (delta === 0) delta = 7;

    const requestedDate = addDaysISO(todayISO, delta);
    return { ok: true, requestedDate, todayISO, daysAhead: delta, extractedTimeOfDay };
  }

  const dayOnly = phrase
    .replace(/^on\s+the\s+/, "")
    .replace(/(\d+)(st|nd|rd|th)$/g, "$1");
  if (/^\d{1,2}$/.test(dayOnly)) {
    const dayNum = parseInt(dayOnly, 10);
    const [y, m] = todayISO.split("-").map((x) => parseInt(x, 10));

    const candidateThisMonth = `${y}-${String(m).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    let requestedDate = candidateThisMonth;

    if (compareISO(requestedDate, todayISO) < 0) {
      const nextMonthDate = addDaysISO(`${y}-${String(m).padStart(2, "0")}-01`, 32);
      const [ny, nm] = nextMonthDate.split("-").map((x) => parseInt(x, 10));
      requestedDate = `${ny}-${String(nm).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    }

    const daysAhead = Math.round(
      (Date.parse(requestedDate + "T00:00:00Z") -
        Date.parse(todayISO + "T00:00:00Z")) /
        86400000
    );
    return { ok: true, requestedDate, todayISO, daysAhead, extractedTimeOfDay };
  }

  const cleaned = phrase.replace(/(\d+)(st|nd|rd|th)/g, "$1");
  const monthNames = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const monthShort = monthNames.map((x) => x.slice(0, 3));

  const md = cleaned.match(/^([a-z]+)\s+(\d{1,2})$/);
  if (md) {
    const monRaw = md[1];
    const dayNum = parseInt(md[2], 10);
    let monIdx = monthNames.indexOf(monRaw);
    if (monIdx === -1) monIdx = monthShort.indexOf(monRaw.slice(0, 3));
    if (monIdx !== -1) {
      const [y] = todayISO.split("-").map((x) => parseInt(x, 10));
      let requestedDate = `${y}-${String(monIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      if (compareISO(requestedDate, todayISO) < 0) {
        requestedDate = `${y + 1}-${String(monIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      }
      const daysAhead = Math.round(
        (Date.parse(requestedDate + "T00:00:00Z") -
          Date.parse(todayISO + "T00:00:00Z")) /
          86400000
      );
      return { ok: true, requestedDate, todayISO, daysAhead, extractedTimeOfDay };
    }
  }

  // "February 22, 2026" / "Feb 22, 2026" / "February 22nd, 2026"
  const cleaned2 = phrase
    .replace(/(\d+)(st|nd|rd|th)/g, "$1")
    .replace(/,/g, "")
    .trim();

  const mdy = cleaned2.match(/^([a-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (mdy) {
    const monRaw = mdy[1];
    const dayNum = parseInt(mdy[2], 10);
    const yearNum = parseInt(mdy[3], 10);

    let monIdx = monthNames.indexOf(monRaw);
    if (monIdx === -1) monIdx = monthShort.indexOf(monRaw.slice(0, 3));

    if (monIdx !== -1) {
      const requestedDate = `${yearNum}-${String(monIdx + 1).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
      const daysAhead = Math.round(
        (Date.parse(requestedDate + "T00:00:00Z") -
          Date.parse(todayISO + "T00:00:00Z")) /
          86400000
      );
      return { ok: true, requestedDate, todayISO, daysAhead, extractedTimeOfDay };
    }
  }

  return { ok: false, reason: `unrecognized date phrase: "${datePhraseRaw}"` };
}

function buildSpokenDateLabel(dateISO, timeZone) {
  const tz = decodeMaybe(timeZone) || "America/Vancouver";
  const dt = new Date(dateISO + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

/**
 * ✅ FIXED:
 * - NO "Which class would you like to book?" in the webhook message.
 *   Your prompt handles follow-up.
 */
function buildScheduleSay(spokenDateLabel, classes) {
  const safeClasses = Array.isArray(classes) ? classes : [];

  const lines = [];
  lines.push(`Here are the classes for ${spokenDateLabel}.`);

  for (const c of safeClasses) {
    const time = c?.time || "Time TBD";
    const name = c?.name || "Class";
    const instructor = c?.instructor ? ` with ${c.instructor}` : "";
    lines.push(`${time} — ${name}${instructor}.`);
  }

  return lines.join("\n");
}

// ---------------------------
// MOCK schedule (only used if MINDBODY_MODE=mock)
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
// Mindbody LIVE helpers
// ---------------------------
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
      if (!Number.isNaN(dt.getTime())) {
        time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(dt);
      } else {
        time = String(startDateTime);
      }
    }

    const instructor = c?.Staff?.Name || c?.Staff?.FirstName || c?.InstructorName || "";
    const id = c?.Id || c?.ClassId || c?.ClassScheduleId || c?.ClassInstanceId || `class_${Math.random().toString(16).slice(2)}`;

    const bookable =
      typeof c?.IsAvailable === "boolean" ? c.IsAvailable :
      typeof c?.Bookable === "boolean" ? c.Bookable :
      true;

    out.push({ id: String(id), name, time: time || "Time TBD", instructor: instructor || "", bookable });
  }
  return out;
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

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody schedule error (${resp.status}): ${msg}`);
  }

  const rawClasses = json?.Classes || json?.classes || json?.Items || json?.items || json || [];
  return { raw: json, classes: normalizeMindbodyClasses(rawClasses) };
}

// ---------------------------
// Time-of-day filtering (morning/afternoon/evening)
// ---------------------------
function timeStringToMinutes(t) {
  const s = String(t || "");
  const m = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = m[3].toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function filterClassesByTimeOfDay(classes, timeOfDay) {
  if (!timeOfDay) return classes;

  return (classes || []).filter((c) => {
    const mins = timeStringToMinutes(c?.time);
    if (mins === null) return false;

    if (timeOfDay === "morning") return mins < 12 * 60;
    if (timeOfDay === "afternoon") return mins >= 12 * 60 && mins < 17 * 60;
    if (timeOfDay === "evening") return mins >= 17 * 60;
    return true;
  });
}

/**
 * ✅ Sort classes by time (earliest -> latest)
 */
function sortClassesByStartTime(classes) {
  const arr = Array.isArray(classes) ? classes : [];
  arr.sort((a, b) => {
    const am = timeStringToMinutes(a?.time);
    const bm = timeStringToMinutes(b?.time);
    const aa = am === null ? 99999 : am;
    const bb = bm === null ? 99999 : bm;
    return aa - bb;
  });
  return arr;
}

// ---------------------------
// Token + booking/cancel
// ---------------------------
let tokenCache = { value: null, expiresAt: 0 };

async function getMindbodyUserToken(cfg) {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 5 * 60 * 1000) return tokenCache.value;

  if (!cfg.tokenUsername || !cfg.tokenPassword) return null;

  const url = `${cfg.baseUrl.replace(/\/$/, "")}/usertoken/issue`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Username: cfg.tokenUsername, Password: cfg.tokenPassword }),
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody token error (${resp.status}): ${msg}`);
  }

  const accessToken = json?.AccessToken || json?.access_token || json?.Token || json?.token;
  const expiresIn = Number(json?.ExpiresIn || json?.expires_in || 3600);
  if (!accessToken) throw new Error("Mindbody token error: missing AccessToken in response");

  tokenCache.value = accessToken;
  tokenCache.expiresAt = Date.now() + expiresIn * 1000;
  return accessToken;
}

async function mbGet(cfg, path, token, paramsObj = {}) {
  const url = new URL(`${cfg.baseUrl.replace(/\/$/, "")}${path}`);
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") url.searchParams.set(k, String(v));
  }

  const headers = {
    "Api-Key": cfg.apiKey,
    "SiteId": cfg.siteId,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url.toString(), { method: "GET", headers });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody GET ${path} error (${resp.status}): ${msg}`);
  }
  return json;
}

async function mbPost(cfg, path, token, bodyObj = {}) {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;

  const headers = {
    "Api-Key": cfg.apiKey,
    "SiteId": cfg.siteId,
    "Content-Type": "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(bodyObj),
  });

  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!resp.ok) {
    const msg = json?.Error?.Message || json?.Message || text || `HTTP ${resp.status}`;
    throw new Error(`Mindbody POST ${path} error (${resp.status}): ${msg}`);
  }
  return json;
}

function normalizePhone(phoneRaw) {
  const p = decodeMaybe(phoneRaw).trim();
  if (!p) return "";
  return p.replace(/[^\d+]/g, "");
}

async function findClientId(cfg, token, email, phone) {
  const searchText = email || phone || "";
  if (!searchText) return null;

  const json = await mbGet(cfg, "/client/clients", token, { SearchText: searchText, Limit: 10, Offset: 0 });
  const clients = json?.Clients || json?.clients || [];
  if (!Array.isArray(clients) || clients.length === 0) return null;

  if (email) {
    const exact = clients.find((c) => (c?.Email || c?.email || "").toLowerCase() === email.toLowerCase());
    if (exact?.Id) return String(exact.Id);
  }

  const first = clients[0];
  if (first?.Id) return String(first.Id);
  return null;
}

async function createClient(cfg, token, firstName, lastName, email, phone) {
  const payload = { FirstName: firstName, LastName: lastName };
  if (email) payload.Email = email;
  if (phone) payload.MobilePhone = phone;

  const json = await mbPost(cfg, "/client/addclient", token, payload);
  const client = json?.Client || json?.client || json;
  const id = client?.Id || client?.ClientId || client?.id;
  if (!id) throw new Error("Client created but no client ID returned.");
  return String(id);
}

async function bookClientIntoClass(cfg, token, classId, clientId) {
  const payload = { ClientId: clientId, ClassId: Number(classId) };
  return await mbPost(cfg, "/class/addclienttoclass", token, payload);
}

async function cancelClientFromClass(cfg, token, classId, clientId) {
  const payload = { ClientId: clientId, ClassId: Number(classId) };
  return await mbPost(cfg, "/class/removeclientfromclass", token, payload);
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

  const timeOfDayParam = normalizeTimeOfDay(q.timeOfDay ?? b.timeOfDay);

  const dateParamRaw =
    q.date ?? b.date ??
    q.datePhrase ?? b.datePhrase ??
    q.dateParam ?? b.dateParam;

  const datePhraseRaw = decodeMaybe(dateParamRaw).trim();

  const classId = decodeMaybe(q.classId ?? b.classId).trim();

  const firstName = decodeMaybe(
    q.firstName ?? b.firstName ??
    q.client_first_name ?? b.client_first_name
  ).trim();

  const lastName = decodeMaybe(
    q.lastName ?? b.lastName ??
    q.client_last_name ?? b.client_last_name
  ).trim();

  const email = decodeMaybe(q.email ?? b.email).trim();
  const phone = normalizePhone(q.phone ?? b.phone ?? q.mobilephone ?? b.mobilephone);

  const isNewClientRaw = decodeMaybe(
    q.isNewClient ?? b.isNewClient ??
    q.is_new_client ?? b.is_new_client
  ).trim().toLowerCase();

  console.log("--------------------------------------------------");
  console.log("POST /ghl/mindbody");
  console.log("action:", action);
  console.log("query:", q);
  console.log("body:", b);

  if (action === "ping") {
    return respondJSON(res, {
      success: true,
      say: "pong",
      text: "pong",
      data: { action, studioKey, timezone, source },
    });
  }

  const cfg = getMindbodyConfig();
  const liveConfigured = cfg.apiKey && cfg.siteId && cfg.baseUrl;

  // ---------------------------
  // GET SCHEDULE
  // ---------------------------
  if (action === "get_schedule" || action === "get_schedule_web" || action === "get_schedule_by_date") {
    const resolved = resolveDatePhraseToISO(datePhraseRaw || "today", timezone);
    if (!resolved.ok) {
      return respondJSON(res, {
        success: false,
        error: `Could not parse date: ${resolved.reason}`,
        data: { action, studioKey, timezone, source, datePhraseRaw, timeOfDayParam },
      });
    }

    const finalTimeOfDay = timeOfDayParam || resolved.extractedTimeOfDay || null;

    if (cfg.mode !== "live") {
      const requestedDate = resolved.requestedDate;
      const spokenDate = buildSpokenDateLabel(requestedDate, timezone);
      let classes = buildMockSchedule(requestedDate);
      classes = filterClassesByTimeOfDay(classes, finalTimeOfDay);
      classes = sortClassesByStartTime(classes);

      if (!classes || classes.length === 0) {
        const msg = `I couldn’t find any classes for ${spokenDate}. Would you like a different date?`;
        return respondJSON(res, {
          success: false,
          say: msg,
          text: msg,
          data: {
            action: "get_schedule",
            mode: "mock",
            studioKey,
            timezone,
            source,
            requestedDate,
            timeOfDay: finalTimeOfDay,
            schedule: { studioKey, timezone, date: requestedDate, spokenDate, classes: [] },
          },
        });
      }

      const say = buildScheduleSay(spokenDate, classes);
      return respondJSON(res, {
        success: true,
        say,
        text: say,
        data: {
          action: "get_schedule",
          mode: "mock",
          studioKey,
          timezone,
          source,
          requestedDate,
          timeOfDay: finalTimeOfDay,
          schedule: { studioKey, timezone, date: requestedDate, spokenDate, classes },
        },
      });
    }

    if (!liveConfigured) {
      return respondJSON(res, {
        success: false,
        error: "Mindbody LIVE not configured. Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
        data: { action: "get_schedule", mode: "live_unconfigured", studioKey, timezone, source },
      });
    }

    try {
      const requestedDate = resolved.requestedDate;
      const spokenDate = buildSpokenDateLabel(requestedDate, timezone);

      const schedule = await fetchMindbodyScheduleForDate(cfg, requestedDate);
      let classes = schedule.classes;
      classes = filterClassesByTimeOfDay(classes, finalTimeOfDay);
      classes = sortClassesByStartTime(classes);

      if (!classes || classes.length === 0) {
        const msg = `I couldn’t find any classes for ${spokenDate}. Would you like a different date?`;
        return respondJSON(res, {
          success: false,
          say: msg,
          text: msg,
          data: {
            action: "get_schedule",
            mode: "live",
            studioKey,
            timezone,
            source,
            requestedDate,
            timeOfDay: finalTimeOfDay,
            schedule: { studioKey, timezone, date: requestedDate, spokenDate, classes: [] },
          },
        });
      }

      const say = buildScheduleSay(spokenDate, classes);

      return respondJSON(res, {
        success: true,
        say,
        text: say,
        data: {
          action: "get_schedule",
          mode: "live",
          studioKey,
          timezone,
          source,
          requestedDate,
          timeOfDay: finalTimeOfDay,
          schedule: { studioKey, timezone, date: requestedDate, spokenDate, classes },
        },
      });
    } catch (err) {
      console.log("Mindbody live schedule error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        error: err?.message || "Mindbody live schedule error",
        data: { action: "get_schedule", mode: "live_error", studioKey, timezone, source, datePhraseRaw, timeOfDayParam },
      });
    }
  }

  // ---------------------------
  // BOOK CLASS
  // ---------------------------
  if (action === "book_class") {
    if (cfg.mode !== "live") {
      return respondJSON(res, {
        success: false,
        say: "Booking is only available in live mode.",
        text: "Booking is only available in live mode.",
        data: { action, mode: cfg.mode, studioKey, timezone, source },
      });
    }

    if (!liveConfigured) {
      return respondJSON(res, {
        success: false,
        say: "Mindbody live is not configured yet.",
        text: "Mindbody live is not configured yet.",
        error: "Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
        data: { action, mode: "live_unconfigured", studioKey, timezone, source },
      });
    }

    if (!classId) {
      return respondJSON(res, {
        success: false,
        say: "I’m missing the class selection.",
        text: "I’m missing the class selection.",
        error: "Missing classId",
        data: { action, studioKey, timezone, source },
      });
    }

    try {
      const token = await getMindbodyUserToken(cfg);
      if (!token) {
        return respondJSON(res, {
          success: false,
          say: "Booking isn’t enabled yet on our side.",
          text: "Booking isn’t enabled yet on our side.",
          error: "Booking requires Mindbody user token credentials. Set MINDBODY_TOKEN_USERNAME and MINDBODY_TOKEN_PASSWORD.",
          data: { action, mode: "live_missing_token_creds", studioKey, timezone, source, classId },
        });
      }

      const isNewClient = (isNewClientRaw === "true" || isNewClientRaw === "yes" || isNewClientRaw === "1");

      let clientId = await findClientId(cfg, token, email, phone);

      let created = false;
      if (!clientId) {
        if (!firstName || !lastName) {
          return respondJSON(res, {
            success: false,
            say: "I just need your first and last name to complete the booking.",
            text: "I just need your first and last name to complete the booking.",
            error: "No existing client found; missing firstName/lastName to create new client.",
            data: { action, studioKey, timezone, source, classId, email, phone },
          });
        }
        clientId = await createClient(cfg, token, firstName, lastName, email, phone);
        created = true;
      }

      await bookClientIntoClass(cfg, token, classId, clientId);

      const say = (created || isNewClient)
        ? "You’re booked! I’ll also send you a waiver link right after this call to complete before class."
        : "You’re booked! Anything else I can help you with?";

      return respondJSON(res, {
        success: true,
        say,
        text: say,
        data: {
          action,
          mode: "live",
          studioKey,
          timezone,
          source,
          booking: { classId: String(classId), clientId: String(clientId), createdClient: created, email, phone },
        },
      });
    } catch (err) {
      console.log("Mindbody book_class error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        say: "I couldn’t complete that booking right now.",
        text: "I couldn’t complete that booking right now.",
        error: err?.message || "Mindbody booking error",
        data: { action, mode: "live_error", studioKey, timezone, source, classId, email, phone },
      });
    }
  }

  // ---------------------------
  // CANCEL CLASS
  // ---------------------------
  if (action === "cancel_class") {
    if (cfg.mode !== "live") {
      return respondJSON(res, {
        success: false,
        say: "Canceling is only available in live mode.",
        text: "Canceling is only available in live mode.",
        data: { action, mode: cfg.mode, studioKey, timezone, source },
      });
    }

    if (!liveConfigured) {
      return respondJSON(res, {
        success: false,
        say: "Mindbody live is not configured yet.",
        text: "Mindbody live is not configured yet.",
        error: "Set MINDBODY_API_KEY, MINDBODY_SITE_ID, MINDBODY_BASE_URL.",
        data: { action, mode: "live_unconfigured", studioKey, timezone, source },
      });
    }

    if (!classId) {
      return respondJSON(res, {
        success: false,
        say: "I’m missing the class selection to cancel.",
        text: "I’m missing the class selection to cancel.",
        error: "Missing classId",
        data: { action, studioKey, timezone, source },
      });
    }

    try {
      const token = await getMindbodyUserToken(cfg);
      if (!token) {
        return respondJSON(res, {
          success: false,
          say: "Canceling isn’t enabled yet on our side.",
          text: "Canceling isn’t enabled yet on our side.",
          error: "Canceling requires Mindbody user token credentials. Set MINDBODY_TOKEN_USERNAME and MINDBODY_TOKEN_PASSWORD.",
          data: { action, mode: "live_missing_token_creds", studioKey, timezone, source, classId },
        });
      }

      const clientId = await findClientId(cfg, token, email, phone);
      if (!clientId) {
        return respondJSON(res, {
          success: false,
          say: "I couldn’t find your account to cancel that booking.",
          text: "I couldn’t find your account to cancel that booking.",
          error: "No client found for provided email/phone.",
          data: { action, studioKey, timezone, source, classId, email, phone },
        });
      }

      await cancelClientFromClass(cfg, token, classId, clientId);

      const say = "Done — you’re canceled. Want me to book you into a different class instead?";
      return respondJSON(res, {
        success: true,
        say,
        text: say,
        data: {
          action,
          mode: "live",
          studioKey,
          timezone,
          source,
          cancel: { classId: String(classId), clientId: String(clientId), email, phone },
        },
      });
    } catch (err) {
      console.log("Mindbody cancel_class error:", err?.message || err);
      return respondJSON(res, {
        success: false,
        say: "I couldn’t cancel that right now.",
        text: "I couldn’t cancel that right now.",
        error: err?.message || "Mindbody cancel error",
        data: { action, mode: "live_error", studioKey, timezone, source, classId, email, phone },
      });
    }
  }

  return respondJSON(res, {
    success: false,
    error: `Unknown action: ${action}`,
    data: { action, studioKey, timezone, source },
  });
});

app.get("/", (_req, res) => res.status(200).send("ok"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

