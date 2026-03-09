const express = require("express");
const { DateTime } = require("luxon");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const API_KEY = process.env.MINDBODY_API_KEY;
const SITE_ID = process.env.MINDBODY_SITE_ID;

const LOCATION_ID = "1";
const BASE_URL = "https://api.mindbodyonline.com/public/v6";
const STUDIO_TIMEZONE = "America/Vancouver";

/* =========================
CACHE
========================= */

const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

/* =========================
DATE PARSER
========================= */

function parseDate(input = "today") {
  input = decodeURIComponent(input).toLowerCase().trim();
  input = input.replace(/(\d+)(st|nd|rd|th)/g, "$1");

  const today = DateTime.now().setZone(STUDIO_TIMEZONE).startOf("day");

  if (input.includes("today")) {
    return today;
  }

  if (input.includes("tomorrow")) {
    return today.plus({ days: 1 });
  }

  const weekdays = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
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
    let parsed = DateTime.fromFormat(input, fmt, { zone: STUDIO_TIMEZONE });

    if (parsed.isValid) {
      if (!/\b\d{4}\b/.test(input)) {
        parsed = parsed.set({ year: today.year });
      }
      return parsed.startOf("day");
    }
  }

  const jsParsed = new Date(input);
  if (!isNaN(jsParsed)) {
    let parsed = DateTime.fromJSDate(jsParsed).setZone(STUDIO_TIMEZONE).startOf("day");

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

  if (text.includes("morning")) {
    return { start: 0, end: 12 };
  }

  if (text.includes("afternoon")) {
    return { start: 12, end: 17 };
  }

  if (text.includes("evening")) {
    return { start: 17, end: 24 };
  }

  if (text.includes("night")) {
    return { start: 19, end: 24 };
  }

  return null;
}

/* =========================
MINDBODY HELPERS
========================= */

async function mindbodyGet(path, query = {}) {
  const url = new URL(`${BASE_URL}${path}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.append(key, String(value));
    }
  });

  console.log("Mindbody GET:", url.toString());

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": API_KEY,
      "SiteId": SITE_ID,
      "Content-Type": "application/json"
    }
  });

  const text = await res.text();

  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    console.log("Mindbody GET error:", res.status, json);
    throw new Error(`Mindbody GET failed: ${res.status}`);
  }

  return json;
}

async function mindbodyPost(path, body = {}) {
  const url = `${BASE_URL}${path}`;

  console.log("Mindbody POST:", url);
  console.log("Mindbody POST body:", body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Api-Key": API_KEY,
      "SiteId": SITE_ID,
      "Content-Type": "application/json"
    },
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
    console.log("Mindbody POST error:", res.status, json);
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

async function findExistingClient({ firstName, lastName, phone, email }) {
  const searchTerms = [];

  if (phone) searchTerms.push(phone);
  if (email) searchTerms.push(email);
  if (firstName || lastName) searchTerms.push(`${firstName || ""} ${lastName || ""}`.trim());

  let allClients = [];

  for (const term of searchTerms) {
    try {
      const json = await mindbodyGet("/client/clients", {
        SearchText: term
      });

      const clients = Array.isArray(json?.Clients) ? json.Clients : [];
      allClients = allClients.concat(clients);
    } catch (err) {
      console.log("Client search failed for term:", term, err.message);
    }
  }

  // Deduplicate by client ID
  const uniqueClients = [];
  const seen = new Set();

  for (const client of allClients) {
    const id = client?.Id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniqueClients.push(client);
  }

  // Strongest match first: phone + name
  let matched = uniqueClients.find(client =>
    phoneMatches(client, phone) && namesMatch(client, firstName, lastName)
  );

  if (matched) return matched;

  // Next best: email + name
  matched = uniqueClients.find(client =>
    emailMatches(client, email) && namesMatch(client, firstName, lastName)
  );

  if (matched) return matched;

  // Next: phone only
  matched = uniqueClients.find(client => phoneMatches(client, phone));
  if (matched) return matched;

  // Last: email only
  matched = uniqueClients.find(client => emailMatches(client, email));
  if (matched) return matched;

  return null;
}

async function bookExistingClientIntoClass({ clientId, classId }) {
  const payload = {
    ClientID: clientId,
    ClassID: classId,
    Waitlist: false,
    SendEmail: false,
    Test: false,
    RequirePayment: false
  };

  const json = await mindbodyPost("/class/addclienttoclass", payload);

  console.log("AddClientToClass response:", json);

  return json;
}

/* =========================
FETCH MINDBODY CLASSES
========================= */

async function fetchClasses(date) {
  const start = `${date}T00:00:00`;
  const end = `${date}T23:59:59`;

  const url =
    `${BASE_URL}/class/classes?StartDateTime=${start}&EndDateTime=${end}&LocationIds=${LOCATION_ID}`;

  console.log("Mindbody request:", url);

  const res = await fetch(url, {
    headers: {
      "Api-Key": API_KEY,
      "SiteId": SITE_ID
    }
  });

  const json = await res.json();

  return json.Classes || [];
}

/* =========================
NORMALIZE CLASSES
========================= */

function normalize(classes) {
  return classes
    .map(c => {
      const localStart = DateTime.fromISO(c.StartDateTime, { setZone: true }).setZone(STUDIO_TIMEZONE);

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
CACHE HELPERS
========================= */

function getCache(date) {
  const entry = cache.get(date);

  if (!entry) return null;

  if (Date.now() - entry.time > CACHE_TTL) {
    cache.delete(date);
    return null;
  }

  return entry.data;
}

function setCache(date, data) {
  cache.set(date, {
    data,
    time: Date.now()
  });
}

/* =========================
CACHE WARMER
========================= */

async function warmCache() {
  console.log("Warming schedule cache...");

  const today = DateTime.now().setZone(STUDIO_TIMEZONE).startOf("day");

  for (let i = 0; i < 7; i++) {
    const d = today.plus({ days: i });
    const iso = d.toFormat("yyyy-MM-dd");

    try {
      const raw = await fetchClasses(iso);
      const classes = normalize(raw);

      setCache(iso, classes);

      console.log("Cache updated:", iso);
    } catch (err) {
      console.log("Cache warm error:", err.message);
    }
  }
}

/* =========================
WEBHOOK HANDLER
========================= */

async function handler(req, res) {
  console.log("----- WEBHOOK REQUEST -----");
  console.log("Body:", req.body);
  console.log("Query:", req.query);

  const action = req.body.action || req.query.action;

  /* =========================
  EXISTING CLIENT BOOKING
  ========================= */

  if (action === "book_existing_client") {
    const classId = req.body.classId || req.query.classId;
    const firstName = req.body.firstName || req.query.firstName || "";
    const lastName = req.body.lastName || req.query.lastName || "";
    const phone = req.body.phone || req.query.phone || "";
    const email = req.body.email || req.query.email || "";
    const isNewClient = String(req.body.isNewClient || req.query.isNewClient || "").toLowerCase();

    console.log("BOOKING REQUEST:", {
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
      const client = await findExistingClient({
        firstName,
        lastName,
        phone,
        email
      });

      if (!client || !client.Id) {
        return res.json({
          results: "I couldn't find an existing account with that information — would you like me to connect you with the front desk?"
        });
      }

      const bookingResponse = await bookExistingClientIntoClass({
        clientId: client.Id,
        classId
      });

      const visits = Array.isArray(bookingResponse?.Visits) ? bookingResponse.Visits : [];
      const errorCode = bookingResponse?.ErrorCode;
      const message = bookingResponse?.Message || bookingResponse?.ErrorMessage || "";

      if (visits.length > 0 && !errorCode) {
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
        results: "I couldn't complete that booking — would you like me to try a different time or connect you with the front desk?"
      });
    } catch (err) {
      console.log("BOOKING ERROR:", err);

      return res.json({
        results: "I couldn't complete that booking — would you like me to try a different time or connect you with the front desk?"
      });
    }
  }

  /* =========================
  SCHEDULE
  ========================= */

  if (action !== "get_schedule") {
    return res.json({
      results: "Unsupported action."
    });
  }

  const datePhrase = decodeURIComponent(
    req.body.date || req.query.date || "today"
  );

  console.log("DATE PHRASE RECEIVED:", datePhrase);

  try {
    const date = parseDate(datePhrase);
    const iso = dateISO(date);

    let classes = getCache(iso) || [];

    if (classes.length) {
      console.log("CACHE HIT:", iso);
    } else {
      console.log("CACHE MISS:", iso);

      const raw = await fetchClasses(iso);
      classes = normalize(raw);

      setCache(iso, classes);
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
    console.log("ERROR:", err);

    return res.json({
      results:
        "I'm not able to pull the schedule up right now — would you like me to connect you with the front desk?"
    });
  }
}

/* =========================
ROUTES
========================= */

app.post("/ghl/mindbody", handler);
app.get("/ghl/mindbody", handler);

app.post("/ghl/mindbody/speak", handler);
app.get("/ghl/mindbody/speak", handler);

/* =========================
HEALTH CHECK
========================= */

app.get("/debug", (req, res) => {
  res.send("Webhook server alive");
});

/* =========================
START SERVER
========================= */

warmCache();

setInterval(() => {
  warmCache();
}, 15 * 60 * 1000);

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
