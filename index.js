import express from "express";

const app = express();
app.use(express.json());
// Mindbody credentials (read from Railway env vars)
const MINDBODY_SOURCE_NAME = process.env.MINDBODY_SOURCE_NAME;
const MINDBODY_SOURCE_PASSWORD = process.env.MINDBODY_SOURCE_PASSWORD;

// Safety check (this will NOT crash the server)
if (!MINDBODY_SOURCE_NAME || !MINDBODY_SOURCE_PASSWORD) {
  console.warn("⚠️ Mindbody credentials not set yet");
}

// Health check
// ONE endpoint that Agency Vault calls
app.post("/mindbody", async (req, res) => {
  try {
    const siteId = process.env.MINDBODY_SITE_ID;
    const apiKey = process.env.MINDBODY_API_KEY;

    if (!siteId) {
      return res.status(500).json({ success: false, message: "Missing MINDBODY_SITE_ID in Railway Variables" });
    }
    if (!apiKey) {
      return res.status(500).json({ success: false, message: "Missing MINDBODY_API_KEY in Railway Variables" });
    }

    const { action, params = {} } = req.body || {};

    if (!action) {
      return res.status(400).json({
        success: false,
        message: "Missing 'action' in request body. Example: { action: 'get_today_schedule', params: {...} }",
      });
    }

    // For now we just confirm


  console.log("Incoming Mindbody payload:", {
    siteId,
    body: req.body
  });

  return res.json({
    success: true,
    siteIdUsed: siteId,
    received: req.body
  });
});



// ⚠️ THIS MUST EXIST ONCE — NOT TWICE
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

