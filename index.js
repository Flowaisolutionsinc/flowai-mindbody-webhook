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
const MINDBODY_BASE_URL = process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";
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
 * HELPERS
 * ============
 */
function sendSuccess(res, payload = {}) {
  return res.status(200).json({ success: true, ...payload });
}

function sendFail(res, message, extra = {}) {
  return res.status(200).json({ success: false, message, ...extra });
}

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

const WEEKDAY_MAP = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };

function tzWeekdayIndex(tz = STUDIO_TZ) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" }).formatToParts(new Date());
  const wd = parts.find((p) => p.type === "weekday")?.value?.toLowerCase();
  return WEEKDAY_MAP[wd] ?? null;
}

function resolveDateInput(raw, tz = STUDIO_TZ) {
  if (!raw) return nowInTZDateString(tz);
  const s0 = String(raw).trim();
  const s = s0.toLowerCase().trim();
  if (!s || s === "today") return nowInTZDateString(tz);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s === "tomorrow") return addDaysYYYYMMDD(nowInTZDateString(tz), 1);

  const nextPrefix = s.startsWith("next ");
  const weekdayToken = nextPrefix ? s.slice(5).trim() : s.startsWith("this ") ? s.slice(5).trim() : s;

  if (WEEKDAY_MAP[weekdayToken] !== undefined) {
    const todayIdx = tzWeekdayIndex(tz);
    const targetIdx = WEEKDAY_MAP[weekdayToken];
    let delta = (targetIdx - todayIdx + 7) % 7;
    if (nextPrefix) delta = (delta === 0) ? 7 : delta + 7;
    return addDaysYYYYMMDD(nowInTZDateString(tz), delta);
  }

  const parsed = new Date(s0.replace(/(\d+)(st|nd|rd|th)/gi, "$1"));
  if (!Number.isNaN(parsed.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(parsed);
    return `${parts.find(p => p.type==='year').value}-${parts.find(p => p.type==='month').value}-${parts.find(p => p.type==='day').value}`;
  }
  return null;
}

async function mbFetch(path, { method = "GET", query, body } = {}) {
  const url = new URL(`${MINDBODY_BASE_URL}${path}`);
  if (query) Object.entries(query).forEach(([k, v]) => v && url.searchParams.set(k, String(v)));
  
  const res = await fetch(url.toString(), {
    method,
    headers: { "Content-Type": "application/json", "Api-Key": apiKey, SiteId: siteId, "Source-Name": sourceName, "Password": sourcePassword },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/**
 * ============
 * MAIN WEBHOOK (Matching your Screenshot)
 * ============
 */
app.all("/mindbody", async (req, res) => {
  // Merge Query and Body params
  const params = { ...(req.query || {}), ...(req.body || {}) };
  console.log("Agency Vault Request:", params);

  try {
    const rawDate = params.date || params.day || "today";
    const date = resolveDateInput(rawDate, STUDIO_TZ);

    if (!date) return sendFail(res, "Could not understand date: " + rawDate);

    const data = await mbFetch("/class/classes", {
      query: { StartDateTime: `${date}T00:00:00`, EndDateTime: `${date}T23:59:59`, LocationIds: DEFAULT_LOCATION_ID }
    });

    const classesRaw = data.Classes || data.classes || [];
    
    if (classesRaw.length === 0) {
      return sendSuccess(res, { say: `I couldn't find any classes scheduled for ${rawDate}.` });
    }

    const schedule = classesRaw.map(c => {
      const time = new Date(c.StartDateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: STUDIO_TZ });
      return `${time} ${c.ClassDescription?.Name || 'Class'}`;
    }).join(", ");

    return sendSuccess(res, { 
      say: `For ${rawDate}, we have: ${schedule}.`,
      date: date 
    });

  } catch (e) {
    console.error(e);
    return sendFail(res, "Error fetching schedule");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

