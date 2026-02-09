import express from "express";

const app = express();
app.use(express.json());

// Health check (for browser)
app.get("/", (req, res) => {
  res.status(200).send("Flow AI webhook is running");
});

// MAIN endpoint (Agency Vault will call this)
app.post("/mindbody", async (req, res) => {
  try {
    // Required env vars
    const siteId = process.env.MINDBODY_SITE_ID; // 5744527
    const apiKey = process.env.MINDBODY_API_KEY; // you will add later (if needed)
    const sourceName = process.env.MINDBODY_SOURCE_NAME; // optional depending on API type
    const sourcePassword = process.env.MINDBODY_SOURCE_PASSWORD; // optional depending on API type

    if (!siteId) {
      return res.status(500).json({
        success: false,
        message: "Missing MINDBODY_SITE_ID in Railway Variables",
      });
    }

    // What Agency Vault should send
    const { action, params = {} } = req.body || {};
    if (!action) {
      return res.status(400).json({
        success: false,
        message:
          "Missing 'action' in request body. Example: { action: 'get_today_schedule', params: {...} }",
      });
    }

    // ✅ For now: echo back so we KNOW AV -> Railway is working.
    // Next step will be: switch(action) and call Mindbody APIs per action.
    return res.status(200).json({
      success: true,
      siteIdUsed: siteId,
      actionReceived: action,
      paramsReceived: params,
      envDetected: {
        hasApiKey: Boolean(apiKey),
        hasSourceName: Boolean(sourceName),
        hasSourcePassword: Boolean(sourcePassword),
      },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: String(err?.message || err),
    });
  }
});

// IMPORTANT: declare PORT once, only once
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

