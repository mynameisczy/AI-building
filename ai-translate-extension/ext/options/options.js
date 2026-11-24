/**
 * AI 翻译助手 —— 管理面板
 * API 配置 / 语言切换 / 翻译历史 / Token 消耗统计
 */
import { normalizeBaseUrl, DEFAULT_SETTINGS, LANG_LABELS } from '../lib/api.js';

const $ = (id) => document.getElementById(id);
const send = (msg) =>
  new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        void chrome.runtime.lastError;
        resolve(res || { ok: false, error: '后台服务无响应' });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message || String(e) });
    }
  });

let currentHistory = [];
let currentStats = null;

/* ---------------- 设置 ---------------- */

function notice(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `notice${kind ? ' ' + kind : ''}`;
}

function updateHeader(hasKey, model) {
  $('statusDot').className = `dot ${hasKey ? 'ok' : 'err'}`;
  $('statusText').textContent = hasKey
    ? `已配置 · ${model || DEFAULT_SETTINGS.model}`
    : '未配置 API Key，请在下方填写';
}

function updateLanguagePreview() {
  const source = $('sourceLang').value;
  const target = $('targetLang').value;
  const label = (v, fallback) => LANG_LABELS[v] || fallback;
  const srcText = label(source, '自动');
  const tgtText = target === 'auto' ? '自动（反向）' : label(target, '自动');
  $('chipSource').textContent = srcText;
  $('chipTarget').textContent = tgtText;
  $('directionBadge').textContent = `${srcText} → ${tgtText}`;
  $('languageHint').textContent =
    source === 'auto' && target === 'auto'
      ? '当前为自动模式：中英互译；若目标与源相同，会自动切换为反向语言'
      : `已固定语言方向：${srcText} → ${tgtText}；划词翻译可单独覆盖目标语言`;
}

async function loadSettings() {
  const res = await send({ type: 'GET_SETTINGS' });
  if (!res.ok) {
    notice('apiNotice', `读取配置失败：${res.error}`, 'err');
    return;
  }
  const d = res.data;
  $('apiKey').value = d.apiKey || '';
  $('baseUrl').value = d.baseUrl || DEFAULT_SETTINGS.baseUrl;
  $('model').value = d.model || DEFAULT_SETTINGS.model;
  $('sourceLang').value = d.sourceLang || 'auto';
  $('targetLang').value = d.targetLang || 'auto';
  $('selTarget').value = d.selTarget || 'auto';
  $('selectionEnabled').checked = d.selectionEnabled !== false;
  updateHeader(d.hasKey, d.model);
  updateLanguagePreview();
}

function collectSettings() {
  return {
    apiKey: $('apiKey').value.trim(),
    baseUrl: normalizeBaseUrl($('baseUrl').value.trim() || DEFAULT_SETTINGS.baseUrl),
    model: $('model').value.trim() || DEFAULT_SETTINGS.model,
    sourceLang: $('sourceLang').value,
    targetLang: $('targetLang').value,
    selTarget: $('selTarget').value,
    selectionEnabled: $('selectionEnabled').checked,
  };
}

function saveSettings(settings) {
  return chrome.storage.sync.set(settings);
}

/* ---------------- 历史与统计 ---------------- */

const num = (n) => Number(n || 0).toLocaleString('zh-CN');

function renderStats(stats) {
  if (!stats) return;
  currentStats = stats;
  $('statRequests').textContent = num(stats.requests);
  $('statTokens').textContent = num(stats.totalTokens);
  $('statSplit').textContent = `${num(stats.promptTokens)} / ${num(stats.completionTokens)}`;
  $('statErrors').textContent = num(stats.errors);
  $('statByType').textContent = `整页 ${num(stats.byType?.page)} · 划词 ${num(stats.byType?.selection)} · 总结 ${num(stats.byType?.summary)}`;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    days.push({ label: `${d.getMonth() + 1}/${d.getDate()}`, tokens: Number(stats.byDay?.[key]?.tokens || 0) });
  }
  const max = Math.max(1, ...days.map((d) => d.tokens));
  $('tokenChart').innerHTML = days
    .map(
      (d) => `<div class="chart-col">
        <div class="chart-value">${d.tokens ? num(d.tokens) : ''}</div>
        <div class="chart-bar${d.tokens ? '' : ' zero'}" style="height:${Math.max(3, (d.tokens / max) * 88)}px"></div>
        <div class="chart-day">${d.label}</div>
      </div>`,
    )
    .join('');
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function renderHistory() {
  const filter = $('historyFilter').value;
  const rows = currentHistory.filter((r) => filter === 'all' || r.type === filter);
  $('historyEmpty').hidden = rows.length > 0;

  const typeNames = { page: '整页', selection: '划词', summary: '总结' };
  const dir = (r) => `${LANG_LABELS[r.source] || r.source || '?'} → ${LANG_LABELS[r.target] || r.target || '?'}`;

  $('historyBody').innerHTML = rows
    .map((r) => {
      const time = new Date(r.timestamp).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      });
      return `<tr>
        <td>${escapeHtml(time)}</td>
        <td><span class="type-tag ${escapeHtml(r.type)}">${escapeHtml(typeNames[r.type] || r.type)}</span></td>
        <td>${escapeHtml(dir(r))}</td>
        <td class="preview-cell" title="${escapeHtml(r.original)}">
          <span class="preview-original">原文：${escapeHtml(r.original)}</span>
          <span class="preview-translated">译文：${escapeHtml(r.translated)}</span>
        </td>
        <td>${num(r.totalTokens)}</td>
      </tr>`;
    })
    .join('');
}

async function loadData() {
  const res = await send({ type: 'GET_HISTORY' });
  if (!res.ok) return;
  currentHistory = Array.isArray(res.data.history) ? res.data.history : [];
  renderStats(res.data.stats);
  renderHistory();
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('eyeBtn').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('eyeBtn').textContent = show ? '隐藏' : '显示';
  });

  $('btnSave').addEventListener('click', async () => {
    const settings = collectSettings();
    if (!settings.apiKey) return notice('apiNotice', 'API Key 不能为空', 'err');
    await saveSettings(settings);
    updateHeader(true, settings.model);
    notice('apiNotice', '配置已保存', 'ok');
  });

  $('btnTest').addEventListener('click', async () => {
    const settings = collectSettings();
    if (!settings.apiKey) return notice('apiNotice', '请先填写 API Key', 'err');
    await saveSettings(settings);
    updateHeader(true, settings.model);
    notice('apiNotice', '正在连接 API…');
    $('btnTest').disabled = true;
    try {
      const res = await send({ type: 'TEST_CONNECTION' });
      if (res.ok) {
        notice('apiNotice', `连接成功 · 模型 ${res.data.model} · ${res.data.latencyMs}ms`, 'ok');
      } else {
        notice('apiNotice', `连接失败：${res.error}`, 'err');
      }
    } finally {
      $('btnTest').disabled = false;
    }
  });

  for (const id of ['sourceLang', 'targetLang', 'selTarget']) {
    $(id).addEventListener('change', updateLanguagePreview);
  }

  $('btnSaveLang').addEventListener('click', async () => {
    const s = collectSettings();
    await chrome.storage.sync.set({
      sourceLang: s.sourceLang,
      targetLang: s.targetLang,
      selTarget: s.selTarget,
      selectionEnabled: s.selectionEnabled,
    });
    notice('langNotice', '语言设置已保存，对后续翻译立即生效', 'ok');
  });

  $('selectionEnabled').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ selectionEnabled: e.target.checked });
    notice('langNotice', `划词翻译已${e.target.checked ? '开启' : '关闭'}`, 'ok');
  });

  $('btnRefresh').addEventListener('click', loadData);
  $('historyFilter').addEventListener('change', renderHistory);

  $('btnClearHistory').addEventListener('click', async () => {
    const res = await send({ type: 'CLEAR_HISTORY' });
    if (res.ok) {
      await loadData();
      notice('apiNotice', '翻译历史已清空（统计数据保留）', 'ok');
    }
  });

  $('btnResetStats').addEventListener('click', async () => {
    const res = await send({ type: 'RESET_STATS' });
    if (res.ok) {
      await loadData();
      notice('apiNotice', '统计数据已重置', 'ok');
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.history || changes.stats)) loadData();
    if (area === 'sync' && (changes.apiKey || changes.model)) {
      const key = changes.apiKey?.newValue;
      const model = changes.model?.newValue;
      updateHeader(!!key, model);
    }
  });

  const navItems = Array.from(document.querySelectorAll('.nav-item'));
  function syncNav() {
    navItems.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === location.hash));
  }
  navItems.forEach((a) => a.addEventListener('click', syncNav));
  window.addEventListener('hashchange', syncNav);
  if (!location.hash) navItems[0]?.classList.add('active');
}

await loadSettings();
await loadData();
bindEvents();
