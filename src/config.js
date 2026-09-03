import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));

export function loadConfig(env = process.env) {
  loadDotenv({ path: env.OA_ENV_FILE || new URL('../.env', import.meta.url), quiet: true, processEnv: env });
  const parsed = z.object({
    OA_BASE_URL: z.string().url(),
    OA_USERNAME: z.string().trim().min(1),
    OA_PASSWORD: z.string().min(1),
    OA_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(20000),
  }).safeParse(env);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map(issue => issue.path[0]))];
    throw new Error(`配置缺失或无效：${fields.join(', ')}。请检查 .env 或环境变量。`);
  }
  const url = new URL(parsed.data.OA_BASE_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('OA_BASE_URL 必须是 http/https 地址，不能包含凭据、查询参数或片段。');
  }
  return {
    baseUrl: url.href.replace(/\/+$/, ''),
    username: parsed.data.OA_USERNAME,
    password: parsed.data.OA_PASSWORD,
    timeoutMs: parsed.data.OA_TIMEOUT_MS,
  };
}
