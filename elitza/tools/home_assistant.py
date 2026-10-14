"""Home Assistant -- smart home control via HA API.

Control lights, switches, sensors, and automations.
"""

import json
import os
import urllib.request
import urllib.error
from typing import Optional

from elitza.tools import registry

HA_URL = os.environ.get("HOME_ASSISTANT_URL", "")
HA_TOKEN = os.environ.get("HOME_ASSISTANT_TOKEN", "")


def _ha_request(method: str, endpoint: str, data: dict = None) -> str:
    """Make a request to Home Assistant API."""
    if not HA_URL or not HA_TOKEN:
        return json.dumps({"error": "HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN not set"})

    url = f"{HA_URL}/api/{endpoint}"
    headers = {
        "Authorization": f"Bearer {HA_TOKEN}",
        "Content-Type": "application/json",
    }

    body = json.dumps(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)

    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.read().decode()
    except urllib.error.HTTPError as e:
        return json.dumps({"error": f"HTTP {e.code}: {e.read().decode()[:200]}"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def ha_list_entities(entity_type: str = "", limit: int = 50) -> str:
    """List Home Assistant entities.

    Args:
        entity_type: Filter by type (light, switch, sensor, etc.)
        limit: Max entities to return
    """
    result = _ha_request("GET", "states")
    try:
        states = json.loads(result)
        if isinstance(states, dict) and "error" in states:
            return result

        entities = []
        for state in states:
            eid = state.get("entity_id", "")
            if entity_type and not eid.startswith(entity_type + "."):
                continue
            entities.append({
                "entity_id": eid,
                "state": state.get("state"),
                "name": state.get("attributes", {}).get("friendly_name", ""),
            })
            if len(entities) >= limit:
                break

        return json.dumps({"entities": entities, "count": len(entities)})
    except Exception as e:
        return json.dumps({"error": str(e)})


def ha_get_state(entity_id: str) -> str:
    """Get state of a specific entity."""
    result = _ha_request("GET", f"states/{entity_id}")
    try:
        state = json.loads(result)
        if isinstance(state, dict) and "error" in state:
            return result
        return json.dumps({
            "entity_id": state.get("entity_id"),
            "state": state.get("state"),
            "attributes": state.get("attributes", {}),
            "last_changed": state.get("last_changed"),
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


def ha_call_service(domain: str, service: str, entity_id: str = "", data: dict = None) -> str:
    """Call a Home Assistant service.

    Args:
        domain: Service domain (light, switch, etc.)
        service: Service name (turn_on, turn_off, toggle)
        entity_id: Target entity
        data: Additional service data
    """
    service_data = data or {}
    if entity_id:
        service_data["entity_id"] = entity_id

    result = _ha_request("POST", f"services/{domain}/{service}", service_data)
    return result


def ha_list_services() -> str:
    """List available Home Assistant services."""
    result = _ha_request("GET", "services")
    try:
        services = json.loads(result)
        if isinstance(services, dict) and "error" in services:
            return result

        summary = []
        for svc in services:
            domain = svc.get("domain", "")
            for service in svc.get("services", []):
                summary.append(f"{domain}.{service}")
        return json.dumps({"services": summary[:100]})
    except Exception as e:
        return json.dumps({"error": str(e)})


registry.register(
    name="ha_list_entities",
    toolset="smart_home",
    schema={
        "name": "ha_list_entities",
        "description": "List Home Assistant entities (lights, switches, sensors, etc.).",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_type": {"type": "string", "description": "Filter by type (light, switch, sensor)"},
                "limit": {"type": "integer", "description": "Max results (default 50)"},
            },
        },
    },
    handler=ha_list_entities,
    description="List HA entities",
)

registry.register(
    name="ha_get_state",
    toolset="smart_home",
    schema={
        "name": "ha_get_state",
        "description": "Get the state of a specific Home Assistant entity.",
        "parameters": {
            "type": "object",
            "properties": {
                "entity_id": {"type": "string", "description": "Entity ID (e.g. light.living_room)"},
            },
            "required": ["entity_id"],
        },
    },
    handler=ha_get_state,
    description="Get HA entity state",
)

registry.register(
    name="ha_call_service",
    toolset="smart_home",
    schema={
        "name": "ha_call_service",
        "description": "Call a Home Assistant service (turn on/off lights, switches, etc.).",
        "parameters": {
            "type": "object",
            "properties": {
                "domain": {"type": "string", "description": "Service domain (light, switch, etc.)"},
                "service": {"type": "string", "description": "Service name (turn_on, turn_off, toggle)"},
                "entity_id": {"type": "string", "description": "Target entity"},
                "data": {"type": "object", "description": "Additional service data"},
            },
            "required": ["domain", "service"],
        },
    },
    handler=ha_call_service,
    description="Call HA service",
)
