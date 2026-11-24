# AI 翻译助手（Chrome 插件）

AI 驱动的网页翻译插件：**整页双语翻译 / 划词翻译 / 网页总结**，兼容 OpenAI 协议，API Key 与 BaseUrl 由用户自行配置（DeepSeek / OpenAI / 各类自建与中转服务均可）。

## 功能

| 功能 | 说明 |
| --- | --- |
| 整页翻译 | 自动识别页面语言，中英自动互译；译文以蓝色文字紧随原文（双语对照），支持批量并发、段落缓存、失败容错 |
| 隐藏/显示原文 | 一键在「双语对照」与「纯译文」之间切换 |
| 划词翻译 | 选中文字后点击「译」悬浮按钮，弹窗显示译文，支持一键复制；目标语言可设为 自动 / 中文 / 英文 |
| 网页总结 | 提取正文调用 AI 生成结构化总结（一句话总结 / 核心要点 / 关键结论），页面内弹窗展示，支持复制 |
| Popup 配置 | API Key、Base URL、模型均可视化配置，支持「测试连接」即时验证，并可一键打开管理面板 |
| 管理面板 | 独立 options 页面：API 配置、源/目标语言切换、最近 200 条翻译历史、Token 消耗统计（累计/分类/近 7 天图表） |

## 安装（开发者模式加载）

1. 打开 Chrome / Edge，访问 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本项目的 `ext` 目录
4. 点击工具栏图标，在「AI 服务设置」中填写 API Key 与 Base URL，保存后点击「测试连接」
5. 点击弹窗中的「管理面板」（或右键插件图标 → 选项）打开完整管理页面，可配置语言、查看历史与 Token 用量

> 注意：如需翻译本地文件（`file://` 页面），请在扩展详情页开启「允许访问文件网址」。

## 配置示例（OpenAI 协议）

| 服务商 | Base URL | 模型示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| OpenAI 官方 | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 其他兼容服务 | `https://你的域名`（自动拼接 `/chat/completions`） | 按服务商填写 |

## 目录结构

```
ext/                  插件本体（加载此目录）
  manifest.json       MV3 清单
  lib/api.js          共享 OpenAI 协议模块（提示词/解析/请求）
  background/         Service Worker：统一转发 AI 请求
  content/            内容脚本：整页翻译、划词气泡、总结弹窗 UI
  popup/              弹窗配置页（含管理面板入口）
  options/            管理面板：API 配置 / 语言切换 / 翻译历史 / Token 统计
  icons/              插件图标
  scripts/            图标生成脚本（node ext/scripts/gen-icons.cjs）
test/
  api.test.mjs        API 集成测试（单元 + 网络）
  mock-server.mjs     本地 Mock OpenAI 协议服务器
  run-mock-tests.mjs  Mock 全链路测试运行器
  e2e.mjs             端到端测试（真实 Edge 加载插件 + Mock API）
  pages/              中英文测试样例页面
  artifacts/          测试截图（gitignore）
```

## 测试

```bash
npm install

# 1. Mock 全链路测试（无需有效 API Key，覆盖后端逻辑）
npm run test:mock

# 2. 真实 API 测试（需要有效 Key，可用环境变量覆盖）
AITX_API_KEY=sk-xxx AITX_BASE_URL=https://api.deepseek.com AITX_MODEL=deepseek-chat npm run test:api

# 3. 浏览器端到端测试（自动启动 Edge 加载插件 + Mock 服务器，50 项断言 + 截图）
npm run test:e2e

# 4. 真实 API 端到端测试（使用你的 Key 验证全部功能与管理面板）
AITX_E2E_REAL=1 AITX_API_KEY=sk-xxx AITX_MODEL=deepseek-v4-flash npm run test:e2e
```

## 技术要点

- Chrome Manifest V3，Service Worker（ESM）统一代理 AI 请求，规避页面 CORS 限制
- 整页翻译基于 TreeWalker 采集可见文本节点，分批（20 段/2400 字）+ 并发 2 路请求，译文 JSON 逐段解析，容错 markdown 围栏
- 语言检测基于 CJK 字符比例，中英自动互译
- 消息通道：popup → tab（内容脚本）→ SW → API；内容脚本缺失时 popup 自动动态注入
