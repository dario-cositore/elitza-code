"""MCP (Model Context Protocol) client for Elitza Agent.

Supports the legacy SSE transport used by mcp.dariocositore.com:
  - Server pushes responses through the SSE stream
  - We send requests via POST to /message?session_id=...
  - Or the server may push responses directly after connection

Usage:
    client = MCPClient(base_url="https://mcp.dariocositore.com")
    client.connect("dario_hub")
    tools = client.list_tools()
    result = client.call_tool("tool_name", {"key": "value"})
    client.close()
"""

import json
import logging
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


class MCPError(Exception):
    pass


class MCPClient:
    """MCP client using the legacy SSE transport."""

    def __init__(
        self,
        base_url: str,
        auth_token: str = "",
        connect_timeout: float = 0,
        request_timeout: float = 0,
    ):
        self.base_url = base_url.rstrip("/")
        self.auth_token = auth_token
        self.connect_timeout = connect_timeout
        self.request_timeout = request_timeout

        self._session_id: Optional[str] = None
        self._tools: List[Dict[str, Any]] = []
        self._connected = False
        self._sse_thread: Optional[threading.Thread] = None
        self._sse_response: Optional[httpx.Response] = None

        # Pending RPC calls: id -> threading.Event, result
        self._pending: Dict[Any, tuple] = {}
        self._lock = threading.Lock()

        # Buffer for early SSE messages (before pending is registered)
        self._early_messages: Dict[Any, Dict] = {}
        self._early_lock = threading.Lock()

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def tools(self) -> List[Dict[str, Any]]:
        return list(self._tools)

    def connect(self, connector_id: str) -> List[Dict[str, Any]]:
        """Connect to an MCP connector and discover tools."""
        sse_url = f"{self.base_url}/{connector_id}/sse"
        logger.info("Connecting to MCP server: %s", sse_url)

        # Start SSE listener in background thread
        self._sse_thread = threading.Thread(
            target=self._listen_sse,
            args=(sse_url,),
            daemon=True,
        )
        self._sse_thread.start()

        # Wait for session establishment (endpoint event)
        if self.connect_timeout > 0:
            deadline = time.monotonic() + self.connect_timeout
            while time.monotonic() < deadline:
                if self._session_id:
                    break
                time.sleep(0.1)
            else:
                self.close()
                raise MCPError(
                    f"Timed out connecting to {sse_url} "
                    f"(no session established within {self.connect_timeout}s)"
                )
        else:
            while not self._session_id:
                time.sleep(0.1)

        # Initialize the MCP session
        init_result = self._rpc_call("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "elitza-agent", "version": "0.1.0"},
        }, msg_id=0)

        logger.info(
            "MCP initialized: server=%s %s",
            init_result.get("serverInfo", {}).get("name", "?"),
            init_result.get("serverInfo", {}).get("version", "?"),
        )

        # List available tools
        tools_result = self._rpc_call("tools/list", {}, msg_id=1)
        self._tools = tools_result.get("tools", [])
        self._connected = True

        logger.info(
            "MCP connected: %d tools from '%s'",
            len(self._tools), connector_id,
        )
        return self._tools

    def call_tool(self, tool_name: str, arguments: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Call a tool on the MCP server."""
        if not self._connected:
            raise MCPError("Not connected. Call connect() first.")
        return self._rpc_call("tools/call", {
            "name": tool_name,
            "arguments": arguments or {},
        })

    def close(self):
        """Close the MCP connection."""
        self._connected = False
        with self._lock:
            for msg_id, (event, _) in list(self._pending.items()):
                self._pending[msg_id] = (event, {"error": "Connection closed"})
                event.set()
        if self._sse_response is not None:
            try:
                self._sse_response.close()
            except Exception:
                pass
            self._sse_response = None
        logger.debug("MCP connection closed")

    # -- internal ---------------------------------------------------------

    def _listen_sse(self, sse_url: str):
        """Background thread: listen for SSE events."""
        headers = {"Accept": "text/event-stream"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        try:
            with httpx.Client(timeout=httpx.Timeout(None)) as client:
                with client.stream("GET", sse_url, headers=headers) as resp:
                    self._sse_response = resp
                    event_type = ""
                    event_data = ""

                    for line in resp.iter_lines():
                        if not line:
                            if event_type and event_data:
                                self._handle_sse_event(event_type, event_data)
                            event_type = ""
                            event_data = ""
                            continue

                        if line.startswith("event:"):
                            event_type = line[len("event:"):].strip()
                        elif line.startswith("data:"):
                            event_data = line[len("data:"):].strip()

                    logger.debug("SSE stream ended")

        except Exception as e:
            if self._connected or self._session_id is None:
                logger.error("SSE listener error: %s", e)

    def _handle_sse_event(self, event_type: str, event_data: str):
        if event_type == "endpoint":
            self._handle_endpoint(event_data)
        elif event_type == "message":
            self._handle_message(event_data)
        elif event_type == "ping":
            pass

    def _handle_endpoint(self, endpoint_data: str):
        from urllib.parse import parse_qs, urlparse
        parsed = urlparse(endpoint_data)
        params = parse_qs(parsed.query)
        session_ids = params.get("session_id", [])
        if session_ids:
            self._session_id = session_ids[0]
        logger.debug("MCP session_id: %s", self._session_id)

    def _handle_message(self, data: str):
        try:
            msg = json.loads(data)
        except json.JSONDecodeError:
            logger.warning("Invalid JSON in SSE message: %s", data[:200])
            return

        msg_id = msg.get("id")
        if msg_id is not None:
            # Try to deliver to pending call
            with self._lock:
                if msg_id in self._pending:
                    event, _ = self._pending.pop(msg_id)
                    self._pending[msg_id] = (event, msg)
                    event.set()
                else:
                    # No pending call yet -- buffer it
                    with self._early_lock:
                        self._early_messages[msg_id] = msg
        else:
            logger.debug("Server notification: %s", msg.get("method", "?"))

    def _rpc_call(self, method: str, params: Dict, msg_id: Any = None) -> Dict:
        """Send an MCP request and wait for the response via SSE."""
        if msg_id is None:
            msg_id = str(uuid.uuid4())[:8]

        # Check if the response already arrived (race condition)
        with self._early_lock:
            if msg_id in self._early_messages:
                result = self._early_messages.pop(msg_id)
                if "error" in result:
                    err = result["error"]
                    raise MCPError(f"MCP error: {err.get('message', err)}")
                return result.get("result", {})

        # Register pending call
        event = threading.Event()
        with self._lock:
            self._pending[msg_id] = (event, None)

        # Send the request via POST
        if not self._session_id:
            raise MCPError("No session ID available")

        message_url = f"{self.base_url}/message"
        payload = {
            "jsonrpc": "2.0",
            "id": msg_id,
            "method": method,
            "params": params,
        }

        headers = {"Content-Type": "application/json"}
        if self.auth_token:
            headers["Authorization"] = f"Bearer {self.auth_token}"

        logger.debug("MCP POST %s (id=%s)", method, msg_id)

        try:
            req_timeout = httpx.Timeout(None) if self.request_timeout <= 0 else httpx.Timeout(self.request_timeout)
            with httpx.Client(timeout=req_timeout) as client:
                resp = client.post(
                    message_url,
                    json=payload,
                    headers=headers,
                    params={"session_id": self._session_id},
                )

            if resp.status_code == 401:
                raise MCPError("MCP authentication required (401)")
            if resp.status_code == 404:
                raise MCPError(f"MCP session not found (404): {self._session_id}")
            if resp.status_code not in (200, 202):
                raise MCPError(f"MCP server error ({resp.status_code}): {resp.text[:500]}")

        except httpx.TimeoutException:
            with self._lock:
                self._pending.pop(msg_id, None)
            raise MCPError(f"MCP request timed out ({method})")

        # Wait for the response to arrive via SSE
        wait_timeout = None if self.request_timeout <= 0 else self.request_timeout
        if not event.wait(timeout=wait_timeout):
            with self._lock:
                self._pending.pop(msg_id, None)
            raise MCPError(f"MCP response timeout ({method})")

        with self._lock:
            _, result = self._pending.pop(msg_id, (None, None))

        if result is None:
            raise MCPError(f"No response received for {method}")

        if "error" in result:
            err = result["error"]
            raise MCPError(f"MCP error: {err.get('message', err)}")

        return result.get("result", {})


def connect_mcp(
    base_url: str,
    connector_id: str,
    auth_token: str = "",
    timeout: float = 30.0,
) -> MCPClient:
    """Convenience: connect to an MCP server and return a ready client."""
    client = MCPClient(base_url=base_url, auth_token=auth_token, request_timeout=timeout)
    client.connect(connector_id)
    return client
