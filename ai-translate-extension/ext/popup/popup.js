/**
 * AI 翻译助手 —— Popup 逻辑
 */
import { normalizeBaseUrl, DEFAULT_SETTINGS } from '../lib/api.js';

const $ = (id) => document.getElementById(id);

let tabId = null;
let tabUrl = '';

/* ---------------- 初始化 ---------------- */

async function init() {
  const cfg = await chrome.storage.sync.get({
    apiKey: '',
    baseUrl: DEFAULT_SETTINGS.baseUrl,
    model: DEFAULT_SETTINGS.model,
    selectionEnabled: true,
  });
  $('apiKey').value = cfg.apiKey || '';
  $('baseUrl').value = cfg.baseUrl || DEFAULT_SETTINGS.baseUrl;
  $('model').value = cfg.model || DEFAULT_SETTINGS.model;
  $('selEnabled').checked = cfg.selectionEnabled !== false;
  updateStatus(!!cfg.apiKey, cfg.model);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    tabId = tab.id;
    tabUrl = tab.url || '';
    let host = '—';
    try {
      host = new URL(tabUrl).hostname || '—';
    } catch { /* chrome:// 等页面 */ }
    $('domainBadge').textContent = host;
    $('domainBadge').title = tabUrl || '';
  }
  bindEvents();
  refreshPageState();
}

function updateStatus(hasKey, model) {
  const dot = $('statusDot');
  const text = $('statusText');
  if (hasKey) {
    dot.className = 'dot ok';
    text.textContent = `已配置 · ${model || DEFAULT_SETTINGS.model}`;
  } else {
    dot.className = 'dot err';
    text.textContent = '未配置 API Key，请先在下方填写';
  }
}

/* ---------------- 与内容脚本通信 ---------------- */

function injectContentScripts(targetTabId) {
  return new Promise((resolve) => {
    chrome.scripting.insertCSS({ target: { tabId: targetTabId }, files: ['content/content.css'] }, () => {
      void chrome.runtime.lastError;
      chrome.scripting.executeScript({ target: { tabId: targetTabId }, files: ['content/content.js'] }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
  });
}

function sendToTab(msg, { retryInject = true } = {}) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve({ ok: false, error: '未找到活动标签页' });
      return;
    }
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      const err = chrome.runtime.lastError;
      if ((err || !res) && retryInject) {
        // 内容脚本可能未注入（页面早于插件加载），尝试动态注入后重试
        injectContentScripts(tabId).then(() => {
          chrome.tabs.sendMessage(tabId, msg, (res2) => {
            void chrome.runtime.lastError;
            resolve(res2 || { ok: false, error: '当前页面不受支持（如浏览器内部页面），请切换到普通网页后重试' });
          });
        });
        return;
      }
      resolve(res || { ok: false, error: '当前页面不受支持或未刷新，请刷新页面后重试' });
    });
  });
}

async function refreshPageState() {
  const res = await sendToTab({ type: 'GET_STATE' }, { retryInject: false });
  const label = $('btnTranslateLabel');
  const hint = $('btnTranslateHint');
  const tools = $('pageTools');
  if (res.ok && res.data) {
    const dir = res.data.target === 'en' ? '中文 → 英文' : '英文 → 中文';
    hint.textContent = `自动 ${dir}`;
    if (res.data.busy) {
      $('btnTranslate').disabled = true;
      label.textContent = '翻译中…';
    } else if (res.data.translated) {
      label.textContent = '继续翻译新内容';
    } else {
      label.textContent = '翻译整页';
    }
    tools.style.display = 'flex';
    Array.from(tools.querySelectorAll('.tool-btn')).forEach((b) => (b.disabled = false));
  } else {
    label.textContent = '翻译整页';
    tools.style.display = 'flex';
    Array.from(tools.querySelectorAll('.tool-btn')).forEach((b) => (b.disabled = true));
    $('opStatus').className = 'status-line';
    $('opStatus').textContent = '当前页面可能不受支持（chrome:// / 应用商店页等）';
  }
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 显示/隐藏 API Key
  $('eyeBtn').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('eyeBtn').textContent = show ? '隐藏' : '显示';
  });

  // 保存设置
  $('btnSave').addEventListener('click', async () => {
    const apiKey = $('apiKey').value.trim();
    let baseUrl = $('baseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl;
    const model = $('model').value.trim() || DEFAULT_SETTINGS.model;
    baseUrl = normalizeBaseUrl(baseUrl);
    if (!apiKey) {
      setOpStatus('API Key 不能为空', true);
      return;
    }
    await chrome.storage.sync.set({ apiKey, baseUrl, model });
    updateStatus(true, model);
    setOpStatus('设置已保存', false);
  });

  // 测试连接
  $('btnTest').addEventListener('click', async () => {
    const st = $('testStatus');
    st.className = 'status-line';
    st.textContent = '正在连接 API…';
    $('btnTest').disabled = true;
    try {
      // 先保存当前输入，避免“测试的是旧配置”
      const apiKey = $('apiKey').value.trim();
      const baseUrl = normalizeBaseUrl($('baseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl);
      const model = $('model').value.trim() || DEFAULT_SETTINGS.model;
      if (!apiKey) throw new Error('请先填写 API Key');
      await chrome.storage.sync.set({ apiKey, baseUrl, model });
      updateStatus(true, model);
      const res = await chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' });
      if (res?.ok) {
        const d = res.data;
        st.className = 'status-line ok';
        st.textContent = `连接成功 · 模型 ${d.model} · ${d.latencyMs}ms`;
      } else {
        st.className = 'status-line err';
        st.textContent = `连接失败：${res?.error || '未知错误'}`;
      }
    } catch (e) {
      st.className = 'status-line err';
      st.textContent = `连接失败：${e?.message || e}`;
    } finally {
      $('btnTest').disabled = false;
    }
  });

  // 翻译整页
  $('btnTranslate').addEventListener('click', async () => {
    const btn = $('btnTranslate');
    btn.disabled = true;
    $('btnTranslateLabel').textContent = '翻译中…';
    setOpStatus('正在翻译当前页面，结果将直接显示在网页上…');
    const res = await sendToTab({ type: 'TRANSLATE_PAGE' });
    if (res?.ok) {
      setOpStatus('翻译完成，译文已插入页面（蓝色文字）', false);
    } else {
      setOpStatus(`翻译失败：${res?.error || '未知错误'}`, true);
    }
    refreshPageState();
  });

  // 网页总结
  $('btnSummary').addEventListener('click', async () => {
    const btn = $('btnSummary');
    btn.disabled = true;
    setOpStatus('正在生成总结，请保持弹窗打开…完成后将在页面中弹窗显示');
    const res = await sendToTab({ type: 'SUMMARIZE_PAGE' });
    if (res?.ok) {
      setOpStatus('总结完成，已显示在网页中央', false);
    } else {
      setOpStatus(`总结失败：${res?.error || '未知错误'}`, true);
    }
    btn.disabled = false;
  });

  // 隐藏/显示原文
  $('btnToggleOriginal').addEventListener('click', async () => {
    const res = await sendToTab({ type: 'TOGGLE_ORIGINAL' });
    if (res?.ok) {
      $('btnToggleOriginal').textContent = res.data?.hidingOriginal ? '显示原文' : '隐藏原文';
    }
  });

  // 恢复原状
  $('btnReset').addEventListener('click', async () => {
    const res = await sendToTab({ type: 'RESET_TRANSLATION' });
    if (res?.ok) {
      setOpStatus('已恢复页面原状', false);
      $('btnToggleOriginal').textContent = '隐藏原文';
      refreshPageState();
    }
  });

  // 重新翻译（清缓存）
  $('btnReTranslate').addEventListener('click', async () => {
    await sendToTab({ type: 'RESET_TRANSLATION' });
    $('btnTranslate').click();
  });

  // 划词翻译开关
  $('selEnabled').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ selectionEnabled: e.target.checked });
  });
}

function setOpStatus(text, isError) {
  const el = $('opStatus');
  el.className = `status-line${isError ? ' err' : ''}`;
  el.textContent = text;
}

init();
