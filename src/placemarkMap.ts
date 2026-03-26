import * as path from 'path';
import * as vscode from 'vscode';
import { extractPlacemarkPoints, type PlacemarkSource } from './kmlPlacemarks';
import { openPlacemarkMapPanel } from './placemarkMapPanel';
import { kmzUri, parseKmzUri } from './uri';

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

async function showFromKmzArchive(context: vscode.ExtensionContext, archiveFsPath: string): Promise<void> {
  const templateUri = vscode.Uri.parse(kmzUri(archiveFsPath, 'wpmz/template.kml').toString());
  const waylinesUri = vscode.Uri.parse(kmzUri(archiveFsPath, 'wpmz/waylines.wpml').toString());

  let templateBytes: Uint8Array;
  let waylinesBytes: Uint8Array;
  try {
    templateBytes = await vscode.workspace.fs.readFile(templateUri);
  } catch {
    void vscode.window.showErrorMessage('Could not read wpmz/template.kml inside the KMZ.');
    return;
  }
  try {
    waylinesBytes = await vscode.workspace.fs.readFile(waylinesUri);
  } catch {
    void vscode.window.showErrorMessage('Could not read wpmz/waylines.wpml inside the KMZ.');
    return;
  }

  const decoder = new TextDecoder('utf8', { fatal: false });
  const templatePts = extractPlacemarkPoints(decoder.decode(templateBytes), 'template');
  const waylinePts = extractPlacemarkPoints(decoder.decode(waylinesBytes), 'waylines');

  if (templatePts.length === 0 && waylinePts.length === 0) {
    void vscode.window.showWarningMessage('No Placemark points with coordinates were found in template.kml or waylines.wpml.');
  }

  const title = `KMZ map — ${path.basename(archiveFsPath)}`;
  openPlacemarkMapPanel(context, title, templatePts, waylinePts);
}

async function showFromStandaloneXml(context: vscode.ExtensionContext, file: vscode.Uri): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(file);
  } catch {
    void vscode.window.showErrorMessage(`Could not read ${path.basename(file.fsPath)}.`);
    return;
  }
  const decoder = new TextDecoder('utf8', { fatal: false });
  const text = decoder.decode(bytes);
  const lower = file.fsPath.toLowerCase();
  const source: PlacemarkSource = lower.endsWith('.wpml') ? 'waylines' : 'template';
  const templatePts = source === 'template' ? extractPlacemarkPoints(text, 'template') : [];
  const waylinePts = source === 'waylines' ? extractPlacemarkPoints(text, 'waylines') : [];

  if (templatePts.length === 0 && waylinePts.length === 0) {
    void vscode.window.showWarningMessage('No Placemark points with coordinates were found in this file.');
  }

  const title = `KMZ map — ${path.basename(file.fsPath)}`;
  openPlacemarkMapPanel(context, title, templatePts, waylinePts);
}

async function showFromVirtualKmzFile(context: vscode.ExtensionContext, resource: vscode.Uri): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(resource);
  } catch {
    void vscode.window.showErrorMessage('Could not read file inside the KMZ archive.');
    return;
  }
  const { archiveUri, innerPath } = parseKmzUri(resource);
  const source = placemarkSourceForInnerPath(innerPath);
  const decoder = new TextDecoder('utf8', { fatal: false });
  const text = decoder.decode(bytes);
  const templatePts = source === 'template' ? extractPlacemarkPoints(text, 'template') : [];
  const waylinePts = source === 'waylines' ? extractPlacemarkPoints(text, 'waylines') : [];

  if (templatePts.length === 0 && waylinePts.length === 0) {
    void vscode.window.showWarningMessage('No Placemark points with coordinates were found in this file.');
  }

  const innerLabel = innerPath ? path.posix.basename(innerPath) : 'file';
  const title = `KMZ map — ${path.basename(archiveUri.fsPath)} (${innerLabel})`;
  openPlacemarkMapPanel(context, title, templatePts, waylinePts);
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
