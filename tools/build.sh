#!/bin/sh
# Builds dist/hue-lights@ubruckhaus.github.io.shell-extension.zip.
set -eu
cd "$(dirname "$0")/.."
UUID=hue-lights@ubruckhaus.github.io
mkdir -p dist
find "$UUID" -name __pycache__ -prune -exec rm -rf {} +
gnome-extensions pack "$UUID" --force --out-dir dist \
    --extra-source=scripts --extra-source=icons --extra-source=../LICENSE
echo "dist/$UUID.shell-extension.zip"
