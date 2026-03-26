import * as path from 'path';
import * as vscode from 'vscode';
import { applyCoordinateEdit, type ParsedPlacemarkPoint, type PlacemarkSource } from './kmlPlacemarks';

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

const LIVE_RELOAD_DEBOUNCE_MS = 200;
/** Debounced apply when multiple drags complete in quick succession. */
const MOVE_WRITE_DEBOUNCE_MS = 120;

let activePanel: vscode.WebviewPanel | undefined;

export type PlacemarkMapLiveReload = {
  reload: () => Promise<{ template: ParsedPlacemarkPoint[]; waylines: ParsedPlacemarkPoint[] }>;
  watchUris: vscode.Uri[];
};

export type PlacemarkMapEditUris = {
  templateUri?: vscode.Uri;
  waylinesUri?: vscode.Uri;
};

export type PlacemarkMapPanelOptions = {
  liveReload?: PlacemarkMapLiveReload;
  edit?: PlacemarkMapEditUris;
};

type WebviewPointPayload = {
  lon: number;
  lat: number;
  alt?: number;
  index?: number;
  source: PlacemarkSource;
  seriesIndex: number;
  editable: boolean;
};

type MoveMessage = {
  type: 'move';
  source: PlacemarkSource;
  seriesIndex: number;
  lat: number;
  lon: number;
};

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function toWebviewPoint(
  p: ParsedPlacemarkPoint,
  source: PlacemarkSource,
  seriesIndex: number,
  edit: PlacemarkMapEditUris | undefined
): WebviewPointPayload {
  const uri = source === 'template' ? edit?.templateUri : edit?.waylinesUri;
  const editable = !!uri && !!p.coordSpan;
  return {
    lon: p.lon,
    lat: p.lat,
    alt: p.alt,
    index: p.index,
    source,
    seriesIndex,
    editable,
  };
}

function isMoveMessage(msg: unknown): msg is MoveMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const m = msg as Record<string, unknown>;
  if (m.type !== 'move') {
    return false;
  }
  if (m.source !== 'template' && m.source !== 'waylines') {
    return false;
  }
  if (typeof m.seriesIndex !== 'number' || !Number.isInteger(m.seriesIndex) || m.seriesIndex < 0) {
    return false;
  }
  if (typeof m.lat !== 'number' || typeof m.lon !== 'number') {
    return false;
  }
  if (!Number.isFinite(m.lat) || !Number.isFinite(m.lon)) {
    return false;
  }
  return true;
}

export function openPlacemarkMapPanel(
  context: vscode.ExtensionContext,
  title: string,
  template: ParsedPlacemarkPoint[],
  waylines: ParsedPlacemarkPoint[],
  options?: PlacemarkMapPanelOptions
): void {
  if (activePanel) {
    activePanel.dispose();
  }

  const liveReload = options?.liveReload;
  const edit = options?.edit;

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

  let currentTemplate = template;
  let currentWaylines = waylines;

  let writeInFlight = false;
  let pendingWatcherReload = false;

  const postParsed = (t: ParsedPlacemarkPoint[], w: ParsedPlacemarkPoint[]): void => {
    currentTemplate = t;
    currentWaylines = w;
    const payload = {
      type: 'data' as const,
      template: t.map((p, i) => toWebviewPoint(p, 'template', i, edit)),
      waylines: w.map((p, i) => toWebviewPoint(p, 'waylines', i, edit)),
    };
    void panel.webview.postMessage(payload);
  };

  const sendData = (): void => postParsed(currentTemplate, currentWaylines);

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let moveDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedMove: MoveMessage | undefined;
  const watchDisposables: vscode.Disposable[] = [];

  const runLiveReload = (): void => {
    if (!liveReload) {
      return;
    }
    void liveReload.reload().then(
      (next) => postParsed(next.template, next.waylines),
      (err) => console.warn('[levit-kmz] Map reload failed:', err)
    );
  };

  const scheduleReload = (): void => {
    if (!liveReload) {
      return;
    }
    if (writeInFlight) {
      pendingWatcherReload = true;
      return;
    }
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runLiveReload();
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

  const applyMove = async (msg: MoveMessage): Promise<void> => {
    if (!edit) {
      return;
    }
    const uri = msg.source === 'template' ? edit.templateUri : edit.waylinesUri;
    if (!uri) {
      return;
    }
    const series = msg.source === 'template' ? currentTemplate : currentWaylines;
    const pt = series[msg.seriesIndex];
    if (!pt?.coordSpan) {
      return;
    }

    writeInFlight = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf8', { fatal: false }).decode(bytes);
      const updated = applyCoordinateEdit(text, pt.coordSpan, msg.lon, msg.lat, pt.alt);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));

      if (liveReload) {
        const next = await liveReload.reload();
        postParsed(next.template, next.waylines);
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Could not save coordinates: ${detail}`);
      runLiveReload();
    } finally {
      writeInFlight = false;
      if (pendingWatcherReload) {
        pendingWatcherReload = false;
        runLiveReload();
      }
    }
  };

  const scheduleMove = (msg: MoveMessage): void => {
    queuedMove = msg;
    if (moveDebounceTimer !== undefined) {
      clearTimeout(moveDebounceTimer);
    }
    moveDebounceTimer = setTimeout(() => {
      moveDebounceTimer = undefined;
      const toApply = queuedMove;
      queuedMove = undefined;
      if (toApply) {
        void applyMove(toApply);
      }
    }, MOVE_WRITE_DEBOUNCE_MS);
  };

  panel.webview.onDidReceiveMessage((msg: unknown) => {
    if (msg && typeof msg === 'object' && (msg as { type?: string }).type === 'ready') {
      sendData();
      return;
    }
    if (isMoveMessage(msg) && edit) {
      scheduleMove(msg);
    }
  });

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
    }
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    if (moveDebounceTimer !== undefined) {
      clearTimeout(moveDebounceTimer);
    }
    for (const d of watchDisposables) {
      d.dispose();
    }
  });
  context.subscriptions.push(panel);
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
    .kmz-vertex-wrap { background: none !important; border: none !important; }
    .kmz-vertex {
      width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box;
      background: #2563eb;
      border: 2px solid rgba(255,255,255,0.92);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="kmz-legend">
    <div><span style="background:#2563eb;"></span>template.kml (drag to edit)</div>
    <div><span style="background:#ea580c;"></span>waylines.wpml (drag to edit)</div>
  </div>
  <script nonce="${nonce}" src="${LEAFLET_JS}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    var mapInstance = null;
    var featureLayer = null;
    var didFitInitialBounds = false;

    function waypointIcon() {
      return L.divIcon({
        className: 'kmz-vertex-wrap',
        html: '<div class="kmz-vertex"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
    }

    function renderMap(template, waylines) {
      if (!mapInstance) {
        mapInstance = L.map('map', { maxZoom: ${MAP_MAX_ZOOM} });
        L.tileLayer('${TILE_IMAGERY}', {
          maxZoom: ${MAP_MAX_ZOOM},
          maxNativeZoom: ${TILE_MAX_NATIVE_ZOOM},
          attribution: '${TILE_IMAGERY_ATTRIBUTION.replace(/'/g, "\\'")}'
        }).addTo(mapInstance);
        featureLayer = L.layerGroup().addTo(mapInstance);
      } else {
        featureLayer.clearLayers();
      }

      const bounds = [];

      var waypointBlue = '#2563eb';
      function addSeries(points, lineColor, label) {
        if (!points || points.length === 0) return;
        const latlngs = points.map(function (p) { return [p.lat, p.lon]; });
        var poly = L.polyline(latlngs, { color: lineColor, weight: 3, opacity: 0.75 }).addTo(featureLayer);
        points.forEach(function (p, i) {
          var labelText = label + ' ' + (p.index != null ? '#' + p.index : '(' + i + ')');
          var latlng = [p.lat, p.lon];
          if (p.editable) {
            var marker = L.marker(latlng, { draggable: true, icon: waypointIcon() });
            marker.bindPopup(labelText);
            marker.on('drag', function () {
              var ll = marker.getLatLng();
              var pts = poly.getLatLngs();
              if (pts.length && !Array.isArray(pts[0])) {
                pts[i] = ll;
                poly.setLatLngs(pts);
              }
            });
            marker.on('dragend', function (ev) {
              var ll = ev.target.getLatLng();
              vscode.postMessage({
                type: 'move',
                source: p.source,
                seriesIndex: p.seriesIndex,
                lat: ll.lat,
                lon: ll.lng
              });
            });
            marker.addTo(featureLayer);
          } else {
            L.circleMarker(latlng, {
              radius: 6,
              color: '#ffffff',
              weight: 2,
              fillColor: waypointBlue,
              fillOpacity: 1,
              opacity: 1
            }).bindPopup(labelText).addTo(featureLayer);
          }
          bounds.push(latlng);
        });
      }

      addSeries(template, '#2563eb', 'template.kml');
      addSeries(waylines, '#ea580c', 'waylines.wpml');

      if (bounds.length === 0) {
        if (!didFitInitialBounds) {
          mapInstance.setView([20, 0], 2);
          didFitInitialBounds = true;
        }
        return;
      }
      if (!didFitInitialBounds) {
        mapInstance.fitBounds(L.latLngBounds(bounds), { padding: [40, 40] });
        didFitInitialBounds = true;
      }
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
