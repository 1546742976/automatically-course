// Operates normal course controls. It does not call completion/reporting APIs.
function installTaskAgent() {
  if (!/(^|\.)chaoxing\.com$/.test(location.hostname) || globalThis.__courseTaskAgent) return;
  const documentId = crypto.randomUUID();
  let readingAt = 0, readDone = false, submission = null;
  const externalConfirmations = new Set();
  const retriedImages = new WeakSet();
  const visible = el => Boolean(el?.isConnected && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getClientRects().length);
  const text = el => el?.innerText?.trim() || el?.textContent?.trim() || '';
  const blocks = () => [...document.querySelectorAll('.TiMu, .questionLi, .question-item[data-question-id]')].filter(visible);
  const choiceMarker = el => el.querySelector('.num_option[data], .num_option_dx[data]');
  function choices(block) {
    const native = [...block.querySelectorAll('input[type=radio], input[type=checkbox]')].filter(el => !el.disabled);
    return native.length ? native : [...block.querySelectorAll('li[role=radio], li[role=checkbox], li[onclick]')].filter(el => choiceMarker(el));
  }
  function choiceKey(el, index, type) {
    const value = el.matches('input') ? el.value : choiceMarker(el)?.getAttribute('data');
    return type === 'judgment' ? (/^(true|1)$/i.test(value) ? 'true' : /^(false|0)$/i.test(value) ? 'false' : value) : value || String.fromCharCode(65 + index);
  }
  const checked = el => el.matches('input') ? el.checked : Boolean(choiceMarker(el)?.matches('.check_answer, .check_answer_dx') || el.getAttribute('aria-checked') === 'true');
  const editors = block => [...block.querySelectorAll('input:not([type]), input[type="text"], textarea, [contenteditable="true"]')]
    .filter(el => !el.disabled && (visible(el) || el.tagName === 'TEXTAREA' && globalThis.UE?.getEditor(el.name || el.id)));
  function questions() {
    return blocks().map((block, index) => {
      const heading = block.querySelector('.Zy_TItle .clearfix, .Cy_TItle .clearfix, .mark_name, .question-title, .stem') || block;
      const title = text(heading), radios = choices(block);
      const fields = editors(block);
      const type = /多选/.test(title) ? 'multiple' : /判断/.test(title) ? 'judgment' : /单选/.test(title) ? 'single'
        : /填空/.test(title) ? 'blank' : /简答|论述|问答/.test(title) ? 'text' : null;
      const options = radios.map((el, i) => ({ key: choiceKey(el, i, type),
        text: text(el.closest('li, label') || el.parentElement) }));
      let issue = !type ? '未识别的题型' : null;
      const needsImage = Boolean(block.querySelector('img, canvas, math, svg, .font-cxsecret'));
      if (['single', 'multiple', 'judgment'].includes(type) ? !options.length : !fields.length) issue ||= '未找到可填写的控件';
      if (options.some(o => !o.key) || new Set(options.map(o => o.key)).size !== options.length) issue ||= '选项标识不唯一';
      return { id: `${documentId}:${index}`, title, type, options, slots: fields.length, needsImage, issue };
    });
  }
  function submitted() {
    return /selectWorkQuestionYiPiYue|work\/view/i.test(location.href) || [...document.querySelectorAll('#workStatus, .work-status, .submit-success, .mark_title')].some(el => visible(el) && /已提交|提交成功|待批阅|已完成|作业成绩/.test(text(el)));
  }
  function chapterCompleted() {
    if (window !== window.top || !/\/mycourse\/studentstudy\/?$/i.test(location.pathname)) return false;
    const id = [...new URLSearchParams(location.search)].find(([key]) => /^(chapterid|knowledgeid)$/i.test(key))?.[1];
    const current = document.querySelector('.posCatalog_active');
    if (!id || current?.id !== `cur${id}` || !visible(current)) return false;
    if ([...current.querySelectorAll('.jobUnfinishCount')].some(el => Number(el.value) > 0)) return false;
    return [...current.querySelectorAll('.icon_Completed')].some(visible);
  }
  function inventory() {
    const attachments = globalThis.mArg?.attachments;
    if (!Array.isArray(attachments)) return [];
    return attachments.map(a => ({ type: a.type || a.property?.module || 'unknown', title: a.property?.name || a.property?.title || a.type || '未命名任务',
      done: a.isPassed === true || a.isPassed === 'true', id: String(a.jobid || a.property?.mid || '') }));
  }
  function cloudDocument() {
    if (!/^\/screen\/(?:v2\/)?file(?:_|\/|$)/.test(location.pathname)) return null;
    const root = document.querySelector('.fileBox');
    const pages = [...(root?.querySelectorAll('li[id^="anchor"]') || [])];
    let target = document.scrollingElement;
    for (let el = root; el && el !== document.body; el = el.parentElement) {
      if (el.clientHeight > 0 && el.scrollHeight > el.clientHeight + 5 && /auto|scroll/.test(getComputedStyle(el).overflowY)) { target = el; break; }
    }
    const top = target === document.scrollingElement ? 0 : target?.getBoundingClientRect().top || 0;
    const height = target?.clientHeight || 0;
    const current = pages.findIndex(page => page.getBoundingClientRect().bottom > top + 5);
    return { pages, target, top, height, current: Math.max(0, current) };
  }
  function reading() {
    const cloud = cloudDocument();
    if (cloud) return { kind: 'document', done: readDone, supported: true, title: document.title || '文档', currentPage: cloud.pages.length ? cloud.current + 1 : 0, totalPages: cloud.pages.length };
    const next = document.querySelector('.imglook > .mkeRbtn');
    const reader = document.querySelector('.reader-content, .chapter-content, .course-content');
    const documentPage = /\/ananas\/modules\/(pdf|ppt|document)\//i.test(location.pathname) || Boolean(next);
    if (!documentPage && !reader) return null;
    const delegated = documentPage && !next && !reader && [...document.querySelectorAll('#panView, #wpsView')].some(el => visible(el) && el.getAttribute('src'));
    return { kind: documentPage ? 'document' : 'text', done: readDone, supported: Boolean(next || reader || delegated), delegated, title: document.title || '阅读任务' };
  }
  function snapshot() {
    const qs = questions();
    const shell = /\/work\/(doHomeWorkNew|doWork)/i.test(location.pathname);
    const items = inventory();
    const empty = /\/knowledge\/cards\/?$/.test(location.pathname) && document.readyState === 'complete'
      && !items.length && text(document.body) === '暂无内容'
      && [...document.querySelectorAll('dd')].some(el => visible(el) && text(el) === '暂无内容');
    return { documentId, chapterCompleted: chapterCompleted(), inventory: items, questions: qs, exercise: qs.length > 0 || shell || submitted(), submitted: submitted(), reading: reading(), empty, submission };
  }
  function readStep(now = Date.now()) {
    const state = reading();
    if (!state?.supported) return { error: '此文档阅读器尚未适配，请手动阅读。' };
    if (readDone) return { done: true };
    if (!readingAt) { readingAt = now; return {}; }
    if (now - readingAt < 5000) return {};
    readingAt = now;
    const cloud = cloudDocument();
    if (cloud) {
      if (!cloud.pages.length || !cloud.height) return { waiting: true };
      const onScreen = cloud.pages.filter(page => {
        const rect = page.getBoundingClientRect();
        return rect.bottom > cloud.top && rect.top < cloud.top + cloud.height;
      });
      if (!onScreen.length) return { waiting: true };
      for (const page of onScreen) {
        const images = [...page.querySelectorAll('img')];
        if (!images.length) return { waiting: true };
        for (const image of images) {
          if (image.complete && image.naturalWidth > 0) continue;
          if (image.complete && image.getAttribute('src')) {
            if (retriedImages.has(image)) return { error: `文档第 ${cloud.pages.indexOf(page) + 1} 页图片加载失败，请刷新文档后继续。` };
            retriedImages.add(image);
            const token = `${documentId}:${cloud.pages.indexOf(page)}`;
            image.dataset.courseAssistantImage = token;
            return { retryImage: { token, src: image.src, page: cloud.pages.indexOf(page) + 1 } };
          }
          return { waiting: true };
        }
      }
      if (cloud.target.scrollTop + cloud.height >= cloud.target.scrollHeight - 5) { readDone = true; return { done: true }; }
      cloud.target.scrollBy({ top: Math.max(100, cloud.height * 0.8), behavior: 'instant' });
      return {};
    }
    if (state.delegated) return { waiting: true };
    const next = document.querySelector('.imglook > .mkeRbtn');
    if (next) {
      if (visible(next) && !next.matches('[disabled], .disabled')) { next.click(); return {}; }
      // A hidden next arrow is the viewer's last-page indication.
      if (document.querySelector('.imglook img')?.complete) { readDone = true; return { done: true }; }
      return { error: '文档尚未载入，或翻页按钮不可用。' };
    }
    const reader = document.querySelector('.reader-content, .chapter-content, .course-content');
    const target = reader.scrollHeight > reader.clientHeight + 5 ? reader : document.scrollingElement;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 5) { readDone = true; return { done: true }; }
    target.scrollBy(0, Math.max(100, target.clientHeight * 0.8));
    return {};
  }
  function restoreImage(token, source, dataURL) {
    const image = [...document.querySelectorAll('.fileBox img[data-course-assistant-image]')].find(el => el.dataset.courseAssistantImage === token);
    if (!image || image.src !== source || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataURL)) return { restored: false };
    image.src = dataURL;
    return { restored: true };
  }
  function fill(expected, answers) {
    if (JSON.stringify(questions()) !== JSON.stringify(expected)) return { error: '题目在解题期间发生变化，请重新开始。' };
    if (expected.some(q => q.issue)) return { error: '有题目不能自动填写。' };
    const nodes = blocks();
    for (let i = 0; i < expected.length; i++) {
      const q = expected[i], a = answers.find(x => x.id === q.id)?.answer;
      if (!a) return { error: '答案不完整。' };
      if (['single', 'multiple', 'judgment'].includes(q.type)) {
        const controls = choices(nodes[i]);
        for (let j = 0; j < controls.length; j++) {
          const wanted = a.includes(q.options[j].key), el = controls[j];
          if (checked(el) !== wanted && (q.type === 'multiple' || wanted)) el.click();
        }
        if (controls.some((el, j) => checked(el) !== a.includes(q.options[j].key))) return { error: '选项填写未成功，未提交。' };
        const qid = controls[0]?.getAttribute('qid');
        if (qid) {
          const field = document.getElementById(`answer${qid}`);
          const value = q.options.filter(o => a.includes(o.key)).map(o => o.key).join('');
          if (!field || field.value !== value) return { error: '网页未保存所选选项，未提交。' };
        }
      } else {
        const fields = editors(nodes[i]);
        for (let j = 0; j < fields.length; j++) {
          const el = fields[j], value = a[j];
          const ue = el.tagName === 'TEXTAREA' && globalThis.UE?.getEditor(el.name || el.id);
          if (ue) {
            const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
            ue.setContent(escaped);
            if (ue.getContentTxt().trim() !== value.trim()) return { error: '富文本填写未成功，未提交。' };
          } else {
            if (el.isContentEditable) el.textContent = value;
            else Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            if ((el.isContentEditable ? text(el) : el.value).trim() !== value.trim()) return { error: '文本填写未成功，未提交。' };
          }
        }
      }
    }
    return { filled: true };
  }
  function submit() {
    if (submitted()) return { done: true };
    if (submission) return { waiting: true };
    const candidate = [...document.querySelectorAll('.Btn_blue_1, #submitWork, .submitBtn, [data-action="submit-work"], button, a')]
      .find(el => visible(el) && /^(提交|提交作业|提交答案)$/.test(text(el)) && !el.closest('.TiMu, .questionLi'));
    if (!candidate || candidate.matches('[disabled], .disabled')) return { error: '未找到可用的提交按钮，请检查课程页面。' };
    submission = { at: Date.now(), confirmed: false };
    candidate.click();
    return { waiting: true };
  }
  function confirmSubmit({ externalId, now = Date.now() } = {}) {
    if (submitted()) return { done: true };
    // A nested exercise opens top.workPop in its ancestor chapter, not here.
    // Only an active submission may authorize a confirmation in that ancestor.
    if (!submission && !externalId) return { waiting: true };
    const tips = [...document.querySelectorAll('#tipContent, #popcontent, #toastcontent, #hintCon, .toastContent')].filter(visible);
    const failure = tips.find(el => /未[做答完]|未作答|漏答|还有.*题|尚未完成|重做|未达到及格|未达.*及格|提交失败|字数|请.*刷新|账号.*异常|重新登录|验证码|身份验证/.test(text(el)));
    if (failure) return { error: `网页提示：${text(failure).slice(0, 300)}` };
    const tip = tips.find(el => /(?:确认|确定|是否|确定要).{0,12}提交|提交.{0,12}(?:吗|？|\?)/.test(text(el)));
    if (tip) {
      const container = tip.closest('.con03, .popDiv, [role="dialog"]') || tip;
      const button = [...container.querySelectorAll('#popok, .bluebtn, button, a, [role="button"]')]
        .find(el => visible(el) && !el.matches('[disabled], [aria-disabled="true"], .disabled') && /^(确定|确认|提交|确认提交)$/.test(text(el)));
      const confirmed = externalId ? externalConfirmations.has(externalId) : submission?.confirmed;
      if (button && !confirmed) {
        if (externalId) externalConfirmations.add(externalId);
        else submission.confirmed = true;
        button.click();
        return { confirmed: true };
      }
    }
    return !externalId && submission && now - submission.at > 20000 ? { error: '尚未检测到提交成功，请在课程页检查；不会重复提交。' } : { waiting: true };
  }
  globalThis.__courseTaskAgent = { snapshot, readStep, restoreImage, fill, submit, confirmSubmit };
}
module.exports = { installTaskAgent };
