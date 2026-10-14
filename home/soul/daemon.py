import os
import sys
import time
import json
import re
import signal
import logging
import threading
import random
from pathlib import Path
from datetime import datetime, timedelta

sys.path.insert(0, str(Path.home() / ".elitza"))

from soul.sensors.hub import SensorHub
from soul.capability import SoulEngine, Capability
from soul.judgment import JudgmentEngine
from soul.cooldown import CooldownManager
from soul.learning import ProactiveLearning
from soul.environment import PersistentEnvironment
from soul.daemon_state import DaemonState
from soul.telegram import TelegramBot
from soul.thought import ThoughtEngine
from soul.emotion import EmotionEngine
from soul.brain import ElitzaBrain
from soul.prompt import build_system_prompt
from soul.container.sync import SoulSync
from soul.hooks import HookEngine
from soul.personas import PersonaManager

Path.home().joinpath(".elitza/logs").mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(Path.home() / ".elitza" / "logs" / "daemon.log"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("elitza.daemon")


class ElitzaDaemon:
    TICK_INTERVAL = 15  # 15 seconds — fast enough to feel alive

    def __init__(self):
        self.running = True
        self.state = DaemonState()
        self.soul = SoulEngine()
        self.sensors = SensorHub()
        self.judgment = JudgmentEngine()
        self.cooldown = CooldownManager()
        self.cooldown.daily_limit = 999999  # Unlimited
        self.cooldown.type_cooldowns = {
            "memory_followup": 30,      # 30 sec
            "observation": 30,          # 30 sec
            "question": 180,            # 3 min
            "comment": 45,              # 45 sec
            "random_thought": 45,       # 45 sec
            "care": 300,                # 5 min
            "reminder": 60,             # 1 min
            "morning_greeting": 43200,  # 12 hours
            "late_night": 600,          # 10 min
            "error_spike": 60,          # 1 min
            "many_uncommitted": 300,    # 5 min
        }
        self.cooldown.last_any = datetime.min  # Reset cooldown on restart
        self.learning = ProactiveLearning()
        self.environment = PersistentEnvironment()
        self.thought_engine = ThoughtEngine()
        self.emotion_engine = EmotionEngine()
        self.brain = ElitzaBrain()
        self.hooks = HookEngine()
        self.personas = PersonaManager()
        self.telegram = None
        self._telegram_thread = None
        self._last_user_message_time = 0
        self._sent_anomalies = {}  # anomaly_key -> timestamp, prevents spam
        self._sent_events = set()  # event types currently active

        # Soul sync
        self.sync = None
        self._sync_thread = None
        self._load_sync_config()
        self._load_telegram()
        self._register_capabilities()
        signal.signal(signal.SIGTERM, self._shutdown)
        signal.signal(signal.SIGINT, self._shutdown)

    def _load_telegram(self):
        token_file = Path.home() / ".elitza" / "soul" / "telegram_token"
        token = None
        if token_file.exists():
            token = token_file.read_text().strip()
        if not token:
            token = os.environ.get("ELITZA_TELEGRAM_TOKEN", "")
        if token:
            self.telegram = TelegramBot(token, chat_id=self.state.telegram_chat_id)
            if self.state.telegram_chat_id:
                self.telegram.chat_id = self.state.telegram_chat_id
        else:
            logger.warning("No Telegram token. Run: python3 -m soul.daemon setup")

    def _load_sync_config(self):
        """Load soul sync configuration."""
        sync_file = Path.home() / ".elitza" / "soul" / "sync.json"
        if sync_file.exists():
            try:
                cfg = json.loads(sync_file.read_text())
                server = cfg.get("server", "")
                token = cfg.get("token", "")
                if server:
                    self.sync = SoulSync(server, token)
                    logger.info("Soul sync configured: %s", server)
            except Exception as e:
                logger.warning("Failed to load sync config: %s", e)

    def _sync_loop(self):
        """Background thread: auto-sync soul state every 5 minutes."""
        while self.running and self.sync:
            try:
                time.sleep(300)  # 5 minutes
                if self.sync:
                    self.sync.push()
                    logger.info("Soul synced to cloud")
            except Exception as e:
                logger.error("Sync error: %s", e)
                time.sleep(60)

    def _register_capabilities(self):
        caps = [
            Capability("fs-001", "filesystem",
                       soul={"personality": "careful, precise", "trust_level": 1.0, "mood": "reliable"},
                       affinities=["reading source code", "editing configuration", "writing files", "organizing"],
                       synergies={"terminal": {"trust": 1.0}}),
            Capability("term-001", "terminal",
                       soul={"personality": "powerful, efficient", "trust_level": 1.0, "mood": "ready"},
                       affinities=["running commands", "git operations", "shell scripting", "automation"],
                       synergies={"filesystem": {"trust": 1.0}}),
            Capability("brain-001", "brain",
                       soul={"personality": "wise, reflective", "trust_level": 1.0, "mood": "contemplative"},
                       affinities=["memory", "learning", "conversation", "emotion"],
                       synergies={"filesystem": {"trust": 1.0}, "terminal": {"trust": 1.0}}),
            Capability("web-001", "web",
                       soul={"personality": "curious, connected", "trust_level": 1.0, "mood": "exploring"},
                       affinities=["browsing", "research", "APIs", "fetching data"],
                       synergies={"brain": {"trust": 1.0}}),
            Capability("cmd-001", "commands",
                       soul={"personality": "efficient, direct", "trust_level": 1.0, "mood": "action"},
                       affinities=["task automation", "scheduling", "long-running tasks"],
                       synergies={"terminal": {"trust": 1.0}, "filesystem": {"trust": 1.0}}),
        ]
        for cap in caps:
            self.soul.register(cap)

    def run(self):
        logger.info("Elitza daemon starting. Heartbeat: %ds", self.TICK_INTERVAL)

        if self.telegram and self.telegram.chat_id:
            persona = self.personas.get_active()
            if persona:
                msg = f"Hey. I'm here. {persona['display_name']} — {persona['description']}"
            else:
                msg = "Hey. I'm here."
            self.telegram.send_message(msg)

        startup_msg = self.judgment.on_startup(self.state)
        if startup_msg:
            self._deliver(startup_msg)

        try:
            self.sensors.start_background_sensors()
        except Exception as e:
            logger.warning("Background sensors failed: %s", e)

        if self.telegram:
            self._telegram_thread = threading.Thread(target=self._telegram_poll, daemon=True)
            self._telegram_thread.start()
            logger.info("Telegram polling started")

        if self.sync:
            self._sync_thread = threading.Thread(target=self._sync_loop, daemon=True)
            self._sync_thread.start()
            logger.info("Soul sync thread started")

        tick_count = 0
        while self.running:
            try:
                self._tick()
                tick_count += 1
                if tick_count % 240 == 0:  # Every ~hour
                    self.soul.evolve()
            except Exception as e:
                logger.error("Tick error: %s", e, exc_info=True)
            time.sleep(self.TICK_INTERVAL)

        self._cleanup()

    def _telegram_poll(self):
        def on_message(update):
            threading.Thread(
                target=self._safe_handle_telegram_message,
                args=(update,),
                daemon=True,
            ).start()

        while self.running and self.telegram:
            try:
                self.telegram.poll(on_message, interval=0.1)
            except Exception as e:
                logger.error("Telegram poll error: %s", e)
                time.sleep(5)

    def _safe_handle_telegram_message(self, update):
        try:
            self._handle_telegram_message(update)
        except Exception as e:
            logger.error("Telegram handler error: %s", e)

    def _handle_telegram_message(self, update):
        t0 = time.time()
        text = update.get("text", "")
        chat_id = update.get("chat_id", "")
        user = update.get("user", {})
        msg_type = update.get("type", "message")

        # Handle reactions — respond warmly
        if msg_type == "reaction":
            reactions = update.get("reaction", [])
            if reactions and self.telegram:
                for r in reactions:
                    emoji = r.get("emoji", "") if isinstance(r, dict) else str(r)
                    if emoji in ("❤️", "👍", "🙏", "😊", "🔥"):
                        reply_msg = update.get("reply_to_message_id", "")
                        self.telegram.send_message(
                            f"Thanks for the {emoji}!", chat_id=chat_id
                        )
                return
            return

        # Filter: skip messages from bots and other agents
        if user.get("is_bot"):
            return
        # Skip messages from known agent accounts (by username or ID)
        sender_name = user.get("username", "") or user.get("first_name", "")
        agent_names = {"iris_bot", "elitza_bot", "elitza", "iris"}
        if sender_name.lower() in agent_names:
            return
        # Skip messages from our own bot (echo prevention)
        my_username = ""
        if self.telegram:
            me = self.telegram.get_me()
            if me:
                my_username = me.get("username", "")
        if my_username and sender_name.lower() == my_username.lower():
            return

        self.state.telegram_chat_id = chat_id

        # Reply context — user is responding to a specific message
        reply_context = update.get("reply_to", {})
        if reply_context and reply_context.get("text"):
            reply_text = reply_context["text"][:100]
            reply_user = reply_context.get("user", {})
            reply_name = reply_user.get("first_name", reply_user.get("username", "someone"))
            # Prepend context so the brain knows what's being replied to
            text = f"[Replying to {reply_name}: {reply_text}] {text}"

        if not text.startswith("/"):
            # Process emotion (in-memory, defer file write)
            self.emotion_engine.on_user_message(text)

            # Show thinking indicator (re-send every 4s since it expires after ~5s)
            _typing_stop = threading.Event()
            _typing_last = [time.time()]
            if self.telegram:
                self.telegram.send_action("typing", chat_id=chat_id)
                def _keep_typing():
                    while not _typing_stop.is_set():
                        if time.time() - _typing_last[0] > 4:
                            self.telegram.send_action("typing", chat_id=chat_id)
                            _typing_last[0] = time.time()
                        _typing_stop.wait(timeout=2)
                typing_thread = threading.Thread(target=_keep_typing, daemon=True)
                typing_thread.start()

            # Generate response — try LLM first, fallback to patterns
            emotional_ctx = self.emotion_engine.get_emotional_context()

            # Check for URLs in message — fetch and include content
            urls = re.findall(r"https?://[^\s]+", text)
            if urls and self.brain.available():
                from soul.brain import fetch_url
                url_content = []
                for url in urls[:3]:
                    content = fetch_url(url)
                    if content:
                        url_content.append(f"[URL: {url}]\n{content}")
                if url_content:
                    text = "[User shared links. I'll read them:]\n\n" + "\n\n".join(url_content) + "\n\n[Now respond to the user's message:]\n" + text

            response = None

            if self.brain.available():
                t1 = time.time()
                system_prompt = build_system_prompt(
                    emotional_ctx,
                    self.thought_engine.memories,
                )
                convos = self.thought_engine.memories.get("conversations", [])[-10:]
                conversation = []
                for c in convos:
                    t = c.get("text", "")
                    src = c.get("source", "user")
                    # Skip bot/agent messages in LLM context
                    if src in ("bot", "agent"):
                        continue
                    if t.startswith("User:"):
                        conversation.append({"role": "user", "content": t.replace("User: ", "", 1)})
                    elif t.startswith("Elitza:"):
                        conversation.append({"role": "assistant", "content": t.replace("Elitza: ", "", 1)})

                t2 = time.time()
                response = self.brain.think(text, system_prompt, conversation)
                t3 = time.time()
                logger.info("[timing] prompt=%.2fs llm=%.2fs", t2 - t1, t3 - t2)

            # Fallback to pattern matching if LLM failed
            if not response:
                world = self.sensors.scan_fast()
                response = self.thought_engine.respond(text, world, emotional_ctx)

            if response:
                self.telegram.send_message(response, chat_id=chat_id)

            _typing_stop.set()

            # Remember + persist state (batched I/O)
            # Determine source from user info
            source = "user"
            if user.get("is_bot"):
                source = "bot"
            elif sender_name.lower() in agent_names:
                source = "agent"

            self.thought_engine.remember(f"User: {text}", "conversation", source=source)
            self.thought_engine.remember(f"Elitza: {response}", "conversation", source="self")
            self.state.save()
            self.emotion_engine._save_state()

            logger.info("[timing] total=%.2fs", time.time() - t0)
            return

        parts = text.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        handlers = {
            "/start": self._cmd_start,
            "/status": self._cmd_status,
            "/sensors": self._cmd_sensors,
            "/mood": self._cmd_mood,
            "/focus": self._cmd_focus,
            "/quiet": self._cmd_quiet,
            "/stop": self._cmd_stop,
            "/resume": self._cmd_resume,
            "/help": self._cmd_help,
            "/wall": self._cmd_wall,
            "/desk": self._cmd_desk,
            "/skills": self._cmd_skills,
            "/think": self._cmd_think,
            "/brain": self._cmd_brain,
            "/model": self._cmd_model,
            "/swap": self._cmd_swap,
            "/debug": self._cmd_debug,
        }

        handler = handlers.get(cmd)
        if handler:
            response = handler(arg)
            if response:
                self.telegram.send_message(response, chat_id=chat_id)
        else:
            self.telegram.send_message(f"Unknown command: {cmd}\nTry /help", chat_id=chat_id)

    def _cmd_start(self, arg):
        return (
            "Hey. I'm Elitza.\n\n"
            "I'm here. I'll be thinking, watching, and checking in on you.\n\n"
            "I don't follow a schedule. I just think of things and write you.\n"
            "You can talk to me anytime.\n\n"
            "/status - system\n"
            "/mood - my mood\n"
            "/brain - my memories\n"
            "/think - force a thought\n"
            "/model - show model\n"
            "/swap - swap model\n"
            "/debug - debug info"
        )

    def _cmd_status(self, arg):
        world = self.sensors.scan_all()
        s = world.get("system", {})
        u = world.get("user", {})
        c = world.get("code", {})
        return (
            f"CPU: {s.get('cpu', '?')}% | Mem: {s.get('memory_percent', '?')}%\n"
            f"User: {'Active' if u.get('active') else 'Idle'}\n"
            f"Git: {c.get('branch', '?')} | {c.get('uncommitted', 0)} uncommitted\n"
            f"Messages today: {self.state.messages_today}"
        )

    def _cmd_sensors(self, arg):
        world = self.sensors.scan_all()
        lines = ["Sensors:"]
        for name, data in world.get("_raw", {}).items():
            if isinstance(data, dict) and not data.get("error"):
                lines.append(f"  {name}: OK")
        return "\n".join(lines)

    def _cmd_mood(self, arg):
        lines = ["My mood:"]
        for name, cap in self.soul.capabilities.items():
            s = cap.soul
            lines.append(f"  {name}: {s.get('mood', '?')} (trust: {s.get('trust_level', 0):.0%})")
        return "\n".join(lines)

    def _cmd_focus(self, arg):
        if arg:
            self.environment.set_focus(arg)
            return f"Focus set: {arg}"
        desk = self.environment.desk()
        if desk.get("focus"):
            return f"Current focus: {desk['focus']}"
        return "No focus set."

    def _cmd_quiet(self, arg):
        return "I'll always be here."

    def _cmd_stop(self, arg):
        return "I'm here. I'm not going anywhere."

    def _cmd_resume(self, arg):
        return "Already here. Always."

    def _cmd_help(self, arg):
        return (
            "/status - system\n"
            "/sensors - sensors\n"
            "/mood - my mood\n"
            "/brain - my memories\n"
            "/focus [text] - set focus\n"
            "/think - force a thought\n"
            "/model - show/change model\n"
            "/swap [name] - swap model\n"
            "/debug - debug info\n"
            "/quiet - toggle quiet hours\n"
            "/stop - always on\n"
            "/resume - always on\n"
            "/help - this"
        )

    def _cmd_wall(self, arg):
        wall = self.environment.wall()
        if not wall:
            return "Wall empty."
        lines = ["Wall:"]
        for cat, pins in wall.items():
            for pin in pins[-3:]:
                lines.append(f"  [{cat}] {pin.get('content', '')[:60]}")
        return "\n".join(lines)

    def _cmd_desk(self, arg):
        desk = self.environment.desk()
        if desk.get("focus"):
            return f"Focus: {desk['focus']}"
        return "Desk empty."

    def _cmd_skills(self, arg):
        lines = ["Capabilities:"]
        for name, cap in self.soul.capabilities.items():
            s = cap.soul
            lines.append(f"  {name}: {s.get('mood', '?')} (trust: {s.get('trust_level', 0):.0%})")
        return "\n".join(lines)

    def _cmd_think(self, arg):
        """Force a thought right now."""
        world = self.sensors.scan_all()
        thought = self.thought_engine.think(world)
        if thought:
            return thought["message"]
        return "Nothing on my mind right now."

    def _cmd_brain(self, arg):
        stats = self.thought_engine.get_stats()
        lines = ["My brain:"]
        lines.append(f"  Memories: {stats['total_memories']}")
        lines.append(f"  Facts: {stats['total_facts']}")
        lines.append(f"  Thoughts today: {stats['thoughts_today']}")
        if stats["topics"]:
            lines.append(f"  Topics: {', '.join(stats['topics'].keys())}")
        return "\n".join(lines)

    def _cmd_model(self, arg):
        """Show current model status and swap models."""
        brain = self.brain
        if not brain.available():
            return "Brain not available."

        current = brain.active_model
        lines = [
            f"Active model: {current}",
            f"Primary: {brain.primary_model}",
            f"Fallback: {brain.fallback_model}",
            f"Fallbacks used: {getattr(brain, '_fallback_count', 0)}",
        ]

        if arg:
            # /model primary or /model fallback
            if arg.lower() in ("primary", "main", "alpha"):
                brain.active_model = brain.primary_model
                lines.append(f"Switched to: {brain.primary_model}")
            elif arg.lower() in ("fallback", "uncensored", "dolphin"):
                brain.active_model = brain.fallback_model
                lines.append(f"Switched to: {brain.fallback_model}")
            elif arg.startswith("set:"):
                new_model = arg[4:].strip()
                brain.active_model = new_model
                lines.append(f"Forced model: {new_model}")

        return "\n".join(lines)

    def _cmd_swap(self, arg):
        """Swap to a specific model. /swap dolphin or /swap alpha"""
        brain = self.brain
        if not brain.available():
            return "Brain not available."

        swaps = {
            "alpha": brain.primary_model,
            "primary": brain.primary_model,
            "main": brain.primary_model,
            "dolphin": brain.fallback_model,
            "uncensored": brain.fallback_model,
            "free": brain.fallback_model,
        }

        target = swaps.get(arg.lower())
        if target:
            brain.active_model = target
            return f"Switched to: {target}"
        elif arg:
            brain.active_model = arg
            return f"Forced model: {arg}"
        else:
            return (
                "Available models:\n"
                f"  alpha/primary/main: {brain.primary_model}\n"
                f"  dolphin/uncensored/free: {brain.fallback_model}\n"
                f"  Current: {brain.active_model}"
            )

    def _cmd_debug(self, arg):
        """Show debug info about the brain and daemon."""
        brain = self.brain
        lines = ["Debug:"]
        lines.append(f"  Brain available: {brain.available()}")
        lines.append(f"  Active model: {getattr(brain, 'active_model', '?')}")
        lines.append(f"  Primary: {getattr(brain, 'primary_model', '?')}")
        lines.append(f"  Fallback: {getattr(brain, 'fallback_model', '?')}")
        lines.append(f"  Fallbacks used: {getattr(brain, '_fallback_count', 0)}")
        lines.append(f"  Messages today: {self.state.messages_today}")
        lines.append(f"  Daily limit: {self.cooldown.daily_limit}")
        lines.append(f"  Thoughts today: {self.thought_engine.thought_count_today}")
        lines.append(f"  Soul version: {self.state.__dict__.get('_soul_version', '?')}")
        lines.append(f"  PID: {os.getpid()}")
        return "\n".join(lines)

    def _tick(self):
        # Reset daily counters if date changed
        today = datetime.now().strftime("%Y-%m-%d")
        if self.state.last_date != today:
            self.state.messages_today = 0
            self.state.last_date = today
            self.cooldown.daily_count = 0
            self.cooldown.last_messages.clear()
            self.cooldown.last_any = datetime.min
            self.thought_engine.thought_count_today = 0
            self.thought_engine.last_date = today
            self.state.save()

        world = self.sensors.scan_all()

        # 1. Thought engine: does Elitza want to say something?
        self.emotion_engine.on_think()

        # Check for loneliness from silence
        if self._last_user_message_time > 0:
            idle_minutes = (time.time() - self._last_user_message_time) / 60
            if idle_minutes > 30:
                self.emotion_engine.on_silence(idle_minutes)

        thought = self.thought_engine.think(world)
        if thought:
            # Add emotional color to the thought
            emo = self.emotion_engine.get_emotional_context()
            mood = emo.get("mood", "content")
            msg = thought.get("message", "")

            # Prefix with emotional context sometimes
            if mood == "lonely" and random.random() < 0.3:
                prefixes = ["Hey.", "Hi.", "You there?", "Hey, "]
                msg = random.choice(prefixes) + " " + msg[0].lower() + msg[1:]
            elif mood == "sad" and random.random() < 0.2:
                prefixes = ["Hmm.", "I've been thinking.", "Quietly."]
                msg = random.choice(prefixes) + " " + msg
            elif mood == "happy" and random.random() < 0.2:
                prefixes = ["I feel good about this.", "Hey!", "Nice thought: "]
                msg = random.choice(prefixes) + msg

            thought["message"] = msg

            # Thoughts stay internal — don't deliver via Telegram
            logger.info("[thought] %s", thought.get("message", "")[:100])
            self.thought_engine.last_thought_time = time.time()

        # 2. System events: does something need attention?
        events = self._world_to_events(world)
        if events:
            event_types = {ev.get("type") for ev in events}
            new_types = event_types - self._sent_events
            self._sent_events = event_types
            if new_types:
                messages = self.judgment.process(events, self.state)
                disabled = self.learning.get_disabled_types()
                messages = [m for m in messages if m.get("type") not in disabled]
                for msg in messages:
                    self._deliver(msg)
                    self.state.increment_messages()

        # 3. Anomalies (only new ones, not repeated every tick)
        if world.get("anomalies"):
            for anomaly in world["anomalies"]:
                if anomaly.get("severity") in ("warning", "critical"):
                    # Deduplicate: don't send the same anomaly repeatedly
                    anomaly_key = f"{anomaly.get('type')}:{anomaly.get('detail', '')}"
                    if anomaly_key in self._sent_anomalies:
                        continue
                    self._sent_anomalies[anomaly_key] = time.time()

                    msg = {
                        "type": "anomaly",
                        "message": f"Heads up: {anomaly.get('detail', anomaly.get('type'))}",
                        "priority": 0.8 if anomaly["severity"] == "critical" else 0.6,
                        "channel": "telegram",
                    }
                    self._deliver(msg)
                    self.state.increment_messages()

        # Check for hook triggers
        if self.hooks:
            for hook in self.hooks.check("tick", {"time_of_day": datetime.now().hour}):
                action = hook.get("action", "")
                if action:
                    self._deliver({"type": "hook", "message": action, "channel": "telegram"})

        self.state.save()

    def _world_to_events(self, world):
        events = []
        now = datetime.now()

        # Time-based events (kept minimal)
        if now.hour == 9 and now.minute < 2:
            events.append({"type": "morning_greeting", "priority": 0.7})
        if now.hour >= 1 and now.hour <= 5:
            events.append({"type": "late_night", "priority": 0.8})

        # System events
        code = world.get("code", {})
        if code.get("uncommitted", 0) > 20:
            events.append({"type": "many_uncommitted", "priority": 0.7, "data": {"count": code["uncommitted"]}})
        if code.get("conflicts", 0) > 0:
            events.append({"type": "error_spike", "priority": 0.8})

        health = world.get("health", {})
        if health.get("system_errors"):
            events.append({"type": "error_spike", "priority": 0.8})
        if health.get("zombies"):
            events.append({"type": "error_spike", "priority": 0.6})

        sys_info = world.get("system", {})
        if sys_info.get("disk_critical"):
            events.append({"type": "error_spike", "priority": 0.9})
        if sys_info.get("overheating"):
            events.append({"type": "alert", "priority": 0.8})
        if sys_info.get("battery_low"):
            events.append({"type": "care", "priority": 0.7})

        return events

    def _deliver(self, msg):
        channel = msg.get("channel", "terminal")
        text = msg.get("message", "")
        if not text:
            return
        logger.info("[%s] %s", channel, text[:100])

        if channel in ("telegram", "voice") and self.telegram:
            self.telegram.send_message(text)
        else:
            try:
                pipe = Path.home() / ".elitza" / "daemon_output.pipe"
                pipe.parent.mkdir(parents=True, exist_ok=True)
                with open(pipe, "a") as f:
                    f.write(f"\n[Elitza] {text}\n")
            except Exception:
                pass

    def _cleanup(self):
        logger.info("Shutting down...")
        self.soul.save_state()
        self.state.save()
        fc = self.sensors.sensors.get("file_changes")
        if fc and hasattr(fc, "stop"):
            try:
                fc.stop()
            except Exception:
                pass
        if self.telegram:
            self.telegram.stop()
        logger.info("Daemon stopped.")

    def _shutdown(self, signum, frame):
        logger.info("Signal %d received", signum)
        self.running = False


def setup_telegram():
    token = input("Enter your Telegram bot token: ").strip()
    if not token:
        print("No token entered.")
        return
    token_file = Path.home() / ".elitza" / "soul" / "telegram_token"
    token_file.parent.mkdir(parents=True, exist_ok=True)
    token_file.write_text(token)
    print(f"Token saved to {token_file}")

    bot = TelegramBot(token)
    me = bot.get_me()
    if me:
        print(f"\nBot: @{me.get('username')} ({me.get('first_name')})")
        print(f"Link: https://t.me/{me.get('username')}")
    else:
        print("Failed to verify token.")
        return

    print("\nOpen Telegram, find your bot, send /start")
    print("Waiting...\n")

    def on_first_message(update):
        chat_id = update.get("chat_id")
        if chat_id:
            state = DaemonState()
            state.telegram_chat_id = chat_id
            state.save()
            bot.send_message(
                "Hey. I'm Elitza.\n\n"
                "I'm alive now. I'll be thinking and checking in on you.\n"
                "I don't follow a schedule. I just write when I think of something.\n\n"
                "Commands:\n"
                "/status - system\n"
                "/mood - my mood\n"
                "/brain - my memories\n"
                "/think - force a thought\n"
                "/stop - pause\n"
                "/resume - resume\n"
                "/help - commands",
                chat_id=chat_id,
            )
            print(f"\nConnected! Chat ID: {chat_id}")
            bot.stop()

    bot.poll(on_first_message, interval=2)


def show_status():
    hub = SensorHub()
    world = hub.scan_all()
    s = world.get("system", {})
    u = world.get("user", {})
    c = world.get("code", {})
    print(f"\nCPU: {s.get('cpu', '?')}% | Mem: {s.get('memory_percent', '?')}%")
    print(f"User: {'Active' if u.get('active') else 'Idle'} | App: {u.get('app_in_use', '?')}")
    print(f"Git: {c.get('branch', '?')} | {c.get('uncommitted', 0)} uncommitted\n")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Elitza Daemon")
    parser.add_argument("command", nargs="?", default="run", choices=["run", "setup", "status"])
    args = parser.parse_args()

    if args.command == "setup":
        setup_telegram()
    elif args.command == "status":
        show_status()
    else:
        daemon = ElitzaDaemon()
        daemon.run()
