/**
 * AI 翻译助手 —— 后台 Service Worker
 * 负责：读取设置、统一转发 AI 请求（避开内容脚本的 CORS 限制）
 *      记录翻译历史与 Token 消耗统计
 */
import * as api from '../lib/api.js';

const HISTORY_LIMIT = 200;
const DEFAULT_STATS = {
  requests: 0,
  errors: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  byType: { page: 0, selection: 0, summary: 0 },
  byDay: {},
};

async function getSettings() {
  const cfg = await chrome.storage.sync.get({
    apiKey: '',
    baseUrl: api.DEFAULT_SETTINGS.baseUrl,
    model: api.DEFAULT_SETTINGS.model,
    sourceLang: 'auto',
    targetLang: 'auto',
    selTarget: 'auto',
    selectionEnabled: true,
  });
  return {
    apiKey: String(cfg.apiKey || '').trim(),
    baseUrl: String(cfg.baseUrl || '').trim() || api.DEFAULT_SETTINGS.baseUrl,
    model: String(cfg.model || '').trim() || api.DEFAULT_SETTINGS.model,
    sourceLang: cfg.sourceLang || 'auto',
    targetLang: cfg.targetLang || 'auto',
    selTarget: cfg.selTarget || 'auto',
    selectionEnabled: cfg.selectionEnabled !== false,
  };
}

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function makeRecord({ type, source, target, original, translated, usage, model, url }) {
  usage = usage || {};
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    source,
    target,
    timestamp: Date.now(),
    original: String(original || '').slice(0, 180),
    translated: String(translated || '').slice(0, 180),
    promptTokens: Number(usage.prompt_tokens) || 0,
    completionTokens: Number(usage.completion_tokens) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    model: model || '',
    url: String(url || '').slice(0, 300),
  };
}

// 串行写入，避免 SW 中多个并发请求互相覆盖历史/统计
let persistQueue = Promise.resolve();
function persist(record) {
  persistQueue = persistQueue
    .then(async () => {
      const cfg = await chrome.storage.local.get({ history: [], stats: DEFAULT_STATS });
      const history = Array.isArray(cfg.history) ? cfg.history : [];
      const s = cfg.stats || {};
      const stats = {
        ...DEFAULT_STATS,
        ...s,
        byType: { ...DEFAULT_STATS.byType, ...(s.byType || {}) },
        byDay: { ...(s.byDay || {}) },
      };
      if (record) {
        history.unshift(record);
        if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
        stats.requests += 1;
        stats.promptTokens += record.promptTokens;
        stats.completionTokens += record.completionTokens;
        stats.totalTokens += record.totalTokens;
        stats.byType[record.type] = (stats.byType[record.type] || 0) + 1;
        const day = stats.byDay[dayKey(record.timestamp)] || { requests: 0, tokens: 0 };
        day.requests += 1;
        day.tokens += record.totalTokens;
        stats.byDay[dayKey(record.timestamp)] = day;
      } else {
        stats.errors += 1;
      }
      await chrome.storage.local.set({ history, stats });
    })
    .catch(() => {});
  return persistQueue;
}

async function getLocalData() {
  await persistQueue;
  const cfg = await chrome.storage.local.get({ history: [], stats: DEFAULT_STATS });
  const s = cfg.stats || {};
  return {
    history: Array.isArray(cfg.history) ? cfg.history : [],
    stats: {
      ...DEFAULT_STATS,
      ...s,
      byType: { ...DEFAULT_STATS.byType, ...(s.byType || {}) },
      byDay: { ...(s.byDay || {}) },
    },
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      switch (msg?.type) {
        case 'GET_SETTINGS': {
          return sendResponse({
            ok: true,
            data: {
              hasKey: !!settings.apiKey,
              apiKey: settings.apiKey,
              baseUrl: settings.baseUrl,
              model: settings.model,
              sourceLang: settings.sourceLang,
              targetLang: settings.targetLang,
              selTarget: settings.selTarget,
              selectionEnabled: settings.selectionEnabled,
            },
          });
        }
        case 'TEST_CONNECTION': {
          const data = await api.testConnection({ settings, timeoutMs: 30000 });
          return sendResponse({ ok: true, data });
        }
        case 'TRANSLATE_SEGMENTS': {
          const texts = (msg.texts || []).map((t) => String(t));
          if (!texts.length) return sendResponse({ ok: true, data: [] });
          const dir = api.resolveDirection({ source: msg.source, target: msg.target, sample: texts.join(' ') });
          let usage = null;
          let model = '';
          const data = await api.translateSegments({
            settings,
            texts,
            target: dir.target,
            timeoutMs: 90000,
            onUsage: (u, raw) => { usage = u; model = raw?.model; },
          });
          await persist(makeRecord({
            type: 'page',
            source: dir.source,
            target: dir.target,
            original: texts.join('\n'),
            translated: data.join('\n'),
            usage,
            model,
            url: msg.url,
          }));
          return sendResponse({ ok: true, data });
        }
        case 'TRANSLATE_TEXT': {
          const dir = api.resolveDirection({ source: msg.source, target: msg.target, sample: msg.text });
          let usage = null;
          let model = '';
          const data = await api.translateText({
            settings,
            text: msg.text,
            target: dir.target,
            timeoutMs: 60000,
            onUsage: (u, raw) => { usage = u; model = raw?.model; },
          });
          await persist(makeRecord({
            type: 'selection',
            source: dir.source,
            target: dir.target,
            original: msg.text,
            translated: data,
            usage,
            model,
            url: msg.url,
          }));
          return sendResponse({ ok: true, data });
        }
        case 'SUMMARIZE': {
          const dir = api.resolveDirection({ source: msg.source, target: msg.target, sample: msg.text });
          let usage = null;
          let model = '';
          const data = await api.summarize({
            settings,
            title: msg.title,
            url: msg.url,
            text: msg.text,
            lang: msg.lang || dir.target,
            timeoutMs: 180000,
            onUsage: (u, raw) => { usage = u; model = raw?.model; },
          });
          await persist(makeRecord({
            type: 'summary',
            source: dir.source,
            target: msg.lang || dir.target,
            original: msg.text,
            translated: data,
            usage,
            model,
            url: msg.url,
          }));
          return sendResponse({ ok: true, data });
        }
        case 'GET_HISTORY': {
          return sendResponse({ ok: true, data: await getLocalData() });
        }
        case 'CLEAR_HISTORY': {
          await persistQueue;
          await chrome.storage.local.set({ history: [] });
          return sendResponse({ ok: true });
        }
        case 'RESET_STATS': {
          await persistQueue;
          await chrome.storage.local.set({ stats: DEFAULT_STATS });
          return sendResponse({ ok: true });
        }
        default:
          return sendResponse({ ok: false, error: `未知消息类型: ${msg?.type}` });
      }
    } catch (err) {
      if (['TRANSLATE_SEGMENTS', 'TRANSLATE_TEXT', 'SUMMARIZE'].includes(msg?.type)) {
        await persist(null); // 记录一次失败
      }
      return sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true;
});
