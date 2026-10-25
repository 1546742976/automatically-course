// Each course is a native WebContentsView in the assistant's single window.
class CourseView {
  constructor(context, runner, electronApp) {
    this.context = context;
    this.runner = runner;
    this.electronApp = electronApp;
    this.selected = null;
    this.ids = new WeakMap();
    this.inputs = Promise.resolve();
  }
  pages() { return this.context.pages().filter(p => p !== this.runner.dashboard && !p.isClosed() && p.url() !== 'about:blank'); }
  page() {
    const pages = this.pages();
    return pages.includes(this.selected) ? this.selected : pages.includes(this.runner.activePage()) ? this.runner.activePage() : pages.at(-1);
  }
  async id(page) {
    if (!this.ids.has(page)) {
      const client = await this.context.newCDPSession(page);
      try {
        const { targetInfo } = await client.send('Target.getTargetInfo');
        const id = await this.electronApp.evaluate(({ webContents }, target) => webContents.fromDevToolsTargetId(target)?.id, targetInfo.targetId);
        this.ids.set(page, String(id));
      } finally { await client.detach(); }
    }
    return this.ids.get(page);
  }
  async snapshot() {
    const popup = await this.electronApp.evaluate(() => globalThis.__courseShell.popupId);
    if (popup) for (const candidate of this.pages()) if (await this.id(candidate) === String(popup)) {
      this.selected = candidate;
      await this.electronApp.evaluate((_, id) => globalThis.__courseShell.clearPopup(id), popup);
      break;
    }
    const page = this.page();
    const tabs = await Promise.all(this.pages().map(async p => {
      const course = this.runner.state.courses.find(c => this.runner.courseQueue.pages.get(c.id) === p);
      return { id: await this.id(p), title: course?.title || await p.title().catch(() => '学习通') || '学习通' };
    }));
    const zoom = page ? await this.electronApp.evaluate(({ webContents }, id) => webContents.fromId(Number(id)).getZoomFactor(), await this.id(page)) : 1;
    return { tabs, zoom, selected: page ? await this.id(page) : null,
      address: page ? (() => { try { const u = new URL(page.url()); return u.hostname + u.pathname; } catch { return ''; } })() : '' };
  }
  async layout(bounds) {
    const page = this.page();
    if (!page) return;
    const rect = Object.fromEntries(['x', 'y', 'width', 'height'].map(k => [k, Math.max(0, Math.round(Number(bounds[k]) || 0))]));
    if (!rect.width || !rect.height) return;
    await this.electronApp.evaluate((_, { id, bounds }) => globalThis.__courseShell.show(id, bounds), { id: await this.id(page), bounds: rect });
  }
  async hide() { await this.electronApp.evaluate(() => globalThis.__courseShell.hide()); }
  input(event) {
    const job = this.inputs.catch(() => {}).then(async () => {
      if (event.kind === 'select') {
        for (const page of this.pages()) if (await this.id(page) === event.id) { this.selected = page; break; }
        return;
      }
      const page = this.page();
      if (!page) throw new Error('请先连接学习通。');
      if (event.kind === 'zoom') {
        await this.electronApp.evaluate(({ webContents }, { id, factor }) => webContents.fromId(Number(id)).setZoomFactor(factor), { id: await this.id(page), factor: [0.8, 1, 1.25, 1.5].includes(event.factor) ? event.factor : 1 });
      }
      else if (event.kind === 'back') await page.goBack({ waitUntil: 'domcontentloaded' });
      else if (event.kind === 'reload') await page.reload({ waitUntil: 'domcontentloaded' });
      else if (event.kind === 'course-home') {
        const course = this.runner.state.courses.find(c => this.runner.courseQueue.pages.get(c.id) === page);
        await page.goto(course?.url || 'https://i.chaoxing.com/', { waitUntil: 'domcontentloaded' });
      } else throw new Error('未知页面操作。');
    });
    this.inputs = job;
    return job;
  }
}
module.exports = { CourseView };
