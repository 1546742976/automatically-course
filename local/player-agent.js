// Installed in course frames by Playwright. No browser extension is needed.
function installPlayerAgent() {
  if (!/(^|\.)chaoxing\.com$/.test(location.hostname) || globalThis.__coursePlayerAgent) return;
  const documentId = crypto.randomUUID();
  let enabled = false, controlled = null, sequence = 0;
  const identities = new WeakMap(), progress = new WeakMap(), original = new WeakMap();
  const started = new WeakSet();
  function visible(el) {
    if (!el?.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function videos() {
    return [...document.querySelectorAll('video, audio')].filter(v => visible(v)
      || v.tagName === 'AUDIO' && /\/ananas\/modules\/audio\//.test(location.pathname)
        && Boolean(v.getAttribute('src')?.trim() || v.querySelector('source[src]')?.getAttribute('src')?.trim()));
  }
  function identity(video) {
    const source = video.currentSrc || video.src || video.querySelector('source')?.src || '';
    if (identities.get(video)?.source !== source) identities.set(video, { source, id: `${documentId}:${++sequence}` });
    return identities.get(video).id;
  }
  function blocker() {
    if ([...document.querySelectorAll('#captcha, #captchaBox, .yidun_popup, .nc-container, .verify-code, iframe[src*="captcha"]')].some(visible)) return '页面需要验证码，请手动完成后继续。';
    const dialog = [...document.querySelectorAll('[role="dialog"], .layui-layer-dialog, .vjs-modal-dialog')]
      .find(el => visible(el) && /答题|作答|人脸|登录|身份验证/.test(el.textContent));
    return dialog ? '页面需要人工操作，请处理播放器提示、题目或登录验证。' : null;
  }
  function snapshot() {
    const active = document.querySelector('.posCatalog_active, .posCatalog_select, div.ncells .currents');
    const list = videos();
    return {
      documentId, pageKey: `${location.href}|${active?.id || ''}|${active?.textContent?.trim().slice(0, 120) || ''}`,
      ready: document.readyState === 'complete', waitingMedia: /\/ananas\/modules\/(video|audio)\//.test(location.pathname) && !list.length,
      blocker: blocker(), media: list.map(v => ({ id: identity(v), ended: v.ended, paused: v.paused,
        currentTime: v.currentTime, duration: Number.isFinite(v.duration) ? v.duration : null,
        title: v.getAttribute('title') || document.title.replace(/超星|学习通/g, '').trim().slice(0, 60) }))
    };
  }
  function pause(all = false) {
    if (all) for (const v of videos()) if (!v.paused) v.pause();
    if (controlled?.isConnected && !controlled.ended) controlled.pause();
    if (controlled && original.has(controlled)) {
      const saved = original.get(controlled);
      controlled.muted = saved.muted;
      controlled.playbackRate = saved.rate;
      original.delete(controlled);
    }
    controlled = null;
  }
  function configure(value) {
    enabled = value;
    if (controlled) progress.delete(controlled);
    if (!enabled) pause();
  }
  async function play(id, options) {
    if (!enabled) return { error: '助手已暂停。' };
    const blocked = blocker();
    if (blocked) { pause(); return { error: blocked }; }
    const video = videos().find(v => identity(v) === id);
    if (!video) return { waiting: true };
    if (video.ended) return {};
    if (controlled && controlled !== video) pause();
    controlled = video;
    if (!original.has(video)) original.set(video, { muted: video.muted, rate: video.playbackRate });
    for (const other of videos()) if (other !== video && !other.paused) other.pause();
    video.muted = options.muted;
    video.playbackRate = options.rate;
    // Chaoxing initializes signed media sources through the player control.
    const startButton = video.closest('.video-js')?.querySelector('.vjs-big-play-button');
    if (!started.has(video) && video.paused && visible(startButton)) {
      started.add(video);
      startButton.dataset.courseAssistantPlay = identity(video);
      return { activate: identity(video), waiting: true };
    }
    if (video.error) return { error: `视频加载失败（${video.error.code}），请检查网络或刷新课程页。` };
    const prior = progress.get(video);
    if (!prior || prior.time !== video.currentTime) progress.set(video, { time: video.currentTime, at: Date.now() });
    else if (Date.now() - prior.at > 45000) return { error: '视频超过 45 秒没有进展，请检查缓冲或播放器内的提示。' };
    try {
      if (video.paused) {
        let timeout;
        try { await Promise.race([video.play(), new Promise(resolve => { timeout = setTimeout(resolve, 3000); })]); }
        finally { clearTimeout(timeout); }
      }
      return video.readyState < 2 ? { waiting: true } : {};
    } catch (error) {
      return { error: error.name === 'NotAllowedError' ? '浏览器阻止了自动播放。请在课程页手动点一次播放，或选择静音后重新开始。' : `播放未能开始：${error.message}` };
    }
  }
  function next() {
    if (!enabled) return {};
    const blocked = blocker();
    if (blocked) return { blocked };
    let candidate;
    for (const selector of ['#prevNextFocusNext', '.prev_next.next', '#nextChapter', '[data-action="next-chapter"]', 'span.currents ~ span']) {
      candidate = [...document.querySelectorAll(selector)].find(visible);
      if (candidate) break;
    }
    candidate ||= [...document.querySelectorAll('button, a, [role="button"]')].find(el => visible(el) && /^(下一节|下一章节|下一个任务|下一任务|下一章)$/.test(el.textContent.trim()));
    if (!candidate) {
      const chapters = [...document.querySelectorAll('div.ncells > *')];
      const current = chapters.findIndex(el => el.classList.contains('currents'));
      if (current >= 0) {
        const following = chapters.slice(current + 1).find(el => el.querySelector('a'));
        if (following?.querySelector('.lock, .locked')) return { blocked: '下一章节尚未解锁，请检查当前任务要求。' };
        candidate = following?.querySelector('a > span, a');
      }
    }
    if (!candidate) return {};
    if (candidate.closest('[disabled], [aria-disabled="true"], .disabled, .lock, .locked') || candidate.matches('.prev_next.no')) return { blocked: '下一章节按钮不可用，可能尚未解锁。' };
    candidate.click();
    return { clicked: true };
  }
  globalThis.__coursePlayerAgent = { snapshot, configure, play, pause, next };
}
module.exports = { installPlayerAgent };
