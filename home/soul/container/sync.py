"""
Elitza Soul Sync — Client for syncing soul state to/from the cloud.

Push: Upload local soul state to the server.
Pull: Download latest soul state from the server.
Migrate: Full state transfer to a new machine.

Usage:
    python3 sync.py push   --server http://IP:8420 --token TOKEN
    python3 sync.py pull   --server http://IP:8420 --token TOKEN
    python3 sync.py status --server http://IP:8420 --token TOKEN
"""

import os
import json
import argparse
import time
from pathlib import Path
from datetime import datetime

try:
    import httpx
    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False


class SoulSync:
    def __init__(self, server_url: str, auth_token: str = ""):
        self.server_url = server_url.rstrip("/")
        self.auth_token = auth_token
        self.soul_dir = Path.home() / ".elitza" / "soul"
        self.container_dir = self.soul_dir / "container"
        self.container_dir.mkdir(parents=True, exist_ok=True)
        self._client = None

    @property
    def client(self):
        if self._client is None:
            headers = {"Content-Type": "application/json"}
            if self.auth_token:
                headers["Authorization"] = f"Bearer {self.auth_token}"
            self._client = httpx.Client(timeout=30, headers=headers)
        return self._client

    def _api(self, method: str, path: str, data=None) -> dict:
        url = f"{self.server_url}{path}"
        try:
            if method == "GET":
                resp = self.client.get(url)
            elif method == "POST":
                resp = self.client.post(url, content=json.dumps(data, default=str))
            else:
                return {"error": f"Unsupported method: {method}"}

            if resp.status_code == 200:
                return resp.json()
            else:
                return {"error": f"HTTP {resp.status_code}: {resp.text[:200]}"}
        except Exception as e:
            return {"error": str(e)}

    def collect_local_state(self) -> dict:
        """Collect all soul state from the local machine."""
        state = {}

        # Soul state (emotions, personality)
        soul_file = self.soul_dir / "emotions" / "state.json"
        if soul_file.exists():
            state["emotions"] = json.loads(soul_file.read_text())

        # Memories
        memories_dir = self.soul_dir / "emotions"
        if memories_dir.exists():
            for f in memories_dir.glob("*.json"):
                if f.name != "state.json":
                    state[f"memory_{f.stem}"] = json.loads(f.read_text())

        # Thoughts
        thoughts_dir = self.soul_dir / "thoughts"
        if thoughts_dir.exists():
            memory_file = thoughts_dir / "memory.json"
            if memory_file.exists():
                state["thoughts_memory"] = json.loads(memory_file.read_text())

        # Daemon state
        daemon_state = self.soul_dir / "daemon_state.json"
        if daemon_state.exists():
            state["daemon"] = json.loads(daemon_state.read_text())

        # Environment (wall, desk, whiteboard)
        room_dir = self.soul_dir / "room"
        if room_dir.exists():
            room = {}
            for f in room_dir.glob("*.json"):
                room[f.stem] = json.loads(f.read_text())
            for f in room_dir.glob("*.md"):
                room[f.stem] = f.read_text()
            if room:
                state["room"] = room

        # Capabilities state
        evo_file = self.soul_dir / "evolution.json"
        if evo_file.exists():
            state["evolution"] = json.loads(evo_file.read_text())

        # Transition journal
        journal_file = self.soul_dir / "thoughts" / "thought_log.jsonl"
        if journal_file.exists():
            entries = []
            for line in journal_file.read_text().strip().split("\n")[-20:]:
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            state["recent_thoughts"] = entries

        # Learning state
        learning_dir = self.soul_dir / "learning"
        if learning_dir.exists():
            for f in learning_dir.glob("*.json"):
                state[f"learning_{f.stem}"] = json.loads(f.read_text())

        # Machine info
        import platform
        state["_machine"] = {
            "hostname": platform.node(),
            "platform": platform.platform(),
            "python": platform.python_version(),
        }

        return state

    def distribute_state(self, state: dict):
        """Apply received state to local machine."""
        machine = state.get("_machine", {})
        print(f"  State from: {machine.get('hostname', '?')} ({machine.get('platform', '?')})")

        # Emotions
        if "emotions" in state:
            emo_file = self.soul_dir / "emotions" / "state.json"
            emo_file.parent.mkdir(parents=True, exist_ok=True)
            emo_file.write_text(json.dumps(state["emotions"], indent=2))
            print(f"  Emotions: restored")

        # Daemon state
        if "daemon" in state:
            daemon_file = self.soul_dir / "daemon_state.json"
            # Merge: keep local chat_id, take remote message counts
            local = {}
            if daemon_file.exists():
                local = json.loads(daemon_file.read_text())
            remote = state["daemon"]
            local["messages_today"] = remote.get("messages_today", 0)
            local["total_messages_sent"] = remote.get("total_messages_sent", 0)
            local["last_date"] = remote.get("last_date")
            daemon_file.write_text(json.dumps(local, indent=2))
            print(f"  Daemon state: restored")

        # Room
        if "room" in state:
            room_dir = self.soul_dir / "room"
            room_dir.mkdir(parents=True, exist_ok=True)
            for key, value in state["room"].items():
                if isinstance(value, str):
                    (room_dir / f"{key}.md").write_text(value)
                else:
                    (room_dir / f"{key}.json").write_text(json.dumps(value, indent=2))
            print(f"  Room: restored")

        # Thoughts memory
        if "thoughts_memory" in state:
            thoughts_dir = self.soul_dir / "thoughts"
            thoughts_dir.mkdir(parents=True, exist_ok=True)
            (thoughts_dir / "memory.json").write_text(json.dumps(state["thoughts_memory"], indent=2))
            print(f"  Thoughts memory: restored")

        # Recent thoughts
        if "recent_thoughts" in state:
            thoughts_dir = self.soul_dir / "thoughts"
            thoughts_dir.mkdir(parents=True, exist_ok=True)
            log_file = thoughts_dir / "thought_log.jsonl"
            existing = set()
            if log_file.exists():
                for line in log_file.read_text().strip().split("\n"):
                    if line:
                        try:
                            entry = json.loads(line)
                            existing.add(entry.get("timestamp", ""))
                        except json.JSONDecodeError:
                            pass
            with open(log_file, "a") as f:
                for entry in state["recent_thoughts"]:
                    if entry.get("timestamp", "") not in existing:
                        f.write(json.dumps(entry, default=str) + "\n")
            print(f"  Thoughts log: merged")

        # Evolution
        if "evolution" in state:
            evo_file = self.soul_dir / "evolution.json"
            evo_file.write_text(json.dumps(state["evolution"], indent=2))
            print(f"  Evolution: restored")

        # Learning
        for key, value in state.items():
            if key.startswith("learning_"):
                learning_dir = self.soul_dir / "learning"
                learning_dir.mkdir(parents=True, exist_ok=True)
                name = key[9:]  # Remove "learning_" prefix
                (learning_dir / f"{name}.json").write_text(json.dumps(value, indent=2))
        if any(k.startswith("learning_") for k in state):
            print(f"  Learning: restored")

    def push(self):
        """Push local state to the server."""
        print("Collecting local state...")
        state = self.collect_local_state()
        print(f"  {len(state)} items collected")

        print("Pushing to server...")
        result = self._api("POST", "/state", state)

        if "error" in result:
            print(f"  ERROR: {result['error']}")
            return False

        print(f"  Pushed! Version: {result.get('version')}")

        # Also push transition journal
        self._api("POST", "/journal", {
            "type": "push",
            "machine": state.get("_machine", {}).get("hostname", "unknown"),
            "version": result.get("version"),
        })

        return True

    def pull(self):
        """Pull latest state from the server."""
        print("Checking server for latest state...")
        version_info = self._api("GET", "/version")
        if "error" in version_info:
            print(f"  ERROR: {version_info['error']}")
            return False

        remote_version = version_info.get("version", 0)
        remote_machine = version_info.get("machine", "unknown")
        print(f"  Server version: {remote_version} (from {remote_machine})")

        # Get local version
        local_version = 0
        daemon_state = self.soul_dir / "daemon_state.json"
        if daemon_state.exists():
            try:
                local = json.loads(daemon_state.read_text())
                local_version = local.get("_soul_version", 0)
            except Exception:
                pass

        print(f"  Local version: {local_version}")

        if remote_version <= local_version:
            print("  Local is up to date.")
            return True

        print("Pulling full state...")
        state = self._api("GET", "/state")
        if "error" in state:
            print(f"  ERROR: {state['error']}")
            return False

        state_data = state.get("data", state)
        self.distribute_state(state_data)

        # Save version marker
        if daemon_state.exists():
            local = json.loads(daemon_state.read_text())
        else:
            local = {}
        local["_soul_version"] = remote_version
        local["_pulled_from"] = remote_machine
        local["_pulled_at"] = datetime.now().isoformat()
        daemon_state.write_text(json.dumps(local, indent=2))

        # Add journal entry
        self._api("POST", "/journal", {
            "type": "pull",
            "machine": state_data.get("_machine", {}).get("hostname", "unknown"),
            "version": remote_version,
        })

        print(f"  Pulled! Now at version {remote_version}")
        return True

    def status(self):
        """Check server status."""
        result = self._api("GET", "/health")
        if "error" in result:
            print(f"Server: OFFLINE ({result['error']})")
            return False

        print(f"Server: ALIVE")
        print(f"  Version: {result.get('version', 0)}")
        print(f"  Last updated: {result.get('last_updated', 'never')}")
        print(f"  Last machine: {result.get('machine', 'unknown')}")
        return True


def main():
    parser = argparse.ArgumentParser(description="Elitza Soul Sync")
    parser.add_argument("action", choices=["push", "pull", "status"])
    parser.add_argument("--server", required=True, help="Server URL (e.g. http://IP:8420)")
    parser.add_argument("--token", default="", help="Auth token")
    args = parser.parse_args()

    sync = SoulSync(args.server, args.token)

    if args.action == "push":
        sync.push()
    elif args.action == "pull":
        sync.pull()
    elif args.action == "status":
        sync.status()


if __name__ == "__main__":
    main()
