"""Tool Search -- progressive disclosure for tools.

When the tool surface exceeds 10% of the context window, replaces
non-core tools with search/describe/call bridge tools.
Searches the tool catalog by keyword.
"""

import json
import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

CORE_TOOLS = {"terminal", "read_file", "write_file", "patch", "search_files"}
TOOL_SEARCH_THRESHOLD = 0.10  # 10% of context window


class ToolSearch:
    """Manages progressive tool disclosure."""

    def __init__(self, registry, context_window: int = 2000000):
        self.registry = registry
        self.context_window = context_window
        self._all_tools: Dict[str, dict] = {}
        self._loaded = False

    def _load_tools(self):
        """Cache all tool schemas."""
        if self._loaded:
            return
        for name, entry in self.registry.get_all_tools().items():
            self._all_tools[name] = {
                "name": name,
                "toolset": entry.toolset,
                "description": entry.description,
                "schema": entry.schema,
            }
        self._loaded = True

    def needs_search_mode(self) -> bool:
        """Check if tools exceed the threshold."""
        self._load_tools()
        total_tool_chars = sum(
            len(json.dumps(t["schema"])) for t in self._all_tools.values()
        )
        tool_tokens = total_tool_chars // 4
        threshold = int(self.context_window * TOOL_SEARCH_THRESHOLD)
        return tool_tokens > threshold

    def get_tool_schemas(self, use_search: bool = False) -> List[dict]:
        """Get tool schemas, using search mode if needed."""
        self._load_tools()

        if not use_search or not self.needs_search_mode():
            # Return all tools
            return [t["schema"] for t in self._all_tools.values()]

        # Search mode: core tools + bridge tools
        schemas = []

        # Core tools (always available)
        for name in CORE_TOOLS:
            if name in self._all_tools:
                schemas.append(self._all_tools[name]["schema"])

        # Bridge tools
        schemas.append(self._make_tool_search_schema())
        schemas.append(self._make_tool_describe_schema())
        schemas.append(self._make_tool_call_schema())

        return schemas

    def search_tools(self, query: str) -> str:
        """Search for tools by name or description."""
        self._load_tools()
        query_lower = query.lower()
        results = []
        for name, info in self._all_tools.items():
            if query_lower in name.lower() or query_lower in info["description"].lower():
                results.append(f"- {name}: {info['description']}")
        return "\n".join(results) if results else "No tools found matching that query"

    def describe_tool(self, name: str) -> str:
        """Get detailed schema for a tool."""
        self._load_tools()
        if name in self._all_tools:
            return json.dumps(self._all_tools[name]["schema"], indent=2)
        return f"Tool '{name}' not found"

    def call_deferred_tool(self, name: str, args: dict) -> str:
        """Call a tool that was deferred via search mode."""
        entry = self.registry.get_tool(name)
        if not entry:
            return json.dumps({"error": f"Unknown tool: {name}"})
        try:
            result = entry.handler(**args)
            if isinstance(result, str):
                return result
            return json.dumps(result, default=str)
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _make_tool_search_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "tool_search",
                "description": "Search for available tools by name or description. Use when you need a tool that isn't in your current toolset.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query for tool name or description"}
                    },
                    "required": ["query"]
                }
            }
        }

    def _make_tool_describe_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "tool_describe",
                "description": "Get the full schema and parameters for a specific tool.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Tool name"}
                    },
                    "required": ["name"]
                }
            }
        }

    def _make_tool_call_schema(self) -> dict:
        return {
            "type": "function",
            "function": {
                "name": "tool_call",
                "description": "Call a tool that was found via tool_search but isn't in your current toolset.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Tool name to call"},
                        "args": {"type": "object", "description": "Arguments for the tool"}
                    },
                    "required": ["name", "args"]
                }
            }
        }
