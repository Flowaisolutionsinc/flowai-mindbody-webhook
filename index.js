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
      const start = DateTime.fromISO(c.StartDateTime, { zone: STUDIO_TIMEZONE });
      const time = start.isValid ? start.toFormat("h:mm a") : "Time unavailable";

      return {
        id: c.Id,
        name: c.ClassDescription?.Name || c.Name || "Class",
        instructor: c.Staff?.Name || "Instructor",
        time,
        start: c.StartDateTime
      };
    })
    .sort((a, b) => {
      const aStart = DateTime.fromISO(a.start, { zone: STUDIO_TIMEZONE }).toMillis();
      const bStart = DateTime.fromISO(b.start, { zone: STUDIO_TIMEZONE }).toMillis();
      return aStart - bStart;
    });
}

/* =========================
SPEECH BUILDER
========================= */

function buildSpeech(dateLabel, classes, datePhrase) {
  if (!classes || classes.length === 0) {
    return `I couldn't find any classes for ${datePhrase}.`;
  }

  const MAX_CLASSES = 6;

  const list = classes
    .slice(0, MAX_CLASSES)
    .map(c => `${c.time} ${c.name} with ${c.instructor}`);

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
        if (!c.start) return false;

        const start = DateTime.fromISO(c.start, { zone: STUDIO_TIMEZONE });
        if (!start.isValid) return false;

        const hour = start.hour;
        return hour >= timeFilter.start && hour < timeFilter.end;
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
