const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporaryDir = path.join(root, '.cache/tests');
fs.mkdirSync(temporaryDir, { recursive: true });
const tests = process.argv.slice(2);
const result = spawnSync(process.execPath, ['--test', ...(tests.length ? tests : ['tests/*.test.cjs'])], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, TEMP: temporaryDir, TMP: temporaryDir }
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
