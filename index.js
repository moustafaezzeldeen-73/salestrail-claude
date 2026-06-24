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

// Some MCP clients (notably when a connector's cached tool list is stale —
// e.g. right after adding a new boolean param without the client having
// re-fetched the schema) send boolean arguments as the strings "true"/"false"
// instead of real JSON booleans, which a plain z.boolean() rejects outright.
// Confirmed live: this happened for `summary_only` immediately after adding
// it. Accepting both keeps the tool working regardless of which form the
// client happens to send.
const lenientBoolean = z.preprocess((val) => {
  if (typeof val === "string") {
    if (val.toLowerCase() === "true") return true;
    if (val.toLowerCase() === "false") return false;
  }
  return val;
}, z.boolean());
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

// All timestamps from Salestrail's API are UTC. Mustafa operates out of
// Egypt, which has changed its DST policy more than once — using the IANA
// zone name (rather than a hardcoded +2/+3 offset) means this stays correct
// automatically across any future DST changes, instead of needing a manual
// fix every time the offset shifts.
const TIMEZONE = process.env.SALESTRAIL_TIMEZONE || "Africa/Cairo";

function toLocalTimeString(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return "";
  // "2026-06-23 19:06:20 EEST" style — unambiguous about which zone/offset
  // was used, since DST means the same call could be +2 or +3 depending on
  // time of year.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "short" })
    .formatToParts(d)
    .find((p) => p.type === "timeZoneName")?.value;
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${tzName}`;
}

function localHour(isoString) {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  return parseInt(
    new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, hour: "2-digit", hour12: false }).format(d),
    10
  );
}

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
    // Binary payloads (call recordings: audio/mp4, audio/*, or a generic
    // application/octet-stream) must NOT go through response.text(). Binary
    // bytes are not valid UTF-8, so decoding them as text silently replaces
    // invalid byte sequences with U+FFFD — irreversibly corrupting the file.
    // Confirmed live against get_call_recording: the JSON-stuffed-with-text
    // approach produced unplayable garbage instead of a usable m4a. Base64
    // round-trips losslessly through JSON instead.
    const isBinary = /^(audio|video|image)\//i.test(contentType) || contentType.includes("octet-stream");

    let data;
    let isBase64 = false;
    if (isBinary) {
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
      isBase64 = true;
    } else {
      data = contentType.includes("application/json") ? await response.json() : await response.text();
    }

    // Safety cap: export endpoints (e.g. /export/calls/csv with no working
    // date filter) can return the entire call history, which can be large
    // enough to break the tool-result transport. Truncate and say so rather
    // than silently failing. Never applies to base64 binary data — slicing
    // a base64 string mid-stream corrupts it just as badly as the old text()
    // bug did, so oversized binary gets a clean error instead (see below).
    const MAX_CHARS = 20000;
    let truncated = false;
    if (typeof data === "string" && data.length > MAX_CHARS && !isBase64) {
      data = data.slice(0, MAX_CHARS);
      truncated = true;
    }

    // Generous cap (~6MB raw / ~8M base64 chars) — comfortably covers typical
    // sales-call recordings while still protecting the tool-result transport
    // from an unexpectedly huge file.
    const MAX_BASE64_CHARS = 8_000_000;
    if (isBase64 && data.length > MAX_BASE64_CHARS) {
      return {
        status_code: response.status,
        path: url.pathname + "?" + url.searchParams.toString(),
        error:
          `Recording is ~${Math.round(data.length / 1024)}KB base64-encoded, too large for a single tool ` +
          "result. This file can't be returned through this tool — use the direct recUrl instead.",
      };
    }

    const result = {
      status_code: response.status,
      path: url.pathname + "?" + url.searchParams.toString(),
      data,
      ...(isBase64 && { encoding: "base64", content_type: contentType }),
    };
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
// Full call objects (with userTeams, recUrl, etc.) use the lower default;
// summary_only mode strips those fields, so it's safe to allow a larger
// budget there and still stay well clear of the size that originally broke
// the transport (~286KB).
const MAX_OUTPUT_CHARS_DEFAULT = 15000;
const MAX_OUTPUT_CHARS_SUMMARY = 50000;

function buildCappedResult(allItems, requestedCap, itemsKey, extraFields = {}, maxChars = MAX_OUTPUT_CHARS_DEFAULT) {
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
    if (text.length <= maxChars || count <= 1) {
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
        phone_number: z
          .string()
          .optional()
          .describe(
            "Optional filter to calls involving this phone number (matches either local or +country-code format, " +
              'e.g. "01050008847" matches a call stored as "+201050008847")'
          ),
        answered_only: lenientBoolean.optional().describe("If true, only answered calls; if false, only missed"),
        inbound_only: lenientBoolean.optional().describe("If true, only inbound calls; if false, only outbound"),
        summary_only: lenientBoolean
          .optional()
          .describe(
            "If true, return only number/formattedNumber/startTime/answered/inbound/duration per call " +
              "(drops userTeams, recUrl, source, etc.). Much smaller per-call size, so far more calls fit in " +
              "one response before the size cap kicks in — use this for bulk cross-referencing (e.g. 'which of " +
              "these phone numbers got called today'), and the full mode only when you need recording links or " +
              "CRM integration status for specific calls."
          ),
        max_rows: z.number().optional().describe("Cap on rows returned (default 200) to avoid huge responses"),
      },
    },
    async ({
      start_date,
      end_date,
      filter_by,
      user_email,
      phone_number,
      answered_only,
      inbound_only,
      summary_only,
      max_rows,
    }) => {
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
      if (phone_number !== undefined) {
        // Normalize by stripping everything but digits, then compare the
        // last 9 digits — long enough to be specific, short enough to
        // ignore +20/0/leading-zero country-code formatting differences
        // between what's stored (e.g. "+201050008847") and what's searched
        // for (e.g. "01050008847").
        const normalize = (s) => (s || "").replace(/\D/g, "").slice(-9);
        const target = normalize(phone_number);
        calls = calls.filter(
          (c) => normalize(c.number) === target || normalize(c.formattedNumber) === target
        );
      }
      if (answered_only !== undefined) {
        calls = calls.filter((c) => c.answered === answered_only);
      }
      if (inbound_only !== undefined) {
        calls = calls.filter((c) => c.inbound === inbound_only);
      }

      // startTime/createdAt from Salestrail are UTC. Add a local-time
      // field alongside the original so times match what actually shows
      // on the phone/dashboard (e.g. 16:06 UTC -> 19:06 Cairo in summer).
      calls = calls.map((c) => ({
        ...c,
        startTimeLocal: toLocalTimeString(c.startTime),
        createdAtLocal: toLocalTimeString(c.createdAt),
      }));

      if (summary_only) {
        calls = calls.map((c) => ({
          number: c.number,
          formattedNumber: c.formattedNumber,
          startTime: c.startTime,
          startTimeLocal: c.startTimeLocal,
          answered: c.answered,
          inbound: c.inbound,
          duration: c.duration,
        }));
      }

      const cap = max_rows ?? 80;
      const text = buildCappedResult(
        calls,
        cap,
        "calls",
        { status_code: raw.status_code, timezone: TIMEZONE },
        summary_only ? MAX_OUTPUT_CHARS_SUMMARY : MAX_OUTPUT_CHARS_DEFAULT
      );
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

      if (result.encoding === "base64" && result.status_code < 400) {
        // Salestrail's recording content-type has been observed as a generic
        // application/octet-stream rather than a specific audio/* type, so
        // fall back to audio/mp4 (the container for .m4a, the recType seen
        // on calls so far) when the header doesn't give us anything useful.
        const mimeType =
          result.content_type && !result.content_type.includes("octet-stream")
            ? result.content_type
            : "audio/mp4";
        // NOTE: this was originally an MCP "audio" content block, which is
        // the semantically correct type — but confirmed live that at least
        // one real MCP client (Claude's claude.ai chat client) strips audio
        // blocks before they reach the model, replacing them with a "not
        // currently supported" notice. A "text" block containing the same
        // base64 payload as JSON is universally supported (text is always
        // renderable) and just as lossless, since base64 is plain ASCII —
        // the original corruption bug was from decoding raw, un-encoded
        // binary as UTF-8 text, not from carrying an already-base64 string
        // inside a text block. This also makes the payload directly
        // chainable into another tool's base64 audio input (e.g. a
        // transcription tool) without any client-side audio support.
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status_code: result.status_code,
                call_id,
                mime_type: mimeType,
                encoding: "base64",
                data: result.data,
              }),
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: result.status_code >= 400 || Boolean(result.error),
      };
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
        const hour = localHour(c.startTime);
        if (hour === null) continue;
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
      }
      const mostActiveHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0];

      const result = {
        date_range: { from: start_date, to: end_date },
        timezone: TIMEZONE,
        user_email: user_email ?? "all",
        total_calls: calls.length,
        answered: answered.length,
        missed: calls.length - answered.length,
        answered_rate: calls.length ? Math.round((answered.length / calls.length) * 1000) / 10 : 0,
        inbound: inbound.length,
        outbound: outbound.length,
        avg_duration_seconds_answered: answered.length ? Math.round(totalDuration / answered.length) : 0,
        total_talk_time_seconds: totalDuration,
        most_active_hour_local: mostActiveHour !== undefined ? `${mostActiveHour}:00` : null,
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
      const entries = raw.data.map((e) => ({
        ...e,
        callStartTimeLocal: toLocalTimeString(e.callStartTime),
        integrationLogCreatedLocal: toLocalTimeString(e.integrationLogCreated),
        integrationLogUpdatedLocal: toLocalTimeString(e.integrationLogUpdated),
      }));
      const text = buildCappedResult(entries, cap, "entries", { status_code: raw.status_code, timezone: TIMEZONE });
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
