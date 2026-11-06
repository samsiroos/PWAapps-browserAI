const $ = (id) => document.getElementById(id);
const state = { running: false, stopped: false, pending: null, localRuntime: false, runId: null, lastJobId: null, seenEvents: new Set(), pollTimer: null, waitingKind: null, configRequired: false, historyOpen: false };
const CONFIG_KEY="browser-agent-config-v1";
const heroScenes=["images/scene-metro.png","images/scene-greenhouse.png","images/scene-door.png"];
const providers = {
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
  pwaapps: { endpoint: "https://licence.pwaapps.com:443/airelay/api/v1", model: "" },
  custom: { endpoint: "", model: "" }
};
const rtlPattern = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
function applyDirection(element,text){const rtl=rtlPattern.test(text||"");element.dir=rtl?"rtl":"ltr";element.classList.toggle("rtl",rtl)}
function saveConfig(){try{localStorage.setItem(CONFIG_KEY,JSON.stringify({provider:$("provider").value,endpoint:$("apiEndpoint").value,apiKey:$("apiKey").value,model:$("modelName").value,approvalPolicy:$("approvalPolicy").value}))}catch{}}
function restoreConfig(){try{const saved=JSON.parse(localStorage.getItem(CONFIG_KEY)||"null");if(!saved)return;$("provider").value=saved.provider||"openai";$("apiEndpoint").value=saved.endpoint??providers[$("provider").value].endpoint;$("apiKey").value=saved.apiKey||"";$("modelName").value=saved.model??providers[$("provider").value].model;$("approvalPolicy").value=saved.approvalPolicy||"risky"}catch{}}
function configIsValid(){return Boolean($("apiEndpoint").value.trim()&&$("apiKey").value.trim()&&($("provider").value==="pwaapps"||$("modelName").value.trim()))}
function openConfig(required=false){state.configRequired=required;$("setupCard").hidden=false;$("configBackdrop").hidden=false;document.body.classList.add("config-open");setTimeout(()=>$("provider").focus(),50)}
function closeConfig(){if(state.configRequired&&!configIsValid())return;$("setupCard").hidden=true;$("configBackdrop").hidden=true;document.body.classList.remove("config-open");state.configRequired=false}
const demoSteps = [
  ["plan", "Planning the approach", "I’ll search product listings, collect price and rating data, then compare the strongest candidates."],
  ["browser", "Opening search results", "Navigating to a product search and scanning the first page for relevant options."],
  ["observe", "Reviewing product details", "Found several matching keyboards. Checking ratings, current prices, and standout features."],
  ["compare", "Comparing the shortlist", "Organizing the three strongest options by price, rating, connectivity, and best use case."]
];

function toast(message){const el=$("toast");el.textContent=message;el.classList.add("show");clearTimeout(el._timer);el._timer=setTimeout(()=>el.classList.remove("show"),2600)}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function setStatus(type,title){$("statusDot").className="status-dot "+(type||"");$("runTitle").textContent=title}
function addStep(kind,title,text){
  const row=document.createElement("div");row.className="timeline-item "+(kind==="response"?"response":kind==="error"?"error":"");
  const symbols={plan:"01",browser:"↗",observe:"◎",compare:"≋",response:"✓",error:"!",question:"?"};
  row.innerHTML=`<div class="timeline-icon">${symbols[kind]||"·"}</div><div class="timeline-content"><span>${kind}</span><h3></h3><p></p></div>`;
  row.querySelector("h3").textContent=title;row.querySelector("p").textContent=text;applyDirection(row.querySelector(".timeline-content"),`${title} ${text}`);$("timeline").appendChild(row);row.scrollIntoView({behavior:"smooth",block:"nearest"});
}
function resetRun(){state.stopped=false;$("emptyState").hidden=true;$("timeline").hidden=false;$("timeline").innerHTML="";$("approvalCard").hidden=true;$("continueCard").hidden=true;$("stopButton").hidden=false;$("runButton").classList.add("running")}
function finishRun(){state.running=false;$("stopButton").hidden=true;$("runButton").classList.remove("running");setStatus("","Run complete");$("continueCard").hidden=!(state.localRuntime&&state.lastJobId);if(state.historyOpen)loadJobs()}
function demoAnswer(task){return `I completed the research workflow for: “${task}”\n\nTop choices\n1. Keychron K2 — best overall balance of build quality, wireless flexibility, and value.\n2. Logitech K380 — best budget pick for portability and multi-device use.\n3. Royal Kludge RK84 — best feature set for users who want mechanical switches and customization.\n\nBefore buying, verify the live price, keyboard layout, and switch type on the seller’s page.`}

async function runDemo(task){
  for(const [kind,title,text] of demoSteps){if(state.stopped)return;await delay(650);addStep(kind,title,text)}
  if(state.stopped)return;
  const policy=$("approvalPolicy").value;
  if(policy!=="none"){
    state.pending=new Promise(resolve=>state.pendingResolve=resolve);setStatus("waiting","Waiting for your approval");$("approvalTitle").textContent="Open three product pages?";$("approvalText").textContent="This will navigate to external seller pages to verify current prices. No purchase or account action will be taken.";$("approvalCard").hidden=false;
    const approved=await state.pending;$("approvalCard").hidden=true;if(!approved){addStep("question","Action denied","I skipped opening seller pages and completed the answer using the information already collected.")}
  }
  if(state.stopped)return;setStatus("active","Writing final response");await delay(650);addStep("response","Final response",demoAnswer(task));finishRun();
}

async function callModel(task){
  const base=$("apiEndpoint").value.trim().replace(/\/$/,"");const key=$("apiKey").value.trim();const model=$("modelName").value.trim();
  addStep("plan","Sending task to model",`Using ${model} through the configured OpenAI-compatible endpoint.`);
  const prompt=`You are a careful browser agent. The browser tools are represented by this workbench, so do not claim you actually opened pages. Given the user's browser task, return a concise execution plan, say what information or approval you would need, and provide the best useful response possible. Clearly label assumptions. User task: ${task}`;
  try{
    const body={messages:[{role:"system",content:"Be concise, transparent, and safety-conscious."},{role:"user",content:prompt}],temperature:.3};if(model)body.model=model;
    const res=await fetch(`${base}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},body:JSON.stringify(body)});
    if(!res.ok){const detail=await res.text();throw new Error(`${res.status} ${detail.slice(0,180)}`)}
    const data=await res.json();const answer=data.choices?.[0]?.message?.content||"The model returned no text response.";
    addStep("response","Model response",answer);finishRun();setConnection(true);
  }catch(error){addStep("error","Request failed",`${error.message}\n\nCheck the endpoint, key, model name, and whether the endpoint allows browser requests (CORS).`);finishRun();setConnection(false)}
}

async function startLocalRun(task,continueFrom=null){
  const response=await fetch("/api/runs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({task,provider:$("provider").value,endpoint:$("apiEndpoint").value.trim(),apiKey:$("apiKey").value.trim(),model:$("modelName").value.trim(),approvalPolicy:$("approvalPolicy").value,continueFrom})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not start the local agent");
  state.runId=data.id;state.seenEvents.clear();pollLocalRun();
}
async function pollLocalRun(){
  if(!state.runId)return;
  try{
    const response=await fetch(`/api/runs/${state.runId}`);const run=await response.json();if(!response.ok)throw new Error(run.error||"Run unavailable");
    for(const item of run.events||[]){if(!state.seenEvents.has(item.id)){state.seenEvents.add(item.id);addStep(item.kind,item.title,item.text)}}
    if(run.waiting){state.waitingKind=run.waiting.kind||"approval";const question=state.waitingKind==="question";setStatus("waiting",question?"Waiting for your answer":"Waiting for your approval");$("approvalTitle").textContent=run.waiting.title;$("approvalText").textContent=run.waiting.detail;$("userAnswer").hidden=!question;$("denyButton").textContent=question?"Skip":"Deny";$("approveButton").textContent=question?"Send answer":"Approve action";applyDirection($("approvalCard"),`${run.waiting.title} ${run.waiting.detail}`);$("approvalCard").hidden=false;if(question&&!$("userAnswer").value)setTimeout(()=>$("userAnswer").focus(),50)}else {state.waitingKind=null;$("approvalCard").hidden=true;$("userAnswer").hidden=true}
    if(["completed","failed","stopped"].includes(run.status)){state.lastJobId=state.runId;finishRun();state.runId=null;return}
    setStatus(run.status==="waiting"?"waiting":"active",run.status==="starting"?"Launching browser":"Agent is controlling Chromium");state.pollTimer=setTimeout(pollLocalRun,700);
  }catch(error){addStep("error","Runtime connection lost",error.message);finishRun();state.runId=null}
}

async function startRun(){
  if(state.running)return;if(!configIsValid()){toast("Set up your AI provider first");openConfig(true);return}const task=$("taskInput").value.trim();if(!task){toast("Describe a task first");$("taskInput").focus();return}
  state.running=true;resetRun();setStatus("active","Agent is working");
  try{
    if(state.localRuntime){if(!$("apiKey").value.trim())throw new Error("Add the selected provider's API key first.");await startLocalRun(task)}
    else if($("apiKey").value.trim())await callModel(task);else await runDemo(task);
  }catch(error){addStep("error","Could not start agent",error.message);finishRun()}
}
function setConnection(live){const badge=$("connectionBadge");badge.classList.toggle("live",live);badge.querySelector("span").textContent=live?"API connected":"Demo mode"}

function newJob(){if(state.running){toast("Stop the current job before starting a new one");return}state.runId=null;state.lastJobId=null;state.seenEvents.clear();$("taskInput").value="";applyDirection($("taskInput"),"");$("timeline").innerHTML="";$("timeline").hidden=true;$("emptyState").hidden=false;$("approvalCard").hidden=true;$("continueCard").hidden=true;setStatus("","Ready for a task");$("taskInput").focus()}
function openHistory(){state.historyOpen=true;$("historyPanel").hidden=false;$("historyBackdrop").hidden=false;loadJobs()}
function closeHistory(){state.historyOpen=false;$("historyPanel").hidden=true;$("historyBackdrop").hidden=true}
async function loadJobs(){
  const list=$("historyList");list.innerHTML='<div class="history-empty">Loading jobs…</div>';
  try{const response=await fetch("/api/jobs",{cache:"no-store"});if(!response.ok)throw new Error();const data=await response.json();list.innerHTML="";if(!data.jobs.length){list.innerHTML='<div class="history-empty">No saved jobs yet.<br>Your next run will appear here.</div>';return}data.jobs.forEach(job=>list.appendChild(jobCard(job)))}catch{list.innerHTML='<div class="history-empty">Job history is available in the local app at localhost:3210.</div>'}
}
function jobCard(job){
  const card=document.createElement("article");card.className="job-item";card.innerHTML='<div class="job-item-top"><h3></h3><span class="job-status"></span></div><p class="job-meta"></p><div class="job-actions"><button data-action="open">Open</button><button data-action="rerun">Rerun</button><button class="delete-job" data-action="delete">Delete</button></div>';
  card.querySelector("h3").textContent=job.task;applyDirection(card.querySelector("h3"),job.task);const badge=card.querySelector(".job-status");badge.textContent=job.status;badge.classList.add(job.status);card.querySelector(".job-meta").textContent=`${job.provider||"custom"}${job.model?` · ${job.model}`:" · auto"} · ${new Date(Number(job.created_at)).toLocaleString()}`;
  card.querySelector('[data-action="open"]').addEventListener("click",()=>openSavedJob(job.id));card.querySelector('[data-action="rerun"]').addEventListener("click",()=>rerunJob(job.id));card.querySelector('[data-action="delete"]').addEventListener("click",()=>deleteJob(job.id,job.task));return card;
}
async function getJob(id){const response=await fetch(`/api/jobs/${id}`,{cache:"no-store"});const job=await response.json();if(!response.ok)throw new Error(job.error||"Could not load job");return job}
async function openSavedJob(id){try{const job=await getJob(id);closeHistory();state.lastJobId=job.id;$("taskInput").value=job.task;applyDirection($("taskInput"),job.task);$("emptyState").hidden=true;$("timeline").hidden=false;$("timeline").innerHTML="";(job.events||[]).forEach(item=>addStep(item.kind,item.title,item.text));setStatus("",`Saved job · ${job.status}`);$("continueCard").hidden=!(["completed","failed","stopped","interrupted"].includes(job.status)&&state.localRuntime)}catch(error){toast(error.message)}}
async function continueJob(){const followUp=$("continueInput").value.trim();if(!followUp){toast("Describe the next part of the job");$("continueInput").focus();return}if(!state.lastJobId||!state.localRuntime){toast("Open a saved local job first");return}if(!configIsValid()){openConfig(true);return}state.running=true;resetRun();setStatus("active","Continuing previous job");try{await startLocalRun(followUp,state.lastJobId);$("continueInput").value=""}catch(error){addStep("error","Could not continue job",error.message);finishRun()}}
async function rerunJob(id){if(state.running){toast("Stop the current job before rerunning another");return}try{const job=await getJob(id);$("taskInput").value=job.task;$("provider").value=job.provider||$("provider").value;$("apiEndpoint").value=job.endpoint||$("apiEndpoint").value;$("modelName").value=job.model||"";saveConfig();closeHistory();startRun()}catch(error){toast(error.message)}}
async function deleteJob(id,task){if(!confirm(`Delete this saved job?\n\n${task}`))return;try{const response=await fetch(`/api/jobs/${id}`,{method:"DELETE"});const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not delete job");toast("Job deleted");loadJobs()}catch(error){toast(error.message)}}

$("runButton").addEventListener("click",startRun);$("taskInput").addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter")startRun()});
$("taskInput").addEventListener("input",e=>applyDirection(e.currentTarget,e.currentTarget.value));applyDirection($("taskInput"),$("taskInput").value);
$("stopButton").addEventListener("click",async()=>{state.stopped=true;state.running=false;if(state.runId)await fetch(`/api/runs/${state.runId}/stop`,{method:"POST"});if(state.pendingResolve)state.pendingResolve(false);$("approvalCard").hidden=true;if(!state.localRuntime)addStep("error","Run stopped","The run was stopped by you.");finishRun()});
async function decide(approved){if(state.runId){const answer=state.waitingKind==="question"&&approved?$("userAnswer").value.trim():"";if(state.waitingKind==="question"&&approved&&!answer){toast("Type an answer or choose Skip");return}await fetch(`/api/runs/${state.runId}/decision`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(answer?{answer}:{approved})});$("approvalCard").hidden=true;$("userAnswer").value="";return}if(state.pendingResolve){state.pendingResolve(approved);state.pendingResolve=null;setStatus("active",approved?"Agent is working":"Finishing without that action");if(approved)addStep("browser","Action approved","Opening the shortlisted pages to verify details.")}}
$("approveButton").addEventListener("click",()=>decide(true));
$("denyButton").addEventListener("click",()=>decide(false));
$("keyToggle").addEventListener("click",()=>{const input=$("apiKey");input.type=input.type==="password"?"text":"password"});
$("themeButton").addEventListener("click",()=>document.body.classList.toggle("dark"));
restoreConfig();
{const values=new Uint32Array(1);crypto.getRandomValues(values);const scene=heroScenes[values[0]%heroScenes.length];document.documentElement.style.setProperty("--scene-image",`url("${scene}")`)}
$("provider").addEventListener("change",()=>{const preset=providers[$("provider").value];$("apiEndpoint").value=preset.endpoint;$("modelName").value=preset.model;saveConfig()});
[$("apiEndpoint"),$("apiKey"),$("modelName"),$("approvalPolicy")].forEach(element=>element.addEventListener(element.tagName==="SELECT"?"change":"input",saveConfig));
$("userAnswer").addEventListener("input",e=>applyDirection(e.currentTarget,e.currentTarget.value));$("userAnswer").addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter")decide(true)});
document.querySelectorAll("[data-prompt]").forEach(button=>button.addEventListener("click",()=>{$("taskInput").value=button.dataset.prompt;$("taskInput").focus()}));
$("settingsButton").addEventListener("click",()=>openConfig(false));
$("newJobButton").addEventListener("click",newJob);$("historyButton").addEventListener("click",openHistory);$("closeHistory").addEventListener("click",closeHistory);$("historyBackdrop").addEventListener("click",closeHistory);
$("continueButton").addEventListener("click",continueJob);$("continueInput").addEventListener("input",e=>applyDirection(e.currentTarget,e.currentTarget.value));$("continueInput").addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key==="Enter")continueJob()});
$("configBackdrop").addEventListener("click",()=>closeConfig());
$("saveConfigButton").addEventListener("click",()=>{if(!configIsValid()){toast($("provider").value==="pwaapps"?"API endpoint and key are required":"API endpoint, key, and model are required");return}saveConfig();closeConfig();toast("AI settings saved")});
if(!configIsValid())openConfig(true);

(async()=>{try{const response=await fetch("/api/health",{cache:"no-store"});const data=await response.json();if(data.ok){state.localRuntime=true;setConnection(true);$("connectionBadge").querySelector("span").textContent="Local agent ready"}}catch{state.localRuntime=false}})();
