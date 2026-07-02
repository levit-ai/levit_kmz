import { XMLParser } from 'fast-xml-parser';

export type PlacemarkSource = 'template' | 'waylines';

/** UTF-16 code unit offsets into the XML string; replaces `xml.slice(start, end)` inside `<coordinates>`. */
export type CoordSpan = { start: number; end: number };

export type WaypointAction = {
  /** DJI actuator function, e.g. takePhoto, gimbalRotate, hover. */
  func: string;
  /** Actuator params, stringified scalar values. */
  params: Record<string, string>;
};

/** Where a point's displayed height came from (also the field an edit writes back to). */
export type HeightField = 'executeHeight' | 'height' | 'coordinates';

export type ParsedPlacemarkPoint = {
  lon: number;
  lat: number;
  /** Altitude from the KML coordinates string, if present. */
  alt?: number;
  /** wpml:index, if present. */
  index?: number;
  /** 0-based position among all Placemarks in the file, in document order. */
  ordinal: number;
  source: PlacemarkSource;
  coordSpan?: CoordSpan;
  /** Best-known waypoint height in metres: executeHeight ?? height ?? coordinate alt. */
  height?: number;
  heightField?: HeightField;
  ellipsoidHeight?: number;
  actions: WaypointAction[];
  /** Remaining simple per-waypoint fields (speed, heading, turn params, …), flattened to dot paths. */
  extra: Record<string, string>;
};

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
});

export function extractPlacemarkPoints(xml: string, source: PlacemarkSource): ParsedPlacemarkPoint[] {
  let root: unknown;
  try {
    root = parser.parse(xml);
  } catch {
    return [];
  }
  const marks = collectPlacemarks(root);
  const out: ParsedPlacemarkPoint[] = [];
  for (let ordinal = 0; ordinal < marks.length; ordinal++) {
    const pt = placemarkToPoint(marks[ordinal]);
    if (pt) {
      out.push({ ...pt, ordinal, source });
    }
  }
  return out;
}

/**
 * Same as {@link extractPlacemarkPoints} plus `coordSpan` for each point when document-order span
 * discovery matches the parser output (required for safe in-place coordinate edits).
 */
export function extractPlacemarkPointsWithSpans(xml: string, source: PlacemarkSource): ParsedPlacemarkPoint[] {
  const points = extractPlacemarkPoints(xml, source);
  const spans = extractPointCoordinateSpans(xml);
  if (points.length !== spans.length) {
    return points.map((p) => ({ ...p }));
  }
  return points.map((p, i) => ({ ...p, coordSpan: spans[i] }));
}

/** Serialize KML Point `<coordinates>` inner text (lon,lat optional alt). */
export function formatCoordinates(lon: number, lat: number, alt?: number): string {
  const lonS = String(lon);
  const latS = String(lat);
  if (alt !== undefined && Number.isFinite(alt)) {
    return `${lonS},${latS},${alt}`;
  }
  return `${lonS},${latS}`;
}

/** Replace the coordinate substring at `span` with `formatCoordinates(lon, lat, altPreserve)`. */
export function applyCoordinateEdit(
  xml: string,
  span: CoordSpan,
  lon: number,
  lat: number,
  altPreserve?: number
): string {
  const { start, end } = span;
  if (start < 0 || end > xml.length || start > end) {
    return xml;
  }
  const next = formatCoordinates(lon, lat, altPreserve);
  return xml.slice(0, start) + next + xml.slice(end);
}

function idxLower(hay: string, needle: string, from: number): number {
  return hay.toLowerCase().indexOf(needle.toLowerCase(), from);
}

/** After `<coordinates...>`, return index of first non-whitespace UTF-16 unit. */
function coordInnerStart(xml: string, afterOpenTag: number): number {
  let i = afterOpenTag;
  while (i < xml.length && /\s/.test(xml[i]!)) {
    i++;
  }
  return i;
}

/** Index of end of trimmed coordinate text before `</coordinates>` (exclusive). */
function coordInnerEnd(xml: string, innerStart: number, closeAngle: number): number {
  let j = closeAngle;
  while (j > innerStart && /\s/.test(xml[j - 1]!)) {
    j--;
  }
  return j;
}

/**
 * Document-order spans of `<coordinates>` text for Placemarks that contain a `<Point>`.
 * Matches traversal order of `extractPlacemarkPoints` for supported DJI/WPML-style KML.
 */
export function extractPointCoordinateSpans(xml: string): CoordSpan[] {
  const out: CoordSpan[] = [];
  let searchFrom = 0;
  for (;;) {
    const open = idxLower(xml, '<Placemark', searchFrom);
    if (open === -1) {
      break;
    }
    const blockEnd = findMatchingPlacemarkEnd(xml, open);
    if (blockEnd === -1) {
      break;
    }
    const span = firstPointCoordinatesSpanInBlock(xml, open, blockEnd);
    if (span) {
      out.push(span);
    }
    searchFrom = blockEnd;
  }
  return out;
}

function findMatchingPlacemarkEnd(xml: string, openPos: number): number {
  let depth = 1;
  let i = openPos + 1;
  while (i < xml.length && depth > 0) {
    const nextOpen = idxLower(xml, '<Placemark', i);
    const nextClose = idxLower(xml, '</Placemark>', i);
    if (nextClose === -1) {
      return -1;
    }
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + '<Placemark'.length;
    } else {
      depth--;
      i = nextClose + '</Placemark>'.length;
    }
  }
  return depth === 0 ? i : -1;
}

function firstPointCoordinatesSpanInBlock(xml: string, blockStart: number, blockEnd: number): CoordSpan | null {
  const block = xml.slice(blockStart, blockEnd);
  const pointIdx = idxLower(block, '<Point', 0);
  if (pointIdx === -1) {
    return null;
  }
  const afterPoint = blockStart + pointIdx;
  const sliceFromPoint = xml.slice(afterPoint, blockEnd);
  const coordOpen = /<coordinates\b[^>]*>/i.exec(sliceFromPoint);
  if (!coordOpen || coordOpen.index === undefined) {
    return null;
  }
  const contentRegionStart = afterPoint + coordOpen.index + coordOpen[0].length;
  const sliceAfterOpen = xml.slice(contentRegionStart, blockEnd);
  const closeMatch = /<\/coordinates\s*>/i.exec(sliceAfterOpen);
  if (!closeMatch || closeMatch.index === undefined) {
    return null;
  }
  const innerStart = coordInnerStart(xml, contentRegionStart);
  const closeAbs = contentRegionStart + closeMatch.index;
  const innerEnd = coordInnerEnd(xml, innerStart, closeAbs);
  if (innerEnd <= innerStart) {
    return null;
  }
  const inner = xml.slice(innerStart, innerEnd);
  if (!parseCoordinatesText(inner)) {
    return null;
  }
  return { start: innerStart, end: innerEnd };
}

function collectPlacemarks(node: unknown): unknown[] {
  if (node === null || typeof node !== 'object') {
    return [];
  }
  if (Array.isArray(node)) {
    return node.flatMap(collectPlacemarks);
  }
  const obj = node as Record<string, unknown>;
  const marks: unknown[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'Placemark') {
      const arr = Array.isArray(v) ? v : [v];
      marks.push(...arr.filter((x) => x && typeof x === 'object'));
    } else {
      marks.push(...collectPlacemarks(v));
    }
  }
  return marks;
}

/** Fields that get dedicated handling and are excluded from `extra`. */
const NON_EXTRA_KEYS = new Set(['Point', 'index', 'executeHeight', 'height', 'ellipsoidHeight', 'actionGroup']);

function placemarkToPoint(mark: unknown): Omit<ParsedPlacemarkPoint, 'source' | 'ordinal'> | null {
  if (!mark || typeof mark !== 'object') {
    return null;
  }
  const o = mark as Record<string, unknown>;
  const coordsText = findCoordinates(o['Point']);
  if (coordsText === undefined) {
    return null;
  }
  const parsed = parseCoordinatesText(coordsText);
  if (!parsed) {
    return null;
  }

  const execHeight = parseOptionalNumber(o['executeHeight']);
  const wpmlHeight = parseOptionalNumber(o['height']);
  const ellipsoidHeight = parseOptionalNumber(o['ellipsoidHeight']);

  let height: number | undefined;
  let heightField: HeightField | undefined;
  if (execHeight !== undefined) {
    height = execHeight;
    heightField = 'executeHeight';
  } else if (wpmlHeight !== undefined) {
    height = wpmlHeight;
    heightField = 'height';
  } else if (parsed.alt !== undefined) {
    height = parsed.alt;
    heightField = 'coordinates';
  }

  return {
    ...parsed,
    index: parseOptionalIndex(o),
    height,
    heightField,
    ellipsoidHeight,
    actions: extractActions(o['actionGroup']),
    extra: flattenExtra(o),
  };
}

function extractActions(actionGroup: unknown): WaypointAction[] {
  const groups = actionGroup == null ? [] : Array.isArray(actionGroup) ? actionGroup : [actionGroup];
  const out: WaypointAction[] = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') {
      continue;
    }
    const rawActions = (g as Record<string, unknown>)['action'];
    const actions = rawActions == null ? [] : Array.isArray(rawActions) ? rawActions : [rawActions];
    for (const a of actions) {
      if (!a || typeof a !== 'object') {
        continue;
      }
      const ao = a as Record<string, unknown>;
      const func = isScalar(ao['actionActuatorFunc']) ? String(ao['actionActuatorFunc']) : 'unknown';
      const params: Record<string, string> = {};
      const rawParams = ao['actionActuatorFuncParam'];
      if (rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)) {
        for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
          if (isScalar(v)) {
            params[k] = String(v);
          }
        }
      }
      out.push({ func, params });
    }
  }
  return out;
}

function flattenExtra(o: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) {
    if (NON_EXTRA_KEYS.has(k)) {
      continue;
    }
    flattenInto(out, k, v, 0);
  }
  return out;
}

function flattenInto(out: Record<string, string>, key: string, value: unknown, depth: number): void {
  if (value === null || value === undefined) {
    return;
  }
  if (isScalar(value)) {
    out[key] = String(value);
    return;
  }
  if (depth >= 3) {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flattenInto(out, `${key}[${i}]`, v, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenInto(out, k === '#text' ? key : `${key}.${k}`, v, depth + 1);
    }
  }
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function parseOptionalNumber(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  return Number.isFinite(n) ? n : undefined;
}

function findCoordinates(point: unknown): string | undefined {
  if (!point || typeof point !== 'object') {
    return undefined;
  }
  const p = point as Record<string, unknown>;
  const c = p['coordinates'];
  if (typeof c === 'string') {
    return c;
  }
  if (c && typeof c === 'object' && '#text' in (c as object)) {
    const t = (c as { '#text'?: unknown })['#text'];
    return typeof t === 'string' ? t : undefined;
  }
  return undefined;
}

function parseOptionalIndex(o: Record<string, unknown>): number | undefined {
  const raw = o['index'];
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** KML coordinates: lon,lat[,alt] with optional whitespace. */
export function parseCoordinatesText(text: string): { lon: number; lat: number; alt?: number } | null {
  const parts = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const lon = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  let alt: number | undefined;
  if (parts.length >= 3) {
    const a = Number(parts[2]);
    if (Number.isFinite(a)) {
      alt = a;
    }
  }
  return alt !== undefined ? { lon, lat, alt } : { lon, lat };
}
