import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

/**
 * --- CORS / Preflight (helps Vapi dashboard Test Tool + browsers) ---
 * Safe for your use-case since this endpoint isn't using cookies.
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
 * Set these in Railway Variables:
 * - MINDBODY_SITE_ID
 * - MINDBODY_API_KEY
 * - MINDBODY_SOURCE_NAME
 * - MINDBODY_SOURCE_PASSWORD
 *
 * Optional:
 * - MINDBODY_BASE_URL (default below)
 * - MINDBODY_DEFAULT_LOCATION_ID (single numeric id)
 * - MINDBODY_DEFAULT_LOCATION_IDS (comma-separated ids like "1,2,3")
 * - DEBUG_MODE ("true" to enable extra debug responses)
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

/**
 * ============
 * SMALL HELPERS
 * ============
 */
function nowInTZDateString(tz = "America/Vancouver") {
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

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
}

/**
 * IMPORTANT: Mindbody often returns date-times WITHOUT timezone offset (ex: "2026-02-12T20:00:00")
 * If we use new Date() on that in a server running UTC, times shift and won't match the website.
 * So we parse the time as "naive local" (HH:MM) and format it ourselves.
 */
function parseNaiveISO(iso) {
  if (!iso || typeof iso !== "string") return null;
  const parts = iso.split("T");
  if (parts.length < 2) return null;
  const timePart = parts[1];
  const hm = timePart.split(":");
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
 * HEALTH CHECKS
 * ============
 */
app.get("/", (req, res) => {
  res.status(200).send("Flow AI Mindbody webhook is running");
});

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
    },
  });
});

/**
 * ============
 * MAIN WEBHOOK
 * ============
 */
app.all("/mindbody", async (req, res) => {
  // Vapi-safe responder: always HTTP 200
  const reply = (payload, httpStatus = 200) => {
    return res.status(200).json({
      httpStatus,
      ...payload,
    });
  };

  try {
    let action = req.query?.action || req.body?.action || req.body?.action_type || "";

    const paramsFromQuery = { ...(req.query || {}) };
    delete paramsFromQuery.action;

    const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
    const paramsFromBody = bodyObj.params && typeof bodyObj.params === "object" ? bodyObj.params : {};

    const extraTopLevelBody = { ...bodyObj };
    delete extraTopLevelBody.action;
    delete extraTopLevelBody.action_type;
    delete extraTopLevelBody.params;

    const params = { ...paramsFromBody, ...extraTopLevelBody, ...paramsFromQuery };

    // fallback: if date exists but action missing
    if (!action && params.date) action = "get_today_schedule";

    console.log("WEBHOOK_HIT", { method: req.method, action, params });

    if (!action) {
      return reply(
        {
          success: false,
          message:
            "Missing action. Send ?action=your_action OR JSON { action:'your_action', ...params }",
          receivedQuery: req.query || {},
          receivedBody: req.body || {},
        },
        400
      );
    }

    if (action === "get_locations") {
      const data = await mbFetch("/site/locations", { method: "GET" });
      const locations = normalizeArray(data, ["Locations", "locations"]);
      return reply(
        {
          success: true,
          actionReceived: action,
          count: locations.length,
          locations: locations.map((l) => ({
            id: l.Id ?? l.LocationId ?? null,
            name: l.Name ?? l.LocationName ?? null,
            address: l.Address ?? null,
            city: l.City ?? null,
            stateProv: l.StateProvCode ?? l.State ?? null,
          })),
        },
        200
      );
    }

    if (action === "get_today_schedule") {
      const date = params.date || nowInTZDateString("America/Vancouver");
      const { startLocal, endLocal } = localDayRange(date);
      const locationQuery = resolveLocationQuery(params);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startLocal,
          EndDateTime: endLocal,
          ...locationQuery,
        },
      });

      const classesRaw = normalizeArray(data, ["Classes", "classes"]);

      const wantType = toLowerClean(params.class_type || params.class_name);
      const wantInstructor = toLowerClean(params.instructor_name);
      const wantTimeRange = toLowerClean(params.time_range);
      const wantTime = toLowerClean(params.time);

      let classes = classesRaw.map((c) => {
        const classId = c.Id ?? c.ClassId ?? c.classId ?? null;
        const name = c.ClassDescription?.Name ?? c.Name ?? c.className ?? "Class";

        const startDateTime = c.StartDateTime ?? c.startDateTime ?? null;
        const endDateTime = c.EndDateTime ?? c.endDateTime ?? null;

        let instructor = c.Staff?.Name ?? c.InstructorName ?? c.instructor ?? null;
        if (!instructor && c.Staff) {
          const first = c.Staff.FirstName || "";
          const last = c.Staff.LastName || "";
          instructor = [first, last].filter(Boolean).join(" ").trim() || null;
        }

        const location = c.Location?.Name ?? c.LocationName ?? c.location ?? null;

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

      // Helpful spoken summary for the assistant (optional)
      const say =
        classes.length === 0
          ? `I couldn’t find any classes for ${date}.`
          : `Here are the classes for ${date}: ` +
            classes
              .slice(0, 10)
              .map((c, i) => `${i + 1}) ${c.startTimeLocal || ""} — ${c.name}${c.instructor ? ` with ${c.instructor}` : ""}`)
              .join(" ");

      return reply(
        {
          success: true,
          actionReceived: action,
          date,
          timezone: "America/Vancouver",
          appliedLocationFilter: resolveLocationQuery(params),
          classes,
          say,
          debug: DEBUG_MODE ? { rawCount: classesRaw.length, params } : undefined,
        },
        200
      );
    }

    if (action === "get_pricing_offers") {
      const [servicesResp, packagesResp, contractsResp] = await Promise.allSettled([
        mbFetch("/sale/services", { method: "GET" }),
        mbFetch("/sale/packages", { method: "GET" }),
        mbFetch("/sale/contracts", { method: "GET" }),
      ]);

      const services =
        servicesResp.status === "fulfilled"
          ? normalizeArray(servicesResp.value, ["Services", "services"])
          : [];
      const packages =
        packagesResp.status === "fulfilled"
          ? normalizeArray(packagesResp.value, ["Packages", "packages"])
          : [];
      const contracts =
        contractsResp.status === "fulfilled"
          ? normalizeArray(contractsResp.value, ["Contracts", "contracts"])
          : [];

      return reply(
        {
          success: true,
          actionReceived: action,
          offers: { services, packages, contracts },
        },
        200
      );
    }

    if (action === "book_class") {
      const isNewClient =
        params.is_new_client === true ||
        String(params.is_new_client || "").toLowerCase() === "true" ||
        String(params.is_new_client || "").toLowerCase() === "yes";

      let classId = params.class_id || params.classId || null;

      if (!classId) {
        return reply(
          {
            success: false,
            actionReceived: action,
            message:
              "Missing class_id. Best practice: call get_today_schedule first, then pass the returned classId.",
            paramsReceived: params,
          },
          400
        );
      }

      let clientId = params.client_id || params.clientId || null;

      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();
      const phone = normalizePhone(params.mobilephone || params.MobilePhone || params.phone);

      // TODO: (keeping your original search/create logic would go here)
      if (!clientId) {
        return reply(
          {
            success: false,
            actionReceived: action,
            message:
              "Missing client_id. For now pass client_id (or we can re-add the client search/create block once schedule is stable).",
            paramsReceived: { first, last, email, phone },
          },
          400
        );
      }

      const bookResp = await mbFetch("/class/addclienttoclass", {
        method: "POST",
        body: {
          ClientId: clientId,
          ClassId: classId,
          RequirePayment: false,
        },
      });

      return reply(
        {
          success: true,
          actionReceived: action,
          booked: true,
          clientId,
          classId,
          raw: DEBUG_MODE ? bookResp : undefined,
        },
        200
      );
    }

    return reply(
      {
        success: false,
        actionReceived: action,
        message: `Unknown action: ${action}`,
        paramsReceived: params,
      },
      400
    );
  } catch (err) {
    console.error("WEBHOOK_ERROR", err?.message || err, err?.stack || "");
    return res.status(200).json({
      httpStatus: 500,
      success: false,
      message: err?.message || "Server error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));


















