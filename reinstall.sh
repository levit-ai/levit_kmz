#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?Usage: $0 <version> (must match version in package.json — output is levit-kmz-<version>.vsix)}"

npm install
npm run compile
# Older local builds used this id and the same kmz.* command IDs — leave it installed and the UI can show the command with no handler.
cursor --uninstall-extension bladespin.vscode-kmz 2>/dev/null || true
npx @vscode/vsce package
cursor --install-extension "./levit-kmz-${VERSION}.vsix" --force
