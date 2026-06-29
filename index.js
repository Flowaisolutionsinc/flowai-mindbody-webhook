const express = require("express");
const { DateTime } = require("luxon");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const BASE_URL = process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

const API_KEY = process.env.MINDBODY_API_KEY;

// Global booking window.
// Keep Railway variable DAYS_AHEAD_MAX set to 7 for Oxygen.
// If the policy changes later, update Railway only — no code edit needed.
const DAYS_AHEAD_MAX = Number(process.env.DAYS_AHEAD_MAX || 7);

/*
  SCALING SETUP:
  - One Railway service.
  - One shared codebase.
  - Every studio lives inside STUDIO_CONFIG_JSON.
  - GHL sends studioKey, for example: oxygen_roundhouse, fort_mcmurray, manning.
*/

let STUDIO_CONFIG = {};
try {
  STUDIO_CONFIG = JSON.parse(process.env.STUDIO_CONFIG_JSON || "{}");
} catch (err) {
  console.log("Failed to parse STUDIO_CONFIG_JSON:", err.message);
  STUDIO_CONFIG = {};
}

function normalizeStudioKey(value = "") {
  return String(value || "").trim();
}

function configuredStudioKeys() {
  return Object.keys(STUDIO_CONFIG).sort();
}

function resolveStudioConfig(studioKey) {
  const key = normalizeStudioKey(studioKey);
  if (!key) return null;

  const config = STUDIO_CONFIG[key];
  if (!config) return null;

  return {
    siteId: config.siteId,
    locationId: config.locationId || "1",
    staffUsername: config.staffUsername,
    staffPassword: config.staffPassword,
    timezone: config.timezone || "America/Vancouver"
  };
}

const CACHE_TTL = 15 * 60 * 1000;
const scheduleCaches = new Map();
const mindbodyTokenCaches = new Map();

function getScheduleCache(studioKey) {
  if (!scheduleCaches.has(studioKey)) scheduleCaches.set(studioKey, new Map());
  return scheduleCaches.get(studioKey);
}

function getCache(studioKey, date) {
  const cache = getScheduleCache(studioKey);
  const entry = cache.get(date);
  if (!entry) return null;
  if (Date.now() - entry.time > CACHE_TTL) { cache.delete(date); return null; }
  return entry.data;
}

function setCache(studioKey, date, data) {
  getScheduleCache(studioKey).set(date, { data, time: Date.now() });
}

function getTokenCache(studioKey) {
  if (!mindbodyTokenCaches.has(studioKey)) {
    mindbodyTokenCaches.set(studioKey, { accessToken: null, expiresAt: 0 });
  }
  return mindbodyTokenCaches.get(studioKey);
}

function parseDate(input = "today", timezone) {
  input = decodeURIComponent(input).toLowerCase().trim();
  input = input.replace(/(\d+)(st|nd|rd|th)/g, "$1");

  const today = DateTime.now().setZone(timezone).startOf("day");

  if (input.includes("today")) return today;
  if (input.includes("tomorrow")) return today.plus({ days: 1 });

  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  for (let i = 0; i < weekdays.length; i++) {
    if (input.includes(weekdays[i])) {
      const target = i;
      const current = today.weekday % 7;
      let diff = target - current;
      if (diff <= 0) diff += 7;
      return today.plus({ days: diff });
    }
  }

  const formats = ["yyyy-MM-dd","MMMM d","MMM d","M/d/yyyy","M/d","MMMM d yyyy","MMM d yyyy"];
  for (const fmt of formats) {
    let parsed = DateTime.fromFormat(input, fmt, { zone: timezone });
    if (parsed.isValid) {
      if (!/\b\d{4}\b/.test(input)) parsed = parsed.set({ year: today.year });
      return parsed.startOf("day");
    }
  }

  const jsParsed = new Date(input);
  if (!isNaN(jsParsed)) {
    let parsed = DateTime.fromJSDate(jsParsed).setZone(timezone).startOf("day");
    if (!/\b\d{4}\b/.test(input)) parsed = parsed.set({ year: today.year });
    return parsed;
  }

  return today;
}

function dateISO(date) { return date.toFormat("yyyy-MM-dd"); }

function parseTimeOfDay(text) {
  text = String(text || "").toLowerCase();

  if (text.includes("morning")) {
    return { label: "morning", start: 0, end: 12 };
  }

  if (text.includes("afternoon")) {
    return { label: "afternoon", start: 12, end: 17 };
  }

  if (text.includes("evening") || text.includes("night")) {
    return { label: "evening", start: 17, end: 24 };
  }

  return null;
}

function baseMindbodyHeaders(studio) {
  return {
    "Api-Key": API_KEY,
    "SiteId": studio.siteId,
    "Content-Type": "application/json"
  };
}

async function getMindbodyUserToken(studioKey, studio, forceRefresh = false) {
  const now = Date.now();
  const tokenCache = getTokenCache(studioKey);

  if (!forceRefresh && tokenCache.accessToken && tokenCache.expiresAt > now + 60 * 1000) {
    return tokenCache.accessToken;
  }

  if (!studio.staffUsername || !studio.staffPassword) {
    throw new Error(`Missing staff username/password for studio: ${studioKey}`);
  }

  const res = await fetch(`${BASE_URL}/usertoken/issue`, {
    method: "POST",
    headers: baseMindbodyHeaders(studio),
    body: JSON.stringify({ Username: studio.staffUsername, Password: studio.staffPassword })
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) throw new Error(`Mindbody user token failed: ${res.status}`);

  const accessToken = json?.AccessToken || json?.accessToken || json?.Token || json?.token;
  if (!accessToken) throw new Error("Mindbody user token missing AccessToken");

  mindbodyTokenCaches.set(studioKey, { accessToken, expiresAt: now + 12 * 60 * 60 * 1000 });
  return accessToken;
}

async function mindbodyGet(studioKey, studio, path, query = {}, options = {}) {
  const { useUserToken = false } = options;
  const url = new URL(`${BASE_URL}${path}`);
  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") url.searchParams.append(key, String(value));
  });

  const headers = baseMindbodyHeaders(studio);
  if (useUserToken) headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio)}`;

  console.log(`[${studioKey}] Mindbody GET:`, url.toString());
  let res = await fetch(url.toString(), { method: "GET", headers });

  if (useUserToken && res.status === 401) {
    headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio, true)}`;
    res = await fetch(url.toString(), { method: "GET", headers });
  }

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Mindbody GET failed: ${res.status}`);
  return json;
}

async function mindbodyPost(studioKey, studio, path, body = {}, options = {}) {
  const { useUserToken = false } = options;
  const url = `${BASE_URL}${path}`;
  const headers = baseMindbodyHeaders(studio);
  if (useUserToken) headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio)}`;

  console.log(`[${studioKey}] Mindbody POST:`, url);
  let res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

  if (useUserToken && res.status === 401) {
    headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio, true)}`;
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  }

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`Mindbody POST failed: ${res.status}`);
  return json;
}

function normalizePhone(phone = "") { return String(phone).replace(/\D/g, ""); }
function safeLower(value = "") { return String(value || "").trim().toLowerCase(); }

function namesMatch(client, firstName, lastName) {
  const clientFirst = safeLower(client?.FirstName);
  const clientLast = safeLower(client?.LastName);
  const inputFirst = safeLower(firstName);
  const inputLast = safeLower(lastName);
  if (!inputFirst && !inputLast) return true;
  if (inputFirst && clientFirst !== inputFirst) return false;
  if (inputLast && clientLast !== inputLast) return false;
  return true;
}

function phoneMatches(client, phone) {
  if (!phone) return false;
  const target = normalizePhone(phone);
  const possiblePhones = [client?.MobilePhone, client?.HomePhone, client?.WorkPhone, client?.Phone]
    .filter(Boolean).map(normalizePhone);
  return possiblePhones.includes(target);
}

function emailMatches(client, email) {
  if (!email) return false;
  return safeLower(client?.Email) === safeLower(email);
}

async function findExistingClient(studioKey, studio, { firstName, lastName, phone, email }) {
  const searchTerms = [];

  let cleanedPhone = phone ? normalizePhone(phone) : "";
  if (cleanedPhone.length === 11 && cleanedPhone.startsWith("1")) cleanedPhone = cleanedPhone.slice(1);
  console.log(`[${studioKey}] Original phone:`, phone, "→ Cleaned phone for search:", cleanedPhone);

  if (cleanedPhone) searchTerms.push(cleanedPhone);
  if (email) searchTerms.push(email);
  if (firstName || lastName) searchTerms.push(`${firstName || ""} ${lastName || ""}`.trim());

  let allClients = [];
  for (const term of searchTerms) {
    try {
      const json = await mindbodyGet(studioKey, studio, "/client/clients", { SearchText: term }, { useUserToken: true });
      const clients = Array.isArray(json?.Clients) ? json.Clients : [];
      console.log(`[${studioKey}] Client search for "${term}" returned ${clients.length} result(s)`);
      allClients = allClients.concat(clients);
    } catch (err) {
      console.log(`[${studioKey}] Client search failed for term:`, term, err.message);
    }
  }

  const uniqueClients = [];
  const seen = new Set();
  for (const client of allClients) {
    const id = client?.Id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueClients.push(client);
  }

  console.log(`[${studioKey}] Total unique clients found:`, uniqueClients.length);

  let matched = uniqueClients.find(c => phoneMatches(c, cleanedPhone) && namesMatch(c, firstName, lastName));
  if (matched) { console.log(`[${studioKey}] Matched by phone + name:`, matched.FirstName, matched.LastName); return matched; }

  matched = uniqueClients.find(c => emailMatches(c, email) && namesMatch(c, firstName, lastName));
  if (matched) { console.log(`[${studioKey}] Matched by email + name:`, matched.FirstName, matched.LastName); return matched; }

  matched = uniqueClients.find(c => phoneMatches(c, cleanedPhone));
  if (matched) { console.log(`[${studioKey}] Matched by phone only:`, matched.FirstName, matched.LastName); return matched; }

  matched = uniqueClients.find(c => emailMatches(c, email));
  if (matched) { console.log(`[${studioKey}] Matched by email only:`, matched.FirstName, matched.LastName); return matched; }

  if (uniqueClients.length === 1 && namesMatch(uniqueClients[0], firstName, lastName)) {
    console.log(`[${studioKey}] Matched by name only (single result):`, uniqueClients[0].FirstName, uniqueClients[0].LastName);
    return uniqueClients[0];
  }

  return null;
}

async function lookupClientByPhone(studioKey, studio, phone) {
  let cleanedPhone = normalizePhone(phone);
  if (cleanedPhone.length === 11 && cleanedPhone.startsWith("1")) cleanedPhone = cleanedPhone.slice(1);

  console.log(`[${studioKey}] Phone lookup — cleaned:`, cleanedPhone);
  if (!cleanedPhone) return null;

  try {
    const json = await mindbodyGet(studioKey, studio, "/client/clients", { SearchText: cleanedPhone }, { useUserToken: true });
    const clients = Array.isArray(json?.Clients) ? json.Clients : [];
    console.log(`[${studioKey}] Phone lookup returned ${clients.length} result(s)`);
    return clients.find(c => phoneMatches(c, cleanedPhone)) || null;
  } catch (err) {
    console.log(`[${studioKey}] Phone lookup failed:`, err.message);
    return null;
  }
}

async function bookExistingClientIntoClass(studioKey, studio, { clientId, classId }) {
  const json = await mindbodyPost(studioKey, studio, "/class/addclienttoclass", {
    ClientID: clientId,
    ClassID: classId,
    Waitlist: false,
    SendEmail: false,
    Test: false,
    RequirePayment: false
  }, { useUserToken: true });

  console.log(`[${studioKey}] AddClientToClass response:`, json);
  return json;
}

async function fetchClasses(studioKey, studio, date) {
  const url = `${BASE_URL}/class/classes?StartDateTime=${date}T00:00:00&EndDateTime=${date}T23:59:59&LocationIds=${studio.locationId}`;
  console.log(`[${studioKey}] Mindbody request:`, url);
  const res = await fetch(url, { headers: { "Api-Key": API_KEY, "SiteId": studio.siteId } });
  const json = await res.json();
  return json.Classes || [];
}

function normalize(classes, timezone) {
  return classes.map(c => {
    const localStart = DateTime.fromISO(c.StartDateTime, { zone: timezone });
    const time = localStart.isValid ? localStart.toFormat("h:mm a") : "Time unavailable";
    return {
      id: c.Id,
      name: c.ClassDescription?.Name || c.Name || "Class",
      instructor: c.Staff?.Name || "Instructor",
      time,
      start: c.StartDateTime,
      localHour: localStart.isValid ? localStart.hour : null,
      localMillis: localStart.isValid ? localStart.toMillis() : 0
    };
  }).sort((a, b) => a.localMillis - b.localMillis);
}

function normalizeText(value = "") {
  return String(value || "").toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").replace(/[^\w\s]/g, "").trim();
}

function buildClassLabel(c) { return `${c.time} ${c.name} with ${c.instructor}`; }

async function getClassesForDate(studioKey, studio, iso) {
  let classes = getCache(studioKey, iso) || [];
  if (classes.length) { console.log(`[${studioKey}] CACHE HIT:`, iso); return classes; }
  console.log(`[${studioKey}] CACHE MISS:`, iso);
  const raw = await fetchClasses(studioKey, studio, iso);
  classes = normalize(raw, studio.timezone);
  setCache(studioKey, iso, classes);
  return classes;
}

async function resolveBookingClassId(studioKey, studio, classInput) {
  if (!classInput) return null;
  if (/^\d+$/.test(String(classInput).trim())) return String(classInput).trim();

  const target = normalizeText(classInput);
  const today = DateTime.now().setZone(studio.timezone).startOf("day");
  const allClasses = [];

  for (let i = 0; i < 7; i++) {
    const iso = today.plus({ days: i }).toFormat("yyyy-MM-dd");
    try {
      const classes = await getClassesForDate(studioKey, studio, iso);
      for (const c of classes) {
        allClasses.push({
          ...c, iso,
          label: buildClassLabel(c),
          normalizedLabel: normalizeText(buildClassLabel(c)),
          normalizedName: normalizeText(c.name),
          normalizedTime: normalizeText(c.time),
          normalizedInstructor: normalizeText(c.instructor)
        });
      }
    } catch (err) {
      console.log(`[${studioKey}] Class resolution fetch failed for date:`, iso, err.message);
    }
  }

  const match =
    allClasses.find(c => c.normalizedLabel === target) ||
    allClasses.find(c => target.includes(c.normalizedTime) && target.includes(c.normalizedName) && target.includes(c.normalizedInstructor)) ||
    allClasses.find(c => target.includes(c.normalizedTime) && target.includes(c.normalizedName)) ||
    allClasses.find(c => target.includes(c.normalizedName) && target.includes(c.normalizedTime)) ||
    allClasses.find(c => target.includes(c.normalizedName)) ||
    allClasses.find(c => target.includes(c.normalizedTime)) ||
    allClasses.find(c => c.normalizedLabel.includes(target) || target.includes(c.normalizedLabel));

  if (!match) { console.log(`[${studioKey}] Could not resolve class input:`, classInput); return null; }
  console.log(`[${studioKey}] Resolved booking classId:`, match.id, "for label:", match.label, "on", match.iso);
  return match.id;
}

function buildSpeech(dateLabel, classes, datePhrase) {
  if (!classes || classes.length === 0) {
    return `I couldn't find any classes for ${datePhrase}.`;
  }

  const lowerDatePhrase = String(datePhrase || "").toLowerCase();
  const hasTimeOfDay =
    lowerDatePhrase.includes("morning") ||
    lowerDatePhrase.includes("afternoon") ||
    lowerDatePhrase.includes("evening") ||
    lowerDatePhrase.includes("night");

  // If the caller asks broadly, do not make the AI read a long full-day list.
  // This keeps the receptionist sounding natural and makes the caller choose a smaller window first.
  if (!hasTimeOfDay && classes.length > 4) {
    return `There are quite a few classes for ${dateLabel}. Ask the caller: "Are you looking for morning, afternoon, or evening classes?" Do not read the full schedule yet.`;
  }

  const classesToRead = classes.slice(0, 4);

  // Blank lines and full sentences help GoHighLevel Voice AI pause between class options.
  const listText = classesToRead
    .map(c => `At ${c.time}, there is ${c.name} with ${c.instructor}.`)
    .join("\n\n");

  const moreText =
    classes.length > 4
      ? "\n\nThere are more options too. Ask if they'd like to hear more."
      : "";

  const timeOfDay = parseTimeOfDay(datePhrase);
  const timeLabel = timeOfDay?.label ? ` ${timeOfDay.label}` : "";

  return `Here are the classes for ${dateLabel}${timeLabel}:\n\n${listText}${moreText}`;
}

/*
  No global cache warming.

  Important for scaling:
  The old version refreshed every studio every 15 minutes.
  At 200 studios, that would mean 200 studios x 7 days = 1,400 schedule fetches
  every 15 minutes, even if nobody called.

  This version loads schedules on demand:
  - First caller for a studio/date = cache miss, fetch from Mindbody.
  - Next callers for the same studio/date within 15 minutes = cache hit.
*/

/* =========================
WEBHOOK HANDLER
========================= */

async function handler(req, res) {
  const studioKey = normalizeStudioKey(
    req.params.studioKey ||
    req.body.studioKey ||
    req.query.studioKey ||
    ""
  );

  const studio = resolveStudioConfig(studioKey);

  console.log("----- WEBHOOK REQUEST -----");
  console.log("Studio key:", studioKey || "(missing)");
  console.log("Body:", req.body);
  console.log("Query:", req.query);

  if (!studioKey) {
    console.log("Missing studioKey. Configured studios:", configuredStudioKeys().join(", ") || "(none)");
    return res.json({
      success: false,
      error: "missing_studio_key",
      results: "This studio isn't configured yet — please contact support."
    });
  }

  if (!studio) {
    console.log(`Invalid studioKey received: "${studioKey}"`);
    console.log("Configured studios:", configuredStudioKeys().join(", ") || "(none)");
    return res.json({
      success: false,
      error: "invalid_studio_key",
      studioKey,
      results: "This studio isn't configured yet — please contact support."
    });
  }

  const effectiveStudioKey = studioKey;
  const action = req.body.action || req.query.action;

  // Lookup caller by inbound phone number at the start of every call
  if (action === "lookup_by_phone") {
    const phone = req.body.phone || req.query.phone || "";
    console.log(`[${effectiveStudioKey}] PHONE LOOKUP:`, phone);

    if (!phone) return res.json({ found: false, results: "new_caller" });

    try {
      const client = await lookupClientByPhone(effectiveStudioKey, studio, phone);
      if (client) {
        console.log(`[${effectiveStudioKey}] Phone lookup matched:`, client.FirstName, client.LastName);
        return res.json({
          found: true,
          firstName: client.FirstName || "",
          lastName: client.LastName || "",
          clientId: client.Id || "",
          results: "existing_member"
        });
      } else {
        console.log(`[${effectiveStudioKey}] Phone lookup — no match found`);
        return res.json({ found: false, results: "new_caller" });
      }
    } catch (err) {
      console.log(`[${effectiveStudioKey}] Phone lookup error:`, err.message);
      return res.json({ found: false, results: "new_caller" });
    }
  }

  if (action === "book_existing_client") {
    const classId = req.body.classId || req.query.classId;
    const firstName = req.body.firstName || req.query.firstName || "";
    const lastName = req.body.lastName || req.query.lastName || "";
    const phone = req.body.phone || req.query.phone || "";
    const email = req.body.email || req.query.email || "";
    const isNewClient = String(req.body.isNewClient || req.query.isNewClient || "").toLowerCase();

    if (!classId) return res.json({ results: "I couldn't tell which class you wanted to book — would you like me to try again or connect you with the front desk?" });
    if (isNewClient === "true") return res.json({ results: "New clients need to get started through the intro offer first." });
    if (!firstName || !lastName || !phone) return res.json({ results: "I need your first name, last name, and phone number to complete that booking." });

    try {
      const client = await findExistingClient(effectiveStudioKey, studio, { firstName, lastName, phone, email });
      console.log(`[${effectiveStudioKey}] Client lookup result:`, client ? `FOUND — ID: ${client.Id}, Name: ${client.FirstName} ${client.LastName}` : "NOT FOUND");

      if (!client || !client.Id) return res.json({ results: "I couldn't find an existing account with that information — would you like me to connect you with the front desk?" });

      const resolvedClassId = await resolveBookingClassId(effectiveStudioKey, studio, classId);

      if (resolvedClassId) {
        const today = DateTime.now().setZone(studio.timezone).startOf("day");
        for (let i = 0; i < 8; i++) {
          const iso = today.plus({ days: i }).toFormat("yyyy-MM-dd");
          try {
            const classes = await getClassesForDate(effectiveStudioKey, studio, iso);
            for (const c of classes) {
              if (String(c.id) === String(resolvedClassId)) {
                const daysAhead = DateTime.fromISO(c.start, { zone: studio.timezone }).startOf("day").diff(today, "days").days;
                if (daysAhead > DAYS_AHEAD_MAX) return res.json({ results: `Sorry, bookings can only be made up to ${DAYS_AHEAD_MAX} days in advance.` });
              }
            }
          } catch (err) {
            console.log(`[${effectiveStudioKey}] Date check error:`, err.message);
          }
        }
      }

      if (!resolvedClassId) return res.json({ results: "I couldn't match that class exactly — would you like me to try again or connect you with the front desk?" });

      const bookingResponse = await bookExistingClientIntoClass(effectiveStudioKey, studio, { clientId: client.Id, classId: resolvedClassId });

      const visits = Array.isArray(bookingResponse?.Visits) ? bookingResponse.Visits : [];
      const visit = bookingResponse?.Visit;
      const bookingAction = bookingResponse?.Action || visit?.Action || "";
      const errorCode = bookingResponse?.ErrorCode;
      const message = bookingResponse?.Message || bookingResponse?.ErrorMessage || "";
      const lowerMessage = String(message).toLowerCase();

      if ((visits.length > 0 || bookingAction === "Added" || visit) && !errorCode) return res.json({ results: "You're all set — you're booked." });
      if (lowerMessage.includes("already booked")) return res.json({ results: "It looks like you're already booked into that class." });
      if (lowerMessage.includes("waitlist")) return res.json({ results: "I couldn't complete that booking directly — it looks like that class may only be available by waitlist. Would you like me to connect you with the front desk?" });
      if (lowerMessage.includes("payment")) return res.json({ results: "I couldn't complete that booking because there may be a payment or pass issue on the account. Would you like me to connect you with the front desk?" });

      return res.json({ results: "I couldn't complete that booking — would you like me to try again or connect you with the front desk?" });
    } catch (err) {
      console.log(`[${effectiveStudioKey}] BOOKING ERROR:`, err);
      return res.json({ results: "I couldn't complete that booking — would you like me to try again or connect you with the front desk?" });
    }
  }

  if (action !== "get_schedule") return res.json({ results: "Unsupported action." });

  const datePhrase = decodeURIComponent(req.body.date || req.query.date || "today");
  console.log(`[${effectiveStudioKey}] DATE PHRASE RECEIVED:`, datePhrase);

  try {
    const date = parseDate(datePhrase, studio.timezone);
    const iso = dateISO(date);

    let classes = getCache(effectiveStudioKey, iso) || [];
    if (!classes.length) {
      const raw = await fetchClasses(effectiveStudioKey, studio, iso);
      classes = normalize(raw, studio.timezone);
      setCache(effectiveStudioKey, iso, classes);
    }

    const timeFilter = parseTimeOfDay(datePhrase);
    if (timeFilter && classes.length) {
      classes = classes.filter(c => c.localHour !== null && c.localHour >= timeFilter.start && c.localHour < timeFilter.end);
    }

    const spokenDate = datePhrase.toLowerCase().includes("tomorrow") ? "tomorrow"
      : datePhrase.toLowerCase().includes("today") ? "today"
      : date.toFormat("cccc, LLLL d");

    const speech = buildSpeech(spokenDate, classes, datePhrase);
    console.log("----- WEBHOOK RESPONSE -----");
    console.log(speech);
    return res.json({ results: speech });
  } catch (err) {
    console.log(`[${effectiveStudioKey}] ERROR:`, err);
    return res.json({ results: "I'm not able to pull the schedule up right now — would you like me to connect you with the front desk?" });
  }
}

/* =========================
ROUTES
========================= */

app.post("/ghl/mindbody", handler);
app.get("/ghl/mindbody", handler);
app.post("/ghl/mindbody/speak", handler);
app.get("/ghl/mindbody/speak", handler);
app.post("/ghl/mindbody/:studioKey", handler);
app.get("/ghl/mindbody/:studioKey", handler);
app.post("/ghl/mindbody/speak/:studioKey", handler);
app.get("/ghl/mindbody/speak/:studioKey", handler);

app.get("/debug", (req, res) => { res.send("Webhook server alive"); });

/* =========================
START SERVER
========================= */

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("Configured studios:", configuredStudioKeys().join(", ") || "(none)");
  console.log("Days ahead max:", DAYS_AHEAD_MAX);
});
