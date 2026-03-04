const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const API_KEY = process.env.MINDBODY_API_KEY;
const SITE_ID = process.env.MINDBODY_SITE_ID;

const BASE_URL = "https://api.mindbodyonline.com/public/v6";
const LOCATION_ID = "1";

/* ===============================
   HELPERS
=============================== */

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

/* ===============================
   DATE PARSER
=============================== */

function parseDatePhrase(input = "today") {
  input = String(input).toLowerCase().trim();

  console.log("DATE PHRASE RECEIVED:", input);

  const today = new Date();

  if (input === "today") return today;

  if (input === "tomorrow") {
    today.setDate(today.getDate() + 1);
    return today;
  }

  const weekdays = [
    "sunday","monday","tuesday",
    "wednesday","thursday","friday","saturday"
  ];

  if (weekdays.includes(input)) {
    const target = weekdays.indexOf(input);
    const now = today.getDay();

    let delta = (target - now + 7) % 7;

    if (delta === 0) delta = 0;

    today.setDate(today.getDate() + delta);

    return today;
  }

  const parsed = new Date(input);

  if (!isNaN(parsed)) return parsed;

  return today;
}

function toISO(date) {
  return date.toISOString().split("T")[0];
}

function buildWindow(dateISO) {
  return {
    start: `${dateISO}T00:00:00`,
    end: `${dateISO}T23:59:59`
  };
}

/* ===============================
   MINDBODY FETCH
=============================== */

async function fetchClasses(dateISO) {

  const { start, end } = buildWindow(dateISO);

  const url = new URL(`${BASE_URL}/class/classes`);

  url.searchParams.set("StartDateTime", start);
  url.searchParams.set("EndDateTime", end);

  /* FORCE LOCATION FILTER */
  url.searchParams.set("LocationIds", LOCATION_ID);

  console.log("MINDBODY REQUEST:", url.toString());

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": API_KEY,
      SiteId: SITE_ID,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(2500)
  });

  const json = await resp.json();

  console.log("RAW MINDBODY RESPONSE:");
  console.log(JSON.stringify(json, null, 2));

  if (!resp.ok) {
    throw new Error(json?.Error?.Message || "Mindbody error");
  }

  const classes = json.Classes || [];

  console.log("CLASSES FOUND:", classes.length);

  return {
    raw: json,
    classes
  };
}

/* ===============================
   MAIN HANDLER
=============================== */

async function handleSchedule(req, res) {

  const q = req.query || {};
  const b = req.body || {};

  const datePhrase =
    decodeMaybe(
      q.date ??
      b.date ??
      q.datePhrase ??
      b.datePhrase ??
      q.dateParam ??
      b.dateParam ??
      "today"
    );

  try {

    const date = parseDatePhrase(datePhrase);

    const dateISO = toISO(date);

    const schedule = await fetchClasses(dateISO);

    const speech =
      "DEBUG MODE. Raw classes from Mindbody:\n\n" +
      JSON.stringify(schedule.raw, null, 2);

    console.log("SPEECH OUTPUT:");
    console.log(speech);

    res.setHeader("Content-Type", "text/plain; charset=utf-8");

    return res.status(200).send(speech);

  } catch (err) {

    console.log("ERROR:", err.message);

    return res
      .status(200)
      .send("Error retrieving classes from Mindbody.");

  }
}

/* ===============================
   ROUTES (UNCHANGED)
=============================== */

app.post("/ghl/mindbody", handleSchedule);
app.get("/ghl/mindbody", handleSchedule);

app.post("/ghl/mindbody/speak", handleSchedule);
app.get("/ghl/mindbody/speak", handleSchedule);

/* ===============================
   HEALTH CHECK
=============================== */

app.get("/", (_, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
