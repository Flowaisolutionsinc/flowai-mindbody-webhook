import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

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

/**
 * ============
 * HELPERS
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

// Best-effort day window.
// NOTE: MB often accepts UTC ISOs. This works for schedule listing,
// but if you see off-by-one-day issues, we’ll adjust this next.
function toISODateRangeForDay(dateStr /* YYYY-MM-DD */) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function decodeMaybe(x) {
  if (x === undefined || x === null) return "";
  const s = String(x);
  try {
    // if it contains % it might be url-encoded
    return s.includes("%") ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}

function cleanStr(x) {
  return decodeMaybe(x).trim();
}

function toLowerClean(x) {
  return cleanStr(x).toLowerCase();
}

// Accepts Phone / phone / MobilePhone / mobilephone / mobile_phone etc.
function getParam(params, ...names) {
  for (const n of names) {
    if (params[n] !== undefined && params[n] !== null && String(params[n]).trim() !== "") {
      return params[n];
    }
    const lower = n.toLowerCase();
    // scan keys case-insensitively
    for (const k of Object.keys(params)) {
      if (k.toLowerCase() === lower) {
        const v = params[k];
        if (v !== undefined && v !== null && String(v).trim() !== "") return v;
      }
    }
  }
  return undefined;
}

function truthy(x) {
  const v = toLowerClean(x);
  return v === "true" || v === "yes" || v === "1";
}

function timeBucketFromISO(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const hour = d.getHours();
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

function humanTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
}

/**
 * Best-effort extraction of capacity & booked counts from Mindbody class object.
 * If MB doesn’t return these fields for this endpoint/account, spotsAvailable will be null.
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
    c.IsWaitlistAvailable ??
    c.WaitlistAvailable ??
    c.AllowWaitlist ??
    null;

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
    },
  });
});

/**
 * ============
 * MAIN WEBHOOK
 * ============
 */
app.all("/mindbody", async (req, res) => {
  try {
    const action =
      getParam(req.query || {}, "action") ||
      getParam(req.body || {}, "action", "action_type") ||
      "";

    const paramsFromQuery = { ...(req.query || {}) };
    delete paramsFromQuery.action;

    const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
    const paramsFromBody =
      bodyObj.params && typeof bodyObj.params === "object" ? bodyObj.params : {};

    const extraTopLevelBody = { ...bodyObj };
    delete extraTopLevelBody.action;
    delete extraTopLevelBody.action_type;
    delete extraTopLevelBody.params;

    // merged params (body params + body top-level + query params)
    const params = { ...paramsFromBody, ...extraTopLevelBody, ...paramsFromQuery };

    console.log("WEBHOOK_HIT", { method: req.method, action, params });

    if (!action) {
      return res.status(400).json({
        success: false,
        message:
          "Missing action. Send JSON { action:'your_action', ... } or include action as a fixed parameter in the custom action.",
        receivedQuery: req.query || {},
        receivedBody: req.body || {},
      });
    }

    /**
     * =====================
     * ACTION: get_today_schedule
     * =====================
     */
    if (action === "get_today_schedule") {
      const date = cleanStr(getParam(params, "date")) || nowInTZDateString("America/Vancouver");
      const { startISO, endISO } = toISODateRangeForDay(date);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startISO,
          EndDateTime: endISO,
        },
      });

      const classesRaw = normalizeArray(data, ["Classes", "classes"]);

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
          startTimeLocal: startDateTime ? humanTime(startDateTime) : null,
          instructor,
          location,
          capacity: cap.capacity,
          booked: cap.booked,
          spotsAvailable: cap.spotsAvailable,
          isWaitlistAvailable: cap.isWaitlistAvailable,
          _timeBucket: startDateTime ? timeBucketFromISO(startDateTime) : null,
        };
      });

      classes = classes.map(({ _timeBucket, ...rest }) => rest);

      return res.status(200).json({
        success: true,
        actionReceived: action,
        date,
        classes,
        notes: {
          capacityLogic:
            "spotsAvailable is best-effort. If Mindbody does not return capacity/booked fields on /class/classes for this account, spotsAvailable will be null or 0. We may need a different endpoint for true remaining spots.",
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
      const dryRun = truthy(getParam(params, "dry_run", "dryRun"));

      const isNewClient = truthy(getParam(params, "is_new_client", "isNewClient"));

      let classId = cleanStr(getParam(params, "class_id", "classId", "ClassId"));

      if (!classId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Missing class_id. Best practice: call get_today_schedule for the target date, then pass its classId into book_class.",
          paramsReceived: params,
        });
      }

      let clientId = cleanStr(getParam(params, "client_id", "clientId", "ClientId"));

      const first = cleanStr(getParam(params, "client_first_name", "first_name", "FirstName"));
      const last = cleanStr(getParam(params, "client_last_name", "last_name", "LastName"));
      const email = cleanStr(getParam(params, "email", "Email"));
      // accept phone/mobilephone in any casing; map to MobilePhone for MB
      const phone = cleanStr(
        getParam(params, "mobilephone", "MobilePhone", "mobile_phone", "phone", "Phone")
      );

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
        const addressLine1 = cleanStr(getParam(params, "address_line1", "AddressLine1"));
        const city = cleanStr(getParam(params, "city", "City"));
        const state = cleanStr(getParam(params, "state", "State"));
        const postalCode = cleanStr(getParam(params, "postal_code", "PostalCode"));

        if (!first || !last) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message: "New client booking requires first and last name.",
            paramsReceived: params,
          });
        }

        if (!phone) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message:
              "Mindbody requires MobilePhone for this studio. Ask caller for a mobile number.",
            paramsReceived: params,
          });
        }

        const addBody = {
          FirstName: first,
          LastName: last,
          Email: email || undefined,
          MobilePhone: phone || undefined,
          AddressLine1: addressLine1 || undefined,
          City: city || undefined,
          State: state || undefined,
          PostalCode: postalCode || undefined,
        };

        console.log("ADDCLIENT_BODY", addBody);

        const createResp = await mbFetch("/client/addclient", {
          method: "POST",
          body: addBody,
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
            "Client likely exists but search didn’t find them. Ask for the exact phone/email on file or pass client_id.",
          paramsReceived: params,
        });
      }

      if (dryRun) {
        return res.status(200).json({
          success: true,
          actionReceived: action,
          dryRun: true,
          message: "Dry run enabled — not booking class.",
          clientId,
          classId,
        });
      }

      try {
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
      } catch (e) {
        // Surface booking-window issues clearly to the AI
        const msg = String(e?.message || e);
        if (msg.includes("SchedulingWindowViolated")) {
          return res.status(409).json({
            success: false,
            actionReceived: action,
            message:
              "Mindbody says this class is outside the booking window. Try a different class time, or the studio may only allow booking within a certain timeframe.",
            clientId,
            classId,
            error: msg,
          });
        }
        throw e;
      }
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));











