function courseKey(raw) {
  const url = new URL(raw);
  const params = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
  const course = params.get('courseid'), clazz = params.get('clazzid');
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)chaoxing\.com$/.test(url.hostname) || !course || !clazz) throw new Error('请选择有效的学习通课程。');
  return `${course}:${clazz}`;
}
function academicTerm(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric' }).formatToParts(now).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
  const first = parts.month >= 9 || parts.month === 1;
  const start = parts.month >= 9 ? parts.year : parts.year - 1;
  return { code: `${start}${first ? 1 : 2}`, title: `${start}-${start + 1}第${first ? '一' : '二'}学期` };
}
function matchCurrentTerm(terms, now) {
  const target = academicTerm(now);
  return terms.find(t => t.code === target.code) || terms.find(t => t.title.replace(/\s|学年/g, '').replace(/第1/g, '第一').replace(/第2/g, '第二') === target.title);
}
async function readCatalog(context, { termFilter = 'auto', now } = {}) {
  const page = await context.newPage();
  try {
    await page.goto('https://i.chaoxing.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      const courses = new Map();
      let catalogFrame;
      for (const frame of page.frames()) {
        if (!/(^|\.)chaoxing\.com$/.test(new URL(frame.url() || 'about:blank').hostname)) continue;
        const items = await frame.locator('a[href*="opencoursenewfy"], a[href*="/mycourse/studentstudy"]').evaluateAll(links => links.map(a => ({
          title: a.innerText.trim(), url: a.href,
          closed: /本课程已结课/.test(a.closest('li, .course, .course-item')?.textContent || '')
        })).filter(c => c.title && c.title !== '本课程已结课')).catch(() => []);
        if (items.length) catalogFrame = frame;
        for (const course of items) {
          try { const id = courseKey(course.url); courses.set(id, { ...course, id }); } catch {}
        }
      }
      if (courses.size) {
        const frame = catalogFrame;
        const terms = await frame.locator('ul[name="xq"] li[value]').evaluateAll(els => els.map(el => ({ id: el.getAttribute('value'), title: el.textContent.trim(), code: el.getAttribute('semesternum') })).filter(t => t.id !== '0'));
        const current = matchCurrentTerm(terms, now);
        const selected = termFilter === 'auto' ? current : terms.find(t => t.id === termFilter);
        if (termFilter !== 'auto' && termFilter !== '0' && !selected) throw new Error('该学期已不可用，请切换到自动匹配或全部学期。');
        if (selected) {
          const menu = frame.locator('.xqselect').filter({ has: frame.locator('ul[name="xq"]') });
          await menu.locator('.selectEn_name').click();
          const index = terms.findIndex(t => t.id === selected.id);
          const response = page.waitForResponse(r => r.request().frame() === frame && /\/courselist\/getStudyCourse/.test(new URL(r.url()).pathname), { timeout: 15000 });
          try {
            await frame.locator('ul[name="xq"] li[value]').filter({ hasNotText: /^全部$/ }).nth(index).click();
            const loaded = await response; await loaded.finished();
            if (!loaded.ok()) throw new Error('学期课程列表加载失败，请重试。');
            await frame.waitForFunction(() => typeof window.jQuery !== 'function' || window.jQuery.active === 0, null, { timeout: 10000 });
          } catch (error) { await response.catch(() => {}); throw error; }
          courses.clear();
          const items = await frame.locator('a[href*="opencoursenewfy"], a[href*="/mycourse/studentstudy"]').evaluateAll(links => links.map(a => ({ title: a.innerText.trim(), url: a.href, closed: /本课程已结课/.test(a.closest('li, .course, .course-item')?.textContent || '') })).filter(c => c.title && c.title !== '本课程已结课'));
          for (const c of items) { try { const id = courseKey(c.url); courses.set(id, { ...c, id }); } catch {} }
        }
        return { catalog: [...courses.values()], terms, termFilter, selectedTerm: selected?.id || '0', currentTerm: current?.title || academicTerm(now).title,
          termNotice: termFilter === 'auto' ? selected ? `已自动匹配：${selected.title}` : '没有匹配到当前学期，暂显示全部课程，可手动选择。' : selected ? `当前显示：${selected.title}` : '当前显示全部学期的课程。' };
      }
      if (/passport|login/i.test(page.url())) throw new Error('请先在助手内登录学习通，再刷新课程列表。');
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error('尚未读到课程列表，请在助手内完成登录后重试。');
  } finally { await page.close(); }
}
function isCourseChapter(raw, id) {
  try { return /\/mycourse\/studentstudy/i.test(new URL(raw).pathname) && courseKey(raw) === id; }
  catch { return false; }
}
async function openCourseChapter(page, course) {
  if (isCourseChapter(page.url(), course.id)) return;
  const resume = isCourseChapter(course.resumeURL, course.id) ? new URL(course.resumeURL) : null;
  const chapterId = resume && [...resume.searchParams].find(([key]) => /^(chapterid|knowledgeid)$/i.test(key))?.[1];
  // Catalog entry creates fresh navigation parameters; saved chapter URLs can expire.
  let entry = course.url;
  if (isCourseChapter(entry, course.id) && resume) entry = resume.href;
  await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 30000 });
  if (/passport|login/i.test(page.url())) throw new Error('登录已失效，请在助手内重新登录。');
  await enterFirstChapter(page, { chapterId });
  if (!isCourseChapter(page.url(), course.id)) throw new Error('未能进入所选课程的章节，请在助手内检查该课程。');
}
async function enterFirstChapter(page, { chapterId } = {}) {
  if (/\/mycourse\/studentstudy/i.test(new URL(page.url()).pathname)) return;
  const chapterTab = page.getByText('章节', { exact: true }).first();
  await chapterTab.waitFor({ timeout: 15000 });
  await chapterTab.click();
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    if (page.isClosed()) throw new Error('课程页面已关闭。');
    for (const frame of page.frames()) {
      if (!/studentcourse|mycourse\/stu/.test(frame.url())) continue;
      const chapters = frame.locator('.chapter_item[id][onclick*="toOld"], a[href*="/mycourse/studentstudy"]');
      if (!await chapters.count()) continue;
      const pending = chapters.filter({ has: frame.locator('.catalog_points_yi') });
      const savedIndex = chapterId ? await chapters.evaluateAll((elements, id) => elements.findIndex(el => {
        if (el.id === id || el.id === `cur${id}`) return true;
        try { return [...new URL(el.href).searchParams].some(([key, value]) => /^(chapterid|knowledgeid)$/i.test(key) && value === id); }
        catch { return false; }
      }), chapterId) : -1;
      const target = savedIndex >= 0 ? chapters.nth(savedIndex) : await pending.count() ? pending.first() : chapters.first();
      const name = target.locator('.clicktitle').first();
      await (await name.count() ? name : target).click();
      await page.waitForURL(url => /\/mycourse\/studentstudy/i.test(url.pathname), { timeout: 15000 });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('没有找到可打开的课程章节，请在助手内检查课程目录。');
}
module.exports = { courseKey, readCatalog, enterFirstChapter, openCourseChapter, isCourseChapter, academicTerm, matchCurrentTerm };
