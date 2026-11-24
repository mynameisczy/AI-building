/**
 * 本地 Mock OpenAI 协议服务器（无外部依赖，Node 内置 http）
 * 用于在 API Key 无效/不可用时，对插件全链路做端到端验证。
 * 返回内容带 [MOCK-EN] / [MOCK-ZH] / [MOCK-T] 前缀，便于断言。
 */
import http from 'node:http';

export function startMockServer({ port = 18765 } = {}) {
  const requests = [];

  function classify(messages = []) {
    const sys = (messages.find((m) => m.role === 'system')?.content || '');
    if (sys.includes('connectivity probe')) return 'probe';
    if (sys.includes('webpage translation engine')) {
      return sys.includes('into English') ? 'batch-en' : 'batch-zh';
    }
    if (sys.includes('professional translator')) {
      return sys.includes('into English') ? 'text-en' : 'text-zh';
    }
    if (sys.includes('总结助手')) return 'summary';
    return 'other';
  }

  const ZH_DICT = [
    [/hello.*world/i, '[MOCK-ZH] 你好，世界！'],
    [/knowledge is power/i, '[MOCK-ZH] 知识就是力量。'],
    [/weather/i, '[MOCK-ZH] 今天天气真不错。'],
  ];

  function fakeTranslate(text, prefix) {
    if (prefix.includes('ZH')) {
      for (const [re, t] of ZH_DICT) if (re.test(text)) return t;
      return `${prefix} 中文译文：${text}`;
    }
    return `${prefix} ${text}`;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      const record = {
        url: req.url,
        auth: req.headers.authorization || '',
        model: payload.model,
        messages: payload.messages,
      };
      requests.push(record);

      const finish = (content, model) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'mock-chatcmpl',
          object: 'chat.completion',
          model: model || payload.model || 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
      };
      const deny = (code, message) => {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
      };

      // 模拟鉴权
      if (record.auth !== 'Bearer mock-key') return deny(401, 'Mock: invalid api key');
      if (!/\/chat\/completions$/.test(req.url || '')) return deny(404, 'Mock: unknown endpoint');

      const kind = classify(payload.messages);
      switch (kind) {
        case 'probe':
          return finish('OK');
        case 'batch-en':
        case 'batch-zh': {
          const prefix = kind === 'batch-en' ? '[MOCK-EN]' : '[MOCK-ZH]';
          const user = payload.messages.find((m) => m.role === 'user')?.content || '';
          const segs = user.split('\n').filter(Boolean).map((line) => {
            const m = line.match(/^\s*(\d+)\.\s?([\s\S]*)$/);
            return m ? { i: Number(m[1]), t: m[2] } : null;
          }).filter(Boolean);
          if (!segs.length) return finish('[]');
          return finish(JSON.stringify(segs.map((s) => ({ i: s.i, t: fakeTranslate(s.t, prefix) }))));
        }
        case 'text-en':
        case 'text-zh': {
          const prefix = kind === 'text-en' ? '[MOCK-T-EN]' : '[MOCK-T-ZH]';
          const user = payload.messages.find((m) => m.role === 'user')?.content || '';
          return finish(fakeTranslate(user, prefix));
        }
        case 'summary':
          return finish(
            [
              '## 一句话总结',
              '这是 Mock 服务器生成的总结：页面讨论了 AI 翻译技术的发展与挑战。',
              '',
              '## 核心要点',
              '- [MOCK] 要点一：神经网络显著提升了翻译质量',
              '- [MOCK] 要点二：大语言模型支持多领域术语适配',
              '- [MOCK] 要点三：低资源语言与幻觉仍是挑战',
              '',
              '## 关键结论',
              'AI 翻译正成为互联网的隐形基础设施。',
            ].join('\n')
          );
        default:
          return finish('(mock) ok');
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ server, port, requests }));
  });
}
