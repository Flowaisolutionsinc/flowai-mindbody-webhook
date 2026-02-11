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
 * - STUDIO_TIMEZONE (default America/Vancouver)
 */
const MINDBODY_BASE_URL =
  process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6";

const TZ = process.env.STUDIO_TIMEZONE || "America/Vancouver";

const siteId = process.env.MINDBODY_SITE_ID || "";
const apiKey = process.env.MINDBODY_API_KEY || "";
const sourceName = process.env.MINDBODY_SOURCE_NAME || "";
const sourcePassword = process.env.MINDBODY_SOURCE_PASSWORD || "";

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

function nowYYYYMMDD(tz = TZ) {
  // returns YYYY-MM-DD in tz
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

function humanTime(iso, tz = TZ) {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return null;
  }
}

function timeBucketFromISO(iso, tz = TZ) {
  if (!iso) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  if (!Number.isFinite(hh)) return null;
  if (hh < 12) return "morning";
  if (hh < 17) return "afternoon";
  return "evening";
}

/**
 * Convert "today", "tomorrow", weekday names, or YYYY-MM-DD into YYYY-MM-DD (in studio tz).
 * Examples:
 * - "today" -> 2026-02-11
 * - "tomorrow" -> 2026-02-12
 * - "thursday" -> next Thursday from today (in tz)
 * - "2026-02-12" -> same
 */
function resolveDateInput(inputRaw, tz = TZ) {
  const s = toLowerClean(inputRaw);
  const todayStr = nowYYYYMMDD(tz);

  if (!s || s === "today") return todayStr;

  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const base = new Date(); // now
  // Get "today" in tz at noon to avoid DST edge cases
  const baseParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(base);
  const y = Number(baseParts.find((p) => p.type === "year")?.value);
  const m = Number(baseParts.find((p) => p.type === "month")?.value);
  const d = Number(baseParts.find((p) => p.type === "day")?.value);
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

  if (s === "tomorrow") {
    const t = new Date(noonUTC);
    t.setUTCDate(t.getUTCDate() + 1);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t);
  }

  // Weekday name -> next occurrence (including today if matches)
  const weekdays = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const idx = weekdays.indexOf(s);
  if (idx >= 0) {
    // Determine today's weekday in tz
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long" })
      .format(noonUTC)
      .toLowerCase();
    const todayIdx = weekdays.indexOf(wd);
    let add = idx - todayIdx;
    if (add < 0) add += 7;
    const t = new Date(noonUTC);
    t.setUTCDate(t.getUTCDate() + add);
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(t);
  }

  // fallback: try Date parse (like "Feb 12 2026")
  const parsed = new Date(inputRaw);
  if (!Number.isNaN(parsed.getTime())) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(parsed);
  }

  return todayStr;
}

/**
 * IMPORTANT:
 * Mindbody endpoints behave best when StartDateTime/EndDateTime are passed as "local-like" timestamps.
 * We build them WITHOUT "Z" so we don't shift days/time.
 */
function localRangeForDay(dateYYYYMMDD) {
  const startLocal = `${dateYYYYMMDD}T00:00:00`;
  const endLocal = `${dateYYYYMMDD}T23:59:59`;
  return { startLocal, endLocal };
}

/**
 * Best-effort extraction of capacity & booked counts from Mindbody class object.
 * NOTE: Many studios do NOT return capacity/booked in this endpoint, so spotsAvailable may be null.
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

  const headers = {
    "Content-Type": "application/json",
    "Api-Key": apiKey,
    SiteId: siteId,
    "Source-Name": sourceName,
    // Mindbody v6 accepts SourcePassword; keeping both doesn’t hurt
    SourcePassword: sourcePassword,
    Password: sourcePassword,
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
    timezone: TZ,
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
 * Supports:
 * - Query:  /mindbody?action=get_today_schedule&date=YYYY-MM-DD
 * - Body:   { action: "get_today_schedule", date: "tomorrow" }
 * - Body:   { action: "get_today_schedule", params: { date: "tomorrow" } }
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
          "Missing action. Send action as param or JSON: { action:'your_action', params:{...} }",
        receivedQuery: req.query || {},
        receivedBody: req.body || {},
      });
    }

    /**
     * =====================
     * ACTION: get_today_schedule (really: get_schedule_for_date)
     * =====================
     * Optional filters:
     * - date: today/tomorrow/thursday/2026-02-12
     * - class_type OR class_name (substring)
     * - instructor_name (substring)
     * - time_range: morning/afternoon/evening
     * - time: "6pm"
     */
    if (action === "get_today_schedule") {
      const resolvedDate = resolveDateInput(params.date, TZ);
      const { startLocal, endLocal } = localRangeForDay(resolvedDate);

      const data = await mbFetch("/class/classes", {
        method: "GET",
        query: {
          StartDateTime: startLocal,
          EndDateTime: endLocal,
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
          startTimeLocal: startDateTime ? humanTime(startDateTime, TZ) : null,
          instructor,
          location,
          capacity: cap.capacity,
          booked: cap.booked,
          spotsAvailable: cap.spotsAvailable,
          isWaitlistAvailable: cap.isWaitlistAvailable,
          _timeBucket: startDateTime ? timeBucketFromISO(startDateTime, TZ) : null,
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
        date: resolvedDate,
        timezone: TZ,
        classes,
        notes: {
          capacityLogic:
            "spotsAvailable is best-effort. Many studios do not return capacity/booked fields from this endpoint, so spotsAvailable may be null even though the class is bookable.",
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
     * Notes:
     * - Mindbody may block bookings outside scheduling window.
     * - If spotsAvailable is null, booking still may succeed.
     */
    if (action === "book_class") {
      const isNewClient =
        params.is_new_client === true ||
        String(params.is_new_client || "").toLowerCase() === "true" ||
        String(params.is_new_client || "").toLowerCase() === "yes";

      let classId = params.class_id || params.classId || null;

      if (!classId) {
        return res.status(400).json({
          success: false,
          actionReceived: action,
          message:
            "Missing class_id. Best practice: call get_today_schedule first, then pass back the classId you want to book.",
          paramsReceived: params,
        });
      }

      let clientId = params.client_id || params.clientId || null;

      const first = (params.client_first_name || "").toString().trim();
      const last = (params.client_last_name || "").toString().trim();
      const email = (params.email || "").toString().trim();
      const phone = (params.mobilephone || params.mobile_phone || params.phone || "").toString().trim();

      // Try search if no clientId
      if (!clientId) {
        const searchText = [email, phone, `${first} ${last}`].find((x) => x && x.length >= 3);
        if (searchText) {
          const clientResp = await mbFetch("/client/clients", {
            method: "GET",
            query: { SearchText: searchText },
          });

          const clients = normalizeArray(clientResp, ["Clients", "clients"]);
          const best = clients[0];
          clientId = best?.Id ?? best?.ClientId ?? null;
        }
      }

      // Create new client if needed
      if (!clientId && isNewClient) {
        if (!first || !last) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message: "New client booking requires client_first_name and client_last_name.",
            paramsReceived: params,
          });
        }

        if (!phone) {
          return res.status(400).json({
            success: false,
            actionReceived: action,
            message: "Mindbody requires MobilePhone for new clients. Ask for a mobile number.",
            paramsReceived: params,
          });
        }

        const createResp = await mbFetch("/client/addclient", {
          method: "POST",
          body: {
            FirstName: first,
            LastName: last,
            Email: email || undefined,
            MobilePhone: phone,
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
            "Could not locate/create client. Ask for the mobile number (exactly as on file) or email, or provide client_id.",
          paramsReceived: params,
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
        const msg = String(e?.message || e);

        // Scheduling window / too late / too early
        if (msg.includes("SchedulingWindowViolated") || msg.toLowerCase().includes("outside scheduling window")) {
          return res.status(409).json({
            success: false,
            actionReceived: action,
            booked: false,
            message:
              "Mindbody won’t allow booking this class right now due to the studio’s scheduling window. I can help you book a different class or a different day/time.",
            clientId,
            classId,
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













