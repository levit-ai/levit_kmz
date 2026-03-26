import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { kmzUri } from '../../uri';

const EXT_ID = 'jasper.levit-kmz';

suite('KMZ extension integration', () => {
  test('openTextDocument reads file inside KMZ via FileSystemProvider', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension not found');
    await ext.activate();

    const kmzPath = path.join(ext.extensionPath, 'example_kmzs', 'SubstationMission.kmz');
    assert.ok(fs.existsSync(kmzPath), `fixture missing: ${kmzPath}`);

    const uri = kmzUri(kmzPath, 'wpmz/template.kml') as vscode.Uri;
    const doc = await vscode.workspace.openTextDocument(uri);
    const text = doc.getText();

    assert.ok(text.includes('kml') || text.includes('KML'), 'expected XML/KML content');
  });

  test('kmz.showPlacemarkMap is registered after activation (executes without "not found")', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension not found');
    await ext.activate();

    const kmzPath = path.join(ext.extensionPath, 'example_kmzs', 'SubstationMission.kmz');
    assert.ok(fs.existsSync(kmzPath), `fixture missing: ${kmzPath}`);

    const uri = vscode.Uri.file(kmzPath);
    await assert.doesNotReject(
      async () => Promise.resolve(vscode.commands.executeCommand('kmz.showPlacemarkMap', uri)),
      'command should be registered; if this fails with "not found", another extension may own the same command id or activate() failed'
    );
  });
});
