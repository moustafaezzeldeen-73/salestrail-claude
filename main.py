"""
Salestrail MCP Server
======================
Exposes Salestrail's call-tracking data (Pull API) as MCP tools so Claude can
query call logs, recordings, and team performance directly.

STATUS OF EACH TOOL — read before deploying:
  - get_call_recording  -> CONFIRMED endpoint shape (Salestrail's own docs give
                           this exact path: /export/calls/{callId}/recording).
  - list_calls          -> BEST-GUESS endpoint/params. Salestrail's full Pull API
                           schema lives behind your org login at
                           https://standalone-dev.salestrail.io/integration/apidocs
                           (Dashboard -> Settings -> API Docs). I could not reach
                           that page without your login, so the path/params below
                           are an educated guess based on the public Push API
                           payload shape. Verify against your real docs and adjust
                           the constants at the top of this file if the path or
                           field names differ.
  - get_call_analytics  -> BEST-GUESS, same caveat as above.
  - raw_request         -> Escape hatch: call ANY Pull API path directly with the
                           right auth already attached. Use this immediately to
                           explore/confirm real endpoints, then tighten the
                           typed tools above once you know the real shape.

AUTH:
  Salestrail's Pull API auth scheme isn't published publicly. This server
  supports three common schemes - set ONE set of env vars on Render and the
  client will use whichever is present (checked in this order):
    1. SALESTRAIL_API_KEY            -> sent as "Authorization: Bearer <key>"
    2. SALESTRAIL_API_KEY_HEADER     -> sent as a custom header named by
       + SALESTRAIL_API_KEY               SALESTRAIL_API_KEY_HEADER (e.g. "x-api-key")
    3. SALESTRAIL_BASIC_USERNAME     -> sent as HTTP Basic auth
       + SALESTRAIL_BASIC_PASSWORD
  Check your Salestrail dashboard's API Docs page for which one is correct,
  then set the matching env vars on Render. Never put real keys in this file.
"""

import os
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings

# ---------------------------------------------------------------------------
# Configuration — verify these against your real Salestrail API docs
# ---------------------------------------------------------------------------

PULL_BASE_URL = os.environ.get("SALESTRAIL_PULL_BASE_URL", "https://standalone-api.salestrail.io")

# BEST-GUESS paths — confirm/adjust once you have the real API reference.
PATH_LIST_CALLS = os.environ.get("SALESTRAIL_PATH_LIST_CALLS", "/export/calls")
PATH_CALL_RECORDING = os.environ.get("SALESTRAIL_PATH_CALL_RECORDING", "/export/calls/{call_id}/recording")
PATH_ANALYTICS = os.environ.get("SALESTRAIL_PATH_ANALYTICS", "/export/analytics")

REQUEST_TIMEOUT_SECONDS = 30


def _build_client() -> httpx.Client:
    """Build an httpx client with whichever auth scheme is configured via env vars."""
    headers = {"Accept": "application/json"}
    auth = None

    api_key = os.environ.get("SALESTRAIL_API_KEY")
    custom_header = os.environ.get("SALESTRAIL_API_KEY_HEADER")
    basic_user = os.environ.get("SALESTRAIL_BASIC_USERNAME")
    basic_pass = os.environ.get("SALESTRAIL_BASIC_PASSWORD")

    if api_key and custom_header:
        headers[custom_header] = api_key
    elif api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    elif basic_user and basic_pass:
        auth = (basic_user, basic_pass)
    # else: no credentials configured yet — requests will likely 401, which is
    # expected until SALESTRAIL_* env vars are set on Render.

    return httpx.Client(
        base_url=PULL_BASE_URL,
        headers=headers,
        auth=auth,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )


def _request(method: str, path: str, params: Optional[dict] = None) -> dict:
    """Make a request to the Salestrail Pull API and return a normalized result."""
    with _build_client() as client:
        try:
            response = client.request(method, path, params=params)
        except httpx.RequestError as exc:
            return {"error": f"Request failed: {exc}", "path": path}

    result = {
        "status_code": response.status_code,
        "path": path,
    }
    try:
        result["data"] = response.json()
    except ValueError:
        result["data"] = response.text

    if response.status_code >= 400:
        result["error"] = (
            f"Salestrail API returned {response.status_code}. "
            "If this is a 401/403, check your SALESTRAIL_* auth env vars. "
            "If this is a 404, the path is likely wrong — verify it against "
            "your dashboard's API Docs page and update the SALESTRAIL_PATH_* "
            "env var or the constant in main.py."
        )

    return result


# ---------------------------------------------------------------------------
# MCP server + tools
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "salestrail",
    transport_security=TransportSecuritySettings(
        # The MCP SDK validates the Host header to guard against DNS-rebinding
        # attacks. Render serves this app behind a proxy using its own
        # hostname, so that hostname must be explicitly allowed here or every
        # real request gets rejected with 421 Misdirected Request.
        #
        # RENDER_EXTERNAL_HOSTNAME is set automatically by Render — no env
        # var setup needed. localhost/127.0.0.1 stay allowed for local testing.
        allowed_hosts=[
            os.environ.get("RENDER_EXTERNAL_HOSTNAME", ""),
            "localhost",
            "localhost:8000",
            "127.0.0.1",
            "127.0.0.1:8000",
        ],
        allowed_origins=["*"],
    ),
)


@mcp.tool()
def list_calls(
    start_date: str,
    end_date: str,
    user_email: Optional[str] = None,
    answered_only: Optional[bool] = None,
    inbound_only: Optional[bool] = None,
) -> dict:
    """
    Pull call log entries from Salestrail within a date range.

    BEST-GUESS ENDPOINT — verify path/params against your real Salestrail API
    docs before relying on this. If it 404s, try raw_request() to find the
    correct path first.

    Args:
        start_date: ISO 8601 date (e.g. "2026-06-01").
        end_date: ISO 8601 date (e.g. "2026-06-23").
        user_email: Optional filter to a single rep's calls.
        answered_only: If true, only answered calls. If false, only missed.
        inbound_only: If true, only inbound calls. If false, only outbound.
    """
    params = {"startDate": start_date, "endDate": end_date}
    if user_email is not None:
        params["userEmail"] = user_email
    if answered_only is not None:
        params["answered"] = str(answered_only).lower()
    if inbound_only is not None:
        params["inbound"] = str(inbound_only).lower()

    return _request("GET", PATH_LIST_CALLS, params=params)


@mcp.tool()
def get_call_recording(call_id: str) -> dict:
    """
    Get the recording link/audio reference for a specific call.

    CONFIRMED ENDPOINT SHAPE per Salestrail's published docs:
    GET /export/calls/{callId}/recording (callId is the full dashed UUID).

    Args:
        call_id: The Salestrail call UUID (with dashes), e.g.
            "900d8b36-231a-460f-b475-bc768fe8a64c".
    """
    path = PATH_CALL_RECORDING.format(call_id=call_id)
    return _request("GET", path)


@mcp.tool()
def get_call_analytics(
    start_date: str,
    end_date: str,
    user_email: Optional[str] = None,
) -> dict:
    """
    Get aggregated call performance metrics for a date range — the same kind
    of data shown on Salestrail's dashboard Overview (calls, avg duration,
    ranking, most active hour).

    BEST-GUESS ENDPOINT — verify path/params against your real Salestrail API
    docs before relying on this. If it 404s, try raw_request() to find the
    correct path first.

    Args:
        start_date: ISO 8601 date (e.g. "2026-06-01").
        end_date: ISO 8601 date (e.g. "2026-06-23").
        user_email: Optional filter to a single rep.
    """
    params = {"startDate": start_date, "endDate": end_date}
    if user_email is not None:
        params["userEmail"] = user_email

    return _request("GET", PATH_ANALYTICS, params=params)


@mcp.tool()
def raw_request(method: str, path: str, params: Optional[dict] = None) -> dict:
    """
    Call any Salestrail Pull API path directly, with auth already attached.

    Use this to explore and confirm the real API surface — e.g. once you have
    the Swagger reference open in your dashboard, try the exact paths it
    lists here to see real responses, then tell Claude to update the typed
    tools (list_calls, get_call_analytics) to match.

    Args:
        method: HTTP method, e.g. "GET".
        path: Path relative to the Pull API base URL, e.g. "/export/calls".
        params: Optional query parameters as a dict.
    """
    return _request(method.upper(), path, params=params)


# ---------------------------------------------------------------------------
# ASGI app for deployment (Render runs this via uvicorn — see Procfile)
# ---------------------------------------------------------------------------

app = mcp.streamable_http_app()

if __name__ == "__main__":
    # Local dev entrypoint
    mcp.run(transport="streamable-http")
