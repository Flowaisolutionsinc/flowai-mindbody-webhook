const express = require("express");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 8080;

const API_KEY = process.env.MINDBODY_API_KEY;
const SITE_ID = process.env.MINDBODY_SITE_ID;

const BASE_URL = "https://api.mindbodyonline.com/public/v6";
const LOCATION_ID = "1";

/* =================================
CACHE
================================ */

const scheduleCache = new Map();

/* =================================
HELPERS
================================ */

function safeString(v){
  if(v === undefined || v === null) return "";
  return String(v);
}

function decodeMaybe(v){
  const s = safeString(v);
  try{
    return decodeURIComponent(s.replace(/\+/g," "));
  }catch{
    return s.replace(/\+/g," ");
  }
}

/* =================================
DATE PARSER
================================ */

function parseDatePhrase(input="today"){

  input = String(input).toLowerCase().trim();

  console.log("DATE PHRASE RECEIVED:", input);

  input = input.replace(/(\d+)(st|nd|rd|th)/g,"$1");

  const today = new Date();

  if(input==="today") return today;

  if(input==="tomorrow"){
    today.setDate(today.getDate()+1);
    return today;
  }

  const weekdays=[
    "sunday","monday","tuesday",
    "wednesday","thursday","friday","saturday"
  ];

  if(weekdays.includes(input)){
    const target=weekdays.indexOf(input);
    const now=today.getDay();

    let delta=(target-now+7)%7;

    if(delta===0) delta=0;

    today.setDate(today.getDate()+delta);

    return today;
  }

  const parsed = new Date(input);

  if(!isNaN(parsed)){

    const now = new Date();

    if(parsed.getFullYear() === 2001){
      parsed.setFullYear(now.getFullYear());
    }

    return parsed;
  }

  return today;
}

function toISO(date){
  return date.toISOString().split("T")[0];
}

function buildWindow(dateISO){
  return{
    start:`${dateISO}T00:00:00`,
    end:`${dateISO}T23:59:59`
  };
}

/* =================================
NORMALIZE CLASSES
================================ */

function normalizeClasses(rawClasses){

  const classes=[];

  for(const c of rawClasses||[]){

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

/* =================================
SPEECH BUILDER
================================ */

function buildScheduleSay(dateLabel,classes){

  if(!classes.length)
    return `I couldn't find any classes for ${dateLabel}.`;

  const max=2;

  const list=classes.slice(0,max).map(c =>
    `${c.time} ${c.name} with ${c.instructor}`
  );

  return `The next classes for ${dateLabel} are: ${list.join(", ")}. Would you like to book one?`;
}

/* =================================
MINDBODY FETCH
================================ */

async function fetchLiveClasses(dateISO){

  const {start,end}=buildWindow(dateISO);

  const url=new URL(`${BASE_URL}/class/classes`);

  url.searchParams.set("StartDateTime",start);
  url.searchParams.set("EndDateTime",end);
  url.searchParams.set("LocationIds",LOCATION_ID);

  console.log("Fetching Mindbody classes for",dateISO);

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

  const rawClasses=json.Classes || [];

  console.log("CLASSES FOUND:",rawClasses.length);

  if(rawClasses.length>0){
    console.log(
      "LOCATION:",
      rawClasses[0]?.Location?.Name,
      "| ID:",
      rawClasses[0]?.Location?.Id
    );
  }

  return rawClasses;
}

/* =================================
CACHE FUNCTIONS
================================ */

function getCachedClasses(dateISO){
  return scheduleCache.get(dateISO) || null;
}

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

      scheduleCache.set(dateISO, classes);

      console.log("Cache updated:",dateISO,"classes:",classes.length);

    }catch(err){

      console.log("Cache warm error:",err.message);

    }

  }

}

/* =================================
MAIN HANDLER
================================ */

async function handleSchedule(req,res){

  const q=req.query || {};
  const b=req.body || {};

  const datePhrase =
    decodeMaybe(
      q.date ??
      b.date ??
      q.datePhrase ??
      b.datePhrase ??
      q.dateParam ??
      b.dateParam ??
      "today"
    );

  try{

    const date=parseDatePhrase(datePhrase);

    const dateISO=toISO(date);

    const spokenDate=date.toLocaleDateString(
      "en-US",
      { weekday:"long", month:"long", day:"numeric" }
    );

    let classes = getCachedClasses(dateISO);

    if(!classes){

      console.log("CACHE MISS:",dateISO);

      const raw = await fetchLiveClasses(dateISO);

      classes = normalizeClasses(raw);

      classes.sort((a,b)=> new Date(a.start)-new Date(b.start));

      scheduleCache.set(dateISO, classes);

    }else{

      console.log("CACHE HIT:",dateISO);

    }

    const speech=buildScheduleSay(spokenDate,classes);

    console.log("SPEECH OUTPUT:",speech);

    return res.status(200).json({
      speech: speech,
      classes: classes.slice(0,6)
    });

  }catch(err){

    console.log("ERROR:",err.message);

    return res.status(200).json({
      speech: "I'm having trouble retrieving the schedule right now."
    });

  }

}

/* =================================
ROUTES
================================ */

app.post("/ghl/mindbody",handleSchedule);
app.get("/ghl/mindbody",handleSchedule);

app.post("/ghl/mindbody/speak",handleSchedule);
app.get("/ghl/mindbody/speak",handleSchedule);

/* =================================
HEALTH CHECK
================================ */

app.get("/",(_,res)=>res.send("ok"));

/* =================================
CACHE WARMER
================================ */

warmCache();

setInterval(()=>{
  warmCache();
}, 15 * 60 * 1000);

/* =================================
START SERVER
================================ */

app.listen(PORT,()=>{
  console.log("Server running on port",PORT);
});
