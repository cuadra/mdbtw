#!/bin/sh
# Builds mdreader and installs it for the current user - no root, no package.
#
#   ./install.sh              install into ~/.local
#   ./install.sh --uninstall  remove it again
#   PREFIX=/some/dir ./install.sh
set -eu

prefix=${PREFIX:-$HOME/.local}
bin=$prefix/bin/mdreader
desktop=$prefix/share/applications/io.github.mdreader.desktop
here=$(cd "$(dirname "$0")" && pwd)

if [ "${1:-}" = "--uninstall" ]; then
    rm -f "$bin" "$desktop"
    echo "Removed $bin and $desktop"
    exit 0
fi

for dep in gtk4 webkitgtk-6.0; do
    if ! pkg-config --exists "$dep"; then
        echo "Missing $dep. Install it first:  sudo pacman -S --needed gtk4 webkitgtk-6.0" >&2
        exit 1
    fi
done

cd "$here"
cargo build --release --locked

install -Dm755 target/release/mdreader "$bin"
install -Dm644 packaging/io.github.mdreader.desktop "$desktop"
command -v update-desktop-database >/dev/null 2>&1 &&
    update-desktop-database "$prefix/share/applications" >/dev/null 2>&1 || true

echo "Installed $bin"
case ":$PATH:" in
    *":$prefix/bin:"*) ;;
    *) echo "Note: $prefix/bin is not on your PATH." ;;
esac
