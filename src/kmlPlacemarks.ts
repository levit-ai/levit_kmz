import { XMLParser } from 'fast-xml-parser';

export type PlacemarkSource = 'template' | 'waylines';

export type ParsedPlacemarkPoint = {
  lon: number;
  lat: number;
  alt?: number;
  index?: number;
  source: PlacemarkSource;
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
  for (const m of marks) {
    const pt = placemarkToPoint(m);
    if (pt) {
      out.push({ ...pt, source });
    }
  }
  return out;
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

function placemarkToPoint(mark: unknown): Omit<ParsedPlacemarkPoint, 'source'> | null {
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
  const idx = parseOptionalIndex(o);
  return { ...parsed, index: idx };
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
