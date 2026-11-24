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

// 说明：默认值在 getSettings()/popup 读取时兜底，不做安装时写入，
// 避免 onInstalled 异步初始化与用户保存设置之间的写覆盖竞态。

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
