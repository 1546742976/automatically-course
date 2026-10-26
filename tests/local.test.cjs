const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../local/main.cjs');
const { courseIdentity, validateURL, normalizeOptions } = require('../local/runner.cjs');
const { academicTerm, matchCurrentTerm } = require('../local/catalog.cjs');

const origin = 'https://mooc1.chaoxing.com';
const playerOrigin = 'https://video.chaoxing.com';
let app, dataDir;
let events = [];
let withTerms = false;
let launchConflict = false;
const courseLinks = ids => ids.map(id => `<a href="${origin}/courselist/opencoursenewfy?courseId=queue${id}&clazzId=1">课程${({ A: '甲', B: '乙', C: '丙' })[id]}</a>`).join('');

function wav(seconds) {
  const rate = 8000, size = rate * seconds * 2, data = Buffer.alloc(44 + size);
  data.write('RIFF', 0); data.writeUInt32LE(36 + size, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(size, 40);
  return data;
}
function html(body) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试课程</title><style>video{display:block;width:400px;height:100px}iframe{width:450px;height:160px}</style></head><body>${body}</body></html>`;
}
function iframe(name, seconds = 2, extra = '') {
  return `<iframe src="${playerOrigin}/ananas/modules/video/index.html?name=${name}&seconds=${seconds}${extra}"></iframe>`;
}
async function fixtures(context) {
  await context.exposeBinding('__recordCourseEvent', (_source, event) => events.push(event));
  await context.route('https://**.chaoxing.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/media.wav') return route.fulfill({ contentType: 'audio/wav', body: wav(Number(url.searchParams.get('seconds')) || 2) });
    if (url.hostname === 'detect.chaoxing.com') {
      const body = url.searchParams.has('mes') ? `<script>alert(${JSON.stringify(url.searchParams.get('mes'))});location.replace('https://i.mooc.chaoxing.com/space/index')</script>`
        : url.searchParams.has('captcha') ? '<div id="captcha">请完成验证码</div>'
        : `<script>setTimeout(()=>location.replace(${JSON.stringify(url.searchParams.has('return') ? `${origin}/mycourse/studentstudy?courseId=queueC&clazzid=1` : 'https://i.mooc.chaoxing.com/space/index')}),80)</script>`;
      return route.fulfill({ contentType: 'text/html', body: html(body) });
    }
    if (url.pathname === '/mooc-ans/knowledge/cards') return route.fulfill({ contentType: 'text/html', body: html('<audio id="auditionAudio" src="" hidden></audio><dl><dd>暂无内容</dd></dl>'
      + (url.searchParams.has('unknown') ? '<script>window.mArg={attachments:[{type:"discuss",property:{name:"讨论任务"}}]}</script>' : '')) });
    if (url.pathname.includes('/ananas/modules/video/')) {
      const name = url.searchParams.get('name'), seconds = Number(url.searchParams.get('seconds')) || 2;
      if (name === 'init') return route.fulfill({contentType:'text/html',body:html(`<div class="video-js"><video controls title="init"></video><button class="vjs-big-play-button" onclick="const v=document.querySelector('video');v.src='${origin}/media.wav?seconds=30';v.play();this.hidden=true;window.initialized=(window.initialized||0)+1">播放视频</button></div>`) });
      return route.fulfill({ contentType: 'text/html', body: html(`<video id="video_html5_api" controls preload="auto" ${url.searchParams.has('auto') ? 'muted autoplay' : ''} title="${name}" src="${origin}/media.wav?seconds=${seconds}"></video>
        <script>const v=document.querySelector('video');for(const event of ['playing','ended'])v.addEventListener(event,()=>parent.postMessage({event,name:'${name}'},'*'));</script>`) });
    }
    const scenario = url.searchParams.get('courseId'), chapter = url.searchParams.get('chapterId');
    if (url.hostname === 'i.chaoxing.com') return route.fulfill({ contentType: 'text/html', body: html(`<iframe src="${origin}/catalog"></iframe>`) });
    if (url.pathname === '/fyportal/wfw/courselist/getStudyCourse') return route.fulfill({ contentType: 'text/html', body: courseLinks(url.searchParams.get('term') === 'current' ? ['A', 'C'] : ['B']) });
    if (url.pathname === '/catalog') {
      const current = academicTerm();
      const terms = withTerms ? `<div class="xqselect"><p class="selectEn_name" onclick="document.querySelector('ul[name=xq]').hidden=false">全部</p><ul name="xq" hidden><li value="0">全部</li><li value="current" semesternum="${current.code}" onclick="filterTerm('current')">${current.title}</li><li value="old" semesternum="20201" onclick="filterTerm('old')">2020-2021第一学期</li></ul></div><script>window.jQuery=function(){};jQuery.active=0;async function filterTerm(id){jQuery.active++;document.querySelector('#catalogCourses').innerHTML=await(await fetch('/fyportal/wfw/courselist/getStudyCourse?term='+id)).text();jQuery.active--;}</script>` : '';
      return route.fulfill({ contentType: 'text/html', body: html(`${terms}<div id="catalogCourses">${courseLinks(['A', 'B', 'C'])}</div>`) });
    }
    if (url.pathname === '/courselist/opencoursenewfy') {
      if (launchConflict && scenario === 'queueC') {
        launchConflict = false;
        const redirect = `https://detect.chaoxing.com/api/monitor_temp?mes=${encodeURIComponent('多终端登录可能会被判定异常学习')}`;
        return route.fulfill({ contentType: 'text/html', body: html(`<script>location.replace(${JSON.stringify(redirect)})</script>`) });
      }
      return route.fulfill({ contentType: 'text/html', body: html(`<button onclick="document.querySelector('iframe').src='/mycourse/studentcourse?courseId=${scenario}'">章节</button><iframe></iframe>`) });
    }
    if (url.pathname === '/mycourse/studentcourse' && scenario?.startsWith('queue')) return route.fulfill({ contentType: 'text/html', body: html(`<script>function toOld(id){top.location.href='/mycourse/studentstudy?courseId=${scenario}&clazzid=1&chapterId='+id}</script><div class="chapter_item" id="cur1" onclick="toOld(1)"><a class="clicktitle">第一节</a><span class="catalog_points_yi">1</span></div><div class="chapter_item" id="cur2" onclick="toOld(2)"><a class="clicktitle">第二节</a></div>`) });
    if (url.searchParams.has('expired')) return route.fulfill({ contentType: 'text/html', body: html('<script>location.replace("https://i.mooc.chaoxing.com/space/index")</script>') });
    let body;
    if (scenario === 'sequence') {
      body = chapter === '2' ? `<h1>第二节</h1>${iframe('C', 30)}`
        : `<h1>第一节</h1>${iframe('A')}${iframe('B')}<button id="prevNextFocusNext" onclick="location.href='?courseId=sequence&clazzid=1&chapterId=2'">下一节</button>`;
    } else if (scenario === 'autoplay') body = iframe('A', 30) + iframe('B', 30, '&auto=1');
    else if (scenario === 'known-empty') body = chapter === '2' ? iframe('空章节后的课程视频', 30)
      : '<iframe src="/mooc-ans/knowledge/cards"></iframe><button id="nextChapter" onclick="location.href=\'?courseId=known-empty&clazzid=1&chapterId=2\'">下一节</button>';
    else if (scenario === 'empty-unknown') body = '<iframe src="/mooc-ans/knowledge/cards?unknown=1"></iframe><button id="nextChapter" onclick="window.nextClicks=1">下一节</button>';
    else if (scenario === 'fake-empty') body = '<dd>暂无内容</dd><button id="nextChapter" onclick="window.nextClicks=1">下一节</button>';
    else if (scenario === 'init') body = '<audio id="auditionAudio" src="" style="display:none"></audio>' + iframe('init', 30);
    else if (scenario === 'queueA') body = iframe('课程甲', 1);
    else if (scenario === 'queueB') body = '<script>window.mArg={attachments:[{type:"discuss",property:{name:"讨论任务"}}]}</script>';
    else if (scenario === 'queueC') body = iframe('课程丙', 30);
    else if (scenario === 'input') body = '<input id="loginName" placeholder="账号"><input id="loginPassword" type="password"><button onclick="window.loggedIn=true">登录</button><a id="popupLink" href="?courseId=input&clazzid=1&popup=1" target="_blank">弹出课程</a>';
    else if (scenario === 'locked') body = iframe('锁定章节', 1) + '<button id="prevNextFocusNext" disabled>下一节</button>';
    else if (scenario === 'empty') body = '<h1>文档任务</h1><button id="prevNextFocusNext" onclick="document.body.dataset.skipped=true">下一节</button>';
    else if (scenario === 'blocked') body = '<div role="dialog">请完成人脸身份验证</div>' + iframe('验证视频', 30);
    else if (scenario === 'no-next' || scenario === 'no-switch') body = iframe('末尾视频', 1) + (scenario === 'no-switch' ? '<button id="prevNextFocusNext" onclick="window.clicks=(window.clicks||0)+1">下一节</button>' : '');
    else if (scenario) body = iframe('长视频', 30);
    else body = '<h1>登录并选择课程</h1>';
    body += `<script>addEventListener('message',e=>{if(e.data.event)window.__recordCourseEvent(e.data)});</script>`;
    return route.fulfill({ contentType: 'text/html', body: html(body) });
  });
}
async function makeApp() {
  return createApp({ dataDir, headless: true, intervalMs: 100, settleMs: 250, prepareContext: fixtures });
}
async function waitFor(fn, description, timeout = 15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`等待超时：${description}；${JSON.stringify(app?.runner.snapshot())}`);
}
async function openCourse(scenario) {
  if (!await app.dashboard.locator('.manual-course').evaluate(el => el.open)) await app.dashboard.locator('.manual-course summary').click();
  await app.dashboard.locator('#courseURL').fill(`${origin}/mycourse/studentstudy?courseId=${scenario}&clazzid=1&chapterId=1`);
  await app.dashboard.locator('#openURL').click();
  await waitFor(() => app.runner.page?.url().includes(`courseId=${scenario}`) && app.runner.state.status === 'idle', '控制面板打开课程');
  await waitFor(() => app.dashboard.locator('#start').isEnabled(), '操作完成');
  if (await app.dashboard.locator('#courseDialog').evaluate(el => el.open)) await app.dashboard.locator('#closeCourse').click();
  return app.runner.page;
}
async function start(options = { rate: 2, autoNext: true }) {
  await app.dashboard.locator('#rate').selectOption(String(options.rate || 2));
  await app.dashboard.locator('#autoNext').setChecked(options.autoNext ?? true);
  await app.dashboard.locator('#start').click();
  await waitFor(() => app.runner.state.enabled, '控制面板启动播放');
}
async function stop() {
  await app.dashboard.locator('#stop').click();
  await waitFor(() => !app.runner.state.enabled && app.runner.state.status === 'paused', '控制面板暂停');
}

before(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'course-local-test-'));
  await fs.writeFile(path.join(dataDir, 'browser-storage-migration.json'), JSON.stringify({
    cookies: [{ name: 'legacy-login', value: 'migrated', domain: '.chaoxing.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }],
    origins: [{ origin, localStorage: [{ name: 'legacy-test', value: '保留登录资料' }] }]
  }));
  app = await makeApp();
});
after(async () => {
  await app?.close();
  if (dataDir && path.dirname(dataDir) === os.tmpdir() && path.basename(dataDir).startsWith('course-local-test-')) {
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('只接受学习通课程网址，规范化课程标识和播放选项', () => {
  assert.equal(courseIdentity(`${origin}/mycourse/studentstudy?courseId=1&clazzId=2&chapterId=3`), 'mooc1.chaoxing.com:1:2');
  assert.equal(courseIdentity('https://chaoxing.com.evil.test/mycourse/studentstudy'), null);
  assert.equal(courseIdentity(`${origin}/work/doWork`), null);
  assert.equal(validateURL(''), 'https://i.chaoxing.com/');
  assert.throws(() => validateURL('javascript:alert(1)'));
  assert.throws(() => validateURL('https://example.com'));
  assert.deepEqual(normalizeOptions({ rate: 99, muted: false }), { rate: 1, muted: false, autoNext: true });
});

test('本地控制面板无需扩展；响应式布局可用，未进入课程时提示操作', async () => {
  assert.ok(app.dashboard.url().startsWith('file:'));
  assert.equal(app.context.serviceWorkers().length, 0);
  assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await waitFor(async () => await app.dashboard.locator('#status').textContent() === '准备开始', '面板初始化');
  await fs.mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
  await app.dashboard.screenshot({ path: path.resolve(__dirname, '../test-results/local-dashboard.png'), fullPage: true });
  await app.dashboard.setViewportSize({ width: 390, height: 800 });
  assert.equal(await app.dashboard.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await app.dashboard.setViewportSize({ width: 1200, height: 850 });
  await app.dashboard.locator('#start').click();
  await waitFor(async () => /登录学习通/.test(await app.dashboard.locator('#error').textContent()), '未进入课程提示');
});

test('自动迁移旧版登录 Cookie 和本地资料，课程会话与控制面板隔离', async () => {
  const page = await app.context.newPage();
  await page.goto(`${origin}/migration`);
  assert.match(await page.evaluate(() => document.cookie), /legacy-login=migrated/);
  assert.equal(await page.evaluate(() => localStorage.getItem('legacy-test')), '保留登录资料');
  assert.equal(await app.dashboard.evaluate(() => localStorage.getItem('legacy-test')), null);
  assert.equal(await page.evaluate(() => typeof window.__courseAssistantControl), 'undefined');
  assert.equal(await fs.access(path.join(dataDir, 'browser-storage-migration.json')).then(() => true, () => false), false);
  const id = await app.view.id(page);
  assert.equal(await app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(Number(id)).session === globalThis.__courseShell.window.webContents.session, id), false);
  await page.close();
});

test('旧版按地址误报的验证记录不再沿用，重新打开章节清除过期跳转提示', async () => {
  const legacy = new app.runner.constructor(app.context, { preferences: { courses: [{ status: 'attention', detail: '学习通将课程页转入安全检测，队列已暂停。请在助手内查看并处理平台验证后继续。' }] } });
  assert.equal(legacy.state.courses[0].status, 'paused');
  assert.doesNotMatch(legacy.state.courses[0].detail, /验证|安全检测/);
  await legacy.close();
  await app.runner.dispatch({ type: 'set-queue', courses: [{ title: '重新进入课程', url: `${origin}/mycourse/studentstudy?courseId=queueC&clazzid=1` }] });
  const course = app.runner.state.courses[0];
  course.status = 'attention';
  course.detail = '课程页面已跳转到学习通首页，尚未返回章节。请重新进入课程后继续。';
  const result = await app.dashboard.evaluate(courseId => window.__courseAssistantControl({ type: 'show-course', courseId }), course.id);
  assert.equal(result.ok, true);
  assert.equal(course.status, 'paused');
  assert.match(course.detail, /已返回课程章节/);
  await app.runner.dispatch({ type: 'set-queue', courses: [] });
});

test('打开课程复用首页旧标签，从课程入口恢复保存章节，忽略过期地址并在队列保留章节位置', async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: [{ title: '课程丙', url: `${origin}/courselist/opencoursenewfy?courseId=queueC&clazzId=1` }] });
  const course = app.runner.state.courses[0];
  course.resumeURL = `${origin}/mycourse/studentstudy?courseId=queueC&clazzid=1&chapterId=2&expired=1`;
  const page = await app.context.newPage();
  app.runner.courseQueue.pages.set(course.id, page);
  await page.goto('https://i.mooc.chaoxing.com/space/index');
  course.status = 'attention'; course.detail = '课程页面已跳转到学习通首页，尚未返回章节。请重新进入课程后继续。';
  const result = await app.dashboard.evaluate(courseId => window.__courseAssistantControl({ type: 'show-course', courseId }), course.id);
  assert.equal(result.ok, true, result.error);
  assert.equal(app.runner.courseQueue.pages.get(course.id), page);
  assert.match(page.url(), /chapterId=2/);
  assert.doesNotMatch(page.url(), /expired/);
  assert.equal(course.status, 'paused');
  let navigations = 0; const navigated = frame => { if (frame === page.mainFrame()) navigations++; };
  page.on('framenavigated', navigated);
  try {
    await app.runner.dispatch({ type: 'start-queue', options: { parallel: 1 } });
    await waitFor(() => app.runner.state.status === 'playing', '打开课程后实际继续队列');
    assert.equal(navigations, 0, '已经在正确章节时保留当前页面，不强制跳回保存地址');
    assert.match(course.resumeURL, /chapterId=2/);
  } finally { page.off('framenavigated', navigated); await app.runner.dispatch({ type: 'stop' }); }
});

test('队列启动不接管另一门课程，错误课程地址不能覆盖恢复位置', async () => {
  const other = await app.context.newPage();
  await other.goto(`${origin}/mycourse/studentstudy?courseId=queueD&clazzid=1`);
  const runner = new app.runner.constructor(app.context);
  runner.page = other;
  await assert.rejects(runner.start({}, 'queueC:1'), /所选课程/);
  assert.equal(runner.state.enabled, false);
  assert.equal(runner.scope, null);
  const resumeURL = `${origin}/mycourse/studentstudy?courseId=queueC&clazzid=1&chapterId=2`;
  const course = { id: 'queueC:1', url: resumeURL, resumeURL, status: 'running' };
  const owner = new app.runner.constructor(app.context, { preferences: { courses: [course] } });
  owner.courseQueue.jobs.set(course.id, { course, runner, ready: true });
  await owner.courseQueue.stop();
  assert.equal(course.resumeURL, resumeURL, '暂停时不保存其他课程的地址');
  await owner.close(); await other.close();
  await app.runner.dispatch({ type: 'set-queue', courses: [] });
});

test('本地程序通过控制面板启动：跨域 iframe 视频依次播放，结束后切换并继续下一节', { timeout: 30000 }, async () => {
  events = [];
  const page = await openCourse('sequence');
  await start();
  await waitFor(() => page.url().includes('chapterId=2'), '切换第二节', 20000);
  const aStart = events.findIndex(e => e.name === 'A' && e.event === 'playing');
  const aEnd = events.findIndex(e => e.name === 'A' && e.event === 'ended');
  const bStart = events.findIndex(e => e.name === 'B' && e.event === 'playing');
  const bEnd = events.findIndex(e => e.name === 'B' && e.event === 'ended');
  assert.ok(aStart >= 0 && aEnd > aStart && bStart > aEnd && bEnd > bStart, JSON.stringify(events));
  await waitFor(() => app.runner.state.status === 'playing' && app.runner.state.title === 'C', '下一节继续播放');
  assert.equal(await page.evaluate(() => typeof window.__courseAssistantControl), 'undefined');
  assert.equal(app.runner.state.enabled, true);
  await stop();
});

test('暂停实际停止播放并恢复原速度，刷新后保留设定，离开课程后停止', { timeout: 20000 }, async () => {
  const page = await openCourse('pause');
  await start({ rate: 1.5 });
  await waitFor(() => app.runner.state.status === 'playing', '长视频播放');
  let frame = page.frames().find(f => f.url().includes('/ananas/modules/video/'));
  assert.equal(await frame.locator('video').evaluate(v => v.playbackRate), 1.5);
  await stop();
  const saved = await frame.locator('video').evaluate(v => ({ paused: v.paused, rate: v.playbackRate, muted: v.muted, time: v.currentTime }));
  assert.equal(saved.paused, true); assert.equal(saved.rate, 1); assert.equal(saved.muted, false);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(await frame.locator('video').evaluate(v => v.currentTime), saved.time);
  await start({ rate: 1.5 });
  await page.reload();
  await waitFor(() => app.runner.state.status === 'playing', '刷新后继续');
  frame = page.frames().find(f => f.url().includes('/ananas/modules/video/'));
  await waitFor(async () => await frame.locator('video').evaluate(v => !v.paused && v.playbackRate === 1.5), '刷新后使用原速度');
  await page.goto(`${origin}/mycourse/studentcourse`);
  await waitFor(() => !app.runner.state.enabled, '离开课程停止');
});

test('另一个播放器自行播放时暂停它，保持一次播放一个视频', async () => {
  const page = await openCourse('autoplay');
  const a = page.frames().find(f => f.url().includes('name=A'));
  const b = page.frames().find(f => f.url().includes('name=B'));
  await waitFor(async () => await b.locator('video').evaluate(v => !v.paused), 'B 自动播放');
  await start();
  await waitFor(async () => await a.locator('video').evaluate(v => !v.paused), 'A 受控播放');
  assert.equal(await b.locator('video').evaluate(v => v.paused), true);
  await stop();
});

test('网页覆盖原生 Map 后仍能扫描、播放和暂停，保留网页自己的 Map', async () => {
  const page = await openCourse('legacy-map');
  const frames = page.frames().filter(f => /chaoxing\.com/.test(f.url()));
  for (const frame of frames) {
    await frame.evaluate(() => { window.Map = function LegacyMap() { this.put = () => {}; }; });
    await assert.rejects(frame.evaluate(x => x, { probe: true }), /refs\.set is not a function/);
  }
  await app.runner.dispatch({ type: 'scan' });
  await start();
  await waitFor(() => app.runner.state.status === 'playing', 'Map 被覆盖后播放');
  const mediaFrame = frames.find(f => f.url().includes('/ananas/modules/video/'));
  await waitFor(async () => await mediaFrame.locator('video').evaluate(v => !v.paused), '视频实际播放');
  await stop();
  assert.equal(await mediaFrame.locator('video').evaluate(v => v.paused), true);
  for (const frame of frames) assert.equal(await frame.evaluate(() => typeof Map.prototype.set), 'undefined');
});
test('忽略章节隐藏的翻译音频，通过网页播放按钮初始化并持续播放', async () => {
  const page = await openCourse('init'); await start();
  const frame = page.frames().find(f => f.url().includes('name=init'));
  await waitFor(async () => await frame.locator('video').evaluate(v => v.currentTime > 0.2), '网页播放器初始化');
  assert.equal(await frame.evaluate(() => window.initialized), 1);
  assert.equal(await page.locator('#auditionAudio').evaluate(a => a.paused), true);
  assert.equal(app.runner.state.status, 'playing');
  await stop();
});

test('章节锁定时显示原因，无视频文档页不跳过', async () => {
  await openCourse('locked'); await start();
  await waitFor(() => app.runner.state.status === 'attention', '章节锁定提示');
  assert.match(app.runner.state.detail, /解锁/); await stop();
  const page = await openCourse('empty'); await start();
  await waitFor(() => app.runner.state.status === 'waiting', '等待视频状态');
  assert.equal(await page.locator('body').getAttribute('data-skipped'), null); await stop();
});

test('验证提示暂停播放，手动处理后恢复；关闭自动切换后停留本页', async () => {
  const page = await openCourse('blocked'); await start();
  await waitFor(() => app.runner.state.status === 'attention', '人工验证提示');
  const frame = page.frames().find(f => f.url().includes('/ananas/modules/video/'));
  assert.equal(await frame.locator('video').evaluate(v => v.paused), true);
  await page.locator('[role="dialog"]').evaluate(el => el.remove());
  await waitFor(() => app.runner.state.status === 'playing', '验证处理后恢复'); await stop();
  await openCourse('no-next'); await start({ autoNext: false });
  await waitFor(() => app.runner.state.status === 'done', '本页结束');
  assert.match(app.runner.state.detail, /已关闭/); await stop();
});

test('点击下一节无效时不会重复点击，给出未切换提示', async () => {
  const page = await openCourse('no-switch'); await start();
  await waitFor(async () => await page.evaluate(() => window.clicks === 1), '点击一次下一节');
  app.runner.nextAttempt = Date.now() - 16000;
  await waitFor(() => app.runner.state.status === 'attention', '导航失败提示');
  assert.equal(await page.evaluate(() => window.clicks), 1);
  assert.match(app.runner.state.detail, /未切换/); await stop();
});

test('原生内嵌页面直接输入中文、切换标签、缩放和调整尺寸，保持单窗口', async () => {
  await app.electronApp.evaluate(() => {
    globalThis.__nativeTestErrors = [];
    globalThis.__nativeTestCapture = error => globalThis.__nativeTestErrors.push(error.message);
    process.on('uncaughtException', globalThis.__nativeTestCapture);
  });
  const page = await openCourse('input');
  await app.dashboard.locator('#show').click();
  const id = await app.view.id(page);
  const mounted = () => app.electronApp.evaluate((_, id) => globalThis.__courseShell.window.contentView.children.at(-1) === globalThis.__courseShell.views.get(Number(id)), id);
  await waitFor(mounted, '真正的网页视图已挂载');
  assert.equal(await app.dashboard.locator('#courseImage, #courseKeyboard').count(), 0);
  await page.locator('#loginName').click();
  await page.keyboard.insertText('中文账号');
  assert.equal(await page.locator('#loginName').inputValue(), '中文账号');
  await page.keyboard.press('Tab');
  await page.keyboard.type('private-test');
  await waitFor(async () => await page.locator('#loginPassword').inputValue() === 'private-test', '输入密码');
  await app.dashboard.locator('#courseZoom').selectOption('1.25');
  await waitFor(() => app.electronApp.evaluate(({ webContents }, id) => webContents.fromId(Number(id)).getZoomFactor() === 1.25, id), '原生网页缩放');
  await app.electronApp.evaluate(() => globalThis.__courseShell.window.setContentSize(1000, 720));
  const rect = await app.dashboard.locator('#courseScreen').boundingBox();
  await waitFor(() => app.electronApp.evaluate((_, { id, rect }) => {
    const bounds = globalThis.__courseShell.views.get(Number(id)).getBounds();
    return bounds.width === Math.round(rect.width) && bounds.height === Math.round(rect.height);
  }, { id, rect }), '网页随窗口尺寸调整');
  const [popup] = await Promise.all([
    app.context.waitForEvent('page'),
    page.locator('#popupLink').click()
  ]);
  await popup.waitForLoadState('domcontentloaded');
  const popupId = await app.view.id(popup);
  await waitFor(() => app.dashboard.locator(`#courseTabs button[data-id="${popupId}"]`).count(), '网页弹出页面成为内嵌标签');
  await waitFor(() => app.dashboard.locator(`#courseTabs button[data-id="${popupId}"]`).getAttribute('aria-selected').then(v => v === 'true'), '自动切换到弹出页面');
  assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  await app.dashboard.locator(`#courseTabs button[data-id="${id}"]`).click();
  await waitFor(mounted, '切回原课程');
  await app.dashboard.locator('#closeCourse').click();
  await waitFor(async () => !await mounted(), '收起时卸下网页视图');
  assert.equal(await app.electronApp.evaluate(() => [...globalThis.__courseShell.views.values()].every(view => {
    const bounds = view.getBounds();
    return bounds.x + bounds.width <= 0;
  })), true, '返回队列后，后台网页不能覆盖助手面板');
  await popup.close();
  await app.electronApp.evaluate(() => globalThis.__courseShell.window.setContentSize(1200, 850));
  const errors = await app.electronApp.evaluate(() => {
    process.off('uncaughtException', globalThis.__nativeTestCapture);
    return globalThis.__nativeTestErrors;
  });
  assert.deepEqual(errors, [], '打开和关闭内嵌标签不能产生主进程异常');
});

test('学习通明确标注的空章节可切换下一节，遵守自动切换开关', async () => {
  const page = await openCourse('known-empty');
  await start({ autoNext: false });
  await waitFor(() => app.runner.state.status === 'done', '空章节停留本页');
  assert.ok(page.url().includes('chapterId=1'));
  await stop(); await start();
  await waitFor(() => page.url().includes('chapterId=2') && app.runner.state.status === 'playing', '空章节后继续播放');
  await stop();
});

test('空内容文字不能覆盖未知任务，普通页面的同名文字不能当作空章节', async () => {
  for (const scenario of ['empty-unknown', 'fake-empty']) {
    const page = await openCourse(scenario); await start();
    await waitFor(() => ['waiting', 'attention'].includes(app.runner.state.status), '未知内容仍停留');
    assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
    if (scenario === 'empty-unknown') assert.match(app.runner.state.detail, /讨论任务/);
    await stop();
  }
});

test('多选课程读取、排序、顺序处理，记录未适配课程后继续，暂停和重启保留队列', { timeout: 30000 }, async () => {
  await app.runner.dispatch({ type: 'list-courses' });
  assert.equal(app.runner.state.catalog.length, 3);
  await app.dashboard.locator('#courseSearch').fill('课程');
  await waitFor(() => app.dashboard.locator('.course-choice').count().then(n => n === 3), '课程列表');
  for (const choice of await app.dashboard.locator('.course-choice input').all()) await choice.check();
  await app.dashboard.locator('#saveQueue').click();
  await waitFor(() => app.runner.state.courses.length === 3, '多选加入队列');
  await app.dashboard.locator('#startQueue').click();
  await waitFor(() => app.runner.state.courses[2]?.status === 'running' && app.runner.state.status === 'playing', '接续第三门课', 20000);
  assert.deepEqual(app.runner.state.courses.map(c => c.status), ['done', 'attention', 'running']);
  assert.match(app.runner.state.courses[1].detail, /讨论任务/);
  assert.equal(app.runner.courseQueue.pages.has('queueB:1'), false);
  assert.equal(app.context.pages().some(p => p.url().includes('courseId=queueB')), false, '已停止课程不能留在后台发送会话请求');
  assert.ok(app.runner.state.courses[1].resumeURL.includes('courseId=queueB'));
  assert.equal(app.runner.state.queueRunning, true);
  await stop();
  const result = await app.dashboard.evaluate(() => window.__courseAssistantControl({ type: 'show-course', courseId: 'queueB:1' }));
  assert.equal(result.ok, true);
  assert.ok(app.runner.courseQueue.pages.get('queueB:1').url().includes('courseId=queueB'));
  assert.equal(app.runner.state.courses[2].status, 'paused');
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'preferences.json'), 'utf8'));
  assert.equal(saved.courses[2].status, 'paused');
  assert.ok(saved.courses[2].resumeURL.includes('courseId=queueC'));
  await app.runner.dispatch({ type: 'set-queue', courses: [app.runner.state.courses[2], app.runner.state.courses[0]] });
  assert.equal(app.runner.state.courses[0].title, '课程丙');
  await app.runner.dispatch({ type: 'start-queue', options: { rate: 1 } });
  await waitFor(() => app.runner.state.status === 'playing', '继续暂停课程');
  assert.ok(app.runner.activePage().url().includes('courseId=queueC'));
  await stop();
});

test('队列遇到身份验证暂停全部课程，保留后续课程等待处理', async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: [{ title: '验证课程', url: `${origin}/mycourse/studentstudy?courseId=blocked&clazzid=1` }, { title: '后续课程', url: `${origin}/mycourse/studentstudy?courseId=queueC&clazzid=1` }] });
  await app.runner.dispatch({ type: 'start-queue', options: { parallel: 1 } });
  await waitFor(() => app.runner.state.status === 'attention' && !app.runner.state.queueRunning, '队列等待身份验证');
  assert.equal(app.runner.state.enabled, false);
  assert.equal(app.runner.state.courses[0].status, 'attention');
  assert.equal(app.runner.state.courses[1].status, 'pending');
  await app.runner.dispatch({ type: 'stop' });
});

test('旧并行配置被忽略，课程逐门运行并在切换前关闭上一门页面', { timeout: 25000 }, async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: [] });
  await app.runner.dispatch({ type: 'set-queue', courses: ['queueA', 'queueC', 'queueD'].map((id, i) => ({ title: `并行课程${i + 1}`, url: `${origin}/mycourse/studentstudy?courseId=${id}&clazzid=1` })) });
  await app.runner.dispatch({ type: 'start-queue', options: { parallel: 3, rate: 1 } });
  await waitFor(() => app.runner.courseQueue.jobs.size === 1 && app.runner.courseQueue.jobs.get('queueA:1')?.runner.page, '只启动队列首课');
  assert.deepEqual(app.runner.state.courses.map(c => c.status), ['running', 'pending', 'pending']);
  const firstPage = app.runner.courseQueue.jobs.get('queueA:1').runner.page;
  await waitFor(() => app.runner.state.courses[1].status === 'running' && app.runner.courseQueue.jobs.get('queueC:1')?.ready && app.runner.courseQueue.pages.get('queueC:1')?.url().includes('courseId=queueC'), '首课结束后下一门课程完成导航');
  assert.equal(app.runner.courseQueue.jobs.size, 1);
  assert.equal(app.runner.state.courses[0].status, 'done');
  assert.equal(firstPage.isClosed(), true, '切换前关闭上一门课程页');
  assert.ok(app.runner.state.courses[0].resumeURL.includes('courseId=queueA'));
  assert.ok(app.runner.courseQueue.pages.get('queueC:1').url().includes('courseId=queueC'));
  await app.runner.dispatch({ type: 'stop' });
  assert.equal(app.runner.courseQueue.jobs.size, 0);
  assert.equal(app.runner.state.queueRunning, false);
});

test('跳回首页自动恢复一次并保留正确章节位置', async () => {
  await app.runner.dispatch({ type: 'stop' });
  await app.runner.dispatch({ type: 'set-queue', courses: [] });
  await app.runner.dispatch({ type: 'set-queue', courses: ['queueC', 'queueD'].map(id => ({ title: id, url: `${origin}/mycourse/studentstudy?courseId=${id}&clazzid=1` })) });
  await app.runner.dispatch({ type: 'start-queue', options: { parallel: 2 } });
  await waitFor(() => app.runner.courseQueue.jobs.size === 1 && app.runner.state.status === 'playing', '单门课程开始');
  const [first] = [...app.runner.courseQueue.jobs.values()];
  const page = first.runner.page;
  const resume = first.course.resumeURL;
  await page.goto('https://detect.chaoxing.com/api/monitor_temp', { waitUntil: 'domcontentloaded' });
  await waitFor(() => first.recovered && first.ready && first.runner.state.status === 'playing', '从入口自动恢复同一课程');
  assert.equal(first.runner.page, page);
  assert.equal(first.course.resumeURL, resume);
  await app.runner.dispatch({ type: 'stop' });
});

test('检测地址自动返回章节后继续播放，不保留错误的验证状态', async () => {
  const page = await openCourse('queueC');
  await app.runner.dispatch({ type: 'start', options: { muted: true } });
  await waitFor(() => app.runner.state.status === 'playing', '开始播放');
  await page.goto('https://detect.chaoxing.com/api/monitor_temp?return=1', { waitUntil: 'domcontentloaded' });
  await waitFor(() => page.url().includes('courseId=queueC') && app.runner.state.status === 'playing', '中间跳转后继续播放');
  assert.equal(app.runner.state.enabled, true);
  assert.doesNotMatch(app.runner.state.detail, /验证|安全检测/);
  await app.runner.dispatch({ type: 'stop' });
});

test('平台原生多终端提示保留原话并暂停队列，不自动重启', async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: [{ title: '课程丙', url: `${origin}/courselist/opencoursenewfy?courseId=queueC&clazzId=1` }, { title: '课程丁', url: `${origin}/courselist/opencoursenewfy?courseId=queueD&clazzId=1` }] });
  await app.runner.dispatch({ type: 'start-queue', options: { parallel: 3 } });
  await waitFor(() => app.runner.courseQueue.jobs.size === 1 && app.runner.state.status === 'playing', '逐门队列开始');
  const page = app.runner.activePage();
  const message = '您的账号在另一台浏览器设备登入章节页面。多终端登录可能会被判定异常学习。';
  await page.goto(`https://detect.chaoxing.com/api/monitor_temp?mes=${encodeURIComponent(message)}`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => app.runner.state.status === 'attention' && !app.runner.state.queueRunning, '多终端提示后暂停');
  assert.ok(app.runner.state.detail.includes(message));
  assert.deepEqual(app.runner.state.courses.map(c => c.status), ['attention', 'pending']);
  assert.equal(page.isClosed(), false, '保留提示页面供用户查看');
  assert.equal(app.runner.courseQueue.jobs.size, 0);
  const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'preferences.json'), 'utf8'));
  assert.equal('parallel' in saved, false);
  await app.runner.dispatch({ type: 'stop' });
});

test('单门模式仍收到多终端提示时显示平台原话并暂停，不反复重新进入课程', async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: [{ title: '课程丙', url: `${origin}/courselist/opencoursenewfy?courseId=queueC&clazzId=1` }] });
  await app.runner.dispatch({ type: 'start-queue' });
  await waitFor(() => app.runner.state.status === 'playing', '单门开始');
  const page = app.runner.activePage();
  const message = '您的账号在另一台浏览器设备登入章节页面。多终端登录可能会被判定异常学习。';
  await page.goto(`https://detect.chaoxing.com/api/monitor_temp?mes=${encodeURIComponent(message)}`, { waitUntil: 'domcontentloaded' });
  await waitFor(() => app.runner.state.status === 'attention' && !app.runner.state.queueRunning, '单门冲突暂停');
  assert.ok(app.runner.state.detail.includes(message));
  assert.match(app.runner.state.detail, /请按学习通提示处理/);
  assert.equal(app.runner.state.courses[0].status, 'attention');
  assert.equal(app.runner.courseQueue.jobs.size, 0);
  assert.equal(page.isClosed(), false);
  await app.runner.dispatch({ type: 'stop' });
});

test('课程打开期间触发多终端提示时保留原提示并暂停', { timeout: 30000 }, async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: [] });
  await app.runner.dispatch({ type: 'set-queue', courses: ['queueC', 'queueD'].map(id => ({ title: id, url: `${origin}/courselist/opencoursenewfy?courseId=${id}&clazzId=1` })) });
  launchConflict = true;
  await app.runner.dispatch({ type: 'start-queue', options: { parallel: 2 } });
  await waitFor(() => app.runner.state.status === 'attention' && !app.runner.state.queueRunning, '打开阶段提示后暂停', 22000);
  assert.match(app.runner.state.detail, /多终端登录可能会被判定异常学习/);
  assert.deepEqual(app.runner.state.courses.map(c => c.status), ['attention', 'pending']);
  await app.runner.dispatch({ type: 'stop' });
});

test('跳转页实际显示验证码时才暂停全部课程，保留页面供人工处理', async () => {
  await app.runner.dispatch({ type: 'set-queue', courses: ['queueC', 'queueD'].map(id => ({ title: id, url: `${origin}/mycourse/studentstudy?courseId=${id}&clazzid=1` })) });
  await app.runner.dispatch({ type: 'start-queue' });
  await waitFor(() => app.runner.courseQueue.jobs.size === 1 && [...app.runner.courseQueue.jobs.values()][0].runner.state.status === 'playing', '首门课程播放');
  const [first] = [...app.runner.courseQueue.jobs.values()];
  const page = first.runner.page;
  await page.goto('https://detect.chaoxing.com/api/monitor_temp?captcha=1', { waitUntil: 'domcontentloaded' });
  await waitFor(() => !app.runner.state.queueRunning && app.runner.state.status === 'attention', '可见验证码暂停全部课程');
  assert.match(app.runner.state.detail, /验证码/);
  assert.equal(page.isClosed(), false);
  assert.equal(app.runner.state.courses[1].status, 'pending');
  await app.runner.dispatch({ type: 'stop' });
});

test('按中国时区匹配当前学期，覆盖一月、二月和九月的学年边界', () => {
  assert.equal(academicTerm(new Date('2026-01-15T12:00:00Z')).code, '20251');
  assert.equal(academicTerm(new Date('2026-02-15T12:00:00Z')).code, '20252');
  assert.equal(academicTerm(new Date('2026-08-31T16:00:00Z')).code, '20261');
  assert.equal(matchCurrentTerm([{ id: 'x', title: '2026-2027学年第一学期' }], new Date('2026-10-19T00:00:00Z')).id, 'x');
  assert.equal(matchCurrentTerm([{ id: 'old', code: '20251', title: '2025-2026第一学期' }], new Date('2026-10-19T00:00:00Z')), undefined);
});

test('默认筛选当前学期，切换旧学期和全部，保留已加入队列的跨学期选择', { timeout: 20000 }, async () => {
  withTerms = true;
  const queued = app.runner.state.courses.map(c => c.id);
  await app.runner.dispatch({ type: 'list-courses', termFilter: 'auto' });
  assert.deepEqual(app.runner.state.catalog.map(c => c.id), ['queueA:1', 'queueC:1']);
  assert.equal(app.runner.state.selectedTerm, 'current');
  await waitFor(() => app.dashboard.locator('#termFilter').evaluate(s => s.options.length === 4), '学期选项');
  await app.dashboard.locator('#termFilter').selectOption('old');
  await waitFor(() => app.runner.state.termFilter === 'old', '旧学期筛选');
  assert.deepEqual(app.runner.state.catalog.map(c => c.id), ['queueB:1']);
  assert.deepEqual(app.runner.state.courses.map(c => c.id), queued);
  await app.dashboard.locator('#termFilter').selectOption('0');
  await waitFor(() => app.runner.state.termFilter === '0', '全部学期');
  assert.equal(app.runner.state.catalog.length, 3);
  withTerms = false;
  await app.runner.dispatch({ type: 'list-courses', termFilter: 'auto' });
  assert.equal(app.runner.state.selectedTerm, '0');
  assert.match(app.runner.state.termNotice, /没有匹配/);
});

test('浏览器登录资料和选项跨重启保留，重启后不自动开始', { timeout: 20000 }, async () => {
  await app.context.addCookies([{ name: 'test-login', value: 'saved', domain: '.chaoxing.com', path: '/', expires: Date.now() / 1000 + 3600, secure: true }]);
  await openCourse('persist'); await start({ rate: 1.25 }); await stop();
  const savedCourses = structuredClone(app.runner.state.courses);
  await app.close();
  app = await makeApp();
  const cookies = await app.context.cookies(origin);
  assert.equal(cookies.find(c => c.name === 'test-login')?.value, 'saved');
  assert.equal(app.runner.state.options.rate, 1.25);
  assert.match(app.runner.state.courseURL, /courseId=persist/);
  assert.equal(app.runner.state.enabled, false);
  assert.equal(app.runner.state.queueRunning, false);
  assert.deepEqual(app.runner.state.courses, savedCourses);
  assert.equal(app.runner.state.termFilter, 'auto');
  await app.dashboard.close();
  await app.closed;
  assert.equal(app.runner.closed, true);
});
