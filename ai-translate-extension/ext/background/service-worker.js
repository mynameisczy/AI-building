/**
 * AI 翻译助手 —— 后台 Service Worker
 * 负责：读取设置、统一转发 AI 请求（避开内容脚本的 CORS 限制）
 */
import * as api from '../lib/api.js';

async function getSettings() {
  const cfg = await chrome.storage.sync.get({
    apiKey: '',
    baseUrl: api.DEFAULT_SETTINGS.baseUrl,
    model: api.DEFAULT_SETTINGS.model,
  });
  return {
    apiKey: String(cfg.apiKey || '').trim(),
    baseUrl: String(cfg.baseUrl || '').trim() || api.DEFAULT_SETTINGS.baseUrl,
    model: String(cfg.model || '').trim() || api.DEFAULT_SETTINGS.model,
  };
}

// 安装时初始化默认设置（不覆盖用户已有配置）
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ baseUrl: '', model: '' }, (cfg) => {
    const patch = {};
    if (!cfg.baseUrl) patch.baseUrl = api.DEFAULT_SETTINGS.baseUrl;
    if (!cfg.model) patch.model = api.DEFAULT_SETTINGS.model;
    if (Object.keys(patch).length) chrome.storage.sync.set(patch);
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      const settings = await getSettings();
      switch (msg?.type) {
        case 'GET_SETTINGS': {
          return sendResponse({
            ok: true,
            data: { hasKey: !!settings.apiKey, baseUrl: settings.baseUrl, model: settings.model },
          });
        }
        case 'TEST_CONNECTION': {
          const data = await api.testConnection({ settings, timeoutMs: 30000 });
          return sendResponse({ ok: true, data });
        }
        case 'TRANSLATE_SEGMENTS': {
          const texts = (msg.texts || []).map((t) => String(t));
          if (!texts.length) return sendResponse({ ok: true, data: [] });
          const data = await api.translateSegments({
            settings,
            texts,
            target: msg.target,
            timeoutMs: 90000,
          });
          return sendResponse({ ok: true, data });
        }
        case 'TRANSLATE_TEXT': {
          const data = await api.translateText({
            settings,
            text: msg.text,
            target: msg.target,
            timeoutMs: 60000,
          });
          return sendResponse({ ok: true, data });
        }
        case 'SUMMARIZE': {
          const data = await api.summarize({
            settings,
            title: msg.title,
            url: msg.url,
            text: msg.text,
            lang: msg.lang,
            timeoutMs: 180000,
          });
          return sendResponse({ ok: true, data });
        }
        default:
          return sendResponse({ ok: false, error: `未知消息类型: ${msg?.type}` });
      }
    } catch (err) {
      return sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // 保持通道以支持异步 sendResponse
});
