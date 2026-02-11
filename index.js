import express from "express";

const app = express();

// IMPORTANT: support both JSON and form submissions (Agency Vault sometimes posts urlencoded)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

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

function toISODateRangeForDay(dateStr /* YYYY-MM-DD */) {
  // NOTE: this matches what you've been using; keeps behavior consistent.
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
}

function toLowerClean(x) {
  return (x ?? "").toString().toLowerCase().trim();
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
 * Get a param value from many possible key spellings/cases.
 * This fixes your MobilePhone issue (you were receiving "Phone" not "phone").
 */
function pick(params, keys = []) {
  for (const k of keys) {
    if (params?.[k] !== undefined && params?.[k] !== null && String(params[k]).trim() !== "") {
      return params[k];
    }
  }
  return "";
}

/**
 * Best-effort extraction of capacity & booked counts from Mindbody class object.
 */
function extractCapacityInfo(c) {
  const candidatesCapacity = [
    c.MaxCapacity,
    c.WebCapacity,
    c.Capacity,
    c.ClassCapacity,
    c?.ClassDescription?.MaxCapacity,
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

  return { capacity: capNum, booked: bookedNum, spotsAvailable, isWaitlistAvailable };
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

  // Keep your existing header scheme (works for your account)
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
      json || (text ? { raw: text.slice(0, 900) } : { raw: "(no response body)" });
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
      req.query?.action ||
      req.body?.action ||
      req.body?.action_type ||
      req.body?.Action ||
      "";

    const paramsFromQuery = { ...(req.query || {}) };
    delete paramsFromQuery.action;

    const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
    const paramsFromBody =
      bodyObj.params && typeof bodyObj.params === "object" ? bodyObj.params : {};

    const extraTopLevelBody = { ...bodyObj };
    delete extraTopLevelBody.action;
    delete extraTopLevelBody.action_type;
    delete extraTopLevelBody.Action;
    delete extraTopLevelBody.params;

    // Merge: body.params, then top-level body, then query
    const params = { ...paramsFromBody, ...extraTopLevelBody, ...paramsFromQuery };

    console.log("WEBHOOK_HIT", {
      method: req.method,
      action,
      params,
    });

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
     * ACTION: get_today_schedule (supports any date via params.date)
     * =====================
     */
    if (action === "get_today_schedule") {
      const date = pick(params, ["date", "Date", "schedule_date", "ScheduleDate"]) || nowInTZDateString("America/Vancouver");
      const { startISO, endISO } = toISODateRangeForDay(date);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startISO,
          EndDateTime: endISO,
        },
      });

      const classesRaw = normalizeArray(data, ["Classes", "classes"]);

      const wantType = toLowerClean(pick(params, ["class_type", "class_name", "ClassType", "ClassName"]));
      const wantInstructor = toLowerClean(pick(params, ["instructor_name", "InstructorName"]));
      const wantTimeRange = toLowerClean(pick(params, ["time_range", "TimeRange"]));
      const wantTime = toLowerClean(pick(params, ["time", "Time"]));

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

      if (wantType) classes = classes.filter((x) => toLowerClean(x.name).includes(wantType));
      if (wantInstructor) classes = classes.filter((x) => toLowerClean(x.instructor).includes(wantInstructor));
      if (wantTimeRange) classes = classes.filter((x) => toLowerClean(x._timeBucket) === wantTimeRange);
      if (wantTime) classes = classes.filter((x) => toLowerClean(x.startTimeLocal).includes(wantTime));

      classes = classes.map(({ _timeBucket, ...rest }) => rest);

      return res.status(200).json({
        success: true,
        actionReceived: action,
        date,
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
        String(pick(params, ["is_new_client", "IsNewClient"]) || "").toLowerCase() === "true" ||
        String(pick(params, ["is_new_client", "IsNewClient"]) || "").toLowerCase() === "yes";

      let classId = pick(params, ["class_id", "classId", "ClassId", "ClassID"]);

      if (!classId) {
        const date = pick(params, ["date", "Date"]) || nowInTZDateString("America/Vancouver");
        const { startISO, endISO } = toISODateRangeForDay(date);

        const sched = await mbFetch("/class/classes", {
          method: "GET",
          query: { StartDateTime: startISO, EndDateTime: endISO },
        });

        const classes = normalizeArray(sched, ["Classes", "classes"]);

        const desiredName = toLowerClean(pick(params, ["class_name", "class_type", "ClassName", "ClassType"]));
        const desiredTime = toLowerClean(pick(params, ["time", "Time"]));

        const match = classes.find((c) => {
          const nm = toLowerClean(c.ClassDescription?.Name ?? c.Name ?? "");
          const st = (c.StartDateTime ?? "").toString();
          const stHuman = st ? (humanTime(st)?.toLowerCase() || "") : "";

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
            "Missing class_id and could not match a class. BEST PRACTICE: call get_today_schedule first and pass back classId.",
          paramsReceived: params,
        });
      }

      let clientId = pick(params, ["client_id", "clientId", "ClientId", "ClientID"]);

      // IMPORTANT: accept all possible key spellings from the agent/custom action UI
      const first = String(pick(params, ["client_first_name", "clientFirstName", "ClientFirstName", "FirstName"])).trim();
      const last = String(pick(params, ["client_last_name", "clientLastName", "ClientLastName", "LastName"])).trim();
      const email = String(pick(params, ["email", "Email"])).trim();
      const phoneRaw = pick(params, ["phone", "Phone", "mobilephone", "mobilePhone", "MobilePhone"]);
      const phone = normalizePhone(phoneRaw);

      if (!clientId) {
        const searchText = [email, phone, `${first} ${last}`].find((x) => x && String(x).trim().length >= 3);

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
        const addressLine1 = String(pick(params, ["address_line1", "AddressLine1"])).trim();
        const city = String(pick(params, ["city", "City"])).trim();
        const state = String(pick(params, ["state", "State"])).trim();
        const postalCode = String(pick(params, ["postal_code", "postalCode", "PostalCode"])).trim();

        if (!first || !last) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message: "New client booking needs client_first_name and client_last_name.",
            paramsReceived: params,
          });
        }

        // This is the critical fix: ALWAYS send MobilePhone if we have phone/Phone from AV
        const createBody = {
          FirstName: first,
          LastName: last,
          Email: email || undefined,
          MobilePhone: phone || undefined,
          AddressLine1: addressLine1 || undefined,
          City: city || undefined,
          State: state || undefined,
          PostalCode: postalCode || undefined,
        };

        console.log("ADDCLIENT_BODY", createBody);

        const createResp = await mbFetch("/client/addclient", {
          method: "POST",
          body: createBody,
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
            "Client likely already exists, but could not be located via search. Ask for the email/phone exactly as on file or pass client_id.",
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));












