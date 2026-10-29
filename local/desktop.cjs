const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

if (process.argv.includes('--assistant-shell')) {
  require('./electron-shell.cjs');
} else {
  const root = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..');
  const dataDir = path.join(root, '.local-data');
  let assistant, closing = false;
  function report(error) {
    const message = `学习通助手启动失败：${error.message}\n\n请将完整文件夹解压到可写位置后重试。\n日志：${path.join(dataDir, 'startup.log')}`;
    try { fs.appendFileSync(path.join(dataDir, 'startup.log'), `${new Date().toISOString()} ${error.stack || error}\n`); } catch {}
    dialog.showErrorBox('学习通助手', message);
  }
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const temporaryDir = path.join(dataDir, 'tmp');
    fs.mkdirSync(temporaryDir, { recursive: true });
    process.env.TEMP = process.env.TMP = temporaryDir;
    app.setPath('temp', temporaryDir);
    const probe = path.join(dataDir, `.write-test-${process.pid}`);
    fs.writeFileSync(probe, ''); fs.unlinkSync(probe);
    app.setPath('userData', path.join(dataDir, 'launcher-profile'));
  } catch (error) { report(error); app.exit(1); }
  app.on('before-quit', event => {
    if (assistant && !closing) {
      event.preventDefault(); closing = true;
      assistant.close().catch(report).finally(() => app.quit());
    }
  });
  app.whenReady().then(async () => {
    const { createApp } = require('./main.cjs');
    assistant = await createApp({ dataDir, electronExecutablePath: process.execPath,
      electronArgs: app.isPackaged ? ['--assistant-shell'] : [path.join(__dirname, 'desktop.cjs'), '--assistant-shell'] });
    fs.appendFileSync(path.join(dataDir, 'startup.log'), `${new Date().toISOString()} 控制面板已就绪\n`);
    await assistant.closed;
    closing = true; app.quit();
  }).catch(error => { report(error); app.exit(1); });
}
