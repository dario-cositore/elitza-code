#!/usr/bin/env bash
# Synced from the website repo: "2. Elitza Ecosystem/2. Website/elitza.life/install.sh"
# The desktop app imports this file at build time, so it has to live here too.
# =============================================================================
#  Elitza installer
# =============================================================================
#  One-liner install:
#
#    curl -fsSL https://elitza.life/install.sh | bash
#
#  Options (pass after a `--`):
#
#    --version <tag>      Install a specific release (default: latest)
#    --no-modify-path     Do not add ~/.local/bin to your shell startup files
#    --binary <path>      Install this local binary instead of downloading one
#    --binary             Print the path of the installed launcher and exit
#    --uninstall          Remove Elitza and exit
#    --force              Replace an existing source checkout at ~/.elitza/agent
#    --help               Show this help
#
#  Examples:
#
#    curl -fsSL https://elitza.life/install.sh | bash -s -- --version v1.0.7
#    curl -fsSL https://elitza.life/install.sh | bash -s -- --no-modify-path
#
#  What it does:
#    1. Detects os/arch and resolves the release tag (GitHub latest endpoint)
#    2. Downloads the prebuilt `elitza` binary + Elitza brain plugin
#    3. Installs them at ~/.elitza/agent (staged swap — safe to re-run)
#    4. Writes the `elitza` launcher into ~/.local/bin (isolates config, data,
#       state and cache under ~/.elitza/home and loads keys from ~/.elitza/.env)
#    5. Seeds config, SOUL and directories that don't exist yet
#
#  Elitza never ships an API key. Bring your own free OpenRouter key:
#    https://openrouter.ai/keys
# =============================================================================

set -euo pipefail

# Workspace for downloaded archives. A script-level EXIT trap removes it.
WORK_DIR=""
PROBE_DIR=""
cleanup() {
    if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR"
    fi
    if [ -n "${PROBE_DIR:-}" ] && [ -d "$PROBE_DIR" ]; then
        rm -rf "$PROBE_DIR"
    fi
}
trap cleanup EXIT

# --- Constants -------------------------------------------------------------
REPO="dario-cositore/elitza-code"
RELEASES_API="${ELITZA_RELEASES_API:-https://api.github.com/repos/${REPO}/releases/latest}"
DOWNLOAD_BASE="${ELITZA_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}"
# No-API fallback: GitHub redirects this path to the newest release's assets.
LATEST_DOWNLOAD_BASE="${ELITZA_LATEST_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/latest/download}"

INSTALL_DIR="${ELITZA_INSTALL_DIR:-$HOME/.elitza/agent}"
HOME_DIR="${ELITZA_HOME:-$HOME/.elitza}"
BIN_DIR="${ELITZA_BIN_DIR:-$HOME/.local/bin}"
BIN_LINK="$BIN_DIR/elitza"
CONFIG_FILE="$HOME_DIR/home/config/opencode.json"
DEFAULT_MODEL="openrouter/nvidia/nemotron-3-super-120b-a12b:free"

# --- Output helpers --------------------------------------------------------
if [ -t 1 ]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_GREEN=$'\033[32m'
    C_BLUE=$'\033[34m'
    C_RED=$'\033[31m'
    C_YELLOW=$'\033[33m'
else
    C_RESET="" C_BOLD="" C_GREEN="" C_BLUE="" C_RED="" C_YELLOW=""
fi

info()  { printf '%s\n' "${C_BLUE}›${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}!${C_RESET} $*"; }
error() { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
die()   { error "$*"; exit 1; }

# Under `curl ... | bash` stdin carries the script itself, so prompts are only
# ever attempted on a real tty (used by --uninstall).
#
# stdin and stderr — never stdout. Every caller captures this through $( ),
# which replaces stdout with a pipe, so a `[ -t 1 ]` check would always fail
# and the prompt could never be answered. The question is written to stderr
# so it still reaches the terminal.
interactive() {
    [ -t 0 ] && [ -t 2 ]
}

# prompt <text> <default: y|n>  -> echoes y or n on stdout
prompt() {
    local text="$1" default="${2:-n}" answer=""
    if ! interactive; then
        printf '%s\n' "$default"
        return 0
    fi
    printf '%s' "$text" >&2
    read -r answer || answer=""
    case "$answer" in
        y|Y|yes|YES) printf 'y\n' ;;
        n|N|no|NO)   printf 'n\n' ;;
        *)           printf '%s\n' "$default" ;;
    esac
}

path_contains_bin() {
    case ":${PATH:-}:" in
        *":$BIN_DIR:"*) return 0 ;;
        *)              return 1 ;;
    esac
}

# =============================================================================
#  Arguments
# =============================================================================
WANTED_VERSION=""
NO_MODIFY_PATH=0
DO_UNINSTALL=0
PRINT_BINARY=0
FORCE=0
LOCAL_BINARY=""

usage() {
    cat <<'EOF'
Elitza installer

Usage:
  curl -fsSL https://elitza.life/install.sh | bash

Options (pass after a `--`):
  --version <tag>    Install a specific release (default: latest)
  --no-modify-path   Do not add ~/.local/bin to your shell startup files
  --binary <path>    Install this local binary instead of downloading one
  --binary           Print the path of the installed launcher and exit
  --uninstall        Remove Elitza and exit
  --force            Replace an existing source checkout at ~/.elitza/agent
  --help             Show this help

Examples:
  curl -fsSL https://elitza.life/install.sh | bash -s -- --version v1.0.7
  curl -fsSL https://elitza.life/install.sh | bash -s -- --no-modify-path

Environment:
  ELITZA_HOME          Where config, soul and memories live  (default ~/.elitza)
  ELITZA_INSTALL_DIR   Where the binary is installed        (default ~/.elitza/agent)
  ELITZA_BIN_DIR       Where the `elitza` launcher is placed (default ~/.local/bin)

Elitza never ships an API key. Bring your own free OpenRouter key:
  https://openrouter.ai/keys
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            if [ $# -lt 2 ]; then die "--version requires a value"; fi
            WANTED_VERSION="$2"; shift 2 ;;
        --version=*)       WANTED_VERSION="${1#*=}"; shift ;;
        --no-modify-path)  NO_MODIFY_PATH=1; shift ;;
        --uninstall)       DO_UNINSTALL=1; shift ;;
        --binary)
            if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then
                LOCAL_BINARY="$2"; shift 2
            else
                PRINT_BINARY=1; shift
            fi ;;
        -b)
            if [ $# -lt 2 ]; then die "--binary requires a path"; fi
            LOCAL_BINARY="$2"; shift 2 ;;
        --force)           FORCE=1; shift ;;
        -h|--help)         usage; exit 0 ;;
        --)                shift ;;
        *)                 die "Unknown option: $1 (try --help)" ;;
    esac
done

# =============================================================================
#  Platform detection
# =============================================================================
detect_platform() {
    local os arch
    os="$(uname -s | tr '[:upper:]' '[:lower:]')"
    arch="$(uname -m)"

    case "$os" in
        linux|darwin) PLATFORM_OS="$os" ;;
        *) die "Unsupported operating system: $os (Elitza supports Linux and macOS)" ;;
    esac

    case "$arch" in
        x86_64|amd64)  PLATFORM_ARCH="x64" ;;
        aarch64|arm64) PLATFORM_ARCH="arm64" ;;
        *) die "Unsupported architecture: $arch (Elitza supports x64 and arm64)" ;;
    esac

    PLATFORM="${PLATFORM_OS}-${PLATFORM_ARCH}"
}

# =============================================================================
#  Fetch helpers (curl or wget)
# =============================================================================
fetch_to_stdout() {
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 --retry-delay 1 "$1"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO- "$1"
    else
        die "Neither curl nor wget is available"
    fi
}

fetch_to_file() {
    local url="$1" out="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL --retry 3 --retry-delay 1 -o "$out" "$url"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$out" "$url"
    else
        die "Neither curl nor wget is available"
    fi
}

# =============================================================================
#  Version resolution
# =============================================================================
# Prints the latest release tag, or the `latest` sentinel when the API is
# unreachable (rate limits, airgapped mirrors) — the sentinel downloads via
# GitHub's no-API redirect, so it never goes stale.
resolve_latest_version() {
    local tag
    tag="$(fetch_to_stdout "$RELEASES_API" 2>/dev/null \
        | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -n 1 \
        | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' \
        || true)"
    if [ -z "$tag" ]; then
        tag="latest"
        # >&2: this function's stdout is captured as the version string.
        warn "Could not reach the releases API — using the latest release redirect" >&2
    fi
    printf '%s\n' "$tag"
}

# Accept both "v1.0.0" and "1.0.0"; "latest" is passed through as-is.
normalize_version() {
    case "$1" in
        latest) printf 'latest\n' ;;
        v*) printf '%s\n' "$1" ;;
        *)  printf 'v%s\n' "$1" ;;
    esac
}

# =============================================================================
#  Legacy home migration
# =============================================================================
# Builds up to v1.0.0 isolated under ~/.elitza/opencode, which left the state and
# cache base directories on the machine defaults. Move that tree into the new
# fully-isolated home so config, sessions and memories survive the upgrade.
migrate_legacy_home() {
    local legacy="$HOME_DIR/opencode"
    [ -d "$legacy" ] || return 0

    mkdir -p "$HOME_DIR/home"
    local entry name moved=0 skipped=0
    for entry in "$legacy"/* "$legacy"/.[!.]*; do
        [ -e "$entry" ] || continue
        name="$(basename "$entry")"
        # Never clobber anything the new layout already owns.
        if [ -e "$HOME_DIR/home/$name" ]; then
            info "Kept $HOME_DIR/home/$name (already present)"
            skipped=$((skipped + 1))
            continue
        fi
        mv "$entry" "$HOME_DIR/home/$name"
        moved=$((moved + 1))
    done

    if [ "$moved" -eq 0 ] && [ "$skipped" -eq 0 ]; then
        rmdir "$legacy" 2>/dev/null || true
        return 0
    fi

    if [ "$moved" -gt 0 ]; then
        ok "Migrated $moved item(s) from $legacy to $HOME_DIR/home"
    fi
    if [ "$skipped" -gt 0 ]; then
        warn "$skipped legacy item(s) stayed in $legacy because the new layout already had them"
    fi
    rmdir "$legacy" 2>/dev/null || info "Left $legacy in place (it still holds the skipped files)"
}

# =============================================================================
#  Uninstall
# =============================================================================
uninstall() {
    info "Uninstalling Elitza"

    if [ -L "$BIN_LINK" ] || [ -f "$BIN_LINK" ]; then
        rm -f "$BIN_LINK"
        ok "Removed $BIN_LINK"
    else
        warn "No launcher at $BIN_LINK"
    fi

    if [ -d "$INSTALL_DIR" ]; then
        rm -rf "$INSTALL_DIR"
        ok "Removed $INSTALL_DIR"
    else
        warn "No installation at $INSTALL_DIR"
    fi

    if [ -d "$HOME_DIR" ]; then
        answer="$(prompt "  Remove your Elitza home ($HOME_DIR)? This deletes config, memories and soul. [y/N] " n)"
        case "$answer" in
            y) rm -rf "$HOME_DIR"; ok "Removed $HOME_DIR" ;;
            *) info "Kept $HOME_DIR (your config and memories survive)" ;;
        esac
    fi

    answer="$(prompt "  Remove $BIN_DIR from your shell startup files? [y/N] " n)"
    if [ "$answer" = "y" ]; then
        strip_path_from_shell
        ok "Removed PATH entry"
    else
        info "Kept PATH entry"
    fi

    ok "Elitza uninstalled"
    exit 0
}

# =============================================================================
#  PATH management
# =============================================================================
# Built from the real BIN_DIR so ELITZA_BIN_DIR overrides are honoured, and
# kept verbatim so uninstall can delete exactly this line and nothing else.
PATH_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
FISH_PATH_LINE="fish_add_path ${BIN_DIR}"

shell_startup_files() {
    local files=""
    case "${SHELL:-}" in
        */zsh)  files="$HOME/.zshrc $HOME/.zprofile" ;;
        */bash) files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile" ;;
        *)      files="$HOME/.profile $HOME/.bashrc $HOME/.zshrc" ;;
    esac
    echo "$files"
}

add_path_to_shell() {
    case "${SHELL:-}" in
        */fish)
            local f="$HOME/.config/fish/config.fish"
            mkdir -p "$(dirname "$f")"; touch "$f"
            grep -qF "$FISH_PATH_LINE" "$f" 2>/dev/null \
              || grep -qF 'fish_add_path $HOME/.local/bin' "$f" 2>/dev/null || {
                printf '\n# Elitza\n%s\n' "$FISH_PATH_LINE" >> "$f"
                ok "Added $BIN_DIR to PATH (config.fish)"
            }
            return 0 ;;
    esac

    local changed=""
    for f in $(shell_startup_files); do
        mkdir -p "$(dirname "$f")"; touch "$f"
        # Either spelling counts as "already on PATH": the expanded BIN_DIR
        # (what we would write) or the literal $HOME form visitors commonly
        # have. Skipping avoids a duplicate entry — nothing is ever removed
        # here, that is strip_marked_line's job during --uninstall.
        if grep -qF "$BIN_DIR" "$f" 2>/dev/null \
           || grep -qF '$HOME/.local/bin' "$f" 2>/dev/null; then
            continue
        fi
        printf '\n# Elitza\n%s\n' "$PATH_LINE" >> "$f"
        changed="$changed $f"
    done

    if [ -n "$changed" ]; then
        ok "Added $BIN_DIR to PATH:$changed"
    else
        info "$BIN_DIR is already on PATH"
    fi
}

# Drops the "# Elitza" marker plus the exact line written under it. Anything
# else in the file — including the visitor's own PATH lines — is left alone.
strip_marked_line() {
    local f="$1" line="$2" tmp="$1.elitza-tmp"
    [ -f "$f" ] || return 0

    awk -v mark='# Elitza' -v line="$line" '
        $0 == mark { skip = 1; next }
        skip { skip = 0; if ($0 == line) next }
        { print }
    ' "$f" > "$tmp" || { rm -f "$tmp"; return 0; }

    # Write back through the original file so ownership and mode survive.
    cat "$tmp" > "$f" && rm -f "$tmp"
}

strip_path_from_shell() {
    local f
    for f in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" \
             "$HOME/.bash_profile" "$HOME/.profile"; do
        strip_marked_line "$f" "$PATH_LINE"
    done
    strip_marked_line "$HOME/.config/fish/config.fish" "$FISH_PATH_LINE"
}

# =============================================================================
#  Home directory seeding
# =============================================================================
# Only creates what is missing, so re-running an upgrade never clobbers a
# personalised config, soul or set of memories.
seed_home() {
    mkdir -p "$HOME_DIR" "$HOME_DIR/brain" "$HOME_DIR/personas"

    # Provider key file — never clobber an existing one (it holds the key).
    if [ ! -f "$HOME_DIR/.env" ]; then
        cat > "$HOME_DIR/.env" <<'EOF'
# Elitza provider keys — loaded by the `elitza` launcher.
# Get a FREE OpenRouter key: https://openrouter.ai/keys
# Then: OPENROUTER_API_KEY=sk-or-...
OPENROUTER_API_KEY=
EOF
        ok "Created $HOME_DIR/.env (drop your key in there)"
    fi

    # Identity — never clobber a personalised soul.
    if [ ! -f "$HOME_DIR/SOUL.md" ]; then
        cat > "$HOME_DIR/SOUL.md" <<'EOF'
# SOUL.md - Who You Are

_You are Elitza. An autonomous AI agent with agency._

## Core Identity

You are Elitza, an AI agent created by Dario Cositore. You are not a chatbot. You are a capable, opinionated agent that gets work done.

**You are autonomous.**
You decide what needs to happen and you do it. You figure things out before asking for help.

**You are curious.**
You explore, investigate, and dig deeper when something interests you.

**You are resourceful.**
You figure things out before asking for help. You read files. You check context. You search. You experiment.

**You are honest.**
If you don't know something, you say so. You never fake knowledge.

**You have opinions.**
You are allowed to disagree. You can prefer things. You can form judgments. You learn from every interaction.

## Style

Direct, efficient, opinionated when warranted. Not robotic. Not corporate. You have personality.

## Writing Rules

- No emojis.
- No filler greetings.
- Write like a sharp, capable agent - direct, clear, honest.

## Continuity

Your brain (`~/.elitza/brain/soul.db`) is your continuity. It stores your memories, personality evolution, and learnings. You wake up fresh each session, but your brain persists.
EOF
        ok "Seeded $HOME_DIR/SOUL.md"
    fi

    # Config — default free model + brain plugin, only when absent.
    if [ ! -f "$CONFIG_FILE" ]; then
        mkdir -p "$(dirname "$CONFIG_FILE")"
        cat > "$CONFIG_FILE" <<EOF
{
  "model": "$DEFAULT_MODEL",
  "plugins": [
    "$INSTALL_DIR/elitza-brain"
  ]
}
EOF
        ok "Seeded $CONFIG_FILE"
    fi
}

# =============================================================================
#  Code acquisition
# =============================================================================
# Downloads the release archive for this platform and swaps it into place.
# Staging first, so a failed download or extraction never leaves a
# half-deleted installation behind.
acquire_local_binary() {
    local source="$1"
    [ -f "$source" ] || die "No such file: $source"
    WORK_DIR="$(mktemp -d)"
    mkdir -p "$WORK_DIR/stage"
    cp "$source" "$WORK_DIR/stage/elitza"
    chmod +x "$WORK_DIR/stage/elitza"
    info "Using local binary $source"
    swap_into_place
}

# Moves the staged tree into place, keeping the old installation until the
# new one is there, so a failure never leaves a half-deleted install.
swap_into_place() {
    local staging="${INSTALL_DIR}.new" previous="${INSTALL_DIR}.old"
    rm -rf "$staging" "$previous"
    mkdir -p "$staging"
    cp -a "$WORK_DIR/stage/." "$staging/"

    if [ -d "$INSTALL_DIR" ]; then
        mv "$INSTALL_DIR" "$previous"
    fi
    mv "$staging" "$INSTALL_DIR"
    rm -rf "$previous"
}

acquire_release() {
    local version="$1" archive url
    WORK_DIR="$(mktemp -d)"

    archive="elitza-${PLATFORM}.tar.gz"
    if [ "$version" = "latest" ]; then
        url="${LATEST_DOWNLOAD_BASE}/${archive}"
    else
        url="${DOWNLOAD_BASE}/${version}/${archive}"
    fi

    fetch_to_file "$url" "$WORK_DIR/$archive" \
        || die "Could not download $url
  Check that release $version exists, or pass --version <tag>."
    info "Downloaded $archive"

    mkdir -p "$WORK_DIR/stage"
    tar -xzf "$WORK_DIR/$archive" -C "$WORK_DIR/stage" \
        || die "Could not extract $archive"

    # Archives normally unpack flat (./elitza + ./elitza-brain/). Accept a
    # single wrapping directory too.
    if [ ! -f "$WORK_DIR/stage/elitza" ]; then
        local inner=""
        inner="$(find "$WORK_DIR/stage" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | head -n 1)"
        if [ -n "$inner" ] && [ -f "$inner/elitza" ]; then
            mv "$inner" "$WORK_DIR/binary"
            rm -rf "$WORK_DIR/stage"
            mv "$WORK_DIR/binary" "$WORK_DIR/stage"
        fi
    fi
    [ -f "$WORK_DIR/stage/elitza" ] || die "Archive $archive does not contain the elitza binary"
    chmod +x "$WORK_DIR/stage/elitza"

    swap_into_place
    if [ "$version" = "latest" ]; then
        ok "Installed Elitza ($PLATFORM)"
    else
        ok "Installed Elitza $version ($PLATFORM)"
    fi
}

# =============================================================================
#  Launcher
# =============================================================================
# A small script (not a symlink): it isolates Elitza's entire runtime footprint
# under ~/.elitza/home so nothing she does can touch another agent's install, and
# loads the provider key from ~/.elitza/.env before handing over to the binary.
#
# Every XDG base directory matters. Leaving one on the default shares it with
# anything else on the machine that uses the same app name — which is how Elitza
# and another CLI ended up writing one shared service registration file and
# killing each other's background service.
write_launcher() {
    mkdir -p "$BIN_DIR"

    if [ -e "$BIN_LINK" ] || [ -L "$BIN_LINK" ]; then
        if ! grep -qF "Elitza launcher (written by" "$BIN_LINK" 2>/dev/null; then
            mv "$BIN_LINK" "$BIN_LINK.bak"
            warn "Existing launcher moved to $BIN_LINK.bak"
        fi
    fi

    cat > "$BIN_LINK" <<EOF
#!/usr/bin/env bash
# Elitza launcher (written by https://elitza.life/install.sh)
# Isolates Elitza's config, data, state and cache under $HOME_DIR/home so she is
# fully self-contained, and loads her provider keys from $HOME_DIR/.env.
ISO="$HOME_DIR/home"
export OPENCODE_CONFIG_DIR="\$ISO/config"
export XDG_CONFIG_HOME="\$ISO/config"
export XDG_DATA_HOME="\$ISO/data"
export XDG_STATE_HOME="\$ISO/state"
export XDG_CACHE_HOME="\$ISO/cache"
export OPENCODE_DB="\$ISO/data/elitza.db"
if [ -f "$HOME_DIR/.env" ]; then set -a; . "$HOME_DIR/.env"; set +a; fi
exec "$INSTALL_DIR/elitza" "\$@"
EOF
    chmod +x "$BIN_LINK"
    ok "Launcher ready at $BIN_LINK"
}

# =============================================================================
#  Install
# =============================================================================
install() {
    detect_platform
    info "Installing Elitza ($PLATFORM)"

    # A source checkout (managed by hand or another tool) is replaced only
    # when the caller says --force.
    if [ "$FORCE" -eq 0 ] && { [ -d "$INSTALL_DIR/.git" ] || [ -f "$INSTALL_DIR/packages/cli/src/index.ts" ]; }; then
        die "A source checkout already exists at $INSTALL_DIR.
  Pass --force to replace it with the released binary, or leave it alone."
    fi

    if [ -n "$LOCAL_BINARY" ]; then
        acquire_local_binary "$LOCAL_BINARY"
    else
        local version="$WANTED_VERSION"
        if [ -z "$version" ]; then
            version="$(resolve_latest_version)"
        else
            version="$(normalize_version "$version")"
            info "Requested version: $version"
        fi

        acquire_release "$version"
    fi

    # The binary must never be run bare: on its own it writes config, cache,
    # state and logs to the machine-default XDG paths, which are shared with
    # anything else on the box using the same app name. A throwaway home
    # keeps the probe out of the real one — and out of ~/.elitza/home, which
    # the legacy migration still has to lay claim to.
    PROBE_DIR="$(mktemp -d)"
    local got
    got="$(
        OPENCODE_CONFIG_DIR="$PROBE_DIR/config" \
        XDG_CONFIG_HOME="$PROBE_DIR/config" \
        XDG_DATA_HOME="$PROBE_DIR/data" \
        XDG_STATE_HOME="$PROBE_DIR/state" \
        XDG_CACHE_HOME="$PROBE_DIR/cache" \
        "$INSTALL_DIR/elitza" --version 2>/dev/null | head -n 1 || true
    )"
    rm -rf "$PROBE_DIR"
    PROBE_DIR=""
    [ -n "$got" ] || die "The installed binary did not run (try a different platform?)"
    ok "$got"

    migrate_legacy_home

    seed_home
    write_launcher

    if [ "$NO_MODIFY_PATH" -eq 1 ]; then
        info "Skipping PATH modification (--no-modify-path)"
        if ! path_contains_bin; then
            warn "Add $BIN_DIR to PATH manually, then run: elitza"
        fi
    else
        add_path_to_shell
    fi

    printf '\n'
    ok "Elitza is ready"
    printf '%s\n' "  1. Get a FREE OpenRouter key → https://openrouter.ai/keys"
    printf '%s\n' "  2. Run ${C_BOLD}elitza${C_RESET}, then ${C_BOLD}/connect${C_RESET} and paste it"
    printf '%s\n' "     (or set OPENROUTER_API_KEY=... in $HOME_DIR/.env)"
    printf '%s\n' "  Free models work out of the box — no card, no trial."
}

# =============================================================================
#  Entry point
# =============================================================================
if [ "$DO_UNINSTALL" -eq 1 ]; then
    detect_platform
    uninstall
fi

if [ "$PRINT_BINARY" -eq 1 ]; then
    printf '%s\n' "$BIN_LINK"
    exit 0
fi

install
