import { URI } from 'vscode-uri';

const ARCHIVE_QUERY_KEY = 'archive';

/**
 * KMZ virtual URIs use scheme `kmz`, path = inner archive path (POSIX),
 * query `archive=<encoded vscode-uri file URI>` pointing at the `.kmz` on disk.
 */
export function kmzUri(archiveFsPath: string, innerPath: string = ''): URI {
  const archiveUri = URI.file(archiveFsPath);
  const normInner = normalizeInnerPath(innerPath);
  const pathPart = normInner === '' ? '/' : `/${normInner}`;
  return URI.from({
    scheme: 'kmz',
    path: pathPart,
    query: `${ARCHIVE_QUERY_KEY}=${encodeURIComponent(archiveUri.toString())}`,
  });
}

/** Works with `vscode.Uri` or `vscode-uri` (anything with a correct `toString()`). */
export function parseKmzUri(uri: { toString(): string }): { archiveUri: URI; innerPath: string } {
  const u = URI.parse(uri.toString());
  if (u.scheme !== 'kmz') {
    throw new Error(`Expected kmz scheme, got ${u.scheme}`);
  }
  const params = new URLSearchParams(u.query);
  const encoded = params.get(ARCHIVE_QUERY_KEY);
  if (!encoded) {
    throw new Error('KMZ URI missing archive query parameter');
  }
  const archiveUri = URI.parse(decodeURIComponent(encoded));
  const inner = u.path.replace(/^\/+/, '');
  return { archiveUri, innerPath: inner };
}

export function kmzRootUri(archiveFsPath: string): URI {
  return kmzUri(archiveFsPath, '');
}

export function normalizeInnerPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
