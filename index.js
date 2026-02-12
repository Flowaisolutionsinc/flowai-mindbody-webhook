// index.js
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

/**
 * ====== CONFIG ======
 * DEFAULT_LOCATION_ID should be "1" for Roundhouse (from your get_locations response)
 */
const DEFAULT_LOCATION_ID = String(process.env.DEFAULT_LOCATION_ID || "1");

// Mindbody Public API v6 booking creds (optional until you go live booking)
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY || "";
const MINDBODY_SITE_ID = process.env.MINDBODY_SITE_ID || ""; // sometimes called SiteID
const MB_USERNAME = process.env.MINDBODY_USERNAME || "";
const MB_PASSWORD = process.env.MINDBODY_PASSWORD || "";

/**
 * ====== HELPERS ======
 */
function isTrue(v) {
  return String(v).toLowerCase() === "true";
}

function toISODate(dateLike) {
  // Accepts: "today" / "tomorrow" / "YYYY-MM-DD" / best-effort parse
  const raw = String(dateLike || "").trim().toLowerCase();
  const now = new Date();

  if (!raw || raw === "today") return now.toISOString().slice(0, 10);

  if (raw === "tomorrow") {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const d = new Date(dateLike);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return String(dateLike || "");
}

function pickLocationId(input) {
  // Accept common variants
  if (input?.location_id != null) return String(input.location_id).trim();
  if (input?.locationId != null) return String(input.locationId).trim();
  if (input?.LocationId != null) return String(input.LocationId).trim();

  // Accept LocationIds: ["1"] or "1"
  if (Array.isArray(input?.LocationIds) && input.LocationIds.length > 0) {
    return String(input.LocationIds[0]).trim();
  }
  if (input?.LocationIds != null) return String(input.LocationIds).trim();

  // Fallback env default
  return DEFAULT_LOCATION_ID || null;
}

/**
 * ====== YOUR EXISTING (ALREADY WORKING) UPSTREAM CALLS ======
 *
 * IMPORTANT:
 * In the code you pasted as "currently deployed", these two functions are placeholders.
 * But your screenshots show you ALREADY have working logic somewhere that returns:
 * - get_locations
 * - get_today_schedule (with classes array)
 *
 * So:
 * 1) If your real code is already inside these functions in your repo, keep it.
 * 2) If your real code is somewhere else, move it into these two functions.
 *
 * DO NOT leave them returning empty arrays if you want the AI to read schedules.
 */
async function upstreamGetLocations() {
  // <-- PUT YOUR WORKING LOCATIONS LOGIC HERE
  return {
    success: true,
    actionReceived: "get_locations",
    count: 0,
    locations: [],
    notes:
      "upstreamGetLocations() is still a placeholder. Paste your existing working logic here.",
  };
}

async function upstreamGetSchedule({ dateISO, locationId }) {
  // <-- PUT YOUR WORKING SCHEDULE LOGIC HERE
  // MUST apply the filter LocationIds = locationId (like your screenshot shows)
  return {
    success: true,
    actionReceived: "get_today_schedule",
    date: dateISO,
    timezone: "America/Vancouver",
    appliedLocationFilter: { LocationIds: String(locationId) },
    classes: [],
    notes:
      "upstreamGetSchedule() is still a placeholder. Paste your existing working logic here.",
  };
}

/**
 * ====== OPTIONAL: REAL BOOKING VIA MINDBODY PUBLIC API v6 ======
 */
let cachedToken = null;
let cachedTokenExpiryMs = 0;

async function issueMindbodyToken() {
  if (!MINDBODY_API_KEY || !MB_USERNAME || !MB_PASSWORD) {
    throw new Error(
      "Missing MINDBODY_API_KEY or MINDBODY_USERNAME or MINDBODY_PASSWORD"
    );
  }

  const url = "https://api.mindbodyonline.com/public/v6/usertoken/issue";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": MINDBODY_API_KEY,
    },
    body: JSON.stringify({
      Username: MB_USERNAME,
      Password: MB_PASSWORD,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Token issue failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  const token = data?.AccessToken;
  if (!token) throw new Error("No AccessToken returned from Mindbody");

  cachedToken = token;
  cachedTokenExpiryMs = Date.now() + 25 * 60 * 1000; // cache ~25 min
  return token;
}

async function getMindbodyToken() {
  if (cachedToken && Date.now() < cachedTokenExpiryMs) return cachedToken;
  return issueMindbodyToken();
}

async function mindbodyAddClientToClass({
  classId,
  firstName,
  lastName,
  email,
  phone,
  locationId,
}) {
  if (!MINDBODY_API_KEY) throw new Error("Missing MINDBODY_API_KEY");
  const token = await getMindbodyToken();

  const url =
    "https://api.mindbodyonline.com/public/v6/class/addclienttoclass";

  // NOTE: Many Mindbody setups REQUIRE ClientId.
  // If your studio requires it, you must implement:
  // 1) find/create client -> get ClientId
  // 2) add client to class using ClientId
  const payload = {
    ClassId: Number(classId),
    FirstName: firstName,
    LastName: lastName,
    Email: email,
    Phone: phone,
    LocationId: Number(locationId),
  };

  const headers = {
    "Content-Type": "application/json",
    "Api-Key": MINDBODY_API_KEY,
    Authorization: `Bearer ${token}`,
  };

  // Only include SiteId header if set (Mindbody differs by account setup)
  if (MINDBODY_SITE_ID) headers.SiteId = MINDBODY_SITE_ID;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `AddClientToClass failed (${res.status}): ${JSON.stringify(data)}`
    );
  }
  return data;
}

/**
 * ====== ACTION HANDLER ======
 */
async function handleAction(input) {
  const action = String(input?.action || "").trim();
  if (!action) return { success: false, error: "Missing 'action'." };

  if (action === "get_locations") {
    return await upstreamGetLocations();
  }

  if (action === "get_today_schedule" || action === "get_schedule") {
    const locationId = pickLocationId(input);
    const dateISO = toISODate(input?.date);

    if (!dateISO) {
      return { success: false, actionReceived: action, error: "Missing 'date'." };
    }
    if (!locationId) {
      return {
        success: false,
        actionReceived: action,
        error: "Missing locationId and DEFAULT_LOCATION_ID not set.",
      };
    }

    return await upstreamGetSchedule({ dateISO, locationId });
  }

  if (action === "book_class") {
    const locationId = pickLocationId(input);

    // dry_run is OPTIONAL. If not sent, it’s false.
    const dryRun = isTrue(input?.dry_run);

    const classId = input?.class_id || input?.classId;
    const firstName = input?.client_first_name || input?.first_name || "";
    const lastName = input?.client_last_name || input?.last_name || "";
    const email = input?.email || "";
    const phone = input?.phone || "";

    if (!locationId) {
      return {
        success: false,
        actionReceived: "book_class",
        error: "Missing locationId and DEFAULT_LOCATION_ID not set.",
      };
    }
    if (!classId) {
      return {
        success: false,
        actionReceived: "book_class",
        error: "Missing class_id (or classId) for booking.",
      };
    }
    if (!firstName || !lastName || !email) {
      return {
        success: false,
        actionReceived: "book_class",
        error:
          "Missing booking info. Need first name, last name, and email at minimum.",
        required: ["client_first_name", "client_last_name", "email"],
      };
    }

    const hasCreds = Boolean(MINDBODY_API_KEY && MB_USERNAME && MB_PASSWORD);

    // If creds aren’t configured, only allow dry_run so nothing breaks.
    if (!hasCreds) {
      if (!dryRun) {
        return {
          success: false,
          actionReceived: "book_class",
          error:
            "Booking credentials not configured on server. Set MINDBODY_API_KEY / MINDBODY_USERNAME / MINDBODY_PASSWORD or use dry_run=true.",
        };
      }
      return {
        success: true,
        actionReceived: "book_class",
        dry_run: true,
        booked: false,
        wouldBook: {
          classId: String(classId),
          locationId: String(locationId),
          firstName,
          lastName,
          email,
          phone,
        },
      };
    }

    if (dryRun) {
      return {
        success: true,
        actionReceived: "book_class",
        dry_run: true,
        booked: false,
        wouldBook: {
          classId: String(classId),
          locationId: String(locationId),
          firstName,
          lastName,
          email,
          phone,
        },
      };
    }

    const booked = await mindbodyAddClientToClass({
      classId,
      firstName,
      lastName,
      email,
      phone,
      locationId,
    });

    return {
      success: true,
      actionReceived: "book_class",
      dry_run: false,
      booked: true,
      locationId: String(locationId),
      result: booked,
    };
  }

  return { success: false, error: `Unknown action: ${action}` };
}

/**
 * ====== ROUTES ======
 */
app.get("/health", (_req, res) => res.json({ ok: true }));

// Optional debug route (safe: shows non-secret env only)
app.get("/debug", (_req, res) => {
  res.json({
    ok: true,
    env: {
      DEFAULT_LOCATION_ID: process.env.DEFAULT_LOCATION_ID || null,
      TIMEZONE: process.env.TIMEZONE || null,
      HAS_MINDBODY_BOOKING_CREDS: Boolean(
        process.env.MINDBODY_API_KEY &&
          process.env.MINDBODY_USERNAME &&
          process.env.MINDBODY_PASSWORD
      ),
    },
    note: "Shows NON-secret env only. Delete when finished.",
  });
});

/**
 * ONE endpoint for both:
 * - Browser tests (GET ?action=...)
 * - VAPI custom actions (POST JSON)
 */
app.all("/mindbody", async (req, res) => {
  try {
    const action = String(req.query.action || req.body?.action || "").trim();
    if (!action) {
      return res.status(400).json({
        success: false,
        error:
          "Missing 'action'. Provide ?action=... (GET) or {action:'...'} (POST).",
      });
    }

    // Merge inputs from GET and POST (POST wins)
    const merged = { ...req.query, ...(req.body || {}), action };

    const out = await handleAction(merged);

    // If handleAction says success:false => 400, else 200
    return res.status(out?.success === false ? 400 : 200).json(out);
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({
      success: false,
      error: err?.message || "Server error",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

















