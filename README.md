# PWAApps BrowserAgent

A real local browser agent with a web dashboard, Playwright-controlled Chromium, pluggable LLM providers, an activity timeline, and approval gates.

## Run locally

```powershell
npm install
npm run install-browser
npm start
```

Then open `http://localhost:3210`.

Choose OpenAI/GPT, Gemini, OpenRouter, PWAApps AI, or a custom OpenAI-compatible endpoint. Enter the provider key and model, then run a task. The local runtime opens a visible Chromium browser and executes model-selected actions. Keys remain in process memory only for the run and are cleared afterward.

PWAApps AI defaults to `https://licence.pwaapps.com:443/airelay/api/v1` and leaves the model blank so the relay selects it automatically.

The hosted version remains a dashboard/demo because hosted pages cannot control arbitrary browser tabs. Real automation is available through the local runtime.
