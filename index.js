import express from "express";

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
  // returns YYYY-MM-DD for the given TZ
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
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

function normalizePhone(phone) {
  if (!phone) return "";
  return String(phone).trim();
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
    // 1) Pull action from query OR body OR action_type
    const action =
      req.query?.action ||
      req.body?.action ||
      req.body?.action_type ||
      "";

    // 2) Pull params from body.params + extra top-level + query (query wins)
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
     * ACTION: get_today_schedule
     * =====================
     * Mindbody: GET /class/classes :contentReference[oaicite:2]{index=2}
     */
    if (action === "get_today_schedule") {
      const date = params.date || nowInTZDateString("America/Vancouver");
      const { startISO, endISO } = toISODateRangeForDay(date);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startISO,
          EndDateTime: endISO,
        },
      });

      const classesRaw = normalizeArray(data, ["Classes", "classes"]);
      const classes = classesRaw.map((c) => ({
        classId: c.Id ?? c.ClassId ?? c.classId ?? null,
        name: c.ClassDescription?.Name ?? c.Name ?? c.className ?? "Class",
        startDateTime: c.StartDateTime ?? c.startDateTime ?? null,
        endDateTime: c.EndDateTime ?? c.endDateTime ?? null,
        instructor:
          c.Staff?.Name ??
          c.Staff?.FirstName ??
          c.InstructorName ??
          c.instructor ??
          null,
        location: c.Location?.Name ?? c.LocationName ?? c.location ?? null,
      }));

      return res.status(200).json({
        success: true,
        actionReceived: action,
        date,
        classes,
      });
    }

    /**
     * =====================
     * ACTION: get_pricing_offers
     * =====================
     * Public v6 Sale endpoints:
     * - GET /sale/services
     * - GET /sale/packages
     * - GET /sale/contracts :contentReference[oaicite:3]{index=3}
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
        offers: {
          services,
          packages,
          contracts,
        },
        warnings: {
          services: servicesResp.status === "rejected" ? String(servicesResp.reason?.message || servicesResp.reason) : null,
          packages: packagesResp.status === "rejected" ? String(packagesResp.reason?.message || packagesResp.reason) : null,
          contracts: contractsResp.status === "rejected" ? String(contractsResp.reason?.message || contractsResp.reason) : null,
        },
      });
    }

    /**
     * =====================
     * ACTION: book_class
     * =====================
     * - Books a client into a class: POST /class/addclienttoclass :contentReference[oaicite:4]{index=4}
     * - If is_new_client=true and we can't find them, we create them:
     *   POST /client/addclient :contentReference[oaicite:5]{index=5}
     */
    if (action === "book_class") {
      const isNewClient =
        params.is_new_client === true ||
        String(params.is_new_client || "").toLowerCase() === "true" ||
        String(params.is_new_client || "").toLowerCase() === "yes";

      // 1) Determine classId
      let classId = params.class_id || params.classId || null;

      if (!classId) {
        const date = params.date || nowInTZDateString("America/Vancouver");
        const { startISO, endISO } = toISODateRangeForDay(date);

        const sched = await mbFetch("/class/classes", {
          method: "GET",
          query: { StartDateTime: startISO, EndDateTime: endISO },
        });

        const classes = normalizeArray(sched, ["Classes", "classes"]);

        const desiredName = (params.class_name || "").toString().toLowerCase().trim();
        const desiredTime = (params.time || "")
          .toString()
          .toLowerCase()
          .replace(/\s+/g, " ")
          .trim();

        const match = classes.find((c) => {
          const nm =
            (c.ClassDescription?.Name ?? c.Name ?? "").toString().toLowerCase().trim();
          const st = (c.StartDateTime ?? "").toString();

          const stHuman = st
            ? new Date(st).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
              }).toLowerCase()
            : "";

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

      // 2) Determine clientId (find existing)
      let clientId = params.client_id || params.clientId || null;

      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();
      const phone = normalizePhone(params.phone);

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

      // 2b) If still no client and is_new_client=true => create client
      if (!clientId && isNewClient) {
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
          },
        });

        // Common response includes the created client object/id
        clientId =
          createResp?.Client?.Id ||
          createResp?.Client?.ClientId ||
          createResp?.Id ||
          createResp?.ClientId ||
          null;
      }

      if (!clientId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Could not find client. If this is a NEW client, set is_new_client=true and provide first/last (+ email/phone). Otherwise provide client_id.",
          paramsReceived: params,
        });
      }

      // 3) Book into class
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





