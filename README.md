# Salestrail MCP Server (Node.js)

This is a rebuild of the Salestrail MCP connector using **Node.js + Express +
the official `@modelcontextprotocol/sdk`** — the same stack pattern as
`bosta-mcp` — instead of Python FastMCP.

## Why this version instead of the Python one

The Python FastMCP SDK enables Host-header validation (DNS-rebinding
protection) **by default, regardless of bind address**, which caused every
real request from Render to get rejected with `421 Misdirected Request`.

The Node SDK's `createMcpExpressApp` helper only auto-enables that protection
when binding to `localhost`/`127.0.0.1` — and Render requires binding to
`0.0.0.0` to be reachable at all. So with this stack, the problem doesn't
exist in the first place. Verified locally: a request with Render's exact
hostname in the `Host` header gets a clean `200 OK`, no special config needed.

## Tools exposed

All confirmed against Salestrail's real published API docs (call-export-controller / integration-log-export-controller):

| Tool | What it does |
|---|---|
| `list_calls` | Pulls calls in a date range — rep, numbers, duration, answered/inbound, CRM sync status, recording link. Uses `GET /export/calls/json`. |
| `get_call_recording` | Recording for a specific call by `callId`. Uses `GET /export/calls/{callId}/recording`. |
| `get_call_analytics` | Totals, answered rate, avg duration, most active hour — computed here from `list_calls` data, since Salestrail's docs don't expose a separate aggregate endpoint. |
| `get_integration_log` | CRM sync log (which calls pushed to Salesforce/HubSpot/etc. successfully vs failed, with error messages). Uses `GET /export/integration/json`. |
| `raw_request` | Escape hatch — call any Pull API path directly with auth attached, for exploring anything not wrapped above. |

**One remaining assumption:** the docs don't list query parameter names explicitly. `from`/`to` (ISO-8601) were confirmed live against `/export/calls/csv` — `/export/calls/json` is assumed to take the same params since it's the same controller. If a tool call 400s, use `raw_request` to find the exact param names and let me know.

## Files

| File | Purpose |
|---|---|
| `index.js` | The MCP server (named `index.js` because Render's Start Command on this service is set to `node index.js`) |
| `package.json` | Dependencies + start script |
| `package-lock.json` | Locked dependency versions |

## Auth — set ONE of these as env vars on Render

| Your docs show... | Set these |
|---|---|
| Bearer token / API key | `SALESTRAIL_API_KEY` |
| API key in a custom header | `SALESTRAIL_API_KEY` + `SALESTRAIL_API_KEY_HEADER` (e.g. `x-api-key`) |
| Username + password | `SALESTRAIL_BASIC_USERNAME` + `SALESTRAIL_BASIC_PASSWORD` |

Optional: `SALESTRAIL_PULL_BASE_URL` (defaults to `https://standalone-api.salestrail.io`)

Never paste real credentials into chat or this file — set them directly in
Render's Environment tab.

## Deploying to Render

1. Push this folder to your GitHub repo (replacing the old Python files, or
   as a fresh repo — your call).
2. Render dashboard → your service (or **New → Web Service** if starting
   fresh) → connect the repo.
3. **Runtime:** Node
4. **Build Command:** `npm install`
5. **Start Command:** `npm start` (or leave default — Render reads it from
   `package.json`)
6. Add the env vars from the auth table above.
7. Deploy. Your MCP endpoint is `https://<your-service>.onrender.com/mcp`.

## Connecting in Claude

Same as before:
1. **+** button → **Connectors** → **Add custom connector**
2. Paste `https://<your-service>.onrender.com/mcp`
3. Leave OAuth fields blank → **Add**
4. Enable it for the conversation via **+ → Connectors**

## Verifying it works

Ask Claude: *"use raw_request to GET /export/calls and show me the raw
response"* — confirms auth + connectivity, and shows the real response shape
so `list_calls` and `get_call_analytics` can be tightened to match.
