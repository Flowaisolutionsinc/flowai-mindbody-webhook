const express = require("express");
const { DateTime } = require("luxon");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const BASE_URL = process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

// Shared across all studios — same Mindbody developer/source account key
const API_KEY = process.env.MINDBODY_API_KEY;

// Legacy single-studio env vars — power the original unprefixed routes.
// DO NOT REMOVE: this is what keeps Roundhouse running exactly as before.
const LEGACY_CONFIG = {
  siteId: process.env.MINDBODY_SITE_ID,
  locationId: process.env.MINDBODY_LOCATION_ID || "1",
  staffUsername: process.env.MINDBODY_STAFF_USERNAME,
  staffPassword: process.env.MINDBODY_STAFF_PASSWORD,
  timezone: process.env.TZ || "America/Vancouver"
};

// New studios live here, keyed by a studio slug used in the URL path.
// Example:
// {
//   "fort_mcmurray": {
//     "siteId": "349551",
//     "locationId": "1",
//     "timezone": "America/Edmonton",
//     "staffUsername": "...",
//     "staffPassword": "..."
//   }
// }
let STUDIO_CONFIG = {};
try {
  STUDIO_CONFIG = JSON.parse(process.env.STUDIO_CONFIG_JSON || "{}");
} catch (err) {
  console.log("Failed to parse STUDIO_CONFIG_JSON:", err.message);
  STUDIO_CONFIG = {};
}

function resolveStudioConfig(studioKey) {
  if (!studioKey) {
    return LEGACY_CONFIG;
  }

  const config = STUDIO_CONFIG[studioKey];

  if (!config) {
    return null;
  }

  return {
    siteId: config.siteId,
    locationId: config.locationId || "1",
    staffUsername: config.staffUsername,
    staffPassword: config.staffPassword,
    timezone: config.timezone || "America/Vancouver"
  };
}

/* =========================
PER-STUDIO CACHES
========================= */

const CACHE_TTL = 15 * 60 * 1000;

// studioKey -> Map(dateIso -> { data, time })
const scheduleCaches = new Map();

// studioKey -> { accessToken, expiresAt }
const mindbodyTokenCaches = new Map();

function getScheduleCache(studioKey) {
  if (!scheduleCaches.has(studioKey)) {
    scheduleCaches.set(studioKey, new Map());
  }
  return scheduleCaches.get(studioKey);
}

function getCache(studioKey, date) {
  const cache = getScheduleCache(studioKey);
  const entry = cache.get(date);

  if (!entry) return null;

  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(date);
    return null;
  }

  return entry.data;
}

function setCache(studioKey, date, data) {
  const cache = getScheduleCache(studioKey);
  cache.set(date, {
    data,
    time: Date.now()
  });
}

function getTokenCache(studioKey) {
  if (!mindbodyTokenCaches.has(studioKey)) {
    mindbodyTokenCaches.set(studioKey, { accessToken: null, expiresAt: 0 });
  }
  return mindbodyTokenCaches.get(studioKey);
}

/* =========================
DATE PARSER
========================= */

function parseDate(input = "today", timezone) {
  input = decodeURIComponent(input).toLowerCase().trim();
  input = input.replace(/(\d+)(st|nd|rd|th)/g, "$1");

  const today = DateTime.now().setZone(timezone).startOf("day");

  if (input.includes("today")) return today;
  if (input.includes("tomorrow")) return today.plus({ days: 1 });

  const weekdays = [
    "sunday", "monday", "tuesday", "wednesday",
    "thursday", "friday", "saturday"
  ];

  for (let i = 0; i < weekdays.length; i++) {
    if (input.includes(weekdays[i])) {
      const target = i;
      const current = today.weekday % 7;
      let diff = target - current;
      if (diff <= 0) diff += 7;
      return today.plus({ days: diff });
    }
  }

  const formats = [
    "yyyy-MM-dd",
    "MMMM d",
    "MMM d",
    "M/d/yyyy",
    "M/d",
    "MMMM d yyyy",
    "MMM d yyyy"
  ];

  for (const fmt of formats) {
    let parsed = DateTime.fromFormat(input, fmt, { zone: timezone });

    if (parsed.isValid) {
      if (!/\b\d{4}\b/.test(input)) {
        parsed = parsed.set({ year: today.year });
      }
      return parsed.startOf("day");
    }
  }

  const jsParsed = new Date(input);
  if (!isNaN(jsParsed)) {
    let parsed = DateTime.fromJSDate(jsParsed).setZone(timezone).startOf("day");
    if (!/\b\d{4}\b/.test(input)) {
      parsed = parsed.set({ year: today.year });
    }
    return parsed;
  }

  return today;
}

function dateISO(date) {
  return date.toFormat("yyyy-MM-dd");
}

/* =========================
TIME OF DAY PARSER
========================= */

function parseTimeOfDay(text) {
  text = String(text || "").toLowerCase();

  if (text.includes("morning")) return { start: 0, end: 12 };
  if (text.includes("afternoon")) return { start: 12, end: 24 };
  if (text.includes("evening")) return { start: 17, end: 24 };
  if (text.includes("night")) return { start: 19, end: 24 };

  return null;
}

/* =========================
MINDBODY HELPERS
========================= */

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

  if (
    !forceRefresh &&
    tokenCache.accessToken &&
    tokenCache.expiresAt > now + 60 * 1000
  ) {
    return tokenCache.accessToken;
  }

  if (!studio.staffUsername || !studio.staffPassword) {
    throw new Error(`Missing staff username/password for studio: ${studioKey}`);
  }

  const url = `${BASE_URL}/usertoken/issue`;
  const body = {
    Username: studio.staffUsername,
    Password: studio.staffPassword
  };

  console.log(`[${studioKey}] Mindbody POST:`, url);
  console.log(`[${studioKey}] Issuing Mindbody user token...`);

  const res = await fetch(url, {
    method: "POST",
    headers: baseMindbodyHeaders(studio),
    body: JSON.stringify(body)
  });

  const text = await res.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    console.log(`[${studioKey}] Mindbody user token error:`, res.status, json);
    throw new Error(`Mindbody user token failed: ${res.status}`);
  }

  const accessToken =
    json?.AccessToken ||
    json?.accessToken ||
    json?.Token ||
    json?.token;

  if (!accessToken) {
    console.log(`[${studioKey}] Mindbody user token missing AccessToken:`, json);
    throw new Error("Mindbody user token missing AccessToken");
  }

  mindbodyTokenCaches.set(studioKey, {
    accessToken,
    expiresAt: now + 12 * 60 * 60 * 1000
  });

  return accessToken;
}

async function mindbodyGet(studioKey, studio, path, query = {}, options = {}) {
  const { useUserToken = false } = options;

  const url = new URL(`${BASE_URL}${path}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.append(key, String(value));
    }
  });

  const headers = baseMindbodyHeaders(studio);

  if (useUserToken) {
    headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio)}`;
  }

  console.log(`[${studioKey}] Mindbody GET:`, url.toString());

  let res = await fetch(url.toString(), {
    method: "GET",
    headers
  });

  if (useUserToken && res.status === 401) {
    console.log(`[${studioKey}] Mindbody GET received 401, refreshing user token...`);
    headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio, true)}`;

    res = await fetch(url.toString(), {
      method: "GET",
      headers
    });
  }

  const text = await res.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    console.log(`[${studioKey}] Mindbody GET error:`, res.status, json);
    throw new Error(`Mindbody GET failed: ${res.status}`);
  }

  return json;
}

async function mindbodyPost(studioKey, studio, path, body = {}, options = {}) {
  const { useUserToken = false } = options;

  const url = `${BASE_URL}${path}`;
  const headers = baseMindbodyHeaders(studio);

  if (useUserToken) {
    headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio)}`;
  }

  console.log(`[${studioKey}] Mindbody POST:`, url);
  console.log(`[${studioKey}] Mindbody POST body:`, body);

  let res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (useUserToken && res.status === 401) {
    console.log(`[${studioKey}] Mindbody POST received 401, refreshing user token...`);
    headers["Authorization"] = `Bearer ${await getMindbodyUserToken(studioKey, studio, true)}`;

    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
  }

  const text = await res.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    console.log(`[${studioKey}] Mindbody POST error:`, res.status, json);
    throw new Error(`Mindbody POST failed: ${res.status}`);
  }

  return json;
}

function normalizePhone(phone = "") {
  return String(phone).replace(/\D/g, "");
}

function safeLower(value = "") {
  return String(value || "").trim().toLowerCase();
}

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

  const possiblePhones = [
    client?.MobilePhone,
    client?.HomePhone,
    client?.WorkPhone,
    client?.Phone
  ]
    .filter(Boolean)
    .map(normalizePhone);

  return possiblePhones.includes(target);
}

function emailMatches(client, email) {
  if (!email) return false;
  return safeLower(client?.Email) === safeLower(email);
}

async function findExistingClient(studioKey, studio, { firstName, lastName, phone, email }) {
  const searchTerms = [];

  // Strip +1 or 1 country code prefix for Mindbody search compatibility
  let cleanedPhone = phone ? normalizePhone(phone) : "";
  if (cleanedPhone.length === 11 && cleanedPhone.startsWith("1")) {
    cleanedPhone = cleanedPhone.slice(1);
  }
  console.log(`[${studioKey}] Original phone:`, phone, "→ Cleaned phone for search:", cleanedPhone);

  if (cleanedPhone) searchTerms.push(cleanedPhone);
  if (email) searchTerms.push(email);
  if (firstName || lastName) {
    searchTerms.push(`${firstName || ""} ${lastName || ""}`.trim());
  }

  // Use cleaned phone for matching too
  const phoneForMatching = cleanedPhone;

  let allClients = [];

  for (const term of searchTerms) {
    try {
      const json = await mindbodyGet(
        studioKey,
        studio,
        "/client/clients",
        { SearchText: term },
        { useUserToken: true }
      );

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

  let matched = uniqueClients.find(client =>
    phoneMatches(client, phoneForMatching) && namesMatch(client, firstName, lastName)
  );
  if (matched) {
    console.log(`[${studioKey}] Matched by phone + name:`, matched.FirstName, matched.LastName);
    return matched;
  }

  matched = uniqueClients.find(client =>
    emailMatches(client, email) && namesMatch(client, firstName, lastName)
  );
  if (matched) {
    console.log(`[${studioKey}] Matched by email + name:`, matched.FirstName, matched.LastName);
    return matched;
  }

  // Trust phone match alone — name spelling may differ (e.g. Braden vs Brayden)
  matched = uniqueClients.find(client => phoneMatches(client, phoneForMatching));
  if (matched) {
    console.log(`[${studioKey}] Matched by phone only (name spelling may differ):`, matched.FirstName, matched.LastName);
    return matched;
  }

  matched = uniqueClients.find(client => emailMatches(client, email));
  if (matched) {
    console.log(`[${studioKey}] Matched by email only:`, matched.FirstName, matched.LastName);
    return matched;
  }

  // If exactly one client found and name matches, trust it
  if (uniqueClients.length === 1 && namesMatch(uniqueClients[0], firstName, lastName)) {
    console.log(`[${studioKey}] Matched by name only (single result):`, uniqueClients[0].FirstName, uniqueClients[0].LastName);
    return uniqueClients[0];
  }

  return null;
}

async function bookExistingClientIntoClass(studioKey, studio, { clientId, classId }) {
  const payload = {
    ClientID: clientId,
    ClassID: classId,
    Waitlist: false,
    SendEmail: false,
    Test: false,
    RequirePayment: false
  };

  const json = await mindbodyPost(studioKey, studio, "/class/addclienttoclass", payload, {
    useUserToken: true
  });

  console.log(`[${studioKey}] AddClientToClass response:`, json);

  return json;
}

/* =========================
FETCH MINDBODY CLASSES
========================= */

async function fetchClasses(studioKey, studio, date) {
  const start = `${date}T00:00:00`;
  const end = `${date}T23:59:59`;

  const url =
    `${BASE_URL}/class/classes?StartDateTime=${start}&EndDateTime=${end}&LocationIds=${studio.locationId}`;

  console.log(`[${studioKey}] Mindbody request:`, url);

  const res = await fetch(url, {
    headers: {
      "Api-Key": API_KEY,
      "SiteId": studio.siteId
    }
  });

  const json = await res.json();

  return json.Classes || [];
}

/* =========================
NORMALIZE CLASSES
========================= */

function normalize(classes, timezone) {
  return classes
    .map(c => {
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
    })
    .sort((a, b) => a.localMillis - b.localMillis);
}

function normalizeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .replace(/[^\w\s]/g, "")
    .trim();
}

function buildClassLabel(c) {
  return `${c.time} ${c.name} with ${c.instructor}`;
}

async function getClassesForDate(studioKey, studio, iso) {
  let classes = getCache(studioKey, iso) || [];

  if (classes.length) {
    console.log(`[${studioKey}] CACHE HIT:`, iso);
    return classes;
  }

  console.log(`[${studioKey}] CACHE MISS:`, iso);

  const raw = await fetchClasses(studioKey, studio, iso);
  classes = normalize(raw, studio.timezone);
  setCache(studioKey, iso, classes);

  return classes;
}

async function resolveBookingClassId(studioKey, studio, classInput) {
  if (!classInput) return null;

  if (/^\d+$/.test(String(classInput).trim())) {
    return String(classInput).trim();
  }

  const target = normalizeText(classInput);
  console.log(`[${studioKey}] Resolving class input:`, classInput);
  console.log(`[${studioKey}] Normalized target:`, target);

  const today = DateTime.now().setZone(studio.timezone).startOf("day");

  const allClasses = [];

  for (let i = 0; i < 7; i++) {
    const d = today.plus({ days: i });
    const iso = d.toFormat("yyyy-MM-dd");

    try {
      const classes = await getClassesForDate(studioKey, studio, iso);
      for (const c of classes) {
        allClasses.push({
          ...c,
          iso,
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

  console.log(`[${studioKey}] Total classes available for matching:`, allClasses.length);
  console.log(`[${studioKey}] Available class labels:`, allClasses.map(c => `[${c.iso}] ${c.normalizedLabel}`));

  let match = allClasses.find(c => c.normalizedLabel === target);

  if (!match) {
    match = allClasses.find(c =>
      target.includes(c.normalizedTime) &&
      target.includes(c.normalizedName) &&
      target.includes(c.normalizedInstructor)
    );
  }

  if (!match) {
    match = allClasses.find(c =>
      target.includes(c.normalizedTime) &&
      target.includes(c.normalizedName)
    );
  }

  if (!match) {
    match = allClasses.find(c =>
      target.includes(c.normalizedName) &&
      target.includes(c.normalizedTime)
    );
  }

  if (!match) {
    match = allClasses.find(c =>
      target.includes(c.normalizedName)
    );
  }

  if (!match) {
    match = allClasses.find(c =>
      target.includes(c.normalizedTime)
    );
  }

  if (!match) {
    match = allClasses.find(c =>
      c.normalizedLabel.includes(target) || target.includes(c.normalizedLabel)
    );
  }

  if (!match) {
    console.log(`[${studioKey}] Could not resolve class input:`, classInput);
    return null;
  }

  console.log(`[${studioKey}] Resolved booking classId:`, match.id, "for label:", match.label, "on", match.iso);

  return match.id;
}

/* =========================
SPEECH BUILDER
========================= */

function buildSpeech(dateLabel, classes, datePhrase) {
  if (!classes || classes.length === 0) {
    return `I couldn't find any classes for ${datePhrase}.`;
  }

  const list = classes.map(c => `${c.time} ${c.name} with ${c.instructor}`);

  if (datePhrase.toLowerCase().includes("morning")) {
    return `The classes for ${dateLabel} morning are: ${list.join(", ")}.`;
  }

  if (datePhrase.toLowerCase().includes("afternoon")) {
    return `The classes for ${dateLabel} afternoon are: ${list.join(", ")}.`;
  }

  if (datePhrase.toLowerCase().includes("evening")) {
    return `The classes for ${dateLabel} evening are: ${list.join(", ")}.`;
  }

  if (datePhrase.toLowerCase().includes("night")) {
    return `The classes for ${dateLabel} night are: ${list.join(", ")}.`;
  }

  return `The classes for ${dateLabel} are: ${list.join(", ")}.`;
}

/* =========================
CACHE WARMER
========================= */

async function warmCacheForStudio(studioKey, studio) {
  const today = DateTime.now().setZone(studio.timezone).startOf("day");

  for (let i = 0; i < 7; i++) {
    const d = today.plus({ days: i });
    const iso = d.toFormat("yyyy-MM-dd");

    try {
      const raw = await fetchClasses(studioKey, studio, iso);
      const classes = normalize(raw, studio.timezone);

      setCache(studioKey, iso, classes);
      console.log(`[${studioKey}] Cache updated:`, iso);
    } catch (err) {
      console.log(`[${studioKey}] Cache warm error:`, err.message);
    }
  }
}

function allStudios() {
  const entries = [["__legacy__", LEGACY_CONFIG]];

  for (const [key, config] of Object.entries(STUDIO_CONFIG)) {
    const resolved = resolveStudioConfig(key);
    if (resolved) {
      entries.push([key, resolved]);
    }
  }

  return entries;
}

async function warmAllCaches() {
  console.log("Warming schedule cache for all studios...");

  for (const [studioKey, studio] of allStudios()) {
    if (!studio.siteId) continue;
    await warmCacheForStudio(studioKey, studio);
  }
}

/* =========================
WEBHOOK HANDLER
========================= */

async function handler(req, res) {
  const studioKey = req.params.studioKey || null;
  const studio = resolveStudioConfig(studioKey);

  console.log("----- WEBHOOK REQUEST -----");
  console.log("Studio key:", studioKey || "(legacy/default)");
  console.log("Body:", req.body);
  console.log("Query:", req.query);

  if (!studio) {
    console.log("Unknown studio key:", studioKey);
    return res.json({
      results: "This studio isn't configured yet — please contact support."
    });
  }

  const effectiveStudioKey = studioKey || "__legacy__";

  const action = req.body.action || req.query.action;

  if (action === "book_existing_client") {
    const classId = req.body.classId || req.query.classId;
    const firstName = req.body.firstName || req.query.firstName || "";
    const lastName = req.body.lastName || req.query.lastName || "";
    const phone = req.body.phone || req.query.phone || "";
    const email = req.body.email || req.query.email || "";
    const isNewClient = String(req.body.isNewClient || req.query.isNewClient || "").toLowerCase();

    console.log(`[${effectiveStudioKey}] BOOKING REQUEST:`, {
      classId,
      firstName,
      lastName,
      phone,
      email,
      isNewClient
    });

    if (!classId) {
      return res.json({
        results: "I couldn't tell which class you wanted to book — would you like me to try again or connect you with the front desk?"
      });
    }

    if (isNewClient === "true") {
      return res.json({
        results: "New clients need to get started through the intro offer first."
      });
    }

    if (!firstName || !lastName || !phone) {
      return res.json({
        results: "I need your first name, last name, and phone number to complete that booking."
      });
    }

    try {
      const client = await findExistingClient(effectiveStudioKey, studio, {
        firstName,
        lastName,
        phone,
        email
      });

      console.log(`[${effectiveStudioKey}] Client lookup result:`, client ? `FOUND — ID: ${client.Id}, Name: ${client.FirstName} ${client.LastName}` : "NOT FOUND");

      if (!client || !client.Id) {
        return res.json({
          results: "I couldn't find an existing account with that information — would you like me to connect you with the front desk?"
        });
      }

      const resolvedClassId = await resolveBookingClassId(effectiveStudioKey, studio, classId);

      console.log(`[${effectiveStudioKey}] Resolved class ID:`, resolvedClassId !== null ? resolvedClassId : "NOT RESOLVED");

      // Block bookings more than 7 days in advance
      if (resolvedClassId) {
        const today = DateTime.now().setZone(studio.timezone).startOf("day");
        for (let i = 0; i < 8; i++) {
          const d = today.plus({ days: i });
          const iso = d.toFormat("yyyy-MM-dd");
          try {
            const classes = await getClassesForDate(effectiveStudioKey, studio, iso);
            for (const c of classes) {
              if (String(c.id) === String(resolvedClassId)) {
                const classDate = DateTime.fromISO(c.start, { zone: studio.timezone }).startOf("day");
                const daysAhead = classDate.diff(today, "days").days;
                if (daysAhead > 7) {
                  console.log(`[${effectiveStudioKey}] Booking blocked — class is more than 7 days out:`, daysAhead, "days");
                  return res.json({
                    results: "Sorry, bookings can only be made up to 7 days in advance."
                  });
                }
              }
            }
          } catch (err) {
            console.log(`[${effectiveStudioKey}] Date check error:`, err.message);
          }
        }
      }

      if (!resolvedClassId) {
        return res.json({
          results: "I couldn't match that class exactly — would you like me to try again or connect you with the front desk?"
        });
      }

      console.log(`[${effectiveStudioKey}] Attempting to book client`, client.Id, "into class", resolvedClassId);

      const bookingResponse = await bookExistingClientIntoClass(effectiveStudioKey, studio, {
        clientId: client.Id,
        classId: resolvedClassId
      });

      const visits = Array.isArray(bookingResponse?.Visits) ? bookingResponse.Visits : [];
      const visit = bookingResponse?.Visit;
      const bookingAction = bookingResponse?.Action || visit?.Action || "";
      const errorCode = bookingResponse?.ErrorCode;
      const message = bookingResponse?.Message || bookingResponse?.ErrorMessage || "";

      console.log(`[${effectiveStudioKey}] Booking result — visits:`, visits.length, "action:", bookingAction, "errorCode:", errorCode, "message:", message);

      // Success if visits array has entries, OR single Visit object returned with Action: Added
      if ((visits.length > 0 || bookingAction === "Added" || visit) && !errorCode) {
        return res.json({
          results: "You're all set — you're booked."
        });
      }

      const lowerMessage = String(message).toLowerCase();

      if (lowerMessage.includes("already booked")) {
        return res.json({
          results: "It looks like you're already booked into that class."
        });
      }

      if (lowerMessage.includes("waitlist")) {
        return res.json({
          results: "I couldn't complete that booking directly — it looks like that class may only be available by waitlist. Would you like me to connect you with the front desk?"
        });
      }

      if (lowerMessage.includes("payment")) {
        return res.json({
          results: "I couldn't complete that booking because there may be a payment or pass issue on the account. Would you like me to connect you with the front desk?"
        });
      }

      return res.json({
        results: "I couldn't complete that booking — would you like me to try again or connect you with the front desk?"
      });
    } catch (err) {
      console.log(`[${effectiveStudioKey}] BOOKING ERROR:`, err);

      return res.json({
        results: "I couldn't complete that booking — would you like me to try again or connect you with the front desk?"
      });
    }
  }

  if (action !== "get_schedule") {
    return res.json({
      results: "Unsupported action."
    });
  }

  const datePhrase = decodeURIComponent(req.body.date || req.query.date || "today");

  console.log(`[${effectiveStudioKey}] DATE PHRASE RECEIVED:`, datePhrase);

  try {
    const date = parseDate(datePhrase, studio.timezone);
    const iso = dateISO(date);

    let classes = getCache(effectiveStudioKey, iso) || [];

    if (classes.length) {
      console.log(`[${effectiveStudioKey}] CACHE HIT:`, iso);
    } else {
      console.log(`[${effectiveStudioKey}] CACHE MISS:`, iso);

      const raw = await fetchClasses(effectiveStudioKey, studio, iso);
      classes = normalize(raw, studio.timezone);
      setCache(effectiveStudioKey, iso, classes);
    }

    const timeFilter = parseTimeOfDay(datePhrase);

    if (timeFilter && classes.length) {
      classes = classes.filter(c => {
        if (c.localHour === null) return false;
        return c.localHour >= timeFilter.start && c.localHour < timeFilter.end;
      });
    }

    let spokenDate;

    if (datePhrase.toLowerCase().includes("tomorrow")) {
      spokenDate = "tomorrow";
    } else if (datePhrase.toLowerCase().includes("today")) {
      spokenDate = "today";
    } else {
      spokenDate = date.toFormat("cccc, LLLL d");
    }

    const speech = buildSpeech(spokenDate, classes, datePhrase);

    console.log("----- WEBHOOK RESPONSE -----");
    console.log(speech);

    return res.json({
      results: speech
    });
  } catch (err) {
    console.log(`[${effectiveStudioKey}] ERROR:`, err);

    return res.json({
      results: "I'm not able to pull the schedule up right now — would you like me to connect you with the front desk?"
    });
  }
}

/* =========================
ROUTES
========================= */

// Legacy routes — unchanged behavior, still power Roundhouse via env vars
app.post("/ghl/mindbody", handler);
app.get("/ghl/mindbody", handler);

app.post("/ghl/mindbody/speak", handler);
app.get("/ghl/mindbody/speak", handler);

// New multi-studio routes — config comes from STUDIO_CONFIG_JSON
app.post("/ghl/mindbody/:studioKey", handler);
app.get("/ghl/mindbody/:studioKey", handler);

app.post("/ghl/mindbody/speak/:studioKey", handler);
app.get("/ghl/mindbody/speak/:studioKey", handler);

/* =========================
HEALTH CHECK
========================= */

app.get("/debug", (req, res) => {
  res.send("Webhook server alive");
});

/* =========================
START SERVER
========================= */

warmAllCaches();

getMindbodyUserToken("__legacy__", LEGACY_CONFIG)
  .then(() => {
    console.log("Mindbody user token ready for legacy studio");
  })
  .catch(err => {
    console.log("Mindbody user token warmup failed for legacy studio:", err.message);
  });

setInterval(() => {
  warmAllCaches();
}, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
