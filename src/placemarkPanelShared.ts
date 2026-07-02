import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ParsedPlacemarkPoint, PlacemarkSource } from './kmlPlacemarks';
import type { PlacemarkMapEditUris } from './placemarkMapPanel';

export type StatsConfig = {
  speedMps: number;
  secondsPerWaypoint: number;
};

export function getStatsConfig(): StatsConfig {
  const cfg = vscode.workspace.getConfiguration('levitKmz.stats');
  return {
    speedMps: cfg.get<number>('speedMps', 8),
    secondsPerWaypoint: cfg.get<number>('secondsPerWaypoint', 7),
  };
}

export type OpenXmlMessage = { type: 'openXml'; source: PlacemarkSource; seriesIndex: number };

export function isOpenXmlMessage(msg: unknown): msg is OpenXmlMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }
  const m = msg as Record<string, unknown>;
  return (
    m.type === 'openXml' &&
    (m.source === 'template' || m.source === 'waylines') &&
    typeof m.seriesIndex === 'number' &&
    Number.isInteger(m.seriesIndex) &&
    m.seriesIndex >= 0
  );
}

/** Open the backing XML beside the panel and select the placemark's coordinates. */
export async function revealPlacemarkXml(
  uri: vscode.Uri | undefined,
  point: ParsedPlacemarkPoint | undefined
): Promise<void> {
  if (!uri) {
    void vscode.window.showInformationMessage('This layer is not backed by an openable file.');
    return;
  }
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
    const span = point?.coordSpan;
    if (span) {
      const start = doc.positionAt(span.start);
      const end = doc.positionAt(span.end);
      editor.selection = new vscode.Selection(start, end);
      editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`Could not open XML: ${detail}`);
  }
}

const VALIDATOR_SCRIPT = 'dji_dock/manual_utils/validate_kmz_safety.py';
const VALIDATOR_KILL_MS = 120000;

export type ValidationResult = { ok: boolean; exitCode: number | null; lines: string[] };

export type ValidationSettings = { pythonPath: string; basestationRepo: string; dockSerial: string };

export function getValidationSettings(): ValidationSettings {
  const cfg = vscode.workspace.getConfiguration('levitKmz.validation');
  return {
    pythonPath: cfg.get<string>('pythonPath', ''),
    basestationRepo: cfg.get<string>('basestationRepo', ''),
    dockSerial: cfg.get<string>('dockSerial', ''),
  };
}

export type RunValidationMessage = {
  type: 'runValidation';
  pythonPath?: unknown;
  basestationRepo?: unknown;
  dockSerial?: unknown;
};

export function isRunValidationMessage(msg: unknown): msg is RunValidationMessage {
  return !!msg && typeof msg === 'object' && (msg as { type?: unknown }).type === 'runValidation';
}

function asTrimmed(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function expandHome(p: string): string {
  if (p === '~') {
    return os.homedir();
  }
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

type ValidationSettingsMessage = { pythonPath?: unknown; basestationRepo?: unknown; dockSerial?: unknown };

function persistValidationSettings(msg: ValidationSettingsMessage): ValidationSettings {
  const cfg = vscode.workspace.getConfiguration('levitKmz.validation');
  const pythonPath = asTrimmed(msg.pythonPath);
  const repo = asTrimmed(msg.basestationRepo);
  const serial = asTrimmed(msg.dockSerial);
  const saved = getValidationSettings();
  if (pythonPath !== saved.pythonPath) {
    void cfg.update('pythonPath', pythonPath, vscode.ConfigurationTarget.Global);
  }
  if (repo !== saved.basestationRepo) {
    void cfg.update('basestationRepo', repo, vscode.ConfigurationTarget.Global);
  }
  if (serial !== saved.dockSerial) {
    void cfg.update('dockSerial', serial, vscode.ConfigurationTarget.Global);
  }
  return { pythonPath, basestationRepo: repo, dockSerial: serial };
}

/** Persist a webview 'setValidationConfig' message into user settings; true if it was one. */
export function applyValidationConfigUpdate(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'setValidationConfig') {
    return false;
  }
  persistValidationSettings(msg as ValidationSettingsMessage);
  return true;
}

/** Persist the popout's settings, then run the validator and post progress/result to the webview. */
export async function handleRunValidation(
  msg: RunValidationMessage,
  missionKmzFsPath: string,
  post: (m: unknown) => void
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('levitKmz.validation');
  const { pythonPath, basestationRepo: repo, dockSerial: serial } = persistValidationSettings(msg);

  const missing = [
    !serial ? 'dock serial' : null,
    !repo ? 'basestation repo' : null,
    !pythonPath ? 'python location' : null,
  ].filter((x): x is string => !!x);
  if (missing.length > 0) {
    post({
      type: 'validation',
      ok: false,
      exitCode: null,
      command: '',
      lines: [`Missing: ${missing.join(', ')}. Fill in the fields above and Run again.`],
    });
    return;
  }

  const extraArgs = cfg.get<string[]>('extraArgs', []);
  const python = expandHome(pythonPath);
  const args = [VALIDATOR_SCRIPT, serial, missionKmzFsPath, ...extraArgs];
  const command = ['PYTHONPATH=.', python, ...args].join(' ');
  post({ type: 'validationStarted', command });
  const result = await runValidatorProcess(python, args, expandHome(repo));
  post({ type: 'validation', command, ...result });
}

function runValidatorProcess(pythonPath: string, args: string[], cwd: string): Promise<ValidationResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(pythonPath, args, { cwd, env: { ...process.env, PYTHONPATH: '.' } });
    } catch (e) {
      resolve({
        ok: false,
        exitCode: null,
        lines: [`Failed to start validator: ${e instanceof Error ? e.message : String(e)}`],
      });
      return;
    }
    let out = '';
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.stderr?.on('data', (d) => {
      out += String(d);
    });
    const timer = setTimeout(() => {
      out += `\nValidator killed after ${VALIDATOR_KILL_MS / 1000}s.`;
      child.kill('SIGKILL');
    }, VALIDATOR_KILL_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: null, lines: [`Failed to run validator: ${e.message}`] });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        lines.push('Validator produced no output.');
      }
      resolve({ ok: code === 0, exitCode: code, lines });
    });
  });
}

/** Persist a webview 'setStatsConfig' message into user settings; true if it was one. */
export function applyStatsConfigUpdate(msg: unknown): boolean {
  if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'setStatsConfig') {
    return false;
  }
  const m = msg as { speedMps?: unknown; secondsPerWaypoint?: unknown };
  const cfg = vscode.workspace.getConfiguration('levitKmz.stats');
  if (typeof m.speedMps === 'number' && isFinite(m.speedMps) && m.speedMps > 0) {
    void cfg.update('speedMps', m.speedMps, vscode.ConfigurationTarget.Global);
  }
  if (typeof m.secondsPerWaypoint === 'number' && isFinite(m.secondsPerWaypoint) && m.secondsPerWaypoint >= 0) {
    void cfg.update('secondsPerWaypoint', m.secondsPerWaypoint, vscode.ConfigurationTarget.Global);
  }
  return true;
}

export const SERIES_COLORS: Record<PlacemarkSource, string> = {
  template: '#2563eb',
  waylines: '#ea580c',
};

/** Sequential blue ramp (steps 100→700), light = low, dark = high. */
export const HEIGHT_RAMP = [
  '#cde2fb',
  '#9ec5f4',
  '#6da7ec',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#104281',
  '#0d366b',
];

export type WebviewPointPayload = {
  lon: number;
  lat: number;
  alt?: number;
  index?: number;
  ordinal: number;
  source: PlacemarkSource;
  seriesIndex: number;
  /** Position (lon/lat) can be edited by dragging. */
  editable: boolean;
  /** Height can be edited (a writable backing file exists). */
  heightEditable: boolean;
  height?: number;
  heightField?: string;
  ellipsoidHeight?: number;
  actions: { func: string; params: Record<string, string> }[];
  extra: Record<string, string>;
};

export function toWebviewPoint(
  p: ParsedPlacemarkPoint,
  source: PlacemarkSource,
  seriesIndex: number,
  edit: PlacemarkMapEditUris | undefined
): WebviewPointPayload {
  const uri = source === 'template' ? edit?.templateUri : edit?.waylinesUri;
  return {
    lon: p.lon,
    lat: p.lat,
    alt: p.alt,
    index: p.index,
    ordinal: p.ordinal,
    source,
    seriesIndex,
    editable: !!uri && !!p.coordSpan,
    heightEditable: !!uri,
    height: p.height,
    heightField: p.heightField,
    ellipsoidHeight: p.ellipsoidHeight,
    actions: p.actions,
    extra: p.extra,
  };
}

export function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** CSS shared by the 2D and 3D panels: controls box, legend, and tooltip content. */
export const PANEL_WIDGET_CSS = `
  .kmz-controls {
    position: absolute; top: 12px; right: 12px; z-index: 1000;
    background: rgba(255,255,255,0.94); padding: 8px 12px; border-radius: 6px;
    font: 12px/1.6 system-ui, sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,0.25); color: #1f2937;
  }
  .kmz-controls label { display: block; cursor: pointer; user-select: none; }
  .kmz-controls input { vertical-align: middle; margin-right: 5px; }
  .kmz-controls button { display: block; width: 100%; margin-top: 6px; cursor: pointer; font: inherit; }
  .kmz-stats { margin-top: 6px; border-top: 1px solid #d1d5db; padding-top: 6px; min-width: 190px; }
  .kmz-stats .ks-title { font-weight: 600; margin-top: 4px; }
  .kmz-stats .ks-row { display: flex; justify-content: space-between; gap: 12px; }
  .kmz-stats .ks-k, .kmz-stats .ks-note { color: #6b7280; }
  .kmz-stats .ks-note { margin-top: 4px; }
  .kmz-stats .ks-cfg { margin-top: 6px; border-top: 1px solid #d1d5db; padding-top: 4px; }
  .kmz-stats .ks-cfg label { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .kmz-stats .ks-cfg input { width: 56px; }
  .kmz-validation { margin-top: 6px; border-top: 1px solid #d1d5db; padding-top: 6px; max-width: 360px; max-height: 45vh; overflow: auto; }
  .kmz-validation label { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 2px; }
  .kmz-validation input { width: 180px; font: 11px ui-monospace, Menlo, monospace; }
  .kmz-validation .v-line { font: 11px/1.4 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
  .kmz-validation .v-cmd { color: #4b5563; margin-bottom: 4px; }
  .kmz-validation #val-output { margin-top: 4px; }
  .kmz-validation .v-ok { color: #15803d; font-weight: 600; }
  .kmz-validation .v-fail { color: #b91c1c; font-weight: 600; }
  .kmz-edit .kmz-open-xml { display: inline-block; margin-top: 4px; }
  .kmz-legend {
    position: absolute; bottom: 24px; right: 12px; z-index: 1000;
    background: rgba(255,255,255,0.94); padding: 8px 12px; border-radius: 6px;
    font: 12px/1.5 system-ui, sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,0.25); color: #1f2937;
  }
  .kmz-legend .dot { display: inline-block; width: 12px; height: 12px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  .kmz-legend .ramp { width: 140px; height: 10px; border-radius: 3px; margin-top: 4px; }
  .kmz-legend .ramp-labels { display: flex; justify-content: space-between; color: #4b5563; }
  .kmz-tt { font: 12px/1.45 system-ui, sans-serif; max-width: 320px; }
  .kmz-tt .tt-title { font-weight: 600; margin-bottom: 2px; }
  .kmz-tt .tt-sec { margin-top: 5px; }
  .kmz-tt .tt-dim { color: #6b7280; }
  .kmz-tt .tt-action { padding-left: 8px; }
  .kmz-tt table { border-collapse: collapse; margin-top: 2px; width: 316px; table-layout: fixed; }
  .kmz-tt td { padding: 0 8px 0 0; vertical-align: top; color: #374151; overflow-wrap: anywhere; }
  .kmz-tt td:first-child { color: #6b7280; width: 60%; }
`;

/**
 * Plain-JS helpers injected into both webviews: colors, height ramp interpolation,
 * HTML escaping, and the hover tooltip content builder.
 */
export const SHARED_PANEL_JS = `
  var SERIES_COLORS = ${JSON.stringify(SERIES_COLORS)};
  var RAMP = ${JSON.stringify(HEIGHT_RAMP)};

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function seriesLabel(source) { return source === 'template' ? 'template.kml' : 'waylines.wpml'; }

  function pointTitle(source, p, i) {
    return seriesLabel(source) + ' ' + (p.index != null ? '#' + p.index : '(' + i + ')');
  }

  function fmtMeters(h) { return String(Math.round(h * 10) / 10); }

  function mixHex(a, b, t) {
    function ch(hex, i) { return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16); }
    var r = Math.round(ch(a, 0) + (ch(b, 0) - ch(a, 0)) * t);
    var g = Math.round(ch(a, 1) + (ch(b, 1) - ch(a, 1)) * t);
    var bl = Math.round(ch(a, 2) + (ch(b, 2) - ch(a, 2)) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  function heightColor(h, min, max) {
    if (h == null || !isFinite(h)) { return '#9ca3af'; }
    var t = max > min ? (h - min) / (max - min) : 0.5;
    t = Math.max(0, Math.min(1, t));
    var x = t * (RAMP.length - 1);
    var i = Math.floor(x);
    if (i >= RAMP.length - 1) { return RAMP[RAMP.length - 1]; }
    return mixHex(RAMP[i], RAMP[i + 1], x - i);
  }

  function rampCss() { return 'linear-gradient(to right, ' + RAMP.join(', ') + ')'; }

  function pointsHeightRange(pointLists) {
    var min = Infinity, max = -Infinity;
    pointLists.forEach(function (points) {
      points.forEach(function (p) {
        if (p.height != null && isFinite(p.height)) {
          if (p.height < min) { min = p.height; }
          if (p.height > max) { max = p.height; }
        }
      });
    });
    return min <= max ? { min: min, max: max } : null;
  }

  function segMeters(a, b) {
    var rad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * rad;
    var dLon = (b.lon - a.lon) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    var ground = 2 * 6371000 * Math.asin(Math.sqrt(s));
    if (a.height != null && isFinite(a.height) && b.height != null && isFinite(b.height)) {
      var dz = b.height - a.height;
      return Math.sqrt(ground * ground + dz * dz);
    }
    return ground;
  }

  function pathMeters(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) { total += segMeters(points[i - 1], points[i]); }
    return total;
  }

  function fmtDistance(m) {
    return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : fmtMeters(m) + ' m';
  }

  function fmtDuration(totalSeconds) {
    var s = Math.round(totalSeconds);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) { return h + 'h ' + m + 'm ' + sec + 's'; }
    if (m > 0) { return m + 'm ' + sec + 's'; }
    return sec + 's';
  }

  function statsRow(k, v) {
    return '<div class="ks-row"><span class="ks-k">' + escapeHtml(k) + '</span><span>' + escapeHtml(v) + '</span></div>';
  }

  function statsHtml(vis, cfg) {
    var parts = [];
    vis.forEach(function (s) {
      if (!s.points || s.points.length === 0) { return; }
      var range = pointsHeightRange([s.points]);
      var length = pathMeters(s.points);
      var secs = (cfg.speedMps > 0 ? length / cfg.speedMps : 0) + s.points.length * cfg.secondsPerWaypoint;
      parts.push('<div class="ks-title">' + escapeHtml(seriesLabel(s.source)) + '</div>');
      parts.push(statsRow('Waypoints', String(s.points.length)));
      parts.push(statsRow('Min height', range ? fmtMeters(range.min) + ' m' : 'n/a'));
      parts.push(statsRow('Max height', range ? fmtMeters(range.max) + ' m' : 'n/a'));
      parts.push(statsRow('Path length', fmtDistance(length)));
      parts.push(statsRow('Est. time', fmtDuration(secs)));
    });
    if (parts.length === 0) { return '<div class="ks-note">No points.</div>'; }
    return parts.join('');
  }

  function validationHtml(r) {
    var parts = [];
    var head = r.ok ? '<div class="v-ok">PASSED' : '<div class="v-fail">FAILED';
    parts.push(head + (r.exitCode != null ? ' (exit ' + r.exitCode + ')' : '') + '</div>');
    (r.lines || []).forEach(function (l) {
      parts.push('<div class="v-line">' + escapeHtml(l) + '</div>');
    });
    return parts.join('');
  }

  function wireValidation(postRun, persistCfg) {
    var btn = document.getElementById('run-validation');
    var box = document.getElementById('validation');
    var fields = {
      dockSerial: document.getElementById('val-serial'),
      basestationRepo: document.getElementById('val-repo'),
      pythonPath: document.getElementById('val-python')
    };
    var out = document.getElementById('val-output');
    function fieldValues() {
      return {
        dockSerial: fields.dockSerial.value.trim(),
        basestationRepo: fields.basestationRepo.value.trim(),
        pythonPath: fields.pythonPath.value.trim()
      };
    }
    btn.addEventListener('click', function () { box.hidden = !box.hidden; });
    Object.keys(fields).forEach(function (k) {
      fields[k].addEventListener('change', function () { persistCfg(fieldValues()); });
    });
    document.getElementById('val-run').addEventListener('click', function () {
      out.innerHTML = '<div class="v-line">Running validator…</div>';
      postRun(fieldValues());
    });
    function cmdHtml(command) {
      return command ? '<div class="v-line v-cmd">$ ' + escapeHtml(command) + '</div>' : '';
    }
    return {
      update: function (v) {
        btn.hidden = !v || !v.hasMission;
        Object.keys(fields).forEach(function (k) {
          var el = fields[k];
          if (document.activeElement !== el) { el.value = (v && v[k]) || ''; }
        });
      },
      showStarted: function (command) {
        out.innerHTML = cmdHtml(command) + '<div class="v-line">Running…</div>';
      },
      showResult: function (r) {
        out.innerHTML = cmdHtml(r.command) + validationHtml(r);
      }
    };
  }

  function wireStatsInputs(state, rerender, persist) {
    var speed = document.getElementById('stats-speed');
    var wp = document.getElementById('stats-wp');
    function current() {
      var s = Number(speed.value);
      var w = Number(wp.value);
      return {
        speedMps: isFinite(s) && s > 0 ? s : state.statsConfig.speedMps,
        secondsPerWaypoint: isFinite(w) && w >= 0 ? w : state.statsConfig.secondsPerWaypoint
      };
    }
    [speed, wp].forEach(function (el) {
      el.addEventListener('input', function () {
        state.statsConfig = current();
        rerender();
      });
      el.addEventListener('change', function () { persist(state.statsConfig); });
    });
    return {
      sync: function () {
        if (document.activeElement !== speed) { speed.value = String(state.statsConfig.speedMps); }
        if (document.activeElement !== wp) { wp.value = String(state.statsConfig.secondsPerWaypoint); }
      }
    };
  }

  function tooltipHtml(source, p, i) {
    var parts = [];
    parts.push('<div class="tt-title">' + escapeHtml(pointTitle(source, p, i)) + '</div>');
    var h = p.height != null && isFinite(p.height) ? fmtMeters(p.height) + ' m' : 'n/a';
    var hSrc = p.heightField ? ' <span class="tt-dim">(' + escapeHtml(p.heightField) + ')</span>' : '';
    parts.push('<div><b>Height:</b> ' + h + hSrc + '</div>');
    if (p.ellipsoidHeight != null) {
      parts.push('<div><b>Ellipsoid height:</b> ' + fmtMeters(p.ellipsoidHeight) + ' m</div>');
    }
    parts.push('<div class="tt-dim">' + p.lat.toFixed(7) + ', ' + p.lon.toFixed(7) + '</div>');
    var actions = p.actions || [];
    if (actions.length) {
      parts.push('<div class="tt-sec"><b>Actions (' + actions.length + ')</b></div>');
      actions.slice(0, 8).forEach(function (a) {
        var ps = Object.keys(a.params || {}).map(function (k) {
          return escapeHtml(k) + '=' + escapeHtml(a.params[k]);
        }).join(', ');
        parts.push('<div class="tt-action">' + escapeHtml(a.func) + (ps ? ' <span class="tt-dim">' + ps + '</span>' : '') + '</div>');
      });
      if (actions.length > 8) { parts.push('<div class="tt-dim">+' + (actions.length - 8) + ' more…</div>'); }
    }
    var keys = Object.keys(p.extra || {});
    if (keys.length) {
      parts.push('<div class="tt-sec"><b>Waypoint data</b></div>');
      parts.push('<table>');
      keys.slice(0, 14).forEach(function (k) {
        parts.push('<tr><td>' + escapeHtml(k) + '</td><td>' + escapeHtml(p.extra[k]) + '</td></tr>');
      });
      parts.push('</table>');
      if (keys.length > 14) { parts.push('<div class="tt-dim">+' + (keys.length - 14) + ' more fields…</div>'); }
    }
    return '<div class="kmz-tt">' + parts.join('') + '</div>';
  }
`;
