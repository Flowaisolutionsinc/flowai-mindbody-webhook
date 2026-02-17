import express from "express";

const app = express();
app.use(express.json());

const STUDIO_TZ = "America/Vancouver";

/*
  STANDARDIZED RESPONSE SHAPE
  ALWAYS RETURNS:

  {
    success: true,
    results: {
      say: "...",
      text: "...",
      date: "...",
      timezone: "...",
      classes: [...]
    }
  }
*/

function sendSuccess(res, payload) {
  return res.status(200).json({
    success: true,
    results: payload
  });
}

function sendFailure(res, message) {
  return res.status(200).json({
    success: false,
    results: {
      say: message,
      text: message
    }
  });
}

app.get("/health", (req, res) => {
  return sendSuccess(res, {
    ok: true
  });
});

app.get("/mb/schedule", async (req, res) => {
  try {
    const { date = "today", location_id = "1" } = req.query;

    // IMPORTANT:
    // Replace this with your real Mindbody fetch logic
    // This is just structure example

    const say = `Classes for ${date}: 7:15 AM Hot Yoga | 5:30 PM Hot Sculpt`;

    return sendSuccess(res, {
      say,
      text: say,
      date,
      timezone: STUDIO_TZ,
      classes: []
    });

  } catch (err) {
    return sendFailure(res, "Sorry — I couldn’t access the schedule.");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});

