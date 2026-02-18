import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

const MINDBODY_BASE_URL =
  process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

const siteId = (process.env.MINDBODY_SITE_ID || "").trim();
const apiKey = (process.env.MINDBODY_API_KEY || "").trim();
const sourceName = (process.env.MINDBODY_SOURCE_NAME || "").trim();
const sourcePassword = (process.env.MINDBODY_SOURCE_PASSWORD || "").trim();

const STUDIO_TZ = "America/Vancouver";

function ok(res, results = {}) {
  return res.status(200).json({ success: true, results });
}

function fail(res, message) {
  return res.status(200).json({
    success: false,
    message,
    results: { say: "", text: "" },
  });
}

function safeJsonParse(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : x;
  } catch {
    return null;
  }
}

function getIncomingParams(req) {
  const q = { ...(req.query || {}) };
  let b = req.body && typeof req.body === "object" ? { ...req.body } : {};

  const maybeArgs =
    req.body?.message?.toolCallList?.[0]?.function?.arguments ??
    req.body?.message?.toolCalls?.[0]?.function?.arguments ??
    req.body?.toolCallList?.[0]?.function?.arguments ??
    req.body?.toolCalls?.[0]?.function?.arguments ??
    null;

  if (maybeArgs) {
    const parsed = typeof maybeArgs === "string" ? safeJsonParse(maybeArgs) : maybeArgs;
    if (parsed && typeof parsed === "object") b = { ...b, ...parsed };
  }

  if (b.params && typeof b.params === "object") {
    b = { ...b.params, ...b };
    delete b.params;
  }

  return { ...q, ...b };
}

async function mbFetch(path, { method = "GET", query } = {}) {
  if (!siteId || !apiKey || !sourceName || !sourcePassword) {
    throw new Error("Missing Mindbody ENV variables");
  }

  const url = new URL(`${MINDBODY_BASE_URL}${path}`);

  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    });
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
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
    throw new Error(`Mindbody API error: ${text}`);
  }

  return json;
}

function format12h(hour, minute) {
  const ampm = hour >= 12 ? "PM" : "AM";
  let hr = hour % 12;
  if (hr === 0) hr = 12;
  return `${hr}:${String(minute).padStart(2, "0")} ${ampm}`;
}

function parseISO(iso) {
  if (!iso) return null;
  const parts = iso.split("T");
  if (parts.length < 2) return null;
  const time = parts[1].split(":");
  return { hour: Number(time[0]), minute: Number(time[1]) };
}

function resolveDate(raw) {
  if (!raw) return null;

  const today = new Date();
  const tzToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: STUDIO_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(today);

  if (raw.toLowerCase() === "today") return tzToday;

  if (raw.toLowerCase() === "tomorrow") {
    const t = new Date(today);
    t.setDate(t.getDate() + 1);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: STUDIO_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t);
  }

  return raw;
}

app.all("/mb/schedule", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/schedule", params);

  try {
    const datePhrase = params.date;
    if (!datePhrase) return fail(res, "Missing date");

    const date = resolveDate(datePhrase);
    if (!date) return fail(res, "Invalid date");

    const startLocal = `${date}T00:00:00`;
    const endLocal = `${date}T23:59:59`;

    const data = await mbFetch("/class/classes", {
      method: "GET",
      query: {
        StartDateTime: startLocal,
        EndDateTime: endLocal,
        LocationIds: "1",
      },
    });

    const classes = (data?.Classes || []).map((c) => {
      const name = c.ClassDescription?.Name ?? c.Name ?? "Class";
      const instructor =
        c.Staff?.Name ||
        `${c.Staff?.FirstName || ""} ${c.Staff?.LastName || ""}`.trim() ||
        null;

      const parsed = parseISO(c.StartDateTime);
      const time = parsed ? format12h(parsed.hour, parsed.minute) : "";

      const bucket =
        parsed?.hour < 12
          ? "morning"
          : parsed?.hour < 17
          ? "afternoon"
          : "evening";

      return { name, instructor, time, bucket };
    });

    const timeRange = (params.time_range || "").toLowerCase().trim();
    const filtered = timeRange
      ? classes.filter((c) => c.bucket === timeRange)
      : classes;

    const grouped = { morning: [], afternoon: [], evening: [] };
    filtered.forEach((c) => grouped[c.bucket]?.push(c));

    const maxPerBucket = 5;

    const buildLine = (bucket) => {
      if (!grouped[bucket].length) return "";
      const items = grouped[bucket]
        .slice(0, maxPerBucket)
        .map(
          (c) =>
            `${c.time} ${c.name}${
              c.instructor ? ` with ${c.instructor}` : ""
            }`
        )
        .join(" | ");
      return `${bucket[0].toUpperCase() + bucket.slice(1)}: ${items}`;
    };

    const parts = [];
    if (!timeRange) {
      ["morning", "afternoon", "evening"].forEach((b) => {
        const line = buildLine(b);
        if (line) parts.push(line);
      });
    } else {
      const line = buildLine(timeRange);
      if (line) parts.push(line);
    }

    const say =
      parts.length === 0
        ? `No classes found for ${date}.`
        : `Classes for ${date}. ${parts.join(" ")}`;

    return ok(res, { say, text: say });
  } catch (e) {
    console.error("ERROR:", e);
    return fail(res, e.message);
  }
});

app.listen(process.env.PORT || 3000, () =>
  console.log("Server running")
);




