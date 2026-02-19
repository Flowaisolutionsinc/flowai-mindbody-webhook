import express from "express";

const app = express();

// Parse JSON and form bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

// Use your Railway variable GHL_SECRET
const SHARED_SECRET = process.env.GHL_SECRET || "CHANGE_THIS_SECRET";

// ============================
// AUTH MIDDLEWARE
// ============================
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  if (authHeader !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
});

// ============================
// MAIN WEBHOOK ROUTE
// ============================
app.post("/ghl/mindbody", async (req, res) => {
  try {
    // Accept action from body OR query
    const action =
      (req.body && req.body.action) ||
      (req.query && req.query.action);

    if (!action) {
      return res.status(400).json({
        error: "Missing action parameter",
        debug: {
          contentType: req.headers["content-type"] || null,
          body: req.body || null,
          query: req.query || null,
        },
      });
    }

    // ============================
    // TEST MODE
    // ============================
    if (action === "ping") {
      return res.json({
        ok: true,
        message: "Webhook is working.",
        received: {
          action,
          studioKey: req.body.studioKey || req.query.studioKey || null,
          timezone: req.body.timezone || req.query.timezone || null,
          source: req.body.source || req.query.source || null,
        },
      });
    }

    // ============================
    // PLACEHOLDER FOR FUTURE LOGIC
    // ============================
    return res.json({
      ok: true,
      action,
      received: {
        body: req.body || null,
        query: req.query || null,
      },
    });

  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ============================
// SERVER START
// ============================
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
