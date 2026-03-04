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

  /* remove ordinal suffix */
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

  const parsed=new Date(input);

  if(!isNaN(parsed)) return parsed;

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

function buildScheduleSay(dateISO,classes){

  if(!classes.length)
    return `I couldn't find any classes for ${dateISO}.`;

  const max=6;

  const list=classes.slice(0,max).map(c =>
    `${c.time} ${c.name} with ${c.instructor}`
  );

  return `The classes for ${dateISO} are: ${list.join(", ")}. Would you like to book one?`;
}

/* =================================
   MINDBODY FETCH
================================ */

async function fetchClasses(dateISO){

  const {start,end}=buildWindow(dateISO);

  const url=new URL(`${BASE_URL}/class/classes`);

  url.searchParams.set("StartDateTime",start);
  url.searchParams.set("EndDateTime",end);

  /* force location 1 */
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

  rawClasses.slice(0,5).forEach(c=>{
    console.log(
      "CLASS:",
      c.Id,
      "|",
      c.ClassDescription?.Name,
      "|",
      c.StartDateTime
    );
  });

  return rawClasses;
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

    const raw=await fetchClasses(dateISO);

    const classes=normalizeClasses(raw);

    /* sort classes */
    classes.sort((a,b)=>{
      return new Date(a.start)-new Date(b.start);
    });

    const speech=buildScheduleSay(dateISO,classes);

    console.log("SPEECH OUTPUT:",speech);

    res.setHeader("Content-Type","text/plain; charset=utf-8");

    return res.status(200).send(speech);

  }catch(err){

    console.log("ERROR:",err.message);

    return res
      .status(200)
      .send("I'm having trouble retrieving the schedule right now.");
  }
}

/* =================================
   ROUTES (UNCHANGED)
================================ */

app.post("/ghl/mindbody",handleSchedule);
app.get("/ghl/mindbody",handleSchedule);

app.post("/ghl/mindbody/speak",handleSchedule);
app.get("/ghl/mindbody/speak",handleSchedule);

/* =================================
   HEALTH
================================ */

app.get("/",(_,res)=>res.send("ok"));

app.listen(PORT,()=>{
  console.log("Server running on port",PORT);
});
