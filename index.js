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
  console.log("Incoming Mindbody payload:", req.body);

  res.json({
    success: true,
    sourceConfigured: Boolean(MINDBODY_SOURCE_NAME),
    message: "Mindbody webhook received successfully",
  });
});


// ⚠️ THIS MUST EXIST ONCE — NOT TWICE
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

