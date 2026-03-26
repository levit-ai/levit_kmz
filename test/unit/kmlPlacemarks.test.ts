import { describe, expect, it } from 'vitest';
import { extractPlacemarkPoints, parseCoordinatesText } from '../../src/kmlPlacemarks';

const MINIMAL_KML = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <Folder>
      <Placemark>
        <Point>
          <coordinates>-116.04,32.74</coordinates>
        </Point>
        <wpml:index>0</wpml:index>
      </Placemark>
      <Placemark>
        <Point>
          <coordinates>-116.05,32.75,10</coordinates>
        </Point>
        <wpml:index>1</wpml:index>
      </Placemark>
    </Folder>
  </Document>
</kml>
`;

describe('parseCoordinatesText', () => {
  it('parses lon,lat', () => {
    expect(parseCoordinatesText(' -116.044 , 32.744 \n')).toEqual({ lon: -116.044, lat: 32.744 });
  });

  it('parses lon,lat,alt', () => {
    expect(parseCoordinatesText('-116,32,100')).toEqual({ lon: -116, lat: 32, alt: 100 });
  });

  it('returns null for empty', () => {
    expect(parseCoordinatesText('')).toBeNull();
  });
});

describe('extractPlacemarkPoints', () => {
  it('extracts two points with indices', () => {
    const pts = extractPlacemarkPoints(MINIMAL_KML, 'template');
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ lon: -116.04, lat: 32.74, index: 0, source: 'template' });
    expect(pts[1]).toMatchObject({ lon: -116.05, lat: 32.75, alt: 10, index: 1, source: 'template' });
  });

  it('returns empty for invalid XML', () => {
    expect(extractPlacemarkPoints('not xml', 'waylines')).toEqual([]);
  });
});
