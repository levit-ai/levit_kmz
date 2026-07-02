# kmz_plugin
DJI KMZ plugin for vscode/cursor. Lets you open these files without unzipping them and also provides a map viewer. 

Developed by [jasper](https://github.com/jaspereb)

! This repo is public, don't commit anything sensitive ! 

## Installation
Open the **[latest release](https://github.com/levit-ai/levit_kmz/releases)**. Under **Assets**, download `levit-kmz-<version>.vsix` (the version matches `package.json` for that build).

From the VS code command prompt select "Extensions: Install from VSIX..."

To upgrade later, install the newer `.vsix` the same way — it replaces the existing install.

## Functionality
- Right click kmz file and "Open KMZ as workspace folder" to add this as a folder
- Right click kmz, kml or wpml files and "Show placemarks on map"
- Right click kmz, kml or wpml files and "Show placemarks in 3D" for an orbitable 3D view of the mission
- Right click new folder and "Remove folder from worspace" to close it
- Any changes you make to the workspace folder will be reflected in the original kmz

### Map & 3D view
- Hover a waypoint to see its height, attached actions, and the rest of its WPML data (speed, heading, turn mode, ...)
- "Color by height" toggle colors waypoints on a light->dark blue ramp with a min/max legend
- "Stats" button shows min/max height, total path length, and estimated flight time per series
  (speed and per-waypoint pause are editable in the popout and via the `levitKmz.stats.*` settings)
- Click a waypoint and "Open XML" (map) or click a waypoint sphere (3D) to jump to its placemark
  in the backing kml/wpml
- "Validate" button (kmz-backed views) opens a popout with dock serial, basestation repo, and venv
  python fields (persisted to the `levitKmz.validation.*` user settings) and a Run button that runs
  the basestation KMZ safety validator, showing the python command and its output; extra flags go in
  `levitKmz.validation.extraArgs`
- "Show template.kml" toggle displays the template.kml waypoints alongside waylines.wpml (off by default)
- Drag a waypoint on the map to move it; the new coordinates are written back to the file
- Click a waypoint on the map to edit its height - the change is written back into the kmz/kml/wpml file
  (waylines `executeHeight`, template `height` + `ellipsoidHeight` shifted by the same delta, or the
  coordinate altitude for plain KML)
- The map view live-reloads when the underlying file changes

### Editing kml/wpml
- kml and wpml files open as XML with tag-based folding: collapse/expand any block via the gutter
  chevrons, `Cmd+K Cmd+0` (Fold All), `Cmd+K Cmd+J` (Unfold All), or `Cmd+K Cmd+1...7` (fold to level) -
  works inside KMZ archives too
- "Format Document" pretty-prints kml/wpml (useful for single-line files), preserving values,
  attributes, and node order

## Test
```bash
./reinstall.sh "$(node -p "require('./package.json').version")"
```

Unit tests: `npm test`. Integration tests: `npm run test:integration`.

## Push release

Publishes to a **moving git tag and release named `latest`** (delete + recreate so the GitHub release matches the current commit and VSIX).

```bash
VERSION=$(node -p "require('./package.json').version")
./reinstall.sh "$VERSION"
gh release delete latest --cleanup-tag -y 2>/dev/null || true
git tag -d latest 2>/dev/null || true
git tag latest
git push -f origin latest
gh release create latest \
  --latest \
  --title "LevitKMZ latest (v${VERSION})" \
  --notes "LevitKMZ extension — package.json v${VERSION}" \
  "levit-kmz-${VERSION}.vsix"
```

