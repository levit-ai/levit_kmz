import * as path from 'path';
import * as vscode from 'vscode';
import type { ParsedPlacemarkPoint } from './kmlPlacemarks';

const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';

/**
 * Esri World Imagery (satellite). Do not use tile.openstreetmap.org in VS Code webviews — OSM’s
 * tile policy returns 403 without an acceptable Referer/User-Agent.
 */
const TILE_IMAGERY =
  'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILE_IMAGERY_ATTRIBUTION =
  '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/** Highest zoom Esri World Imagery serves; above this, tiles are upscaled. */
const TILE_MAX_NATIVE_ZOOM = 19;
/** Map / layer zoom ceiling (arbitrary deep zoom via scaled tiles). */
const MAP_MAX_ZOOM = 26;

/** Allow tile/CDN hosts Esri may redirect to from the webview. */
const TILE_IMG_CSP = [
  'https://services.arcgisonline.com',
  'https://server.arcgisonline.com',
  'https://*.arcgisonline.com',
  'https://tiles.arcgis.com',
  'https://*.arcgis.com',
].join(' ');

let activePanel: vscode.WebviewPanel | undefined;

const LIVE_RELOAD_DEBOUNCE_MS = 200;

export type PlacemarkMapLiveReload = {
  reload: () => Promise<{ template: ParsedPlacemarkPoint[]; waylines: ParsedPlacemarkPoint[] }>;
  watchUris: vscode.Uri[];
};

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

export function openPlacemarkMapPanel(
  context: vscode.ExtensionContext,
  title: string,
  template: ParsedPlacemarkPoint[],
  waylines: ParsedPlacemarkPoint[],
  liveReload?: PlacemarkMapLiveReload
): void {
  if (activePanel) {
    activePanel.dispose();
  }

  const panel = vscode.window.createWebviewPanel(
    'kmzPlacemarkMap',
    title,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel = panel;

  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    `style-src ${panel.webview.cspSource} 'nonce-${nonce}' ${LEAFLET_CSS}`,
    `script-src 'nonce-${nonce}' ${LEAFLET_JS}`,
    `img-src ${panel.webview.cspSource} data: blob: ${TILE_IMG_CSP}`,
    `connect-src ${panel.webview.cspSource}`,
  ].join('; ');

  panel.webview.html = getHtml(csp, nonce);

  const postParsed = (t: ParsedPlacemarkPoint[], w: ParsedPlacemarkPoint[]): void => {
    const payload = {
      type: 'data' as const,
      template: t.map(stripSource),
      waylines: w.map(stripSource),
    };
    void panel.webview.postMessage(payload);
  };

  const sendData = (): void => postParsed(template, waylines);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  const watchDisposables: vscode.Disposable[] = [];

  const scheduleReload = (): void => {
    if (!liveReload) {
      return;
    }
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void liveReload.reload().then(
        (next) => postParsed(next.template, next.waylines),
        (err) => console.warn('[levit-kmz] Map reload failed:', err)
      );
    }, LIVE_RELOAD_DEBOUNCE_MS);
  };

  if (liveReload) {
    const seen = new Set<string>();
    for (const uri of liveReload.watchUris) {
      const key = uri.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const folder = vscode.Uri.file(path.dirname(uri.fsPath));
      const pattern = path.basename(uri.fsPath);
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
      watcher.onDidChange(scheduleReload);
      watcher.onDidCreate(scheduleReload);
      watchDisposables.push(watcher);
    }
  }

  panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
    if (msg?.type === 'ready') {
      sendData();
    }
  });

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
    }
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    for (const d of watchDisposables) {
      d.dispose();
    }
  });
  context.subscriptions.push(panel);
}

function stripSource(p: ParsedPlacemarkPoint): {
  lon: number;
  lat: number;
  alt?: number;
  index?: number;
} {
  return { lon: p.lon, lat: p.lat, alt: p.alt, index: p.index };
}

function getHtml(csp: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${LEAFLET_CSS}" nonce="${nonce}" />
  <style nonce="${nonce}">
    html, body { height: 100%; margin: 0; padding: 0; }
    #map { height: 100vh; width: 100%; }
    .kmz-legend {
      position: absolute; bottom: 24px; right: 12px; z-index: 1000;
      background: rgba(255,255,255,0.92); padding: 8px 12px; border-radius: 6px;
      font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,0.2);
    }
    .kmz-legend span { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="kmz-legend">
    <div><span style="background:#2563eb;"></span>template.kml</div>
    <div><span style="background:#ea580c;"></span>waylines.wpml</div>
  </div>
  <script nonce="${nonce}" src="${LEAFLET_JS}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    var mapInstance = null;
    function renderMap(template, waylines) {
      if (mapInstance) {
        mapInstance.remove();
        mapInstance = null;
      }
      mapInstance = L.map('map', { maxZoom: ${MAP_MAX_ZOOM} });
      var map = mapInstance;
      L.tileLayer('${TILE_IMAGERY}', {
        maxZoom: ${MAP_MAX_ZOOM},
        maxNativeZoom: ${TILE_MAX_NATIVE_ZOOM},
        attribution: '${TILE_IMAGERY_ATTRIBUTION.replace(/'/g, "\\'")}'
      }).addTo(map);

      const bounds = [];
      function addSeries(points, color, label) {
        if (!points || points.length === 0) return;
        const latlngs = points.map(function (p) { return [p.lat, p.lon]; });
        L.polyline(latlngs, { color: color, weight: 3, opacity: 0.75 }).addTo(map);
        points.forEach(function (p, i) {
          var labelText = label + ' ' + (p.index != null ? '#' + p.index : '(' + i + ')');
          L.circleMarker([p.lat, p.lon], {
            radius: 5,
            color: color,
            weight: 2,
            fillColor: color,
            fillOpacity: 0.85
          }).bindPopup(labelText).addTo(map);
        });
        latlngs.forEach(function (ll) { bounds.push(ll); });
      }

      addSeries(template, '#2563eb', 'template.kml');
      addSeries(waylines, '#ea580c', 'waylines.wpml');

      if (bounds.length === 0) {
        map.setView([20, 0], 2);
        return;
      }
      map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40] });
    }

    window.addEventListener('message', function (event) {
      var m = event.data;
      if (m && m.type === 'data') {
        renderMap(m.template || [], m.waylines || []);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
