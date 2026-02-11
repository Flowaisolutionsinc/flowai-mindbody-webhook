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
 * - STUDIO_TZ (default America/Vancouver)
 */
const MINDBODY_BASE_URL =
  process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

const STUDIO_TZ = process.env.STUDIO_TZ || "America/Vancouver";

const siteId = process.env.MINDBODY_SITE_ID || "";
const apiKey = process.env.MINDBODY_API_KEY || "";
const sourceName = process.env.MINDBODY_SOURCE_NAME || "";
const sourcePassword = process.env.MINDBODY_SOURCE_PASSWORD || "";

/**
 * ============
 * SMALL HELPERS
 * ============
 */
function nowInTZDateString(tz = STUDIO_TZ) {
  return DateTime.now().setZone(tz).toFormat("yyyy-LL-dd"); // YYYY-MM-DD
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

/**
 * FIXED: Build the "day window" in STUDIO_TZ, then convert to UTC for Mindbody.
 */
function toISODateRangeForDay(dateStr, tz = STUDIO_TZ) {
  const startISO = DateTime.fromISO(dateStr, { zone: tz })
    .startOf("day")
    .toUTC()
    .toISO();

  const endISO = DateTime.fromISO(dateStr, { zone: tz })
    .endOf("day")
    .toUTC()
    .toISO();

  return { startISO, endISO };
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
}

function toLowerClean(x) {
  return (x ?? "").toString().toLowerCase().trim();
}

function timeBucketFromISO(iso, tz = STUDIO_TZ) {
  if (!iso) return null;

  const hour = DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).hour;
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function humanTime(iso, tz = STUDIO_TZ) {
  try {
    return DateTime.fromISO(iso, { zone: "utc" }).setZone(tz).toFormat("h:mm a");
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of capacity & booked counts from Mindbody class object.
 * Mindbody fields can vary by account/configuration.
 */
function extractCapacityInfo(c) {
  const candidatesCapacity = [
    c.MaxCapacity,
    c.WebCapacity,
    c.Capacity,
    c.ClassCapacity,
  ];
  const candidatesBooked = [
    c.TotalBooked,
    c.Visits,
    c.TotalBookedClients,
    c.Booked,
    c.NumBooked,
  ];

  const capacity = candidatesCapacity.find((v) => Number.isFinite(Number(v)));
  const booked = candidatesBooked.find((v) => Number.isFinite(Number(v)));

  const capNum = capacity !== undefined ? Number(capacity) : null;
  const bookedNum = booked !== undefined ? Number(booked) : null;

  const spotsAvailable =
    capNum !== null && bookedNum !== null ? Math.max(capNum - bookedNum, 0) : null;

  const isWaitlistAvailable =
    c.IsWaitlistAvailable ?? c.WaitlistAvailable ?? c.AllowWaitlist ?? null;

  return {
    capacity: capNum,
    booked: bookedNum,
    spotsAvailable,
    isWaitlistAvailable,
  };
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
    const detail =
      json ||
      (text ? { raw: text.slice(0, 700) } : { raw: "(no response body)" });
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
    tz: STUDIO_TZ,
    envDetected: {
      hasSiteId: Boolean(siteId),
      hasApiKey: Boolean(apiKey),
      hasSourceName: Boolean(sourceName),
      hasSourcePassword: Boolean(sourcePassword),
      baseUrl: MINDBODY_BASE_URL,
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
 */
app.all("/mindbody", async (req, res) => {
  try {
    const action = req.query?.action || req.body?.action || req.body?.action_type || "";

    const paramsFromQuery = { ...(req.query || {}) };
    delete paramsFromQuery.action;

    const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
    const paramsFromBody =
      bodyObj.params && typeof bodyObj.params === "object" ? bodyObj.params : {};

    const extraTopLevelBody = { ...bodyObj };
    delete extraTopLevelBody.action;
    delete extraTopLevelBody.action_type;
    delete extraTopLevelBody.params;

    const params = { ...paramsFromBody, ...extraTopLevelBody, ...paramsFromQuery };

    console.log("WEBHOOK_HIT", { method: req.method, action, params });

    if (!action) {
      return res.status(400).json({
        success: false,
        message:
          "Missing action. Send ?action=your_action OR JSON { action:'your_action', params:{...} }",
        receivedQuery: req.query || {},
        receivedBody: req.body || {},
      });
    }

    /**
     * =====================
     * ACTION: get_today_schedule
     * =====================
     * Optional filters supported:
     * - date (YYYY-MM-DD)
     * - class_type OR class_name (substring match)
     * - instructor_name (substring match)
     * - time_range (morning/afternoon/evening) OR time (like "6pm")
     */
    if (action === "get_today_schedule") {
      const date = params.date || nowInTZDateString(STUDIO_TZ);
      const { startISO, endISO } = toISODateRangeForDay(date, STUDIO_TZ);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startISO,
          EndDateTime: endISO,
        },
      });

      const classesRaw = normalizeArray(data, ["Classes", "classes"]);

      const wantType = toLowerClean(params.class_type || params.class_name);
      const wantInstructor = toLowerClean(params.instructor_name);
      const wantTimeRange = toLowerClean(params.time_range); // morning/afternoon/evening
      const wantTime = toLowerClean(params.time); // "6pm" etc

      let classes = classesRaw.map((c) => {
        const classId = c.Id ?? c.ClassId ?? c.classId ?? null;
        const name = c.ClassDescription?.Name ?? c.Name ?? c.className ?? "Class";
        const startDateTime = c.StartDateTime ?? c.startDateTime ?? null;
        const endDateTime = c.EndDateTime ?? c.endDateTime ?? null;

        const instructor =
          c.Staff?.Name ??
          c.Staff?.FirstName ??
          c.InstructorName ??
          c.instructor ??
          null;

        const location = c.Location?.Name ?? c.LocationName ?? c.location ?? null;

        const cap = extractCapacityInfo(c);

        return {
          classId,
          name,
          startDateTime,
          endDateTime,
          startTimeLocal: startDateTime ? humanTime(startDateTime, STUDIO_TZ) : null,
          instructor,
          location,
          capacity: cap.capacity,
          booked: cap.booked,
          spotsAvailable: cap.spotsAvailable,
          isWaitlistAvailable: cap.isWaitlistAvailable,
          _timeBucket: startDateTime ? timeBucketFromISO(startDateTime, STUDIO_TZ) : null,
        };
      });

      if (wantType) {
        classes = classes.filter((x) => toLowerClean(x.name).includes(wantType));
      }
      if (wantInstructor) {
        classes = classes.filter((x) => toLowerClean(x.instructor).includes(wantInstructor));
      }
      if (wantTimeRange) {
        classes = classes.filter((x) => toLowerClean(x._timeBucket) === wantTimeRange);
      }
      if (wantTime) {
        classes = classes.filter((x) => toLowerClean(x.startTimeLocal).includes(wantTime));
      }

      classes = classes.map(({ _timeBucket, ...rest }) => rest);

      return res.status(200).json({
        success: true,
        actionReceived: action,
        date,
        timezone: STUDIO_TZ,
        classes,
        notes: {
          capacityLogic:
            "spotsAvailable is best-effort: if Mindbody does not return capacity/booked fields for a class, spotsAvailable will be null.",
        },
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

      return res.status(200).json({
        success: true,
        actionReceived: action,
        filtersReceived: {
          pricing_interest: params.pricing_interest || null,
          is_new_client: params.is_new_client ?? null,
          membership_interest: params.membership_interest || null,
          class_pack_interest: params.class_pack_interest || null,
          notes: params.notes || null,
        },
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
     */
    if (action === "book_class") {
      const isNewClient =
        params.is_new_client === true ||
        String(params.is_new_client || "").toLowerCase() === "true" ||
        String(params.is_new_client || "").toLowerCase() === "yes";

      let classId = params.class_id || params.classId || null;

      if (!classId) {
        const date = params.date || nowInTZDateString(STUDIO_TZ);
        const { startISO, endISO } = toISODateRangeForDay(date, STUDIO_TZ);

        const sched = await mbFetch("/class/classes", {
          method: "GET",
          query: { StartDateTime: startISO, EndDateTime: endISO },
        });

        const classes = normalizeArray(sched, ["Classes", "classes"]);

        const desiredName = toLowerClean(params.class_name || params.class_type);
        const desiredTime = toLowerClean(params.time);

        const match = classes.find((c) => {
          const nm = toLowerClean(c.ClassDescription?.Name ?? c.Name ?? "");
          const st = (c.StartDateTime ?? "").toString();
          const stHuman = st ? (humanTime(st, STUDIO_TZ) || "").toLowerCase() : "";

          const nameOk = desiredName ? nm.includes(desiredName) : true;
          const timeOk = desiredTime ? stHuman.includes(desiredTime) : true;
          return nameOk && timeOk;
        });

        classId = match?.Id ?? match?.ClassId ?? null;
      }

      if (!classId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Missing class_id and could not match a class. BEST PRACTICE: call get_today_schedule first and pass back class_id.",
          paramsReceived: params,
        });
      }

      let clientId = params.client_id || params.clientId || null;

      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();

      // accept phone OR mobilephone param names
      const phone = normalizePhone(params.mobilephone || params.mobile_phone || params.phone);

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
        const addressLine1 = (params.address_line1 || "").toString().trim();
        const city = (params.city || "").toString().trim();
        const state = (params.state || "").toString().trim();
        const postalCode = (params.postal_code || "").toString().trim();

        if (!first || !last) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message:
              "New client booking needs client_first_name and client_last_name (and ideally email/phone).",
            paramsReceived: params,
          });
        }

        const createResp = await mbFetch("/client/addclient", {
          method: "POST",
          body: {
            FirstName: first,
            LastName: last,
            Email: email || undefined,
            MobilePhone: phone || undefined,
            AddressLine1: addressLine1 || undefined,
            City: city || undefined,
            State: state || undefined,
            PostalCode: postalCode || undefined,
          },
        });

        clientId =
          createResp?.Client?.Id ||
          createResp?.Client?.ClientId ||
          createResp?.Id ||
          createResp?.ClientId ||
          null;
      }

      if (!clientId) {
        return res.status(409).json({
          success: false,
          actionReceived: action,
          message:
            "Client likely already exists, but could not be located via search. Try asking for the phone or email exactly as on file, or use client_id.",
          paramsReceived: params,
        });
      }

      const bookResp = await mbFetch("/class/addclienttoclass", {
        method: "POST",
        body: {
          ClientId: clientId,
          ClassId: classId,
          RequirePayment: false,
        },
      });

      return res.status(200).json({
        success: true,
        actionReceived: action,
        booked: true,
        clientId,
        classId,
        raw: bookResp,
      });
    }

    return res.status(400).json({
      success: false,
      actionReceived: action,
      message: `Unknown action: ${action}`,
      paramsReceived: params,
    });
  } catch (err) {
    console.error("WEBHOOK_ERROR", err?.message || err, err?.stack || "");
    return res.status(500).json({
      success: false,
      message: err?.message || "Server error",
    });
  }
});

// IMPORTANT: only declare PORT once
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));












