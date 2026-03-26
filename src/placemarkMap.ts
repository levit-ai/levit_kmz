import * as path from 'path';
import * as vscode from 'vscode';
import { extractPlacemarkPoints, type ParsedPlacemarkPoint, type PlacemarkSource } from './kmlPlacemarks';
import { openPlacemarkMapPanel } from './placemarkMapPanel';
import { kmzUri, parseKmzUri } from './uri';

type PlacemarkSeries = { template: ParsedPlacemarkPoint[]; waylines: ParsedPlacemarkPoint[] };

export async function showPlacemarkMap(context: vscode.ExtensionContext, resource?: vscode.Uri): Promise<void> {
  if (resource?.scheme === 'kmz') {
    await showFromVirtualKmzFile(context, resource);
    return;
  }
  if (resource?.scheme === 'file') {
    const lower = resource.fsPath.toLowerCase();
    if (lower.endsWith('.kmz')) {
      await showFromKmzArchive(context, path.resolve(resource.fsPath));
      return;
    }
    if (lower.endsWith('.kml') || lower.endsWith('.wpml')) {
      await showFromStandaloneXml(context, resource);
      return;
    }
    void vscode.window.showErrorMessage('Show placemarks on map works on .kmz, .kml, or .wpml files.');
    return;
  }

  const archive = await resolveKmzArchiveFsPathFromWorkspace();
  if (!archive) {
    return;
  }
  await showFromKmzArchive(context, archive);
}

function decodeKmzArchiveBytes(templateBytes: Uint8Array, waylinesBytes: Uint8Array): PlacemarkSeries {
  const decoder = new TextDecoder('utf8', { fatal: false });
  return {
    template: extractPlacemarkPoints(decoder.decode(templateBytes), 'template'),
    waylines: extractPlacemarkPoints(decoder.decode(waylinesBytes), 'waylines'),
  };
}

async function loadKmzArchivePlacemarks(archiveFsPath: string): Promise<PlacemarkSeries> {
  const templateUri = vscode.Uri.parse(kmzUri(archiveFsPath, 'wpmz/template.kml').toString());
  const waylinesUri = vscode.Uri.parse(kmzUri(archiveFsPath, 'wpmz/waylines.wpml').toString());
  const [templateBytes, waylinesBytes] = await Promise.all([
    vscode.workspace.fs.readFile(templateUri),
    vscode.workspace.fs.readFile(waylinesUri),
  ]);
  return decodeKmzArchiveBytes(templateBytes, waylinesBytes);
}

async function openKmzArchiveWithUserErrors(archiveFsPath: string): Promise<PlacemarkSeries | undefined> {
  const templateUri = vscode.Uri.parse(kmzUri(archiveFsPath, 'wpmz/template.kml').toString());
  const waylinesUri = vscode.Uri.parse(kmzUri(archiveFsPath, 'wpmz/waylines.wpml').toString());

  let templateBytes: Uint8Array;
  let waylinesBytes: Uint8Array;
  try {
    templateBytes = await vscode.workspace.fs.readFile(templateUri);
  } catch {
    void vscode.window.showErrorMessage('Could not read wpmz/template.kml inside the KMZ.');
    return undefined;
  }
  try {
    waylinesBytes = await vscode.workspace.fs.readFile(waylinesUri);
  } catch {
    void vscode.window.showErrorMessage('Could not read wpmz/waylines.wpml inside the KMZ.');
    return undefined;
  }

  return decodeKmzArchiveBytes(templateBytes, waylinesBytes);
}

async function showFromKmzArchive(context: vscode.ExtensionContext, archiveFsPath: string): Promise<void> {
  const data = await openKmzArchiveWithUserErrors(archiveFsPath);
  if (!data) {
    return;
  }

  if (data.template.length === 0 && data.waylines.length === 0) {
    void vscode.window.showWarningMessage('No Placemark points with coordinates were found in template.kml or waylines.wpml.');
  }

  const title = `KMZ map — ${path.basename(archiveFsPath)}`;
  const archiveUri = vscode.Uri.file(archiveFsPath);
  openPlacemarkMapPanel(context, title, data.template, data.waylines, {
    reload: () => loadKmzArchivePlacemarks(archiveFsPath),
    watchUris: [archiveUri],
  });
}

async function loadStandalonePlacemarks(file: vscode.Uri): Promise<PlacemarkSeries> {
  const bytes = await vscode.workspace.fs.readFile(file);
  const decoder = new TextDecoder('utf8', { fatal: false });
  const text = decoder.decode(bytes);
  const lower = file.fsPath.toLowerCase();
  const source: PlacemarkSource = lower.endsWith('.wpml') ? 'waylines' : 'template';
  return {
    template: source === 'template' ? extractPlacemarkPoints(text, 'template') : [],
    waylines: source === 'waylines' ? extractPlacemarkPoints(text, 'waylines') : [],
  };
}

async function showFromStandaloneXml(context: vscode.ExtensionContext, file: vscode.Uri): Promise<void> {
  let data: PlacemarkSeries;
  try {
    data = await loadStandalonePlacemarks(file);
  } catch {
    void vscode.window.showErrorMessage(`Could not read ${path.basename(file.fsPath)}.`);
    return;
  }

  if (data.template.length === 0 && data.waylines.length === 0) {
    void vscode.window.showWarningMessage('No Placemark points with coordinates were found in this file.');
  }

  const title = `KMZ map — ${path.basename(file.fsPath)}`;
  openPlacemarkMapPanel(context, title, data.template, data.waylines, {
    reload: () => loadStandalonePlacemarks(file),
    watchUris: [file],
  });
}

async function loadVirtualKmzPlacemarks(resource: vscode.Uri): Promise<PlacemarkSeries> {
  const bytes = await vscode.workspace.fs.readFile(resource);
  const { innerPath } = parseKmzUri(resource);
  const source = placemarkSourceForInnerPath(innerPath);
  const decoder = new TextDecoder('utf8', { fatal: false });
  const text = decoder.decode(bytes);
  return {
    template: source === 'template' ? extractPlacemarkPoints(text, 'template') : [],
    waylines: source === 'waylines' ? extractPlacemarkPoints(text, 'waylines') : [],
  };
}

async function showFromVirtualKmzFile(context: vscode.ExtensionContext, resource: vscode.Uri): Promise<void> {
  let data: PlacemarkSeries;
  try {
    data = await loadVirtualKmzPlacemarks(resource);
  } catch {
    void vscode.window.showErrorMessage('Could not read file inside the KMZ archive.');
    return;
  }

  if (data.template.length === 0 && data.waylines.length === 0) {
    void vscode.window.showWarningMessage('No Placemark points with coordinates were found in this file.');
  }

  const { archiveUri, innerPath } = parseKmzUri(resource);
  const innerLabel = innerPath ? path.posix.basename(innerPath) : 'file';
  const title = `KMZ map — ${path.basename(archiveUri.fsPath)} (${innerLabel})`;
  openPlacemarkMapPanel(context, title, data.template, data.waylines, {
    reload: () => loadVirtualKmzPlacemarks(resource),
    watchUris: [vscode.Uri.file(archiveUri.fsPath)],
  });
}

function placemarkSourceForInnerPath(innerPath: string): PlacemarkSource {
  const lower = innerPath.toLowerCase();
  if (lower.endsWith('.wpml')) {
    return 'waylines';
  }
  return 'template';
}

async function resolveKmzArchiveFsPathFromWorkspace(): Promise<string | undefined> {
  const kmzFolders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === 'kmz') ?? [];
  if (kmzFolders.length === 0) {
    void vscode.window.showErrorMessage(
      'No KMZ workspace folder is open. Use "Open KMZ as Workspace Folder", or right-click a .kmz / .kml / .wpml file and choose "Show placemarks on map".'
    );
    return undefined;
  }
  if (kmzFolders.length === 1) {
    return parseKmzUri(kmzFolders[0].uri).archiveUri.fsPath;
  }

  type Pick = { label: string; description: string; fsPath: string };
  const items: Pick[] = kmzFolders.map((f) => {
    const fsPath = parseKmzUri(f.uri).archiveUri.fsPath;
    return { label: f.name, description: fsPath, fsPath };
  });
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select a KMZ workspace folder',
  });
  return picked?.fsPath;
}
