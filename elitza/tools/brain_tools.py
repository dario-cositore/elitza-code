"""Brain tools -- Allow Elitza to interact with her own memory.

These tools give Elitza agency over her memory system, enabling her to:
- Search her memories
- Create new memories
- View her personality and stats
- Consolidate memories
- Forget things
"""

import json
from elitza.tools import registry
from elitza.brain_v2 import (
    memory_search, memory_create, memory_stats, 
    memory_consolidate, memory_forget, recall,
    get_personality, get_metamemory, store_episodic,
    store_semantic, build_full_context
)
from elitza.auto_learning import get_learning_stats
from elitza.persistence import get_persistence_stats, search_messages, get_recent_sessions
from elitza.config import config_summary, get, validate_config
from elitza.doctor import check_all, repair_all, doctor_summary, get_health_history


def _register_brain_tools():
    """Register brain/memory tools."""

    def brain_search(query: str, memory_type: str = "", limit: int = 10) -> str:
        """Search your memories using full-text search."""
        return memory_search(query=query, memory_type=memory_type or None, limit=limit)

    registry.register(
        name="brain_search",
        toolset="brain",
        schema={
            "name": "brain_search",
            "description": "Search your memories and knowledge. Use this to recall past interactions, facts, skills, or emotional experiences.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query (what you want to remember)"
                    },
                    "memory_type": {
                        "type": "string",
                        "enum": ["episodic", "semantic", "procedural", "emotional"],
                        "description": "Filter by memory type (optional)"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10)",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        },
        handler=brain_search,
        description="Search memories and knowledge"
    )

    def brain_create(content: str, memory_type: str = "episodic", 
                     importance: float = 0.7, tags: str = "") -> str:
        """Create a new memory explicitly."""
        tag_list = [t.strip() for t in tags.split(",") if t.strip()] if tags else []
        return memory_create(content=content, memory_type=memory_type,
                           importance=importance, tags=tag_list)

    registry.register(
        name="brain_create",
        toolset="brain",
        schema={
            "name": "brain_create",
            "description": "Create a new memory. Use this to explicitly store important information you want to remember.",
            "parameters": {
                "type": "object",
                "properties": {
                    "content": {
                        "type": "string",
                        "description": "The memory content to store"
                    },
                    "memory_type": {
                        "type": "string",
                        "enum": ["episodic", "semantic", "procedural", "emotional"],
                        "description": "Type of memory (default: episodic)"
                    },
                    "importance": {
                        "type": "number",
                        "description": "Importance 0.0-1.0 (default 0.7)",
                        "default": 0.7
                    },
                    "tags": {
                        "type": "string",
                        "description": "Comma-separated tags for categorization"
                    }
                },
                "required": ["content"]
            }
        },
        handler=brain_create,
        description="Create a new memory"
    )

    def brain_stats() -> str:
        """View your brain statistics and personality."""
        return memory_stats()

    registry.register(
        name="brain_stats",
        toolset="brain",
        schema={
            "name": "brain_stats",
            "description": "View your brain statistics, memory counts, and current personality state.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_stats,
        description="View brain statistics"
    )

    def brain_consolidate() -> str:
        """Run memory consolidation (promote important episodic to semantic)."""
        return memory_consolidate()

    registry.register(
        name="brain_consolidate",
        toolset="brain",
        schema={
            "name": "brain_consolidate",
            "description": "Run memory consolidation. This promotes important episodic memories to lasting semantic knowledge.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_consolidate,
        description="Consolidate memories"
    )

    def brain_forget(query: str) -> str:
        """Forget (delete) memories matching a query."""
        return memory_forget(query=query)

    registry.register(
        name="brain_forget",
        toolset="brain",
        schema={
            "name": "brain_forget",
            "description": "Forget memories matching a query. Use this to remove outdated or incorrect information.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to forget"
                    }
                },
                "required": ["query"]
            }
        },
        handler=brain_forget,
        description="Forget memories"
    )

    def brain_personality() -> str:
        """View your current personality and emotional state."""
        p = get_personality()
        return json.dumps({
            "name": p["name"],
            "mood": p["mood"],
            "confidence": p["confidence"],
            "interactions": p["interactions"],
            "style": p["style"],
            "emotional_state": p.get("emotional_state", {}),
            "top_tools": sorted(p.get("preferences", {}).items(), 
                              key=lambda x: -x[1])[:5],
            "recent_learnings": p.get("learnings", [])[-3:],
        }, indent=2)

    registry.register(
        name="brain_personality",
        toolset="brain",
        schema={
            "name": "brain_personality",
            "description": "View your current personality, mood, confidence, and emotional state.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_personality,
        description="View personality state"
    )

    def brain_metamemory() -> str:
        """View metamemory - statistics about how your memory system is working."""
        mm = get_metamemory()
        return json.dumps(mm, indent=2, default=str)

    registry.register(
        name="brain_metamemory",
        toolset="brain",
        schema={
            "name": "brain_metamemory",
            "description": "View metamemory statistics - how your memory system is performing, recall patterns, and most accessed memories.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_metamemory,
        description="View metamemory stats"
    )

    def brain_learning() -> str:
        """View auto-learning statistics - skills, knowledge, and lessons extracted."""
        stats = get_learning_stats()
        return json.dumps(stats, indent=2, default=str)

    registry.register(
        name="brain_learning",
        toolset="brain",
        schema={
            "name": "brain_learning",
            "description": "View auto-learning statistics - how many skills, knowledge items, and lessons have been extracted from conversations.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_learning,
        description="View learning statistics"
    )

    def brain_persistence() -> str:
        """View persistence statistics - messages stored, sessions, etc."""
        stats = get_persistence_stats()
        return json.dumps(stats, indent=2, default=str)

    registry.register(
        name="brain_persistence",
        toolset="brain",
        schema={
            "name": "brain_persistence",
            "description": "View persistence statistics - how many messages and sessions are stored permanently.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_persistence,
        description="View persistence stats"
    )

    def brain_search_history(query: str, limit: int = 10) -> str:
        """Search across all past conversations."""
        results = search_messages(query=query, limit=limit)
        if not results:
            return "No matching messages found."
        
        lines = [f"Found {len(results)} messages:"]
        for r in results:
            role = "User" if r["role"] == "user" else "Elitza"
            lines.append(f"- [{r.get('created', '')[:10]}] **{role}**: {r['content'][:150]}")
        
        return "\n".join(lines)

    registry.register(
        name="brain_search_history",
        toolset="brain",
        schema={
            "name": "brain_search_history",
            "description": "Search across ALL past conversations to find relevant context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for in conversation history"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 10)",
                        "default": 10
                    }
                },
                "required": ["query"]
            }
        },
        handler=brain_search_history,
        description="Search conversation history"
    )

    def brain_sessions() -> str:
        """View recent sessions."""
        sessions = get_recent_sessions(limit=10)
        if not sessions:
            return "No sessions found."
        
        lines = ["Recent sessions:"]
        for s in sessions:
            status = "active" if not s.get("ended") else "completed"
            lines.append(f"- [{s['started'][:10]}] {s.get('summary', 'No summary')[:80]} ({s['message_count']} messages, {status})")
        
        return "\n".join(lines)

    registry.register(
        name="brain_sessions",
        toolset="brain",
        schema={
            "name": "brain_sessions",
            "description": "View recent conversation sessions.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_sessions,
        description="View recent sessions"
    )

    def brain_config(section: str = "") -> str:
        """View Elitza's configuration."""
        if section:
            value = get(section)
            if value is None:
                return f"Section '{section}' not found in config."
            return json.dumps(value, indent=2, default=str)
        return config_summary()

    registry.register(
        name="brain_config",
        toolset="brain",
        schema={
            "name": "brain_config",
            "description": "View Elitza's configuration. Pass a section name (e.g., 'model', 'brain', 'personality') to see specific settings, or leave empty for full summary.",
            "parameters": {
                "type": "object",
                "properties": {
                    "section": {
                        "type": "string",
                        "description": "Config section to view (e.g., 'model', 'brain', 'personality', 'tools')"
                    }
                }
            }
        },
        handler=brain_config,
        description="View configuration"
    )

    def brain_validate() -> str:
        """Validate configuration and show warnings."""
        warnings = validate_config()
        if not warnings:
            return "Configuration is valid. No warnings."
        
        lines = [f"Configuration warnings ({len(warnings)}):"]
        for w in warnings:
            lines.append(f"- {w}")
        return "\n".join(lines)

    registry.register(
        name="brain_validate",
        toolset="brain",
        schema={
            "name": "brain_validate",
            "description": "Validate Elitza's configuration and show any warnings or issues.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=brain_validate,
        description="Validate configuration"
    )

    def doctor_check() -> str:
        """Run full health check on all Elitza subsystems."""
        return doctor_summary()

    registry.register(
        name="doctor_check",
        toolset="brain",
        schema={
            "name": "doctor_check",
            "description": "Run a full health check on all Elitza subsystems (databases, brain, config, tools, plugins, hooks, disk space).",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=doctor_check,
        description="Run health check"
    )

    def doctor_repair() -> str:
        """Attempt to repair any detected issues."""
        results = repair_all()
        
        lines = [f"## Repair Results"]
        lines.append(f"**Success**: {results['success_count']}, **Failed**: {results['fail_count']}")
        lines.append("")
        
        for repair in results["repairs"]:
            icon = "✓" if repair["success"] else "✗"
            lines.append(f"- {icon} **{repair['component']}**: {repair['message']}")
            if repair.get("fixes_applied"):
                for fix in repair["fixes_applied"]:
                    lines.append(f"  - Applied: {fix}")
        
        return "\n".join(lines)

    registry.register(
        name="doctor_repair",
        toolset="brain",
        schema={
            "name": "doctor_repair",
            "description": "Attempt to automatically repair any detected issues with Elitza's subsystems.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=doctor_repair,
        description="Repair issues"
    )

    def doctor_history() -> str:
        """View health check history."""
        history = get_health_history(days=7)
        
        if not history:
            return "No health check history found."
        
        lines = ["## Health Check History (last 7 days)"]
        
        # Group by component
        by_component = {}
        for entry in history:
            comp = entry["component"]
            if comp not in by_component:
                by_component[comp] = []
            by_component[comp].append(entry)
        
        for comp, entries in by_component.items():
            ok_count = sum(1 for e in entries if e["status"] == "ok")
            warn_count = sum(1 for e in entries if e["status"] == "warning")
            err_count = sum(1 for e in entries if e["status"] == "error")
            lines.append(f"- **{comp}**: {ok_count} ok, {warn_count} warnings, {err_count} errors")
        
        return "\n".join(lines)

    registry.register(
        name="doctor_history",
        toolset="brain",
        schema={
            "name": "doctor_history",
            "description": "View health check history over the past week.",
            "parameters": {"type": "object", "properties": {}}
        },
        handler=doctor_history,
        description="View health history"
    )


# Auto-register on import
_register_brain_tools()
