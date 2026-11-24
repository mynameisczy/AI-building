/**
 * AI 翻译助手 —— 共享 API 模块
 * 被 background/service-worker.js、popup/popup.js 与 Node 测试脚本共用。
 * 纯 ESM，无 chrome.* 依赖，兼容任意 OpenAI 协议端点。
 */

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
};

/** 规范化 Base URL：补协议、去尾部斜杠 */
export function normalizeBaseUrl(raw) {
  let u = String(raw || '').trim().replace(/\s+/g, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  return u;
}

/** 拼接 chat/completions 端点（用户可直接填完整端点或 BaseUrl） */
export function chatCompletionsUrl(baseUrl) {
  const u = normalizeBaseUrl(baseUrl);
  if (!u) {
    const e = new Error('未配置 API Base URL，请在插件设置中填写。');
    e.code = 'NO_BASE_URL';
    throw e;
  }
  if (/\/chat\/completions$/i.test(u)) return u;
  return u + '/chat/completions';
}

/**
 * 调用 OpenAI 协议 chat/completions 接口
 * @returns {Promise<object>} 完整响应 JSON
 */
export async function chat({ settings, messages, temperature = 0.3, maxTokens, timeoutMs = 60000 }) {
  if (!settings?.apiKey) {
    const e = new Error('尚未配置 API Key，请点击插件图标，在「AI 服务设置」中填写。');
    e.code = 'NO_KEY';
    throw e;
  }
  const url = chatCompletionsUrl(settings.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_SETTINGS.model,
        messages,
        temperature,
        stream: false,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒），请稍后重试或更换模型。`);
    }
    throw new Error(`无法连接 API（${url}）：${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* 忽略非 JSON */ }

  if (!res.ok) {
    const detail =
      data?.error?.message || data?.message || (raw || '').slice(0, 300) || `HTTP ${res.status}`;
    const err = new Error(`API 返回错误（HTTP ${res.status}）：${detail}`);
    err.status = res.status;
    throw err;
  }
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error(`API 返回格式异常（缺少 choices[0].message.content）：${(raw || '').slice(0, 300)}`);
  }
  return data;
}

/** 目标语言展示名 */
export function langLabel(target) {
  return target === 'en' ? 'English' : '简体中文';
}

/** 整页翻译的批量翻译提示词（要求返回 JSON 数组，逐段对应） */
export function buildTranslateMessages({ texts, target }) {
  const sys = [
    'You are a professional webpage translation engine.',
    `Translate each numbered text segment into ${langLabel(target)}.`,
    'Rules:',
    '- Keep translations natural, fluent and faithful; use correct terminology.',
    '- Translate each segment independently; keep the same order and count. Never merge or split segments.',
    '- Preserve numbers, URLs, email addresses and code snippets as-is.',
    '- If a segment is already in the target language, return it unchanged.',
    '- Output STRICTLY a JSON array like [{"i":1,"t":"translation"},...] with exactly one object per input segment, no extra text, no markdown fences.',
  ].join('\n');
  const user = `Translate the following ${texts.length} segment(s) into ${langLabel(target)}:\n\n${texts
    .map((t, i) => `${i + 1}. ${t}`)
    .join('\n')}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/** 从模型输出中稳健解析翻译结果（容忍 markdown 围栏 / 前后杂讯） */
export function parseTranslationResponse(content, count) {
  let s = String(content || '').trim();
  s = s.replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  let arr = null;
  if (a !== -1 && b > a) {
    try { arr = JSON.parse(s.slice(a, b + 1)); } catch { /* 忽略 */ }
  }
  if (!Array.isArray(arr)) return null;
  const out = new Array(count).fill(null);
  for (const item of arr) {
    let idx = null;
    let val = null;
    if (item && typeof item === 'object') {
      idx = item.i ?? item.index ?? item.id;
      val = item.t ?? item.translation ?? item.text;
    }
    const n = Number(idx);
    if (Number.isInteger(n) && n >= 1 && n <= count && typeof val === 'string') out[n - 1] = val;
  }
  return out.some((v) => v !== null) ? out : null;
}

/** 批量翻译（整页翻译核心），缺失段落回退为原文 */
export async function translateSegments({ settings, texts, target, timeoutMs = 90000 }) {
  const data = await chat({
    settings,
    messages: buildTranslateMessages({ texts, target }),
    temperature: 0.3,
    timeoutMs,
  });
  const content = data.choices[0].message.content;
  const arr = parseTranslationResponse(content, texts.length);
  if (!arr) {
    const err = new Error('模型返回的翻译结果无法解析（未得到 JSON 数组）。');
    err.raw = String(content).slice(0, 500);
    throw err;
  }
  return arr.map((v, i) => v ?? texts[i]);
}

/** 划词翻译（单段，自由文本输出） */
export async function translateText({ settings, text, target, timeoutMs = 60000 }) {
  const messages = [
    {
      role: 'system',
      content: `You are a professional translator. Translate the user text into ${langLabel(target)}. Output ONLY the translated text — no explanations, no quotes, no extra formatting.`,
    },
    { role: 'user', content: String(text) },
  ];
  const data = await chat({ settings, messages, temperature: 0.3, timeoutMs });
  return String(data.choices[0].message.content || '').trim();
}

/** 网页总结提示词 */
export function buildSummaryMessages({ title, url, text, lang = 'zh' }) {
  const zh = lang !== 'en';
  const sys = zh
    ? '你是一名专业的网页内容总结助手。用户会提供网页的标题、链接与正文，请用简体中文输出高质量摘要。'
    : 'You are a professional web page summarization assistant. Output a high-quality summary in English.';
  const fmt = zh
    ? `输出格式（Markdown）：
## 一句话总结
（15~30 字概括全文）

## 核心要点
- （4~8 条，每条一句话，按重要性排序）

## 关键结论
（如有建议、结论或注意事项，用 1~3 句话说明；没有则写“无”）`
    : `Output format (Markdown):
## TL;DR
(one sentence)

## Key Points
- (4-8 bullets)

## Conclusion
(1-3 sentences, or "None")`;
  const user = `网页标题：${title || '(无标题)'}\n网页链接：${url || '(无)'}\n\n正文内容：\n"""\n${text}\n"""\n\n${
    zh ? '请总结以上网页内容。' : 'Summarize the page content above.'
  }\n${fmt}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/** 网页总结 */
export async function summarize({ settings, title, url, text, lang = 'zh', timeoutMs = 180000 }) {
  const messages = buildSummaryMessages({ title, url, text, lang });
  const data = await chat({ settings, messages, temperature: 0.5, maxTokens: 2048, timeoutMs });
  return String(data.choices[0].message.content || '').trim();
}

/** 连接测试 */
export async function testConnection({ settings, timeoutMs = 30000 }) {
  const started = Date.now();
  const messages = [
    { role: 'system', content: 'You are a connectivity probe. Reply with exactly: OK' },
    { role: 'user', content: 'ping' },
  ];
  const data = await chat({ settings, messages, temperature: 0, maxTokens: 16, timeoutMs });
  return {
    model: data.model || settings.model,
    reply: String(data.choices[0].message.content || '').trim(),
    latencyMs: Date.now() - started,
    usage: data.usage || null,
  };
}
