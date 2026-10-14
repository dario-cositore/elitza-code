#!/usr/bin/env bash
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
#    --no-setup           Do not run the interactive setup wizard
#    --binary             Print the path of the installed launcher and exit
#    --uninstall          Remove Elitza and exit
#    --help               Show this help
#
#  Examples:
#
#    curl -fsSL https://elitza.life/install.sh | bash -s -- --version 0.2.0
#    curl -fsSL https://elitza.life/install.sh | bash -s -- --no-modify-path
#    curl -fsSL https://elitza.life/install.sh | bash -s -- --uninstall
#
#  What it does:
#    1. Detects os/arch and resolves the version (GitHub "latest" endpoint)
#    2. Downloads the prebuilt release archive (falls back to a git clone)
#    3. Creates a Python virtualenv and installs the package
#    4. Seeds ~/.elitza with the default config, soul, personas and skills
#    5. Links `elitza` into ~/.local/bin (on PATH)
#    6. Runs the setup wizard so you can drop in an API key
# =============================================================================

set -euo pipefail

# Workspace for downloaded archives. A script-level EXIT trap removes it --
# deliberately NOT a RETURN trap inside the function, because bash keeps
# RETURN traps registered for every later function return, and the local
# variable would already be out of scope (fatal under `set -u`).
WORK_DIR=""
cleanup() {
    if [ -n "${WORK_DIR:-}" ] && [ -d "$WORK_DIR" ]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

# --- Guard against inherited interpreter settings ---------------------------
for var in PYTHONPATH PYTHONHOME; do
    if [ -n "${!var:-}" ]; then
        echo "Ignoring inherited $var during install"
        unset "$var"
    fi
done

# --- Constants -------------------------------------------------------------
INSTALLER_VERSION="0.1.0"
REPO="dario-cositore/elitza-agent"
REPO_URL="${ELITZA_REPO_URL:-https://github.com/${REPO}.git}"
RELEASES_API="${ELITZA_RELEASES_API:-https://api.github.com/repos/${REPO}/releases/latest}"
DOWNLOAD_BASE="${ELITZA_DOWNLOAD_BASE:-https://github.com/${REPO}/releases/download}"

INSTALL_DIR="${ELITZA_INSTALL_DIR:-$HOME/.elitza/agent}"
HOME_DIR="${ELITZA_HOME:-$HOME/.elitza}"
BIN_DIR="${ELITZA_BIN_DIR:-$HOME/.local/bin}"
BIN_LINK="$BIN_DIR/elitza"

MIN_PYTHON="3.11"

# --- Output helpers --------------------------------------------------------
# Colours only when stdout is a terminal (a piped run still shows them, since
# only stdin carries the script).
if [ -t 1 ]; then
    C_RESET=$'\033[0m'
    C_BOLD=$'\033[1m'
    C_DIM=$'\033[2m'
    C_GREEN=$'\033[32m'
    C_BLUE=$'\033[34m'
    C_RED=$'\033[31m'
    C_YELLOW=$'\033[33m'
else
    C_RESET="" C_BOLD="" C_DIM="" C_GREEN="" C_BLUE="" C_RED="" C_YELLOW=""
fi

info()  { printf '%s\n' "${C_BLUE}›${C_RESET} $*"; }
ok()    { printf '%s\n' "${C_GREEN}✓${C_RESET} $*"; }
warn()  { printf '%s\n' "${C_YELLOW}!${C_RESET} $*"; }
error() { printf '%s\n' "${C_RED}✗${C_RESET} $*" >&2; }
die()   { error "$*"; exit 1; }

# Under `curl ... | bash` stdin carries the script itself, so reading from it
# would consume script lines. Prompts are only ever attempted on a real tty;
# otherwise the caller gets the documented default. ELITZA_NO_PROMPT=1 forces
# the non-interactive path (used by `elitza update`, which must never block).
interactive() {
    [ -z "${ELITZA_NO_PROMPT:-}" ] || return 1
    [ -t 0 ] && [ -t 1 ]
}

# prompt <prompt text> <default: y|n>  -> echoes y or n
prompt() {
    local text="$1" default="${2:-n}" answer=""
    if ! interactive; then
        printf '%s\n' "$default"
        return 0
    fi
    printf '%s' "$text"
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
NO_SETUP=0
DO_UNINSTALL=0
PRINT_BINARY=0

usage() {
    cat <<'EOF'
Elitza installer

Usage:
  curl -fsSL https://elitza.life/install.sh | bash

Options (pass after a `--`):
  --version <tag>    Install a specific release (default: latest)
  --no-modify-path   Do not add ~/.local/bin to your shell startup files
  --no-setup         Do not run the interactive setup wizard
  --binary           Print the path of the installed launcher and exit
  --uninstall        Remove Elitza and exit
  --help             Show this help

Examples:
  curl -fsSL https://elitza.life/install.sh | bash -s -- --version 0.2.0
  curl -fsSL https://elitza.life/install.sh | bash -s -- --no-modify-path
  curl -fsSL https://elitza.life/install.sh | bash -s -- --uninstall

Environment:
  ELITZA_HOME         Where config, soul and memories live  (default ~/.elitza)
  ELITZA_INSTALL_DIR  Where the code is installed           (default ~/.elitza/agent)
  ELITZA_BIN_DIR      Where the `elitza` link is placed     (default ~/.local/bin)
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            if [ $# -lt 2 ]; then die "--version requires a value"; fi
            WANTED_VERSION="$2"; shift 2 ;;
        --version=*)  WANTED_VERSION="${1#*=}"; shift ;;
        --no-modify-path) NO_MODIFY_PATH=1; shift ;;
        --no-setup)       NO_SETUP=1; shift ;;
        --uninstall)      DO_UNINSTALL=1; shift ;;
        --binary)         PRINT_BINARY=1; shift ;;
        -h|--help)        usage; exit 0 ;;
        --)               shift ;;
        *)                die "Unknown option: $1 (try --help)" ;;
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
# Asks the GitHub "latest" endpoint. Prints the tag name, or nothing when no
# release exists yet (the caller then falls back to the default branch).
resolve_latest_version() {
    fetch_to_stdout "$RELEASES_API" 2>/dev/null \
        | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | head -n 1 \
        | sed 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/' \
        || true
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
        warn "No launcher link at $BIN_LINK"
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
# Appends ~/.local/bin to the startup files of whatever shells are present.
# Skipped entirely under --no-modify-path.
PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

shell_startup_files() {
    local files=""
    [ -n "${SHELL:-}" ] || true
    case "${SHELL:-}" in
        */zsh)  files="$HOME/.zshrc $HOME/.zprofile" ;;
        */bash) files="$HOME/.bashrc $HOME/.bash_profile $HOME/.profile" ;;
        */fish) files="$HOME/.config/fish/config.fish" ;;
        *)      files="$HOME/.profile $HOME/.bashrc $HOME/.zshrc" ;;
    esac
    echo "$files"
}

add_path_to_shell() {
    case "${SHELL:-}" in
        */fish)
            local fish_line='fish_add_path $HOME/.local/bin'
            local f="$HOME/.config/fish/config.fish"
            mkdir -p "$(dirname "$f")"; touch "$f"
            grep -qF 'fish_add_path' "$f" 2>/dev/null || {
                printf '\n# Elitza\n%s\n' "$fish_line" >> "$f"
                ok "Added $BIN_DIR to PATH (config.fish)"
            }
            return 0 ;;
    esac

    local changed=""
    for f in $(shell_startup_files); do
        mkdir -p "$(dirname "$f")"; touch "$f"
        if grep -qF '.local/bin' "$f" 2>/dev/null; then
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

strip_path_from_shell() {
    local f
    for f in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" \
             "$HOME/.bash_profile" "$HOME/.profile" \
             "$HOME/.config/fish/config.fish"; do
        [ -f "$f" ] || continue
        case "$f" in
            */fish) sed -i.bak '/fish_add_path.*\.local\/bin/d' "$f" ;;
            *)      sed -i.bak '/^# Elitza$/d;/\.local\/bin/d' "$f" ;;
        esac
        rm -f "$f.bak"
    done
}

# =============================================================================
#  Python environment
# =============================================================================
# Prefers uv (it can fetch a pinned interpreter). Falls back to any system
# Python that satisfies requires-python.
find_python() {
    if command -v uv >/dev/null 2>&1; then
        echo "uv"
        return 0
    fi

    local cand
    for cand in python3.11 python3.12 python3.13 python3.14 python3; do
        if command -v "$cand" >/dev/null 2>&1; then
            if "$cand" -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" 2>/dev/null; then
                echo "$cand"
                return 0
            fi
        fi
    done
    return 1
}

python_major_minor() {
    "$1" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null
}

create_venv() {
    local venv_dir="$INSTALL_DIR/venv"
    local py found
    found="$(find_python)" || die "Python $MIN_PYTHON+ is required.
  Install it with your package manager, or install uv:
    curl -LsSf https://astral.sh/uv/install.sh | sh"

    if [ "$found" = "uv" ]; then
        info "Creating virtualenv with uv (Python $MIN_PYTHON)"
        (cd "$INSTALL_DIR" && uv venv venv --python "$MIN_PYTHON" >/dev/null)
        (cd "$INSTALL_DIR" && uv pip install --python "$venv_dir/bin/python" -e . >/dev/null)
    else
        py="$found"
        info "Creating virtualenv with $py ($(python_major_minor "$py"))"
        rm -rf "$venv_dir"
        "$py" -m venv "$venv_dir"
        # pip has to exist before the first install. uv-created environments
        # and minimal distro Pythons can ship without it, so bootstrap via
        # ensurepip first rather than assuming `venv/bin/pip` is there.
        if ! "$venv_dir/bin/python" -m pip --version >/dev/null 2>&1; then
            "$venv_dir/bin/python" -m ensurepip --upgrade >/dev/null 2>&1 || true
        fi
        "$venv_dir/bin/python" -m pip install --quiet --upgrade pip || true
        "$venv_dir/bin/python" -m pip install --quiet -e "$INSTALL_DIR"
    fi

    [ -x "$venv_dir/bin/python" ] || die "Virtualenv creation failed"
    ok "Installed Python dependencies"
}

# =============================================================================
#  Home directory seeding
# =============================================================================
# Copies only files that are not already present, so an upgrade never
# overwrites a personalised config, soul or set of memories.
seed_home() {
    local src="$INSTALL_DIR/home"
    [ -d "$src" ] || return 0

    mkdir -p "$HOME_DIR"

    local item name
    for item in "$src"/* "$src"/.[!.]*; do
        [ -e "$item" ] || continue
        name="$(basename "$item")"

        if [ "$name" = ".env.example" ]; then
            # Turn the template into a live .env, but never clobber an
            # existing one (it holds the API key).
            [ -f "$HOME_DIR/.env" ] || cp "$item" "$HOME_DIR/.env"
            continue
        fi

        if [ -d "$item" ]; then
            # Directories are merged file-by-file, never overwritten.
            (cd "$item" && find . -type f -print0) | while IFS= read -r -d '' rel; do
                rel="${rel#./}"
                if [ ! -e "$HOME_DIR/$name/$rel" ]; then
                    mkdir -p "$HOME_DIR/$name/$(dirname "$rel")"
                    cp "$item/$rel" "$HOME_DIR/$name/$rel"
                fi
            done
        else
            [ -e "$HOME_DIR/$name" ] || cp "$item" "$HOME_DIR/$name"
        fi
    done

    ok "Seeded $HOME_DIR"
}

# =============================================================================
#  Code acquisition
# =============================================================================
# Preferred: the prebuilt, versioned release archive for this platform.
# Fallback: a shallow git clone (used before the first release exists).
acquire_source() {
    local version="$1" archive url inner
    WORK_DIR="$(mktemp -d)"

    archive="elitza-${version}-${PLATFORM_OS}-${PLATFORM_ARCH}.tar.gz"
    url="${DOWNLOAD_BASE}/${version}/${archive}"

    if fetch_to_file "$url" "$WORK_DIR/$archive" 2>/dev/null; then
        info "Downloaded $archive"
        tar -xzf "$WORK_DIR/$archive" -C "$WORK_DIR"

        # Archives contain a single top-level directory; unwrap it. Stage the
        # new copy beside the old one and swap, so a failed extraction or copy
        # can never leave a half-deleted installation behind.
        inner="$(find "$WORK_DIR" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | head -n 1)"
        [ -n "$inner" ] || inner="$WORK_DIR"

        local staging="${INSTALL_DIR}.new" previous="${INSTALL_DIR}.old"
        rm -rf "$staging" "$previous"
        mkdir -p "$staging"
        cp -a "$inner/." "$staging/"

        if [ -d "$INSTALL_DIR" ]; then
            mv "$INSTALL_DIR" "$previous"
        fi
        mv "$staging" "$INSTALL_DIR"
        rm -rf "$previous"
        ok "Installed Elitza $version"
        return 0
    fi

    warn "No prebuilt archive for $version on $PLATFORM — falling back to git"
    command -v git >/dev/null 2>&1 || die "git is required for the fallback install"

    if [ -d "$INSTALL_DIR/.git" ]; then
        (cd "$INSTALL_DIR" && git fetch --quiet --tags origin && git checkout --quiet "$version")
    else
        rm -rf "$INSTALL_DIR"
        git clone --quiet --depth 1 --branch "$version" "$REPO_URL" "$INSTALL_DIR"
    fi
    ok "Installed Elitza $version from source"
}

# =============================================================================
#  Launcher link
# =============================================================================
link_launcher() {
    local launcher="$INSTALL_DIR/bin/elitza"
    [ -x "$launcher" ] || die "Launcher not found at $launcher"

    mkdir -p "$BIN_DIR"
    ln -sf "$launcher" "$BIN_LINK"
    ok "Linked $BIN_LINK"
}

# =============================================================================
#  Install
# =============================================================================
install() {
    detect_platform
    info "Installing Elitza ($PLATFORM)"

    local version="$WANTED_VERSION"
    if [ -z "$version" ]; then
        version="$(resolve_latest_version)"
        if [ -n "$version" ]; then
            ok "Latest release: $version"
        else
            version="main"
            warn "No release found yet — using the default branch"
        fi
    else
        info "Requested version: $version"
    fi

    acquire_source "$version"
    create_venv
    seed_home
    link_launcher

    if [ "$NO_MODIFY_PATH" -eq 1 ]; then
        info "Skipping PATH modification (--no-modify-path)"
        if ! path_contains_bin; then
            warn "Add $BIN_DIR to PATH manually, then run: elitza"
        fi
    else
        add_path_to_shell
    fi

    ok "Elitza $version installed"

    if [ "$NO_SETUP" -eq 1 ]; then
        printf '\n  Run %selitza%s to get started.\n' "$C_BOLD" "$C_RESET"
        return 0
    fi

    printf '\n'
    if ! interactive; then
        # The wizard needs a terminal; a piped run just prints the next step.
        printf '  Next: run %selitza setup%s to add your API key.\n' "$C_BOLD" "$C_RESET"
        return 0
    fi

    if [ "$(prompt "  Run 'elitza setup' now to add your API key? [Y/n] " y)" = "n" ]; then
        printf '  Run %selitza setup%s to configure later.\n' "$C_BOLD" "$C_RESET"
    else
        "$BIN_LINK" setup || warn "Setup wizard failed — run 'elitza setup' later"
    fi
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
