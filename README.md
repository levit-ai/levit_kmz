# kmz_plugin
DJI KMZ plugin for vscode. Developed by [jasper](https://github.com/jaspereb)

! This repo is public, don't commit anything sensitive ! 

## Install

Open the **[latest release](https://github.com/jasper-levit/kmz_plugin/releases/tag/latest)**. Under **Assets**, download `levit-kmz-<version>.vsix` (the version matches `package.json` for that build).

In VS Code or Cursor, open the Extensions view, choose **⋯** (Views and more actions) → **Install from VSIX…**, and select the downloaded file. Reload if prompted.

## Functionality
- Right click kmz file and "Open KMZ as workspace folder" to add this as a folder
- Right click kmz, kml or wpml files and "Show placemarks on map"
- Right click new folder and "Remove folder from worspace" to close it
- Any changes you make to the workspace folder will be reflected in the original kmz

## Test
```bash
./reinstall.sh "$(node -p "require('./package.json').version")"
```

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

