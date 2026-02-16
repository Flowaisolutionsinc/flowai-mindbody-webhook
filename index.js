import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// --------------------
// Helpers
// --------------------
function logHit(req, extra = {}) {
  const q = req.query || {};
  console.log("HIT", req.path, {
    url: req.originalUrl,
    params: { ...q, ...extra },
  });
}

function okResults(payload) {
  // IMPORTANT: This must match what Vapi is showing you: results.say + results.classes[]...
  return { results: payload };
}

function failResults(message, meta = {}) {
  // Keep shape consistent so Vapi can still parse and you can debug.
  return {
    results: {
      say: "",
      error: message,
      ...meta,
    },
  };
}

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    envDetected: {
      tz: process.env.TZ || "America/Vancouver",
      hasApiKey: !!process.env.MINDBODY_API_KEY,
      hasSiteId: !!process.env.MINDBODY_SITE_ID,
      hasSourceName: !!process.env.MINDBODY_SOURCE_NAME,
      hasSourcePassword: !!process.env.MINDBODY_SOURCE_PASSWORD,
      baseUrl: process.env.MINDBODY_BASE_URL || "https://api.mindbodyonline.com/public/v6",
    },
  });
});

// --------------------
// SCHEDULE
// Endpoint used by your Vapi action get_schedule_by_date
// GET /mb/schedule?date=Friday&location_id=1&onlySay=1
// --------------------
app.get("/mb/schedule", async (req, res) => {
  try {
    const datePhrase = String(req.query.date || "").trim();          // can be "Friday", "next Tuesday", "Feb 21st, 2026"
    const locationId = String(req.query.location_id || "1").trim();
    const onlySay = String(req.query.onlySay || "1").trim();         // if you want just the string for voice

    logHit(req);

    if (!datePhrase) {
      return res.status(400).json(failResults("Missing required query param: date"));
    }

    // TODO: Replace this stub with your real schedule lookup logic.
    // IMPORTANT: Whatever you do, you MUST return results.say (string).
    //
    // If you already have working parsing/resolution on server-side (like your browser tests),
    // keep it there. Do NOT rely on the agent to convert dates.

    // --- STUB EXAMPLE (REPLACE) ---
    // Imagine your existing code resolves datePhrase -> resolvedDateISO
    // and produces a "say" string plus optional classes list.
    const resolvedDateISO = "2026-02-20"; // <-- replace with real
    const say = `Classes for ${resolvedDateISO}: (your real formatted list here)`;

    const classes = [
      // optional; include only if you want Vapi to access these later
      // { classId: "123", startTime: "07:15 AM", name: "Hot Yoga", instructor: "Taylor", spotsAvailable: 5, isWaitlistAvailable: true }
    ];

    // Return in the shape Vapi expects:
    // - results.say
    // - results.classes[] (optional)
    return res.json(
      okResults({
        say,
        date: resolvedDateISO,
        timezone: "America/Vancouver",
        location_id: locationId,
        ...(onlySay === "1" ? {} : { classes }),
      })
    );
  } catch (err) {
    console.error("ERROR /mb/schedule", err);
    return res.status(500).json(failResults("Schedule lookup failed", { debug: String(err?.message || err) }));
  }
});

// --------------------
// BOOK CLASS
// Endpoint used by your Vapi action book_class
// POST /mb/book
// Body: { classId, is_new_client, client_first_name, client_last_name, mobilephone, email }
// --------------------
app.post("/mb/book", async (req, res) => {
  try {
    const {
      classId,
      is_new_client,
      client_first_name,
      client_last_name,
      mobilephone,
      email,
    } = req.body || {};

    console.log("HIT /mb/book", { body: { classId, is_new_client, client_first_name, client_last_name, mobilephone, email } });

    // Basic validation (fail fast with consistent shape)
    if (!classId) return res.status(400).json(failResults("Missing required field: classId"));
    if (!client_first_name) return res.status(400).json(failResults("Missing required field: client_first_name"));
    if (!client_last_name) return res.status(400).json(failResults("Missing required field: client_last_name"));
    if (!mobilephone) return res.status(400).json(failResults("Missing required field: mobilephone"));

    // TODO: Replace with real Mindbody booking logic.
    // Must return results.say and success flag.
    return res.json(
      okResults({
        success: true,
        say: "You’re all set — you’re booked.",
        booking: {
          classId,
          firstName: client_first_name,
          lastName: client_last_name,
        },
      })
    );
  } catch (err) {
    console.error("ERROR /mb/book", err);
    return res.status(500).json(failResults("Booking failed", { debug: String(err?.message || err) }));
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});


























