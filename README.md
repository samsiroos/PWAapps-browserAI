# Browser Agent Workbench

A static browser-agent interface with an OpenAI-compatible API configuration, task composer, agent activity timeline, approval flow, and final response panel.

## Run locally

Serve the repository root with any static server, or open `dist/index.html` directly.

The app starts in demo mode. Enter an API endpoint, API key, and model name to send the task directly from the browser to an OpenAI-compatible `/chat/completions` endpoint. The key is held only in page memory and is not persisted.
