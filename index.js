import express from "express";

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

const siteId = (process.env.MINDBODY_SITE_ID || "").trim();
const apiKey = (process.env.MINDBODY_API_KEY || "").trim();
const sourceName = (process.env.MINDBODY_SOURCE_NAME || "").trim();
const sourcePassword = (process.env.MINDBODY_SOURCE_PASSWORD || "").trim();

const DEFAULT_LOCATION_ID = (process.env.MINDBODY_DEFAULT_LOCATION_ID || "").trim();
const DEFAULT_LOCATION_IDS = (process.env.MINDBODY_DEFAULT_LOCATION_IDS || "").trim();
const DEBUG_MODE = String(process.env.DEBUG_MODE || "").toLowerCase() === "true";

const STUDIO_TZ = process.env.TZ || "America/Vancouver";

/**
 * =========================
 * AGENCY VAULT COMPAT OUTPUT
 * =========================
 * IMPORTANT:
 * - Agency Vault typically WRAPS your JSON response under "results".
 * - If you ALSO include a nested "results" object, AV ends up with results.results.say etc.
 *
 * So we ONLY return top-level:
 *   { success: true, say: "...", text: "..." }
 *
 * Then AV can reliably read results.say (because it wraps top-level under results).
 */
function sendOk(res, payload = {}) {
  return res.status(200).json(payload);
}

function okSay(res, sayText, extra = {}) {
  const say = (sayText || "").toString();
  return sendOk(res, { success: true, say, text: say, ...extra });
}

function failSay(res, sayText, extra = {}) {
  const say = (sayText || "").toString();
  // Keep HTTP 200 so the tool runner doesn’t treat it as a hard failure
  return sendOk(res, { success: false, say, text: say, ...extra });
}

/**
 * ============
 * TIME / DATE HELPERS
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

  // Remove suffixes like 19th -> 19
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
  return sendOk(res, {
    ok: true,
    hasSiteId: Boolean(siteId),
    hasApiKey: Boolean(apiKey),
    hasSourceName: Boolean(sourceName),
    hasSourcePassword: Boolean(sourcePassword),
    baseUrl: MINDBODY_BASE_URL,
    hasDefaultLocationId: Boolean(DEFAULT_LOCATION_ID),
    hasDefaultLocationIds: Boolean(DEFAULT_LOCATION_IDS),
    debugMode: DEBUG_MODE,
    tz: STUDIO_TZ,
  });
});

/**
 * ============
 * ENDPOINTS
 * ============
 */

// LOCATIONS
app.all("/mb/locations", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/locations", { method: req.method, url: req.originalUrl, params });

  try {
    const data = await mbFetch("/site/locations", { method: "GET" });
    const locations = normalizeArray(data, ["Locations", "locations"]);

    return okSay(
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
    return failSay(res, "I can’t access locations right now.", { message: e?.message || "Server error" });
  }
});

// SCHEDULE (SMALL + BUCKETED)
app.all("/mb/schedule", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/schedule", { method: req.method, url: req.originalUrl, params });

  try {
    const rawDateInput = params.date || params.day || params.requested_day || params.requestedDate;
    const date = resolveDateInput(rawDateInput, STUDIO_TZ);

    if (!date) {
      return failSay(
        res,
        "Sorry — I didn’t catch the date. Would you like today, tomorrow, or a specific date?",
        { received: { date: rawDateInput } }
      );
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

    // NEW: time_range bucket from caller (“morning” | “afternoon” | “evening”)
    const wantTimeRange = toLowerClean(params.time_range);

    let classes = classesRaw.map((c) => {
      const name = c.ClassDescription?.Name ?? c.Name ?? "Class";
      const startDateTime = c.StartDateTime ?? null;

      let instructor = c.Staff?.Name ?? c.InstructorName ?? null;
      if (!instructor && c.Staff) {
        const first = c.Staff.FirstName || "";
        const last = c.Staff.LastName || "";
        instructor = [first, last].filter(Boolean).join(" ").trim() || null;
      }

      const st = parseNaiveISO(startDateTime);
      const startTimeLocal = st ? format12h(st.hour, st.minute) : null;
      const bucket = st ? timeBucketFromHour(st.hour) : null;

      return {
        name,
        startTimeLocal,
        instructor,
        _bucket: bucket,
      };
    });

    if (wantType) classes = classes.filter((x) => toLowerClean(x.name).includes(wantType));
    if (wantInstructor) classes = classes.filter((x) => toLowerClean(x.instructor).includes(wantInstructor));

    const morning = classes.filter((c) => c._bucket === "morning");
    const afternoon = classes.filter((c) => c._bucket === "afternoon");
    const evening = classes.filter((c) => c._bucket === "evening");

    // Default small response ALWAYS
    // - If no time_range specified: give counts + ask which bucket
    // - If time_range specified: list only that bucket (short list, includes instructor)
    const maxItems = 8;

    const listBucket = (label, arr) => {
      if (!arr.length) return `${label}: none`;
      const shown = arr.slice(0, maxItems).map((c) => {
        const who = c.instructor ? ` with ${c.instructor}` : "";
        return `${c.startTimeLocal || ""} ${c.name}${who}`.trim();
      });
      const more = arr.length > maxItems ? ` | plus ${arr.length - maxItems} more` : "";
      return `${label}: ${shown.join(" | ")}${more}`;
    };

    if (wantTimeRange === "morning" || wantTimeRange === "afternoon" || wantTimeRange === "evening") {
      const picked =
        wantTimeRange === "morning" ? morning : wantTimeRange === "afternoon" ? afternoon : evening;

      const say =
        picked.length === 0
          ? `No ${wantTimeRange} classes found for ${date}.`
          : `${wantTimeRange[0].toUpperCase()}${wantTimeRange.slice(1)} classes for ${date}: ` +
            picked
              .slice(0, maxItems)
              .map((c) => `${c.startTimeLocal || ""} ${c.name}${c.instructor ? ` with ${c.instructor}` : ""}`)
              .join(" | ") +
            (picked.length > maxItems ? ` | plus ${picked.length - maxItems} more` : "");

      return okSay(res, say, { date, timezone: STUDIO_TZ });
    }

    // No bucket requested → summarize counts and ask which part of day
    const total = classes.length;
    if (total === 0) {
      return okSay(res, `No classes found for ${date}.`, { date, timezone: STUDIO_TZ });
    }

    const say =
      `For ${date}, we have ` +
      `${morning.length} in the morning, ${afternoon.length} in the afternoon, and ${evening.length} in the evening. ` +
      `Which would you like — morning, afternoon, or evening?`;

    return okSay(res, say, { date, timezone: STUDIO_TZ });
  } catch (e) {
    return failSay(
      res,
      "I’m not able to pull the schedule right now. Would you like me to try again?",
      { message: e?.message || "Server error" }
    );
  }
});

// PRICING
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

    return okSay(
      res,
      "I pulled pricing successfully.",
      { offers: { services, packages, contracts } }
    );
  } catch (e) {
    return failSay(res, "I can’t access pricing right now.", { message: e?.message || "Server error" });
  }
});

// BOOK (existing-client only in this version)
app.all("/mb/book", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/book", { method: req.method, url: req.originalUrl, params });

  try {
    const classId = params.class_id || params.classId;
    if (!classId) return failSay(res, "Missing class_id.");

    const clientId = params.client_id || params.clientId;
    if (!clientId) return failSay(res, "Missing client_id (existing client required).");

    const bookResp = await mbFetch("/class/addclienttoclass", {
      method: "POST",
      body: { ClientId: clientId, ClassId: classId, RequirePayment: false },
    });

    return okSay(res, "Booked successfully.", {
      booked: true,
      clientId,
      classId,
      raw: DEBUG_MODE ? bookResp : undefined,
    });
  } catch (e) {
    return failSay(res, "I couldn’t complete that booking.", { message: e?.message || "Server error" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));




