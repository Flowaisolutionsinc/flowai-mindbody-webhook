const express = require("express");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const MINDBODY_SOURCE_NAME = process.env.MINDBODY_SOURCE_NAME;
const MINDBODY_SOURCE_PASSWORD = process.env.MINDBODY_SOURCE_PASSWORD;

app.get("/", (req, res) => {
  res.status(200).send("Flow AI Mindbody Webhook is running");
});

app.post("/mindbody", (req, res) => {
  console.log("Incoming Mindbody payload:", req.body);

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
