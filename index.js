import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const MINDBODY_BASE_URL =
  process.env.MINDBODY_BASE_URL ||
  "https://api.mindbodyonline.com/public/v6";

const siteId = process.env.MINDBODY_SITE_ID;
const apiKey = process.env.MINDBODY_API_KEY;
const sourceName = process.env.MINDBODY_SOURCE_NAME;
const sourcePassword = process.env.MINDBODY_SOURCE_PASSWORD;

const STUDIO_TZ = "America/Vancouver";

function safeJsonParse(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : x;
  } catch {
    return null;
  }
}

async function mbFetch(path, { query } = {}) {
  const url = new URL(`${MINDBODY_BASE_URL}${path}`);

  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null)
        url.searchParams.set(k, String(v));
    });
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Api-Key": apiKey,
      SiteId: siteId,
      "Source-Name": sourceName,
      Password: sourcePassword,
      SourcePassword: sourcePassword,
    },
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) {
    throw new Error(
      `Mindbody API error ${res.status}: ${JSON.stringify(json)}`
    );
  }

  return json;
}

function normalizeArray(payload, keys = []) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  return [];
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: STUDIO_TZ,
  });
}

function resolveDateInput(raw) {
  if (!raw) return new Date().toISOString().split("T")[0];

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime()))
    return parsed.toISOString().split("T")[0];

  const today = new Date();
  if (raw.toLowerCase() === "today")
    return today.toISOString().split("T")[0];

  if (raw.toLowerCase() === "tomorrow") {
    today.setDate(today.getDate() + 1);
    return today.toISOString().split("T")[0];
  }

  return today.toISOString().split("T")[0];
}

app.get("/health", (req, res) => {
  return res.json({
    success: true,
    results: { ok: true },
  });
});

app.get("/mb/schedule", async (req, res) => {
  try {
    const rawDate = req.query.date;
    const locationId = req.query.location_id || "1";

    const date = resolveDateInput(rawDate);

    const start = `${date}T00:00:00`;
    const end = `${date}T23:59:59`;

    const data = await mbFetch("/class/classes", {
      query: {
        StartDateTime: start,
        EndDateTime: end,
        LocationIds: locationId,
      },
    });

    const classesRaw = normalizeArray(data, ["Classes"]);

    const classes = classesRaw.map((c) => ({
      classId: c.Id,
      name: c.ClassDescription?.Name,
      startDateTime: c.StartDateTime,
      startTimeLocal: formatTime(c.StartDateTime),
      instructor: c.Staff?.Name || "",
    }));

    const say =
      classes.length === 0
        ? `No classes found for ${date}.`
        : `Classes for ${date}: ` +
          classes
            .map(
              (c) =>
                `${c.startTimeLocal} ${c.name}${
                  c.instructor ? ` with ${c.instructor}` : ""
                }`
            )
            .join(" | ");

    return res.status(200).json({
      success: true,
      results: {
        date,
        timezone: STUDIO_TZ,
        say,
        text: say,
        classes,
      },
    });
  } catch (e) {
    return res.status(200).json({
      success: false,
      results: {
        say: "Sorry — I couldn’t access the schedule.",
        error: e.message,
      },
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

