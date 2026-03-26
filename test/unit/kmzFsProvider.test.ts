import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { KmzFileSystemProvider } from '../../src/kmzFsProvider';
import { kmzUri } from '../../src/uri';

const FIXTURE = fileURLToPath(new URL('../fixtures/sample.kmz', import.meta.url));

describe('KmzFileSystemProvider', () => {
  const provider = new KmzFileSystemProvider();
  let tmpKmzs: string[] = [];

  afterEach(async () => {
    for (const p of tmpKmzs) {
      await fs.rm(p, { force: true });
      await fs.rm(`${p}.vscode-kmz.${process.pid}.tmp`, { force: true }).catch(() => {});
    }
    tmpKmzs = [];
  });

  async function copyFixture(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-kmz-'));
    const dest = path.join(dir, 'test.kmz');
    await fs.copyFile(FIXTURE, dest);
    tmpKmzs.push(dest);
    return dest;
  }

  it('readFile returns template.kml from KMZ', async () => {
    const kmzPath = await copyFixture();
    const uri = kmzUri(kmzPath, 'wpmz/template.kml');
    const bytes = await provider.readFile(uri as never);
    const text = Buffer.from(bytes).toString('utf8');
    expect(text).toContain('kml');
  });

  it('writeFile updates entry and persists to disk', async () => {
    const kmzPath = await copyFixture();
    const uri = kmzUri(kmzPath, 'wpmz/template.kml');
    const original = await provider.readFile(uri as never);
    const marker = `<!-- vscode-kmz-test-${Date.now()} -->`;
    const next = Buffer.concat([Buffer.from(marker + '\n', 'utf8'), Buffer.from(original)]);
    await provider.writeFile(uri as never, next, { create: false, overwrite: true });

    const disk = await fs.readFile(kmzPath);
    const zip = await JSZip.loadAsync(disk);
    const file = await zip.file('wpmz/template.kml')?.async('string');
    expect(file).toBeDefined();
    expect(file).toContain(marker);
  });
});
