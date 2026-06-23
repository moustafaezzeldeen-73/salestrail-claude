/**
 * Salestrail MCP Server (Node.js / Express)
 * ==========================================
 * Built with the official @modelcontextprotocol/sdk + Express, the same
 * stack pattern as bosta-mcp — instead of the Python FastMCP SDK used in
 * the earlier version, which had host-header DNS-rebinding protection
 * enabled by default regardless of bind address (causing 421 errors on
 * Render). The Node SDK only enables that protection automatically when
 * binding to localhost — Render requires binding to 0.0.0.0, so this
 * server never hits that issue in the first place.
 *
 * API SURFACE — confirmed against Salestrail's real Swagger docs
 * (call-export-controller / integration-log-export-controller):
 *   GET /export/calls/json              -> CallData[]   (used by list_calls)
 *   GET /export/calls/byCreated/json     -> CallData[]   (filter by record
 *                                           creation time instead of call
 *                                           start time — same shape)
 *   GET /export/calls/csv                -> tab-separated text, same fields
 *   GET /export/calls/{callId}/recording -> the call's recording (CONFIRMED,
 *                                           used by get_call_recording)
 *   GET /export/integration/json         -> IntegrationData[] (CRM sync log,
 *                                           used by get_integration_log)
 *
 * CallData fields (confirmed): answered, callId, createdAt, duration,
 * formattedNumber, inbound, integrated, number, phonebookName, recType,
 * recUrl, source, sourceDetail, startTime, userEmail, userId, userName,
 * userPhone, userTeams[].
 *
 * REMAINING ASSUMPTION: the docs don't list query parameters explicitly.
 * `from`/`to` were confirmed live against /export/calls/csv (the error
 * message named the param "from" as a required Instant). /export/calls/json
 * is assumed to take the same from/to params since it's the same controller
 * — if a tool call 400s on this, try raw_request to find the exact names.
 *
 * There is NO separate analytics/aggregate endpoint in the docs — anything
 * dashboard-Overview-like (totals, averages, most active hour) is computed
 * client-side in get_call_analytics from list_calls data, not from a
 * dedicated Salestrail endpoint.
 *
 * AUTH:
 *   Salestrail's Pull API auth scheme isn't published publicly. Set ONE of
 *   these on Render — whichever matches what your dashboard's API Docs page
 *   shows:
 *     1. SALESTRAIL_API_KEY                          -> "Authorization: Bearer <key>"
 *     2. SALESTRAIL_API_KEY + SALESTRAIL_API_KEY_HEADER -> custom header
 *     3. SALESTRAIL_BASIC_USERNAME + SALESTRAIL_BASIC_PASSWORD -> HTTP Basic auth
 *   Never put real keys in this file — set them as env vars on Render.
 */

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ---------------------------------------------------------------------------
// Configuration — confirmed against Salestrail's real Swagger docs
// ---------------------------------------------------------------------------

const PULL_BASE_URL = process.env.SALESTRAIL_PULL_BASE_URL || "https://standalone-api.salestrail.io";

const PATH_LIST_CALLS_JSON = process.env.SALESTRAIL_PATH_LIST_CALLS_JSON || "/export/calls/json";
const PATH_LIST_CALLS_BY_CREATED_JSON =
  process.env.SALESTRAIL_PATH_LIST_CALLS_BY_CREATED_JSON || "/export/calls/byCreated/json";
const PATH_CALL_RECORDING = process.env.SALESTRAIL_PATH_CALL_RECORDING || "/export/calls/{call_id}/recording";
const PATH_INTEGRATION_LOG = process.env.SALESTRAIL_PATH_INTEGRATION_LOG || "/export/integration/json";

const REQUEST_TIMEOUT_MS = 30_000;

function buildAuthHeaders() {
  // Use */* rather than application/json: Salestrail's export endpoints
  // (e.g. /export/calls/csv) only produce CSV and reject a strict JSON
  // Accept header with 406 Not Acceptable. The response parser below already
  // falls back to plain text for non-JSON content types.
  const headers = { Accept: "*/*" };
  const apiKey = process.env.SALESTRAIL_API_KEY;
  const customHeader = process.env.SALESTRAIL_API_KEY_HEADER;
  const basicUser = process.env.SALESTRAIL_BASIC_USERNAME;
  const basicPass = process.env.SALESTRAIL_BASIC_PASSWORD;

  if (apiKey && customHeader) {
    headers[customHeader] = apiKey;
  } else if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else if (basicUser && basicPass) {
    headers["Authorization"] = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString("base64")}`;
  }
  // else: no credentials configured yet — requests will likely 401, which is
  // expected until SALESTRAIL_* env vars are set on Render.

  return headers;
}

async function salestrailRequest(method, path, params) {
  const url = new URL(path, PULL_BASE_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: buildAuthHeaders(),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    let data = contentType.includes("application/json") ? await response.json() : await response.text();

    // Safety cap: export endpoints (e.g. /export/calls/csv with no working
    // date filter) can return the entire call history, which can be large
    // enough to break the tool-result transport. Truncate and say so rather
    // than silently failing.
    const MAX_CHARS = 20000;
    let truncated = false;
    if (typeof data === "string" && data.length > MAX_CHARS) {
      data = data.slice(0, MAX_CHARS);
      truncated = true;
    }

    const result = { status_code: response.status, path: url.pathname + "?" + url.searchParams.toString(), data };
    if (truncated) {
      result.truncated = true;
      result.note = `Response body truncated to ${MAX_CHARS} characters to stay within tool-result size limits. Use date-range params or a narrower path to get a smaller result.`;
    }

    if (response.status >= 400) {
      result.error =
        `Salestrail API returned ${response.status}. ` +
        "If this is a 401/403, check your SALESTRAIL_* auth env vars. " +
        "If this is a 404, the path is likely wrong — verify it against " +
        "your dashboard's API Docs page and update the matching " +
        "SALESTRAIL_PATH_* env var.";
    }

    return result;
  } catch (err) {
    return { error: `Request failed: ${err.message}`, path };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

// Safe budget for a tool result's stringified size. The earlier truncation
// in salestrailRequest only applies to raw string responses (e.g. CSV) — it
// never fires for /export/calls/json, since that response is already a
// parsed array by the time it gets here. A busy date range can return 150+
// call objects (each with nested userTeams), producing output large enough
// to break the tool-result transport. This guards against that directly on
// the final stringified output, regardless of which endpoint was used.
const MAX_OUTPUT_CHARS = 15000;

function buildCappedResult(allItems, requestedCap, itemsKey, extraFields = {}) {
  const totalMatching = allItems.length;
  let count = Math.min(requestedCap, totalMatching);
  let text;
  while (true) {
    const slice = allItems.slice(0, count);
    const truncated = count < totalMatching;
    const result = {
      total_matching: totalMatching,
      returned: slice.length,
      truncated,
      ...extraFields,
      [itemsKey]: slice,
    };
    if (truncated) {
      result.note = `Showing first ${slice.length} of ${totalMatching} matching. Narrow the date range for a more complete view — results are capped here to stay within response size limits.`;
    }
    text = JSON.stringify(result, null, 2);
    if (text.length <= MAX_OUTPUT_CHARS || count <= 1) {
      return text;
    }
    count = Math.max(1, Math.floor(count / 2));
  }
}

function createServer() {
  const server = new McpServer({ name: "salestrail", version: "1.0.0" });

  server.registerTool(
    "list_calls",
    {
      title: "List calls",
      description:
        "Pull call log entries from Salestrail within a date range — rep " +
        "name/email, phone numbers, duration, answered/inbound flags, CRM " +
        "integration status, and a direct recording link per call where " +
        "available. CONFIRMED endpoint per Salestrail's published API docs " +
        "(GET /export/calls/json).",
      inputSchema: {
        start_date: z.string().describe('ISO 8601 datetime, e.g. "2026-06-01T00:00:00Z"'),
        end_date: z.string().describe('ISO 8601 datetime, e.g. "2026-06-23T23:59:59Z"'),
        filter_by: z
          .enum(["startTime", "createdAt"])
          .optional()
          .describe(
            "Whether the date range filters by when the call happened (startTime, default) or when the " +
              "record was created in Salestrail's system (createdAt) — only differs for delayed/retroactive syncs."
          ),
        user_email: z.string().optional().describe("Optional filter to a single rep's calls"),
        answered_only: z.boolean().optional().describe("If true, only answered calls; if false, only missed"),
        inbound_only: z.boolean().optional().describe("If true, only inbound calls; if false, only outbound"),
        max_rows: z.number().optional().describe("Cap on rows returned (default 200) to avoid huge responses"),
      },
    },
    async ({ start_date, end_date, filter_by, user_email, answered_only, inbound_only, max_rows }) => {
      const path = filter_by === "createdAt" ? PATH_LIST_CALLS_BY_CREATED_JSON : PATH_LIST_CALLS_JSON;
      const params = { from: start_date, to: end_date };
      const raw = await salestrailRequest("GET", path, params);

      if (raw.error || !Array.isArray(raw.data)) {
        return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
      }

      let calls = raw.data;
      if (user_email !== undefined) {
        calls = calls.filter((c) => c.userEmail === user_email);
      }
      if (answered_only !== undefined) {
        calls = calls.filter((c) => c.answered === answered_only);
      }
      if (inbound_only !== undefined) {
        calls = calls.filter((c) => c.inbound === inbound_only);
      }

      const cap = max_rows ?? 80;
      const text = buildCappedResult(calls, cap, "calls", { status_code: raw.status_code });
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "get_call_recording",
    {
      title: "Get call recording",
      description:
        "Get the recording link/audio reference for a specific call. CONFIRMED " +
        "endpoint shape per Salestrail's published docs: " +
        "GET /export/calls/{callId}/recording (callId is the full dashed UUID).",
      inputSchema: {
        call_id: z.string().describe(
          'The Salestrail call UUID with dashes, e.g. "900d8b36-231a-460f-b475-bc768fe8a64c"'
        ),
      },
    },
    async ({ call_id }) => {
      const path = PATH_CALL_RECORDING.replace("{call_id}", encodeURIComponent(call_id));
      const result = await salestrailRequest("GET", path);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_call_analytics",
    {
      title: "Get call analytics",
      description:
        "Aggregated call performance metrics for a date range — totals, " +
        "answered rate, average duration, inbound/outbound split, and most " +
        "active hour — the same kind of data shown on Salestrail's dashboard " +
        "Overview. NOTE: Salestrail's API docs don't expose a separate " +
        "analytics endpoint, so this is computed here from the same data as " +
        "list_calls rather than a dedicated Salestrail aggregate endpoint.",
      inputSchema: {
        start_date: z.string().describe('ISO 8601 datetime, e.g. "2026-06-01T00:00:00Z"'),
        end_date: z.string().describe('ISO 8601 datetime, e.g. "2026-06-23T23:59:59Z"'),
        user_email: z.string().optional().describe("Optional filter to a single rep"),
      },
    },
    async ({ start_date, end_date, user_email }) => {
      const raw = await salestrailRequest("GET", PATH_LIST_CALLS_JSON, { from: start_date, to: end_date });

      if (raw.error || !Array.isArray(raw.data)) {
        return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
      }

      const calls = user_email !== undefined ? raw.data.filter((c) => c.userEmail === user_email) : raw.data;

      const answered = calls.filter((c) => c.answered);
      const inbound = calls.filter((c) => c.inbound);
      const outbound = calls.filter((c) => !c.inbound);
      const totalDuration = answered.reduce((sum, c) => sum + (c.duration || 0), 0);

      const hourCounts = {};
      for (const c of calls) {
        if (!c.startTime) continue;
        const hour = new Date(c.startTime).getUTCHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
      const mostActiveHourUtc = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      const result = {
        date_range: { from: start_date, to: end_date },
        user_email: user_email ?? "all",
        total_calls: calls.length,
        answered: answered.length,
        missed: calls.length - answered.length,
        answered_rate: calls.length ? Math.round((answered.length / calls.length) * 1000) / 10 : 0,
        inbound: inbound.length,
        outbound: outbound.length,
        avg_duration_seconds_answered: answered.length ? Math.round(totalDuration / answered.length) : 0,
        total_talk_time_seconds: totalDuration,
        most_active_hour_utc: mostActiveHourUtc !== undefined ? `${mostActiveHourUtc}:00` : null,
      };

      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.registerTool(
    "get_integration_log",
    {
      title: "Get CRM integration log",
      description:
        "Get the CRM integration sync log — which calls were successfully " +
        "pushed to your connected CRM (Salesforce/HubSpot/etc.) vs failed, " +
        "with error messages for failures. CONFIRMED endpoint per Salestrail's " +
        "published API docs (GET /export/integration/json).",
      inputSchema: {
        start_date: z.string().optional().describe('Optional ISO 8601 datetime filter, e.g. "2026-06-01T00:00:00Z"'),
        end_date: z.string().optional().describe('Optional ISO 8601 datetime filter, e.g. "2026-06-23T23:59:59Z"'),
        max_rows: z.number().optional().describe("Cap on rows returned (default 200)"),
      },
    },
    async ({ start_date, end_date, max_rows }) => {
      const params = {};
      if (start_date !== undefined) params.from = start_date;
      if (end_date !== undefined) params.to = end_date;

      const raw = await salestrailRequest("GET", PATH_INTEGRATION_LOG, params);

      if (raw.error || !Array.isArray(raw.data)) {
        return { content: [{ type: "text", text: JSON.stringify(raw, null, 2) }] };
      }

      const cap = max_rows ?? 80;
      const text = buildCappedResult(raw.data, cap, "entries", { status_code: raw.status_code });
      return { content: [{ type: "text", text }] };
    }
  );

  server.registerTool(
    "raw_request",
    {
      title: "Raw Salestrail API request",
      description:
        "Call any Salestrail Pull API path directly, with auth already " +
        "attached. Use this to explore and confirm the real API surface — " +
        "once you have the Swagger reference open in your dashboard, try the " +
        "exact paths it lists here to see real responses.",
      inputSchema: {
        method: z.string().describe('HTTP method, e.g. "GET"'),
        path: z.string().describe('Path relative to the Pull API base URL, e.g. "/export/calls"'),
        params: z.record(z.string(), z.any()).optional().describe("Optional query parameters as an object"),
      },
    },
    async ({ method, path, params }) => {
      const result = await salestrailRequest(method.toUpperCase(), path, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// Express app — stateful Streamable HTTP transport, one session per client
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

// Simple request logging so Render's Logs tab actually shows what's
// happening — without this, failed or successful requests are invisible.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// No host-header allowlist is configured here: this server binds to 0.0.0.0
// (required by Render) and the SDK only auto-enables DNS-rebinding
// protection for localhost binds, so no 421 errors occur. This is fine for
// a single-user private connector reached only over HTTPS by Claude.

// Stateless mode: every request gets a fresh transport + server instance.
// No session state is kept across requests, so there's nothing to go stale
// when Render redeploys or restarts the process — each tool call is fully
// self-contained, which matches what these tools actually need (simple,
// independent API calls with no server-initiated notifications).
app.post("/mcp", async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: `Internal server error: ${err.message}` },
      });
    }
  }
});

// GET/DELETE are only meaningful for session-based (stateful) servers —
// this server doesn't use sessions, so there's nothing to resume or close.
app.get("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Method not allowed: this server runs in stateless mode." },
  });
});
app.delete("/mcp", (req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    id: null,
    error: { code: -32000, message: "Method not allowed: this server runs in stateless mode." },
  });
});

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "salestrail-mcp", endpoint: "/mcp" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Salestrail MCP server listening on 0.0.0.0:${PORT}`);
});
