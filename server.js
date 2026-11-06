import express from "express";
import { chromium } from "playwright";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const runs = new Map();
const PORT = Number(process.env.PORT || 3210);
const db = new DatabaseSync(path.join(root, "browser-agent.sqlite"));
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, task TEXT NOT NULL, provider TEXT, endpoint TEXT, model TEXT,
  approval_policy TEXT, status TEXT NOT NULL, events_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);`);
db.prepare("UPDATE jobs SET status = 'interrupted', updated_at = ? WHERE status IN ('starting','running','waiting')").run(Date.now());

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(root, "dist")));
app.get("/api/health", (_req, res) => res.json({ ok: true, runtime: "playwright", providers: ["openai", "gemini", "openrouter", "pwaapps", "custom"] }));

app.post("/api/runs", async (req, res) => {
  const { task, provider, endpoint, apiKey, model, approvalPolicy = "risky" } = req.body || {};
  if (!task || !apiKey || (!model && provider !== "pwaapps")) return res.status(400).json({ error: provider === "pwaapps" ? "Task and API key are required." : "Task, API key, and model are required." });
  const run = { id: crypto.randomUUID(), status: "starting", events: [], waiting: null, stopped: false, config: { provider, endpoint, apiKey, model, approvalPolicy } };
  runs.set(run.id, run);
  const now = Date.now();
  db.prepare("INSERT INTO jobs (id,task,provider,endpoint,model,approval_policy,status,events_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(run.id, task, provider || "custom", endpoint || "", model || "", approvalPolicy, run.status, "[]", now, now);
  res.status(202).json({ id: run.id });
  executeRun(run, task).catch(error => fail(run, error));
});

app.get("/api/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json({ id: run.id, status: run.status, events: run.events, waiting: run.waiting && { kind: run.waiting.kind, title: run.waiting.title, detail: run.waiting.detail } });
});

app.post("/api/runs/:id/decision", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run?.waiting) return res.status(409).json({ error: "No decision is pending" });
  const answer = typeof req.body?.answer === "string" ? req.body.answer.trim() : null;
  run.waiting.resolve(answer || Boolean(req.body?.approved));
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

app.get("/api/jobs", (_req, res) => {
  const rows = db.prepare("SELECT id,task,provider,model,status,created_at,updated_at FROM jobs ORDER BY created_at DESC LIMIT 200").all();
  res.json({ jobs: rows });
});

app.get("/api/jobs/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Job not found" });
  res.json({ ...row, events: JSON.parse(row.events_json || "[]") });
});

app.delete("/api/jobs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (run && !["completed", "failed", "stopped", "interrupted"].includes(run.status)) return res.status(409).json({ error: "Stop the active job before deleting it." });
  const result = db.prepare("DELETE FROM jobs WHERE id = ?").run(req.params.id);
  runs.delete(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "Job not found" });
  res.json({ ok: true });
});

function persistRun(run) { db.prepare("UPDATE jobs SET status = ?, events_json = ?, updated_at = ? WHERE id = ?").run(run.status, JSON.stringify(run.events), Date.now(), run.id); }
function event(run, kind, title, text) { run.events.push({ id: crypto.randomUUID(), kind, title, text, at: Date.now() }); persistRun(run); }
function fail(run, error) { run.status = "failed"; event(run, "error", "Agent stopped", error.message || String(error)); run.config.apiKey = ""; persistRun(run); }

async function pageState(page) {
  return page.evaluate(() => {
    const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
    document.querySelectorAll("[data-agent-id]").forEach(el => el.removeAttribute("data-agent-id"));
    const nodes = [...document.querySelectorAll("a,button,input,textarea,select,[role=button],[contenteditable=true]")].filter(visible).slice(0, 120);
    nodes.forEach((el, i) => el.setAttribute("data-agent-id", String(i + 1)));
    const controls = nodes.map((el, i) => ({ id: i + 1, tag: el.tagName.toLowerCase(), type: el.getAttribute("type") || "", text: (el.innerText || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("name") || "").trim().slice(0, 160), value: el.value?.slice?.(0, 80) || "" }));
    return { url: location.href, title: document.title, text: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 12000), controls };
  });
}

async function safePageState(page) {
  let lastError;
  for (let attempt = 0; attempt < 6; attempt++) {
    try { return await pageState(page); }
    catch (error) {
      lastError = error;
      if (!/Execution context was destroyed|navigation|Target closed/i.test(error.message)) throw error;
      await page.waitForTimeout(600);
    }
  }
  throw lastError;
}

async function actionLocator(page, action, control) {
  if (!action.id) return null;
  let locator = page.locator(`[data-agent-id="${Number(action.id)}"]:visible`);
  if (control?.tag) {
    const tagged = page.locator(`${control.tag}[data-agent-id="${Number(action.id)}"]:visible`);
    if (await tagged.count()) locator = tagged;
  }
  const count = await locator.count();
  if (!count) throw new Error(`Control ${action.id} is no longer visible.`);
  return locator.last();
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
Use only control IDs from the current page. Never claim an action succeeded before observing the next state. Before browsing, use ask_user when one or two missing preferences would materially improve the result—for example budget, bedrooms, parking, date, location radius, or must-have features. Do not ask unnecessary questions when the task is already specific. Prefer direct navigation to a search engine or known URL. Do not purchase, submit forms, log in, send messages, or expose secrets without approval. Finish with a useful concise answer and sources/URLs observed.`;

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
  const approved = await new Promise(resolve => { run.waiting = { kind: "approval", title, detail, resolve }; });
  run.status = "running";
  event(run, approved ? "browser" : "question", approved ? "Action approved" : "Action denied", detail);
  return approved;
}

async function askUser(run, question) {
  run.status = "waiting";
  const answer = await new Promise(resolve => { run.waiting = { kind: "question", title: "Agent needs more information", detail: question, resolve }; });
  run.status = "running";
  const text = typeof answer === "string" ? answer : "No additional information provided.";
  event(run, "question", "User response", text);
  return text;
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
      const state = await safePageState(page);
      messages.push({ role: "user", content: `Step ${step}. Current page state:\n${JSON.stringify(state)}` });
      const raw = await callLLM(run.config, messages);
      const action = parseAction(raw);
      messages.push({ role: "assistant", content: JSON.stringify(action) });
      event(run, action.action === "finish" ? "response" : "browser", action.reason || `Step ${step}: ${action.action}`, action.answer || action.question || action.url || action.text || "");
      if (action.action === "finish") { run.status = "completed"; break; }
      if (action.action === "ask_user") { const answer = await askUser(run, action.question || "What additional information should I use?"); messages.push({ role: "user", content: `User answered: ${answer}` }); continue; }
      const control = state.controls.find(item => item.id === Number(action.id));
      const needsApproval = run.config.approvalPolicy === "all" || (run.config.approvalPolicy === "risky" && sensitive(action, control));
      if (needsApproval && !await approve(run, `Allow ${action.action}?`, `${action.reason || "The agent requested this action"}${action.text ? ` — “${action.text.slice(0, 120)}”` : ""}`)) { messages.push({ role: "user", content: "User denied that action. Choose a safe alternative or finish." }); continue; }
      try {
        if (action.action === "navigate") await page.goto(action.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        else if (action.action === "click" && action.id) await (await actionLocator(page, action, control)).click({ timeout: 10000 });
        else if (action.action === "type" && action.id) await (await actionLocator(page, action, control)).fill(String(action.text || ""), { timeout: 10000 });
        else if (action.action === "scroll") await page.mouse.wheel(0, action.direction === "up" ? -650 : 650);
        else if (action.action === "back") await page.goBack({ waitUntil: "domcontentloaded" });
        else if (action.action === "wait") await page.waitForTimeout(Math.min(Number(action.ms) || 1000, 10000));
        else throw new Error(`Unsupported or incomplete action: ${action.action}`);
        await page.waitForTimeout(500);
      } catch (actionError) {
        if (action.action === "navigate") {
          await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
          await page.evaluate(() => window.stop()).catch(() => {});
        }
        const detail = `${action.action} failed: ${actionError.message}`;
        event(run, "error", "Action failed — retrying", detail);
        messages.push({ role: "user", content: `${detail}. The page may have changed or the marker may be duplicated. Observe the new state and choose another control or method. Do not stop unless the task is impossible.` });
      }
    }
    if (run.stopped) { run.status = "stopped"; event(run, "error", "Run stopped", "The user stopped this run."); }
    else if (run.status === "running") { run.status = "completed"; event(run, "response", "Step limit reached", "The agent stopped after 30 steps. Refine the request and run again if needed."); }
  } finally {
    run.config.apiKey = "";
    persistRun(run);
    if (run.stopped) await browser.close();
  }
}

app.listen(PORT, "127.0.0.1", () => console.log(`PWAApps BrowserAgent: http://localhost:${PORT}`));
