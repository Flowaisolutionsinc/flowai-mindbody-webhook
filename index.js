const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// ---------------- helpers ----------------
function normalizeAuth(authHeaderRaw = "") {
  const raw = String(authHeaderRaw || "").trim();
  if (!raw) return "";
  return raw.toLowerCase().startsWith("bearer ")
    ? raw.slice(7).trim()
    : raw;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "")
      return v;
  }
  return undefined;
}

function makeDebugId() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Math.random().toString(16).slice(2, 10)
  );
}

// ---------------- date utilities ----------------

// Convert YYYY-MM-DD into proper UTC start/end
function buildUtcRangeFromLocalDate(dateStr, timezone) {
  const startLocal = new Date(`${dateStr}T00:00:00`);
  const endLocal = new Date(`${dateStr}T23:59:59`);

  return {
    fromDate: startLocal.toISOString(),
    toDate: endLocal.toISOString(),
  };
}

// Default: today → today + 14 days
function defaultDateRangeISO(daysAhead = 14) {
  const from = new Date();
  const to = new Date(
    from.getTime() + daysAhead * 24 * 60 * 60 * 1000
  );
  return {
    fromDate: from.toISOString(),
    toDate: to.toISOString(),
  };
}

// ---------------- widget fetch ----------------
async function fetchMindbodyWidgetSchedule({
  fromDate,
  toDate,
  debugId,
}) {
  const url = String(
    process.env.MINDBODY_WIDGET_URL || ""
  ).trim();
  const token = String(
    process.env.MINDBODY_WIDGET_TOKEN || ""
  ).trim();

  if (!url)
    throw new Error("Missing MINDBODY_WIDGET_URL env var");
  if (!token)
    throw new Error("Missing MINDBODY_WIDGET_TOKEN env var");

  const form = new FormData();
  form.append("1", token);
  form.append(
    "0",
    JSON.stringify(["$@1", { fromDate, toDate }])
  );

  const res = await fetch(url, {
    method: "POST",
    body: form,
    headers: {
      "User-Agent": `flowai-webhook/${debugId}`,
    },
  });

  const text = await res.text();

  return {
    status: res.status,
    ok: res.ok,
    text,
  };
}

// ---------------- route ----------------
app.post("/ghl/mindbody", async (req, res) => {
  const debugId = makeDebugId();

  const action = pickFirst(
    req.body?.action,
    req.query?.action
  );
  const studioKey = pickFirst(
    req.body?.studioKey,
    req.query?.studioKey
  );

  let timezone = pickFirst(
    req.body?.timezone,
    req.query?.timezone
  );

  const source = pickFirst(
    req.body?.source,
    req.query?.source
  );

  const dateParam = pickFirst(
    req.body?.date,
    req.query?.date
  );

  // 🔥 FIX: decode timezone if URL encoded
  if (timezone) timezone = decodeURIComponent(timezone);

  const incomingAuth = normalizeAuth(
    req.headers.authorization
  );
  const expectedSecret = String(
    process.env.GHL_SECRET || ""
  ).trim();

  console.log("--------------------------------------------------");
  console.log(`[${debugId}] ${req.method} ${req.originalUrl}`);
  console.log(`[${debugId}] parsed:`, {
    action,
    studioKey,
    timezone,
    source,
    dateParam,
  });

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
      error: "Missing action",
    });
  }

  if (action === "ping") {
    return res.status(200).json({
      ok: true,
      message: "pong",
      debugId,
    });
  }

  // ---------------- get_schedule_web ----------------
  if (action === "get_schedule_web") {
    try {
      let fromDate, toDate;

      if (dateParam) {
        const today = new Date();
        const requested = new Date(dateParam);

        const diffDays =
          (requested - today) / (1000 * 60 * 60 * 24);

        if (diffDays > 14) {
          return res.status(400).json({
            ok: false,
            debugId,
            error:
              "Date too far in future. Max 14 days allowed.",
          });
        }

        const range = buildUtcRangeFromLocalDate(
          dateParam,
          timezone
        );
        fromDate = range.fromDate;
        toDate = range.toDate;
      } else {
        const range = defaultDateRangeISO(14);
        fromDate = range.fromDate;
        toDate = range.toDate;
      }

      const result = await fetchMindbodyWidgetSchedule({
        fromDate,
        toDate,
        debugId,
      });

      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        date: dateParam || null,
        widget: {
          status: result.status,
          ok: result.ok,
          rawLength: result.text.length,
          preview: result.text.slice(0, 500),
        },
        debugId,
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        debugId,
        error: String(err?.message || err),
      });
    }
  }

  return res.status(400).json({
    ok: false,
    debugId,
    error: `Unknown action: ${action}`,
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));

app.listen(PORT, () =>
  console.log(`Server listening on ${PORT}`)
);






