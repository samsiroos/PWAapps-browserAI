import express from "express";
import { chromium } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const runs = new Map();
const PORT = Number(process.env.PORT || 3210);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "dist")));
app.get("/api/health", (_req, res) => res.json({ ok: true, runtime: "playwright", providers: ["openai", "gemini", "openrouter", "pwaapps", "custom"] }));

app.post("/api/runs", async (req, res) => {
  const { task, provider, endpoint, apiKey, model, approvalPolicy = "risky" } = req.body || {};
  if (!task || !apiKey || (!model && provider !== "pwaapps")) return res.status(400).json({ error: provider === "pwaapps" ? "Task and API key are required." : "Task, API key, and model are required." });
  const run = { id: crypto.randomUUID(), status: "starting", events: [], waiting: null, stopped: false, config: { provider, endpoint, apiKey, model, approvalPolicy } };
  runs.set(run.id, run);
  res.status(202).json({ id: run.id });
  executeRun(run, task).catch(error => fail(run, error));
});

app.get("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({ id: run.id, status: run.status, events: run.events, waiting: run.waiting && { title: run.waiting.title, detail: run.waiting.detail } });
});

app.post("/api/runs/:id/decision", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run?.waiting) return res.status(409).json({ error: "No decision is pending" });
  run.waiting.resolve(Boolean(req.body?.approved));
  run.waiting = null;
  res.json({ ok: true });
});

app.post("/api/runs/:id/stop", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  run.stopped = true;
  if (run.waiting) run.waiting.resolve(false);
  res.json({ ok: true });
});

function event(run, kind, title, text) { run.events.push({ id: crypto.randomUUID(), kind, title, text, at: Date.now() }); }
function fail(run, error) { run.status = "failed"; event(run, "error", "Agent stopped", error.message || String(error)); run.config.apiKey = ""; }

async function pageState(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    const nodes = [...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")].filter(visible).slice(0, 120);
    nodes.forEach((el, i) => el.setAttribute("data-agent-id", String(i + 1)));
    const controls = nodes.map((el, i) => ({ id: i + 1, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().slice(0, 160), value: el.value?.slice?.(0, 80) || "" }));
    return { url: location.href, title: document.title, text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 12000), controls };
  });
}

const SYSTEM = `You are an autonomous browser agent controlling Playwright. Return ONLY one JSON object per turn, no markdown. Available actions:
{"action":"navigate","url":"https://...","reason":"..."}
{"action":"click","id":12,"reason":"..."}
{"action":"type","id":4,"text":"...","reason":"..."}
{"action":"scroll","direction":"down|up","reason":"..."}
{"action":"back","reason":"..."}
{"action":"wait","ms":1500,"reason":"..."}
{"action":"ask_user","question":"..."}
{"action":"finish","answer":"..."}
Use only control IDs from the current page. Never claim an action succeeded before observing the next state. Prefer direct navigation to a search engine or known URL. Do not purchase, submit forms, log in, send messages, or expose secrets without approval. Finish with a useful concise answer and sources/URLs observed.`;

async function callLLM(config, messages) {
  const provider = config.provider || "custom";
  if (provider === "gemini") {
    const base = (config.endpoint || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
    const contents = messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const response = await fetch(`${base}/models/${encodeURIComponent(config.model)}:generateContent?key=${encodeURIComponent(config.apiKey)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents, generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }) });
    if (!response.ok) throw new Error(`Gemini API ${response.status}: ${(await response.text()).slice(0, 400)}`);
    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  }
  const defaults = { openai: "https://api.openai.com/v1", openrouter: "https://openrouter.ai/api/v1", pwaapps: "https://licence.pwaapps.com:443/airelay/api/v1" };
  const base = (config.endpoint || defaults[provider] || "").replace(/\/$/, "");
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` };
  if (provider === "openrouter") { headers["HTTP-Referer"] = `http://localhost:${PORT}`; headers["X-Title"] = "Independent Browser Agent"; }
  const requestBody = { messages: [{ role: "system", content: SYSTEM }, ...messages], temperature: 0.1, response_format: { type: "json_object" } };
  if (config.model) requestBody.model = config.model;
  const response = await fetch(`${base}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  if (!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 400)}`);
  const data = await response.json();
  return data.choices?.[0]?.message?.content || "";
}

function parseAction(raw) {
  const clean = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(clean); } catch { const match = clean.match(/\{[\s\S]*\}/); if (match) return JSON.parse(match[0]); throw new Error("Model returned invalid action JSON."); }
}
function sensitive(action, control) {
  const content = `${action.reason || ""} ${action.text || ""} ${control?.text || ""}`.toLowerCase();
  return action.action === "type" && /password|card|cvv|social security|secret|token|api key/.test(content) || action.action === "click" && /buy|purchase|pay|submit|send|delete|confirm|sign in|log in|book|order/.test(content);
}
async function approve(run, title, detail) {
  run.status = "waiting";
  const approved = await new Promise(resolve => { run.waiting = { title, detail, resolve }; });
  run.status = "running";
  event(run, approved ? "browser" : "question", approved ? "Action approved" : "Action denied", detail);
  return approved;
}

async function executeRun(run, task) {
  event(run, "plan", "Starting independent browser", "Launching a local Chromium window controlled by Playwright.");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  run.status = "running";
  const messages = [{ role: "user", content: `Task: ${task}` }];
  try {
    for (let step = 1; step <= 30 && !run.stopped; step++) {
      const state = await pageState(page);
      messages.push({ role: "user", content: `Step ${step}. Current page state:\n${JSON.stringify(state)}` });
      const raw = await callLLM(run.config, messages);
      const action = parseAction(raw);
      messages.push({ role: "assistant", content: JSON.stringify(action) });
      event(run, action.action === "finish" ? "response" : "browser", action.reason || `Step ${step}: ${action.action}`, action.answer || action.question || action.url || action.text || "");
      if (action.action === "finish") { run.status = "completed"; break; }
      if (action.action === "ask_user") { const ok = await approve(run, "Agent needs your input", action.question || "Continue?"); messages.push({ role: "user", content: ok ? "User approved/answered yes." : "User denied/answered no. Choose a safe alternative or finish." }); continue; }
      const selector = action.id ? `[data-agent-id="${Number(action.id)}"]` : null;
      const control = state.controls.find(item => item.id === Number(action.id));
      const needsApproval = run.config.approvalPolicy === "all" || (run.config.approvalPolicy === "risky" && sensitive(action, control));
      if (needsApproval && !await approve(run, `Allow ${action.action}?`, `${action.reason || "The agent requested this action"}${action.text ? ` — “${action.text.slice(0, 120)}”` : ""}`)) { messages.push({ role: "user", content: "User denied that action. Choose a safe alternative or finish." }); continue; }
      if (action.action === "navigate") await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      else if (action.action === "click" && selector) await page.locator(selector).click({ timeout: 10000 });
      else if (action.action === "type" && selector) await page.locator(selector).fill(String(action.text || ""), { timeout: 10000 });
      else if (action.action === "scroll") await page.mouse.wheel(0, action.direction === "up" ? -650 : 650);
      else if (action.action === "back") await page.goBack({ waitUntil: "domcontentloaded" });
      else if (action.action === "wait") await page.waitForTimeout(Math.min(Number(action.ms) || 1000, 10000));
      else throw new Error(`Unsupported or incomplete action: ${action.action}`);
      await page.waitForTimeout(500);
    }
    if (run.stopped) { run.status = "stopped"; event(run, "error", "Run stopped", "The user stopped this run."); }
    else if (run.status === "running") { run.status = "completed"; event(run, "response", "Step limit reached", "The agent stopped after 30 steps. Refine the request and run again if needed."); }
  } finally {
    run.config.apiKey = "";
    if (run.stopped) await browser.close();
  }
}

app.listen(PORT, "127.0.0.1", () => console.log(`Independent Browser Agent: http://localhost:${PORT}`));
