const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createApp } = require('../local/main.cjs');
const { validateAnswers } = require('../local/ai.cjs');
const { loadDocumentImage } = require('../local/document-image.cjs');

let app, dataDir, server, endpoint, mode = 'valid', requests = [];
let imageRanges = [];
const documentImage = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(150000, 7)]);
const origin = 'https://mooc1.chaoxing.com';
const question = (title, body) => `<div class="TiMu"><div class="Zy_TItle"><div class="clearfix">${title}</div></div><ul>${body}</ul></div>`;
const option = (key, label, type = 'radio', name = 'q') => `<li><label><input type="${type}" name="${name}" value="${key}">${label}</label></li>`;
const exercise = question('【单选题】2+2=?', option('A', '3') + option('B', '4'))
  + question('【多选题】哪些是偶数', option('A', '2', 'checkbox', 'm') + option('B', '3', 'checkbox', 'm') + option('C', '4', 'checkbox', 'm'))
  + question('【判断题】太阳是恒星', option('true', '正确', 'radio', 'j') + option('false', '错误', 'radio', 'j'))
  + question('【填空题】中国首都、法国首都', '<input type="text"><input type="text">')
  + question('【简答题】写一个学习建议', '<textarea></textarea>');
function html(body) { return `<!doctype html><meta charset="utf-8"><title>章节任务测试</title>${body}`; }
async function waitFor(fn, timeout = 12000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await fn()) return; await new Promise(r => setTimeout(r, 60)); }
  throw new Error(JSON.stringify(app.runner.snapshot()));
}
async function open(scenario) {
  await app.runner.dispatch({ type: 'open', url: `${origin}/mycourse/studentstudy?courseId=${scenario}&clazzid=1` });
  return app.runner.page;
}
async function start() { await app.runner.dispatch({ type: 'start', options: { autoNext: true } }); }
before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.url === '/doc-image' || req.url === '/bad-image-range') {
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': documentImage.length }); res.end(); return; }
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) { res.writeHead(200, { 'Content-Length': documentImage.length }); res.end(documentImage.subarray(0, 1000)); return; }
      const start = Number(range[1]), end = Number(range[2]);
      imageRanges.push([start, end]);
      res.writeHead(206, { 'Content-Type': 'image/png', 'Content-Range': req.url === '/bad-image-range' ? 'bytes 0-1/2' : `bytes ${start}-${end}/${documentImage.length}` });
      res.end(documentImage.subarray(start, end + 1)); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), qs = JSON.parse(Array.isArray(body.messages[1].content) ? body.messages[1].content[0].text : body.messages[1].content);
    requests.push({ body, key: req.headers.authorization });
    if (mode === 'hang') return;
    const answer = [['B'], ['A', 'C'], ['true'], ['北京', '巴黎'], ['每天复习']];
    const result = { answers: qs.map((q, i) => ({ id: q.id, answer: mode === 'invalid' && i === 0 ? ['Z']
      : ['uncertain', 'retry'].includes(mode) && q.id.endsWith(':2') && (mode === 'uncertain' || requests.length === 1) ? null
      : answer[Number(q.id.split(':').at(-1))] })) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${server.address().port}`;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'course-tasks-test-'));
  app = await createApp({ dataDir, headless: true, intervalMs: 80, settleMs: 100, prepareContext: async context => {
    await context.route('https://**.chaoxing.com/**', route => {
      const url = new URL(route.request().url()), scenario = url.searchParams.get('courseId');
      if (url.pathname === '/ananas/modules/pdf/index.html') return route.fulfill({ contentType: 'text/html', body: html(`<div class="imglook"><iframe id="panView" style="width:700px;height:300px" src="https://pan-yz.chaoxing.com/screen/v2/file_fixture?mode=${url.searchParams.get('mode') || 'pages'}"></iframe></div>`) });
      if (url.pathname === '/screen/v2/file_fixture') {
        const image = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        const pages = url.searchParams.get('mode') === 'empty' ? '' : [1, 2, 3].map(i => `<li id="anchor${i}"><img width="600" height="450" src="${image}"><span class="pageNum">${i}</span></li>`).join('');
        return route.fulfill({ contentType: 'text/html', body: html(`<style>body{margin:0}.fileBox ul{list-style:none;padding:0;margin:0}.fileBox li{height:475px}img{display:block}</style><div class="fileBox"><ul>${pages}</ul></div>`) });
      }
      if (url.pathname === '/broken.png') return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      if (url.pathname === '/exercise' && url.searchParams.has('popup')) {
        const popup = url.searchParams.get('popup');
        const message = popup === 'incomplete' ? '您还有未做完的 判断题，确认提交吗？' : popup === 'grade' ? '很遗憾，未达到及格线，请重做' : '确认提交？';
        return route.fulfill({ contentType: 'text/html', body: html(exercise + `<button id="submitWork" onclick="window.submits=(window.submits||0)+1;top.workPop('${message}')">提交</button><div id="workStatus"></div>`) });
      }
      if (url.pathname === '/exercise') return route.fulfill({ contentType: 'text/html', body: html(exercise + `<button id="submitWork" onclick="window.submits=(window.submits||0)+1;document.querySelector('#tipContent').hidden=false">提交</button>
        <div id="tipContent" hidden>确认提交作业？<button class="bluebtn" onclick="document.body.dataset.answers=JSON.stringify([...document.querySelectorAll('input,textarea')].map(e=>e.type==='radio'||e.type==='checkbox'?e.checked:e.value));document.querySelector('#tipContent').hidden=true;document.querySelector('#workStatus').textContent='提交成功';window.confirmations=(window.confirmations||0)+1">确定</button></div><div id="workStatus"></div>`) });
      if (url.pathname === '/work/doHomeWorkNew') return route.fulfill({ contentType: 'text/html', body: html(`<iframe src="/exercise${url.search}" style="width:800px;height:800px"></iframe>`) });
      if (['custom', 'custom-dx', 'custom-dx-unsaved'].includes(scenario)) {
        let custom = exercise.replaceAll(/<li><label><input type="(radio|checkbox)" name="([^"]+)" value="([^"]+)">([^<]+)<\/label><\/li>/g,
          (_, type, name, key, label) => `<li role="${type}" onclick="let n=this.querySelector('.num_option');if('${type}'==='radio')for(const el of this.parentElement.querySelectorAll('.num_option')){if(el!==n)el.classList.remove('check_answer')}n.classList.toggle('check_answer');this.closest('.TiMu').querySelector('input[type=hidden]').value=[...this.parentElement.querySelectorAll('.check_answer')].map(e=>e.getAttribute('data')).join('')" qid="${name}"><span class="num_option" data="${key}">${key}</span><a>${label}</a></li>`)
          .replaceAll(/<div class="TiMu">([\s\S]*?)<\/ul>/g, (whole, inside) => { const qid = inside.match(/qid="([^"]+)"/)?.[1]; return whole + (qid ? `<input type="hidden" id="answer${qid}">` : ''); });
        if (scenario !== 'custom') {
          custom = custom.replace(/<li role="checkbox"[\s\S]*?<\/li>/g, li => {
            let dx = li.replaceAll('num_option', 'num_option_dx').replaceAll('check_answer', 'check_answer_dx');
            if (scenario === 'custom-dx-unsaved') dx = dx.replace("this.closest('.TiMu').querySelector('input[type=hidden]').value=", 'window.unsavedAnswer=');
            return dx.replace('class="num_option_dx" data="B"', 'class="num_option_dx check_answer_dx" data="B"');
          }).replace('<input type="hidden" id="answerm">', '<input type="hidden" id="answerm" value="B">');
        }
        return route.fulfill({ contentType: 'text/html', body: html(custom.replace('【单选题】', '<span class="font-cxsecret">【单选题】</span>') + '<button id="submitWork" onclick="window.submits=(window.submits||0)+1;document.querySelector(\'#workStatus\').textContent=\'提交成功\'">提交</button><div id="workStatus"></div>') });
      }
      const next = '<button id="nextChapter" onclick="window.nextClicks=(window.nextClicks||0)+1">下一节</button>';
      if (scenario?.startsWith('completed-')) {
        const chapter = url.searchParams.get('chapterId') || '1';
        const marker = '<span class="icon_Completed"><span hidden>已完成</span></span>';
        const currentMarker = ['completed-other', 'completed-text'].includes(scenario) ? '' : marker;
        const currentId = scenario === 'completed-stale' ? 'old' : chapter;
        const pending = scenario === 'completed-pending' ? '<input type="hidden" class="jobUnfinishCount" value="1">' : '';
        const content = scenario === 'completed-unknown' || scenario === 'completed-delayed' ? '<p>思考题：自行思考</p>'
          : `<iframe style="width:900px;height:900px" src="/work/doHomeWorkNew"></iframe>`;
        const delayed = scenario === 'completed-delayed' ? `<script>setTimeout(()=>document.querySelector('.posCatalog_active').insertAdjacentHTML('beforeend', ${JSON.stringify(marker)}),350)</script>` : '';
        return route.fulfill({ contentType: 'text/html', body: html(`<div class="posCatalog_select" id="curother">${marker}</div><div class="posCatalog_select posCatalog_active" id="cur${currentId}">${scenario === 'completed-delayed' ? '' : currentMarker}${pending}<span>${scenario === 'completed-text' ? '未完成' : '当前章节'}</span></div>${content}${delayed}${next}`) });
      }
      if (scenario?.startsWith('top-')) {
        const popup = scenario.replace('top-', '');
        return route.fulfill({ contentType: 'text/html', body: html(`<script>window.mArg={attachments:[{type:'workid',property:{name:'章节测验'}}]};function workPop(message){document.querySelector('#popcontent').textContent=message;document.querySelector('#workpop').hidden=false;}</script>
          <div id="workpop" hidden><div class="popDiv"><p id="popcontent"></p><div class="popBottom"><a id="popok" role="button" onclick="window.confirmations=(window.confirmations||0)+1;document.querySelector('#workpop').hidden=true;">提交</a><a id="popno">取消</a></div></div></div>
          <div hidden><p id="tipContent">未达到及格线，请重做</p></div>
          <iframe style="width:900px;height:900px" src="/work/doHomeWorkNew?popup=${popup}"></iframe>${next}`) });
      }
      if (scenario === 'cloud-document' || scenario === 'cloud-empty') return route.fulfill({ contentType: 'text/html', body: html(`<script>window.mArg={attachments:[{type:'document',property:{name:'教材文档'}}]}</script><iframe style="width:800px;height:400px" src="/ananas/modules/pdf/index.html?mode=${scenario === 'cloud-empty' ? 'empty' : 'pages'}"></iframe>${next}`) });
      if (scenario === 'unknown') return route.fulfill({ contentType: 'text/html', body: html(`<script>window.mArg={attachments:[{type:'discuss',property:{name:'讨论任务'}}]}</script>${next}`) });
      if (scenario === 'document') return route.fulfill({ contentType: 'text/html', body: html(`<div class="imglook"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"><button class="mkeRbtn" onclick="window.pages=(window.pages||1)+1;this.style.visibility='hidden'">下一页</button></div>${next}`) });
      return route.fulfill({ contentType: 'text/html', body: html(`<script>window.mArg={attachments:[{type:'workid',property:{name:'章节练习'}}]}</script><iframe style="width:900px;height:900px" src="/work/doHomeWorkNew"></iframe>${next}`) });
    });
  } });
  await app.runner.dispatch({ type: 'save-ai', ai: { baseURL: endpoint, model: 'deepseek-flash', apiKey: 'test-secret' } });
});
after(async () => {
  await app?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server?.close(resolve));
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

test('严格检查 AI 答案：空值、缺题、无效选项和填空数量不会提交', () => {
  const q = [{ id: '1', type: 'single', options: [{ key: 'A' }], slots: 0 }];
  for (const answers of [[], [{ id: '1', answer: null }], [{ id: '1', answer: ['Z'] }], [{ id: '1', answer: ['A', 'A'] }]]) assert.throws(() => validateAnswers(q, { answers }));
  assert.throws(() => validateAnswers([{ id: '2', type: 'blank', slots: 2 }], { answers: [{ id: '2', answer: ['北京'] }] }));
});
test('扫描嵌套章节练习，调用 Flash 填写五种题型、确认提交后才切换，密钥不出现在状态中', async () => {
  mode = 'valid'; requests = [];
  const page = await open('exercise');
  await app.runner.dispatch({ type: 'scan' });
  assert.match(app.runner.state.tasks.join(' '), /章节练习/);
  await start();
  await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
  const frame = page.frames().find(f => f.url().endsWith('/exercise'));
  const actual = await frame.evaluate(() => ({ answers: JSON.parse(document.body.dataset.answers), submits, confirmations }));
  assert.deepEqual(actual.answers, [false, true, true, false, true, true, false, '北京', '巴黎', '每天复习']);
  assert.equal(actual.submits, 1); assert.equal(actual.confirmations, 1);
  assert.equal(requests.length, 1); assert.equal(requests[0].body.model, 'deepseek-flash');
  assert.equal(requests[0].key, 'Bearer test-secret');
  assert.equal(JSON.stringify(app.runner.snapshot()).includes('test-secret'), false);
  await app.runner.dispatch({ type: 'stop' });
});

test('测验在外层章节弹出 workPop 时确认一次，收到提交成功后才切换，兼容网页覆盖 Map', async () => {
  mode = 'valid'; requests = [];
  const page = await open('top-confirm');
  await page.frameLocator('iframe').frameLocator('iframe').locator('#submitWork').waitFor();
  for (const f of page.frames()) await f.evaluate(() => { window.Map = function LegacyMap() {}; });
  const frame = page.frames().find(f => /\/exercise\?/.test(f.url()));
  // An unrelated visible prompt is never confirmed while no submission is active.
  await page.evaluate(() => window.workPop('确认提交？'));
  const idle = JSON.parse(await page.evaluate(() => JSON.stringify(window.__courseTaskAgent.confirmSubmit())));
  assert.equal(idle.waiting, true);
  assert.equal(await page.evaluate(() => window.confirmations || 0), 0);
  await page.evaluate(() => { document.querySelector('#workpop').hidden = true; });
  await start();
  await waitFor(async () => await page.evaluate(() => window.confirmations === 1));
  assert.equal(app.runner.state.status, 'submitting');
  assert.equal(requests.length, 1);
  assert.equal(await frame.evaluate(() => window.submits), 1);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await new Promise(r => setTimeout(r, 350));
  assert.equal(await page.evaluate(() => window.confirmations), 1);
  await frame.evaluate(() => { document.querySelector('#workStatus').textContent = '提交成功'; });
  await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
  await app.runner.dispatch({ type: 'stop' });
});

test('外层确认框提示未答完或未及格时显示平台原话，不点确认、不重复答题或跳转', async () => {
  mode = 'valid';
  for (const scenario of ['incomplete', 'grade']) {
    requests = [];
    const page = await open(`top-${scenario}`); await start();
    await waitFor(() => app.runner.state.status === 'attention');
    assert.match(app.runner.state.detail, scenario === 'incomplete' ? /未做完/ : /未达到及格线/);
    assert.equal(await page.evaluate(() => window.confirmations || 0), 0);
    assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
    assert.equal(requests.length, 1);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(requests.length, 1);
    await app.runner.dispatch({ type: 'stop' });
  }
});
test('AI 无效答案停留当前章节，不填写、不提交、不反复请求', async () => {
  mode = 'invalid'; requests = [];
  const page = await open('invalid'); await start();
  await waitFor(() => app.runner.state.status === 'attention');
  assert.match(app.runner.state.detail, /无效选项/);
  const frame = page.frames().find(f => f.url().endsWith('/exercise'));
  assert.equal(await frame.evaluate(() => window.submits || 0), 0);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await new Promise(r => setTimeout(r, 400)); assert.equal(requests.length, 1);
  await app.runner.dispatch({ type: 'stop' });
});

test('当前章节明确完成时不解题、不填写或提交，直接下一节；尊重自动切换开关', async () => {
  for (const scenario of ['completed-exercise', 'completed-unknown', 'completed-delayed']) {
    mode = 'valid'; requests = [];
    const page = await open(scenario);
    await page.goto(page.url() + '&chapterId=1');
    await start();
    await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
    assert.equal(requests.length, 0);
    const exerciseFrame = page.frames().find(f => f.url().endsWith('/exercise'));
    if (exerciseFrame) {
      assert.equal(await exerciseFrame.evaluate(() => window.submits || 0), 0);
      assert.equal(await exerciseFrame.locator('input:checked').count(), 0);
    }
    await app.runner.dispatch({ type: 'stop' });
  }
  const page = await open('completed-unknown'); await page.goto(page.url() + '&chapterId=1');
  await app.runner.dispatch({ type: 'start', options: { autoNext: false } });
  app.runner.settleUntil = Date.now() + 60000;
  await waitFor(() => app.runner.state.status === 'done');
  assert.match(app.runner.state.detail, /学习通已标记当前章节完成.*自动切换章节已关闭/);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await app.runner.dispatch({ type: 'stop' });
});

test('其他章节完成、章节标记过期、未完成文字或仍有待完成任务都不跳过当前练习', async () => {
  for (const scenario of ['completed-other', 'completed-stale', 'completed-text', 'completed-pending']) {
    mode = 'invalid'; requests = [];
    const page = await open(scenario); await page.goto(page.url() + '&chapterId=1'); await start();
    await waitFor(() => app.runner.state.status === 'attention');
    assert.match(app.runner.state.detail, /无效选项/);
    assert.equal(requests.length, 1);
    assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
    await app.runner.dispatch({ type: 'stop' });
  }
});

test('真实多选样式 num_option_dx 可识别、取消旧选项、保存隐藏答案并提交一次', async () => {
  mode = 'valid'; requests = [];
  const page = await open('custom-dx');
  const before = JSON.parse(await page.evaluate(() => JSON.stringify(globalThis.__courseTaskAgent.snapshot())));
  assert.equal(before.questions[1].issue, null);
  assert.deepEqual(before.questions[1].options.map(o => o.key), ['A', 'B', 'C']);
  assert.equal(await page.locator('.num_option_dx.check_answer_dx').textContent(), 'B');
  await start();
  await waitFor(async () => await page.evaluate(() => window.submits === 1));
  assert.deepEqual(await page.locator('.num_option_dx.check_answer_dx').allTextContents(), ['A', 'C']);
  assert.equal(await page.locator('#answerm').inputValue(), 'AC');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(requests.length, 1);
  await app.runner.dispatch({ type: 'stop' });
});

test('多选样式变更后仍校验隐藏答案，网页未保存时不提交', async () => {
  mode = 'valid'; requests = [];
  const page = await open('custom-dx-unsaved'); await start();
  await waitFor(() => app.runner.state.status === 'attention');
  assert.match(app.runner.state.detail, /网页未保存所选选项/);
  assert.equal(await page.locator('#answerm').inputValue(), 'B');
  assert.equal(await page.evaluate(() => window.submits || 0), 0);
  assert.equal(requests.length, 1);
  await app.runner.dispatch({ type: 'stop' });
});

test('缺题仅补答未解决题目，补齐后只填写并提交一次', async () => {
  mode = 'retry'; requests = [];
  const page = await open('retry'); await start();
  await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
  assert.equal(requests.length, 2);
  const retry = JSON.parse(requests[1].body.messages[1].content);
  assert.equal(retry.length, 1);
  assert.ok(retry[0].id.endsWith(':2'));
  const frame = page.frames().find(f => f.url().endsWith('/exercise'));
  assert.equal(await frame.evaluate(() => window.submits), 1);
  assert.equal(await frame.evaluate(() => window.confirmations), 1);
  await app.runner.dispatch({ type: 'stop' });
});

test('补答仍不确定时显示题号，整份练习保持未填写且未提交', async () => {
  mode = 'uncertain'; requests = [];
  const page = await open('uncertain'); await start();
  await waitFor(() => app.runner.state.status === 'attention');
  assert.match(app.runner.state.detail, /第 3 题.*4\/5/);
  const frame = page.frames().find(f => f.url().endsWith('/exercise'));
  assert.equal(await frame.evaluate(() => window.submits || 0), 0);
  assert.equal(await frame.locator('input:checked').count(), 0);
  assert.equal(await frame.locator('input[type=text],textarea').evaluateAll(nodes => nodes.every(n => !n.value)), true);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(requests.length, 2);
  await app.runner.dispatch({ type: 'stop' });
});

test('网页覆盖 Map 后嵌套练习仍可扫描、填写和确认提交', async () => {
  mode = 'valid'; requests = [];
  const page = await open('legacy-map');
  await page.frameLocator('iframe').frameLocator('iframe').locator('#submitWork').waitFor();
  for (const frame of page.frames()) {
    await frame.evaluate(() => { window.Map = function LegacyMap() {}; });
    await assert.rejects(frame.evaluate(x => x, { probe: true }), /refs\.set is not a function/);
  }
  await app.runner.dispatch({ type: 'scan' });
  assert.match(app.runner.state.tasks.join(' '), /章节练习/);
  await start();
  await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
  const frame = page.frames().find(f => f.url().endsWith('/exercise'));
  const actual = JSON.parse(await frame.evaluate(() => JSON.stringify({ answers: JSON.parse(document.body.dataset.answers), submits, confirmations })));
  assert.deepEqual(actual.answers, [false, true, true, false, true, true, false, '北京', '巴黎', '每天复习']);
  assert.equal(actual.submits, 1); assert.equal(actual.confirmations, 1);
  assert.equal(requests.length, 1);
  assert.equal(await frame.evaluate(() => typeof Map.prototype.set), 'undefined');
  await app.runner.dispatch({ type: 'stop' });
});
test('暂停可中断等待中的 AI 请求，不会在暂停后填写或提交', async () => {
  mode = 'hang'; requests = [];
  const page = await open('cancel'); await start();
  await waitFor(() => requests.length === 1);
  const at = Date.now();
  await app.runner.dispatch({ type: 'stop' });
  assert.ok(Date.now() - at < 3000);
  const frame = page.frames().find(f => f.url().endsWith('/exercise'));
  assert.equal(await frame.evaluate(() => window.submits || 0), 0);
  assert.equal(app.runner.state.enabled, false);
});
test('文档逐页阅读后才允许下一节；未知任务显示名称并停留', async () => {
  const page = await open('document'); await start();
  await waitFor(() => app.runner.state.status === 'reading');
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await page.evaluate(() => window.__courseTaskAgent.readStep(Date.now() + 6000));
  assert.equal(await page.evaluate(() => window.pages), 2);
  await page.evaluate(() => window.__courseTaskAgent.readStep(Date.now() + 12000));
  await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
  await app.runner.dispatch({ type: 'stop' });
  await open('unknown'); await start();
  await waitFor(() => app.runner.state.status === 'attention');
  assert.match(app.runner.state.detail, /讨论任务/);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await app.runner.dispatch({ type: 'stop' });
});

test('嵌套云盘教材逐屏滚动，显示页码，末页阅读完毕后才切换章节', async () => {
  const page = await open('cloud-document'); await start();
  await waitFor(() => app.runner.state.status === 'reading' && /1 \/ 3 页/.test(app.runner.state.detail));
  const frame = page.frames().find(f => f.url().includes('/screen/v2/file_fixture'));
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  const at = Date.now();
  let done = false;
  for (let i = 1; i <= 14; i++) {
    const result = JSON.parse(await frame.evaluate(now => JSON.stringify(globalThis.__courseTaskAgent.readStep(now)), at + i * 6000));
    assert.equal(result.error, undefined);
    if (result.done) { done = true; break; }
    assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  }
  assert.equal(done, true);
  assert.equal(await frame.evaluate(() => document.scrollingElement.scrollTop > 0), true);
  await waitFor(async () => await page.evaluate(() => window.nextClicks === 1));
  await app.runner.dispatch({ type: 'stop' });
});

test('云盘文档未载入或页面图片损坏时不标记完成，不跳过章节', async () => {
  const page = await open('cloud-empty'); await start();
  await waitFor(() => app.runner.state.status === 'reading');
  const frame = page.frames().find(f => f.url().includes('/screen/v2/file_fixture'));
  const at = Date.now();
  const empty = JSON.parse(await frame.evaluate(now => JSON.stringify(globalThis.__courseTaskAgent.readStep(now)), at + 6000));
  assert.equal(empty.waiting, true);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  await frame.evaluate(() => { document.querySelector('.fileBox ul').innerHTML = '<li id="anchor1"><img width="600" height="450" src="/broken.png"></li>'; });
  await waitFor(() => frame.locator('img').evaluate(img => img.complete));
  const retry = JSON.parse(await frame.evaluate(now => JSON.stringify(globalThis.__courseTaskAgent.readStep(now)), at + 12000));
  assert.equal(retry.retryImage.page, 1);
  await waitFor(() => frame.locator('img').evaluate(img => img.complete));
  const failed = JSON.parse(await frame.evaluate(now => JSON.stringify(globalThis.__courseTaskAgent.readStep(now)), at + 18000));
  assert.match(failed.error, /第 1 页图片加载失败/);
  assert.equal(await frame.evaluate(() => globalThis.__courseTaskAgent.snapshot().reading.done), false);
  assert.equal(await page.evaluate(() => window.nextClicks || 0), 0);
  const restored = JSON.parse(await frame.evaluate(payload => {
    const { token, src } = JSON.parse(payload);
    return JSON.stringify(globalThis.__courseTaskAgent.restoreImage(token, src, 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'));
  }, JSON.stringify(retry.retryImage)));
  assert.equal(restored.restored, true);
  await waitFor(() => frame.locator('img').evaluate(img => img.complete && img.naturalWidth > 0));
  const resumed = JSON.parse(await frame.evaluate(now => JSON.stringify(globalThis.__courseTaskAgent.readStep(now)), at + 24000));
  assert.equal(resumed.error, undefined);
  await app.runner.dispatch({ type: 'stop' });
});

test('图片完整响应被截断时按原资源分段读取并检查长度，不接受错误分段', async () => {
  imageRanges = [];
  const data = await loadDocumentImage(app.context.request, `${endpoint}/doc-image`);
  assert.deepEqual(Buffer.from(data.split(',')[1], 'base64'), documentImage);
  assert.deepEqual(imageRanges, [[0, 65535], [65536, 131071], [131072, documentImage.length - 1]]);
  await assert.rejects(loadDocumentImage(app.context.request, `${endpoint}/bad-image-range`), /分段响应不完整/);
});
test('真实页面采用的自定义选项会同步隐藏答案字段，特殊字体题会发送截图', async () => {
  mode = 'valid'; requests = [];
  const page = await open('custom'); await start();
  await waitFor(async () => await page.evaluate(() => window.submits === 1));
  assert.equal(requests.length, 1);
  assert.ok(requests[0].body.messages[1].content.some(c => c.type === 'image_url' && c.image_url.url.startsWith('data:image/png;base64,')));
  assert.equal(await page.locator('.TiMu').nth(0).locator('input#answerq').inputValue(), 'B');
  assert.equal(await page.locator('.TiMu').nth(1).locator('input#answerm').inputValue(), 'AC');
  assert.equal(await page.locator('.TiMu').nth(2).locator('input#answerj').inputValue(), 'true');
  await app.runner.dispatch({ type: 'stop' });
});
