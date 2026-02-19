const express = require("express");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// --- helpers ---
function normalizeAuth(authHeaderRaw = "") {
  const raw = String(authHeaderRaw || "").trim();
  if (!raw) return "";
  // Accept either "token" or "Bearer token"
  return raw.toLowerCase().startsWith("bearer ") ? raw.slice(7).trim() : raw;
}

function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function decodeMaybe(v) {
  if (v === undefined || v === null) return v;
  const s = String(v);
  try {
    return s.includes("%") ? decodeURIComponent(s) : s;
  } catch {
    return s;
  }
}

function makeDebugId() {
  return (
    Math.random().toString(16).slice(2, 10) +
    Math.random().toString(16).slice(2, 10)
  );
}

function isoNow() {
  return new Date().toISOString();
}

function isoPlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString();
}

function dateOnlyISO(d) {
  // yyyy-mm-dd in local time
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateOnly(s) {
  // expects YYYY-MM-DD
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  const dt = new Date(y, mo, d, 0, 0, 0);
  if (Number.isNaN(dt.getTime())) return null;
  return dt;
}

// --- mock schedule generator ---
function buildMockSchedule({ studioKey, timezone, fromDate, toDate }) {
  // Simple predictable classes for flow testing
  // fromDate/toDate are Date objects (local)
  const classes = [];
  const names = ["Hot Yoga", "Yin", "Sculpt", "Power Flow", "Pilates"];

  let cur = new Date(fromDate.getTime());
  let idx = 0;

  while (cur <= toDate) {
    const day = dateOnlyISO(cur);

    // 3 classes per day at fixed times
    const times = ["06:00", "12:00", "18:00"];
    for (const t of times) {
      const [hh, mm] = t.split(":").map(Number);

      const start = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), hh, mm, 0);
      const end = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), hh + 1, mm, 0);

      classes.push({
        id: `mock-${day}-${t.replace(":", "")}`,
        name: names[idx % names.length],
        startLocal: `${day}T${t}:00`,
        endLocal: `${day}T${String(hh + 1).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`,
        timezone,
        instructor: ["Jess", "Alex", "Sam", "Taylor"][idx % 4],
        spotsRemaining: 2 + (idx % 10),
        level: "All Levels",
        location: studioKey,
      });

      idx++;
    }

    cur.setDate(cur.getDate() + 1);
  }

  return {
    studioKey,
    timezone,
    range: {
      from: dateOnlyISO(fromDate),
      to: dateOnlyISO(toDate),
    },
    classes,
  };
}

// --- route ---
app.post("/ghl/mindbody", (req, res) => {
  const debugId = makeDebugId();

  // Merge inputs from query + body (AgencyVault is sending query params)
  const action = pickFirst(req.body?.action, req.query?.action);
  const studioKey = pickFirst(req.body?.studioKey, req.query?.studioKey);
  const timezoneRaw = pickFirst(req.body?.timezone, req.query?.timezone);
  const source = pickFirst(req.body?.source, req.query?.source);
  const timezone = decodeMaybe(timezoneRaw);

  // Auth
  const incomingAuth = normalizeAuth(req.headers.authorization);
  const expectedSecret = String(process.env.GHL_SECRET || "").trim();

  // Mode
  const mode = String(process.env.MINDBODY_MODE || "mock").trim().toLowerCase(); // "mock" or "live"

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
  console.log(`[${debugId}] parsed:`, { action, studioKey, timezone, source });

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
      mode,
      message: "pong",
      debugId,
    });
  }

  // Step: get_schedule (MOCK now, LIVE later)
  if (action === "get_schedule") {
    // Inputs you can test later from the AI:
    // from=YYYY-MM-DD, to=YYYY-MM-DD, OR days=7
    const fromStr = pickFirst(req.body?.from, req.query?.from);
    const toStr = pickFirst(req.body?.to, req.query?.to);
    const days = Number(pickFirst(req.body?.days, req.query?.days) || 7);

    const today = new Date();
    const fromDate = parseDateOnly(fromStr) || today;
    const toDate =
      parseDateOnly(toStr) ||
      new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate() + days, 0, 0, 0);

    if (mode === "mock") {
      const mock = buildMockSchedule({
        studioKey: studioKey || "unknown_studio",
        timezone: timezone || "America/Vancouver",
        fromDate,
        toDate,
      });

      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        mode,
        schedule: mock,
        debugId,
      });
    }

    // LIVE mode placeholder (we will wire this when you have production credentials)
    return res.status(501).json({
      ok: false,
      action,
      studioKey,
      timezone,
      source,
      mode,
      debugId,
      error: "Live Mindbody mode not enabled yet (waiting on production credentials).",
    });
  }

  // Placeholders for later
  if (action === "book_class" || action === "cancel_class") {
    return res.status(200).json({
      ok: true,
      action,
      studioKey,
      timezone,
      source,
      mode,
      message: `${action} received (mock stub)`,
      debugId,
    });
  }

  return res.status(400).json({
    ok: false,
    debugId,
    error: `Unknown action: ${action}`,
    allowed: ["ping", "get_schedule", "book_class", "cancel_class"],
  });
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));


