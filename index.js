import express from "express";

const app = express();
app.use(express.json());

app.post("/mindbody", (req, res) => {
  console.log("Incoming Mindbody payload:", req.body);

  // Later we will:
  // - Validate source name
  // - Use siteId
  // - Call Mindbody APIs
  // - Return booking data to Agency Vault

  res.json({
    success: true,
    message: "Mindbody webhook received",
  });
});

app.get("/", (req, res) => {
  res.send("Flow AI Mindbody Webhook is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
