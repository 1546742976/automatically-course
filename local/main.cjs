const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { chromium, _electron } = require('playwright');
const { CourseRunner, courseIdentity } = require('./runner.cjs');
const { installPlayerAgent } = require('./player-agent.js');
const { installTaskAgent } = require('./task-agent.js');
const { AnswerService } = require('./ai.cjs');
const { CourseView } = require('./course-view.cjs');
const { openCourseChapter } = require('./catalog.cjs');

function findBrowser() {
  const candidates = [process.env.COURSE_ASSISTANT_BROWSER,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'), chromium.executablePath()];
  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}
async function legacyStorage(dataDir, executablePath) {
  if (fs.existsSync(path.join(dataDir, 'desktop-migrated.json'))) return null;
  const exported = path.join(dataDir, 'browser-storage-migration.json');
  if (fs.existsSync(exported)) return JSON.parse(await fsp.readFile(exported, 'utf8'));
  const profile = path.join(dataDir, 'browser-profile');
  if (!fs.existsSync(profile)) return null;
  const browser = await chromium.launchPersistentContext(profile, { executablePath: executablePath || findBrowser(), headless: true });
  try { return await browser.storageState(); } finally { await browser.close(); }
}
async function createApp({ dataDir = path.resolve(__dirname, '../.local-data'), headless = false, executablePath, prepareContext, intervalMs, settleMs } = {}) {
  await fsp.mkdir(dataDir, { recursive: true });
  let preferences = {};
  try { preferences = JSON.parse(await fsp.readFile(path.join(dataDir, 'preferences.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') console.warn('读取上次设置失败，将使用默认设置。'); }
  const storage = await legacyStorage(dataDir, executablePath);
  const env = { ...process.env, COURSE_ASSISTANT_DATA: path.join(dataDir, 'desktop-profile'), COURSE_ASSISTANT_HIDDEN: headless ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  let electronApp;
  try {
    electronApp = await _electron.launch({ args: [path.join(__dirname, 'electron-shell.cjs')], env, timeout: 30000 });
    const context = electronApp.context();
    const dashboard = await electronApp.firstWindow();
    await electronApp.evaluate(() => Boolean(globalThis.__courseShell));
    context.newPage = async () => {
      const marker = `about:blank#course-${randomUUID()}`;
      const [created] = await Promise.all([
        context.waitForEvent('page', { predicate: p => p.waitForURL(marker, { timeout: 10000 }).then(() => true, () => false), timeout: 15000 }),
        electronApp.evaluate((_, marker) => globalThis.__courseShell.createPage(marker), marker)
      ]);
      return created;
    };
    // Course views use their own persistent Electron session, separate from the UI.
    context.addCookies = cookies => electronApp.evaluate((_, cookies) => globalThis.__courseShell.importCookies(cookies), cookies);
    context.cookies = async urls => electronApp.evaluate(async ({ session }, urls) => {
      const store = session.fromPartition('persist:learning').cookies;
      const cookies = !urls?.length ? await store.get({}) : (await Promise.all(urls.map(url => store.get({ url })))).flat();
      return [...new Map(cookies.map(c => [`${c.domain}|${c.path}|${c.name}`, {
        name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expirationDate || -1,
        httpOnly: c.httpOnly, secure: c.secure, sameSite: ({ strict: 'Strict', lax: 'Lax', no_restriction: 'None' })[c.sameSite] || 'Lax'
      }])).values()];
    }, typeof urls === 'string' ? [urls] : urls);
    if (storage) {
      await context.addCookies(storage.cookies);
      await fsp.writeFile(path.join(dataDir, 'desktop-local-storage.json'), JSON.stringify(storage.origins || []));
    }
    const originsFile = path.join(dataDir, 'desktop-local-storage.json');
    if (fs.existsSync(originsFile)) {
      const origins = JSON.parse(await fsp.readFile(originsFile, 'utf8'));
      await context.addInitScript(origins => {
        const origin = origins.find(o => o.origin === location.origin);
        if (!origin || localStorage.getItem('__courseAssistantMigrated')) return;
        for (const item of origin.localStorage || []) localStorage.setItem(item.name, item.value);
        localStorage.setItem('__courseAssistantMigrated', '1');
      }, origins);
    }
    if (prepareContext) await prepareContext(context);
    await context.addInitScript(installPlayerAgent);
    await context.addInitScript(installTaskAgent);
    const ai = new AnswerService(dataDir); await ai.load();
    const runner = new CourseRunner(context, { dataDir, preferences, intervalMs, settleMs, ai });
    runner.dashboard = dashboard;
    const view = new CourseView(context, runner, electronApp);
    const dashboardURL = pathToFileURL(path.join(__dirname, 'dashboard.html')).href;
    await dashboard.exposeBinding('__courseAssistantControl', async (source, command) => {
      if (source.page !== dashboard || source.frame !== dashboard.mainFrame() || source.frame.url() !== dashboardURL) return { ok: false, error: '请从本地控制面板操作。' };
      try {
        if (command.type === 'view-state') return { ok: true, view: await view.snapshot() };
        if (command.type === 'view-input') { await view.input(command.event); return { ok: true }; }
        if (command.type === 'view-layout') { await view.layout(command.bounds); return { ok: true }; }
        if (command.type === 'view-hide') { await view.hide(); return { ok: true }; }
        if (command.type === 'show-course' && command.courseId) {
          const course = runner.state.courses.find(c => c.id === command.courseId);
          if (!course) throw new Error('未找到课程。');
          let page = runner.courseQueue.pages.get(course.id);
          if (!page || page.isClosed()) {
            page = await context.newPage(); runner.courseQueue.pages.set(course.id, page);
          }
          await openCourseChapter(page, course);
          if (courseIdentity(page.url())?.endsWith(`:${course.id}`)
            && /学习通将课程页转入安全检测|课程页面.*跳转|上次课程页面发生跳转/.test(course.detail || '')) {
            course.status = 'paused';
            course.detail = '已返回课程章节，点击继续队列重新检查任务。';
            await runner.save();
          }
          view.selected = page;
          return { ok: true, state: runner.snapshot() };
        }
        if (command.type === 'start' && !runner.state.queueRunning && view.page()) runner.page = view.page();
        const state = await runner.dispatch(command);
        if (command.type === 'open' || command.type === 'show-course') view.selected = runner.activePage();
        return { ok: true, state };
      } catch (error) { return { ok: false, error: error.message }; }
    });
    await dashboard.goto(dashboardURL);
    if (!headless) await electronApp.evaluate(() => { globalThis.__courseShell.window.restore(); globalThis.__courseShell.window.show(); });
    if (storage) await fsp.writeFile(path.join(dataDir, 'desktop-migrated.json'), JSON.stringify({ importedAt: new Date().toISOString() }));
    if (storage) await fsp.rm(path.join(dataDir, 'browser-storage-migration.json'), { force: true });
    runner.startPolling();
    let closePromise, resolveClosed;
    const closed = new Promise(resolve => { resolveClosed = resolve; });
    function close() {
      closePromise ||= (async () => {
        try {
          await runner.close();
          await electronApp.evaluate(() => globalThis.__courseShell.flush()).catch(error => { if (!/closed|exited/.test(error.message)) throw error; });
        }
        finally { await electronApp.close().catch(() => {}); resolveClosed(); }
      })();
      return closePromise;
    }
    dashboard.once('close', () => { close().catch(error => console.error(error.message)); });
    electronApp.once('close', () => { close().catch(error => console.error(error.message)); });
    return { context, electronApp, runner, dashboard, view, close, closed };
  } catch (error) { await electronApp?.close().catch(() => {}); throw error; }
}
if (require.main === module) {
  createApp().then(async app => {
    console.log('学习通助手已启动，课程页面直接内嵌在助手窗口中。');
    process.once('SIGINT', () => { app.close().catch(error => console.error(error.message)); });
    process.once('SIGTERM', () => { app.close().catch(error => console.error(error.message)); });
    await app.closed;
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { createApp, findBrowser };
