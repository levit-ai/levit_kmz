import { describe, expect, it } from 'vitest';
import { kmzRootUri, kmzUri, normalizeInnerPath, parseKmzUri } from '../../src/uri';

describe('uri', () => {
  it('round-trips root', () => {
    const root = kmzRootUri('/abs/mission.kmz');
    expect(root.scheme).toBe('kmz');
    const { archiveUri, innerPath } = parseKmzUri(root);
    expect(archiveUri.fsPath.replace(/\\/g, '/').endsWith('/abs/mission.kmz')).toBe(true);
    expect(innerPath).toBe('');
  });

  it('round-trips nested path', () => {
    const u = kmzUri('/abs/mission.kmz', 'wpmz/template.kml');
    const { archiveUri, innerPath } = parseKmzUri(u);
    expect(archiveUri.fsPath.replace(/\\/g, '/').endsWith('/abs/mission.kmz')).toBe(true);
    expect(innerPath).toBe('wpmz/template.kml');
  });

  it('normalizeInnerPath trims slashes', () => {
    expect(normalizeInnerPath('/wpmz/foo/')).toBe('wpmz/foo');
    expect(normalizeInnerPath('')).toBe('');
  });
});
