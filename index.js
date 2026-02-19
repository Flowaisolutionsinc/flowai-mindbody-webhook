import express from "express";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PUBLIC health routes (must be ABOVE auth middleware)
app.get("/", (req, res) => res.status(200).send("ok"));
app.get("/health", (req, res) => res.status(200).send("ok"));

const SHARED_SECRET = process.env.GHL_SECRET || "CHANGE_THIS_SECRET";

// AUTH middleware (protect everything else)
app.use((req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) return res.status(401).json({ error: "Missing Authorization header" });
  if (authHeader !== `Bearer ${SHARED_SECRET}`) return res.status(401).json({ error: "Unauthorized" });

  next();
});

app.post("/ghl/mindbody", async (req, res) => {
  try {
    const action = (req.body && req.body.action) || (req.query && req.query.action);

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

    return res.json({
      ok: true,
      action,
      received: { body: req.body || null, query: req.query || null },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const PORT = Number(process.env.PORT || 8080);
console.log("Listening on PORT:", PORT);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
