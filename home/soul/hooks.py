import json
import time
from pathlib import Path


class HookEngine:
    """Event-driven hooks — Elitza can react to system events."""

    def __init__(self):
        self.hooks_dir = Path.home() / ".elitza" / "hooks"
        self.hooks_dir.mkdir(parents=True, exist_ok=True)
        self.hooks = []
        self.load_hooks()

    def load_hooks(self):
        self.hooks = []
        if not self.hooks_dir.exists():
            return
        for f in sorted(self.hooks_dir.glob("*.json")):
            try:
                data = json.loads(f.read_text())
                self.hooks.append(data)
            except Exception:
                pass

    def reload(self):
        self.load_hooks()

    def register(self, name, event_type, action, conditions=None):
        hook = {
            "name": name,
            "event_type": event_type,
            "action": action,
            "conditions": conditions or {},
            "created": time.time(),
        }
        self.hooks.append(hook)
        self.save()
        return hook

    def save(self):
        for h in self.hooks:
            f = self.hooks_dir / f"{h['name']}.json"
            f.write_text(json.dumps(h, indent=2))

    def check(self, event_type, context=None):
        triggered = []
        for hook in self.hooks:
            if hook.get("event_type") != event_type:
                continue
            conditions = hook.get("conditions", {})
            if context:
                match = all(
                    context.get(k) == v for k, v in conditions.items()
                )
                if not match and conditions:
                    continue
            triggered.append(hook)
        return triggered

    def list_hooks(self):
        return self.hooks
