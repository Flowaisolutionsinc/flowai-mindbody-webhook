import express from "express";

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.send("Flow AI Mindbody Webhook is running");
});

// Mindbody webhook
app.post("/mindbody", (req, res) => {
  console.log("Incoming Mindbody payload:", req.body);

  res.json({
    success: true,
    message: "Mindbody webhook received",
  });
});

// ⚠️ THIS MUST EXIST ONCE — NOT TWICE
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

