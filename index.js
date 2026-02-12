// index.js
import express from "express";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

/**
 * ====== CONFIG ======
 * For your Roundhouse pilot:
 * - DEFAULT_LOCATION_ID should be "1" (from your get_locations response)
 *
 * NOTE:
 * "LocationId" is NOT the "Site ID".
 * - Site ID = the overall Mindbody site/account
 * - LocationId = a specific studio/location within that site (Roundhouse, etc.)
 */
const DEFAULT_LOCATION_ID = String(process.env.DEFAULT_LOCATION_ID || "1");

// If you are calling Mindbody Public API v6 for booking, you need these.
// If you don't have them yet, book_class can still work in dry_run mode.
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY || "";
const MINDBODY_SITE_ID = process.env.MINDBODY_SITE_ID || ""; // sometimes called SiteID
const MB_USERNAME = process.env.MINDBODY_USERNAME || "";
const MB_PASSWORD = process.env.MINDBODY_PASSWORD || "";

/**
 * ====== HELPERS ======
 */
function toISODate(dateLike) {
  // Accepts:
  // - "today" / "tomorrow"
  // - "YYYY-MM-DD"
  // - anything JS Date can parse (best effort)
  const raw = String(dateLike || "").trim().toLowerCase();
  const now = new Date();

  if (!raw || raw === "today") {
    return now.toISOString().slice(0, 10);
  }
  if (raw === "tomorrow") {
    const t = new Date(now);
    t.setDate(t.getDate() + 1);
    return t.toISOString().slice(0, 10);
  }

  // If already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  // Try parse
  const d = new Date(dateLike);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  // Fallback: just return the original (but this may fail upstream)
  return String(dateLike || "");
}

function pickLocationId(input) {
  // Accept either:
  // - locationId (camel)
  // - location_id (snake)
  // - LocationIds (array-ish)
  if (input?.location_id != null) return String(input.location_id);
  if (input?.locationId != null) return String(input.locationId);
  if (input?.LocationId != null) return String(input.LocationId);

  // sometimes people pass LocationIds: ["1"]
  if (Array.isArray(input?.LocationIds) && input.LocationIds.length > 0) {
    return String(input.LocationIds[0]);
  }
  return DEFAULT_LOCATION_ID;
}

/**
 * ====== MINDBODY CALLS ======
 * You currently have endpoints that already return the schedule + locations.
 * Your screenshot shows these working:
 * - /mindbody?action=get_locations
 * - /mindbody?action=get_today_schedule&date=2026-02-12
 *
 * So below, "get_locations" and "get_today_schedule" call YOUR EXISTING LOGIC:
 * - If you already call the Mindbody widget/partner endpoints internally, keep that.
 * - If you want this file to be self-contained, you must implement the upstream call(s).
 *
 * IMPORTANT:
 * Because your current deployed endpoint already works, the main change here is:
 * - always apply LocationId filter using the provided locationId/location_id
 */

// --- Replace these with your real upstream calls if needed ---
async function upstreamGetLocations() {
  // If you already have working code that returns locations, use it here.
  // For now, this placeholder returns the same shape you showed.
  // In production, this function should call your upstream Mindbody integration.
  return {
    success: true,
    actionReceived: "get_locations",
    count: 0,
    locations: [],
    notes: "upstreamGetLocations() is a placeholder. Replace with your working upstream call.",
  };
}

async function upstreamGetSchedule({ dateISO, locationId }) {
  // This should call your upstream schedule source and apply LocationIds=[locationId]
  return {
    success: true,
    actionReceived: "get_today_schedule",
    date: dateISO,
    timezone: "America/Vancouver",
    appliedLocationFilter: { LocationIds: String(locationId) },
    classes: [],
    notes:
      "upstreamGetSchedule() is a placeholder. Replace with your working upstream call that returns classes.",
  };
}

/**
 * ====== OPTIONAL: REAL BOOKING VIA MINDBODY PUBLIC API v6 ======
 * If you have the API key + login + site id set, this will:
 * - issue a staff token
 * - add a client to class
 *
 * If you do NOT have creds set, book_class will require dry_run=true to succeed.
 */
let cachedToken = null;
let cachedTokenExpiryMs = 0;

async function issueMindbodyToken() {
  if (!MINDBODY_API_KEY || !MB_USERNAME || !MB_PASSWORD) {
    throw new Error("Missing MINDBODY_API_KEY or MINDBODY_USERNAME or MINDBODY_PASSWORD");
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
    throw new Error(`Token issue failed (${res.status}): ${JSON.stringify(data)}`);
  }

  // token lasts a while; we’ll cache for ~25 minutes to be safe
  const token = data?.AccessToken;
  if (!token) throw new Error("No AccessToken returned from Mindbody");

  cachedToken = token;
  cachedTokenExpiryMs = Date.now() + 25 * 60 * 1000;
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

  // NOTE: Mindbody expects an existing ClientId in many flows.
  // Some studios allow creating a client first, then booking.
  // This is a simplified example; your production flow may need:
  // 1) find/create client
  // 2) add to class
  const url = "https://api.mindbodyonline.com/public/v6/class/addclienttoclass";

  const payload = {
    ClassId: Number(classId),
    // Many Mindbody setups require ClientId; if you have it, use it.
    // ClientId: "123",
    // If not, you generally must create/find the client first.
    // So this function may need to be expanded for real production booking.
    // Leaving fields here so you see the structure:
    FirstName: firstName,
    LastName: lastName,
    Email: email,
    Phone: phone,
    LocationId: Number(locationId),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": MINDBODY_API_KEY,
      Authorization: `Bearer ${token}`,
      ...(MINDBODY_SITE_ID ? { SiteId: MINDBODY_SITE_ID } : {}),
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`AddClientToClass failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * ====== ACTION ROUTER ======
 */
async function handleAction(input) {
  const action = String(input?.action || "").trim();

  if (!action) {
    return { success: false, error: "Missing 'action'." };
  }

  if (action === "get_locations") {
    return await upstreamGetLocations();
  }

  if (action === "get_today_schedule") {
    const locationId = pickLocationId(input);
    const dateISO = toISODate(input?.date);
    return await upstreamGetSchedule({ dateISO, locationId });
  }

  if (action === "book_class") {
    const locationId = pickLocationId(input);

    const dryRun =
      String(input?.dry_run || "").toLowerCase() === "true" ||
      input?.dry_run === true;

    // Required booking fields (minimum)
    const classId = input?.class_id || input?.classId;
    const firstName = input?.client_first_name || input?.first_name || "";
    const lastName = input?.client_last_name || input?.last_name || "";
    const email = input?.email || "";
    const phone = input?.phone || "";

    if (!classId) {
      return { success: false, error: "Missing class_id (or classId) for booking." };
    }

    // If you want to allow bookings without these, adjust rules,
    // but most studios will require them.
    if (!firstName || !lastName || !email) {
      return {
        success: false,
        error: "Missing booking info. Need first name, last name, and email at minimum.",
        required: ["client_first_name", "client_last_name", "email"],
      };
    }

    // If creds not set, only allow dry_run so nothing breaks.
    const hasCreds = Boolean(MINDBODY_API_KEY && MB_USERNAME && MB_PASSWORD);

    if (!hasCreds) {
      if (!dryRun) {
        return {
          success: false,
          error:
            "Booking credentials not configured on server. Set MINDBODY_API_KEY / MINDBODY_USERNAME / MINDBODY_PASSWORD or use dry_run=true.",
        };
      }
      return {
        success: true,
        actionReceived: "book_class",
        dry_run: true,
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

    // Real booking attempt:
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
      locationId: String(locationId),
      result: booked,
    };
  }

  return { success: false, error: `Unknown action: ${action}` };
}

/**
 * ====== ROUTES ======
 * - GET /mindbody?action=...&date=...&locationId=...
 * - POST /mindbody with JSON body
 */
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.get("/mindbody", async (req, res) => {
  try {
    const payload = {
      action: req.query.action,
      date: req.query.date,
      locationId: req.query.locationId,
      location_id: req.query.location_id,
      class_id: req.query.class_id,
      dry_run: req.query.dry_run,
    };

    const out = await handleAction(payload);
    res.status(out?.success === false ? 400 : 200).json(out);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
});

app.post("/mindbody", async (req, res) => {
  try {
    const out = await handleAction(req.body || {});
    res.status(out?.success === false ? 400 : 200).json(out);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err?.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

















