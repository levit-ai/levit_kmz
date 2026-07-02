import { describe, expect, it } from 'vitest';
import { updatePlacemarkHeight } from '../../src/kmlEdit';
import { extractPlacemarkPoints } from '../../src/kmlPlacemarks';

const WAYLINES = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <Folder>
      <Placemark>
        <Point><coordinates>-111.4311,36.5809</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:executeHeight>53.8</wpml:executeHeight>
      </Placemark>
      <Placemark>
        <Point><coordinates>-111.4308,36.5808</coordinates></Point>
        <wpml:index>1</wpml:index>
        <wpml:executeHeight>36.9</wpml:executeHeight>
      </Placemark>
    </Folder>
  </Document>
</kml>
`;

const TEMPLATE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <Folder>
      <Placemark>
        <Point><coordinates>-111.4311,36.5809</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:ellipsoidHeight>57.4</wpml:ellipsoidHeight>
        <wpml:height>53.8</wpml:height>
      </Placemark>
    </Folder>
  </Document>
</kml>
`;

const PLAIN_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <Point><coordinates>-116.05,32.75,10</coordinates></Point>
    </Placemark>
    <Placemark>
      <Point><coordinates>-116.06,32.76</coordinates></Point>
    </Placemark>
  </Document>
</kml>
`;

describe('updatePlacemarkHeight', () => {
  it('updates executeHeight for the targeted waylines waypoint only', () => {
    const out = updatePlacemarkHeight(
      WAYLINES,
      { ordinal: 1, index: 1, source: 'waylines', heightField: 'executeHeight' },
      42.5
    );
    expect(out).not.toBeNull();
    expect(out).toContain('<wpml:executeHeight>42.5</wpml:executeHeight>');
    expect(out).toContain('<wpml:executeHeight>53.8</wpml:executeHeight>');
    expect(out).not.toContain('36.9');
    const pts = extractPlacemarkPoints(out!, 'waylines');
    expect(pts[1].height).toBe(42.5);
    expect(pts[0].height).toBe(53.8);
  });

  it('locates the waypoint by wpml:index when ordinals disagree', () => {
    const out = updatePlacemarkHeight(WAYLINES, { ordinal: 0, index: 1, source: 'waylines' }, 99);
    // ordinal 0 has index 0, so index verification keeps the ordinal block only if it
    // matches; here index=1 wins over ordinal=0.
    expect(out).not.toBeNull();
    const pts = extractPlacemarkPoints(out!, 'waylines');
    expect(pts.find((p) => p.index === 1)?.height).toBe(99);
    expect(pts.find((p) => p.index === 0)?.height).toBe(53.8);
  });

  it('updates template height and shifts ellipsoidHeight by the same delta', () => {
    const out = updatePlacemarkHeight(
      TEMPLATE,
      { ordinal: 0, index: 0, source: 'template', heightField: 'height' },
      60
    );
    expect(out).not.toBeNull();
    expect(out).toContain('<wpml:height>60</wpml:height>');
    // 57.4 shifted by the same delta the height moved (60 - 53.8)
    expect(out).toContain(`<wpml:ellipsoidHeight>${String(57.4 + (60 - 53.8))}</wpml:ellipsoidHeight>`);
  });

  it('rewrites the coordinate altitude when height came from coordinates', () => {
    const out = updatePlacemarkHeight(
      PLAIN_KML,
      { ordinal: 0, source: 'template', heightField: 'coordinates' },
      25
    );
    expect(out).not.toBeNull();
    expect(out).toContain('<coordinates>-116.05,32.75,25</coordinates>');
  });

  it('appends an altitude when coordinates have none', () => {
    const out = updatePlacemarkHeight(PLAIN_KML, { ordinal: 1, source: 'template' }, 12);
    expect(out).not.toBeNull();
    expect(out).toContain('<coordinates>-116.06,32.76,12</coordinates>');
  });

  it('returns null for an out-of-range ordinal', () => {
    expect(updatePlacemarkHeight(WAYLINES, { ordinal: 5, source: 'waylines' }, 10)).toBeNull();
  });

  it('returns null for a non-finite height', () => {
    expect(updatePlacemarkHeight(WAYLINES, { ordinal: 0, source: 'waylines' }, Number.NaN)).toBeNull();
  });
});
