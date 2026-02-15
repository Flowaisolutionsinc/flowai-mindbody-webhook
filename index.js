import express from "express";
import { DateTime } from "luxon";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

const STUDIO_TZ = "America/Vancouver";

/**
 * ============
 * VAPI RESPONSE HELPERS
 * ============
 * Vapi custom tools require:
 * HTTP 200 AND JSON:
 * { results: [ { toolCallId: "...", result: "single line string" } ] }
 */
function toSingleLine(str) {
  return String(str ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractToolCallId(body) {
  if (!body || typeof body !== "object") return null;

  // Common shapes Vapi may send
  if (typeof body.toolCallId === "string") return body.toolCallId;
  if (typeof body.id === "string" && body.id.startsWith("call_")) return body.id;

  if (body.toolCall && typeof body.toolCall.id === "string") return body.toolCall.id;
  if (Array.isArray(body.toolCalls) && body.toolCalls[0]?.id) return body.toolCalls[0].id;

  // Sometimes nested
  if (body.message?.toolCallId) return body.message.toolCallId;

  return null;
}

function vapiResult(res, toolCallId, resultString) {
  // Always HTTP 200 for Vapi tools
  return res.status(200).json({
    results: [
      {
        toolCallId,
        result: toSingleLine(resultString),
      },
    ],
  });
}

function vapiError(res, toolCallId, errorString) {
  return res.status(200).json({
    results: [
      {
        toolCallId,
        error: toSingleLine(errorString),
      },
    ],
  });
}

/**
 * ============
 * SMALL HELPERS
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

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
}

/**
 * Date handling:
 * - Vapi sometimes sends params_date / params_location_id (you had this in logs)
 * - Vapi may send ISO timestamps; we coerce to YYYY-MM-DD in Vancouver time
 */
function coerceYYYYMMDD(input) {
  if (!input) return null;
  const s = String(input).trim();

  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // If ISO like 2026-02-17T00:00:00.000Z
  const dt = DateTime.fromISO(s, { setZone: true });
  if (dt.isValid) return dt.setZone(STUDIO_TZ).toISODate();

  // Fallback: grab first 10 chars if it looks like date
  const first10 = s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(first10)) return first10;

  return null;
}

function todayInStudioTZ() {
  return DateTime.now().setZone(STUDIO_TZ).toISODate(); // YYYY-MM-DD
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
  const timePart = parts[1]; // "20:00:00"
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

/** Build a “local day range” without Z (timezone) so Mindbody treats it as location-local time */
function localDayRange(dateStr /* YYYY-MM-DD */) {
  return {
    startLocal: `${dateStr}T00:00:00`,
    endLocal: `${dateStr}T23:59:59`,
  };
}

/** Best-effort extraction of capacity & booked counts from Mindbody class object. */
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

/**
 * Location resolution:
 * - If request has location_id => use that
 * - else if request has location_ids => use that
 * - else use env default(s)
 */
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
      studioTimezone: STUDIO_TZ,
    },
  });
});

/**
 * ============
 * MAIN WEBHOOK
 * ============
 * Accepts either:
 * - Query:  /mindbody?action=get_today_schedule&date=YYYY-MM-DD
 * - JSON:   { "action": "get_today_schedule", "params": { ... } }
 *
 * ALSO supports Vapi custom tool requests:
 * - It will detect toolCallId and respond in Vapi-required results[] format.
 */
app.all("/mindbody", async (req, res) => {
  const toolCallId = extractToolCallId(req.body);
  const isVapi = Boolean(toolCallId);

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

    // Merge params
    const params = { ...paramsFromBody, ...extraTopLevelBody, ...paramsFromQuery };

    // Fix Vapi-style param names you showed in logs: params_date, params_location_id
    if (!params.date && params.params_date) params.date = params.params_date;
    if (!params.location_id && params.params_location_id) params.location_id = params.params_location_id;

    // Coerce date correctly (prevents “wrong schedule today” issues)
    const coerced = coerceYYYYMMDD(params.date);
    if (coerced) params.date = coerced;

    // Safety fallback
    if (!action && params.date) action = "get_today_schedule";

    console.log("WEBHOOK_HIT", { method: req.method, action, params, isVapi });

    if (!action) {
      const msg =
        "Missing action. Send ?action=your_action OR JSON { action:'your_action', params:{...} }";
      return isVapi
        ? vapiError(res, toolCallId, msg)
        : res.status(200).json({ httpStatus: 400, success: false, message: msg });
    }

    /**
     * =====================
     * ACTION: get_locations
     * =====================
     */
    if (action === "get_locations") {
      const data = await mbFetch("/site/locations", { method: "GET" });
      const locations = normalizeArray(data, ["Locations", "locations"]);

      const resultText = `Found ${locations.length} locations.`;

      return isVapi
        ? vapiResult(res, toolCallId, resultText)
        : res.status(200).json({
            httpStatus: 200,
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
          });
    }

    /**
     * =====================
     * ACTION: get_today_schedule
     * =====================
     */
    if (action === "get_today_schedule") {
      const date = params.date || todayInStudioTZ();
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
          const combined = [first, last].filter(Boolean).join(" ").trim();
          instructor = combined || null;
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
      if (wantInstructor)
        classes = classes.filter((x) => toLowerClean(x.instructor).includes(wantInstructor));
      if (wantTimeRange)
        classes = classes.filter((x) => toLowerClean(x._timeBucket) === wantTimeRange);
      if (wantTime) classes = classes.filter((x) => toLowerClean(x.startTimeLocal).includes(wantTime));

      classes = classes.map(({ _timeBucket, ...rest }) => rest);

      // Build a clean single-line sentence for Vapi (prevents token truncation + formatting issues)
      let say;
      if (!classes.length) {
        say = `I couldn't find any classes for ${date}. Want me to check a different day?`;
      } else {
        const parts = classes.map((c, idx) => {
          const t = c.startTimeLocal || "";
          const n = c.name || "Class";
          const ins = c.instructor ? ` with ${c.instructor}` : "";
          return `${idx + 1}) ${t} - ${n}${ins}`.trim();
        });
        say = `Here are the classes for ${date}: ${parts.join(" ")}`;
      }

      return isVapi
        ? vapiResult(res, toolCallId, say)
        : res.status(200).json({
            httpStatus: 200,
            success: true,
            actionReceived: action,
            date,
            timezone: STUDIO_TZ,
            appliedLocationFilter: resolveLocationQuery(params),
            classes,
            say,
            notes: {
              whyTimesMatchWebsite:
                "We format Mindbody times as naive-local (no Date() parsing) because Mindbody often returns times without timezone offsets.",
              capacityLogic:
                "spotsAvailable is best-effort. Many studios do not return capacity/booked fields from this endpoint, so spotsAvailable may be null even though the class is bookable.",
            },
            debug: DEBUG_MODE ? { rawCount: classesRaw.length } : undefined,
          });
    }

    /**
     * =====================
     * ACTION: get_pricing_offers
     * =====================
     */
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

      const say = `I pulled pricing offers. Services: ${services.length}, Packages: ${packages.length}, Contracts: ${contracts.length}.`;

      return isVapi
        ? vapiResult(res, toolCallId, say)
        : res.status(200).json({
            httpStatus: 200,
            success: true,
            actionReceived: action,
            offers: { services, packages, contracts },
            warnings: {
              services:
                servicesResp.status === "rejected"
                  ? String(servicesResp.reason?.message || servicesResp.reason)
                  : null,
              packages:
                packagesResp.status === "rejected"
                  ? String(packagesResp.reason?.message || packagesResp.reason)
                  : null,
              contracts:
                contractsResp.status === "rejected"
                  ? String(contractsResp.reason?.message || contractsResp.reason)
                  : null,
            },
          });
    }

    /**
     * =====================
     * ACTION: book_class
     * =====================
     * NOTE: For Vapi we return a short string result, not raw JSON.
     */
    if (action === "book_class") {
      const isNewClient =
        params.is_new_client === true ||
        String(params.is_new_client || "").toLowerCase() === "true" ||
        String(params.is_new_client || "").toLowerCase() === "yes";

      let classId = params.class_id || params.classId || null;

      if (!classId) {
        const date = params.date || todayInStudioTZ();
        const { startLocal, endLocal } = localDayRange(date);
        const locationQuery = resolveLocationQuery(params);

        const sched = await mbFetch("/class/classes", {
          method: "GET",
          query: { StartDateTime: startLocal, EndDateTime: endLocal, ...locationQuery },
        });

        const classes = normalizeArray(sched, ["Classes", "classes"]);

        const desiredName = toLowerClean(params.class_name || params.class_type);
        const desiredTime = toLowerClean(params.time);

        const match = classes.find((c) => {
          const nm = toLowerClean(c.ClassDescription?.Name ?? c.Name ?? "");
          const st = (c.StartDateTime ?? "").toString();
          const parsed = parseNaiveISO(st);
          const stHuman = parsed ? format12h(parsed.hour, parsed.minute).toLowerCase() : "";

          const nameOk = desiredName ? nm.includes(desiredName) : true;
          const timeOk = desiredTime ? (stHuman || "").includes(desiredTime) : true;
          return nameOk && timeOk;
        });

        classId = match?.Id ?? match?.ClassId ?? null;
      }

      if (!classId) {
        const msg =
          "Missing class_id and could not match a class. Best practice: call get_today_schedule first and pass back class_id.";
        return isVapi
          ? vapiError(res, toolCallId, msg)
          : res.status(200).json({ httpStatus: 400, success: false, actionReceived: action, message: msg });
      }

      let clientId = params.client_id || params.clientId || null;

      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();
      const phone = normalizePhone(params.mobilephone || params.MobilePhone || params.phone);

      if (!clientId) {
        const searchText = [email, phone, `${first} ${last}`].find((x) => x && x.length >= 3);

        if (searchText) {
          const clientResp = await mbFetch("/client/clients", {
            method: "GET",
            query: { SearchText: searchText },
          });

          const clients = normalizeArray(clientResp, ["Clients", "clients"]);

          const firstLower = first.toLowerCase();
          const lastLower = last.toLowerCase();

          const best =
            clients.find((c) => {
              const fn = (c.FirstName ?? "").toString().toLowerCase();
              const ln = (c.LastName ?? "").toString().toLowerCase();
              return (firstLower ? fn === firstLower : true) && (lastLower ? ln === lastLower : true);
            }) || clients[0];

          clientId = best?.Id ?? best?.ClientId ?? null;
        }
      }

      if (!clientId && isNewClient) {
        if (!first || !last) {
          const msg =
            "New client booking needs client_first_name and client_last_name (and ideally email/mobilephone).";
          return isVapi
            ? vapiError(res, toolCallId, msg)
            : res.status(200).json({ httpStatus: 400, success: false, actionReceived: action, message: msg });
        }

        const addClientBody = {
          FirstName: first,
          LastName: last,
          Email: email || undefined,
          MobilePhone: phone || undefined,
        };

        const createResp = await mbFetch("/client/addclient", {
          method: "POST",
          body: addClientBody,
        });

        clientId =
          createResp?.Client?.Id ||
          createResp?.Client?.ClientId ||
          createResp?.Id ||
          createResp?.ClientId ||
          null;
      }

      if (!clientId) {
        const msg =
          "Client likely already exists, but could not be located via search. Ask for the exact email/phone on file or pass client_id.";
        return isVapi
          ? vapiError(res, toolCallId, msg)
          : res.status(200).json({ httpStatus: 409, success: false, actionReceived: action, message: msg });
      }

      await mbFetch("/class/addclienttoclass", {
        method: "POST",
        body: {
          ClientId: clientId,
          ClassId: classId,
          RequirePayment: false,
        },
      });

      const say = `Booked successfully. Client ID ${clientId}, Class ID ${classId}.`;

      return isVapi
        ? vapiResult(res, toolCallId, say)
        : res.status(200).json({
            httpStatus: 200,
            success: true,
            actionReceived: action,
            booked: true,
            clientId,
            classId,
          });
    }

    const unknownMsg = `Unknown action: ${action}`;
    return isVapi
      ? vapiError(res, toolCallId, unknownMsg)
      : res.status(200).json({ httpStatus: 400, success: false, actionReceived: action, message: unknownMsg });
  } catch (err) {
    console.error("WEBHOOK_ERROR", err?.message || err, err?.stack || "");
    const msg = err?.message || "Server error";
    return isVapi
      ? vapiError(res, toolCallId, msg)
      : res.status(200).json({ httpStatus: 500, success: false, message: msg });
  }
});

// IMPORTANT: Railway supplies PORT automatically
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));


















