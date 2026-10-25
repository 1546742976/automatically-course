const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AnswerService } = require('../local/ai.cjs');

const questions = n => Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, type: 'single', options: [{ key: 'A' }, { key: 'B' }] }));
const valid = batch => ({ answers: batch.map(q => ({ id: q.id, answer: ['A'] })) });

test('50 题依次按 10 题解答，每批只发送对应截图，保持题目顺序并报告进度', async () => {
  const service = new AnswerService('.'), qs = questions(50), calls = [], progress = [];
  const images = qs.map(q => ({ id: q.id, url: `image-${q.id}` }));
  let active = 0;
  service.requestAnswers = async (batch, signal, screenshots) => {
    assert.equal(++active, 1);
    await new Promise(resolve => setImmediate(resolve));
    calls.push(batch.map(q => q.id));
    assert.deepEqual(screenshots.map(i => i.id), batch.map(q => q.id));
    active--;
    return { answers: valid(batch).answers.reverse() };
  };
  const result = await service.solve(qs, new AbortController().signal, images, p => progress.push(p.answered));
  assert.deepEqual(calls.map(c => c.length), [10, 10, 10, 10, 10]);
  assert.deepEqual(result.map(a => a.id), qs.map(q => q.id));
  assert.deepEqual(progress, [10, 20, 30, 40, 50]);
});

test('只补答空值、空数组与缺题，保留有效答案，不重发已解决题目', async () => {
  const service = new AnswerService('.'), qs = questions(13), calls = [], progress = [];
  service.requestAnswers = async batch => {
    calls.push(batch.map(q => q.id));
    const result = valid(batch);
    if (calls.length === 1) {
      result.answers[1].answer = null;
      result.answers[3].answer = [];
      result.answers.splice(5, 1);
      result.answers[0].answer = ['B'];
    }
    return result;
  };
  const result = await service.solve(qs, new AbortController().signal, [], p => progress.push(p));
  assert.deepEqual(calls, [qs.slice(0, 10).map(q => q.id), qs.slice(10).map(q => q.id), ['q2', 'q4', 'q6']]);
  assert.deepEqual(result[0].answer, ['B']);
  assert.deepEqual(result.map(a => a.id), qs.map(q => q.id));
  assert.equal(progress.at(-1).retry, true);
});

test('补答仍不确定时显示原始题号和已解决数量，仅尝试两轮', async () => {
  const service = new AnswerService('.');
  let calls = 0;
  service.requestAnswers = async batch => {
    calls++;
    return { answers: valid(batch).answers.map(a => ['q3', 'q12'].includes(a.id) ? { ...a, answer: null } : a) };
  };
  await assert.rejects(service.solve(questions(13), new AbortController().signal), /第 3、12 题.*11\/13.*未填写或提交/);
  assert.equal(calls, 3);
});

test('错误选项、未知题号和重复题号立即拒绝，不补答', async () => {
  for (const response of [
    { answers: [{ id: 'q1', answer: ['Z'] }] },
    { answers: [{ id: 'unknown', answer: ['A'] }] },
    { answers: [{ id: 'q1', answer: ['A'] }, { id: 'q1', answer: ['B'] }] }
  ]) {
    const service = new AnswerService('.'); let calls = 0;
    service.requestAnswers = async () => { calls++; return response; };
    await assert.rejects(service.solve(questions(1), new AbortController().signal), /无效选项|重复或未知题目/);
    assert.equal(calls, 1);
  }
});

test('批次之间暂停时不发送后续批次或补答请求', async () => {
  for (const uncertain of [false, true]) {
    const service = new AnswerService('.'), controller = new AbortController(); let calls = 0;
    service.requestAnswers = async batch => {
      calls++;
      return uncertain ? { answers: [] } : valid(batch);
    };
    await assert.rejects(service.solve(questions(uncertain ? 1 : 13), controller.signal, [], () => controller.abort()), { name: 'AbortError' });
    assert.equal(calls, 1);
  }
});
