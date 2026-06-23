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
 * STATUS OF EACH TOOL — read before relying on a tool's output:
 *   - get_call_recording  -> CONFIRMED endpoint shape per Salestrail's own
 *                            public docs: /export/calls/{callId}/recording
 *   - list_calls           -> BEST-GUESS path/params. Salestrail's full Pull
 *                            API schema lives behind your org login at
 *                            https://standalone-dev.salestrail.io/integration/apidocs
 *                            (Dashboard -> Settings -> API Docs). Verify and
 *                            adjust SALESTRAIL_PATH_LIST_CALLS if needed.
 *   - get_call_analytics  -> BEST-GUESS, same caveat.
 *   - raw_request         -> Escape hatch: call ANY Pull API path directly
 *                            with auth already attached. Use this to confirm
 *                            real endpoints, then tighten the typed tools.
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
// Configuration — verify these against your real Salestrail API docs
// ---------------------------------------------------------------------------

const PULL_BASE_URL = process.env.SALESTRAIL_PULL_BASE_URL || "https://standalone-api.salestrail.io";

// BEST-GUESS paths — confirm/adjust once you have the real API reference.
const PATH_LIST_CALLS = process.env.SALESTRAIL_PATH_LIST_CALLS || "/export/calls";
const PATH_CALL_RECORDING = process.env.SALESTRAIL_PATH_CALL_RECORDING || "/export/calls/{call_id}/recording";
const PATH_ANALYTICS = process.env.SALESTRAIL_PATH_ANALYTICS || "/export/analytics";

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

function createServer() {
  const server = new McpServer({ name: "salestrail", version: "1.0.0" });

  server.registerTool(
    "list_calls",
    {
      title: "List calls",
      description:
        "Pull call log entries from Salestrail within a date range. BEST-GUESS " +
        "endpoint — verify path/params against your real Salestrail API docs " +
        "before relying on this. If it 404s, try raw_request first.",
      inputSchema: {
        start_date: z.string().describe('ISO 8601 date, e.g. "2026-06-01"'),
        end_date: z.string().describe('ISO 8601 date, e.g. "2026-06-23"'),
        user_email: z.string().optional().describe("Optional filter to a single rep's calls"),
        answered_only: z.boolean().optional().describe("If true, only answered calls; if false, only missed"),
        inbound_only: z.boolean().optional().describe("If true, only inbound calls; if false, only outbound"),
      },
    },
    async ({ start_date, end_date, user_email, answered_only, inbound_only }) => {
      const params = { startDate: start_date, endDate: end_date };
      if (user_email !== undefined) params.userEmail = user_email;
      if (answered_only !== undefined) params.answered = answered_only;
      if (inbound_only !== undefined) params.inbound = inbound_only;

      const result = await salestrailRequest("GET", PATH_LIST_CALLS, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
        "Get aggregated call performance metrics for a date range — the same " +
        "kind of data shown on Salestrail's dashboard Overview (calls, avg " +
        "duration, ranking, most active hour). BEST-GUESS endpoint — verify " +
        "against your real docs. If it 404s, try raw_request first.",
      inputSchema: {
        start_date: z.string().describe('ISO 8601 date, e.g. "2026-06-01"'),
        end_date: z.string().describe('ISO 8601 date, e.g. "2026-06-23"'),
        user_email: z.string().optional().describe("Optional filter to a single rep"),
      },
    },
    async ({ start_date, end_date, user_email }) => {
      const params = { startDate: start_date, endDate: end_date };
      if (user_email !== undefined) params.userEmail = user_email;

      const result = await salestrailRequest("GET", PATH_ANALYTICS, params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
