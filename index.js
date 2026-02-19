import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Shared secret between GHL and Railway
const SHARED_SECRET = process.env.GHL_SECRET || "CHANGE_THIS_SECRET";

// Middleware to protect endpoint
app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${SHARED_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// MAIN ROUTE (THIS IS YOUR WEBHOOK ROUTE)
app.post("/ghl/mindbody", async (req, res) => {
  const { action } = req.body;

  if (!action) {
    return res.status(400).json({ error: "Missing action parameter" });
  }

  // Temporary test response
  if (action === "ping") {
    return res.json({
      ok: true,
      message: "Webhook is working."
    });
  }

  // Placeholder for future logic
  return res.json({
    ok: true,
    received: req.body
  });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

