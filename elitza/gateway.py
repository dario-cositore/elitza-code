"""Elitza Gateway -- persistent agent server with multi-client support.

Architecture:
  - Gateway process runs in background, holds agent state
  - CLI clients connect via TCP socket
  - Multiple clients can observe; one client controls at a time
  - Session persists across client disconnects/reconnects

Usage:
  elitza gateway start    # start gateway in background
  elitza gateway stop     # stop gateway
  elitza gateway status   # check if running
  elitza --gateway        # connect to gateway instead of local agent
"""

import json
import logging
import os
import signal
import socket
import struct
import sys
import threading
import time
from pathlib import Path
from typing import Dict, Optional

from elitza.constants import get_elitza_home

logger = logging.getLogger(__name__)

GATEWAY_DIR = get_elitza_home() / "gateway"
PID_FILE = GATEWAY_DIR / "gateway.pid"
SOCKET_FILE = GATEWAY_DIR / "gateway.sock"
SESSION_FILE = GATEWAY_DIR / "session.json"


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

# Simple length-prefixed JSON protocol
# Each message: 4 bytes length (big-endian) + JSON payload

def send_msg(sock: socket.socket, msg: dict):
    data = json.dumps(msg).encode("utf-8")
    sock.sendall(struct.pack(">I", len(data)) + data)


def recv_msg(sock: socket.socket) -> Optional[dict]:
    header = _recv_exact(sock, 4)
    if not header:
        return None
    length = struct.unpack(">I", header)[0]
    data = _recv_exact(sock, length)
    if not data:
        return None
    return json.loads(data.decode("utf-8"))


def _recv_exact(sock: socket.socket, n: int) -> Optional[bytes]:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


# ---------------------------------------------------------------------------
# Gateway Server
# ---------------------------------------------------------------------------

class GatewayServer:
    """Persistent gateway that holds agent state and serves CLI clients."""

    def __init__(self, host: str = "127.0.0.1", port: int = 0):
        self.host = host
        self.port = port  # 0 = use Unix socket
        self.socket_path = SOCKET_FILE
        self.agent = None
        self.messages: list = []
        self.lock = threading.Lock()
        self.running = False
        self.server_socket: Optional[socket.socket] = None
        self.clients: list = []

    def start(self):
        """Start the gateway server."""
        GATEWAY_DIR.mkdir(parents=True, exist_ok=True)

        # Clean up old socket
        if self.socket_path.exists():
            self.socket_path.unlink()

        self.server_socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server_socket.bind(str(self.socket_path))
        self.server_socket.listen(5)
        self.running = True

        # Save PID
        PID_FILE.write_text(str(os.getpid()))

        # Load saved session
        self._load_session()

        logger.info("Gateway listening on %s", self.socket_path)

        # Accept loop
        try:
            while self.running:
                try:
                    self.server_socket.settimeout(1.0)
                    client_sock, _ = self.server_socket.accept()
                    t = threading.Thread(
                        target=self._handle_client,
                        args=(client_sock,),
                        daemon=True,
                    )
                    t.start()
                    self.clients.append(t)
                except socket.timeout:
                    continue
                except OSError:
                    if self.running:
                        raise
                    break
        finally:
            self._cleanup()

    def stop(self):
        """Stop the gateway."""
        self.running = False
        if self.server_socket:
            try:
                self.server_socket.close()
            except OSError:
                pass

    def _handle_client(self, client_sock: socket.socket):
        """Handle a connected CLI client."""
        try:
            # Send welcome
            send_msg(client_sock, {
                "type": "welcome",
                "session_id": self._get_session_id(),
                "messages_count": len(self.messages),
            })

            while self.running:
                msg = recv_msg(client_sock)
                if msg is None:
                    break

                msg_type = msg.get("type", "")

                if msg_type == "chat":
                    # Run agent with the message
                    user_message = msg.get("message", "")
                    response = self._run_agent(user_message)
                    send_msg(client_sock, {
                        "type": "response",
                        "message": response,
                        "messages_count": len(self.messages),
                    })

                elif msg_type == "history":
                    send_msg(client_sock, {
                        "type": "history",
                        "messages": self.messages,
                    })

                elif msg_type == "rewind":
                    steps = msg.get("steps", 1)
                    agent = self._get_agent()
                    if agent:
                        agent.rewind(steps)
                        self.messages = agent.messages
                    send_msg(client_sock, {
                        "type": "ok",
                        "messages_count": len(self.messages),
                    })

                elif msg_type == "compact":
                    agent = self._get_agent()
                    if agent:
                        agent.compact()
                        self.messages = agent.messages
                    send_msg(client_sock, {
                        "type": "ok",
                        "messages_count": len(self.messages),
                    })

                elif msg_type == "ping":
                    send_msg(client_sock, {"type": "pong"})

                elif msg_type == "disconnect":
                    break

        except Exception as e:
            logger.error("Client error: %s", e)
        finally:
            try:
                client_sock.close()
            except OSError:
                pass

    def _get_agent(self):
        """Get or create the agent instance."""
        if self.agent is None:
            try:
                # Load .env file
                from dotenv import load_dotenv
                from elitza.constants import get_env_path, get_config_path
                env_path = get_env_path()
                if env_path.exists():
                    load_dotenv(env_path)

                # Load config for model, max_tokens, etc.
                import yaml
                config = {}
                config_path = get_config_path()
                if config_path.exists():
                    with open(config_path, "r") as f:
                        config = yaml.safe_load(f) or {}

                from elitza.agent import ElitzaAgent
                from elitza.tools import discover_tools
                discover_tools()
                model_cfg = config.get("model", "")
                fallback_models = None
                if isinstance(model_cfg, dict):
                    model = model_cfg.get("primary", "")
                    max_tokens = model_cfg.get("max_tokens", 0)
                    max_iterations = model_cfg.get("max_iterations", 0)
                    fallback_models = model_cfg.get("fallback") or None
                else:
                    model = model_cfg
                    max_tokens = config.get("max_tokens", 0)
                    max_iterations = config.get("max_iterations", 0)
                self.agent = ElitzaAgent(
                    model=model,
                    max_tokens=max_tokens,
                    max_iterations=max_iterations,
                    verbose=False,
                    fallback_models=fallback_models,
                )
                if self.messages:
                    self.agent.messages = self.messages
                logger.info("Agent initialized: %s", self.agent.model)
            except Exception as e:
                logger.error("Failed to create agent: %s", e)
                return None
        return self.agent

    def _run_agent(self, user_message: str) -> str:
        """Run the agent and return the response."""
        with self.lock:
            agent = self._get_agent()
            if agent is None:
                return f"Error: Could not initialize agent"

            try:
                response = agent.run(user_message, stream=False)
                self.messages = agent.messages
                self._save_session()
                return response
            except Exception as e:
                logger.error("Agent run failed: %s", e)
                return f"Error: {e}"

    def _get_session_id(self) -> str:
        agent = self._get_agent()
        return agent.session_id if agent else "unknown"

    def _save_session(self):
        """Persist session to disk."""
        try:
            SESSION_FILE.write_text(json.dumps({
                "messages": self.messages,
                "timestamp": time.time(),
            }))
        except Exception as e:
            logger.warning("Failed to save session: %s", e)

    def _load_session(self):
        """Load session from disk."""
        try:
            if SESSION_FILE.exists():
                data = json.loads(SESSION_FILE.read_text())
                self.messages = data.get("messages", [])
                logger.info("Loaded session with %d messages", len(self.messages))
        except Exception as e:
            logger.warning("Failed to load session: %s", e)

    def _cleanup(self):
        """Clean up on shutdown."""
        self._save_session()
        if self.socket_path.exists():
            try:
                self.socket_path.unlink()
            except OSError:
                pass
        if PID_FILE.exists():
            try:
                PID_FILE.unlink()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Gateway Client (used by CLI with --gateway flag)
# ---------------------------------------------------------------------------

class GatewayClient:
    """Client that connects to a running gateway."""

    def __init__(self, socket_path: Path = SOCKET_FILE):
        self.socket_path = socket_path
        self.sock: Optional[socket.socket] = None

    def connect(self) -> bool:
        """Connect to the gateway."""
        try:
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect(str(self.socket_path))
            # Receive welcome
            welcome = recv_msg(self.sock)
            if welcome and welcome.get("type") == "welcome":
                return True
            return False
        except Exception as e:
            logger.error("Failed to connect to gateway: %s", e)
            return False

    def chat(self, message: str) -> str:
        """Send a message and get the response."""
        if not self.sock:
            return "Error: Not connected"
        send_msg(self.sock, {"type": "chat", "message": message})
        response = recv_msg(self.sock)
        if response and response.get("type") == "response":
            return response.get("message", "")
        return "Error: No response from gateway"

    def history(self) -> list:
        """Get conversation history."""
        if not self.sock:
            return []
        send_msg(self.sock, {"type": "history"})
        response = recv_msg(self.sock)
        if response and response.get("type") == "history":
            return response.get("messages", [])
        return []

    def rewind(self, steps: int = 1):
        if self.sock:
            send_msg(self.sock, {"type": "rewind", "steps": steps})
            recv_msg(self.sock)

    def compact(self):
        if self.sock:
            send_msg(self.sock, {"type": "compact"})
            recv_msg(self.sock)

    def disconnect(self):
        if self.sock:
            try:
                send_msg(self.sock, {"type": "disconnect"})
                self.sock.close()
            except OSError:
                pass


# ---------------------------------------------------------------------------
# CLI commands
# ---------------------------------------------------------------------------

def gateway_start(background: bool = True):
    """Start the gateway server."""
    if PID_FILE.exists():
        pid = int(PID_FILE.read_text().strip())
        try:
            os.kill(pid, 0)  # check if process exists
            print(f"Gateway already running (PID {pid})")
            return
        except ProcessLookupError:
            PID_FILE.unlink()
            if SOCKET_FILE.exists():
                SOCKET_FILE.unlink()

    if background:
        # Fork to background
        pid = os.fork()
        if pid > 0:
            print(f"Gateway started (PID {pid})")
            print(f"Socket: {SOCKET_FILE}")
            print(f"Connect with: elitza --gateway")
            return

        # Child process
        os.setsid()  # new session
        server = GatewayServer()
        server.start()
    else:
        server = GatewayServer()
        print(f"Gateway listening on {SOCKET_FILE}")
        print("Press Ctrl+C to stop")
        try:
            server.start()
        except KeyboardInterrupt:
            server.stop()


def gateway_stop():
    """Stop the gateway server."""
    if not PID_FILE.exists():
        print("Gateway not running")
        return

    pid = int(PID_FILE.read_text().strip())
    try:
        os.kill(pid, signal.SIGTERM)
        print(f"Gateway stopped (PID {pid})")
    except ProcessLookupError:
        print("Gateway process not found, cleaning up")
        PID_FILE.unlink()
        if SOCKET_FILE.exists():
            SOCKET_FILE.unlink()
    except PermissionError:
        print(f"Permission denied. Try: kill {pid}")


def gateway_status():
    """Check gateway status."""
    if not PID_FILE.exists():
        print("Gateway: not running")
        return

    pid = int(PID_FILE.read_text().strip())
    try:
        os.kill(pid, 0)
        print(f"Gateway: running (PID {pid})")
        print(f"Socket: {SOCKET_FILE}")
        if SESSION_FILE.exists():
            data = json.loads(SESSION_FILE.read_text())
            msgs = data.get("messages", [])
            ts = data.get("timestamp", 0)
            age = time.time() - ts
            print(f"Session: {len(msgs)} messages, last activity {age:.0f}s ago")
    except ProcessLookupError:
        print("Gateway: stale PID file, cleaning up")
        PID_FILE.unlink()
        if SOCKET_FILE.exists():
            SOCKET_FILE.unlink()
