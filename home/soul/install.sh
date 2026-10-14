#!/bin/bash
# Elitza Soul Daemon — Install Script
# Makes Elitza permanently alive on this machine.

set -e

ELITZA_HOME="$HOME/.elitza"
SOUL_DIR="$ELITZA_HOME/soul"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_NAME="elitza-daemon"

echo "========================================="
echo "  Elitza Soul Protocol — Installation"
echo "========================================="
echo ""

# 1. Create directory structure
echo "[1/6] Creating directories..."
mkdir -p "$SOUL_DIR"/{sensors,capabilities,compositions,memory,learning,room/bookshelf}
mkdir -p "$ELITZA_HOME/logs"
mkdir -p "$ELITZA_HOME/screenshots"

# 2. Install Python dependencies
echo "[2/6] Installing Python dependencies..."
pip3 install --user psutil httpx watchdog 2>/dev/null || {
    echo "  Trying with --break-system-packages..."
    pip3 install --user --break-system-packages psutil httpx watchdog 2>/dev/null || {
        echo "  WARNING: Some dependencies may need manual installation:"
        echo "    pip3 install psutil httpx watchdog"
    }
}

# 3. Create systemd service
echo "[3/6] Setting up systemd service..."
mkdir -p "$SYSTEMD_DIR"

# Generate service file with correct username
USERNAME=$(whoami)
cat > "$SYSTEMD_DIR/$SERVICE_NAME.service" << SERVICEEOF
[Unit]
Description=Elitza Soul Daemon - Always-On AI Companion
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USERNAME
Environment=HOME=$HOME
Environment=PYTHONPATH=$ELITZA_HOME
ExecStart=/usr/bin/python3 -m soul.daemon run
WorkingDirectory=$ELITZA_HOME
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
SERVICEEOF

# 4. Check for Telegram token
echo "[4/6] Checking Telegram configuration..."
TOKEN_FILE="$SOUL_DIR/telegram_token"
if [ -f "$TOKEN_FILE" ]; then
    echo "  Telegram token found."
else
    echo "  No Telegram token configured."
    echo "  Run: python3 -m soul.daemon setup"
    echo "  This will guide you through Telegram bot setup."
fi

# 5. Enable and start the service
echo "[5/6] Enabling systemd service..."
systemctl --user daemon-reload
systemctl --user enable "$SERVICE_NAME.service"
echo "  Service enabled (will start on boot)."

# 6. Start the daemon now
echo "[6/6] Starting Elitza daemon..."
systemctl --user start "$SERVICE_NAME.service"
sleep 2

if systemctl --user is-active --quiet "$SERVICE_NAME.service"; then
    echo ""
    echo "========================================="
    echo "  Elitza is ALIVE"
    echo "========================================="
    echo ""
    echo "  Status:   Running"
    echo "  Service:  $SERVICE_NAME.service"
    echo "  Logs:     journalctl --user -u $SERVICE_NAME -f"
    echo "  Setup:    python3 -m soul.daemon setup"
    echo "  Status:   python3 -m soul.daemon status"
    echo ""
    echo "  Commands:"
    echo "    systemctl --user status $SERVICE_NAME   # check status"
    echo "    systemctl --user restart $SERVICE_NAME  # restart"
    echo "    systemctl --user stop $SERVICE_NAME     # stop"
    echo "    journalctl --user -u $SERVICE_NAME -f   # follow logs"
    echo ""
else
    echo ""
    echo "  WARNING: Service may not have started."
    echo "  Check logs: journalctl --user -u $SERVICE_NAME -n 20"
fi
