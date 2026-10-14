"""MCP tool bridge: connects to MCP servers and registers their tools
into Elitza's tool registry so the agent can call them transparently.

Each MCP tool gets a schema like: mcp_{connector_id}_{tool_name}

Usage:
    # In cli.py or agent setup:
    mcp_servers = [
        {"base_url": "https://mcp.dariocositore.com", "connector_id": "dario_hub"},
    ]
    clients = setup_mcp_servers(mcp_servers)
"""

import json
import logging
from typing import Any, Dict, List, Optional

from elitza.mcp_client import MCPClient, MCPError, connect_mcp
from elitza.tools import registry

logger = logging.getLogger(__name__)

# Track active MCP clients so we can close them on shutdown
_active_clients: List[MCPClient] = []


def _mcp_schema_to_openai(tool: Dict[str, Any], prefix: str) -> Dict[str, Any]:
    """Convert an MCP tool definition to OpenAI function schema."""
    name = tool["name"].replace("-", "_").replace(".", "_")
    full_name = f"mcp_{prefix}_{name}"
    return {
        "name": full_name,
        "description": tool.get("description", ""),
        "parameters": tool.get("inputSchema", {"type": "object", "properties": {}}),
    }


def _make_tool_handler(client: MCPClient, tool_name: str):
    """Create a handler function for a specific MCP tool."""
    def handler(**kwargs):
        try:
            result = client.call_tool(tool_name, kwargs)
            # MCP returns {"content": [{"type": "text", "text": "..."}]}
            content = result.get("content", [])
            texts = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    texts.append(item.get("text", ""))
                else:
                    texts.append(str(item))
            return "\n".join(texts) if texts else json.dumps(result, default=str)
        except MCPError as e:
            return json.dumps({"error": str(e)})
        except Exception as e:
            return json.dumps({"error": str(e)})
    return handler


def setup_mcp_server(
    base_url: str,
    connector_id: str,
    auth_token: str = "",
    timeout: float = 30.0,
) -> MCPClient:
    """Connect to one MCP server and register all its tools.

    Args:
        base_url: MCP server base URL.
        connector_id: Connector/namespace ID.
        auth_token: Optional bearer token.
        timeout: Request timeout in seconds.

    Returns:
        Connected MCPClient instance.
    """
    client = connect_mcp(
        base_url=base_url,
        connector_id=connector_id,
        auth_token=auth_token,
        timeout=timeout,
    )

    prefix = connector_id.replace("-", "_").replace(".", "_")
    registered = 0

    for tool in client.tools:
        full_name = f"mcp_{prefix}_{tool['name']}"
        openai_schema = _mcp_schema_to_openai(tool, prefix)
        handler = _make_tool_handler(client, tool["name"])

        registry.register(
            name=full_name,
            toolset="mcp",
            schema=openai_schema,
            handler=handler,
            description=tool.get("description", ""),
        )
        registered += 1
        logger.info("Registered MCP tool: %s", full_name)

    logger.info(
        "MCP server '%s': registered %d tools",
        connector_id, registered,
    )
    _active_clients.append(client)
    return client


def setup_mcp_servers(servers: List[Dict[str, Any]]) -> List[MCPClient]:
    """Connect to multiple MCP servers and register all tools.

    Args:
        servers: List of dicts with keys:
            - base_url (str)
            - connector_id (str)
            - auth_token (str, optional)
            - timeout (float, optional)

    Returns:
        List of connected MCPClient instances.
    """
    clients = []
    for server in servers:
        try:
            client = setup_mcp_server(
                base_url=server["base_url"],
                connector_id=server["connector_id"],
                auth_token=server.get("auth_token", ""),
                timeout=server.get("timeout", 30.0),
            )
            clients.append(client)
        except Exception as e:
            logger.error(
                "Failed to connect to MCP server '%s' at %s: %s",
                server.get("connector_id", "?"),
                server.get("base_url", "?"),
                e,
            )
    return clients


def close_all():
    """Close all active MCP connections."""
    for client in _active_clients:
        try:
            client.close()
        except Exception:
            pass
    _active_clients.clear()
