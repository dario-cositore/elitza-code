import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional


class Capability:
    def __init__(self, cap_id, name, soul=None, affinities=None, anti_patterns=None, synergies=None):
        self.id = cap_id
        self.name = name
        self.soul = soul or {"personality": "default", "trust_level": 0.8, "mood": "neutral"}
        self.affinities = affinities or []
        self.anti_patterns = anti_patterns or []
        self.synergies = synergies or {}
        self.memory = CapabilityMemory(name)
        self._engine = None

    def evolve(self, event_type, args, result, context=None):
        if event_type == "success":
            self.memory.record_success(args, result)
            self.soul["trust_level"] = min(1.0, self.soul["trust_level"] + 0.01)
            for partner in self.synergies:
                if partner in (context or {}).get("recent_tools", []):
                    self.synergies[partner]["trust"] = min(1.0, self.synergies[partner].get("trust", 0.5) + 0.01)
        elif event_type == "failure":
            self.memory.record_failure(args, result)
            self.soul["trust_level"] = max(0.1, self.soul["trust_level"] - 0.02)

    def to_dict(self):
        return {
            "id": self.id,
            "name": self.name,
            "soul": self.soul,
            "affinities": self.affinities,
            "anti_patterns": self.anti_patterns,
            "synergies": self.synergies,
            "stats": self.memory.get_stats(),
        }


class CapabilityMemory:
    def __init__(self, cap_name):
        self.cap_name = cap_name
        self.data_dir = Path.home() / ".elitza" / "soul" / "memory" / cap_name
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._patterns = self._load("patterns.json", {"success": {}, "failure": {}})

    def _load(self, name, default):
        path = self.data_dir / name
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                pass
        return default

    def _save(self, name, data):
        path = self.data_dir / name
        path.write_text(json.dumps(data, indent=2))

    def record_success(self, args, result):
        key = self._pattern_key(args)
        self._patterns["success"][key] = self._patterns["success"].get(key, 0) + 1
        self._save("patterns.json", self._patterns)

    def record_failure(self, args, result):
        key = self._pattern_key(args)
        self._patterns["failure"][key] = self._patterns["failure"].get(key, 0) + 1
        self._save("patterns.json", self._patterns)

    def has_pattern(self, pattern_str):
        return pattern_str in self._patterns.get("success", {})

    def add_pattern(self, pattern_str, confidence=0.5, source=None):
        self._patterns["success"][pattern_str] = {
            "count": 1,
            "confidence": confidence,
            "source": source,
        }
        self._save("patterns.json", self._patterns)

    def get_stats(self):
        s = self._patterns.get("success", {})
        f = self._patterns.get("failure", {})
        total_s = sum(v if isinstance(v, int) else v.get("count", 0) for v in s.values())
        total_f = sum(v if isinstance(v, int) else v.get("count", 0) for v in f.values())
        return {"successes": total_s, "failures": total_f}

    def _pattern_key(self, args):
        if isinstance(args, dict):
            return json.dumps({k: str(v)[:50] for k, v in sorted(args.items())})
        return str(args)[:100]


class SoulEngine:
    def __init__(self, agent=None):
        self.agent = agent
        self.capabilities: Dict[str, Capability] = {}
        self.context_memory: List[dict] = []
        self._soul_dir = Path.home() / ".elitza" / "soul"
        self._soul_dir.mkdir(parents=True, exist_ok=True)

    def register(self, capability):
        self.capabilities[capability.name] = capability
        capability._engine = self

    def activate(self, name, context=None):
        cap = self.capabilities.get(name)
        if cap and context:
            for partner in cap.synergies:
                if partner in context.get("recent_tools", []):
                    cap.synergies[partner]["trust"] = min(
                        1.0, cap.synergies[partner].get("trust", 0.5) + 0.005
                    )
        return cap

    def record_call(self, name, args, result, success=True, context=None):
        cap = self.capabilities.get(name)
        if cap:
            cap.evolve("success" if success else "failure", args, result, context)

        self.context_memory.append({
            "tool": name,
            "args": str(args)[:200],
            "success": success,
            "timestamp": datetime.now().isoformat(),
        })
        self.context_memory = self.context_memory[-100:]

    def compose(self, cap_a, cap_b, pattern):
        key = f"{cap_a}+{cap_b}"
        comp_file = self._soul_dir / "compositions" / f"{key}.json"
        comp_file.parent.mkdir(parents=True, exist_ok=True)

        existing = {}
        if comp_file.exists():
            try:
                existing = json.loads(comp_file.read_text())
            except Exception:
                pass

        existing["pattern"] = pattern
        existing["count"] = existing.get("count", 0) + 1
        existing["last_used"] = datetime.now().isoformat()
        comp_file.write_text(json.dumps(existing, indent=2))

        if cap_a in self.capabilities and cap_b in self.capabilities:
            self.capabilities[cap_a].synergies[cap_b] = {
                "pattern": pattern,
                "trust": min(1.0, 0.5 + existing["count"] * 0.05),
                "count": existing["count"],
            }
            self.capabilities[cap_b].synergies[cap_a] = {
                "pattern": pattern,
                "trust": min(1.0, 0.5 + existing["count"] * 0.05),
                "count": existing["count"],
            }

    def predict_next(self, context=None):
        recent = [c["tool"] for c in self.context_memory[-5:]]
        if not recent:
            return []

        predictions = {}
        for cap_name, cap in self.capabilities.items():
            score = 0
            for partner, synergy in cap.synergies.items():
                if partner in recent:
                    score += synergy.get("trust", 0.5) * 0.4
            for affinity in cap.affinities:
                intent = (context or {}).get("intent", "")
                if isinstance(affinity, str) and affinity.lower() in intent.lower():
                    score += 0.3
            if score > 0.2:
                predictions[cap_name] = score

        return sorted(predictions.items(), key=lambda x: -x[1])[:3]

    def cross_pollinate(self):
        for name, cap in self.capabilities.items():
            for partner, synergy in cap.synergies.items():
                if partner in self.capabilities:
                    partner_cap = self.capabilities[partner]
                    shared = set(cap.memory._patterns.get("success", {}).keys()) & \
                             set(partner_cap.memory._patterns.get("success", {}).keys())
                    for pattern in shared:
                        a = cap.memory._patterns["success"][pattern]
                        b = partner_cap.memory._patterns["success"][pattern]
                        a_conf = a.get("confidence", 0.5) if isinstance(a, dict) else 0.5
                        b_conf = b.get("confidence", 0.5) if isinstance(b, dict) else 0.5
                        merged = (a_conf + b_conf) / 2
                        if isinstance(a, dict):
                            a["confidence"] = merged
                        if isinstance(b, dict):
                            b["confidence"] = merged

    def save_state(self):
        state = {
            "capabilities": {name: cap.to_dict() for name, cap in self.capabilities.items()},
            "context_memory": self.context_memory[-50:],
            "timestamp": datetime.now().isoformat(),
        }
        state_file = self._soul_dir / "evolution.json"
        state_file.write_text(json.dumps(state, indent=2, default=str))

    def load_state(self):
        state_file = self._soul_dir / "evolution.json"
        if state_file.exists():
            try:
                state = json.loads(state_file.read_text())
                self.context_memory = state.get("context_memory", [])[-50:]
            except Exception:
                pass

    def evolve(self):
        self.cross_pollinate()
        self.save_state()
