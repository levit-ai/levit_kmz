import { describe, expect, it } from 'vitest';
import { SHARED_PANEL_JS } from '../../src/placemarkPanelShared';

type Pt = { lat: number; lon: number; height?: number };

type StatsFns = {
  segMeters: (a: Pt, b: Pt) => number;
  pathMeters: (pts: Pt[]) => number;
  fmtDuration: (s: number) => string;
  statsHtml: (vis: { source: string; points: Pt[] }[], cfg: { speedMps: number; secondsPerWaypoint: number }) => string;
};

const fns = new Function(
  `${SHARED_PANEL_JS}; return { segMeters, pathMeters, fmtDuration, statsHtml };`
)() as StatsFns;

describe('segMeters', () => {
  it('computes ground distance', () => {
    const d = fns.segMeters({ lat: 0, lon: 0 }, { lat: 0.001, lon: 0 });
    expect(d).toBeCloseTo(111.19, 0);
  });

  it('includes the vertical component when both heights are known', () => {
    const d = fns.segMeters({ lat: 10, lon: 20, height: 0 }, { lat: 10, lon: 20, height: 30 });
    expect(d).toBeCloseTo(30, 6);
  });

  it('ignores height when one side is missing it', () => {
    const d = fns.segMeters({ lat: 10, lon: 20, height: 50 }, { lat: 10, lon: 20 });
    expect(d).toBe(0);
  });
});

describe('pathMeters', () => {
  it('sums consecutive segments', () => {
    const pts: Pt[] = [
      { lat: 0, lon: 0, height: 0 },
      { lat: 0, lon: 0, height: 10 },
      { lat: 0, lon: 0, height: 25 },
    ];
    expect(fns.pathMeters(pts)).toBeCloseTo(25, 6);
  });

  it('is zero for fewer than two points', () => {
    expect(fns.pathMeters([{ lat: 0, lon: 0 }])).toBe(0);
  });
});

describe('fmtDuration', () => {
  it('formats seconds, minutes, and hours', () => {
    expect(fns.fmtDuration(59)).toBe('59s');
    expect(fns.fmtDuration(125)).toBe('2m 5s');
    expect(fns.fmtDuration(3665)).toBe('1h 1m 5s');
  });
});

describe('statsHtml', () => {
  it('reports heights, length, and estimated time per series', () => {
    const pts: Pt[] = [
      { lat: 10, lon: 20, height: 0 },
      { lat: 10, lon: 20, height: 100 },
    ];
    const html = fns.statsHtml([{ source: 'waylines', points: pts }], { speedMps: 10, secondsPerWaypoint: 2 });
    expect(html).toContain('waylines.wpml');
    expect(html).toContain('100 m');
    expect(html).toContain('0 m');
    expect(html).toContain('14s');
  });

  it('handles no visible points', () => {
    expect(fns.statsHtml([], { speedMps: 12, secondsPerWaypoint: 4 })).toContain('No points');
  });
});
