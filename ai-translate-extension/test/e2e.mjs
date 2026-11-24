/**
 * 端到端测试：真实 Chromium（Edge）加载插件
 * 两种模式：
 *   默认（Mock）：      本地 Mock OpenAI 服务器，快速、稳定、可断言请求细节
 *   真实 API（Real）：  AITX_E2E_REAL=1 AITX_API_KEY=sk-xxx node test/e2e.mjs
 * 覆盖：整页翻译（英→中 / 中→英）、隐藏/显示原文、恢复原状、
 *       划词翻译、网页总结、popup 设置与测试连接。
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './mock-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '../ext');
const PAGES_DIR = path.resolve(__dirname, './pages');
const ARTIFACTS = path.resolve(__dirname, './artifacts');
const PROFILE = path.resolve(__dirname, './.playwright-profile');
fs.rmSync(ARTIFACTS, { recursive: true, force: true });
fs.mkdirSync(ARTIFACTS, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });

const REAL = process.env.AITX_E2E_REAL === '1';
// 真实推理模型耗时较长，放宽等待
const T = REAL
  ? { translate: 150000, summary: 240000, sel: 90000 }
  : { translate: 15000, summary: 15000, sel: 15000 };

/* ---------- 静态页面服务器（避免 file:// 权限问题） ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
const pageServer = http.createServer((req, res) => {
  const file = path.join(PAGES_DIR, req.url.replace(/\?.*$/, '').replace(/^\/+/, '') || 'sample-en.html');
  if (!file.startsWith(PAGES_DIR) || !fs.existsSync(file)) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => pageServer.listen(18768, '127.0.0.1', r));
const PAGE_BASE = 'http://127.0.0.1:18768';

const { server: mock, port: MOCK_PORT, requests } = await startMockServer();

const desiredSettings = REAL
  ? {
      apiKey: process.env.AITX_API_KEY || '',
      baseUrl: process.env.AITX_BASE_URL || 'https://api.deepseek.com',
      model: process.env.AITX_MODEL || 'deepseek-v4-flash',
      selectionEnabled: true,
    }
  : {
      apiKey: 'mock-key',
      baseUrl: `http://127.0.0.1:${MOCK_PORT}`,
      model: 'mock-model',
      selectionEnabled: true,
    };
console.log(`E2E 模式: ${REAL ? '真实 API' : 'Mock'}`);
if (REAL) console.log(`API: ${desiredSettings.baseUrl} / ${desiredSettings.model}`);

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; failures.push({ name, detail }); console.log(`  ✘ ${name}${detail ? ` —— ${detail}` : ''}`); }
}

let context;
try {
  /* ---------- 启动浏览器并加载插件 ---------- */
  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    channel: 'msedge',
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
  });
  let sw = context.serviceWorkers().find((w) => w.url().includes('service-worker'));
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 20000 });
  const extId = new URL(sw.url()).host;
  console.log(`插件已加载，ID: ${extId}\n`);

  // 预置插件设置；轮询确认写入成功（防止任何初始化竞态）
  let settingsOk = false;
  for (let i = 0; i < 10; i++) {
    await sw.evaluate((d) => chrome.storage.sync.set(d), desiredSettings);
    await new Promise((r) => setTimeout(r, 300));
    const cur = await sw.evaluate(() => chrome.storage.sync.get(['apiKey', 'baseUrl', 'model']));
    if (
      cur.baseUrl === desiredSettings.baseUrl &&
      cur.model === desiredSettings.model &&
      cur.apiKey === desiredSettings.apiKey
    ) { settingsOk = true; break; }
  }
  check('插件设置预置成功', settingsOk);

  /** 从 Service Worker 向指定页面发消息（模拟 popup 操作） */
  async function sendToPage(page, msg) {
    const url = page.url().split('#')[0];
    const tabId = await sw.evaluate(async (u) => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find((x) => x.url && x.url.split('#')[0] === u);
      return t?.id ?? null;
    }, url);
    if (tabId == null) throw new Error(`未找到标签页: ${url}`);
    return sw.evaluate(({ id, m }) => new Promise((resolve) => {
      chrome.tabs.sendMessage(id, m, (res) => {
        const err = chrome.runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : res);
      });
    }), { id: tabId, m: msg });
  }

  /* ---------- 1. 整页翻译：英文 → 中文 ---------- */
  console.log('[E2E] 整页翻译 英→中');
  const pageEn = await context.newPage();
  await pageEn.goto(`${PAGE_BASE}/sample-en.html`);
  await pageEn.waitForSelector('article p');
  const r1 = await sendToPage(pageEn, { type: 'TRANSLATE_PAGE' });
  check('TRANSLATE_PAGE 返回成功', r1?.ok === true, JSON.stringify(r1).slice(0, 200));
  await pageEn.waitForSelector('.aitx-trans', { timeout: T.translate });
  const enStats = await pageEn.evaluate(() => ({
    trans: document.querySelectorAll('.aitx-trans').length,
    orig: document.querySelectorAll('.aitx-orig').length,
    firstOrig: document.querySelector('.aitx-orig')?.textContent || '',
    firstTrans: document.querySelector('.aitx-trans')?.textContent || '',
    sampleTrans: Array.from(document.querySelectorAll('.aitx-trans')).map((e) => e.textContent).join('|').slice(0, 300),
  }));
  check('译文段落 ≥ 5', enStats.trans >= 5, `实际 ${enStats.trans}`);
  check('原文段落保留（双语）', enStats.orig >= 5, `实际 ${enStats.orig}`);
  check('译文含中文（英→中）', /[\u4e00-\u9fff]/.test(enStats.sampleTrans), enStats.sampleTrans.slice(0, 150));
  check('译文确实经过 AI（非原文）', enStats.sampleTrans !== enStats.firstOrig && /[\u4e00-\u9fff]/.test(enStats.firstTrans), enStats.firstTrans.slice(0, 100));
  if (!REAL) check('译文来自 Mock 管道', enStats.sampleTrans.includes('[MOCK-ZH]'), enStats.sampleTrans.slice(0, 120));
  await pageEn.screenshot({ path: path.join(ARTIFACTS, '1-fullpage-en2zh.png'), fullPage: false });

  /* ---------- 2. 隐藏/显示原文 ---------- */
  console.log('[E2E] 隐藏/显示原文');
  const r2 = await sendToPage(pageEn, { type: 'TOGGLE_ORIGINAL' });
  check('切换原文返回 hidingOriginal=true', r2?.ok && r2?.data?.hidingOriginal === true, JSON.stringify(r2));
  const origHidden = await pageEn.evaluate(() => {
    const el = document.querySelector('.aitx-orig');
    return getComputedStyle(el).display === 'none';
  });
  check('原文已隐藏 (display:none)', origHidden);
  await pageEn.screenshot({ path: path.join(ARTIFACTS, '2-original-hidden.png') });
  const r2b = await sendToPage(pageEn, { type: 'TOGGLE_ORIGINAL' });
  check('再次切换恢复显示', r2b?.ok && r2b?.data?.hidingOriginal === false);
  const origShown = await pageEn.evaluate(() => {
    const el = document.querySelector('.aitx-orig');
    return getComputedStyle(el).display !== 'none';
  });
  check('原文恢复显示', origShown);

  /* ---------- 3. 划词翻译 ---------- */
  console.log('[E2E] 划词翻译');
  await pageEn.evaluate(() => {
    const p = document.querySelectorAll('article p')[1];
    const range = document.createRange();
    range.selectNodeContents(p);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await pageEn.waitForSelector('.aitx-selbtn.aitx-show', { timeout: 5000 });
  check('划词按钮出现', true);
  await pageEn.click('.aitx-selbtn');
  await pageEn.waitForSelector('.aitx-selbox-body', { timeout: T.sel });
  await pageEn.waitForFunction(() => {
    const el = document.querySelector('.aitx-selbox-body');
    return el && el.textContent.trim().length > 2 && !el.textContent.includes('翻译中');
  }, { timeout: T.sel });
  const selInfo = await pageEn.evaluate(() => ({
    text: document.querySelector('.aitx-selbox-body')?.textContent || '',
    orig: document.querySelectorAll('article p')[1]?.textContent || '',
  }));
  check('划词译文含中文', /[\u4e00-\u9fff]/.test(selInfo.text), selInfo.text.slice(0, 120));
  check('划词译文为 AI 翻译结果', selInfo.text.trim() !== selInfo.orig.trim(), selInfo.text.slice(0, 120));
  if (!REAL) check('划词译文来自 Mock 管道', selInfo.text.includes('[MOCK-T-ZH]'), selInfo.text.slice(0, 120));
  await pageEn.screenshot({ path: path.join(ARTIFACTS, '3-selection.png') });
  await pageEn.click('.aitx-selbox-close');
  const boxGone = await pageEn.evaluate(() => !document.querySelector('.aitx-selbox'));
  check('关闭划词气泡', boxGone);

  /* ---------- 4. 网页总结 ---------- */
  console.log('[E2E] 网页总结');
  const r4 = await sendToPage(pageEn, { type: 'SUMMARIZE_PAGE' });
  check('SUMMARIZE_PAGE 返回成功', r4?.ok === true, JSON.stringify(r4).slice(0, 200));
  await pageEn.waitForSelector('.aitx-modal.aitx-show', { timeout: T.summary });
  await pageEn.waitForFunction(() => {
    const el = document.querySelector('.aitx-modal-body');
    return el && el.textContent.replace(/\s/g, '').length > 60 && !el.textContent.includes('正在阅读');
  }, { timeout: T.summary });
  const sumText = await pageEn.evaluate(() => document.querySelector('.aitx-modal-body')?.textContent || '');
  check(
    '总结为结构化内容',
    /一句话总结|核心要点|关键结论|TL;DR|Key Points|Conclusion/.test(sumText),
    sumText.slice(0, 150),
  );
  if (!REAL) check('总结含 Mock 标记', sumText.includes('[MOCK]'), sumText.slice(0, 120));
  await pageEn.screenshot({ path: path.join(ARTIFACTS, '4-summary.png') });
  const closeBtn = await pageEn.$$('.aitx-modal-foot .aitx-btn');
  await closeBtn[closeBtn.length - 1].click();
  const modalGone = await pageEn.evaluate(() => !document.querySelector('.aitx-modal'));
  check('关闭总结弹窗', modalGone);

  /* ---------- 5. 恢复原状 ---------- */
  console.log('[E2E] 恢复原状');
  const r5 = await sendToPage(pageEn, { type: 'RESET_TRANSLATION' });
  check('RESET 返回成功', r5?.ok === true, JSON.stringify(r5));
  const afterReset = await pageEn.evaluate(() => ({
    trans: document.querySelectorAll('.aitx-trans').length,
    orig: document.querySelectorAll('.aitx-orig').length,
  }));
  check('译文与包裹节点全部移除', afterReset.trans === 0 && afterReset.orig === 0, JSON.stringify(afterReset));

  /* ---------- 6. 整页翻译：中文 → 英文 ---------- */
  console.log('[E2E] 整页翻译 中→英');
  const pageZh = await context.newPage();
  await pageZh.goto(`${PAGE_BASE}/sample-zh.html`);
  await pageZh.waitForSelector('article p');
  const r6 = await sendToPage(pageZh, { type: 'TRANSLATE_PAGE' });
  check('中文页翻译返回成功', r6?.ok === true, JSON.stringify(r6).slice(0, 200));
  await pageZh.waitForSelector('.aitx-trans', { timeout: T.translate });
  const zhStats = await pageZh.evaluate(() => ({
    sample: Array.from(document.querySelectorAll('.aitx-trans')).map((e) => e.textContent).join('|').slice(0, 300),
    orig: document.querySelectorAll('.aitx-orig').length,
    firstOrig: document.querySelector('.aitx-orig')?.textContent || '',
    firstTrans: document.querySelector('.aitx-trans')?.textContent || '',
  }));
  check('中文页译文为英文方向', /[a-zA-Z]{4,}/.test(zhStats.sample) && zhStats.firstTrans !== zhStats.firstOrig, zhStats.firstTrans.slice(0, 150));
  if (!REAL) check('中文页译文含 Mock 标记', zhStats.sample.includes('[MOCK-EN]'), zhStats.sample.slice(0, 120));
  check('中文页原文保留', zhStats.orig >= 5);
  await pageZh.screenshot({ path: path.join(ARTIFACTS, '5-fullpage-zh2en.png') });

  /* ---------- 7. Popup 设置页 ---------- */
  console.log('[E2E] Popup 配置界面');
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await popup.waitForSelector('#apiKey');
  const kv = await popup.evaluate(() => ({
    apiKey: document.getElementById('apiKey').value,
    baseUrl: document.getElementById('baseUrl').value,
    model: document.getElementById('model').value,
    sel: document.getElementById('selEnabled').checked,
  }));
  check('设置已持久化 (Key)', kv.apiKey === desiredSettings.apiKey, kv.apiKey);
  check('设置已持久化 (BaseUrl)', kv.baseUrl.includes(REAL ? 'deepseek' : String(MOCK_PORT)), kv.baseUrl);
  check('设置已持久化 (模型)', kv.model === desiredSettings.model, kv.model);
  check('划词开关状态正确', kv.sel === true);

  // 测试连接按钮
  await popup.click('#btnTest');
  await popup.waitForFunction(() => {
    const el = document.getElementById('testStatus');
    return el && (el.textContent.includes('连接成功') || el.textContent.includes('失败'));
  }, { timeout: REAL ? 60000 : 20000 });
  const testMsg = await popup.evaluate(() => document.getElementById('testStatus').textContent);
  check('popup 测试连接成功', testMsg.includes('连接成功'), testMsg);

  // 修改并保存设置
  await popup.fill('#model', desiredSettings.model + '-saved');
  await popup.click('#btnSave');
  const saved = await sw.evaluate(() => chrome.storage.sync.get(['model']));
  check('popup 保存设置生效', saved.model === desiredSettings.model + '-saved', JSON.stringify(saved));
  await popup.screenshot({ path: path.join(ARTIFACTS, '6-popup.png') });

  /* ---------- 8. 管理面板：配置 / 历史 / 统计 / 语言切换 ---------- */
  console.log('[E2E] 管理面板');
  await sw.evaluate((m) => chrome.storage.sync.set({ model: m }), desiredSettings.model);
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extId}/options/options.html`);
  await options.waitForSelector('#historyBody tr', { timeout: 10000 });
  const histText = await options.evaluate(() => document.getElementById('historyBody').textContent);
  check('历史记录有内容', histText.length > 20, histText.slice(0, 100));
  check('历史包含整页翻译', histText.includes('整页'));
  check('历史包含划词翻译', histText.includes('划词'));
  check('历史包含网页总结', histText.includes('总结'));
  const reqCount = Number((await options.textContent('#statRequests')).replace(/,/g, ''));
  const tokenCount = Number((await options.textContent('#statTokens')).replace(/,/g, ''));
  check('统计请求数 > 0', reqCount >= 4, `实际 ${reqCount}`);
  check('Token 累计 > 0', tokenCount > 0, `实际 ${tokenCount}`);
  check('配置回显 API Key', (await options.inputValue('#apiKey')) === desiredSettings.apiKey);
  check('配置回显 BaseUrl', (await options.inputValue('#baseUrl')).includes(REAL ? 'deepseek' : String(MOCK_PORT)));
  await options.screenshot({ path: path.join(ARTIFACTS, '7-options.png'), fullPage: true });

  // 语言切换：固定目标为英文后，英文页面应直接译为英文（Mock 管道）
  if (!REAL) {
    await options.selectOption('#targetLang', 'en');
    await options.click('#btnSaveLang');
    check('语言设置保存后提示可见', (await options.textContent('#langNotice')).includes('已保存'));
    const dirText = await options.textContent('#directionBadge');
    check('方向预览显示固定英文', dirText.includes('英文'), dirText);
    const pageForced = await context.newPage();
    await pageForced.goto(`${PAGE_BASE}/sample-en.html?forced=1`);
    await pageForced.waitForSelector('article p');
    const forcedRes = await sendToPage(pageForced, { type: 'TRANSLATE_PAGE' });
    check('固定目标语言后翻译成功', forcedRes?.ok === true, JSON.stringify(forcedRes).slice(0, 150));
    await pageForced.waitForSelector('.aitx-trans', { timeout: T.translate });
    const forcedText = await pageForced.evaluate(() =>
      Array.from(document.querySelectorAll('.aitx-trans')).map((e) => e.textContent).join('|').slice(0, 120),
    );
    check('目标语言切换生效（译为英文）', forcedText.includes('[MOCK-EN]'), forcedText);
    await sw.evaluate(() => chrome.storage.sync.set({ targetLang: 'auto' }));
    await pageForced.close();
  }

  // 清空历史不影响累计统计
  const beforeClear = Number((await options.textContent('#statRequests')).replace(/,/g, ''));
  await options.click('#btnClearHistory');
  await options.waitForFunction(() => document.querySelectorAll('#historyBody tr').length === 0, { timeout: 5000 });
  check('清空历史生效', (await options.locator('#historyBody tr').count()) === 0);
  check('统计在清空历史后保留', Number((await options.textContent('#statRequests')).replace(/,/g, '')) === beforeClear);

  /* ---------- 9. 请求规范校验（仅 Mock 模式） ---------- */
  if (!REAL) {
    console.log('[E2E] 请求规范校验');
    check('Mock 收到请求', requests.length >= 5, `实际 ${requests.length}`);
    check('鉴权头正确', requests.every((r) => r.auth === 'Bearer mock-key'));
    check('使用用户配置的模型', requests.every((r) => !!r.model));
    const batchReq = requests.find((r) => JSON.stringify(r.messages || '').includes('webpage translation engine'));
    check('批量翻译请求结构正确', !!batchReq && /Translate the following \d+ segment/.test(batchReq.messages.at(-1).content));
  }

  console.log(`\n=== E2E 结果（${REAL ? '真实 API' : 'Mock'}）：${passed} 通过，${failed} 失败 ===`);
  console.log(`截图与产物: ${ARTIFACTS}`);
  if (failures.length) {
    for (const f of failures) console.log(` - ${f.name}: ${String(f.detail).slice(0, 200)}`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('E2E 异常中断:', e?.message || e);
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {});
  pageServer.close();
  mock.close();
  process.exit(process.exitCode ?? 0);
}
