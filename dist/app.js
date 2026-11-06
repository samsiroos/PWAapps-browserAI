const $ = (id) => document.getElementById(id);
const state = { running: false, stopped: false, pending: null };
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
  row.querySelector("h3").textContent=title;row.querySelector("p").textContent=text;$("timeline").appendChild(row);row.scrollIntoView({behavior:"smooth",block:"nearest"});
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
    const res=await fetch(`${base}/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json","Authorization":`Bearer ${key}`},body:JSON.stringify({model,messages:[{role:"system",content:"Be concise, transparent, and safety-conscious."},{role:"user",content:prompt}],temperature:.3})});
    if(!res.ok){const detail=await res.text();throw new Error(`${res.status} ${detail.slice(0,180)}`)}
    const data=await res.json();const answer=data.choices?.[0]?.message?.content||"The model returned no text response.";
    addStep("response","Model response",answer);finishRun();setConnection(true);
  }catch(error){addStep("error","Request failed",`${error.message}\n\nCheck the endpoint, key, model name, and whether the endpoint allows browser requests (CORS).`);finishRun();setConnection(false)}
}

async function startRun(){
  if(state.running)return;const task=$("taskInput").value.trim();if(!task){toast("Describe a task first");$("taskInput").focus();return}
  state.running=true;resetRun();setStatus("active","Agent is working");
  if($("apiKey").value.trim())await callModel(task);else await runDemo(task);
}
function setConnection(live){const badge=$("connectionBadge");badge.classList.toggle("live",live);badge.querySelector("span").textContent=live?"API connected":"Demo mode"}

$("runButton").addEventListener("click",startRun);$("taskInput").addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter")startRun()});
$("stopButton").addEventListener("click",()=>{state.stopped=true;state.running=false;if(state.pendingResolve)state.pendingResolve(false);$("approvalCard").hidden=true;addStep("error","Run stopped","The run was stopped by you.");finishRun()});
$("approveButton").addEventListener("click",()=>{if(state.pendingResolve){state.pendingResolve(true);state.pendingResolve=null;setStatus("active","Agent is working");addStep("browser","Action approved","Opening the shortlisted pages to verify details.")}});
$("denyButton").addEventListener("click",()=>{if(state.pendingResolve){state.pendingResolve(false);state.pendingResolve=null;setStatus("active","Finishing without that action")}});
$("keyToggle").addEventListener("click",()=>{const input=$("apiKey");input.type=input.type==="password"?"text":"password"});
$("themeButton").addEventListener("click",()=>document.body.classList.toggle("dark"));
document.querySelectorAll("[data-prompt]").forEach(button=>button.addEventListener("click",()=>{$("taskInput").value=button.dataset.prompt;$("taskInput").focus()}));
$("testConnection").addEventListener("click",async()=>{if(!$("apiKey").value.trim()){toast("Add an API key to test the connection");return}toast("Connection will be verified on the next run")});
