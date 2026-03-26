import type JSZip from 'jszip';
import { normalizeInnerPath } from './uri';

export type ZipEntryKind = 'file' | 'dir';

/**
 * Lists immediate children under `innerPath` inside the ZIP (POSIX-style paths).
 */
export function listZipChildren(zip: JSZip, innerPath: string): Map<string, ZipEntryKind> {
  const prefix = normalizeInnerPath(innerPath);
  const prefixWithSlash = prefix === '' ? '' : `${prefix}/`;
  const names = new Map<string, ZipEntryKind>();

  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.name.endsWith('/')) {
      continue;
    }
    if (prefixWithSlash && !name.startsWith(prefixWithSlash) && name !== prefix) {
      continue;
    }
    if (!prefixWithSlash && name.includes('/')) {
      const seg = name.slice(0, name.indexOf('/'));
      names.set(seg, 'dir');
      continue;
    }
    if (prefixWithSlash) {
      const rest = name.slice(prefixWithSlash.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        names.set(rest, 'file');
      } else {
        names.set(rest.slice(0, slash), 'dir');
      }
    } else if (!name.includes('/')) {
      names.set(name, 'file');
    }
  }

  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('/')) {
      continue;
    }
    const dirPath = name.replace(/\/+$/, '');
    if (prefix === '' && !dirPath.includes('/')) {
      names.set(dirPath, 'dir');
    } else if (prefixWithSlash && dirPath.startsWith(prefixWithSlash)) {
      const rest = dirPath.slice(prefixWithSlash.length);
      if (rest && !rest.includes('/')) {
        names.set(rest, 'dir');
      }
    }
  }

  return names;
}

export function zipHasNonemptyDirectory(zip: JSZip, dirPath: string): boolean {
  const norm = normalizeInnerPath(dirPath);
  const slashPrefix = `${norm}/`;
  for (const k of Object.keys(zip.files)) {
    if (k.startsWith(slashPrefix) && k !== norm) {
      return true;
    }
    const entry = zip.files[k];
    if (entry.dir && (k === `${norm}/` || normalizeInnerPath(k.replace(/\/+$/, '')) === norm)) {
      return true;
    }
  }
  return false;
}
