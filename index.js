/**
 * Flow AI – Mindbody Webhook (Production Ready)
 *
 * Actions:
 *   - ping
 *   - get_schedule
 *   - book_class
 *
 * ENV (Railway):
 *   MINDBODY_MODE=mock|live
 *   MINDBODY_API_KEY
 *   MINDBODY_SITE_ID
 *   MINDBODY_BASE_URL
 */

const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

/* ===============================
   Helpers
================================= */

function respondJSON(res, payload) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.status(200).send(JSON.stringify(payload));
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) return null;
  return String(v).trim();
}

function getMindbodyConfig() {
  return {
    mode: (requireEnv("MINDBODY_MODE") || "live").toLowerCase(),
    apiKey: requireEnv("MINDBODY_API_KEY"),
    siteId: requireEnv("MINDBODY_SITE_ID"),
    baseUrl:
      requireEnv("MINDBODY_BASE_URL") ||
      "https://api.mindbodyonline.com/public/v6",
  };
}

function buildSpokenDateLabel(dateISO, timeZone) {
  const dt = new Date(dateISO + "T12:00:00Z");
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dt);
}

function normalizeMindbodyClasses(rawClasses) {
  const out = [];

  for (const c of rawClasses || []) {
    out.push({
      id: c?.Id,
      name: c?.ClassDescription?.Name || c?.Name || "Class",
      time: new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(c?.StartDateTime)),
      instructor: c?.Staff?.Name || "",
      bookable: true,
    });
  }

  return out;
}

/* ===============================
   Mindbody Calls
================================= */

async function fetchSchedule(cfg, dateISO) {
  const url = new URL(`${cfg.baseUrl}/class/classes`);
  url.searchParams.set("StartDateTime", `${dateISO}T00:00:00`);
  url.searchParams.set("EndDateTime", `${dateISO}T23:59:59`);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }

  if (!resp.ok) {
    throw new Error(`Schedule error (${resp.status}): ${text}`);
  }

  return normalizeMindbodyClasses(json?.Classes || []);
}

async function findClientByEmail(cfg, email) {
  const url = new URL(`${cfg.baseUrl}/client/clients`);
  url.searchParams.set("SearchText", email);

  const resp = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }

  if (!resp.ok) {
    throw new Error(`Client search error (${resp.status}): ${text}`);
  }

  return json?.Clients?.length ? json.Clients[0] : null;
}

async function createClient(cfg, firstName, lastName, email, phone) {
  const resp = await fetch(`${cfg.baseUrl}/client/addclient`, {
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
      MobilePhone: phone,
    }),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }

  if (!resp.ok) {
    throw new Error(`Client create error (${resp.status}): ${text}`);
  }

  return json?.Client;
}

async function bookClientIntoClass(cfg, classId, clientId) {
  const resp = await fetch(`${cfg.baseUrl}/class/addclienttoclass`, {
    method: "POST",
    headers: {
      "Api-Key": cfg.apiKey,
      "SiteId": cfg.siteId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ClientId: clientId,
      ClassId: classId,
    }),
  });

  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }

  if (!resp.ok) {
    throw new Error(`Booking error (${resp.status}): ${text}`);
  }

  return json;
}

/* ===============================
   Routes
================================= */

app.post("/ghl/mindbody", async (req, res) => {
  const { action } = req.body;

  const cfg = getMindbodyConfig();

  try {

    if (action === "ping") {
      return respondJSON(res, {
        success: true,
        say: "pong",
        text: "pong",
      });
    }

    if (action === "get_schedule") {
      const { date, timezone = "America/Vancouver" } = req.body;

      const classes = await fetchSchedule(cfg, date);

      const spokenDate = buildSpokenDateLabel(date, timezone);

      const say = classes.length
        ? `Here are the classes for ${spokenDate}: ${classes.map(c => `${c.time} — ${c.name}`).join(", ")}. Which class would you like to book?`
        : `No classes found for ${spokenDate}.`;

      return respondJSON(res, {
        success: true,
        say,
        text: say,
        data: { classes },
      });
    }

    if (action === "book_class") {
      const { classId, firstName, lastName, email, phone } = req.body;

      if (!classId || !firstName || !lastName || !email || !phone) {
        throw new Error("Missing required booking fields.");
      }

      let client = await findClientByEmail(cfg, email);
      let isNewClient = false;

      if (!client) {
        client = await createClient(cfg, firstName, lastName, email, phone);
        isNewClient = true;
      }

      await bookClientIntoClass(cfg, classId, client.Id);

      return respondJSON(res, {
        success: true,
        say: "You're booked!",
        text: "You're booked!",
        data: {
          classId,
          clientId: client.Id,
          isNewClient,
        },
      });
    }

    return respondJSON(res, {
      success: false,
      error: "Unknown action.",
    });

  } catch (err) {
    return respondJSON(res, {
      success: false,
      error: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
