import express from "express";

const app = express();

// ✅ Accept BOTH JSON and form-urlencoded (Agency Vault often sends form data)
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

function toISODateRangeForDay(dateStr) {
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
}

function asBool(v) {
  if (v === true) return true;
  const s = String(v || "").toLowerCase().trim();
  return s === "true" || s === "yes" || s === "1";
}

// ✅ So we can pass through Mindbody HTTP status when helpful
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function mbFetch(path, { method = "GET", query, body } = {}) {
  if (!siteId || !apiKey || !sourceName || !sourcePassword) {
    throw new HttpError(
      500,
      `Missing ENV. hasSiteId=${Boolean(siteId)} hasApiKey=${Boolean(
        apiKey
      )} hasSourceName=${Boolean(sourceName)} hasSourcePassword=${Boolean(
        sourcePassword
      )}`
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
      json || (text ? { raw: text.slice(0, 700) } : { raw: "(no response body)" });

    throw new HttpError(
      res.status,
      `Mindbody API error ${res.status} ${res.statusText} at ${path}: ${JSON.stringify(
        detail
      )}`
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
 * WEBHOOK
 * ============
 */
app.all("/mindbody", async (req, res) => {
  try {
    // action from query OR body
    const action = req.query?.action || req.body?.action || req.body?.action_type || "";

    // merge params from query/body (supports form encoded too)
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

    // ✅ Dry-run always returns 200 so Agency Vault can initialize/save
    if (asBool(params.dry_run)) {
      return res.status(200).json({
        success: true,
        dry_run: true,
        actionReceived: action || "(missing)",
        paramsReceived: params,
      });
    }

    // ✅ IMPORTANT: Return 200 even if missing/unknown action
    // (prevents Agency Vault from blocking Save/Initialize)
    if (!action) {
      return res.status(200).json({
        success: false,
        message:
          "Missing action. Add ?action=book_class to the URL OR include { action:'book_class' } in body. (Returned 200 intentionally so setup can proceed.)",
        receivedQuery: req.query || {},
        receivedBody: req.body || {},
      });
    }

    /**
     * ACTION: get_today_schedule
     */
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
        name: c.ClassDescription?.Name ?? c.Name ?? "Class",
        startDateTime: c.StartDateTime ?? null,
        endDateTime: c.EndDateTime ?? null,
        instructor: c.Staff?.Name ?? c.Staff?.FirstName ?? null,
        location: c.Location?.Name ?? c.LocationName ?? null,
      }));

      return res.status(200).json({ success: true, actionReceived: action, date, classes });
    }

    /**
     * ACTION: get_pricing_offers
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
     * ACTION: book_class
     */
    if (action === "book_class") {
      const isNewClient = asBool(params.is_new_client);

      let classId = params.class_id || params.classId || null;

      if (!classId) {
        return res.status(200).json({
          success: false,
          actionReceived: action,
          message: "Missing class_id (returning 200 for setup).",
          paramsReceived: params,
        });
      }

      let clientId = params.client_id || params.clientId || null;

      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();
      const phone = normalizePhone(params.phone);

      // Try find existing
      if (!clientId) {
        const searchText = [email, phone, `${first} ${last}`].find((x) => x && x.length >= 3);
        if (searchText) {
          const clientResp = await mbFetch("/client/clients", {
            method: "GET",
            query: { SearchText: searchText },
          });
          const clients = normalizeArray(clientResp, ["Clients", "clients"]);
          clientId = clients?.[0]?.Id ?? clients?.[0]?.ClientId ?? null;
        }
      }

      // Create new if needed
      if (!clientId && isNewClient) {
        const address1 = (params.address_line1 || "").toString().trim();
        const city = (params.city || "").toString().trim();
        const state = (params.state || "").toString().trim();
        const postal = (params.postal_code || "").toString().trim();
        const country = (params.country || "CA").toString().trim();

        if (!first || !last || !address1 || !city || !state || !postal) {
          return res.status(200).json({
            success: false,
            actionReceived: action,
            message:
              "New client needs first/last AND address_line1/city/state/postal_code (returning 200 for setup).",
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
      }

      if (!clientId) {
        return res.status(200).json({
          success: false,
          actionReceived: action,
          message:
            "Could not resolve client. Use client_id for existing clients, or ensure new client details are complete. (Returning 200 for setup.)",
          paramsReceived: params,
        });
      }

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
    }

    // ✅ Unknown action returns 200 (so the tool can still save during setup)
    return res.status(200).json({
      success: false,
      actionReceived: action,
      message: `Unknown action: ${action} (returning 200 for setup)`,
      paramsReceived: params,
    });
  } catch (err) {
    const status = err?.status || 500;
    console.error("WEBHOOK_ERROR", err?.message || err, err?.stack || "");
    // ✅ Even errors return 200 during setup? No — real errors should stay visible:
    return res.status(status).json({
      success: false,
      message: err?.message || "Server error",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));










