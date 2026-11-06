const $ = (id) => document.getElementById(id);
const state = { running: false, stopped: false, pending: null, localRuntime: false, runId: null, seenEvents: new Set(), pollTimer: null };
const providers = {
  openai: { endpoint: "https://api.openai.com/v1", model: "gpt-4.1-mini" },
  gemini: { endpoint: "https://generativelanguage.googleapis.com/v1beta", model: "gemini-2.5-flash" },
  openrouter: { endpoint: "https://openrouter.ai/api/v1", model: "openai/gpt-4.1-mini" },
  pwaapps: { endpoint: "https://licence.pwaapps.com:443/airelay/api/v1", model: "" },
  custom: { endpoint: "", model: "" }
};
const rtlPattern = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]/;
function applyDirection(element,text){const rtl=rtlPattern.test(text||"");element.dir=rtl?"rtl":"ltr";element.classList.toggle("rtl",rtl)}
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
function resetRun(){state.stopped=false;$("emptyState").hidden=true;$("timeline").hidden=false;$("timeline").innerHTML="";$("approvalCard").hidden=true;$("stopButton").hidden=false;$("runButton").classList.add("running")}
function finishRun(){state.running=false;$("stopButton").hidden=true;$("runButton").classList.remove("running");setStatus("","Run complete")}
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

async function startLocalRun(task){
  const response=await fetch("/api/runs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({task,provider:$("provider").value,endpoint:$("apiEndpoint").value.trim(),apiKey:$("apiKey").value.trim(),model:$("modelName").value.trim(),approvalPolicy:$("approvalPolicy").value})});
  const data=await response.json();if(!response.ok)throw new Error(data.error||"Could not start the local agent");
  state.runId=data.id;state.seenEvents.clear();pollLocalRun();
}
async function pollLocalRun(){
  if(!state.runId)return;
  try{
    const response=await fetch(`/api/runs/${state.runId}`);const run=await response.json();if(!response.ok)throw new Error(run.error||"Run unavailable");
    for(const item of run.events||[]){if(!state.seenEvents.has(item.id)){state.seenEvents.add(item.id);addStep(item.kind,item.title,item.text)}}
    if(run.waiting){setStatus("waiting","Waiting for your approval");$("approvalTitle").textContent=run.waiting.title;$("approvalText").textContent=run.waiting.detail;applyDirection($("approvalCard"),`${run.waiting.title} ${run.waiting.detail}`);$("approvalCard").hidden=false}else $("approvalCard").hidden=true;
    if(["completed","failed","stopped"].includes(run.status)){finishRun();state.runId=null;return}
    setStatus(run.status==="waiting"?"waiting":"active",run.status==="starting"?"Launching browser":"Agent is controlling Chromium");state.pollTimer=setTimeout(pollLocalRun,700);
  }catch(error){addStep("error","Runtime connection lost",error.message);finishRun();state.runId=null}
}

async function startRun(){
  if(state.running)return;const task=$("taskInput").value.trim();if(!task){toast("Describe a task first");$("taskInput").focus();return}
  state.running=true;resetRun();setStatus("active","Agent is working");
  try{
    if(state.localRuntime){if(!$("apiKey").value.trim())throw new Error("Add the selected provider's API key first.");await startLocalRun(task)}
    else if($("apiKey").value.trim())await callModel(task);else await runDemo(task);
  }catch(error){addStep("error","Could not start agent",error.message);finishRun()}
}
function setConnection(live){const badge=$("connectionBadge");badge.classList.toggle("live",live);badge.querySelector("span").textContent=live?"API connected":"Demo mode"}

$("runButton").addEventListener("click",startRun);$("taskInput").addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter")startRun()});
$("taskInput").addEventListener("input",e=>applyDirection(e.currentTarget,e.currentTarget.value));applyDirection($("taskInput"),$("taskInput").value);
$("stopButton").addEventListener("click",async()=>{state.stopped=true;state.running=false;if(state.runId)await fetch(`/api/runs/${state.runId}/stop`,{method:"POST"});if(state.pendingResolve)state.pendingResolve(false);$("approvalCard").hidden=true;if(!state.localRuntime)addStep("error","Run stopped","The run was stopped by you.");finishRun()});
async function decide(approved){if(state.runId){await fetch(`/api/runs/${state.runId}/decision`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({approved})});$("approvalCard").hidden=true;return}if(state.pendingResolve){state.pendingResolve(approved);state.pendingResolve=null;setStatus("active",approved?"Agent is working":"Finishing without that action");if(approved)addStep("browser","Action approved","Opening the shortlisted pages to verify details.")}}
$("approveButton").addEventListener("click",()=>decide(true));
$("denyButton").addEventListener("click",()=>decide(false));
$("keyToggle").addEventListener("click",()=>{const input=$("apiKey");input.type=input.type==="password"?"text":"password"});
$("themeButton").addEventListener("click",()=>document.body.classList.toggle("dark"));
$("provider").addEventListener("change",()=>{const preset=providers[$("provider").value];$("apiEndpoint").value=preset.endpoint;$("modelName").value=preset.model});
document.querySelectorAll("[data-prompt]").forEach(button=>button.addEventListener("click",()=>{$("taskInput").value=button.dataset.prompt;$("taskInput").focus()}));
$("testConnection").addEventListener("click",async()=>{if(!$("apiKey").value.trim()){toast("Add an API key to test the connection");return}toast(state.localRuntime?"Local runtime ready — provider is verified on run":"Connection will be verified on the next run")});

(async()=>{try{const response=await fetch("/api/health",{cache:"no-store"});const data=await response.json();if(data.ok){state.localRuntime=true;setConnection(true);$("connectionBadge").querySelector("span").textContent="Local agent ready"}}catch{state.localRuntime=false}})();
