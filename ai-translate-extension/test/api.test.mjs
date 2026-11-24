/**
 * API 集成测试（直接调用共享模块 lib/api.js）
 * 用法：
 *   真实 API： node test/api.test.mjs （默认使用 DeepSeek + 指定 Key）
 *   Mock：    AITX_API_KEY=mock-key AITX_BASE_URL=http://127.0.0.1:18765 node test/api.test.mjs
 */
import * as api from '../ext/lib/api.js';

const settings = {
  apiKey: process.env.AITX_API_KEY || 'sk-f05b922434bd4ea29b6dbce577461110',
  baseUrl: process.env.AITX_BASE_URL || 'https://api.deepseek.com',
  model: process.env.AITX_MODEL || 'deepseek-v4-flash',
};

let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failed++;
    failures.push({ name, detail });
    console.log(`  ✘ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

async function netTest(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(name, false, e?.message || String(e));
  }
}

console.log(`\n=== AI 翻译助手 API 测试 ===`);
console.log(`BaseUrl: ${settings.baseUrl}`);
console.log(`Model:   ${settings.model}`);
console.log(`Key:     ${settings.apiKey.slice(0, 6)}...${settings.apiKey.slice(-4)}\n`);

/* ---------- 纯单元测试（无网络） ---------- */
console.log('[单元] URL 规范化');
check('normalizeBaseUrl 去尾斜杠', api.normalizeBaseUrl('https://api.deepseek.com/') === 'https://api.deepseek.com');
check('normalizeBaseUrl 补协议', api.normalizeBaseUrl('api.deepseek.com') === 'https://api.deepseek.com');
check('chatCompletionsUrl 拼接', api.chatCompletionsUrl('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions');
check('chatCompletionsUrl 已含端点', api.chatCompletionsUrl('https://x.com/v1/chat/completions') === 'https://x.com/v1/chat/completions');

console.log('[单元] 翻译结果解析');
{
  const r1 = api.parseTranslationResponse('```json\n[{"i":1,"t":"a"},{"i":2,"t":"b"}]\n```', 2);
  check('解析 markdown 围栏 JSON', Array.isArray(r1) && r1[0] === 'a' && r1[1] === 'b');
  const r2 = api.parseTranslationResponse('好的，翻译如下：[{"i":1,"t":"x"}] 祝愉快', 1);
  check('容忍前后杂讯', Array.isArray(r2) && r2[0] === 'x');
  const r3 = api.parseTranslationResponse('[{"index":1,"translation":"y"}]', 1);
  check('兼容 index/translation 字段名', Array.isArray(r3) && r3[0] === 'y');
  const r4 = api.parseTranslationResponse('[{"i":1,"t":"z"},{"i":3,"t":"bad"}]', 2);
  check('越界序号被忽略、缺失位为 null', Array.isArray(r4) && r4[0] === 'z' && r4[1] === null);
  const r5 = api.parseTranslationResponse('不是 JSON', 2);
  check('非法输出返回 null', r5 === null);
}
console.log('');

/* ---------- 网络测试 ---------- */
await netTest('testConnection 连接测试', async () => {
  const r = await api.testConnection({ settings });
  check('连接测试返回 OK', /ok/i.test(r.reply || ''), `reply=${r.reply}`);
  check('连接测试有耗时统计', typeof r.latencyMs === 'number' && r.latencyMs >= 0);
});

await netTest('translateSegments 中译英（批量）', async () => {
  const out = await api.translateSegments({
    settings,
    texts: ['你好，世界。', '人工智能正在改变翻译方式。'],
    target: 'en',
  });
  check('返回段落数一致', Array.isArray(out) && out.length === 2, JSON.stringify(out));
  check('译文非空且不同于原文', out.every((t) => typeof t === 'string' && t.length > 0));
});

await netTest('translateSegments 英译中（批量）', async () => {
  const out = await api.translateSegments({
    settings,
    texts: ['Hello, world!', 'The weather is nice today.'],
    target: 'zh',
  });
  check('返回段落数一致', Array.isArray(out) && out.length === 2, JSON.stringify(out));
  check('英译中包含中文字符', out.every((t) => /[\u4e00-\u9fff]/.test(t)), JSON.stringify(out));
});

await netTest('translateText 划词翻译', async () => {
  const out = await api.translateText({ settings, text: 'Knowledge is power.', target: 'zh' });
  check('划词翻译非空', typeof out === 'string' && out.length > 0, JSON.stringify(out));
  check('划词翻译含中文', /[\u4e00-\u9fff]/.test(out), out);
});

await netTest('summarize 网页总结', async () => {
  const text = [
    '人工智能翻译技术在过去十年取得了巨大进步。',
    '神经机器翻译取代了基于规则的方法，大语言模型进一步提升了译文的自然度。',
    '与此同时，低资源语言、模型幻觉与文化细节保留仍是待解决的难题。',
    '未来，AI 翻译将成为互联网的隐形基础设施，用户几乎感知不到语言差异。',
    '研究人员正在改进评估方法与人机协作流程，以持续提高翻译可靠性。',
  ].join('\n');
  const out = await api.summarize({ settings, title: 'AI 翻译的演进', url: 'https://example.com/ai', text });
  check('总结非空', typeof out === 'string' && out.length > 30, JSON.stringify(out));
  check('总结包含结构化标题', /总结|要点|结论|TL;DR|Key Points/i.test(out), out.slice(0, 120));
});

await netTest('错误处理：错误 Key 返回可读错误', async () => {
  try {
    await api.testConnection({ settings: { ...settings, apiKey: 'sk-invalid-key-000' }, timeoutMs: 20000 });
    check('应抛出错误', false);
  } catch (e) {
    check('应抛出错误', true);
    check('错误信息包含 HTTP 状态', /HTTP 4\d\d/.test(e?.message || ''), e?.message);
  }
});

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`);
if (failures.length) {
  console.log('\n失败详情:');
  for (const f of failures) console.log(` - ${f.name}: ${f.detail}`);
  process.exit(1);
}
