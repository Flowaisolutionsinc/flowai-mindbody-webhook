// index.js
'use strict';

const express = require('express');

const app = express();

// --- Config ---
const PORT = process.env.PORT || 8080;
const GHL_SECRET = process.env.GHL_SECRET || '';
const TZ_DEFAULT = process.env.TZ || 'America/Vancouver';

// Optional, but recommended for scaling
let STUDIO_CONFIG = {};
try {
  if (process.env.STUDIO_CONFIG_JSON) {
    STUDIO_CONFIG = JSON.parse(process.env.STUDIO_CONFIG_JSON);
  }
} catch (e) {
  console.error('Invalid STUDIO_CONFIG_JSON:', e.message);
  STUDIO_CONFIG = {};
}

// Mindbody envs (some may be optional depending on which endpoints you use)
const MINDBODY_API_KEY = process.env.MINDBODY_API_KEY || '';
const MINDBODY_SITE_ID = process.env.MINDBODY_SITE_ID || '';
const MINDBODY_DEFAULT_LOCATION_ID = process.env.MINDBODY_DEFAULT_LOCATION_ID || '';
const MINDBODY_SOURCE_NAME = process.env.MINDBODY_SOURCE_NAME || '';
const MINDBODY_SOURCE_PASSWORD = process.env.MINDBODY_SOURCE_PASSWORD || '';

app.use(express.json({ limit: '1mb' }));

// --- Health endpoints ---
app.get('/', (req, res) => res.status(200).send('ok'));
app.get('/health', (req, res) => res.status(200).send('ok'));

// --- Auth middleware for GHL webhook ---
function requireBearer(req, res, next) {
  // If you ever want to temporarily allow local testing without auth,
  // you can set ALLOW_NO_AUTH=true in Railway (not recommended for prod).
  const allowNoAuth = (process.env.ALLOW_NO_AUTH || '').toLowerCase() === 'true';

  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';

  if (allowNoAuth) return next();

  if (!GHL_SECRET) {
    return res.status(500).json({ error: 'Server misconfigured: missing GHL_SECRET' });
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  if (token !== GHL_SECRET) {
    return res.status(401).json({ error: 'Invalid Authorization token' });
  }

  next();
}

// --- Helpers ---
function getStudioConfig(studioKey) {
  const studio = (studioKey && STUDIO_CONFIG && STUDIO_CONFIG[studioKey]) ? STUDIO_CONFIG[studioKey] : {};
  return {
    timezone: studio.timezone || TZ_DEFAULT,
    siteId: studio.siteId || MINDBODY_SITE_ID,
    locationId: studio.locationId || MINDBODY_DEFAULT_LOCATION_ID,
    // You can also store per-studio source creds if needed later
  };
}

function badRequest(res, message, extra = {}) {
  return res.status(400).json({ error: message, ...extra });
}

// --- Main webhook endpoint ---
app.post('/ghl/mindbody', requireBearer, async (req, res) => {
  try {
    const body = req.body || {};

    const action = body.action;
    const studioKey = body.studioKey;

    if (!action) return badRequest(res, 'Missing required field: action');
    if (!studioKey) return badRequest(res, 'Missing required field: studioKey');

    const studio = getStudioConfig(studioKey);

    // Optional fields (GHL can pass these as fixed too, but config is better)
    const timezone = body.timezone || studio.timezone;
    const source = body.source || 'agencyvault';

    // Basic validation for supported actions
    const allowed = new Set(['ping', 'get_schedule', 'book_class', 'cancel_class']);
    if (!allowed.has(action)) {
      return badRequest(res, 'Unsupported action', { allowed: Array.from(allowed) });
    }

    // ---- Action handlers ----
    if (action === 'ping') {
      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        message: 'pong'
      });
    }

    // NOTE: The below are placeholders until you wire the exact Mindbody endpoints you want.
    // They return structured responses so the agent can proceed safely.

    if (action === 'get_schedule') {
      // TODO: Replace with real Mindbody schedule call
      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        schedule: [],
        note: 'Schedule endpoint not wired yet (placeholder).'
      });
    }

    if (action === 'book_class') {
      // Expect something like: classId, client info, etc.
      // TODO: Replace with real Mindbody booking call
      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        booked: false,
        note: 'Booking endpoint not wired yet (placeholder).'
      });
    }

    if (action === 'cancel_class') {
      // TODO: Replace with real Mindbody cancel call
      return res.status(200).json({
        ok: true,
        action,
        studioKey,
        timezone,
        source,
        cancelled: false,
        note: 'Cancel endpoint not wired yet (placeholder).'
      });
    }

    // Should never reach here
    return badRequest(res, 'Unhandled action');

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Listening on PORT: ${PORT}`);
});
