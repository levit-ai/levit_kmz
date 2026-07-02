import { describe, expect, it } from 'vitest';
import {
  applyCoordinateEdit,
  extractPlacemarkPoints,
  extractPlacemarkPointsWithSpans,
  extractPointCoordinateSpans,
  formatCoordinates,
  parseCoordinatesText,
} from '../../src/kmlPlacemarks';

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

const WPML_SNIPPET = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:wpml="http://www.dji.com/wpmz/1.0.6">
  <Document>
    <Folder>
      <Placemark>
        <Point><coordinates>-111.4311,36.5809</coordinates></Point>
        <wpml:index>0</wpml:index>
        <wpml:executeHeight>53.8</wpml:executeHeight>
        <wpml:waypointSpeed>15</wpml:waypointSpeed>
        <wpml:waypointHeadingParam>
          <wpml:waypointHeadingMode>followWayline</wpml:waypointHeadingMode>
        </wpml:waypointHeadingParam>
        <wpml:actionGroup>
          <wpml:actionGroupId>0</wpml:actionGroupId>
          <wpml:action>
            <wpml:actionId>0</wpml:actionId>
            <wpml:actionActuatorFunc>takePhoto</wpml:actionActuatorFunc>
            <wpml:actionActuatorFuncParam>
              <wpml:payloadPositionIndex>0</wpml:payloadPositionIndex>
            </wpml:actionActuatorFuncParam>
          </wpml:action>
          <wpml:action>
            <wpml:actionId>1</wpml:actionId>
            <wpml:actionActuatorFunc>gimbalRotate</wpml:actionActuatorFunc>
          </wpml:action>
        </wpml:actionGroup>
      </Placemark>
      <Placemark>
        <Point><coordinates>-111.4308,36.5808</coordinates></Point>
        <wpml:index>1</wpml:index>
        <wpml:ellipsoidHeight>40.5</wpml:ellipsoidHeight>
        <wpml:height>36.9</wpml:height>
      </Placemark>
    </Folder>
  </Document>
</kml>
`;

describe('extractPlacemarkPoints', () => {
  it('extracts two points with indices and ordinals', () => {
    const pts = extractPlacemarkPoints(MINIMAL_KML, 'template');
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ lon: -116.04, lat: 32.74, index: 0, ordinal: 0, source: 'template' });
    expect(pts[1]).toMatchObject({ lon: -116.05, lat: 32.75, alt: 10, index: 1, ordinal: 1, source: 'template' });
  });

  it('uses coordinate altitude as height when no wpml height fields exist', () => {
    const pts = extractPlacemarkPoints(MINIMAL_KML, 'template');
    expect(pts[0].height).toBeUndefined();
    expect(pts[1]).toMatchObject({ height: 10, heightField: 'coordinates' });
  });

  it('returns empty for invalid XML', () => {
    expect(extractPlacemarkPoints('not xml', 'waylines')).toEqual([]);
  });

  it('extracts executeHeight as the display height', () => {
    const pts = extractPlacemarkPoints(WPML_SNIPPET, 'waylines');
    expect(pts[0]).toMatchObject({ height: 53.8, heightField: 'executeHeight' });
  });

  it('falls back to wpml:height and keeps ellipsoidHeight', () => {
    const pts = extractPlacemarkPoints(WPML_SNIPPET, 'template');
    expect(pts[1]).toMatchObject({ height: 36.9, heightField: 'height', ellipsoidHeight: 40.5 });
  });

  it('extracts actions with params', () => {
    const pts = extractPlacemarkPoints(WPML_SNIPPET, 'waylines');
    expect(pts[0].actions).toEqual([
      { func: 'takePhoto', params: { payloadPositionIndex: '0' } },
      { func: 'gimbalRotate', params: {} },
    ]);
    expect(pts[1].actions).toEqual([]);
  });

  it('flattens remaining waypoint fields into extra', () => {
    const pts = extractPlacemarkPoints(WPML_SNIPPET, 'waylines');
    expect(pts[0].extra).toMatchObject({
      waypointSpeed: '15',
      'waypointHeadingParam.waypointHeadingMode': 'followWayline',
    });
    expect(pts[0].extra).not.toHaveProperty('index');
    expect(pts[0].extra).not.toHaveProperty('executeHeight');
  });
});

const KML_WITH_GAP = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark><name>X</name></Placemark>
    <Placemark><Point><coordinates>  -116.1 , 32.1  </coordinates></Point></Placemark>
  </Document>
</kml>`;

describe('extractPlacemarkPointsWithSpans / extractPointCoordinateSpans', () => {
  it('pairs spans with parser output for MINIMAL_KML', () => {
    const pts = extractPlacemarkPointsWithSpans(MINIMAL_KML, 'template');
    expect(pts).toHaveLength(2);
    expect(pts[0].coordSpan).toBeDefined();
    expect(pts[1].coordSpan).toBeDefined();
    const inner0 = MINIMAL_KML.slice(pts[0].coordSpan!.start, pts[0].coordSpan!.end);
    expect(inner0.trim()).toBe('-116.04,32.74');
    const inner1 = MINIMAL_KML.slice(pts[1].coordSpan!.start, pts[1].coordSpan!.end);
    expect(inner1.trim()).toBe('-116.05,32.75,10');
    expect(extractPointCoordinateSpans(MINIMAL_KML)).toHaveLength(2);
  });

  it('skips placemarks without Point so counts stay aligned', () => {
    const pts = extractPlacemarkPointsWithSpans(KML_WITH_GAP, 'template');
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({ lon: -116.1, lat: 32.1, source: 'template' });
    expect(pts[0].coordSpan).toBeDefined();
    const inner = KML_WITH_GAP.slice(pts[0].coordSpan!.start, pts[0].coordSpan!.end);
    expect(inner.trim()).toBe('-116.1 , 32.1');
  });
});

describe('applyCoordinateEdit / formatCoordinates', () => {
  it('replaces span and preserves altitude', () => {
    const pts = extractPlacemarkPointsWithSpans(MINIMAL_KML, 'template');
    const span = pts[1].coordSpan!;
    const edited = applyCoordinateEdit(MINIMAL_KML, span, -120.5, 35.25, 10);
    const next = extractPlacemarkPoints(edited, 'template');
    expect(next[1]).toMatchObject({ lon: -120.5, lat: 35.25, alt: 10 });
    expect(edited).toContain(formatCoordinates(-120.5, 35.25, 10));
  });
});
