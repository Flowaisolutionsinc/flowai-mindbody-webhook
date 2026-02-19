const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// --- helpers ---
function normalizeAuth(authHeaderRaw = "") {
  const raw = String(authHeaderRaw || "").trim();
  if (!raw) return "";
  // Accept either:
  // "braydentj"
  // "Bearer braydentj"
  // "bearer braydentj"
  return raw.toLowerCase().startsWith("bearer ")
    ? raw.slice(7).trim()
    : raw;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function makeDebugId() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Math.random().toString(16).slice(2, 10)
  );
}

// Build ISO window for “today” (or N days) in a timezone without extra libs.
// We’ll keep it simple: if caller passes fromDate/toDate, we use them.
// Otherwise default: now -> +24h in UTC (good enough for testing).
function defaultDateWindowISO() {
  const now = new Date();
  const from = new Date(now);
  const to = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return { fromDate: from.toISOString(), toDate: to.toISOString() };
}

// Try to extract a JSON-ish chunk from the widget response (often returns "text/x-component").
// We’ll return both raw and best-effort extracted data.
function tryExtractJsonLike(rawText) {
  if (!rawText || typeof rawText !== "string") return { extracted: null };

  // Common case: response contains a big JSON-ish array starting with '['
  const firstBracket = rawText.indexOf("[");
  const lastBracket = rawText.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    const candidate = rawText.slice(firstBracket, lastBracket + 1);
    try {
      const parsed = JSON.parse(candidate);
      return { extracted: parsed };
    } catch (_e) {
      // Not valid JSON, but still useful to return candidate snippet
      return { extracted: null, candidateSnippet: candidate.slice(0, 4000) };
    }
  }

  return { extracted: null };
}

async function fetchScheduleFromWidget({ debugId, fromDate, toDate }) {
  const widgetUrl = String(process.env.MINDBODY_WIDGET_URL || "").trim();
  const widgetToken = String(process.env.MINDBODY_WIDGET_TOKEN || "").trim();

  if (!widgetUrl) {
    throw new Error("Missing MINDBODY_WIDGET_URL env var");
  }
  if (!widgetToken) {
    throw new Error("Missing MINDBODY_WIDGET_TOKEN env var");
  }

  // Node 18+ has fetch + FormData globally
  const form = new FormData();

  // This matches what you captured:
  // name="1" -> a long quoted token string
  // name="0" -> ["$@1",{"fromDate":"...","toDate":"..."}]
  form.append("1", widgetToken);
  form.append("0", JSON.stringify(["$@1", { fromDate, toDate }]));

  const resp = await fetch(widgetUrl, {
    method: "POST",
    body: form,
    // IMPORTANT: do NOT manually set Content-Type for FormData.
    // fetch will set boundary correctly.
    headers: {
      // These are “safe” defaults; the widget endpoint usually accepts them.
      // If we later find it requires additional headers, we’ll add them.
      "accept": "*/*",
    },
  });

  const text = await resp.text();

  return {
    status: resp.status,
    okHttp: resp.ok,
    contentType: resp.headers.get("content-type"),
    raw: text,
    jsonGuess: tryExtractJsonLike(text),
    debugId,
  };
}

// --- route ---
app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault is sending query params)
  const action = pickFirst(req.body?.action, req.query?.action);
  const studioKey = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezone = pickFirst(req.body?.timezone, req.query?.timezone);
  const source = pickFirst(req.body?.source, req.query?.source);

  // Optional date window (for schedule)
  const fromDate = pickFirst(req.body?.fromDate, req.query?.fromDate);
  const toDate = pickFirst(req.body?.toDate, req.query?.toDate);

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase();

  console.log("--------------------------------------------------");
  console.log(`[${debugId}] ${req.method} ${req.originalUrl}`);
  console.log(`[${debugId}] mode: ${mode}`);
  console.log(`[${debugId}] headers:`, {
    "content-type": req.headers["content-type"],
    authorization: req.headers.authorization ? "[present]" : "[missing]",
    "user-agent": req.headers["user-agent"],
  });
  console.log(`[${debugId}] body:`, req.body);
  console.log(`[${debugId}] query:`, req.query);
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source, fromDate, toDate });

  if (!expectedSecret) {
    return res.status(500).json({
      ok: false,
      debugId,
      error: "Server missing GHL_SECRET env var",
    });
  }

  if (!incomingAuth || incomingAuth !== expectedSecret) {
    return res.status(401).json({
      ok: false,
      debugId,
      error: "Unauthorized",
    });
  }

  if (!action) {
    return res.status(400).json({
      ok: false,
      debugId,
      error: "Missing action (send in JSON body or query string)",
    });
  }

  // Ping
  if (action === "ping") {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      message: "pong",
      debugId,
    });
  }

  // ---- SCHEDULE ----
  // get_schedule (main action)
  // - if MINDBODY_MODE=mock -> mocked response
  // - if MINDBODY_MODE=web  -> calls widget endpoint
  // - if MINDBODY_MODE=live -> (later) Mindbody v6
  if (action === "get_schedule") {
    if (mode === "web") {
      const win = fromDate && toDate ? { fromDate, toDate } : defaultDateWindowISO();
      try {
        const result = await fetchScheduleFromWidget({ debugId, ...win });
        return res.status(result.okHttp ? 200 : 502).json({
          ok: result.okHttp,
          action,
          mode,
          studioKey,
          timezone,
          source,
          fromDate: win.fromDate,
          toDate: win.toDate,
          httpStatus: result.status,
          contentType: result.contentType,
          // Keep raw small so responses don’t explode:
          rawPreview: result.raw.slice(0, 4000),
          // Best-effort extraction:
          extractedJson: result.jsonGuess.extracted || null,
          extractedSnippet: result.jsonGuess.candidateSnippet || null,
          debugId,
        });
      } catch (e) {
        return res.status(500).json({
          ok: false,
          action,
          mode,
          error: String(e?.message || e),
          debugId,
        });
      }
    }

    // MOCK mode default
    return res.status(200).json({
      ok: true,
      action,
      mode: "mock",
      studioKey,
      timezone,
      source,
      message: "mock schedule (not implemented yet)",
      debugId,
    });
  }

  // Explicit web action (so you can test it directly even if mode is mock)
  if (action === "get_schedule_web") {
    const win = fromDate && toDate ? { fromDate, toDate } : defaultDateWindowISO();
    try {
      const result = await fetchScheduleFromWidget({ debugId, ...win });
      return res.status(result.okHttp ? 200 : 502).json({
        ok: result.okHttp,
        action,
        mode: "web",
        studioKey,
        timezone,
        source,
        fromDate: win.fromDate,
        toDate: win.toDate,
        httpStatus: result.status,
        contentType: result.contentType,
        rawPreview: result.raw.slice(0, 4000),
        extractedJson: result.jsonGuess.extracted || null,
        extractedSnippet: result.jsonGuess.candidateSnippet || null,
        debugId,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        action,
        mode: "web",
        error: String(e?.message || e),
        debugId,
      });
    }
  }

  // Placeholder for booking actions
  if (action === "book_class" || action === "cancel_class") {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      message: `${action} received (not implemented yet)`,
      debugId,
    });
  }

  return res.status(400).json({
    ok: false,
    debugId,
    error: `Unknown action: ${action}`,
    allowed: ["ping", "get_schedule", "get_schedule_web", "book_class", "cancel_class"],
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));



