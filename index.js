import express from "express";

const app = express();
app.use(express.json());

// Railway injects PORT automatically
const PORT = process.env.PORT || 3000;

// Read env vars
const MINDBODY_SOURCE_NAME = process.env.MINDBODY_SOURCE_NAME;
const MINDBODY_SOURCE_PASSWORD = process.env.MINDBODY_SOURCE_PASSWORD;

// Fail fast if missing (prevents confusing bugs)
if (!MINDBODY_SOURCE_NAME || !MINDBODY_SOURCE_PASSWORD) {
  console.error("Missing required env vars: MINDBODY_SOURCE_NAME or MINDBODY_SOURCE_PASSWORD");
}

app.get("/", (req, res) => {
  res.status(200).send("Flow AI Mindbody Webhook is running");
});

// Webhook endpoint
app.post("/mindbody", (req, res) => {
  console.log("Incoming Mindbody payload:", req.body);

  // (Optional) Basic auth check example:
  // If Agency Vault sends a header like x-source-password, you can validate here.
  // const incomingPassword = req.headers["x-source-password"];
  // if (incomingPassword !== MINDBODY_SOURCE_PASSWORD) {
  //   return res.status(401).json({ success: false, message: "Unauthorized" });
  // }

  res.json({
    success: true,
    message: "Mindbody webhook received",
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
