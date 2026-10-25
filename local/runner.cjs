const fs = require('node:fs/promises');
const path = require('node:path');
const { installPlayerAgent } = require('./player-agent.js');
const { installTaskAgent } = require('./task-agent.js');
const { courseKey, readCatalog } = require('./catalog.cjs');
const { CourseQueue } = require('./course-queue.cjs');
const { loadDocumentImage } = require('./document-image.cjs');

function courseIdentity(raw) {
  try {
    const url = new URL(raw);
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)chaoxing\.com$/.test(url.hostname) || !/\/mycourse\/studentstudy/i.test(url.pathname)) return null;
    const p = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    return `${url.hostname}:${p.get('courseid') || ''}:${p.get('clazzid') || ''}`;
  } catch { return null; }
}
function normalizeOptions(input = {}) {
  const rate = Number(input.rate);
  return { rate: [1, 1.25, 1.5, 2].includes(rate) ? rate : 1,
    muted: typeof input.muted === 'boolean' ? input.muted : true,
    autoNext: typeof input.autoNext === 'boolean' ? input.autoNext : true };
}
function validateURL(raw) {
  if (!raw?.trim()) return 'https://i.chaoxing.com/';
  try {
    const url = new URL(raw.trim());
    if (!/^https?:$/.test(url.protocol) || !/(^|\.)chaoxing\.com$/.test(url.hostname) || url.username || url.password) throw new Error();
    return url.href;
  } catch { throw new Error('请输入学习通 chaoxing.com 域名下的完整网址。'); }
}
function time(seconds) {
  if (!Number.isFinite(seconds)) return '--:--';
  const v = Math.max(0, Math.floor(seconds));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}
async function agentCommand(frame, name, method, args, fallback) {
  try {
    // Some Chaoxing frames replace native Map. Playwright's object serializer
    // then fails inside refs.set/get, so send and return primitive JSON strings.
    const result = await frame.evaluate(async payload => {
      const { name, method, args, fallback } = JSON.parse(payload);
      const agent = globalThis[name];
      return JSON.stringify(agent ? (await agent[method](...args)) ?? fallback : null);
    }, JSON.stringify({ name, method, args, fallback }));
    return JSON.parse(result);
  } catch (error) {
    if (frame.isDetached() || /Execution context was destroyed|Cannot find context|Target.*closed|Frame was detached/.test(error.message)) return null;
    throw error;
  }
}
async function frameCommand(frame, method, ...args) {
  return agentCommand(frame, '__coursePlayerAgent', method, args, {});
}
async function taskCommand(frame, method, ...args) {
  return agentCommand(frame, '__courseTaskAgent', method, args, null);
}

class CourseRunner {
  constructor(context, { dataDir, preferences = {}, intervalMs = 1000, settleMs = 5000, ai } = {}) {
    this.context = context;
    this.dataDir = dataDir;
    this.intervalMs = intervalMs;
    this.settleMs = settleMs;
    this.ai = ai;
    this.exerciseJobs = new Map();
    this.state = { enabled: false, status: 'idle', detail: '先打开学习通并登录，进入章节任务页后点击开始。',
      options: normalizeOptions(preferences.options), courseURL: preferences.courseURL || '', title: '', currentTime: 0, duration: null,
      courses: (preferences.courses || []).map(c => ({ ...c,
        status: c.status === 'running' || c.detail?.startsWith('学习通将课程页转入安全检测') ? 'paused' : c.status,
        detail: c.detail?.startsWith('学习通将课程页转入安全检测') ? '上次课程页面发生跳转，点击继续队列重新检查当前页面。' : c.detail })),
      termFilter: preferences.termFilter || 'auto', terms: [], selectedTerm: '0', termNotice: '',
      queueRunning: false, queueNotice: preferences.queueNotice || '', catalog: [] };
    this.courseQueue = new CourseQueue(this);
    this.page = null;
    this.dashboard = null;
    this.scope = null;
    this.documents = new Map();
    this.active = null;
    this.nextAttempt = null;
    this.settleUntil = 0;
    this.queue = Promise.resolve();
    this.closed = false;
    this.generation = 0;
    this.attachedPages = new Map();
    this.onNewPage = page => this.attach(page);
    context.on('page', this.onNewPage);
    for (const page of context.pages()) this.attach(page);
  }
  attach(page) {
    const navigated = frame => {
      if (this.page !== page) return;
      if (frame === page.mainFrame()) {
        const url = new URL(frame.url());
        if (url.hostname === 'detect.chaoxing.com' && url.pathname === '/api/monitor_temp') {
          const message = url.searchParams.get('mes')?.trim();
          if (message) this.platformNotice = message;
        }
      }
      this.abort?.abort();
      this.generation++;
      this.nextAttempt = null;
      this.active = null;
      this.settleUntil = Date.now() + this.settleMs;
    };
    const closed = () => {
      if (this.page !== page) return;
      this.state.enabled = false;
      this.publish('paused', '课程标签页已关闭，请重新打开课程后开始。');
      this.page = null;
    };
    page.on('framenavigated', navigated); page.on('close', closed);
    this.attachedPages.set(page, { navigated, closed });
  }
  serialize(work) {
    const job = this.queue.catch(() => {}).then(work);
    this.queue = job;
    return job;
  }
  publish(status, detail, extra = {}) { Object.assign(this.state, { status, detail }, extra); }
  reportPlatformNotice() {
    if (!this.platformNotice) return false;
    this.publish('attention', `学习通提示：${this.platformNotice}`, {
      sessionConflict: /多终端|异地|其他设备|另一.*设备|重复登[录入]/.test(this.platformNotice), navigationIssue: false
    });
    return true;
  }
  activePage() { return this.courseQueue.activePage() || this.page; }
  snapshot() { return structuredClone({ ...this.state, ai: this.ai?.publicSettings(), activeURL: this.activePage()?.url() || '' }); }
  startPolling() {
    const poll = async () => {
      if (this.closed) return;
      try { await this.serialize(() => this.tick()); }
      catch (error) { this.publish('attention', `读取课程页面失败：${error.message}`); }
      if (!this.closed) this.timer = setTimeout(poll, this.intervalMs);
    };
    this.timer = setTimeout(poll, this.intervalMs);
  }
  async save() {
    if (!this.dataDir) return;
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.writeFile(path.join(this.dataDir, 'preferences.json'), JSON.stringify({ options: this.state.options, courseURL: this.state.courseURL, courses: this.state.courses, termFilter: this.state.termFilter, queueNotice: this.state.queueNotice }, null, 2), 'utf8');
  }
  async dispatch(command) {
    if (command.type === 'state') return this.snapshot();
    if (['stop', 'start', 'start-queue', 'open', 'save-ai'].includes(command.type)) this.abort?.abort();
    return this.serialize(async () => {
      if (command.type === 'open') await this.open(command.url);
      else if (command.type === 'start') await this.start(command.options);
      else if (command.type === 'stop') await this.stop();
      else if (command.type === 'save-ai') { await this.ai.save(command.ai); }
      else if (command.type === 'scan') await this.scan();
      else if (command.type === 'list-courses') {
        Object.assign(this.state, await readCatalog(this.context, { termFilter: command.termFilter || this.state.termFilter }));
        await this.save();
      }
      else if (command.type === 'set-queue') await this.setCourses(command.courses);
      else if (command.type === 'start-queue') await this.courseQueue.start(command.options);
      else if (command.type === 'show-course') {
        if (!this.activePage() || this.activePage().isClosed()) throw new Error('请先打开课程。');
      } else throw new Error('未知操作。');
      return this.snapshot();
    });
  }
  async open(raw) {
    const url = validateURL(raw);
    await this.stop();
    await this.courseQueue.clearPages();
    if (!this.page || this.page.isClosed()) this.page = await this.context.newPage();
    this.state.courseURL = raw?.trim() ? url : '';
    await this.save();
    this.publish('loading', '正在打开学习通，请在课程标签页登录并进入章节任务。');
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await this.page.bringToFront();
    this.publish('idle', '进入具体章节任务后，回到控制面板点击开始。');
  }
  async setCourses(courses) {
    if (this.state.enabled) throw new Error('请先暂停队列，再调整课程。');
    if (!Array.isArray(courses)) throw new Error('课程列表格式不正确。');
    const previous = new Map(this.state.courses.map(c => [c.id, c]));
    const selected = new Map();
    for (const c of courses) {
      const url = validateURL(c.url), id = courseKey(url);
      selected.set(id, { ...previous.get(id), id, url, title: String(c.title || '未命名课程').slice(0, 200), status: previous.get(id)?.status || 'pending' });
    }
    this.state.courses = [...selected.values()];
    await this.save();
  }
  async start(options, expectedCourseId) {
    if (this.closed) throw new Error('任务已停止。');
    if (!expectedCourseId) this.platformNotice = null;
    this.state.sessionConflict = false;
    const candidates = this.context.pages().filter(page => page !== this.dashboard && courseIdentity(page.url()));
    const selected = expectedCourseId ? candidates.find(page => page === this.page && courseKey(page.url()) === expectedCourseId)
      : this.page && candidates.includes(this.page) ? this.page : candidates.at(-1);
    if (expectedCourseId && !selected) throw new Error('未能进入所选课程的章节，请在助手内检查该课程。');
    if (!selected) throw new Error('请在助手打开的浏览器中登录学习通，进入具体的章节任务页，再点击开始。');
    if (this.page && this.page !== selected) await this.pauseFrames();
    this.page = selected;
    this.scope = courseIdentity(selected.url());
    this.state.options = normalizeOptions(options);
    this.state.courseURL = selected.url();
    await this.save();
    this.state.enabled = true;
    this.state.navigationIssue = false;
    this.documents.clear();
    this.exerciseJobs.clear();
    this.active = null;
    this.nextAttempt = null;
    this.settleUntil = Date.now() + this.settleMs;
    this.generation++;
    for (const frame of selected.frames()) {
      if (!this.supported(frame)) continue;
      try {
        await frame.evaluate(installPlayerAgent);
        await frame.evaluate(installTaskAgent);
        await frameCommand(frame, 'configure', true);
      } catch (error) {
        if (!frame.isDetached() && !/Execution context was destroyed|Cannot find context|Target.*closed|Frame was detached/.test(error.message)) throw error;
      }
    }
    this.publish('loading', '正在识别当前章节任务…');
  }
  supported(frame) {
    try { return /(^|\.)chaoxing\.com$/.test(new URL(frame.url()).hostname); }
    catch { return false; }
  }
  async pauseFrames() {
    if (!this.page || this.page.isClosed()) return;
    await Promise.all(this.page.frames().filter(frame => this.supported(frame)).map(frame => frameCommand(frame, 'configure', false)));
  }
  async stop() {
    this.abort?.abort();
    this.state.enabled = false;
    this.state.queueRunning = false;
    await this.courseQueue.stop();
    this.active = null;
    await this.pauseFrames();
    this.publish('paused', '助手已暂停，当前受控视频也已暂停。');
    await this.save();
  }
  async scan() {
    const page = this.context.pages().filter(p => p !== this.dashboard && courseIdentity(p.url())).at(-1);
    if (!page) throw new Error('请在助手浏览器里打开具体课程章节，然后点击扫描。');
    this.page = page;
    const tasks = [];
    for (const frame of page.frames().filter(f => this.supported(f))) {
      await frame.evaluate(installTaskAgent);
      const report = await taskCommand(frame, 'snapshot');
      if (!report) continue;
      tasks.push(...report.inventory.map(t => `${t.title}（${t.type}${t.done ? '，已完成' : ''}）`));
      if (report.exercise) tasks.push(`章节练习：${report.questions.length} 题${report.submitted ? '，已提交' : ''}`);
      if (report.reading) tasks.push(`${report.reading.title}（${report.reading.kind}）`);
    }
    this.state.tasks = [...new Set(tasks)];
    this.publish('idle', this.state.tasks.length ? `扫描到 ${this.state.tasks.length} 项任务，见下方任务列表。` : '当前章节没有识别到文档或练习，请展开具体任务页。');
  }
  async processTasks(reports, generation) {
    const tasks = [];
    for (const { frame } of reports) {
      const report = await taskCommand(frame, 'snapshot');
      if (report) tasks.push({ frame, ...report });
    }
    if (generation !== this.generation) return true;
    this.state.tasks = [...new Set(tasks.flatMap(t => t.inventory.map(a => `${a.title}（${a.type}${a.done ? '，已完成' : ''}）`)))];
    const unsupported = tasks.flatMap(t => t.inventory).find(a => !a.done && !['video', 'audio', 'document', 'workid', 'read', 'text'].includes(a.type));
    if (unsupported) { this.publish('attention', `待适配任务：${unsupported.title}（${unsupported.type}），请在课程页处理。`); return true; }
    for (const task of tasks) {
      if (task.reading?.delegated) {
        const readers = tasks.filter(candidate => {
          if (!candidate.reading || candidate.reading.delegated) return false;
          for (let parent = candidate.frame.parentFrame(); parent; parent = parent.parentFrame()) if (parent === task.frame) return true;
          return false;
        });
        if (!readers.length) {
          this.publish(Date.now() > this.settleUntil + 15000 ? 'attention' : 'loading', Date.now() > this.settleUntil + 15000 ? '嵌入文档尚未载入，或其阅读器尚未适配，请查看课程页。' : '等待嵌入文档阅读器载入…');
          return true;
        }
        continue;
      }
      if (task.reading && !task.reading.done) {
        const result = await taskCommand(task.frame, 'readStep');
        if (result?.retryImage) {
          const image = result.retryImage;
          const controller = new AbortController();
          this.abort = controller;
          this.publish('reading', `正在重新载入文档第 ${image.page} 页图片…`);
          try {
            const url = new URL(image.src);
            if (url.protocol !== 'https:' || url.hostname !== 's3.cldisk.com') throw new Error('此图片来源不支持分段读取。');
            const dataURL = await loadDocumentImage(this.context.request, image.src, controller.signal);
            if (controller.signal.aborted || generation !== this.generation || !this.state.enabled) return true;
            const restored = await taskCommand(task.frame, 'restoreImage', image.token, image.src, dataURL);
            if (!restored?.restored) throw new Error('文档页面已变化。');
          } catch {
            if (!controller.signal.aborted && generation === this.generation) this.publish('attention', `文档第 ${image.page} 页图片加载失败，请刷新文档后继续。`);
          } finally { if (this.abort === controller) this.abort = null; }
          return true;
        }
        const progress = task.reading.totalPages ? ` · 第 ${task.reading.currentPage} / ${task.reading.totalPages} 页` : '';
        this.publish(result?.error ? 'attention' : 'reading', result?.error || `正在阅读：${task.reading.title}${progress}`);
        return true;
      }
      if (!task.exercise || task.submitted) continue;
      if (!task.questions.length) {
        if (tasks.some(t => t !== task && (t.questions.length || t.submitted))) continue;
        this.publish('attention', '练习正在载入，或当前题目布局尚未适配，请查看课程页。'); return true;
      }
      const issue = task.questions.find(q => q.issue);
      if (issue) { this.publish('attention', `练习未自动提交：${issue.issue}（${issue.title.slice(0, 60)}）`); return true; }
      let job = this.exerciseJobs.get(task.documentId);
      if (job?.error) { this.publish('attention', job.error); return true; }
      if (!job) {
        job = {};
        this.exerciseJobs.set(task.documentId, job);
        this.abort = new AbortController();
        this.publish('solving', `DeepSeek 正在解答 ${task.questions.length} 道题…`);
        try {
          const images = [];
          if (task.questions.some(q => q.needsImage)) {
            if (!this.ai.settings.vision) throw new Error('题目含图片或特殊字体，请开启截图识题或手动处理。');
            const imageCount = task.questions.filter(q => q.needsImage).length;
            this.publish('solving', `正在截图识题 · 已采集 0/${imageCount} 道题…`);
            await task.frame.evaluate(() => document.fonts.ready);
            const nodes = task.frame.locator('.TiMu, .questionLi, .question-item[data-question-id]').filter({ visible: true });
            for (let i = 0; i < task.questions.length; i++) {
              if (this.abort.signal.aborted || generation !== this.generation) return true;
              if (!task.questions[i].needsImage) continue;
              const data = await nodes.nth(i).screenshot({ type: 'png', timeout: 10000 });
              if (this.abort.signal.aborted || generation !== this.generation) return true;
              images.push({ id: task.questions[i].id, url: `data:image/png;base64,${data.toString('base64')}` });
              this.publish('solving', `正在截图识题 · 已采集 ${images.length}/${imageCount} 道题…`);
            }
          }
          const answers = await this.ai.solve(task.questions, this.abort.signal, images, progress => {
            if (!this.state.enabled || generation !== this.generation) return;
            this.publish('solving', `DeepSeek ${progress.retry ? '正在补答未解决题目' : '正在分批解题'} · 已取得 ${progress.answered}/${progress.total} 题答案…`);
          });
          if (generation !== this.generation || this.abort.signal.aborted || !this.state.enabled) return true;
          const current = await Promise.all(reports.map(({ frame }) => frameCommand(frame, 'snapshot')));
          if (current.some(r => r?.blocker)) throw new Error('课程出现验证提示，请处理后重新开始。');
          const result = await taskCommand(task.frame, 'fill', task.questions, answers);
          if (!result?.filled) throw new Error(result?.error || '题目页面已变化，未提交。');
          if (generation !== this.generation || this.abort.signal.aborted || !this.state.enabled) return true;
          job.submitting = true;
          const submitted = await taskCommand(task.frame, 'submit');
          if (submitted?.error) throw new Error(submitted.error);
        } catch (error) {
          if (this.abort.signal.aborted) return true;
          job.error = error.message;
          this.publish('attention', job.error);
          return true;
        }
      }
      // The exercise may ask top.workPop to show its confirmation in an ancestor.
      // Inspect only that exercise's ancestors, never a sibling course/task.
      for (let parent = task.frame.parentFrame(); parent; parent = parent.parentFrame()) {
        const result = await taskCommand(parent, 'confirmSubmit', { externalId: task.documentId });
        if (result?.error) { job.error = result.error; break; }
      }
      const result = job.error ? null : await taskCommand(task.frame, 'confirmSubmit');
      if (result?.error) job.error = result.error;
      this.publish(job.error ? 'attention' : 'submitting', job.error || '答案已填写，正在确认网页提交结果…');
      return true;
    }
    const attachments = tasks.flatMap(t => t.inventory).filter(a => !a.done);
    if (attachments.some(a => a.type === 'workid') && !tasks.some(t => t.exercise)
      || attachments.some(a => ['document', 'read', 'text'].includes(a.type)) && !tasks.some(t => t.reading)) {
      this.publish('attention', '章节包含尚未展开或未适配的文档／练习，请在课程页打开该任务。');
      return true;
    }
    const expectedExercises = attachments.filter(a => a.type === 'workid').length;
    const loadedExercises = tasks.filter(t => t.questions.length || t.submitted).length;
    const expectedDocuments = attachments.filter(a => ['document', 'read', 'text'].includes(a.type)).length;
    const expectedMedia = attachments.filter(a => ['video', 'audio'].includes(a.type)).length;
    if (expectedExercises > loadedExercises || expectedDocuments > tasks.filter(t => t.reading).length
      || expectedMedia > reports.reduce((sum, r) => sum + (r.report?.media.length || 0), 0)) {
      this.publish('attention', '章节任务数量与已载入内容不一致，请展开剩余任务；暂不切换章节。');
      return true;
    }
    return false;
  }
  async tick() {
    if (!this.state.queueRunning) return this.tickCurrent();
    return this.courseQueue.tick();
  }
  async tickCurrent() {
    if (!this.state.enabled || !this.page || this.page.isClosed()) return;
    if (this.platformNotice) {
      await this.stop();
      this.reportPlatformNotice();
      return;
    }
    const generation = this.generation;
    const frames = this.page.frames().filter(frame => this.supported(frame));
    const reports = await Promise.all(frames.map(async frame => ({ frame, report: await frameCommand(frame, 'snapshot') })));
    if (generation !== this.generation || !this.state.enabled) return;
    const blocked = reports.find(item => item.report?.blocker);
    if (blocked) {
      await Promise.all(frames.map(frame => frameCommand(frame, 'pause', true)));
      this.active = null;
      return this.publish('attention', blocked.report.blocker);
    }
    if (courseIdentity(this.page.url()) !== this.scope) {
      // Intermediate redirects can return to the chapter without any challenge.
      // Only visible page controls are evidence that manual verification is needed.
      if (Date.now() < this.settleUntil) return this.publish('loading', '课程页面正在跳转，等待章节载入。');
      await this.stop();
      const url = new URL(this.page.url());
      const portal = /(^|\.)chaoxing\.com$/.test(url.hostname) && (/\/space\/index/.test(url.pathname) || url.hostname === 'i.chaoxing.com');
      this.publish('attention', /passport|login/i.test(this.page.url()) ? '课程已进入登录页，请在助手内重新登录后继续。'
        : portal ? '课程页面已跳转到学习通首页，尚未返回章节。请重新进入课程后继续。'
          : url.hostname === 'detect.chaoxing.com' ? '课程页面停留在跳转中间页，未能载入章节。请重新进入课程后继续。'
            : '已离开当前课程。进入需要播放的课程后，点击开始。',
        { navigationIssue: !/passport|login/i.test(this.page.url()) && (portal || url.hostname === 'detect.chaoxing.com') });
      return;
    }
    for (const { frame, report } of reports) {
      if (!report) continue;
      const key = `${report.documentId}|${report.pageKey}`;
      if (this.documents.get(frame) !== key) {
        this.documents.set(frame, key);
        this.nextAttempt = null;
        this.settleUntil = Date.now() + this.settleMs;
        await frameCommand(frame, 'configure', true);
      }
    }
    for (const frame of this.documents.keys()) if (!frames.includes(frame)) this.documents.delete(frame);
    const chapter = await taskCommand(this.page.mainFrame(), 'snapshot');
    if (chapter?.chapterCompleted) {
      await Promise.all(frames.map(frame => frameCommand(frame, 'pause', true)));
      this.active = null;
      return this.advanceChapter(frames, generation, true);
    }
    const media = reports.flatMap(({ frame, report }) => (report?.media || []).map(video => ({ ...video, frame })));
    const pending = media.filter(video => !video.ended);
    if (pending.length) {
      const target = pending.find(video => this.active?.frame === video.frame && this.active.id === video.id) || pending[0];
      this.active = { frame: target.frame, id: target.id };
      for (const { frame, report } of reports) {
        if (frame !== target.frame && report?.media.some(video => !video.paused && !video.ended)) await frameCommand(frame, 'pause', true);
      }
      const result = await frameCommand(target.frame, 'play', target.id, this.state.options);
      if (generation !== this.generation) return;
      if (result?.activate) {
        await target.frame.locator(`[data-course-assistant-play="${result.activate}"]`).click({ timeout: 5000 });
        return this.publish('loading', '已点击网页播放按钮，等待播放器初始化。');
      }
      if (!result || result.waiting) return this.publish('loading', '视频正在载入或缓冲，等待播放。');
      if (result.error) return this.publish('attention', result.error);
      this.settleUntil = Date.now() + this.settleMs;
      return this.publish('playing', `${target.title || '课程视频'} · ${time(target.currentTime)} / ${time(target.duration)}`, { title: target.title, currentTime: target.currentTime, duration: target.duration });
    }
    this.active = null;
    if (reports.some(({ report }) => !report || !report.ready || report.waitingMedia) || Date.now() < this.settleUntil) return this.publish('loading', '等待页面与视频任务载入。');
    if (await this.processTasks(reports, generation)) return;
    const taskReports = await Promise.all(frames.map(frame => taskCommand(frame, 'snapshot')));
    const hasTasks = taskReports.some(t => t?.reading || t?.exercise);
    if (!media.length && !hasTasks && !taskReports.some(t => t?.empty)) return this.publish('waiting', '当前页没有识别到可处理任务。请打开具体章节任务；未知任务不会跳过。');
    return this.advanceChapter(frames, generation);
  }
  async advanceChapter(frames, generation, completed = false) {
    const detail = completed ? '学习通已标记当前章节完成' : '本页任务已处理';
    if (!this.state.options.autoNext) return this.publish('done', `${detail}，自动切换章节已关闭。`);
    if (this.nextAttempt) return this.publish(Date.now() - this.nextAttempt > 15000 ? 'attention' : 'loading', Date.now() - this.nextAttempt > 15000 ? '已点击下一节，但页面未切换。请检查章节是否锁定，或手动切换。' : '视频已结束，正在等待下一节。');
    for (const frame of frames) {
      const result = await frameCommand(frame, 'next');
      if (result?.blocked) return this.publish('attention', result.blocked);
      if (result?.clicked || generation !== this.generation) {
        if (generation === this.generation) this.nextAttempt = Date.now();
        this.settleUntil = Date.now() + this.settleMs;
        return this.publish('loading', `${detail}，正在切换下一节。`);
      }
    }
    this.publish('done', `${detail}，未找到下一节按钮。任务完成状态请以课程页面为准。`);
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    await this.serialize(() => this.stop());
    this.context.off('page', this.onNewPage);
    for (const [page, events] of this.attachedPages) {
      page.off('framenavigated', events.navigated); page.off('close', events.closed);
    }
    this.attachedPages.clear();
  }
}
module.exports = { CourseRunner, courseIdentity, normalizeOptions, validateURL };
