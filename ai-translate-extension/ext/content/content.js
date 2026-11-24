/**
 * AI 翻译助手 —— 内容脚本
 * 功能：整页双语翻译 / 划词翻译 / 网页总结（页面内 UI）
 */
(() => {
  'use strict';
  if (window.__AITX_CONTENT__) return;
  window.__AITX_CONTENT__ = true;

  const ROOT_CLASS = 'aitx-root';
  const SKIP_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'select', 'option',
    'svg', 'iframe', 'canvas', 'object', 'embed', 'code', 'pre', 'button',
    'audio', 'video', '[contenteditable]', '[aria-hidden="true"]',
  ].join(',');

  const state = {
    busy: false,          // 整页翻译进行中
    busySummary: false,   // 总结进行中
    translated: false,
    cache: new Map(),     // `${target}|${text}` -> 译文
    pageLang: null,
    selectionEnabled: true,
    selTarget: 'auto',    // auto | zh | en
  };

  /* ---------------- 基础工具 ---------------- */

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError; // 消除“未检查 lastError”告警
          resolve(res || { ok: false, error: '后台服务无响应，请重试' });
        });
      } catch (e) {
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });

  function isChinese(s) {
    const str = String(s);
    const cjk = (str.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    return cjk / Math.max(str.replace(/\s/g, '').length, 1) > 0.2;
  }

  function detectPageLang() {
    if (state.pageLang) return state.pageLang;
    const sample = (document.body?.innerText || '').slice(0, 4000);
    state.pageLang = isChinese(sample) ? 'zh' : 'en';
    return state.pageLang;
  }

  function selectionTarget(text) {
    if (state.selTarget === 'zh') return 'zh';
    if (state.selTarget === 'en') return 'en';
    return isChinese(text) ? 'en' : 'zh'; // 中英自动互译
  }

  // 读取设置并监听变更
  chrome.storage.sync.get({ selectionEnabled: true, selTarget: 'auto' }, (cfg) => {
    state.selectionEnabled = cfg.selectionEnabled !== false;
    state.selTarget = cfg.selTarget || 'auto';
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.selectionEnabled) state.selectionEnabled = changes.selectionEnabled.newValue !== false;
    if (changes.selTarget) state.selTarget = changes.selTarget.newValue || 'auto';
  });

  function clampToViewport(x, y, w, h) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left: Math.max(8, Math.min(x, vw - w - 8)),
      top: Math.max(8, Math.min(y, vh - h - 8)),
    };
  }

  /* ---------------- Toast ---------------- */

  let toastEl = null;
  let toastTimer = null;

  function showToast(text, opts = {}) {
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.className = `aitx-toast ${ROOT_CLASS}`;
      (document.body || document.documentElement).appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('aitx-show');
    toastEl.classList.toggle('aitx-toast-error', !!opts.error);
    clearTimeout(toastTimer);
    if (!opts.sticky) toastTimer = setTimeout(() => toastEl?.classList.remove('aitx-show'), opts.duration || 2600);
    return toastEl;
  }

  function hideToast() {
    toastEl?.classList.remove('aitx-show');
  }

  /* ---------------- 整页翻译 ---------------- */

  function collectSegments() {
    const segments = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`.${ROOT_CLASS}`)) return NodeFilter.FILTER_REJECT; // 插件自身 UI
        if (parent.classList.contains('aitx-orig')) return NodeFilter.FILTER_REJECT; // 已翻译
        const text = node.nodeValue;
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
        if (text.trim().length < 2 && !/[\u4e00-\u9fff]/.test(text)) return NodeFilter.FILTER_REJECT;
        const cs = getComputedStyle(parent);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue.trim();
      if (text) segments.push({ node, text });
    }
    return segments;
  }

  function applyTranslation(entry, translated) {
    const { node } = entry;
    const parent = node.parentElement;
    if (!parent || !parent.isConnected) return;
    // 1) 包裹原文（便于“隐藏原文”）
    let wrap = parent;
    if (!parent.classList.contains('aitx-orig')) {
      wrap = document.createElement('span');
      wrap.className = 'aitx-orig';
      parent.insertBefore(wrap, node);
      wrap.appendChild(node);
    }
    // 2) 插入译文
    const span = document.createElement('span');
    span.className = `aitx-trans ${ROOT_CLASS}`;
    span.textContent = translated;
    const host = wrap.parentElement;
    if (host) {
      const display = getComputedStyle(host).display;
      const blockish = /block|list-item|flex|grid|flow-root|table-cell/.test(display);
      const onlyChild = host.childElementCount === 1 && host.contains(wrap);
      if (blockish && onlyChild) span.classList.add('aitx-block');
    }
    wrap.insertAdjacentElement('afterend', span);
  }

  const BATCH = { maxChars: 2400, maxCount: 20, concurrency: 2 };

  async function translatePage() {
    if (state.busy) {
      showToast('正在翻译中，请稍候…');
      return { ok: false, error: 'busy' };
    }
    let segments = [];
    try {
      segments = collectSegments();
    } catch {
      /* ignore */
    }
    if (!segments.length) {
      showToast(state.translated ? '页面没有新的可翻译内容' : '未找到可翻译的文本');
      return { ok: true, translated: state.translated };
    }
    const target = detectPageLang() === 'zh' ? 'en' : 'zh';
    state.busy = true;
    try {
      // 命中缓存的段落直接应用
      const pending = [];
      for (const seg of segments) {
        const key = `${target}|${seg.text}`;
        if (state.cache.has(key)) applyTranslation(seg, state.cache.get(key));
        else pending.push(seg);
      }

      // 分批
      const batches = [];
      let cur = [];
      let chars = 0;
      for (const seg of pending) {
        if (cur.length && (cur.length >= BATCH.maxCount || chars + seg.text.length > BATCH.maxChars)) {
          batches.push(cur);
          cur = [];
          chars = 0;
        }
        cur.push(seg);
        chars += seg.text.length;
        if (seg.text.length > BATCH.maxChars) {
          batches.push(cur); // 超长段落单独成批
          cur = [];
          chars = 0;
        }
      }
      if (cur.length) batches.push(cur);

      if (!batches.length) {
        state.translated = true;
        showToast('已应用缓存翻译，页面为最新状态');
        return { ok: true, translated: true, target };
      }

      const total = batches.length;
      let done = 0;
      let failed = 0;
      let firstError = null;
      if (total) showToast(`AI 翻译中… 0/${total} 批`, { sticky: true });

      const worker = async () => {
        while (batches.length) {
          const batch = batches.shift();
          const texts = batch.map((s) => s.text);
          const res = await send({ type: 'TRANSLATE_SEGMENTS', texts, target });
          done += 1;
          if (res.ok && Array.isArray(res.data) && res.data.length === texts.length) {
            batch.forEach((seg, i) => {
              const t = res.data[i];
              if (typeof t === 'string' && t) {
                state.cache.set(`${target}|${seg.text}`, t);
                try { applyTranslation(seg, t); } catch { /* 节点可能已变化 */ }
              }
            });
          } else {
            failed += 1;
            if (!firstError) firstError = res.error || '未知错误';
          }
          showToast(`AI 翻译中… ${done}/${total} 批`, { sticky: true });
        }
      };
      await Promise.all(Array.from({ length: Math.min(BATCH.concurrency, total) }, worker));

      state.translated = true;
      if (failed) {
        showToast(`翻译完成，${failed}/${total} 批失败：${firstError}`, { error: true, duration: 7000 });
        return { ok: false, error: firstError, translated: true, target };
      }
      showToast(`翻译完成（共 ${pending.length} 段 / ${total} 批，${target === 'en' ? '中 → 英' : '英 → 中'}）`);
      return { ok: true, translated: true, target };
    } catch (e) {
      showToast(`翻译失败：${e?.message || e}`, { error: true, duration: 6000 });
      return { ok: false, error: e?.message || String(e), translated: state.translated, target };
    } finally {
      state.busy = false;
      hideToast();
    }
  }

  function toggleOriginal() {
    const hiding = document.documentElement.classList.toggle('aitx-hide-orig');
    return { ok: true, data: { hidingOriginal: hiding } };
  }

  function resetTranslation() {
    document.querySelectorAll('.aitx-trans').forEach((el) => el.remove());
    document.querySelectorAll('span.aitx-orig').forEach((w) => {
      const parent = w.parentElement;
      if (!parent) return;
      while (w.firstChild) parent.insertBefore(w.firstChild, w);
      w.remove();
    });
    document.documentElement.classList.remove('aitx-hide-orig');
    state.translated = false;
    state.cache.clear();
    hideToast();
    return { ok: true };
  }

  /* ---------------- 划词翻译 ---------------- */

  let selBtn = null;
  let selBox = null;
  let selAnchor = null;
  let lastBtnPos = null;

  function ensureSelBtn() {
    if (selBtn?.isConnected) return selBtn;
    selBtn = document.createElement('div');
    selBtn.className = `aitx-selbtn ${ROOT_CLASS}`;
    selBtn.textContent = '译';
    selBtn.title = 'AI 翻译选中文本';
    selBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 防止选区丢失
    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      onSelBtnClick();
    });
    (document.body || document.documentElement).appendChild(selBtn);
    return selBtn;
  }

  function hideSelBtn() {
    selBtn?.remove();
    selBtn = null;
  }

  document.addEventListener('mouseup', (e) => {
    hideSelBox();
    if (!state.selectionEnabled) {
      hideSelBtn();
      return;
    }
    if (e.target?.closest?.(`.${ROOT_CLASS}`)) return;
    const sel = window.getSelection();
    const text = sel ? String(sel).trim() : '';
    if (!sel || sel.isCollapsed || !text || text.length < 2 || text.length > 3000 || !sel.rangeCount) {
      hideSelBtn();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideSelBtn();
      return;
    }
    selAnchor = { text, target: selectionTarget(text) };
    const btn = ensureSelBtn();
    const pos = clampToViewport(rect.left + rect.width / 2 - 14, rect.bottom + 6, 28, 28);
    lastBtnPos = { x: pos.left, y: pos.top };
    btn.style.left = `${pos.left}px`;
    btn.style.top = `${pos.top}px`;
    btn.classList.add('aitx-show');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideSelBox();
      hideSelBtn();
    }
  });

  async function onSelBtnClick() {
    if (!selAnchor) return;
    const { text, target } = selAnchor;
    hideSelBtn();
    showSelBox({ loading: true, target });
    const res = await send({ type: 'TRANSLATE_TEXT', text, target });
    if (selBox?.isConnected) {
      if (res.ok) showSelBox({ text: res.data, target, original: text });
      else showSelBox({ error: res.error, target });
    }
  }

  function showSelBox({ loading, text, error, target }) {
    hideSelBox();
    selBox = document.createElement('div');
    selBox.className = `aitx-selbox ${ROOT_CLASS}`;

    const head = document.createElement('div');
    head.className = 'aitx-selbox-head';
    const title = document.createElement('span');
    title.className = 'aitx-selbox-title';
    title.textContent = loading ? 'AI 翻译中…' : `AI 翻译 · → ${target === 'en' ? 'English' : '中文'}`;
    const close = document.createElement('span');
    close.className = 'aitx-selbox-close';
    close.textContent = '×';
    close.title = '关闭 (Esc)';
    close.addEventListener('click', hideSelBox);
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'aitx-selbox-body';
    if (loading) {
      const sp = document.createElement('span');
      sp.className = 'aitx-spinner';
      body.append(sp, document.createTextNode(' 正在翻译，请稍候…'));
    } else if (error) {
      body.classList.add('aitx-selbox-error');
      body.textContent = `翻译失败：${error}`;
    } else {
      body.textContent = text;
    }

    selBox.append(head, body);

    if (!loading && !error) {
      const foot = document.createElement('div');
      foot.className = 'aitx-selbox-foot';
      const copy = document.createElement('button');
      copy.className = 'aitx-mini-btn';
      copy.textContent = '复制译文';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = '已复制';
          setTimeout(() => (copy.textContent = '复制译文'), 1500);
        } catch {
          copy.textContent = '复制失败';
        }
      });
      foot.append(copy);
      selBox.append(foot);
    }

    (document.body || document.documentElement).appendChild(selBox);
    const w = selBox.offsetWidth || 380;
    const h = selBox.offsetHeight || 140;
    const anchorX = lastBtnPos?.x ?? window.innerWidth / 2;
    const anchorY = lastBtnPos?.y ?? 120;
    const pos = clampToViewport(anchorX - w / 2 + 14, anchorY + 34, w, h);
    selBox.style.left = `${pos.left}px`;
    selBox.style.top = `${pos.top}px`;
    requestAnimationFrame(() => selBox?.classList.add('aitx-show'));
  }

  function hideSelBox() {
    selBox?.remove();
    selBox = null;
  }

  /* ---------------- 网页总结 ---------------- */

  function extractMainText() {
    const cand =
      document.querySelector('article') ||
      document.querySelector('main') ||
      document.querySelector('[role="main"]') ||
      document.body;
    let text = cand?.innerText || '';
    text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return text;
  }

  let sumModal = null;

  function showSummaryModal(opts) {
    hideSummaryModal();
    sumModal = document.createElement('div');
    sumModal.className = `aitx-modal ${ROOT_CLASS}`;
    const card = document.createElement('div');
    card.className = 'aitx-modal-card';

    const head = document.createElement('div');
    head.className = 'aitx-modal-head';
    const title = document.createElement('h3');
    title.className = 'aitx-modal-title';
    title.textContent = '网页总结';
    const sub = document.createElement('div');
    sub.className = 'aitx-modal-sub';
    sub.textContent = document.title || location.href;
    head.append(title, sub);

    const body = document.createElement('div');
    body.className = 'aitx-modal-body';

    if (opts.loading) {
      const loading = document.createElement('div');
      loading.className = 'aitx-modal-loading';
      const sp = document.createElement('span');
      sp.className = 'aitx-spinner';
      loading.append(sp, document.createTextNode('正在阅读页面并生成总结…（约需 10~60 秒）'));
      body.append(loading);
    } else if (opts.error) {
      body.classList.add('aitx-modal-error');
      body.textContent = `总结失败：${opts.error}`;
    } else {
      renderMarkdown(body, opts.markdown || '');
    }

    const foot = document.createElement('div');
    foot.className = 'aitx-modal-foot';
    if (opts.error) {
      const retry = document.createElement('button');
      retry.className = 'aitx-btn';
      retry.textContent = '重试';
      retry.addEventListener('click', () => summarizePage());
      foot.append(retry);
    } else if (!opts.loading) {
      const copy = document.createElement('button');
      copy.className = 'aitx-btn aitx-btn-plain';
      copy.textContent = '复制全文';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(opts.markdown || '');
          copy.textContent = '已复制';
          setTimeout(() => (copy.textContent = '复制全文'), 1500);
        } catch {
          copy.textContent = '复制失败';
        }
      });
      foot.append(copy);
    }
    const close = document.createElement('button');
    close.className = `aitx-btn ${opts.error ? 'aitx-btn-plain' : ''}`;
    close.textContent = '关闭';
    close.addEventListener('click', hideSummaryModal);
    foot.append(close);

    card.append(head, body, foot);
    sumModal.append(card);
    sumModal.addEventListener('click', (e) => {
      if (e.target === sumModal) hideSummaryModal();
    });
    (document.body || document.documentElement).appendChild(sumModal);
    requestAnimationFrame(() => sumModal?.classList.add('aitx-show'));
  }

  function hideSummaryModal() {
    sumModal?.remove();
    sumModal = null;
  }

  async function summarizePage() {
    if (state.busySummary) {
      showToast('正在生成总结，请稍候…');
      return { ok: false, error: 'busy' };
    }
    const text = extractMainText();
    if (text.length < 200) {
      showToast('页面正文内容太少，无法生成总结');
      return { ok: false, error: '页面正文过少' };
    }
    state.busySummary = true;
    showSummaryModal({ loading: true });
    try {
      const res = await send({
        type: 'SUMMARIZE',
        title: document.title,
        url: location.href,
        text: text.slice(0, 20000),
        lang: 'zh',
      });
      if (res.ok) showSummaryModal({ markdown: res.data });
      else showSummaryModal({ error: res.error });
      return { ok: !!res.ok, error: res.error };
    } finally {
      state.busySummary = false;
    }
  }

  /* ---------------- 轻量 Markdown 渲染 ---------------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function renderMarkdown(el, md) {
    const lines = String(md).split(/\r?\n/);
    let html = '';
    let inList = false;
    const inline = (s) =>
      escapeHtml(s)
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^#{1,6}\s+/.test(line)) {
        if (inList) { html += '</ul>'; inList = false; }
        const level = Math.min(line.match(/^#+/)[0].length, 4);
        html += `<h${level}>${inline(line.replace(/^#+\s+/, ''))}</h${level}>`;
      } else if (/^[-*•]\s+/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(line.replace(/^[-*•]\s+/, ''))}</li>`;
      } else if (!line.trim()) {
        if (inList) { html += '</ul>'; inList = false; }
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += `<p>${inline(line)}</p>`;
      }
    }
    if (inList) html += '</ul>';
    el.innerHTML = html;
  }

  /* ---------------- 消息入口（popup -> 页面） ---------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        switch (msg?.type) {
          case 'GET_STATE':
            return sendResponse({
              ok: true,
              data: {
                translated: state.translated,
                busy: state.busy,
                target: detectPageLang() === 'zh' ? 'en' : 'zh',
              },
            });
          case 'TRANSLATE_PAGE':
            return sendResponse(await translatePage());
          case 'TOGGLE_ORIGINAL':
            return sendResponse(toggleOriginal());
          case 'RESET_TRANSLATION':
            return sendResponse(resetTranslation());
          case 'SUMMARIZE_PAGE':
            return sendResponse(await summarizePage());
          default:
            return sendResponse({ ok: false, error: `未知指令：${msg?.type}` });
        }
      } catch (e) {
        return sendResponse({ ok: false, error: e?.message || String(e) });
      }
    })();
    return true;
  });
})();
