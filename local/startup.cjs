const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');

function windowsProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const output = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true });
    return /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)
      ? output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim() || '' : '';
  } catch { return ''; }
}
function downloadEnvironment(source = process.env, getProxy = windowsProxy, root = path.resolve(__dirname, '..')) {
  const env = { ...source, electron_config_cache: path.join(root, '.cache/electron'),
    ELECTRON_BUILDER_CACHE: path.join(root, '.cache/electron-builder'), npm_config_cache: path.join(root, '.cache/npm'),
    TEMP: path.join(root, '.cache/tmp'), TMP: path.join(root, '.cache/tmp') };
  if (!env.HTTPS_PROXY && !env.https_proxy && !env.HTTP_PROXY && !env.http_proxy) {
    const proxy = getProxy();
    const parts = Object.fromEntries(proxy.split(';').filter(p => p.includes('=')).map(p => p.split('=')));
    const normalize = value => value && (/^\w+:\/\//.test(value) ? value : `http://${value}`);
    const generic = proxy.includes('=') ? '' : proxy;
    if (parts.https || generic) env.HTTPS_PROXY = normalize(parts.https || generic);
    if (parts.http || generic) env.HTTP_PROXY = normalize(parts.http || generic);
  }
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy) env.ELECTRON_GET_USE_PROXY = '1';
  return env;
}
function inspectElectron(root) {
  const dir = path.join(root, 'node_modules/electron');
  try {
    const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
    const binary = fs.readFileSync(path.join(dir, 'path.txt'), 'utf8').trim();
    const installed = fs.readFileSync(path.join(dir, 'dist/version'), 'utf8').trim().replace(/^v/, '');
    return { ready: binary === 'electron.exe' && installed === version && fs.existsSync(path.join(dir, 'dist', binary)), version, dir };
  } catch { return { ready: false, dir }; }
}
function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`子进程退出码 ${code}`)));
  });
}
async function ensureElectron(root, env = downloadEnvironment(), execute = run) {
  const state = inspectElectron(root);
  if (state.ready) return state;
  console.log('[Electron 预检] 运行程序缺失或版本不匹配，正在下载并校验……');
  try {
    await execute(process.execPath, [path.join(state.dir, 'install.js')], { cwd: root, env });
    const result = inspectElectron(root);
    if (!result.ready) throw new Error('安装结束后仍未找到匹配版本的 electron.exe');
    return result;
  } catch (error) {
    throw new Error(`[Electron 下载失败] ${error.message}。请检查网络和 Windows 系统代理，或设置 HTTPS_PROXY 后重试。`);
  }
}
const runtimeCache = new Map();
function runnableElectron(root = path.resolve(__dirname, '..')) {
  if (runtimeCache.has(root)) return runtimeCache.get(root);
  const state = inspectElectron(root);
  if (!state.ready) throw new Error('[Electron 预检] 运行程序不完整，请先运行 node local/startup.cjs。');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  function usable(exe) {
    const result = spawnSync(exe, ['--version'], { env, encoding: 'utf8', timeout: 10000, windowsHide: true });
    return result.status === 0 && result.stdout.trim() === `v${state.version}`;
  }
  const exe = path.join(state.dir, 'dist/electron.exe');
  if (!usable(exe)) {
    console.log('[Electron 预检] 正在恢复项目运行目录的普通执行权限……');
    execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/repair-runtime.ps1'), '-Target', 'source'], { windowsHide: true, stdio: 'inherit' });
    if (!usable(exe)) throw new Error('[Electron 启动失败] 请检查项目运行目录权限。运行程序保留在项目内，不会回退到 C 盘。');
  }
  runtimeCache.set(root, exe);
  return exe;
}
async function prepare(root = path.resolve(__dirname, '..')) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) throw new Error('[Node.js 预检] 请安装 Node.js 22.12 或更新版本。');
  const env = downloadEnvironment(process.env, windowsProxy, root);
  fs.mkdirSync(env.TEMP, { recursive: true });
  let missing = false;
  for (const name of ['playwright', 'playwright-core', 'electron/package.json']) {
    try { require.resolve(name, { paths: [root] }); } catch { missing = true; }
  }
  if (missing) {
    console.log('[依赖预检] 正在按 package-lock.json 安装依赖……');
    await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npm ci --include=dev'], { cwd: root, env });
  }
  await ensureElectron(root, env);
  return runnableElectron(root);
}
if (require.main === module) {
  prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { inspectElectron, downloadEnvironment, ensureElectron, prepare, runnableElectron };
