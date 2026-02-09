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

function normalizeClasses(payload) {
  // Mindbody responses vary; handle common shapes
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.Classes)) return payload.Classes;
  if (Array.isArray(payload.classes)) return payload.classes;
  if (Array.isArray(payload.Results)) return payload.Results;
  return [];
}

function normalizePrices(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.OnlinePrices)) return payload.OnlinePrices;
  if (Array.isArray(payload.Prices)) return payload.Prices;
  if (Array.isArray(payload.Results)) return payload.Results;
  return [];
}

function normalizeClients(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.Clients)) return payload.Clients;
  if (Array.isArray(payload.clients)) return payload.clients;
  if (Array.isArray(payload.Results)) return payload.Results;
  return [];
}

function toISODateRangeForDay(dateStr /* YYYY-MM-DD */) {
  // Mindbody often accepts ISO strings. We'll use "day start" to "day end" as UTC-ish.
  // If your studio timezone is strict, Mindbody still typically interprets dates correctly server-side.
  const start = new Date(`${dateStr}T00:00:00`);
  const end = new Date(`${dateStr}T23:59:59`);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
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
    // Mindbody public API headers (common pattern)
    "Api-Key": apiKey,
    SiteId: siteId,
    "Source-Name": sourceName,
    // Some setups expect "Password", others "SourcePassword"—we send both to be safe.
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
      (text ? { raw: text.slice(0, 500) } : { raw: "(no response body)" });
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
 *
 * Agency Vault typically sends JSON fields you define as top-level or nested.
 * We accept BOTH.
 */
app.all("/mindbody", async (req, res) => {
  try {
    // 1) Pull action from query OR body OR action_type
    const action =
      req.query?.action ||
      req.body?.action ||
      req.body?.action_type ||
      "";

    // 2) Pull params from:
    // - req.body.params (preferred)
    // - plus any extra top-level body fields (if AV sends them)
    // - plus query params (except action)
    const paramsFromQuery = { ...(req.query || {}) };
    delete paramsFromQuery.action;

    const bodyObj = req.body && typeof req.body === "object" ? req.body : {};
    const paramsFromBody = bodyObj.params && typeof bodyObj.params === "object" ? bodyObj.params : {};

    const extraTopLevelBody = { ...bodyObj };
    delete extraTopLevelBody.action;
    delete extraTopLevelBody.action_type;
    delete extraTopLevelBody.params;

    // Merge order: paramsFromBody <- extraTopLevelBody <- paramsFromQuery (query wins)
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
     * Params accepted:
     * - date (YYYY-MM-DD) optional; defaults to today in America/Vancouver
     */
    if (action === "get_today_schedule") {
      const date = params.date || nowInTZDateString("America/Vancouver");
      const { startISO, endISO } = toISODateRangeForDay(date);

      // Mindbody endpoint commonly used for schedule:
      // GET /class/classes?StartDateTime=...&EndDateTime=...
      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startISO,
          EndDateTime: endISO,
        },
      });

      const classes = normalizeClasses(data).map((c) => ({
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
        raw: data, // keep for debugging
      });
    }

    /**
     * =====================
     * ACTION: get_pricing_offers
     * =====================
     * Params accepted (optional, used mainly for filtering or future logic):
     * - pricing_interest
     * - is_new_client
     * - membership_interest
     * - class_pack_interest
     * - notes
     */
    if (action === "get_pricing_offers") {
      // Mindbody endpoint commonly used:
      // GET /sale/onlineprices
      const data = await mbFetch("/sale/onlineprices", { method: "GET" });

      const prices = normalizePrices(data).map((p) => ({
        id: p.Id ?? p.id ?? null,
        name: p.Name ?? p.name ?? "Offer",
        price: p.Price ?? p.price ?? null,
        onlinePrice: p.OnlinePrice ?? p.onlinePrice ?? null,
        taxIncluded: p.TaxIncluded ?? p.taxIncluded ?? null,
        type: p.Type ?? p.type ?? null,
        duration: p.Duration ?? p.duration ?? null,
        description: p.Description ?? p.description ?? null,
      }));

      return res.status(200).json({
        success: true,
        actionReceived: action,
        filtersReceived: {
          pricing_interest: params.pricing_interest || null,
          is_new_client: params.is_new_client || null,
          membership_interest: params.membership_interest || null,
          class_pack_interest: params.class_pack_interest || null,
          notes: params.notes || null,
        },
        prices,
        raw: data,
      });
    }

    /**
     * =====================
     * ACTION: book_class
     * =====================
     * BEST CASE: AV passes these:
     * - class_id
     * - client_id
     *
     * Otherwise we try to find:
     * - class_name + date + time
     * - client_first_name + client_last_name (+ optional phone/email)
     *
     * Params accepted:
     * - date (YYYY-MM-DD)
     * - time (e.g. "6:00 PM" or ISO)
     * - class_name
     * - class_id
     * - client_id
     * - client_first_name
     * - client_last_name
     * - email
     * - phone
     */
    if (action === "book_class") {
      // 1) Determine classId
      let classId = params.class_id || params.classId || null;

      if (!classId) {
        const date = params.date || nowInTZDateString("America/Vancouver");
        const { startISO, endISO } = toISODateRangeForDay(date);

        const sched = await mbFetch("/class/classes", {
          method: "GET",
          query: { StartDateTime: startISO, EndDateTime: endISO },
        });

        const classes = normalizeClasses(sched);

        const desiredName = (params.class_name || "").toString().toLowerCase().trim();
        const desiredTime = (params.time || "").toString().toLowerCase().replace(/\s+/g, " ").trim();

        const match = classes.find((c) => {
          const nm =
            (c.ClassDescription?.Name ?? c.Name ?? "").toString().toLowerCase().trim();
          const st = (c.StartDateTime ?? "").toString();
          const stHuman = st ? new Date(st).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).toLowerCase() : "";
          const stHuman2 = st ? new Date(st).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).toLowerCase() : "";

          const nameOk = desiredName ? nm.includes(desiredName) : true;
          const timeOk = desiredTime
            ? (stHuman.includes(desiredTime) || stHuman2.includes(desiredTime) || st.toLowerCase().includes(desiredTime))
            : true;

          return nameOk && timeOk;
        });

        classId = match?.Id ?? match?.ClassId ?? null;
      }

      if (!classId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Missing class_id and could not match a class. Provide class_id OR (class_name + date + time).",
          paramsReceived: params,
        });
      }

      // 2) Determine clientId
      let clientId = params.client_id || params.clientId || null;

      if (!clientId) {
        const first = (params.client_first_name || "").toString().trim();
        const last = (params.client_last_name || "").toString().trim();
        const email = (params.email || "").toString().trim();
        const phone = (params.phone || "").toString().trim();

        const searchText = [email, phone, `${first} ${last}`].find((x) => x && x.length >= 3);

        if (!searchText) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message:
              "Missing client_id and not enough info to search client. Provide client_id OR (client_first_name + client_last_name) plus optional email/phone.",
            paramsReceived: params,
          });
        }

        // Mindbody client search endpoint often:
        // GET /client/clients?SearchText=...
        const clientResp = await mbFetch("/client/clients", {
          method: "GET",
          query: { SearchText: searchText },
        });

        const clients = normalizeClients(clientResp);

        // pick best match by name if possible
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

      if (!clientId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Could not find client. Provide a valid client_id or ensure name/email/phone matches an existing client in Mindbody.",
          paramsReceived: params,
        });
      }

      // 3) Book: Mindbody commonly supports:
      // POST /class/addclienttoclass  { ClientId, ClassId, RequirePayment }
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

    // Unknown action
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




