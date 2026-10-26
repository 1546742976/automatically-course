const { app, BrowserWindow, WebContentsView, session } = require('electron');

// An explicit executablePath (cached runtime or packaged EXE) skips Playwright's
// automatic loader. Preserve the same ready handshake and Chromium switches,
// including background rendering needed by screenshots of embedded task pages.
if (!globalThis.__playwright_run) {
  const path = require('node:path');
  require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/server/electron/loader.js'));
}

app.setPath('userData', process.env.COURSE_ASSISTANT_DATA);
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 1280, height: 900, minWidth: 800, minHeight: 600,
    show: process.env.COURSE_ASSISTANT_HIDDEN !== '1',
    title: '学习通 · 本地课程助手', backgroundColor: '#f5f5ef', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:assistant', contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
  });
  window.setMenu(null);
  const views = new Map();
  const backgroundBounds = { x: -20000, y: 0, width: 1200, height: 850 };
  let selected = null, popupId = null, bounds = { x: 0, y: 100, width: 1200, height: 750 };
  function hide() {
    if (selected && !selected.webContents.isDestroyed()) {
      window.contentView.removeChildView(selected);
      window.contentView.addChildView(selected, 0);
      selected.setBounds(backgroundBounds);
    }
    selected = null;
    window.webContents.focus();
  }
  function show(id, nextBounds) {
    const view = views.get(Number(id));
    if (!view || view.webContents.isDestroyed()) return;
    if (nextBounds) bounds = nextBounds;
    if (selected !== view) {
      hide(); selected = view;
      window.contentView.removeChildView(view); window.contentView.addChildView(view);
      view.webContents.focus();
    }
    view.setBounds(bounds);
    view.setVisible(true);
  }
  function createView(options = {}) {
    // Electron supplies the popup's existing WebContents. Adopt it so opener,
    // navigation and lifecycle stay connected to the view we return.
    const view = new WebContentsView({ ...(options.webContents ? { webContents: options.webContents } : {}), webPreferences: {
      ...options.webPreferences,
      partition: 'persist:learning', contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false
    } });
    const contents = view.webContents;
    views.set(contents.id, view);
    view.setBounds(backgroundBounds);
    // BrowserWindow's dashboard is not in contentView.children. Index zero
    // still covers it, so park background tabs outside the visible area.
    // Keeping them attached retains animation frames for player controls.
    window.contentView.addChildView(view, 0);
    contents.setWindowOpenHandler(() => ({ action: 'allow', createWindow: options => {
      const child = createView(options); popupId = child.webContents.id; return child.webContents;
    } }));
    contents.on('destroyed', () => { views.delete(contents.id); if (selected === view) selected = null; });
    contents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && selected === view) {
        hide();
        window.webContents.executeJavaScript('document.getElementById("courseDialog")?.close()').catch(() => {});
      }
    });
    return view;
  }
  globalThis.__courseShell = {
    window, views, show, hide,
    get popupId() { return popupId; },
    clearPopup(id) { if (popupId === Number(id)) popupId = null; },
    async createPage(marker) { const view = createView(); await view.webContents.loadURL(marker); return view.webContents.id; },
    async flush() { await session.fromPartition('persist:learning').cookies.flushStore(); },
    async importCookies(cookies) {
      const store = session.fromPartition('persist:learning').cookies;
      for (const c of cookies) {
        const item = { url: `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
          name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly,
          sameSite: ({ Strict: 'strict', Lax: 'lax', None: 'no_restriction' })[c.sameSite] || 'unspecified' };
        if (c.domain.startsWith('.')) item.domain = c.domain;
        if (c.expires > 0) item.expirationDate = c.expires;
        await store.set(item);
      }
      await store.flushStore();
    }
  };
  window.on('closed', () => app.quit());
  window.loadURL('about:blank');
});
