#!/usr/bin/env bash
# Runs the VS Code extension host integration tests (proves kmz.showPlacemarkMap is
# registered after activate). On failure, runs reinstall.sh once per attempt in case
# the fix is cleaning up Cursor’s extension state; then retries.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
PLUGIN_VERSION="$(node -p "require('./package.json').version")"

MAX_ATTEMPTS="${MAX_ATTEMPTS:-5}"
for i in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "=== integration test attempt $i/$MAX_ATTEMPTS ==="
  npm run compile
  if npm run test:integration; then
    echo "=== integration tests passed — packaging and installing for Cursor ==="
    ./reinstall.sh "$PLUGIN_VERSION"
    echo "Reload Cursor (Command Palette: Developer: Reload Window), then try the KMZ command again."
    exit 0
  fi
  echo "Tests failed — running reinstall.sh before retry..."
  ./reinstall.sh "$PLUGIN_VERSION"
done

echo "Giving up after $MAX_ATTEMPTS attempts. Check test output above."
exit 1
