const $ = id => document.getElementById(id);
const labels = { idle: '准备开始', paused: '已暂停', loading: '正在载入', playing: '连续播放中', reading: '正在阅读', solving: 'AI 正在解题', submitting: '正在提交练习', waiting: '等待章节任务', attention: '需要处理', done: '本页任务结束' };
let busy = false, initialized = false;
let latestState, catalog = [], selection = [], catalogSignature = '', queueSignature = '', termSignature = '';
const knownCourses = new Map();
const actionButtons = ['open', 'openURL', 'loadCourses', 'saveQueue', 'startQueue', 'start', 'stop', 'show', 'scan', 'saveAI'];
function formatTime(value) {
  if (!Number.isFinite(value)) return '--:--';
  const seconds = Math.max(0, Math.floor(value));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function render(state) {
  latestState = state;
  $('termNotice').textContent = state.termNotice || '';
  $('queueNotice').textContent = state.queueNotice || '';
  const termKey = JSON.stringify([state.terms, state.termFilter]);
  if (termSignature !== termKey) {
    termSignature = termKey;
    $('termFilter').replaceChildren(...[{ id: 'auto', title: '自动匹配当前学期' }, { id: '0', title: '全部学期' }, ...(state.terms || [])].map(t => { const o = document.createElement('option'); o.value = t.id; o.textContent = t.title; return o; }));
    $('termFilter').value = state.termFilter || 'auto';
  }
  $('status').textContent = labels[state.status] || '准备开始';
  $('detail').textContent = state.detail;
  $('indicator').dataset.state = state.status;
  $('start').textContent = state.enabled ? '应用当前章节设置' : '只处理当前章节';
  $('keyStatus').textContent = state.ai?.configured ? '已配置，留空保留' : '未配置';
  $('tasks').replaceChildren(...(state.tasks || []).map(task => { const li = document.createElement('li'); li.textContent = task; return li; }));
  $('stop').disabled = !state.enabled || busy;
  $('start').disabled = state.queueRunning || busy;
  $('show').disabled = !state.activeURL || busy;
  $('progress').max = state.duration || 1;
  $('progress').value = state.currentTime || 0;
  $('elapsed').textContent = formatTime(state.currentTime);
  $('duration').textContent = formatTime(state.duration);
  if (!initialized) {
    selection = (state.courses || []).map(c => c.id);
    $('courseURL').value = state.courseURL;
    $('rate').value = state.options.rate;
    $('muted').checked = state.options.muted;
    $('autoNext').checked = state.options.autoNext;
    $('aiBaseURL').value = state.ai?.baseURL || 'https://api.deepseek.com';
    $('aiModel').value = state.ai?.model || 'deepseek-flash';
    $('aiVision').checked = state.ai?.vision ?? true;
    initialized = true;
  }
  for (const c of [...(state.courses || []), ...(state.catalog || [])]) knownCourses.set(c.id, c);
  catalog = state.catalog || [];
  const signature = JSON.stringify(catalog.map(c => [c.id, c.title, c.closed]));
  if (signature !== catalogSignature) { catalogSignature = signature; renderChoices(); }
  const queue = JSON.stringify([state.courses, state.enabled, state.queueRunning]);
  if (queue !== queueSignature) { queueSignature = queue; renderQueue(state); }
}
function renderChoices() {
  const search = $('courseSearch').value.trim().toLowerCase();
  const nodes = catalog.filter(c => c.title.toLowerCase().includes(search)).map(course => {
    const label = document.createElement('label'); label.className = 'course-choice';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selection.includes(course.id);
    checkbox.addEventListener('change', () => { selection = checkbox.checked ? [...selection.filter(id => id !== course.id), course.id] : selection.filter(id => id !== course.id); });
    const text = document.createElement('span'); text.textContent = course.title + (course.closed ? '（已结课）' : '');
    label.append(checkbox, text); return label;
  });
  if (nodes.length) $('courseChoices').replaceChildren(...nodes);
  else { const p = document.createElement('p'); p.className = 'hint'; p.textContent = catalog.length ? '没有匹配的课程。' : '登录后刷新课程列表，即可一次勾选多门课程。'; $('courseChoices').replaceChildren(p); }
}
function renderQueue(state) {
  const labels = { pending: '等待中', running: '处理中', paused: '已暂停', done: '已处理', attention: '需要处理' };
  $('courseQueue').replaceChildren(...state.courses.map((course, index) => {
    const li = document.createElement('li'); li.dataset.state = course.status;
    const content = document.createElement('div'); const title = document.createElement('strong'); title.textContent = course.title;
    const status = document.createElement('small'); status.textContent = labels[course.status] || '等待中';
    content.append(title, status);
    if (course.detail) { const detail = document.createElement('p'); detail.textContent = course.detail; content.append(detail); }
    const buttons = document.createElement('div'); buttons.className = 'queue-order';
    const open = document.createElement('button'); open.className = 'outline course-open'; open.textContent = '打开课程'; open.type = 'button';
    open.addEventListener('click', () => action('show-course', { courseId: course.id }));
    buttons.append(open);
    for (const [text, change] of [['↑', -1], ['↓', 1], ['×', 0]]) {
      const b = document.createElement('button'); b.className = 'outline'; b.textContent = text; b.type = 'button';
      b.setAttribute('aria-label', `${change === -1 ? '上移' : change === 1 ? '下移' : '移除'} ${course.title}`);
      b.disabled = state.enabled || busy || change === -1 && index === 0 || change === 1 && index === state.courses.length - 1;
      b.addEventListener('click', async () => {
        const courses = [...latestState.courses];
        if (change) [courses[index], courses[index + change]] = [courses[index + change], courses[index]];
        else courses.splice(index, 1);
        try { await call({ type: 'set-queue', courses }); selection = courses.map(c => c.id); renderChoices(); }
        catch (error) { $('error').textContent = error.message; }
      }); buttons.append(b);
    }
    li.append(content, buttons); return li;
  }));
  $('queueSummary').textContent = state.courses.length ? `${state.courses.length} 门课程 · 已处理 ${state.courses.filter(c => c.status === 'done').length} 门${state.queueRunning ? ' · 正按顺序处理' : ' · 进度已保存在本机'}` : '尚未安排课程。';
}
async function call(command) {
  const result = await window.__courseAssistantControl(command);
  if (!result.ok) throw new Error(result.error);
  render(result.state);
}
async function action(type, extra = {}) {
  busy = true;
  for (const id of actionButtons) $(id).disabled = true;
  $('error').textContent = '';
  try {
    await call({ type, ...extra, url: $('courseURL').value, termFilter: $('termFilter').value, courses: selection.map(id => knownCourses.get(id)).filter(Boolean), ai: { baseURL: $('aiBaseURL').value, model: $('aiModel').value, apiKey: $('aiKey').value, vision: $('aiVision').checked }, options: { rate: Number($('rate').value), muted: $('muted').checked, autoNext: $('autoNext').checked } });
    if (type === 'save-ai') $('aiKey').value = '';
    if (['open', 'show-course'].includes(type)) showCourse();
  }
  catch (error) { $('error').textContent = error.message; }
  finally { busy = false; for (const id of actionButtons) $(id).disabled = false; queueSignature = ''; await refresh(); }
}
async function refresh() {
  if (busy) return;
  try { await call({ type: 'state' }); }
  catch (error) { $('error').textContent = `本地程序连接失败：${error.message}`; }
}
$('open').addEventListener('click', () => { $('courseURL').value = ''; action('open'); });
$('openURL').addEventListener('click', () => action('open'));
$('loadCourses').addEventListener('click', () => action('list-courses'));
$('saveQueue').addEventListener('click', () => action('set-queue'));
$('startQueue').addEventListener('click', () => action('start-queue'));
$('courseSearch').addEventListener('input', renderChoices);
$('termFilter').addEventListener('change', () => action('list-courses'));
$('start').addEventListener('click', () => action('start'));
$('stop').addEventListener('click', () => action('stop'));
$('show').addEventListener('click', () => action('show-course'));
$('scan').addEventListener('click', () => action('scan'));
$('saveAI').addEventListener('click', () => action('save-ai'));
refresh();
setInterval(refresh, 1000);

let viewGeneration = 0, viewQueue = Promise.resolve(), layoutFrame = 0;
async function viewCall(command) {
  const result = await window.__courseAssistantControl(command);
  if (!result.ok) throw new Error(result.error);
  return result;
}
function layoutView() {
  if (!$('courseDialog').open) return;
  cancelAnimationFrame(layoutFrame);
  layoutFrame = requestAnimationFrame(() => {
    if (!$('courseDialog').open) return;
    const { x, y, width, height } = $('courseScreen').getBoundingClientRect();
    viewCall({ type: 'view-layout', bounds: { x, y, width, height } }).catch(error => { $('viewError').textContent = error.message; });
  });
}
function sendInput(event) {
  viewQueue = viewQueue.catch(() => {}).then(() => viewCall({ type: 'view-input', event })).then(() => { layoutView(); });
  viewQueue.catch(error => { $('viewError').textContent = error.message; });
  return viewQueue;
}
async function updateView(generation) {
  if (!$('courseDialog').open || generation !== viewGeneration) return;
  try {
    const { view } = await viewCall({ type: 'view-state' });
    if (!$('courseDialog').open || generation !== viewGeneration) return;
    $('viewMessage').hidden = Boolean(view.selected);
    $('viewMessage').textContent = view.selected ? '' : '请先连接学习通。';
    $('courseAddress').textContent = view.address;
    $('courseZoom').value = String(view.zoom || 1);
    const tabs = JSON.stringify(view.tabs);
    if ($('courseTabs').dataset.tabs !== tabs) {
      $('courseTabs').replaceChildren(...view.tabs.map(tab => {
        const button = document.createElement('button'); button.type = 'button'; button.role = 'tab';
        button.dataset.id = tab.id; button.textContent = tab.title; button.title = tab.title;
        button.addEventListener('click', async () => {
          await sendInput({ kind: 'select', id: tab.id }); updateView(++viewGeneration);
        });
        return button;
      }));
      $('courseTabs').dataset.tabs = tabs;
    }
    for (const tab of $('courseTabs').children) tab.setAttribute('aria-selected', String(tab.dataset.id === view.selected));
    $('viewError').textContent = '';
    layoutView();
  } catch (error) { $('viewError').textContent = error.message; }
  setTimeout(() => updateView(generation), 1000);
}
function showCourse() {
  if (!$('courseDialog').open) $('courseDialog').showModal();
  layoutView(); updateView(++viewGeneration);
}
$('closeCourse').addEventListener('click', () => $('courseDialog').close());
$('courseDialog').addEventListener('close', () => {
  viewGeneration++; cancelAnimationFrame(layoutFrame);
  viewCall({ type: 'view-hide' }).catch(error => { $('error').textContent = error.message; });
});
$('courseBack').addEventListener('click', () => sendInput({ kind: 'back' }));
$('courseReload').addEventListener('click', () => sendInput({ kind: 'reload' }));
$('courseHome').addEventListener('click', () => sendInput({ kind: 'course-home' }));
$('courseZoom').addEventListener('change', () => sendInput({ kind: 'zoom', factor: Number($('courseZoom').value) }));
new ResizeObserver(layoutView).observe($('courseScreen'));
window.addEventListener('resize', layoutView);
