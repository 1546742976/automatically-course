const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const testTemporaryDir = path.resolve(__dirname, '../.cache/tests/portable');
fs.mkdirSync(testTemporaryDir, { recursive: true });
process.env.TEMP = process.env.TMP = testTemporaryDir;
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || 'dist/win-unpacked');
const exe = path.join(root, '学习通助手.exe');
const output = path.resolve('test-results');
fs.mkdirSync(output, { recursive: true });
const result = { root, checks: [] };
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error(`等待超时：${label}`);
}
async function launch() {
  const env = { ...process.env, DEBUG: 'pw:browser', ELECTRON_MIRROR: 'http://127.0.0.1:1/',
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', npm_config_registry: 'http://127.0.0.1:1/',
    PLAYWRIGHT_DOWNLOAD_HOST: 'http://127.0.0.1:1/', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = path.join(process.env.SystemRoot, 'System32');
  const child = spawn(exe, [], { cwd: os.tmpdir(), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', b => { log += b; }); child.stderr.on('data', b => { log += b; });
  child.on('error', error => { log += error.message; });
  let browser;
  try {
    const endpoint = await until(() => {
      if (child.exitCode !== null) throw new Error(`EXE 退出 ${child.exitCode}: ${log}`);
      return log.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/)?.[1];
    }, 'EXE 子窗口调试端口');
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = await until(() => context.pages().find(p => p.url().endsWith('/dashboard.html')), '控制面板');
    await page.waitForFunction(() => document.getElementById('status').textContent !== '正在连接');
    return { child, browser, context, page, log: () => log };
  } catch (e) {
    fs.writeFileSync(path.join(output, 'portable-failure.log'), log);
    await browser?.close().catch(() => {}); child.kill(); throw e;
  }
}
async function close(instance) {
  await instance.page.close();
  await until(() => instance.child.exitCode !== null, '关闭后控制进程退出', 15000);
  assert.equal(instance.child.exitCode, 0, instance.log());
  await instance.browser.close().catch(() => {});
}
function audit() {
  const files = fs.readdirSync(path.join(root, 'resources/app'), { recursive: true });
  assert(!files.some(f => /(^|[\\/])(\.local-data|\.git|tests|test-results|scripts)([\\/]|$)|\.(log|pem|key)$/.test(f)), '发布包不得包含本机数据或开发输出');
  assert(!fs.existsSync(path.join(root, 'resources/app/node_modules/electron')), '不得包含运行时下载器');
  assert(!fs.existsSync(path.join(root, 'node.exe')), '不依赖单独 Node.js');
  result.checks.push('发布文件白名单，无本机资料、密钥或 Electron 下载器');
}
(async () => {
  audit();
  let app;
  try {
    app = await launch();
    result.checks.push('无 Node.js/npm PATH、下载地址不可达、非应用工作目录下启动');
    const control = command => app.page.evaluate(c => window.__courseAssistantControl(c), command);
    const initial = await control({ type: 'state' });
    assert.equal(initial.state.queueRunning, false);
    const course = { title: '便携版模拟课程', url: 'https://mooc1.chaoxing.com/mycourse/studentstudy?courseId=portable&clazzid=1&chapterId=1' };
    await app.context.route('https://**.chaoxing.com/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><meta charset="utf-8"><title>便携版模拟课程</title><input id="portableInput"><p>当前章节暂无任务</p></html>' }));
    assert.equal((await control({ type: 'set-queue', courses: [course] })).ok, true);
    assert.equal((await control({ type: 'open', url: course.url })).ok, true);
    const coursePage = await until(() => app.context.pages().find(p => p.url().includes('courseId=portable')), '内嵌课程');
    await coursePage.locator('#portableInput').fill('中文输入验证');
    assert.equal(await coursePage.locator('#portableInput').inputValue(), '中文输入验证');
    assert.equal((await control({ type: 'start-queue', options: { rate: 1.25, muted: true, autoNext: false } })).ok, true);
    assert.equal((await control({ type: 'stop' })).ok, true);
    await app.page.screenshot({ path: path.join(output, 'portable-dashboard.png') });
    result.checks.push('内嵌网页中文输入、模拟课程加入/启动/暂停队列');
    await close(app); app = null;
    app = await launch();
    const restored = await app.page.evaluate(() => window.__courseAssistantControl({ type: 'state' }));
    assert.equal(restored.state.queueRunning, false);
    assert.equal(restored.state.enabled, false);
    assert.equal(restored.state.courses[0].title, course.title);
    assert.equal(restored.state.options.rate, 1.25);
    result.checks.push('配置和队列跨重启保留，重启不自动运行');
    if (process.argv.includes('--online')) {
      const response = await app.page.evaluate(() => window.__courseAssistantControl({ type: 'open', url: 'https://i.chaoxing.com/' }));
      assert.equal(response.ok, true, JSON.stringify(response));
      const login = await until(() => app.context.pages().find(p => /chaoxing\.com/.test(p.url())), '学习通网站');
      await login.waitForLoadState('domcontentloaded');
      await until(async () => /登录|账号|手机号|扫码/.test(await login.locator('body').innerText()), '真实登录页');
      result.website = { url: login.url(), title: await login.title() };
      await login.screenshot({ path: path.join(output, 'portable-login.png') });
      result.checks.push('真实学习通登录页面可访问（未登录）');
    }
    await close(app); app = null;
    const processes = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Process | Where-Object {$_.Path -eq $env:COURSE_ASSISTANT_TEST_EXE} | Select-Object -ExpandProperty Id'], { encoding: 'utf8', windowsHide: true, env: { ...process.env, COURSE_ASSISTANT_TEST_EXE: exe } });
    assert.equal(processes.trim(), '', '关闭后不得残留应用进程');
    result.checks.push('关闭后无残留应用进程');
    fs.writeFileSync(path.join(output, 'portable-verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { if (app) { await close(app).catch(() => app.child.kill()); } }
})().catch(error => { console.error(error); process.exitCode = 1; });
