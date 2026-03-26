import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import JSZip from 'jszip';
import { listZipChildren, zipHasNonemptyDirectory } from './kmzZipTree';
import { kmzRootUri, kmzUri, normalizeInnerPath, parseKmzUri } from './uri';

type KmzCache = {
  zip: JSZip;
  /** Entry paths in original ZIP order (for stable repack). */
  entryOrder: string[];
  mtimeMs: number;
  revision: number;
};

export class KmzFileSystemProvider implements vscode.FileSystemProvider {
  private readonly caches = new Map<string, KmzCache>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.emitter.event;

  watch(uri: vscode.Uri): vscode.Disposable {
    const { archiveUri } = parseKmzUri(uri);
    const backing = archiveUri.fsPath;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(backing)), path.basename(backing))
    );
    const refresh = () => {
      void this.invalidate(backing);
      this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: kmzRootUri(backing) as vscode.Uri }]);
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(() => {
      this.caches.delete(backing);
      this.emitter.fire([{ type: vscode.FileChangeType.Deleted, uri: kmzRootUri(backing) as vscode.Uri }]);
    });
    return watcher;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { archiveUri, innerPath } = parseKmzUri(uri);
    const cache = await this.getCache(archiveUri.fsPath);
    const normalized = normalizeInnerPath(innerPath);

    if (normalized === '') {
      const st = await fs.stat(archiveUri.fsPath).catch(() => null);
      return {
        type: vscode.FileType.Directory,
        ctime: st?.ctimeMs ?? cache.mtimeMs,
        mtime: st?.mtimeMs ?? cache.mtimeMs,
        size: 0,
      };
    }

    if (cache.zip.files[normalized]) {
      const entry = cache.zip.files[normalized];
      if (entry.dir) {
        return {
          type: vscode.FileType.Directory,
          ctime: cache.mtimeMs,
          mtime: cache.mtimeMs,
          size: 0,
        };
      }
      const u8 = await entry.async('uint8array');
      return {
        type: vscode.FileType.File,
        ctime: cache.mtimeMs,
        mtime: cache.mtimeMs,
        size: u8.byteLength,
      };
    }

    if (zipHasNonemptyDirectory(cache.zip, normalized)) {
      return {
        type: vscode.FileType.Directory,
        ctime: cache.mtimeMs,
        mtime: cache.mtimeMs,
        size: 0,
      };
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { archiveUri, innerPath } = parseKmzUri(uri);
    const cache = await this.getCache(archiveUri.fsPath);
    const prefix = normalizeInnerPath(innerPath);
    const children = listZipChildren(cache.zip, prefix);
    const out: [string, vscode.FileType][] = [];
    for (const [name, kind] of children.entries()) {
      out.push([name, kind === 'dir' ? vscode.FileType.Directory : vscode.FileType.File]);
    }
    out.sort((a, b) => a[0].localeCompare(b[0]));
    return out;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { archiveUri, innerPath } = parseKmzUri(uri);
    const normalized = normalizeInnerPath(innerPath);
    if (normalized === '') {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    const cache = await this.getCache(archiveUri.fsPath);
    const entry = cache.zip.files[normalized];
    if (!entry || entry.dir) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return entry.async('uint8array');
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const { archiveUri, innerPath } = parseKmzUri(uri);
    const normalized = normalizeInnerPath(innerPath);
    if (normalized === '') {
      throw vscode.FileSystemError.FileIsADirectory(uri);
    }
    const fsPath = archiveUri.fsPath;
    const cache = await this.getCache(fsPath);
    const exists = !!cache.zip.files[normalized] && !cache.zip.files[normalized].dir;

    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (exists && !options.overwrite && !options.create) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    cache.zip.file(normalized, content, { createFolders: true });
    await this.flushToDisk(fsPath, cache);
    cache.revision += 1;
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('Creating directories inside KMZ is not supported in this version');
  }

  async delete(): Promise<void> {
    throw vscode.FileSystemError.NoPermissions('Deleting entries inside KMZ is not supported in this version');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('Renaming entries inside KMZ is not supported in this version');
  }

  private async invalidate(fsPath: string): Promise<void> {
    this.caches.delete(fsPath);
  }

  private async getCache(fsPath: string): Promise<KmzCache> {
    const st = await fs.stat(fsPath);
    const existing = this.caches.get(fsPath);
    if (existing && existing.mtimeMs === st.mtimeMs) {
      return existing;
    }
    const buf = await fs.readFile(fsPath);
    const zip = await JSZip.loadAsync(buf);
    const entryOrder = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
    const cache: KmzCache = {
      zip,
      entryOrder,
      mtimeMs: st.mtimeMs,
      revision: 0,
    };
    this.caches.set(fsPath, cache);
    return cache;
  }

  private async flushToDisk(fsPath: string, cache: KmzCache): Promise<void> {
    const orderedPaths = new Set<string>();
    const out: string[] = [];
    for (const p of cache.entryOrder) {
      if (!cache.zip.files[p]) {
        continue;
      }
      if (!cache.zip.files[p].dir) {
        orderedPaths.add(p);
        out.push(p);
      }
    }
    for (const p of Object.keys(cache.zip.files)) {
      if (cache.zip.files[p].dir) {
        continue;
      }
      if (!orderedPaths.has(p)) {
        out.push(p);
      }
    }

    const zipOut = new JSZip();
    for (const p of out) {
      const entry = cache.zip.files[p];
      if (!entry || entry.dir) {
        continue;
      }
      const data = await entry.async('uint8array');
      zipOut.file(p, data);
    }

    const body = await zipOut.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    const tmp = `${fsPath}.vscode-kmz.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, fsPath);

    const st = await fs.stat(fsPath);
    cache.mtimeMs = st.mtimeMs;
    cache.zip = await JSZip.loadAsync(body);
    cache.entryOrder = Object.keys(cache.zip.files).filter((p) => !cache.zip.files[p].dir);
  }
}
