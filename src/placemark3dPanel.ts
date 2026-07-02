import * as path from 'path';
import * as vscode from 'vscode';
import type { ParsedPlacemarkPoint } from './kmlPlacemarks';
import type { PlacemarkMapEditUris, PlacemarkMapLiveReload } from './placemarkMapPanel';
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

const THREE_CDN = 'https://cdn.jsdelivr.net';
const THREE_MODULE = `${THREE_CDN}/npm/three@0.160.0/build/three.module.js`;
const THREE_ADDONS = `${THREE_CDN}/npm/three@0.160.0/examples/jsm/`;

const LIVE_RELOAD_DEBOUNCE_MS = 200;

let activePanel: vscode.WebviewPanel | undefined;

export type Placemark3dPanelOptions = {
  liveReload?: PlacemarkMapLiveReload;
  edit?: PlacemarkMapEditUris;
  /** On-disk path of the source .kmz, when known; enables the safety validator. */
  missionKmzFsPath?: string;
};

export function openPlacemark3dPanel(
  context: vscode.ExtensionContext,
  title: string,
  template: ParsedPlacemarkPoint[],
  waylines: ParsedPlacemarkPoint[],
  options?: Placemark3dPanelOptions
): void {
  if (activePanel) {
    activePanel.dispose();
  }

  const liveReload = options?.liveReload;
  const edit = options?.edit;
  const missionKmzFsPath = options?.missionKmzFsPath;

  const panel = vscode.window.createWebviewPanel(
    'kmzPlacemark3d',
    title,
    vscode.ViewColumn.One,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel = panel;

  const nonce = getNonce();
  const csp = [
    "default-src 'none'",
    // A nonce here would block the inline style="" attributes used for legend colors.
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${THREE_CDN}`,
    `img-src ${panel.webview.cspSource} data: blob:`,
  ].join('; ');

  panel.webview.html = getHtml(csp, nonce);

  let currentTemplate = template;
  let currentWaylines = waylines;

  const postParsed = (t: ParsedPlacemarkPoint[], w: ParsedPlacemarkPoint[]): void => {
    currentTemplate = t;
    currentWaylines = w;
    void panel.webview.postMessage({
      type: 'data' as const,
      template: t.map((p, i) => toWebviewPoint(p, 'template', i, edit)),
      waylines: w.map((p, i) => toWebviewPoint(p, 'waylines', i, edit)),
      statsConfig: getStatsConfig(),
      validation: { hasMission: !!missionKmzFsPath, ...getValidationSettings() },
    });
  };

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
        (err) => console.warn('[levit-kmz] 3D reload failed:', err)
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

  watchDisposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('levitKmz.stats') || e.affectsConfiguration('levitKmz.validation')) {
        postParsed(currentTemplate, currentWaylines);
      }
    })
  );

  panel.webview.onDidReceiveMessage((msg: { type?: string }) => {
    if (msg?.type === 'ready') {
      postParsed(currentTemplate, currentWaylines);
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
    if (isRunValidationMessage(msg) && missionKmzFsPath) {
      void handleRunValidation(msg, missionKmzFsPath, (m) => void panel.webview.postMessage(m));
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

function getHtml(csp: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <style nonce="${nonce}">
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; background: #1e2228; }
    #scene { position: absolute; inset: 0; }
    #tooltip {
      position: absolute; z-index: 1200; pointer-events: none; display: none;
      background: rgba(255,255,255,0.96); color: #1f2937; padding: 6px 9px;
      border-radius: 6px; box-shadow: 0 1px 6px rgba(0,0,0,0.4); max-width: 340px;
    }
    #empty {
      position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      color: #9ca3af; font: 14px system-ui, sans-serif;
    }
    ${PANEL_WIDGET_CSS}
  </style>
  <script type="importmap" nonce="${nonce}">
    {
      "imports": {
        "three": "${THREE_MODULE}",
        "three/addons/": "${THREE_ADDONS}"
      }
    }
  </script>
</head>
<body>
  <div id="scene"></div>
  <div id="empty">No placemark points to display.</div>
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
  <div id="tooltip"></div>
  <script nonce="${nonce}">
    ${SHARED_PANEL_JS}
  </script>
  <script type="module" nonce="${nonce}">
    import * as THREE from 'three';
    import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

    const vscode = acquireVsCodeApi();
    const container = document.getElementById('scene');
    const tooltip = document.getElementById('tooltip');

    const state = {
      template: [], waylines: [], colorByHeight: false, showTemplate: null, fitted: false,
      showStats: false, statsConfig: { speedMps: 8, secondsPerWaypoint: 7 }
    };

    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#1e2228');
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100000);
    camera.position.set(80, 80, 80);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, 2, 1.5);
    scene.add(sun);

    let dataGroup = null;
    let markerMeshes = [];
    let hovered = null;

    function resize() {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener('resize', resize);
    resize();

    function visibleSeries() {
      const out = [];
      if (state.showTemplate && state.template.length) { out.push({ source: 'template', points: state.template }); }
      if (state.waylines.length) { out.push({ source: 'waylines', points: state.waylines }); }
      return out;
    }

    /** Equirectangular projection to local metres around the centroid of all points. */
    function makeProjector() {
      let latSum = 0, lonSum = 0, n = 0;
      [state.template, state.waylines].forEach(function (points) {
        points.forEach(function (p) { latSum += p.lat; lonSum += p.lon; n++; });
      });
      if (n === 0) { return null; }
      const lat0 = latSum / n, lon0 = lonSum / n;
      const mPerDegLat = 111320;
      const mPerDegLon = 111320 * Math.cos(lat0 * Math.PI / 180);
      return function (p) {
        return new THREE.Vector3(
          (p.lon - lon0) * mPerDegLon,
          p.height != null && isFinite(p.height) ? p.height : 0,
          -(p.lat - lat0) * mPerDegLat
        );
      };
    }

    function niceStep(raw) {
      const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];
      for (let i = 0; i < steps.length; i++) {
        if (steps[i] >= raw) { return steps[i]; }
      }
      return steps[steps.length - 1];
    }

    function disposeGroup(group) {
      group.traverse(function (obj) {
        if (obj.geometry) { obj.geometry.dispose(); }
        if (obj.material) {
          (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach(function (m) { m.dispose(); });
        }
      });
    }

    function rebuild() {
      if (dataGroup) {
        scene.remove(dataGroup);
        disposeGroup(dataGroup);
      }
      dataGroup = new THREE.Group();
      markerMeshes = [];
      hovered = null;
      tooltip.style.display = 'none';

      // Project using ALL points so toggling template doesn't shift the origin.
      const project = makeProjector();
      const vis = visibleSeries();
      const total = vis.reduce(function (acc, s) { return acc + s.points.length; }, 0);
      document.getElementById('empty').style.display = project && total > 0 ? 'none' : 'flex';
      renderLegend(vis);
      renderStats();
      if (!project || total === 0) { scene.add(dataGroup); return; }

      const range = pointsHeightRange(vis.map(function (s) { return s.points; }));
      const box = new THREE.Box3();
      vis.forEach(function (s) { s.points.forEach(function (p) { box.expandByPoint(project(p)); }); });
      const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 50);
      const markerRadius = Math.min(Math.max(span * 0.009, 0.5), 6);
      const sphereGeom = new THREE.SphereGeometry(markerRadius, 20, 14);

      const stemPositions = [];

      vis.forEach(function (s) {
        const seriesColor = SERIES_COLORS[s.source];
        const pathPoints = [];
        s.points.forEach(function (p, i) {
          const pos = project(p);
          pathPoints.push(pos);
          const color = state.colorByHeight && range
            ? heightColor(p.height, range.min, range.max)
            : seriesColor;
          const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55, metalness: 0.05 });
          const mesh = new THREE.Mesh(sphereGeom, mat);
          mesh.position.copy(pos);
          mesh.userData = { source: s.source, point: p, i: i };
          dataGroup.add(mesh);
          markerMeshes.push(mesh);
          stemPositions.push(pos.x, 0, pos.z, pos.x, pos.y, pos.z);
        });
        if (pathPoints.length > 1) {
          const geom = new THREE.BufferGeometry().setFromPoints(pathPoints);
          const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: new THREE.Color(seriesColor), transparent: true, opacity: 0.85 }));
          dataGroup.add(line);
        }
      });

      if (stemPositions.length > 0) {
        const stemGeom = new THREE.BufferGeometry();
        stemGeom.setAttribute('position', new THREE.Float32BufferAttribute(stemPositions, 3));
        dataGroup.add(new THREE.LineSegments(stemGeom, new THREE.LineBasicMaterial({ color: 0x8a93a3, transparent: true, opacity: 0.35 })));
      }

      const gridSize = Math.ceil((span * 1.5) / 10) * 10;
      const cell = niceStep(gridSize / 24);
      const grid = new THREE.GridHelper(gridSize, Math.max(2, Math.round(gridSize / cell)), 0x5b6472, 0x353c47);
      const center = box.getCenter(new THREE.Vector3());
      grid.position.set(center.x, 0, center.z);
      dataGroup.add(grid);

      scene.add(dataGroup);

      if (!state.fitted) {
        const target = new THREE.Vector3(center.x, (box.min.y + box.max.y) / 2, center.z);
        const dist = Math.max(span, box.max.y - box.min.y, 60) * 1.1;
        camera.position.set(target.x + dist * 0.65, target.y + dist * 0.6, target.z + dist * 0.65);
        controls.target.copy(target);
        controls.update();
        state.fitted = true;
      }
    }

    function renderLegend(vis) {
      const legend = document.getElementById('legend');
      const range = pointsHeightRange(vis.map(function (s) { return s.points; }));
      const parts = [];
      vis.forEach(function (s) {
        if (s.points.length === 0) { return; }
        parts.push('<div><span class="dot" style="background:' + SERIES_COLORS[s.source] + ';"></span>' +
          escapeHtml(seriesLabel(s.source)) + '</div>');
      });
      if (state.colorByHeight && range) {
        parts.push('<div class="ramp" style="background:' + rampCss() + ';"></div>');
        parts.push('<div class="ramp-labels"><span>' + fmtMeters(range.min) + ' m</span><span>' +
          fmtMeters(range.max) + ' m</span></div>');
      }
      legend.innerHTML = parts.join('');
      legend.hidden = parts.length === 0;
    }

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    renderer.domElement.addEventListener('pointermove', function (e) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(markerMeshes, false);
      const hit = hits.length > 0 ? hits[0].object : null;
      if (hovered && hovered !== hit) {
        hovered.scale.setScalar(1);
        hovered = null;
      }
      if (hit) {
        hovered = hit;
        hovered.scale.setScalar(1.45);
        const d = hit.userData;
        tooltip.innerHTML = tooltipHtml(d.source, d.point, d.i);
        tooltip.style.display = 'block';
        const tx = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
        const ty = Math.min(e.clientY + 14, window.innerHeight - tooltip.offsetHeight - 8);
        tooltip.style.left = tx + 'px';
        tooltip.style.top = ty + 'px';
      } else {
        tooltip.style.display = 'none';
      }
    });
    renderer.domElement.addEventListener('pointerleave', function () {
      if (hovered) { hovered.scale.setScalar(1); hovered = null; }
      tooltip.style.display = 'none';
    });

    let downX = 0, downY = 0;
    renderer.domElement.addEventListener('pointerdown', function (e) {
      downX = e.clientX;
      downY = e.clientY;
    });
    renderer.domElement.addEventListener('pointerup', function (e) {
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) { return; }
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(markerMeshes, false);
      if (hits.length === 0) { return; }
      const d = hits[0].object.userData;
      if (!d.point.heightEditable) { return; }
      vscode.postMessage({ type: 'openXml', source: d.source, seriesIndex: d.point.seriesIndex });
    });

    function renderStats() {
      const el = document.getElementById('stats');
      el.hidden = !state.showStats;
      if (el.hidden) { return; }
      document.getElementById('stats-body').innerHTML = statsHtml(visibleSeries(), state.statsConfig);
    }

    const statsInputs = wireStatsInputs(state, renderStats, function (cfg) {
      vscode.postMessage({ type: 'setStatsConfig', speedMps: cfg.speedMps, secondsPerWaypoint: cfg.secondsPerWaypoint });
    });
    statsInputs.sync();

    const validation = wireValidation(function (cfg) {
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
      rebuild();
    });
    document.getElementById('toggle-template').addEventListener('change', function (e) {
      state.showTemplate = e.target.checked;
      rebuild();
    });

    window.addEventListener('message', function (event) {
      const m = event.data;
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
      const toggleRow = document.getElementById('template-toggle-row');
      const bothPresent = state.template.length > 0 && state.waylines.length > 0;
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
      rebuild();
    });

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
