import * as fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { listZipChildren, zipHasNonemptyDirectory } from '../../src/kmzZipTree';

const FIXTURE = fileURLToPath(new URL('../fixtures/sample.kmz', import.meta.url));

describe('kmzZipTree', () => {
  it('lists root of fixture KMZ', async () => {
    const buf = await fs.readFile(FIXTURE);
    const zip = await JSZip.loadAsync(buf);
    const root = listZipChildren(zip, '');
    expect([...root.keys()].sort()).toEqual(['wpmz']);
    expect(root.get('wpmz')).toBe('dir');
  });

  it('lists wpmz children', async () => {
    const buf = await fs.readFile(FIXTURE);
    const zip = await JSZip.loadAsync(buf);
    const ch = listZipChildren(zip, 'wpmz');
    const names = [...ch.keys()].sort();
    expect(names).toContain('template.kml');
    expect(names).toContain('waylines.wpml');
    expect(names).toContain('res');
    expect(ch.get('template.kml')).toBe('file');
    expect(ch.get('res')).toBe('dir');
  });

  it('zipHasNonemptyDirectory for wpmz', async () => {
    const buf = await fs.readFile(FIXTURE);
    const zip = await JSZip.loadAsync(buf);
    expect(zipHasNonemptyDirectory(zip, 'wpmz')).toBe(true);
    expect(zipHasNonemptyDirectory(zip, 'missing')).toBe(false);
  });
});
