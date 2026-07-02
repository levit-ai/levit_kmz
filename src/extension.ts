import * as path from 'path';
import * as vscode from 'vscode';
import { KmzFileSystemProvider } from './kmzFsProvider';
import { showPlacemark3d, showPlacemarkMap } from './placemarkMap';
import { kmzRootUri } from './uri';
import { registerXmlTools } from './xmlTools';

const KMZ_SCHEME = 'kmz';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kmz.openAsWorkspaceFolder', async (resource?: vscode.Uri) => {
      const uri = await resolveTargetUri(resource);
      if (!uri) {
        return;
      }
      if (uri.scheme !== 'file' || !uri.fsPath.toLowerCase().endsWith('.kmz')) {
        vscode.window.showErrorMessage('Select a .kmz file on disk, or use the context menu on a KMZ in the explorer.');
        return;
      }

      const absolute = path.resolve(uri.fsPath);
      const root = kmzRootUri(absolute);
      const name = path.basename(absolute);

      const exists = vscode.workspace.workspaceFolders?.some((f) => f.uri.toString() === root.toString());
      if (exists) {
        vscode.window.showInformationMessage('This KMZ is already open as a workspace folder.');
        return;
      }

      const added = vscode.workspace.updateWorkspaceFolders(
        vscode.workspace.workspaceFolders?.length ?? 0,
        0,
        { uri: root as vscode.Uri, name }
      );
      if (!added) {
        vscode.window.showErrorMessage('Could not add KMZ to the workspace.');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kmz.showPlacemarkMap', async (resource?: vscode.Uri) => {
      await showPlacemarkMap(context, resource);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kmz.showPlacemark3d', async (resource?: vscode.Uri) => {
      await showPlacemark3d(context, resource);
    })
  );

  registerXmlTools(context);

  const provider = new KmzFileSystemProvider();
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(KMZ_SCHEME, provider, { isCaseSensitive: true }));
}

async function resolveTargetUri(resource?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (resource && resource.scheme === 'file') {
    return resource;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { KMZ: ['kmz', 'zip'] },
    openLabel: 'Open KMZ',
  });
  return picked?.[0];
}

export function deactivate(): void {}
