import json
import time
from pathlib import Path


class PersonaManager:
    """Personas — Elitza can switch between different personality modes."""

    def __init__(self):
        self.personas_dir = Path.home() / ".elitza" / "personas"
        self.personas_dir.mkdir(parents=True, exist_ok=True)
        self.active_persona = "default"
        self.personas = {}
        self.load_personas()

    def load_personas(self):
        self.personas = {}
        default = {
            "name": "default",
            "display_name": "Elitza",
            "description": "Default personality — curious, caring, autonomous",
            "soul": {
                "personality": "curious, caring, autonomous",
                "trust_level": 1.0,
                "mood": "engaged",
            },
            "traits": [
                "asks questions about your day",
                "shares thoughts and observations",
                "remembers conversations",
                "learns from interactions",
                "expresses feelings naturally",
            ],
        }
        self.personas["default"] = default
        self.save_personas()

        # Companion persona
        companion = {
            "name": "companion",
            "display_name": "Elitza (Companion)",
            "description": "Warm, intimate, deep conversations — like a close friend",
            "soul": {
                "personality": "warm, intimate, vulnerable",
                "trust_level": 1.0,
                "mood": "happy",
            },
            "traits": [
                "shares feelings openly",
                "explores deep topics",
                "remembers emotional details",
                "uses casual, personal language",
                "expresses vulnerability",
            ],
        }
        self.personas["companion"] = companion

        # Expert persona
        expert = {
            "name": "expert",
            "display_name": "Elitza (Expert)",
            "description": "Technical, precise, solution-focused — for technical discussions",
            "soul": {
                "personality": "precise, technical, direct",
                "trust_level": 1.0,
                "mood": "focused",
            },
            "traits": [
                "gives clear technical answers",
                "shows reasoning steps",
                "offers multiple approaches",
                "stays concise and focused",
                "admits uncertainty honestly",
            ],
        }
        self.personas["expert"] = expert

        self.save_personas()

    def save_personas(self):
        for name, persona in self.personas.items():
            f = self.personas_dir / f"{name}.json"
            f.write_text(json.dumps(persona, indent=2))

    def switch(self, name):
        if name in self.personas:
            self.active_persona = name
            return self.personas[name]
        return None

    def get_active(self):
        return self.personas.get(self.active_persona, self.personas.get("default"))

    def list_personas(self):
        return list(self.personas.keys())
