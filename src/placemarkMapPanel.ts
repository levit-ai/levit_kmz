import * as path from 'path';
import * as vscode from 'vscode';
import {
  applyCoordinateEdit,
  extractPlacemarkPointsWithSpans,
  type HeightField,
  type ParsedPlacemarkPoint,
  type PlacemarkSource,
} from './kmlPlacemarks';
import { updatePlacemarkHeight } from './kmlEdit';
import {
  PANEL_WIDGET_CSS,
  SHARED_PANEL_JS,
  applyStatsConfigUpdate,
  applyValidationConfigUpdate,
  getNonce,
  getStatsConfig,
  getValidationSettings,
  handleRunValidation,
  isOpenXmlMessage,
  isRunValidationMessage,
  revealPlacemarkXml,
  toWebviewPoint,
} from './placemarkPanelShared';

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
  /** On-disk path of the source .kmz, when known; enables the safety validator. */
  missionKmzFsPath?: string;
};

type MoveMessage = {
  type: 'move';
  source: PlacemarkSource;
  seriesIndex: number;
  lat: number;
  lon: number;
};

type EditHeightMessage = {
  type: 'editHeight';
  source: PlacemarkSource;
  ordinal: number;
  index?: number;
  heightField?: HeightField;
  height: number;
};

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

function isEditHeightMessage(msg: unknown): msg is EditHeightMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const m = msg as Record<string, unknown>;
  if (m.type !== 'editHeight') {
    return false;
  }
  if (m.source !== 'template' && m.source !== 'waylines') {
    return false;
  }
  if (typeof m.ordinal !== 'number' || !Number.isInteger(m.ordinal) || m.ordinal < 0) {
    return false;
  }
  if (typeof m.height !== 'number' || !Number.isFinite(m.height)) {
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
  const missionKmzFsPath = options?.missionKmzFsPath;

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
    // A nonce here would block the inline style="" attributes used for marker colors.
    `style-src ${panel.webview.cspSource} 'unsafe-inline' ${LEAFLET_CSS}`,
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
      statsConfig: getStatsConfig(),
      validation: { hasMission: !!missionKmzFsPath, ...getValidationSettings() },
    };
    void panel.webview.postMessage(payload);
  };

  const sendData = (): void => postParsed(currentTemplate, currentWaylines);

  /** Refresh from disk after a write; falls back to re-extracting the edited file. */
  const refreshAfterWrite = async (editedSource: PlacemarkSource, editedText: string): Promise<void> => {
    if (liveReload) {
      const next = await liveReload.reload();
      postParsed(next.template, next.waylines);
      return;
    }
    const pts = extractPlacemarkPointsWithSpans(editedText, editedSource);
    if (editedSource === 'template') {
      postParsed(pts, currentWaylines);
    } else {
      postParsed(currentTemplate, pts);
    }
  };

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

  watchDisposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('levitKmz.stats') || e.affectsConfiguration('levitKmz.validation')) {
        sendData();
      }
    })
  );

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
      await refreshAfterWrite(msg.source, updated);
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

  const applyEditHeight = async (msg: EditHeightMessage): Promise<void> => {
    const uri = msg.source === 'template' ? edit?.templateUri : edit?.waylinesUri;
    if (!uri) {
      void vscode.window.showErrorMessage('This layer is not backed by a writable file.');
      sendData();
      return;
    }

    writeInFlight = true;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder('utf8', { fatal: false }).decode(bytes);
      const updated = updatePlacemarkHeight(
        text,
        { ordinal: msg.ordinal, index: msg.index, source: msg.source, heightField: msg.heightField },
        msg.height
      );
      if (updated === null) {
        void vscode.window.showErrorMessage('Could not find an editable height field for this waypoint.');
        sendData();
        return;
      }
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
      await refreshAfterWrite(msg.source, updated);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Could not save waypoint height: ${detail}`);
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
    if (applyStatsConfigUpdate(msg) || applyValidationConfigUpdate(msg)) {
      return;
    }
    if (isOpenXmlMessage(msg)) {
      const uri = msg.source === 'template' ? edit?.templateUri : edit?.waylinesUri;
      const series = msg.source === 'template' ? currentTemplate : currentWaylines;
      void revealPlacemarkXml(uri, series[msg.seriesIndex]);
      return;
    }
    if (isRunValidationMessage(msg)) {
      if (missionKmzFsPath) {
        void handleRunValidation(msg, missionKmzFsPath, (m) => void panel.webview.postMessage(m));
      }
      return;
    }
    if (isMoveMessage(msg) && edit) {
      scheduleMove(msg);
      return;
    }
    if (isEditHeightMessage(msg)) {
      void applyEditHeight(msg);
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
    ${PANEL_WIDGET_CSS}
    .leaflet-tooltip.kmz-tip { white-space: normal; }
    .kmz-vertex-wrap { background: none !important; border: none !important; }
    .kmz-vertex {
      width: 10px; height: 10px; border-radius: 50%; box-sizing: border-box;
      background: #2563eb;
      border: 2px solid rgba(255,255,255,0.92);
      box-shadow: 0 0 0 1px rgba(0,0,0,0.35);
    }
    .kmz-edit { font: 12px/1.5 system-ui, sans-serif; }
    .kmz-edit .tt-title { font-weight: 600; margin-bottom: 4px; }
    .kmz-edit input { width: 90px; margin-right: 6px; }
    .kmz-edit .kmz-edit-status { color: #b91c1c; margin-top: 4px; min-height: 14px; }
  </style>
</head>
<body>
  <div id="map"></div>
  <div class="kmz-controls">
    <label><input type="checkbox" id="toggle-color" /> Color by height</label>
    <label id="template-toggle-row" hidden><input type="checkbox" id="toggle-template" /> Show template.kml</label>
    <button id="toggle-stats">Stats</button>
    <div class="kmz-stats" id="stats" hidden>
      <div id="stats-body"></div>
      <div class="ks-cfg">
        <label>Speed (m/s) <input id="stats-speed" type="number" step="0.5" min="0.1" /></label>
        <label>Per waypoint (s) <input id="stats-wp" type="number" step="1" min="0" /></label>
      </div>
    </div>
    <button id="run-validation" hidden>Validate</button>
    <div class="kmz-validation" id="validation" hidden>
      <label>Dock serial <input id="val-serial" type="text" /></label>
      <label>Basestation repo <input id="val-repo" type="text" /></label>
      <label>Python <input id="val-python" type="text" /></label>
      <button id="val-run">Run</button>
      <div id="val-output"></div>
    </div>
  </div>
  <div class="kmz-legend" id="legend" hidden></div>
  <script nonce="${nonce}" src="${LEAFLET_JS}"></script>
  <script nonce="${nonce}">
    ${SHARED_PANEL_JS}

    var vscode = acquireVsCodeApi();

    var mapInstance = null;
    var featureLayer = null;
    var didFitInitialBounds = false;
    var state = {
      template: [], waylines: [], colorByHeight: false, showTemplate: null,
      showStats: false, statsConfig: { speedMps: 8, secondsPerWaypoint: 7 }
    };

    function ensureMap() {
      if (mapInstance) {
        featureLayer.clearLayers();
        return;
      }
      mapInstance = L.map('map', { maxZoom: ${MAP_MAX_ZOOM} });
      L.tileLayer('${TILE_IMAGERY}', {
        maxZoom: ${MAP_MAX_ZOOM},
        maxNativeZoom: ${TILE_MAX_NATIVE_ZOOM},
        attribution: '${TILE_IMAGERY_ATTRIBUTION.replace(/'/g, "\\'")}'
      }).addTo(mapInstance);
      featureLayer = L.layerGroup().addTo(mapInstance);
    }

    function waypointIcon(color) {
      return L.divIcon({
        className: 'kmz-vertex-wrap',
        html: '<div class="kmz-vertex" style="background:' + color + '"></div>',
        iconSize: [14, 14],
        iconAnchor: [7, 7]
      });
    }

    function openXmlLink(p) {
      var a = document.createElement('a');
      a.href = '#';
      a.className = 'kmz-open-xml';
      a.textContent = 'Open XML';
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        vscode.postMessage({ type: 'openXml', source: p.source, seriesIndex: p.seriesIndex });
      });
      return a;
    }

    function titlePopupContent(p, i) {
      var div = document.createElement('div');
      div.className = 'kmz-edit';
      var title = document.createElement('div');
      title.className = 'tt-title';
      title.textContent = pointTitle(p.source, p, i);
      div.appendChild(title);
      if (p.heightEditable) { div.appendChild(openXmlLink(p)); }
      return div;
    }

    function editPopupContent(p, i) {
      var div = document.createElement('div');
      div.className = 'kmz-edit';
      var title = document.createElement('div');
      title.className = 'tt-title';
      title.textContent = pointTitle(p.source, p, i);
      div.appendChild(title);

      var label = document.createElement('label');
      label.textContent = 'Height (m): ';
      var input = document.createElement('input');
      input.type = 'number';
      input.step = '0.1';
      if (p.height != null && isFinite(p.height)) {
        input.value = String(Math.round(p.height * 100) / 100);
      }
      label.appendChild(input);
      div.appendChild(label);

      var btn = document.createElement('button');
      btn.textContent = 'Save';
      div.appendChild(btn);

      var status = document.createElement('div');
      status.className = 'kmz-edit-status';
      div.appendChild(status);
      div.appendChild(openXmlLink(p));

      btn.addEventListener('click', function () {
        var v = Number(input.value);
        if (!isFinite(v)) {
          status.textContent = 'Enter a number.';
          return;
        }
        btn.disabled = true;
        btn.textContent = 'Saving…';
        vscode.postMessage({
          type: 'editHeight',
          source: p.source,
          ordinal: p.ordinal,
          index: p.index,
          heightField: p.heightField,
          height: v
        });
      });
      return div;
    }

    function render() {
      ensureMap();
      var showTemplatePts = state.showTemplate ? state.template : [];
      var visibleLists = [showTemplatePts, state.waylines];
      var range = pointsHeightRange(visibleLists);
      var bounds = [];

      function addSeries(points, source) {
        if (!points || points.length === 0) return;
        var seriesColor = SERIES_COLORS[source];
        var latlngs = points.map(function (p) { return [p.lat, p.lon]; });
        var poly = null;
        if (latlngs.length > 1) {
          poly = L.polyline(latlngs, { color: seriesColor, weight: 3, opacity: 0.75 }).addTo(featureLayer);
        }
        points.forEach(function (p, i) {
          var latlng = [p.lat, p.lon];
          var color = state.colorByHeight && range ? heightColor(p.height, range.min, range.max) : seriesColor;
          var marker;
          if (p.editable) {
            marker = L.marker(latlng, { draggable: true, icon: waypointIcon(color) });
            marker.on('drag', function () {
              if (!poly) return;
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
          } else {
            marker = L.circleMarker(latlng, {
              radius: 6,
              color: '#ffffff',
              weight: 1.5,
              fillColor: color,
              fillOpacity: 0.95
            });
          }
          marker.bindTooltip(tooltipHtml(p.source, p, i), {
            sticky: true,
            direction: 'top',
            opacity: 0.97,
            className: 'kmz-tip'
          });
          if (p.heightEditable) {
            marker.bindPopup(function () { return editPopupContent(p, i); });
          } else {
            marker.bindPopup(function () { return titlePopupContent(p, i); });
          }
          marker.addTo(featureLayer);
          bounds.push(latlng);
        });
      }

      addSeries(showTemplatePts, 'template');
      addSeries(state.waylines, 'waylines');

      renderLegend(showTemplatePts, range);
      renderStats();

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

    function renderLegend(templatePts, range) {
      var legend = document.getElementById('legend');
      var parts = [];
      [{ pts: templatePts, source: 'template' }, { pts: state.waylines, source: 'waylines' }].forEach(function (s) {
        if (!s.pts || s.pts.length === 0) return;
        var draggable = s.pts.some(function (p) { return p.editable; });
        parts.push('<div><span class="dot" style="background:' + SERIES_COLORS[s.source] + ';"></span>' +
          escapeHtml(seriesLabel(s.source)) + (draggable ? ' <span class="tt-dim">(drag to edit)</span>' : '') + '</div>');
      });
      if (state.colorByHeight && range) {
        parts.push('<div class="ramp" style="background:' + rampCss() + ';"></div>');
        parts.push('<div class="ramp-labels"><span>' + fmtMeters(range.min) + ' m</span><span>' +
          fmtMeters(range.max) + ' m</span></div>');
      }
      legend.innerHTML = parts.join('');
      legend.hidden = parts.length === 0;
    }

    function renderStats() {
      var el = document.getElementById('stats');
      el.hidden = !state.showStats;
      if (el.hidden) { return; }
      var vis = [];
      if (state.showTemplate && state.template.length) { vis.push({ source: 'template', points: state.template }); }
      if (state.waylines.length) { vis.push({ source: 'waylines', points: state.waylines }); }
      document.getElementById('stats-body').innerHTML = statsHtml(vis, state.statsConfig);
    }

    var statsInputs = wireStatsInputs(state, renderStats, function (cfg) {
      vscode.postMessage({ type: 'setStatsConfig', speedMps: cfg.speedMps, secondsPerWaypoint: cfg.secondsPerWaypoint });
    });
    statsInputs.sync();

    var validation = wireValidation(function (cfg) {
      vscode.postMessage({
        type: 'runValidation',
        dockSerial: cfg.dockSerial,
        basestationRepo: cfg.basestationRepo,
        pythonPath: cfg.pythonPath
      });
    }, function (cfg) {
      vscode.postMessage({
        type: 'setValidationConfig',
        dockSerial: cfg.dockSerial,
        basestationRepo: cfg.basestationRepo,
        pythonPath: cfg.pythonPath
      });
    });

    document.getElementById('toggle-stats').addEventListener('click', function () {
      state.showStats = !state.showStats;
      renderStats();
    });
    document.getElementById('toggle-color').addEventListener('change', function (e) {
      state.colorByHeight = e.target.checked;
      render();
    });
    document.getElementById('toggle-template').addEventListener('change', function (e) {
      state.showTemplate = e.target.checked;
      render();
    });

    window.addEventListener('message', function (event) {
      var m = event.data;
      if (!m) { return; }
      if (m.type === 'validationStarted') {
        validation.showStarted(m.command);
        return;
      }
      if (m.type === 'validation') {
        validation.showResult(m);
        return;
      }
      if (m.type !== 'data') { return; }
      validation.update(m.validation);
      state.template = m.template || [];
      state.waylines = m.waylines || [];
      if (m.statsConfig) {
        state.statsConfig = m.statsConfig;
        statsInputs.sync();
      }
      var toggleRow = document.getElementById('template-toggle-row');
      var bothPresent = state.template.length > 0 && state.waylines.length > 0;
      if (bothPresent) {
        toggleRow.hidden = false;
        if (state.showTemplate === null) {
          state.showTemplate = false;
        }
        document.getElementById('toggle-template').checked = state.showTemplate;
      } else {
        toggleRow.hidden = true;
        state.showTemplate = state.template.length > 0;
      }
      render();
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
