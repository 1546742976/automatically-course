const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectElectron, downloadEnvironment, ensureElectron } = require('../local/startup.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'node_modules/electron');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '44.9.0' }));
  return { root, dir, complete() {
    fs.writeFileSync(path.join(dir, 'path.txt'), 'electron.exe');
    fs.writeFileSync(path.join(dir, 'dist/version'), '44.9.0');
    fs.writeFileSync(path.join(dir, 'dist/electron.exe'), 'fixture');
  } };
}
test('包存在但运行程序缺失时必须补齐，完整安装不得重复下载', async t => {
  const f = fixture(t);
  assert.equal(inspectElectron(f.root).ready, false);
  let calls = 0;
  await ensureElectron(f.root, {}, async () => { calls++; f.complete(); });
  assert.equal(inspectElectron(f.root).ready, true);
  await ensureElectron(f.root, {}, async () => { calls++; });
  assert.equal(calls, 1);
  fs.unlinkSync(path.join(f.dir, 'dist/electron.exe'));
  assert.equal(inspectElectron(f.root).ready, false);
});
test('版本不匹配不能判定为就绪', t => {
  const f = fixture(t); f.complete();
  fs.writeFileSync(path.join(f.dir, 'dist/version'), '43.0.0');
  assert.equal(inspectElectron(f.root).ready, false);
});
test('下载失败保留阶段和处理提示', async t => {
  const f = fixture(t);
  await assert.rejects(ensureElectron(f.root, {}, async () => { throw new Error('fetch failed'); }), /Electron.*fetch failed.*代理/s);
});
test('实际预检命令在安装子进程失败时返回非零退出码', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'local'));
  fs.copyFileSync(path.resolve(__dirname, '../local/startup.cjs'), path.join(f.root, 'local/startup.cjs'));
  for (const name of ['playwright', 'playwright-core']) {
    fs.mkdirSync(path.join(f.root, 'node_modules', name));
    fs.writeFileSync(path.join(f.root, 'node_modules', name, 'index.js'), 'module.exports = {};');
  }
  fs.writeFileSync(path.join(f.dir, 'install.js'), 'console.error("fixture download failed");process.exit(7);');
  const result = spawnSync(process.execPath, [path.join(f.root, 'local/startup.cjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Electron 下载失败.*退出码 7.*代理/s);
});
test('显式代理优先；系统代理只注入子进程环境', () => {
  const env = { HTTPS_PROXY: 'http://explicit:1234' };
  assert.equal(downloadEnvironment(env, () => 'system:5678').HTTPS_PROXY, env.HTTPS_PROXY);
  assert.deepEqual(env, { HTTPS_PROXY: 'http://explicit:1234' });
  const inferred = downloadEnvironment({}, () => 'http=host:80;https=host:443');
  assert.equal(inferred.HTTPS_PROXY, 'http://host:443');
  assert.equal(inferred.HTTP_PROXY, 'http://host:80');
  assert.equal(inferred.ELECTRON_GET_USE_PROXY, '1');
  assert.equal(downloadEnvironment({}, () => '').ELECTRON_GET_USE_PROXY, undefined);
});
test('安装与构建缓存固定在项目内，不沿用 C 盘缓存', () => {
  const root = path.resolve(__dirname, '..');
  const env = downloadEnvironment({ LOCALAPPDATA: 'C:\\outside', TEMP: 'C:\\outside', npm_config_cache: 'C:\\outside' }, () => '', root);
  for (const key of ['electron_config_cache', 'ELECTRON_BUILDER_CACHE', 'npm_config_cache', 'TEMP', 'TMP']) {
    assert.ok(env[key].startsWith(path.join(root, '.cache') + path.sep), key);
  }
});
