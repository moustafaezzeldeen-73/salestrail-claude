# Salestrail MCP Server

Exposes Salestrail call-tracking data as MCP tools so Claude can query call
logs, recordings, and team analytics on demand.

## What's in here

| File | Purpose |
|---|---|
| `main.py` | The MCP server — 4 tools (see below) |
| `requirements.txt` | Python deps |
| `Procfile` | Tells Render how to run it |

## Tools exposed

| Tool | Status | What it does |
|---|---|---|
| `get_call_recording` | **Confirmed** | Fetch the recording for a call by `callId`. Path is taken directly from Salestrail's public docs. |
| `list_calls` | Best-guess | Pull call logs by date range / rep / answered status. Path and param names are a reasonable guess — **verify against your real docs** (see below). |
| `get_call_analytics` | Best-guess | Aggregated metrics (calls, avg duration, ranking) — same data as the dashboard Overview. Also a guess. |
| `raw_request` | Always works | Hit any Pull API path directly with auth already attached. Use this to discover the real endpoints. |

I could not reach your account's real API reference
(`https://standalone-dev.salestrail.io/integration/apidocs`) since it's
behind your org login. The two "best-guess" tools will most likely 404 until
you correct the path. That's expected — fix it with the two steps below.

## Step 1 — Get your real API reference

1. Log into your Salestrail dashboard.
2. Go to **Settings → API Docs**.
3. Open the Swagger/API reference page and copy the real path + query params
   for "list calls" and "analytics" (or whatever they're named there).
4. Either:
   - Paste those into chat with Claude and ask it to update `main.py`, or
   - Set them directly as env vars on Render (no redeploy needed):
     - `SALESTRAIL_PATH_LIST_CALLS` (default `/export/calls`)
     - `SALESTRAIL_PATH_ANALYTICS` (default `/export/analytics`)

You can also just call `raw_request` from Claude right away to probe paths
without touching any code.

## Step 2 — Set your credentials on Render

Salestrail's exact Pull API auth scheme isn't published outside your account.
Check the API Docs page for which of these applies, then set the matching
env vars on Render (**Render dashboard → your service → Environment**, never
in chat or in this code):

| If your docs show... | Set these env vars |
|---|---|
| A Bearer token / API key | `SALESTRAIL_API_KEY` |
| An API key in a custom header (e.g. `x-api-key`) | `SALESTRAIL_API_KEY` + `SALESTRAIL_API_KEY_HEADER` (e.g. `x-api-key`) |
| Username + password (Basic auth) | `SALESTRAIL_BASIC_USERNAME` + `SALESTRAIL_BASIC_PASSWORD` |

Optional:
- `SALESTRAIL_PULL_BASE_URL` — defaults to `https://standalone-api.salestrail.io`

## Deploying to Render

1. Push this folder to a GitHub repo (same pattern as `oka-meta-mcp`).
2. In Render: **New → Web Service**, connect the repo.
3. Build command: `pip install -r requirements.txt`
4. Start command: leave default (uses `Procfile`).
5. Add the env vars from Step 2 above.
6. Deploy. The MCP endpoint will be at `https://<your-service>.onrender.com/mcp`.
7. Add/update the connector in Claude with that URL.

## Testing once deployed

Ask Claude something like:
- "Use raw_request to GET /export/calls with no params and show me the raw response" — confirms auth is wired correctly and shows you the real response shape.
- Once you see real field names, ask Claude to tighten `list_calls` and `get_call_analytics` to match exactly.
