const express = require("express");
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 8080;

const API_KEY = process.env.MINDBODY_API_KEY;
const SITE_ID = process.env.MINDBODY_SITE_ID;

const BASE_URL = "https://api.mindbodyonline.com/public/v6";
const LOCATION_ID = "1";

/* ==============================
   DATE PARSER
============================== */

function parseDatePhrase(input="today"){

  input = String(input).toLowerCase().trim();

  const today = new Date();

  if(input === "today") return today;

  if(input === "tomorrow"){
    today.setDate(today.getDate()+1);
    return today;
  }

  const weekdays = [
    "sunday","monday","tuesday",
    "wednesday","thursday","friday","saturday"
  ];

  if(weekdays.includes(input)){

    const target = weekdays.indexOf(input);
    const now = today.getDay();

    let delta = (target-now+7)%7;

    if(delta === 0) delta = 7;

    today.setDate(today.getDate()+delta);

    return today;
  }

  const parsed = new Date(input);

  if(!isNaN(parsed)) return parsed;

  return today;
}

function toISO(date){
  return date.toISOString().split("T")[0];
}

function buildWindow(dateISO){
  return {
    start:`${dateISO}T00:00:00`,
    end:`${dateISO}T23:59:59`
  };
}

/* ==============================
   MINDBODY FETCH
============================== */

async function fetchClasses(dateISO){

  const {start,end} = buildWindow(dateISO);

  const url = new URL(`${BASE_URL}/class/classes`);

  url.searchParams.set("StartDateTime",start);
  url.searchParams.set("EndDateTime",end);
  url.searchParams.set("LocationIds",LOCATION_ID);

  console.log("Mindbody request:",url.toString());

  const resp = await fetch(url.toString(),{
    method:"GET",
    headers:{
      "Api-Key":API_KEY,
      "SiteId":SITE_ID,
      "Content-Type":"application/json"
    },
    signal:AbortSignal.timeout(2500)
  });

  const json = await resp.json();

  if(!resp.ok){
    throw new Error(json?.Error?.Message || "Mindbody error");
  }

  return json.Classes || [];
}

/* ==============================
   FORMAT CLASSES
============================== */

function normalize(classes){

  return classes.map(c=>{

    const dt = new Date(c.StartDateTime);

    const time = dt.toLocaleTimeString("en-US",{
      hour:"numeric",
      minute:"2-digit"
    });

    return {
      id:c.Id,
      name:c.ClassDescription?.Name || "Class",
      instructor:c.Staff?.Name || "staff",
      time
    };

  });

}

/* ==============================
   SPEECH BUILDER
============================== */

function buildSpeech(dateISO,classes){

  if(!classes.length)
    return `I couldn't find any classes for ${dateISO}.`;

  const top = classes.slice(0,6);

  const list = top.map(c =>
    `${c.time} ${c.name} with ${c.instructor}`
  );

  return `The classes for ${dateISO} are: ${list.join(", ")}. Would you like to book one?`;
}

/* ==============================
   MAIN WEBHOOK HANDLER
============================== */

async function handleSchedule(req,res){

  const datePhrase =
    req.query.date ||
    req.body?.date ||
    req.query.datePhrase ||
    req.body?.datePhrase ||
    "today";

  try{

    const date = parseDatePhrase(datePhrase);

    const dateISO = toISO(date);

    const raw = await fetchClasses(dateISO);

    const classes = normalize(raw);

    const speech = buildSpeech(dateISO,classes);

    res.setHeader("Content-Type","text/plain");

    return res.send(speech);

  }
  catch(err){

    console.log("Mindbody error:",err.message);

    return res.send(
      "I'm having trouble retrieving the schedule right now."
    );
  }

}

/* ==============================
   ROUTES (UNCHANGED FOR GHL)
============================== */

app.post("/ghl/mindbody",handleSchedule);
app.get("/ghl/mindbody",handleSchedule);

app.post("/ghl/mindbody/speak",handleSchedule);
app.get("/ghl/mindbody/speak",handleSchedule);

/* ==============================
   HEALTH
============================== */

app.get("/",(_,res)=>res.send("ok"));

app.listen(PORT,()=>{
  console.log("Server running on",PORT);
});
