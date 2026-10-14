"""Central registry for all Elitza tools.

Each tool file calls registry.register() at module level to declare its
schema, handler, and metadata. The agent queries the registry to get
tool definitions and dispatch calls.

Design: a small, explicit tool registry -- lazy registration, no magic.
"""

import ast
import importlib
import json
import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class ToolEntry:
    """Metadata for a single registered tool."""

    __slots__ = (
        "name", "toolset", "schema", "handler", "check_fn",
        "is_async", "description",
    )

    def __init__(self, name, toolset, schema, handler, check_fn=None,
                 is_async=False, description=""):
        self.name = name
        self.toolset = toolset
        self.schema = schema
        self.handler = handler
        self.check_fn = check_fn
        self.is_async = is_async
        self.description = description


class ToolRegistry:
    """Central tool registry. Singleton pattern."""

    def __init__(self):
        self._tools: Dict[str, ToolEntry] = {}
        self._agent: Any = None  # Set by ElitzaAgent.__init__

    def register(
        self,
        name: str,
        toolset: str,
        schema: Dict[str, Any],
        handler: Callable,
        check_fn: Optional[Callable] = None,
        is_async: bool = False,
        description: str = "",
    ):
        """Register a tool.

        Args:
            name: Tool name (used by the LLM in tool_calls)
            toolset: Tool group (terminal, file, web, etc.)
            schema: OpenAI function calling JSON schema
            handler: Callable that executes the tool
            check_fn: Optional availability check
            is_async: Whether the handler is async
            description: Human-readable description
        """
        if name in self._tools:
            logger.warning("Tool '%s' already registered, overwriting", name)
        self._tools[name] = ToolEntry(
            name=name, toolset=toolset, schema=schema,
            handler=handler, check_fn=check_fn, is_async=is_async,
            description=description,
        )
        logger.debug("Registered tool: %s (toolset=%s)", name, toolset)

    def get_tool(self, name: str) -> Optional[ToolEntry]:
        return self._tools.get(name)

    def get_all_tools(self) -> Dict[str, ToolEntry]:
        return dict(self._tools)

    def get_tools_for_toolsets(
        self,
        enabled: Optional[List[str]] = None,
        disabled: Optional[List[str]] = None,
    ) -> List[ToolEntry]:
        """Return tools filtered by toolset."""
        tools = list(self._tools.values())
        if enabled:
            enabled_set = set(enabled)
            tools = [t for t in tools if t.toolset in enabled_set]
        if disabled:
            disabled_set = set(disabled)
            tools = [t for t in tools if t.toolset not in disabled_set]
        return tools

    def get_openai_schemas(
        self,
        enabled_toolsets: Optional[List[str]] = None,
        disabled_toolsets: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Return OpenAI-format tool schemas for the enabled toolsets."""
        tools = self.get_tools_for_toolsets(enabled_toolsets, disabled_toolsets)
        return [
            {"type": "function", "function": t.schema}
            for t in tools
        ]

    def dispatch(self, name: str, args: Dict[str, Any]) -> str:
        """Execute a tool by name with given arguments."""
        entry = self._tools.get(name)
        if entry is None:
            return json.dumps({"error": f"Unknown tool: {name}"})
        try:
            result = entry.handler(**args)
            if isinstance(result, str):
                return result
            return json.dumps(result, default=str)
        except Exception as e:
            logger.exception("Tool %s failed", name)
            return json.dumps({"error": str(e)})


# Global singleton
registry = ToolRegistry()


def _is_registry_register_call(node: ast.AST) -> bool:
    if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
        return False
    func = node.value.func
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "register"
        and isinstance(func.value, ast.Name)
        and func.value.id == "registry"
    )


def _module_registers_tools(module_path: Path) -> bool:
    try:
        source = module_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(module_path))
    except (OSError, SyntaxError):
        return False
    return any(_is_registry_register_call(stmt) for stmt in tree.body)


def discover_tools(tools_dir: Optional[Path] = None) -> List[str]:
    """Import built-in self-registering tool modules."""
    tools_path = tools_dir or Path(__file__).resolve().parent
    module_names = [
        f"elitza.tools.{path.stem}"
        for path in sorted(tools_path.glob("*.py"))
        if path.name not in {"__init__.py", "registry.py"}
        and _module_registers_tools(path)
    ]
    imported: List[str] = []
    for mod_name in module_names:
        try:
            importlib.import_module(mod_name)
            imported.append(mod_name)
        except Exception as e:
            logger.warning("Could not import tool module %s: %s", mod_name, e)
    return imported


# ---------------------------------------------------------------------------
# Built-in: todo_write tool
# ---------------------------------------------------------------------------

def _register_builtin_tools():
    """Register built-in tools that don't live in separate modules."""

    def todo_write(todos: list, merge: bool = True) -> str:
        """Write/update the todo list. Merge=true updates existing, false replaces."""
        # Store on the agent via a global ref; the CLI sets this before each run
        import sys
        # Find the current agent instance from the call stack
        agent = _find_agent()
        if agent is None:
            return json.dumps({"error": "No active agent for todo_write"})
        if merge and agent._current_todos:
            # Merge: update existing by id, add new ones
            existing = {t["id"]: t for t in agent._current_todos}
            for item in todos:
                iid = item.get("id", item.get("content", ""))
                existing[iid] = item
            agent._current_todos = list(existing.values())
        else:
            agent._current_todos = todos
        return json.dumps({"ok": True, "count": len(agent._current_todos)})

    def enter_plan_mode(task: str = "") -> str:
        """Enter plan mode. The agent should create a plan before executing."""
        agent = _find_agent()
        if agent is None:
            return json.dumps({"error": "No active agent"})
        agent._current_plan = []
        return json.dumps({"ok": True, "message": "Plan mode active. Create your plan, then use exit_plan to execute."})

    def exit_plan_mode() -> str:
        """Exit plan mode and return the plan for execution."""
        agent = _find_agent()
        if agent is None:
            return json.dumps({"error": "No active agent"})
        plan = agent._current_plan
        agent._current_plan = []
        return json.dumps({"ok": True, "plan": plan})

    def update_plan(steps: list) -> str:
        """Update the current plan steps."""
        agent = _find_agent()
        if agent is None:
            return json.dumps({"error": "No active agent"})
        agent._current_plan = steps
        return json.dumps({"ok": True, "steps": len(steps)})

    def _find_agent():
        """Find the current agent instance from the registry."""
        return registry._agent

    registry.register(
        name="todo_write",
        toolset="core",
        schema={
            "name": "todo_write",
            "description": "Write or update a todo list for tracking multi-step tasks. Use merge=true to update existing todos, merge=false to replace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "description": "Unique id for this todo item"},
                                "content": {"type": "string", "description": "What needs to be done"},
                                "status": {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"]},
                            },
                            "required": ["id", "content", "status"],
                        },
                    },
                    "merge": {"type": "boolean", "description": "Merge with existing todos (default true)"},
                },
                "required": ["todos"],
            },
        },
        handler=todo_write,
        description="Write/update todo list for multi-step tasks",
    )

    registry.register(
        name="enter_plan_mode",
        toolset="core",
        schema={
            "name": "enter_plan_mode",
            "description": "Enter plan mode. Create a structured plan before executing complex tasks.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "Description of the task to plan"},
                },
            },
        },
        handler=enter_plan_mode,
        description="Enter structured planning mode",
    )

    registry.register(
        name="exit_plan_mode",
        toolset="core",
        schema={
            "name": "exit_plan_mode",
            "description": "Exit plan mode and return the plan for execution.",
            "parameters": {"type": "object", "properties": {}},
        },
        handler=exit_plan_mode,
        description="Exit planning mode and execute plan",
    )

    registry.register(
        name="update_plan",
        toolset="core",
        schema={
            "name": "update_plan",
            "description": "Update the current plan steps.",
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "List of plan steps",
                    },
                },
                "required": ["steps"],
            },
        },
        handler=update_plan,
        description="Update plan steps",
    )

    def spawn_subagent(task: str, persona: str = "implementer", tools: list = None, timeout: int = 120) -> str:
        """Spawn an isolated subagent to work on a task in parallel."""
        import os
        from elitza.subagent import spawn_subagent as _spawn
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        model = registry._agent.model if registry._agent else ""
        result = _spawn(
            task=task,
            persona=persona,
            tools=tools or [],
            timeout=timeout,
            model=model,
            api_key=api_key,
        )
        return json.dumps(result)

    registry.register(
        name="spawn_subagent",
        toolset="core",
        schema={
            "name": "spawn_subagent",
            "description": "Spawn an isolated subagent to work on a task. The subagent runs in its own process and returns its result.",
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {"type": "string", "description": "The task description"},
                    "persona": {
                        "type": "string",
                        "enum": ["implementer", "reviewer", "researcher", "tester", "security-auditor"],
                        "description": "Role persona (default: implementer)",
                    },
                    "tools": {"type": "array", "items": {"type": "string"}, "description": "Tools to enable (default: all)", "default": []},
                    "timeout": {"type": "integer", "description": "Max seconds (default: 120)", "default": 120},
                },
                "required": ["task"],
            },
        },
        handler=spawn_subagent,
        description="Spawn an isolated subagent for parallel work",
    )

    def spawn_parallel(tasks: list, max_concurrency: int = 3, timeout: int = 120) -> str:
        """Spawn multiple subagents in parallel. Tasks: [{task, persona?, tools?, timeout?}]"""
        import os
        from elitza.subagent import spawn_parallel as _spawn_par
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        model = registry._agent.model if registry._agent else ""
        task_kwargs = []
        for t in tasks:
            kw = dict(t)
            kw.setdefault("model", model)
            kw.setdefault("api_key", api_key)
            kw.setdefault("timeout", timeout)
            task_kwargs.append(kw)
        results = _spawn_par(task_kwargs, max_concurrency=max_concurrency, timeout=timeout)
        return json.dumps(results)

    registry.register(
        name="spawn_parallel",
        toolset="core",
        schema={
            "name": "spawn_parallel",
            "description": "Spawn multiple subagents in parallel.",
            "parameters": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "task": {"type": "string"},
                                "persona": {"type": "string"},
                                "tools": {"type": "array", "items": {"type": "string"}},
                                "timeout": {"type": "integer"},
                            },
                            "required": ["task"],
                        },
                    },
                    "max_concurrency": {"type": "integer", "description": "Max parallel (default: 3)"},
                    "timeout": {"type": "integer", "description": "Per-task timeout (default: 120)"},
                },
                "required": ["tasks"],
            },
        },
        handler=spawn_parallel,
        description="Spawn multiple subagents in parallel",
    )


# Auto-register on import
_register_builtin_tools()
