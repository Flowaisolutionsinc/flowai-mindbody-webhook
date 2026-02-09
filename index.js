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
app.post("/mindbody", (req, res) => {
  const siteId = process.env.MINDBODY_SITE_ID; // Oxygen Roundhouse

  if (!siteId) {
    return res.status(500).json({
      success: false,
      message: "Missing MINDBODY_SITE_ID in Railway Variables"
    });
  }

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

