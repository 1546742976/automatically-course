const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { prepare, downloadEnvironment } = require('../local/startup.cjs');

(async () => {
  const root = path.resolve(__dirname, '..');
  await prepare(root);
  // Only this build process and its children inherit download proxy settings.
  Object.assign(process.env, downloadEnvironment());
  const { build, Platform, Arch } = require('electron-builder');
  await build({ projectDir: root, targets: Platform.WINDOWS.createTarget(['zip'], Arch.x64),
    config: { electronDist: path.join(root, 'node_modules/electron/dist'),
      afterPack: () => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/repair-runtime.ps1'), '-Target', 'portable'], { stdio: 'inherit', windowsHide: true }) } });
})().catch(error => { console.error(`[打包失败] ${error.message}`); process.exitCode = 1; });
