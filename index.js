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
  res.setHeader("Cache-Control", "no-store");
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
 * ============
 * IMPORTANT RESPONSE SHAPE (AGENCY VAULT SAFE)
 * ============
 * Agency Vault wraps the webhook response under `results.*`
 * So we MUST return speech at the TOP LEVEL:
 *   { say: "...", text: "..." }
 * Do NOT nest { results: { say: ... } } because AV becomes `results.results.say`.
 */
function sendSuccess(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}
function sendFail(res, message, extra = {}) {
  return res.status(200).json({ success: false, message, ...extra });
}
function withSpeech(payload, sayText) {
  const say = (sayText || "").toString();
  const text = say;
  return { ...payload, say, text };
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
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

function tzWeekdayIndex(tz = STUDIO_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
    .formatToParts(new Date());
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
    if (nextPrefix) delta = delta === 0 ? 7 : delta + 7;
    return addDaysYYYYMMDD(nowInTZDateString(tz), delta);
  }

  const cleaned = s0.replace(/(\d+)(st|nd|rd|th)/gi, "$1");
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(parsed);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  }

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
  for (const k of keys) if (Array.isArray(payload[k])) return payload[k];
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
  return { startLocal: `${dateStr}T00:00:00`, endLocal: `${dateStr}T23:59:59` };
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

async function mbFetch(path, { method = "GET", query, body, timeoutMs = 8000 } = {}) {
  if (!siteId || !apiKey || !sourceName || !sourcePassword) {
    throw new Error(
      `Missing ENV. hasSiteId=${Boolean(siteId)} hasApiKey=${Boolean(apiKey)} hasSourceName=${Boolean(sourceName)} hasSourcePassword=${Boolean(sourcePassword)}`
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

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  const res = await fetch(url.toString(), {
    method,
    headers,
    signal: controller.signal,
    body: body ? JSON.stringify(body) : undefined,
  }).finally(() => clearTimeout(t));

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
 * UTIL: CLAMP SPEECH SIZE
 * ============
 */
function clampSpeech(s, maxChars = 850) {
  const str = (s || "").toString();
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars - 20).trimEnd() + "…";
}

/**
 * ============
 * HEALTH
 * ============
 */
app.get("/", (req, res) => res.status(200).send("Flow AI Mindbody webhook is running"));
app.get("/health", (req, res) => {
  return sendSuccess(res, {
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
 * ENDPOINTS
 * ============
 */

// SCHEDULE
app.all("/mb/schedule", async (req, res) => {
  const params = getIncomingParams(req);
  console.log("HIT /mb/schedule", { method: req.method, url: req.originalUrl, params });

  try {
    const rawDateInput = params.date || params.day || params.requested_day || params.requestedDate;
    const date = resolveDateInput(rawDateInput, STUDIO_TZ);

    if (!date) {
      const say = "Sorry — I couldn’t understand that date. Could you say today, tomorrow, or a specific date?";
      return sendSuccess(res, withSpeech({ success: false, received: { date: rawDateInput } }, say));
    }

    const { startLocal, endLocal } = localDayRange(date);
    const locationQuery = resolveLocationQuery(params);

    const data = await mbFetch("/class/classes", {
      method: "GET",
      query: { StartDateTime: startLocal, EndDateTime: endLocal, ...locationQuery },
      timeoutMs: 9000,
    });

    const classesRaw = normalizeArray(data, ["Classes", "classes"]);

    const wantTimeRange = toLowerClean(params.time_range);
    const wantType = toLowerClean(params.class_type || params.class_name);
    const wantInstructor = toLowerClean(params.instructor_name);

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

      return { name, instructor, startTimeLocal, _bucket: bucket };
    });

    if (wantType) classes = classes.filter((x) => toLowerClean(x.name).includes(wantType));
    if (wantInstructor) classes = classes.filter((x) => toLowerClean(x.instructor).includes(wantInstructor));
    if (wantTimeRange) classes = classes.filter((x) => x._bucket === wantTimeRange);

    // onlySay handling
    const onlySay = String(params.onlySay || params.only_say || "").trim().toLowerCase();
    const isOnlySay = onlySay === "1" || onlySay === "true";

    // Build a compact speech response
    const formatLine = (c) =>
      `${c.startTimeLocal || ""} ${c.name}${c.instructor ? ` with ${c.instructor}` : ""}`.trim();

    if (classes.length === 0) {
      const say = wantTimeRange
        ? `No ${wantTimeRange} classes found for ${date}.`
        : `No classes found for ${date}.`;
      return sendSuccess(res, withSpeech({ date, timezone: STUDIO_TZ }, say));
    }

    // If not filtering by time_range, we will group into morning/afternoon/evening
    if (!wantTimeRange) {
      const groups = { morning: [], afternoon: [], evening: [] };
      for (const c of classes) {
        if (c._bucket && groups[c._bucket]) groups[c._bucket].push(c);
      }

      // cap each group to keep speech small
      const capPerGroup = 5;
      const parts = [];

      for (const key of ["morning", "afternoon", "evening"]) {
        const arr = groups[key];
        if (!arr.length) continue;
        const shown = arr.slice(0, capPerGroup).map(formatLine).join(" | ");
        const extra = arr.length > capPerGroup ? ` | and ${arr.length - capPerGroup} more` : "";
        parts.push(`${key.toUpperCase()}: ${shown}${extra}`);
      }

      let say = `Classes for ${date}. ` + parts.join(". ");

      // HARD clamp so AV/TTS never drops it
      say = clampSpeech(say, 850);

      return sendSuccess(
        res,
        withSpeech(
          { date, timezone: STUDIO_TZ, ...(DEBUG_MODE ? { rawCount: classesRaw.length } : {}) },
          say
        )
      );
    }

    // If time_range IS provided, return only that group and keep it short
    const maxItems = isOnlySay ? 10 : 20;
    let say =
      `Classes for ${date} (${wantTimeRange}): ` +
      classes.slice(0, maxItems).map(formatLine).join(" | ");

    if (classes.length > maxItems) say += ` | and ${classes.length - maxItems} more`;

    say = clampSpeech(say, 850);

    return sendSuccess(res, withSpeech({ date, timezone: STUDIO_TZ }, say));
  } catch (e) {
    const msg = e?.name === "AbortError"
      ? "Timed out while contacting Mindbody."
      : (e?.message || "Server error");

    return sendFail(res, msg);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));


