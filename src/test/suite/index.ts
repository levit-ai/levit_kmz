import * as path from 'path';
import { globSync } from 'glob';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  const testsRoot = path.resolve(__dirname, '..');

  for (const f of globSync('suite/**/*.test.js', { cwd: testsRoot })) {
    mocha.addFile(path.resolve(testsRoot, f));
  }

  return new Promise((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} tests failed`));
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}
