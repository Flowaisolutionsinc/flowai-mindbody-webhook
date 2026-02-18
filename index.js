import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * --- CORS / Preflight ---
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

/**
 * ============
 * CONFIG / ENV
 * ============
 */
const MINDBODY_BASE_URL =
  process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

const siteId = (process.env.MINDBODY_SITE_ID || "").trim();
const apiKey = (process.env.MINDBODY_API_KEY || "").trim();
const sourceName = (process.env.MINDBODY_SOURCE_NAME || "").trim();
const sourcePassword = (process.env.MINDBODY_SOURCE_PASSWORD || "").trim();

const DEFAULT_LOCATION_ID = (process.env.MINDBODY_DEFAULT_LOCATION_ID || "1").trim();
const DEFAULT_LOCATION_IDS = (process.env.MINDBODY_DEFAULT_LOCATION_IDS || "").trim();

const DEBUG_MODE = String(process.env.DEBUG_MODE || "").toLowerCase() === "true";
const STUDIO_TZ = process.env.TZ || "America/Vancouver";

/**
 * ===========================
 * IMPORTANT RESPONSE RULE
 * ===========================
 * DO NOT NEST results.* at all.
 * Only return TOP-LEVEL:
 * - success
 * - say
 * - text
 * plus optional metadata fields.
 */
function sendOk(res, payload) {
  return res.status(200).json(payload);
}

function okSpeak(res, say, extra = {}) {
  const speech = (say || "").toString();
  return sendOk(res, { success: true, say: speech, text: speech, ...extra });
}

function failSpeak(res, say, extra = {}) {
  const speech = (say || "").toString();
  return sendOk(res, { success: false, say: speech, text: speech, ...extra });
}

/**
 * ============
 * DATE HELPERS (TZ-SAFE)
 * ============
 */
function nowInTZDateString(tz = STUDIO_TZ) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

function addDaysYYYYMMDD(yyyyMmDd, daysToAdd) {
  const [y, m, d] = yyyyMmDd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + daysToAdd);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

const WEEKDAY_MAP = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

function tzWeekdayIndex(tz = STUDIO_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value?.toLowerCase();
  return WEEKDAY_MAP[wd] ?? null;
}

function looksLikeYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function resolveDateInput(raw, tz = STUDIO_TZ) {
  if (!raw) return nowInTZDateString(tz);

  const s0 = String(raw).trim();
  const s = s0.toLowerCase().trim();
  if (!s) return nowInTZDateString(tz);

  if (looksLikeYYYYMMDD(s)) return s;

  if (s === "today") return nowInTZDateString(tz);
  if (s === "tomorrow") return addDaysYYYYMMDD(nowInTZDateString(tz), 1);

  const thisPrefix = s.startsWith("this ");
  const nextPrefix = s.startsWith("next ");
  const weekdayToken = nextPrefix ? s.slice(5).trim() : thisPrefix ? s.slice(5).trim() : s;

  if (WEEKDAY_MAP[weekdayToken] !== undefined) {
    const todayIdx = tzWeekdayIndex(tz);
    if (todayIdx === null) return null;

    const targetIdx = WEEKDAY_MAP[weekdayToken];
    let delta = (targetIdx - todayIdx + 7) % 7;

    if (nextPrefix) {
      if (delta === 0) delta = 7;
      else delta += 7;
    }

    return addDaysYYYYMMDD(nowInTZDateString(tz), delta);
  }

  // Remove ordinal suffixes: 17th -> 17
  const cleaned = s0.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(parsed);

    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  }

  // e.g. "the 17th"
  const m = s.match(/(?:the\s*)?(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const today = nowInTZDateString(tz);
    const [yy, mm] = today.split("-");
    const dd = String(Number(m[1])).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  return null;
}

/**
 * ============
 * MISC HELPERS
 * ============
 */
function safeJsonParse(x) {
  try {
    return typeof x === "string" ? JSON.parse(x) : x;
  } catch {
    return null;
  }
}

function normalizeArray(payload, keys = []) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  for (const k of keys) {
    if (Array.isArray(payload[k])) return payload[k];
  }
  if (Array.isArray(payload.Results)) return payload.Results;
  return [];
}

function toLowerClean(x) {
  return (x ?? "").toString().toLowerCase().trim();
}

function parseNaiveISO(iso) {
  if (!iso || typeof iso !== "string") return null;
  const parts = iso.split("T");
  if (parts.length < 2) return null;
  const hm = parts[1].split(":");
  const hour = Number(hm[0]);
  const minute = Number(hm[1] || "0");
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute };
}

function format12h(hour, minute) {
  const h = Number(hour);
  const m = Number(minute);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
  const ampm = h >= 12 ? "PM" : "AM";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  const mm = String(m).padStart(2, "0");
  return `${hr}:${mm} ${ampm}`;
}

function timeBucketFromHour(hour) {
  if (!Number.isFinite(hour)) return "";
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function localDayRange(dateStr) {
  return {
    startLocal: `${dateStr}T00:00:00`,
    endLocal: `${dateStr}T23:59:59`,
  };
}

function resolveLocationQuery(params) {
  const locationId = (params.location_id || params.locationId || "").toString().trim();
  const locationIds = (params.location_ids || params.locationIds || "").toString().trim();

  if (locationIds) return { LocationIds: locationIds };
  if (locationId) return { LocationIds: locationId };

  if (DEFAULT_LOCATION_IDS) return { LocationIds: DEFAULT_LOCATION_IDS };
  if (DEFAULT_LOCATION_ID) return { LocationIds: DEFAULT_LOCATION_ID };

  return {};
}

async function mbFetch(path, { method = "GET", query, body } = {}) {
  if (!siteId || !apiKey || !sourceName || !sourcePassword) {
    throw new Error(
      `Missing ENV. hasSiteId=${Boolean(siteId)} hasApiKey=${Boolean(apiKey)} hasSourceName=${Boolean(
        sourceName
      )} hasSourcePassword=${Boolean(sourcePassword)}`
    );
  }

  const url = new URL(`${MINDBODY_BASE_URL}${path}`);
  if (query && typeof query === "object") {
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null || v === "") return;
      url.searchParams.set(k, String(v));
    });
  }

  const headers = {
    "Content-Type": "application/json",
    "Api-Key": apiKey,
    SiteId: siteId,
    "Source-Name": sourceName,
    Password: sourcePassword,
    SourcePassword: sourcePassword,
  };

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) {
    const detail = json || (text ? { raw: text.slice(0, 700) } : { raw: "(no response body)" });
    throw new Error(
      `Mindbody API error ${res.status} ${res.statusText} at ${path}: ${JSON.stringify(detail)}`
    );
  }

  return json ?? { raw: text };
}

function getIncomingParams(req) {
  // For GET custom actions this is basically req.query
  const q = { ...(req.query || {}) };
  let b = req.body && typeof req.body === "object" ? { ...req.body } : {};

  // Some runners send { params: {...} }
  if (b.params && typeof b.params === "object") {
    b = { ...b.params, ...b };
    delete b.params;
  }

  return { ...q, ...b };
}

/**
 * ============
 * HEALTH
 * ============
 */
app.get("/", (req, res) => res.status(200).send("Flow AI Mindbody webhook is running"));

app.get("/health", (req, res) => {
  return sendOk(res, {
    success: true,
    say: "OK",
    text: "OK",
    env: {
      hasSiteId: Boolean(siteId),
      hasApiKey: Boolean(apiKey),
      hasSourceName: Boolean(sourceName),
      hasSourcePassword: Boolean(sourcePassword),
      baseUrl: MINDBODY_BASE_URL,
      tz: STUDIO_TZ,
      defaultLocationId: DEFAULT_LOCATION_ID,
      defaultLocationIds: DEFAULT_LOCATION_IDS || null,
      debugMode: DEBUG_MODE,
    },
  });
});

/**
 * ============
 * ENDPOINTS
 * ============
 */

// 1) LOCATIONS
app.all("/mb/locations", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/locations", { method: req.method, url: req.originalUrl, params });

  try {
    const data = await mbFetch("/site/locations", { method: "GET" });
    const locations = normalizeArray(data, ["Locations", "locations"]);

    return okSpeak(
      res,
      `Found ${locations.length} locations.`,
      {
        count: locations.length,
        locations: locations.map((l) => ({
          id: l.Id ?? l.LocationId ?? null,
          name: l.Name ?? l.LocationName ?? null,
          address: l.Address ?? null,
          city: l.City ?? null,
          stateProv: l.StateProvCode ?? l.State ?? null,
        })),
      }
    );
  } catch (e) {
    return failSpeak(res, "Sorry, I couldn't access locations right now.", {
      error: DEBUG_MODE ? String(e?.message || e) : undefined,
    });
  }
});

// 2) SCHEDULE (TOP-LEVEL say/text ONLY, SMALL OUTPUT, OPTIONAL time_range)
app.all("/mb/schedule", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/schedule", { method: req.method, url: req.originalUrl, params });

  try {
    const rawDateInput = params.date || params.day || params.requested_day || params.requestedDate;
    const date = resolveDateInput(rawDateInput, STUDIO_TZ);

    if (!date) {
      return failSpeak(
        res,
        "Sorry — I couldn’t understand that date. Could you say today, tomorrow, or a specific date?",
        { received: { date: rawDateInput } }
      );
    }

    const timeRange = toLowerClean(params.time_range); // morning/afternoon/evening optional
    const { startLocal, endLocal } = localDayRange(date);
    const locationQuery = resolveLocationQuery(params);

    const data = await mbFetch("/class/classes", {
      method: "GET",
      query: { StartDateTime: startLocal, EndDateTime: endLocal, ...locationQuery },
    });

    const classesRaw = normalizeArray(data, ["Classes", "classes"]);

    // Map to minimal fields
    let classes = classesRaw.map((c) => {
      const name = c.ClassDescription?.Name ?? c.Name ?? "Class";
      const startDateTime = c.StartDateTime ?? null;

      let instructor = c.Staff?.Name ?? c.InstructorName ?? "";
      if (!instructor && c.Staff) {
        const first = c.Staff.FirstName || "";
        const last = c.Staff.LastName || "";
        instructor = [first, last].filter(Boolean).join(" ").trim();
      }

      const st = parseNaiveISO(startDateTime);
      const startTimeLocal = st ? format12h(st.hour, st.minute) : "";
      const bucket = st ? timeBucketFromHour(st.hour) : "";

      return { name, instructor, startTimeLocal, bucket };
    });

    // Optional bucket filter
    if (timeRange && ["morning", "afternoon", "evening"].includes(timeRange)) {
      classes = classes.filter((x) => x.bucket === timeRange);
    }

    // SMALL RESULT (this is the entire point)
    const onlySay = String(params.onlySay || params.only_say || "").trim().toLowerCase();
    const limit = 6; // keep tiny for voice tools

    const list = classes
      .slice(0, limit)
      .map((c) => {
        const withInstructor = c.instructor ? ` with ${c.instructor}` : "";
        return `${c.startTimeLocal} ${c.name}${withInstructor}`.trim();
      })
      .filter(Boolean)
      .join(" | ");

    const say =
      classes.length === 0
        ? `No classes found for ${date}${timeRange ? ` in the ${timeRange}` : ""}.`
        : `Classes for ${date}${timeRange ? ` (${timeRange})` : ""}: ${list}`;

    // Return only say/text (NO nesting)
    // If onlySay=1, do NOT include big arrays
    if (onlySay === "1" || onlySay === "true") {
      return okSpeak(res, say, {
        date,
        timezone: STUDIO_TZ,
      });
    }

    // If not onlySay, include a small structured list (still minimal)
    return okSpeak(res, say, {
      date,
      timezone: STUDIO_TZ,
      appliedLocationFilter: locationQuery,
      classes: classes.map(({ bucket, ...rest }) => rest),
      debug: DEBUG_MODE ? { rawCount: classesRaw.length, receivedParams: params, rawDateInput } : undefined,
    });
  } catch (e) {
    return failSpeak(res, "Sorry, I couldn't access the schedule right now.", {
      error: DEBUG_MODE ? String(e?.message || e) : undefined,
    });
  }
});

// 3) PRICING (kept simple; still top-level say/text only)
app.all("/mb/pricing", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/pricing", { method: req.method, url: req.originalUrl, params });

  try {
    const [servicesResp, packagesResp, contractsResp] = await Promise.allSettled([
      mbFetch("/sale/services", { method: "GET" }),
      mbFetch("/sale/packages", { method: "GET" }),
      mbFetch("/sale/contracts", { method: "GET" }),
    ]);

    const services =
      servicesResp.status === "fulfilled" ? normalizeArray(servicesResp.value, ["Services", "services"]) : [];
    const packages =
      packagesResp.status === "fulfilled" ? normalizeArray(packagesResp.value, ["Packages", "packages"]) : [];
    const contracts =
      contractsResp.status === "fulfilled" ? normalizeArray(contractsResp.value, ["Contracts", "contracts"]) : [];

    // Keep speech short
    const say = "I pulled pricing successfully. What are you looking for — intro offers, drop-ins, or memberships?";

    return okSpeak(res, say, {
      offers: DEBUG_MODE ? { services, packages, contracts } : undefined,
    });
  } catch (e) {
    return failSpeak(res, "Sorry, I couldn't access pricing right now.", {
      error: DEBUG_MODE ? String(e?.message || e) : undefined,
    });
  }
});

// 4) BOOK (existing-client only in this version)
app.all("/mb/book", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/book", { method: req.method, url: req.originalUrl, params });

  try {
    const classId = params.class_id || params.classId;
    if (!classId) return failSpeak(res, "Missing class_id.");

    const clientId = params.client_id || params.clientId;
    if (!clientId) return failSpeak(res, "Missing client_id (existing client required).");

    const bookResp = await mbFetch("/class/addclienttoclass", {
      method: "POST",
      body: { ClientId: clientId, ClassId: classId, RequirePayment: false },
    });

    return okSpeak(res, "Booked successfully.", {
      booked: true,
      clientId: String(clientId),
      classId: String(classId),
      raw: DEBUG_MODE ? bookResp : undefined,
    });
  } catch (e) {
    return failSpeak(res, "Sorry, I couldn't complete that booking right now.", {
      error: DEBUG_MODE ? String(e?.message || e) : undefined,
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));


