import express from "express";

const app = express();
app.use(express.json());

// Health check (browser)
app.get("/", (req, res) => {
  res.status(200).send("Flow AI Mindbody webhook is running");
});

/**
 * MAIN endpoint:
 * - Works whether AV sends query params OR JSON body
 * - Works for BOTH POST and GET (in case AV is using GET)
 */
app.all("/mindbody", (req, res) => {
  const siteId = process.env.MINDBODY_SITE_ID || "";
  const apiKey = process.env.MINDBODY_API_KEY || "";
  const sourceName = process.env.MINDBODY_SOURCE_NAME || "";
  const sourcePassword = process.env.MINDBODY_SOURCE_PASSWORD || "";

  // 1) Pull action/params from EITHER query OR JSON body
  const action =
    req.query?.action ||
    req.body?.action ||
    "";

  const paramsFromQuery = { ...(req.query || {}) };
  delete paramsFromQuery.action;

  const paramsFromBody = (req.body && typeof req.body === "object") ? (req.body.params || {}) : {};

  // Merge params (query wins if duplicates)
  const params = { ...paramsFromBody, ...paramsFromQuery };

  // 2) Basic validation (this prevents crashes)
  if (!action) {
    return res.status(400).json({
      success: false,
      message:
        "Missing action. Send ?action=your_action OR JSON { action: 'your_action', params: {...} }",
      receivedQuery: req.query || {},
      receivedBody: req.body || {},
    });
  }

  // 3) For now: echo back so we KNOW AV -> Railway works
  return res.status(200).json({
    success: true,
    siteIdUsed: siteId,
    actionReceived: action,
    paramsReceived: params,
    envDetected: {
      hasSiteId: Boolean(siteId),
      hasApiKey: Boolean(apiKey),
      hasSourceName: Boolean(sourceName),
      hasSourcePassword: Boolean(sourcePassword),
    },
  });
});

// IMPORTANT: only declare PORT once
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));


