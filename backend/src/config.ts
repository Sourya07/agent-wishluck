import 'dotenv/config';
import path from 'node:path';

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export type LlmProvider = 'openai' | 'anthropic' | 'gemini' | 'groq' | 'openrouter' | 'ollama' | 'none';

const provider = (process.env.LLM_PROVIDER || 'none').toLowerCase() as LlmProvider;

const defaultModels: Record<LlmProvider, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: 'gemini-2.0-flash',
  groq: 'llama-3.3-70b-versatile',
  openrouter: 'openai/gpt-4o-mini',
  ollama: 'qwen2.5:7b-instruct',
  none: 'none',
};

const defaultBaseUrls: Record<LlmProvider, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ollama: 'http://localhost:11434/v1',
  none: '',
};

const port = num(process.env.PORT, 4000);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port,
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${port}`,
  /** Where the customer-facing pages (tracking, payment) live. In dev the Vite server, in Docker the same origin. */
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  dbPath: process.env.DB_PATH || path.resolve(process.cwd(), 'data', 'wishluck.db'),
  redisUrl: process.env.REDIS_URL || '',
  secrets: {
    orderWebhook: process.env.ORDER_WEBHOOK_SECRET || 'dev-order-webhook-secret',
    courierWebhook: process.env.COURIER_WEBHOOK_SECRET || 'dev-courier-webhook-secret',
    shopifyWebhook: process.env.SHOPIFY_WEBHOOK_SECRET || '',
    dashboardToken: process.env.DASHBOARD_TOKEN || '',
  },
  courier: {
    /** The mock courier is a separate HTTP service (mounted on this server by default). We only talk to it over HTTP. */
    baseUrl: process.env.COURIER_API_URL || `http://localhost:${port}/mock-courier`,
    webhookTarget: process.env.COURIER_WEBHOOK_TARGET || `http://localhost:${port}/webhooks/courier`,
    timeoutMs: num(process.env.COURIER_TIMEOUT_MS, 4000),
  },
  llm: {
    provider,
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || defaultModels[provider],
    baseUrl: process.env.LLM_BASE_URL || defaultBaseUrls[provider],
    timeoutMs: num(process.env.LLM_TIMEOUT_MS, 20000),
    maxRetries: num(process.env.LLM_MAX_RETRIES, 2),
    maxToolRounds: num(process.env.LLM_MAX_TOOL_ROUNDS, 6),
  },
  whatsapp: {
    enabled: !!process.env.WHATSAPP_TOKEN,
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || 'wishluck-verify',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
  },
};

export const llmConfigured = () =>
  config.llm.provider !== 'none' && (config.llm.provider === 'ollama' || !!config.llm.apiKey);
