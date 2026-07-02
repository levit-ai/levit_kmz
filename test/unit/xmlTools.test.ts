import { describe, expect, it } from 'vitest';
import { extractPlacemarkPoints } from '../../src/kmlPlacemarks';
import { computeXmlFoldingRanges, formatXml } from '../../src/xmlTools';

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <!-- a
         multi-line comment -->
    <Folder>
      <Placemark>
        <Point><coordinates>-111.4311,36.5809</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:executeHeight>53.7999992370605</wpml:executeHeight>
      </Placemark>
      <Placemark>
        <Point><coordinates>-111.4308,36.5808</coordinates></Point>
        <wpml:index>1</wpml:index>
        <wpml:executeHeight>36.9000015258789</wpml:executeHeight>
      </Placemark>
    </Folder>
  </Document>
</kml>
`;

describe('computeXmlFoldingRanges', () => {
  it('folds each multi-line element', () => {
    const ranges = computeXmlFoldingRanges(SAMPLE);
    // kml (1..18), Document (2..17), Folder (5..16), two Placemarks, one comment
    const placemarks = ranges.filter((r) => r.start === 6 || r.start === 11);
    expect(placemarks).toHaveLength(2);
    expect(placemarks[0]).toMatchObject({ start: 6, end: 10 });
    expect(placemarks[1]).toMatchObject({ start: 11, end: 15 });
    expect(ranges).toContainEqual({ start: 3, end: 4, kind: 'comment' });
    expect(ranges.some((r) => r.start === 1 && r.end === 18)).toBe(true);
    expect(ranges.some((r) => r.start === 5 && r.end === 16)).toBe(true);
  });

  it('does not fold single-line elements', () => {
    const ranges = computeXmlFoldingRanges('<a><b>x</b></a>');
    expect(ranges).toEqual([]);
  });

  it('folds minified multi-line content by tags, not indentation', () => {
    const text = '<kml><Folder>\n<Placemark><Point><coordinates>1,2</coordinates></Point>\n</Placemark></Folder></kml>';
    const ranges = computeXmlFoldingRanges(text);
    expect(ranges.some((r) => r.start === 1 && r.end === 2)).toBe(true); // Placemark
    expect(ranges.some((r) => r.start === 0 && r.end === 2)).toBe(true); // kml + Folder
  });
});

describe('formatXml', () => {
  it('round-trips DJI wpml content without changing values', () => {
    const formatted = formatXml(SAMPLE, '  ');
    expect(formatted).not.toBeNull();
    expect(formatted).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(formatted).toContain('xmlns:wpml="http://www.dji.com/wpmz/1.0.6"');
    expect(formatted).toContain('<wpml:executeHeight>53.7999992370605</wpml:executeHeight>');
    const before = extractPlacemarkPoints(SAMPLE, 'waylines');
    const after = extractPlacemarkPoints(formatted!, 'waylines');
    expect(after).toEqual(before);
  });

  it('pretty-prints minified XML', () => {
    const formatted = formatXml('<a><b><c>x</c></b></a>', '  ');
    expect(formatted).toBe('<a>\n  <b>\n    <c>x</c>\n  </b>\n</a>\n');
  });

  it('returns null for malformed XML', () => {
    expect(formatXml('<a><b></a>', '  ')).toBeNull();
  });
});
