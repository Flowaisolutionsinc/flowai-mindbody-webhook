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
  for (const k of keys) if (Array.isArray(payload[k])) return payload[k];
  if (Array.isArray(payload.Results)) return payload.Results;
  return [];
}

function toISODateRangeForDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
}

function isTruthy(v) {
  if (v === true) return true;
  const s = String(v ?? "").toLowerCase().trim();
  return s === "true" || s === "yes" || s === "y" || s === "1";
}

function mbHeaders() {
  return {
    "Content-Type": "application/json",
    "Api-Key": apiKey,
    SiteId: siteId,
    "Source-Name": sourceName,
    Password: sourcePassword,
    SourcePassword: sourcePassword,
  };
}

async function mbFetch(path, { method = "GET", query, body } = {}) {
  if (!siteId || !apiKey || !sourceName || !sourcePassword) {
    const e = new Error(
      `Missing ENV. hasSiteId=${Boolean(siteId)} hasApiKey=${Boolean(apiKey)} hasSourceName=${Boolean(
        sourceName
      )} hasSourcePassword=${Boolean(sourcePassword)}`
    );
    e.status = 500;
    throw e;
  }

  const url = new URL(`${MINDBODY_BASE_URL}${path}`);
  if (query && typeof query === "object") {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: mbHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = safeJsonParse(text);

  if (!res.ok) {
    const detail = json || (text ? { raw: text.slice(0, 700) } : { raw: "(no response body)" });
    const e = new Error(
      `Mindbody API error ${res.status} ${res.statusText} at ${path}: ${JSON.stringify(detail)}`
    );
    e.status = res.status;
    e.detail = detail;
    throw e;
  }

  return json ?? { raw: text };
}

// Search helper: try email first, then phone, then name
async function findClientId({ first, last, email, phone }) {
  const attempts = [];

  if (email && email.length >= 3) attempts.push(email);
  if (phone && phone.length >= 3) attempts.push(phone);
  const fullName = `${first} ${last}`.trim();
  if (fullName.length >= 3) attempts.push(fullName);

  for (const searchText of attempts) {
    const clientResp = await mbFetch("/client/clients", {
      method: "GET",
      query: { SearchText: searchText },
    });

    const clients = normalizeArray(clientResp, ["Clients", "clients"]);
    if (!clients.length) continue;

    const firstLower = (first || "").toLowerCase();
    const lastLower = (last || "").toLowerCase();

    const best =
      clients.find((c) => {
        const fn = (c.FirstName ?? "").toString().toLowerCase();
        const ln = (c.LastName ?? "").toString().toLowerCase();
        return (firstLower ? fn === firstLower : true) && (lastLower ? ln === lastLower : true);
      }) || clients[0];

    return best?.Id ?? best?.ClientId ?? null;
  }

  return null;
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
    const action = req.query?.action || req.body?.action || req.body?.action_type || "";

    const paramsFromQuery = { ...(req.query || {}) };
    delete paramsFromQuery.action;

    const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
    const paramsFromBody = bodyObj.params && typeof bodyObj.params === "object" ? bodyObj.params : {};

    const extraTopLevelBody = { ...bodyObj };
    delete extraTopLevelBody.action;
    delete extraTopLevelBody.action_type;
    delete extraTopLevelBody.params;

    const params = { ...paramsFromBody, ...extraTopLevelBody, ...paramsFromQuery };

    console.log("WEBHOOK_HIT", { method: req.method, action, params });

    if (!action) {
      return res.status(400).json({
        success: false,
        message: "Missing action. Send ?action=... OR JSON { action:'...', params:{...} }",
        receivedQuery: req.query || {},
        receivedBody: req.body || {},
      });
    }

    // ---------------------
    // get_today_schedule
    // ---------------------
    if (action === "get_today_schedule") {
      const date = params.date || nowInTZDateString("America/Vancouver");
      const { startISO, endISO } = toISODateRangeForDay(date);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: { StartDateTime: startISO, EndDateTime: endISO },
      });

      const classesRaw = normalizeArray(data, ["Classes", "classes"]);
      const classes = classesRaw.map((c) => ({
        classId: c.Id ?? c.ClassId ?? c.classId ?? null,
        name: c.ClassDescription?.Name ?? c.Name ?? c.className ?? "Class",
        startDateTime: c.StartDateTime ?? c.startDateTime ?? null,
        endDateTime: c.EndDateTime ?? c.endDateTime ?? null,
        instructor: c.Staff?.Name ?? c.Staff?.FirstName ?? c.InstructorName ?? c.instructor ?? null,
        location: c.Location?.Name ?? c.LocationName ?? c.location ?? null,
      }));

      return res.status(200).json({ success: true, actionReceived: action, date, classes });
    }

    // ---------------------
    // get_pricing_offers
    // ---------------------
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
          services: servicesResp.status === "rejected" ? String(servicesResp.reason?.message || servicesResp.reason) : null,
          packages: packagesResp.status === "rejected" ? String(packagesResp.reason?.message || packagesResp.reason) : null,
          contracts: contractsResp.status === "rejected" ? String(contractsResp.reason?.message || contractsResp.reason) : null,
        },
      });
    }

    // ---------------------
    // book_class
    // ---------------------
    if (action === "book_class") {
      const isNewClient = isTruthy(params.is_new_client);

      // REQUIRED for booking
      const classId = params.class_id || params.classId || null;
      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();
      const phone = normalizePhone(params.phone);

      if (!classId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message: "Missing class_id. (Best practice: pick from get_today_schedule and pass class_id.)",
          paramsReceived: params,
        });
      }

      if (!first || !last) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message: "Missing client_first_name or client_last_name.",
          paramsReceived: params,
        });
      }

      // Existing clients MUST provide at least email or phone to find them
      if (!isNewClient && !email && !phone && !params.client_id && !params.clientId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Existing client booking requires email or phone (or client_id). Ask caller for the email/phone they used at Oxygen.",
          paramsReceived: params,
        });
      }

      // If client_id passed, skip search/create
      let clientId = params.client_id || params.clientId || null;

      // Otherwise find by search
      if (!clientId) {
        clientId = await findClientId({ first, last, email, phone });
      }

      // If not found and new client => create
      if (!clientId && isNewClient) {
        const address1 = (params.address_line1 || "").toString().trim();
        const city = (params.city || "").toString().trim();
        const state = (params.state || "").toString().trim();
        const postal = (params.postal_code || "").toString().trim();
        const country = (params.country || "CA").toString().trim();

        if (!address1 || !city || !state || !postal) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message:
              "New client requires address_line1, city, state, postal_code (Mindbody requires these to create a client).",
            paramsReceived: params,
          });
        }

        try {
          const createResp = await mbFetch("/client/addclient", {
            method: "POST",
            body: {
              FirstName: first,
              LastName: last,
              Email: email || undefined,
              MobilePhone: phone || undefined,
              AddressLine1: address1,
              City: city,
              State: state,
              PostalCode: postal,
              Country: country,
            },
          });

          clientId =
            createResp?.Client?.Id ||
            createResp?.Client?.ClientId ||
            createResp?.Id ||
            createResp?.ClientId ||
            null;
        } catch (e) {
          // If duplicate error, try searching again
          const msg = String(e?.message || "");
          if (msg.includes("duplicate") || msg.includes("InvalidClientCreation")) {
            clientId = await findClientId({ first, last, email, phone });
            if (!clientId) {
              return res.status(409).json({
                success: false,
                actionReceived: action,
                message:
                  "Client likely already exists but could not be located via search. Ask caller for the exact email/phone on file, or use client_id.",
              });
            }
          } else {
            // bubble others
            throw e;
          }
        }
      }

      if (!clientId) {
        return res.status(404).json({
          success: false,
          actionReceived: action,
          message:
            "Could not find client. If NEW client set is_new_client=true and provide address fields. If existing, collect exact email/phone or use client_id.",
          paramsReceived: params,
        });
      }

      // Book into class
      try {
        const bookResp = await mbFetch("/class/addclienttoclass", {
          method: "POST",
          body: { ClientId: clientId, ClassId: classId, RequirePayment: false },
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
        const msg = String(e?.message || "");
        if (msg.includes("SchedulingWindowViolated")) {
          return res.status(422).json({
            success: false,
            actionReceived: action,
            message:
              "Mindbody says booking is outside the scheduling window for this class. Try a different class_id/time, or adjust booking rules in Mindbody.",
          });
        }
        throw e;
      }
    }

    // Unknown action
    return res.status(400).json({
      success: false,
      actionReceived: action,
      message: `Unknown action: ${action}`,
      paramsReceived: params,
    });
  } catch (err) {
    console.error("WEBHOOK_ERROR", err?.message || err, err?.stack || "");

    // If Mindbody threw an HTTP status, return that instead of 500
    const status = Number(err?.status) || 500;

    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      message: err?.message || "Server error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));









