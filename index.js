const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const API_KEY = process.env.MINDBODY_API_KEY;
const SITE_ID = process.env.MINDBODY_SITE_ID;

const BASE_URL = "https://api.mindbodyonline.com/public/v6";
const LOCATION_ID = "1";

/* ===============================
CACHE
=============================== */

const scheduleCache = new Map();
const CACHE_MAX_AGE = 15 * 60 * 1000;

/* ===============================
DATE PARSER
=============================== */

function parseDatePhrase(input="today"){

  input = String(input).toLowerCase().trim();
  input = input.replace(/(\d+)(st|nd|rd|th)/g,"$1");

  const today = new Date();

  if(input === "today") return today;

  if(input === "tomorrow"){
    today.setDate(today.getDate()+1);
    return today;
  }

  const parsed = new Date(input);

  if(!isNaN(parsed)){

    if(parsed.getFullYear() === 2001){
      parsed.setFullYear(today.getFullYear());
    }

    return parsed;
  }

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

/* ===============================
CLASS NORMALIZER
=============================== */

function normalizeClasses(rawClasses){

  const classes=[];

  for(const c of rawClasses || []){

    const name =
      c?.ClassDescription?.Name ||
      c?.Name ||
      "Class";

    const instructor =
      c?.Staff?.Name ||
      c?.Staff?.FirstName ||
      "Instructor";

    const start=c?.StartDateTime;

    let time="";

    if(start){

      const dt=new Date(start);

      time=new Intl.DateTimeFormat("en-US",{
        hour:"numeric",
        minute:"2-digit"
      }).format(dt);

    }

    classes.push({
      id:c?.Id,
      name,
      instructor,
      time,
      start
    });

  }

  return classes;
}

/* ===============================
SPEECH BUILDER
=============================== */

function buildScheduleSay(dateLabel,classes){

  if(!classes.length){
    return `I couldn't find any classes for ${dateLabel}.`;
  }

  const list = classes
    .slice(0,2)
    .map(c => `${c.time} ${c.name} with ${c.instructor}`);

  return `The next classes for ${dateLabel} are: ${list.join(", ")}.`;
}

/* ===============================
MINDBODY FETCH
=============================== */

async function fetchLiveClasses(dateISO){

  const {start,end}=buildWindow(dateISO);

  const url=new URL(`${BASE_URL}/class/classes`);

  url.searchParams.set("StartDateTime",start);
  url.searchParams.set("EndDateTime",end);
  url.searchParams.set("LocationIds",LOCATION_ID);

  console.log("Mindbody request:",url.toString());

  const resp=await fetch(url.toString(),{
    method:"GET",
    headers:{
      "Api-Key":API_KEY,
      SiteId:SITE_ID,
      "Content-Type":"application/json"
    },
    signal:AbortSignal.timeout(2500)
  });

  const json=await resp.json();

  if(!resp.ok){
    throw new Error(json?.Error?.Message || "Mindbody error");
  }

  console.log("Mindbody classes received:",json.Classes?.length || 0);

  return json.Classes || [];
}

/* ===============================
CACHE FUNCTIONS
=============================== */

function getCachedClasses(dateISO){

  const cached = scheduleCache.get(dateISO);

  if(!cached) return null;

  const age = Date.now() - cached.updated;

  if(age > CACHE_MAX_AGE){

    console.log("CACHE STALE:",dateISO);

    scheduleCache.delete(dateISO);

    return null;
  }

  console.log("CACHE HIT:",dateISO);

  return cached.classes;
}

function setCachedClasses(dateISO,classes){

  scheduleCache.set(dateISO,{
    classes,
    updated: Date.now()
  });

}

/* ===============================
CACHE WARMER
=============================== */

async function warmCache(){

  console.log("Warming schedule cache...");

  const today = new Date();

  for(let i=0;i<7;i++){

    const d = new Date(today);
    d.setDate(today.getDate()+i);

    const dateISO = toISO(d);

    try{

      const raw = await fetchLiveClasses(dateISO);

      const classes = normalizeClasses(raw);

      classes.sort((a,b)=> new Date(a.start)-new Date(b.start));

      setCachedClasses(dateISO,classes);

      console.log("Cache updated:",dateISO);

    }catch(err){

      console.log("Cache warm error:",err.message);

    }

  }

}

/* ===============================
MAIN HANDLER
=============================== */

async function handleMindbody(req,res){

  console.log("----- WEBHOOK REQUEST -----");
  console.log("Body:",JSON.stringify(req.body,null,2));
  console.log("Query:",JSON.stringify(req.query,null,2));
  console.log("---------------------------");

  const action =
    req.body?.action ||
    req.query?.action;

  if(action !== "get_schedule"){
    return res.status(200).json({
      results:"Invalid action."
    });
  }

  const datePhrase =
    req.body?.date ||
    req.query?.date ||
    "today";

  console.log("DATE PHRASE RECEIVED:",datePhrase);

  try{

    const date = parseDatePhrase(datePhrase);
    const dateISO = toISO(date);

    const spokenDate = date.toLocaleDateString(
      "en-US",
      { weekday:"long", month:"long", day:"numeric" }
    );

    let classes = getCachedClasses(dateISO);

    if(!classes){

      console.log("CACHE MISS:",dateISO);

      const raw = await fetchLiveClasses(dateISO);

      classes = normalizeClasses(raw);

      classes.sort((a,b)=> new Date(a.start)-new Date(b.start));

      setCachedClasses(dateISO,classes);

    }

    const speech = buildScheduleSay(spokenDate,classes);

    console.log("----- WEBHOOK RESPONSE -----");
    console.log(speech);
    console.log("----------------------------");

    return res.status(200).json({
      results: speech
    });

  }catch(err){

    console.log("ERROR:",err.message);

    return res.status(200).json({
      results:"I'm not able to pull the schedule up right now — would you like me to connect you with the front desk?"
    });

  }

}

/* ===============================
ROUTES
=============================== */

app.post("/ghl/mindbody",handleMindbody);
app.get("/ghl/mindbody",handleMindbody);

app.post("/ghl/mindbody/speak",handleMindbody);
app.get("/ghl/mindbody/speak",handleMindbody);

/* ===============================
DEBUG ENDPOINT
=============================== */

app.get("/debug",(req,res)=>{
  res.send("Webhook server alive");
});

/* ===============================
CACHE START
=============================== */

warmCache();

setInterval(()=>{
  warmCache();
},15*60*1000);

/* ===============================
SERVER START
=============================== */

app.listen(PORT,()=>{
  console.log("Server running on port",PORT);
});
