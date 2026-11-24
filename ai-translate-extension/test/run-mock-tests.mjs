/**
 * 使用本地 Mock 服务器运行 API 测试（验证插件后端逻辑全链路）
 */
import { startMockServer } from './mock-server.mjs';
import { spawn } from 'node:child_process';

const { server, port } = await startMockServer();
console.log(`Mock OpenAI 服务器已启动: http://127.0.0.1:${port}/chat/completions\n`);

const child = spawn(process.execPath, ['test/api.test.mjs'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    AITX_API_KEY: 'mock-key',
    AITX_BASE_URL: `http://127.0.0.1:${port}`,
    AITX_MODEL: 'mock-model',
  },
});

child.on('close', (code) => {
  server.close();
  process.exit(code ?? 1);
});
