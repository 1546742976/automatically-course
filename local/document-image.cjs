// Recover a preview image whose normal response is truncated, using the
// storage server's standard HTTP byte ranges for the same resource.
async function loadDocumentImage(request, url, signal) {
  const check = () => { if (signal?.aborted) throw new Error('已暂停文档读取。'); };
  check();
  const head = await request.head(url, { timeout: 10000 });
  const length = Number(head.headers()['content-length']);
  const type = head.headers()['content-type']?.split(';')[0];
  if (!head.ok() || !Number.isSafeInteger(length) || length <= 0 || !/^image\/(png|jpeg|webp|gif)$/.test(type || '')) throw new Error('图片资源信息不可用。');
  const parts = [];
  for (let start = 0; start < length; start += 65536) {
    check();
    const end = Math.min(length - 1, start + 65535);
    const response = await request.get(url, { headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' }, timeout: 10000 });
    check();
    const body = await response.body();
    if (response.status() !== 206 || response.headers()['content-range'] !== `bytes ${start}-${end}/${length}` || body.length !== end - start + 1) throw new Error('图片分段响应不完整。');
    parts.push(body);
    await response.dispose();
  }
  return `data:${type};base64,${Buffer.concat(parts).toString('base64')}`;
}
module.exports = { loadDocumentImage };
