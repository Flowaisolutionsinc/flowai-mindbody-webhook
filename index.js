import express from "express";
import { DateTime } from "luxon";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * --- CORS / Preflight (helps dashboards + browsers) ---
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

const siteId = process.env.MINDBODY_SITE_ID || "";
const apiKey = process.env.MINDBODY_API_KEY || "";
const sourceName = process.env.MINDBODY_SOURCE_NAME || "";
const sourcePassword = process.env.MINDBODY_SOURCE_PASSWORD || "";

const DEFAULT_LOCATION_ID = (process.env.MINDBODY_DEFAULT_LOCATION_ID || "").trim();
const DEFAULT_LOCATION_IDS = (process.env.MINDBODY_DEFAULT_LOCATION_IDS || "").trim();
const DEBUG_MODE = String(process.env.DEBUG_MODE || "").toLowerCase() === "true";

const STUDIO_TZ = "America/Vancouver";

/**
 * ============
 * TIME / DATE HELPERS (Luxon-based, reliable)
 * ============
 */
function todayYYYYMMDD(tz = STUDIO_TZ) {
  return DateTime.now().setZone(tz).toFormat("yyyy-LL-dd");
}

function addDaysYYYYMMDD(yyyyMmDd, daysToAdd, tz = STUDIO_TZ) {
  const dt = DateTime.fromFormat(yyyyMmDd, "yyyy-LL-dd", { zone: tz });
  if (!dt.isValid) return null;
  return dt.plus({ days: Number(daysToAdd) || 0 }).toFormat("yyyy-LL-dd");
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
  // 0..6 Sun..Sat
  const dt = DateTime.now().setZone(tz);
  // Luxon weekday: 1=Mon..7=Sun -> convert to 0=Sun..6=Sat
  const lux = dt.weekday; // 1..7
  return lux === 7 ? 0 : lux; // Mon->1 .. Sat->6, Sun->0
}

function looksLikeYYYYMMDD(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function stripOrdinals(s) {
  return s.replace(/(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
}

/**
 * Accepts:
 * - "today", "tomorrow"
 * - "friday", "next friday"
 * - "2026-02-17"
 * - "Feb 21, 2026", "February 21st, 2026", "February 21 2026"
 * Returns: YYYY-MM-DD in studio TZ, or null if cannot parse
 */
function resolveDateInput(raw, tz = STUDIO_TZ) {
  if (!raw) return todayYYYYMMDD(tz);

  let s = String(raw).trim();
  if (!s) return todayYYYYMMDD(tz);

  const lower = s.toLowerCase();

  // direct YYYY-MM-DD
  if (looksLikeYYYYMMDD(lower)) return lower;

  // today / tomorrow
  if (lower === "today") return todayYYYYMMDD(tz);
  if (lower === "tomorrow") return addDaysYYYYMMDD(todayYYYYMMDD(tz), 1, tz);

  // Normalize ordinals + commas for month-name parsing
  const cleaned = stripOrdinals(lower).replace(/,/g, "").replace(/\s+/g, " ").trim();

  // Month-name formats (try a few)
  // Examples:
  // "february 21 2026"
  // "feb 21 2026"
  const monthNameCandidates = [
    DateTime.fromFormat(cleaned, "LLLL d yyyy", { zone: tz }), // February 21 2026
    DateTime.fromFormat(cleaned, "LLL d yyyy", { zone: tz }),  // Feb 21 2026
    DateTime.fromFormat(cleaned, "LLLL d", { zone: tz }),      // February 21 (assume current year)
    DateTime.fromFormat(cleaned, "LLL d", { zone: tz }),       // Feb 21 (assume current year)
  ];

  for (const dt of monthNameCandidates) {
    if (dt.isValid) {
      const withYear = dt.year ? dt : dt.set({ year: DateTime.now().setZone(tz).year });
      return withYear.toFormat("yyyy-LL-dd");
    }
  }

  // next friday / friday etc.
  const nextPrefix = lower.startsWith("next ");
  const weekdayToken = nextPrefix ? lower.slice(5).trim() : lower;

  if (WEEKDAY_MAP[weekdayToken] !== undefined) {
    const todayIdx = tzWeekdayIndex(tz);
    const targetIdx = WEEKDAY_MAP[weekdayToken];

    let delta = (targetIdx - todayIdx + 7) % 7;

    // If they say "Friday" and today is Friday, assume TODAY.
    // If they say "next Friday", force next week.
    if (nextPrefix) {
      if (delta === 0) delta = 7;
      else delta += 7;
    }

    return addDaysYYYYMMDD(todayYYYYMMDD(tz), delta, tz);
  }

  // "the 17th" (basic support)
  const m = lower.match(/(?:the\s*)?(\d{1,2})(?:st|nd|rd|th)?$/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) {
      const now = DateTime.now().setZone(tz);
      const dt = DateTime.fromObject({ year: now.year, month: now.month, day }, { zone: tz });
      if (dt.isValid) return dt.toFormat("yyyy-LL-dd");
    }
  }

  return null;
}

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

// Mindbody often returns naive local times "2026-02-15T08:30:00"
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
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const ampm = h >= 12 ? "PM" : "AM";
  let hr = h % 12;
  if (hr === 0) hr = 12;
  const mm = String(m).padStart(2, "0");
  return `${hr}:${mm} ${ampm}`;
}

function timeBucketFromHour(hour) {
  if (!Number.isFinite(hour)) return null;
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

function extractCapacityInfo(c) {
  const candidatesCapacity = [c.MaxCapacity, c.WebCapacity, c.Capacity, c.ClassCapacity];
  const candidatesBooked = [c.TotalBooked, c.Visits, c.TotalBookedClients, c.Booked, c.NumBooked];

  const capacity = candidatesCapacity.find((v) => Number.isFinite(Number(v)));
  const booked = candidatesBooked.find((v) => Number.isFinite(Number(v)));

  const capNum = capacity !== undefined ? Number(capacity) : null;
  const bookedNum = booked !== undefined ? Number(booked) : null;

  const spotsAvailable =
    capNum !== null && bookedNum !== null ? Math.max(capNum - bookedNum, 0) : null;

  const isWaitlistAvailable = c.IsWaitlistAvailable ?? c.WaitlistAvailable ?? c.AllowWaitlist ?? null;

  return { capacity: capNum, booked: bookedNum, spotsAvailable, isWaitlistAvailable };
}

function resolveLocationQuery(params) {
  const locationId = (params.location_id || params.locationId || "").toString().trim();
  const locationIds = (params.location_ids || params.locationIds || "").toString().trim();

  // Support "LocationIds" Mindbody query key
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

/**
 * ============
 * UNIVERSAL PARAMS UNWRAP
 * ============
 */
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

/**
 * ============
 * HEALTH
 * ============
 */
app.get("/", (req, res) => res.status(200).send("Flow AI Mindbody webhook is running"));
app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    envDetected: {
      hasSiteId: Boolean(siteId),
      hasApiKey: Boolean(apiKey),
      hasSourceName: Boolean(sourceName),
      hasSourcePassword: Boolean(sourcePassword),
      baseUrl: MINDBODY_BASE_URL,
      hasDefaultLocationId: Boolean(DEFAULT_LOCATION_ID),
      hasDefaultLocationIds: Boolean(DEFAULT_LOCATION_IDS),
      debugMode: DEBUG_MODE,
      tz: STUDIO_TZ,
    },
  });
});

/**
 * ============
 * CLEAN ENDPOINTS
 * ============
 */

// 1) LOCATIONS
app.all("/mb/locations", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/locations", { url: req.originalUrl, params });

  try {
    const data = await mbFetch("/site/locations", { method: "GET" });
    const locations = normalizeArray(data, ["Locations", "locations"]);
    return res.status(200).json({
      success: true,
      count: locations.length,
      results: {
        locations: locations.map((l) => ({
          id: l.Id ?? l.LocationId ?? null,
          name: l.Name ?? l.LocationName ?? null,
          address: l.Address ?? null,
          city: l.City ?? null,
          stateProv: l.StateProvCode ?? l.State ?? null,
        })),
      },
      locations: locations.map((l) => ({
        id: l.Id ?? l.LocationId ?? null,
        name: l.Name ?? l.LocationName ?? null,
        address: l.Address ?? null,
        city: l.City ?? null,
        stateProv: l.StateProvCode ?? l.State ?? null,
      })),
    });
  } catch (e) {
    return res.status(200).json({ success: false, results: { say: e?.message || "Server error" }, message: e?.message || "Server error" });
  }
});

// 2) SCHEDULE
app.all("/mb/schedule", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/schedule", { url: req.originalUrl, params });

  try {
    const rawDateInput = params.date || params.day || params.requested_day || params.requestedDate;
    const date = resolveDateInput(rawDateInput, STUDIO_TZ);

    if (!date) {
      const msg =
        "Could not understand the requested date. Please say a weekday (Friday), 'next Friday', 'today', 'tomorrow', or a date like 2026-02-21.";
      return res.status(200).json({
        success: false,
        message: msg,
        results: { say: msg },
        received: { date: rawDateInput },
      });
    }

    const { startLocal, endLocal } = localDayRange(date);
    const locationQuery = resolveLocationQuery(params);

    const data = await mbFetch("/class/classes", {
      method: "GET",
      query: { StartDateTime: startLocal, EndDateTime: endLocal, ...locationQuery },
    });

    const classesRaw = normalizeArray(data, ["Classes", "classes"]);

    const wantType = toLowerClean(params.class_type || params.class_name);
    const wantInstructor = toLowerClean(params.instructor_name);
    const wantTimeRange = toLowerClean(params.time_range);
    const wantTime = toLowerClean(params.time);

    let classes = classesRaw.map((c) => {
      const classId = c.Id ?? c.ClassId ?? null;
      const name = c.ClassDescription?.Name ?? c.Name ?? "Class";
      const startDateTime = c.StartDateTime ?? null;
      const endDateTime = c.EndDateTime ?? null;

      let instructor = c.Staff?.Name ?? c.InstructorName ?? null;
      if (!instructor && c.Staff) {
        const first = c.Staff.FirstName || "";
        const last = c.Staff.LastName || "";
        instructor = [first, last].filter(Boolean).join(" ").trim() || null;
      }

      const location = c.Location?.Name ?? c.LocationName ?? null;
      const cap = extractCapacityInfo(c);

      const st = parseNaiveISO(startDateTime);
      const startTimeLocal = st ? format12h(st.hour, st.minute) : null;
      const bucket = st ? timeBucketFromHour(st.hour) : null;

      return {
        classId,
        name,
        startDateTime,
        endDateTime,
        startTimeLocal,
        instructor,
        location,
        capacity: cap.capacity,
        booked: cap.booked,
        spotsAvailable: cap.spotsAvailable,
        isWaitlistAvailable: cap.isWaitlistAvailable,
        _timeBucket: bucket,
      };
    });

    if (wantType) classes = classes.filter((x) => toLowerClean(x.name).includes(wantType));
    if (wantInstructor) classes = classes.filter((x) => toLowerClean(x.instructor).includes(wantInstructor));
    if (wantTimeRange) classes = classes.filter((x) => toLowerClean(x._timeBucket) === wantTimeRange);
    if (wantTime) classes = classes.filter((x) => toLowerClean(x.startTimeLocal).includes(wantTime));

    classes = classes.map(({ _timeBucket, ...rest }) => rest);

    const say =
      classes.length === 0
        ? `No classes found for ${date}.`
        : `Classes for ${date}: ` +
          classes
            .slice(0, 20)
            .map((c) => `${c.startTimeLocal || ""} ${c.name}${c.instructor ? ` with ${c.instructor}` : ""}`)
            .join(" | ");

    const onlySay = String(params.onlySay || params.only_say || "").trim();
    const payload = {
      success: true,
      date,
      timezone: STUDIO_TZ,
      appliedLocationFilter: resolveLocationQuery(params),
      classes,
      say,
      // IMPORTANT: Always provide results.say for AgencyVault mapping
      results: {
        date,
        timezone: STUDIO_TZ,
        say,
        classes,
      },
      debug: DEBUG_MODE
        ? { rawCount: classesRaw.length, receivedParams: params, rawDateInput }
        : undefined,
    };

    if (onlySay === "1" || onlySay.toLowerCase() === "true") {
      return res.status(200).json({
        success: true,
        date,
        timezone: STUDIO_TZ,
        say,
        results: { say, date, timezone: STUDIO_TZ },
      });
    }

    return res.status(200).json(payload);
  } catch (e) {
    const msg = e?.message || "Server error";
    return res.status(200).json({ success: false, message: msg, results: { say: msg } });
  }
});

// 3) PRICING
app.all("/mb/pricing", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/pricing", { url: req.originalUrl, params });

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

    return res.status(200).json({
      success: true,
      offers: { services, packages, contracts },
      results: { offers: { services, packages, contracts } },
    });
  } catch (e) {
    const msg = e?.message || "Server error";
    return res.status(200).json({ success: false, message: msg, results: { say: msg } });
  }
});

// 4) BOOK
app.all("/mb/book", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/book", { url: req.originalUrl, params });

  try {
    const classId = params.class_id || params.classId;
    if (!classId) {
      return res.status(200).json({ success: false, message: "Missing class_id", results: { say: "Missing class_id" } });
    }

    const clientId = params.client_id || params.clientId;
    if (!clientId) {
      return res
        .status(200)
        .json({ success: false, message: "Missing client_id (existing client required)", results: { say: "Missing client_id (existing client required)" } });
    }

    const bookResp = await mbFetch("/class/addclienttoclass", {
      method: "POST",
      body: { ClientId: clientId, ClassId: classId, RequirePayment: false },
    });

    return res.status(200).json({
      success: true,
      booked: true,
      clientId,
      classId,
      results: { booked: true, clientId, classId },
      raw: DEBUG_MODE ? bookResp : undefined,
    });
  } catch (e) {
    const msg = e?.message || "Server error";
    return res.status(200).json({ success: false, message: msg, results: { say: msg } });
  }
});

/**
 * ============
 * LEGACY ENDPOINT (optional)
 * ============
 */
app.all("/mindbody", async (req, res) => {
  const params = getIncomingParams(req);
  const action = params.action || params.action_type || "";
  console.log("HIT /mindbody", { url: req.originalUrl, params, action });

  if (!action) {
    return res.status(200).json({
      success: false,
      message: "Missing action.",
      results: { say: "Missing action." },
      receivedQuery: req.query || {},
      receivedBody: req.body || {},
      receivedParams: params,
    });
  }

  if (action === "get_locations") return res.redirect(307, "/mb/locations");
  if (action === "get_today_schedule") return res.redirect(307, "/mb/schedule");
  if (action === "get_pricing_offers") return res.redirect(307, "/mb/pricing");
  if (action === "book_class") return res.redirect(307, "/mb/book");

  return res.status(200).json({ success: false, message: `Unknown action: ${action}`, results: { say: `Unknown action: ${action}` }, receivedParams: params });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));































