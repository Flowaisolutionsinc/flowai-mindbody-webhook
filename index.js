import express from "express";

const app = express();
app.use(express.json());

/**
 * LOG EVERYTHING (so Railway Logs actually show requests)
 * This is what you were missing — requests were coming in,
 * but nothing was being printed to stdout.
 */
app.use((req, res, next) => {
  try {
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`,
      "query=",
      req.query || {},
      "body=",
      req.body || {}
    );
  } catch (e) {
    console.log("Log middleware error:", e?.message || e);
  }
  next();
});

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

  // 1) Pull action from EITHER query OR JSON body
  const action =
    (req.query && req.query.action) ||
    (req.body && req.body.action) ||
    "";

  // 2) Pull params from EITHER query (minus action) OR JSON body params
  const paramsFromQuery = { ...(req.query || {}) };
  delete paramsFromQuery.action;

  const paramsFromBody =
    req.body && typeof req.body === "object" ? req.body.params || {} : {};

  // Merge params (query wins if duplicates)
  const params = { ...paramsFromBody, ...paramsFromQuery };

  // EXTRA: print parsed action/params so it's obvious in logs
  console.log("PARSED_ACTION:", action || "(missing)");
  console.log("PARSED_PARAMS:", params);

  // 3) Basic validation (this prevents crashes)
  if (!action) {
    return res.status(400).json({
      success: false,
      message:
        "Missing action. Send ?action=your_action OR JSON { action: 'your_action', params: {...} }",
      receivedQuery: req.query || {},
      receivedBody: req.body || {},
    });
  }

  // 4) For now: echo back so we KNOW AV -> Railway works
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



