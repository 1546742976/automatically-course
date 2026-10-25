const { openCourseChapter, isCourseChapter } = require('./catalog.cjs');

class CourseQueue {
  constructor(owner) { this.owner = owner; this.jobs = new Map(); this.pages = new Map(); }
  async closeInactivePages(page) {
    const running = [...this.jobs.values()].filter(job => job.course.status === 'running').map(job => job.runner.page);
    for (const other of this.owner.context.pages()) {
      if (other === page || other === this.owner.dashboard || running.includes(other) || other.isClosed()) continue;
      try {
        const url = new URL(other.url());
        if (/(^|\.)chaoxing\.com$/.test(url.hostname)) {
          for (const [id, saved] of this.pages) if (saved === other) {
            const course = this.owner.state.courses.find(c => c.id === id);
            if (course && isCourseChapter(other.url(), id)) course.resumeURL = other.url();
            this.pages.delete(id);
          }
          await other.close();
        }
      } catch (error) { if (!other.isClosed()) throw error; }
    }
  }
  activePage() {
    return [...this.jobs.values()].find(j => j.runner.page && !j.runner.page.isClosed())?.runner.page
      || this.owner.state.courses.filter(c => c.status === 'attention').map(c => this.pages.get(c.id)).find(p => p && !p.isClosed())
      || [...this.pages.values()].find(p => !p.isClosed());
  }
  async start(options) {
    const owner = this.owner, state = owner.state;
    if (!state.courses.length) throw new Error('请至少勾选一门课程并加入队列。');
    await owner.stop();
    state.queueNotice = '';
    state.options = { rate: [1, 1.25, 1.5, 2].includes(Number(options?.rate)) ? Number(options.rate) : 1,
      muted: options?.muted ?? true, autoNext: true };
    for (const course of state.courses) if (course.status !== 'done') { course.status = 'pending'; course.detail = '等待安排处理。'; }
    state.queueRunning = true; state.enabled = true;
    owner.publish('loading', '正在安排课程队列…', { currentTime: 0, duration: null, tasks: [] });
    await this.fill();
  }
  async fill() {
    const { owner } = this;
    let changed = false;
    while (owner.state.queueRunning && this.jobs.size < 1) {
      const course = owner.state.courses.find(c => c.status === 'pending');
      if (!course) break;
      course.status = 'running'; course.detail = '正在打开课程…';
      const runner = new owner.constructor(owner.context, { intervalMs: owner.intervalMs, settleMs: owner.settleMs, ai: owner.ai });
      const job = { course, runner, ready: false, cancelled: false };
      this.jobs.set(course.id, job);
      job.launch = this.launch(job);
      changed = true;
    }
    if (changed) await owner.save();
  }
  async launch(job) {
    const { owner } = this, { course, runner } = job;
    try {
      const savedPage = this.pages.get(course.id);
      const page = savedPage && !savedPage.isClosed() ? savedPage : await owner.context.newPage();
      runner.page = page;
      if (job.cancelled) { await page.close(); return; }
      this.pages.set(course.id, page);
      await this.closeInactivePages(page);
      runner.platformNotice = null;
      await openCourseChapter(page, course);
      if (/passport|login/i.test(page.url())) throw new Error('登录已失效，请在助手内重新登录。');
      if (job.cancelled) return;
      await runner.start(owner.state.options, course.id);
      if (job.cancelled) { await runner.stop(); return; }
      course.resumeURL = page.url();
      job.persistNeeded = true;
      job.ready = true;
      if (!runner.timer) runner.startPolling();
    } catch (error) {
      if (!job.cancelled) {
        if (!runner.reportPlatformNotice()) job.error = error.message;
        job.ready = true;
      }
    }
  }
  async tick() {
    const { owner } = this, state = owner.state;
    let dirty = false;
    for (const [id, job] of this.jobs) {
      if (!job.ready) continue;
      if (job.persistNeeded) { dirty = true; job.persistNeeded = false; }
      const { runner, course } = job;
      const report = runner.snapshot();
      if (runner.page && isCourseChapter(runner.page.url(), course.id) && course.resumeURL !== runner.page.url()) {
        course.resumeURL = runner.page.url(); dirty = true;
      }
      course.detail = job.error || report.detail;
      if (!job.error && report.sessionConflict) {
        course.status = 'attention';
        const detail = `${course.title}：${course.detail}`;
        await owner.stop();
        course.status = 'attention';
        course.detail = detail;
        owner.publish('attention', `${detail}。队列已暂停，请按学习通提示处理后再继续。`);
        await owner.save();
        return;
      }
      if (!job.error && report.navigationIssue && !job.recovered) {
        job.recovered = true; job.ready = false;
        course.detail = '页面跳回首页，正在从课程入口恢复章节…';
        await runner.stop();
        job.launch = this.launch(job);
        dirty = true;
        continue;
      }
      if (!job.error && !['done', 'attention', 'waiting', 'paused'].includes(report.status)) continue;
      course.status = !job.error && report.status === 'done' ? 'done' : 'attention';
      if (/验证码|人脸|身份验证|登录|验证提示|安全检测|平台验证/.test(course.detail)) {
        const detail = `${course.title}：${course.detail}`;
        await owner.stop(); owner.publish('attention', detail); return;
      }
      await runner.close();
      if (course.status === 'done') {
        if (runner.page && !runner.page.isClosed()) await runner.page.close();
        this.pages.delete(id);
      }
      this.jobs.delete(id); dirty = true;
    }
    if (dirty) await owner.save();
    await this.fill();
    if (!this.jobs.size) {
      state.enabled = false; state.queueRunning = false;
      const needsHelp = state.courses.some(c => c.status === 'attention');
      owner.publish(needsHelp ? 'attention' : 'done', needsHelp ? '本轮队列已结束，部分课程需要处理，原因见课程安排。处理后可继续队列。' : '所选课程的已识别任务均已处理。完成情况以学习通记录为准。');
      await owner.save(); return;
    }
    const reports = [...this.jobs.values()].filter(j => j.ready && !j.error);
    const primary = reports[0]?.runner.snapshot();
    owner.publish(primary?.status || 'loading', `${primary ? `${primary.title}处理中 · ${primary.detail}` : '正在载入章节…'}`,
      { enabled: true, title: primary?.title || '', currentTime: primary?.currentTime || 0, duration: primary?.duration || null,
        tasks: reports.flatMap(j => (j.runner.state.tasks || []).map(t => `${j.course.title}：${t}`)) });
  }
  async stop() {
    const jobs = [...this.jobs.values()];
    for (const job of jobs) { job.cancelled = true; job.runner.abort?.abort(); }
    await Promise.all(jobs.map(async job => {
      const page = job.runner.page;
      if (page && !page.isClosed() && isCourseChapter(page.url(), job.course.id)) job.course.resumeURL = page.url();
      if (job.course.status === 'running') job.course.status = 'paused';
      if (!job.ready && page && !page.isClosed()) { await page.close(); this.pages.delete(job.course.id); }
      await job.runner.close();
      await job.launch;
    }));
    this.jobs.clear();
  }
  async clearPages() {
    await Promise.all([...this.pages.values()].filter(p => !p.isClosed()).map(p => p.close()));
    this.pages.clear();
  }
}
module.exports = { CourseQueue };
