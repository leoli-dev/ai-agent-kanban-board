import type { EngineId } from '@akb/shared';

/**
 * Everything the guided provider builder knows about each provider family:
 * which engine runs it, where its Anthropic-compatible endpoint lives
 * (international + China where applicable), which secret name to use, and a
 * starter model list (every list also allows a custom model). Endpoints can
 * drift — the Test button is the source of truth.
 */

export type ProviderTypeId =
  | 'claude'
  | 'codex'
  | 'deepseek'
  | 'kimi'
  | 'qwen'
  | 'glm'
  | 'minimax'
  | 'openrouter'
  | 'local'
  | 'custom';

export interface ProviderType {
  id: ProviderTypeId;
  label: string;
  vendor: string;
  emoji: string;
  engine: EngineId;
  secretName?: string;
  /** Anthropic-compatible base URLs; cn omitted = no region choice. */
  baseUrl?: { intl: string; cn?: string };
  models: string[];
  /** Model env var style: claude engines set ANTHROPIC_MODEL(+defaults). */
  hasEffort?: boolean;
  /** Supports CLI subscription login as an alternative to an API key. */
  hasCliAuth?: boolean;
  notes?: string;
}

export const PROVIDER_TYPES: ProviderType[] = [
  {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    emoji: '✴︎',
    engine: 'claude-code',
    secretName: 'ANTHROPIC_API_KEY',
    models: ['(default)', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    hasEffort: true,
    hasCliAuth: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    emoji: '◎',
    engine: 'codex',
    secretName: 'OPENAI_API_KEY',
    models: ['(default)', 'gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.2', 'gpt-5.1-codex-mini'],
    hasCliAuth: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: 'deepseek.com',
    emoji: '◇',
    engine: 'claude-code',
    secretName: 'DEEPSEEK_API_KEY',
    baseUrl: { intl: 'https://api.deepseek.com/anthropic' },
    models: ['deepseek-v4-pro[1m]', 'deepseek-v4-pro', 'deepseek-v4-flash'],
    hasEffort: true,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    vendor: 'Moonshot',
    emoji: '◐',
    engine: 'claude-code',
    secretName: 'MOONSHOT_API_KEY',
    baseUrl: { intl: 'https://api.moonshot.ai/anthropic', cn: 'https://api.moonshot.cn/anthropic' },
    models: ['kimi-for-coding', 'kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-turbo-preview'],
    hasEffort: true,
  },
  {
    id: 'qwen',
    label: 'Qwen',
    vendor: 'Alibaba DashScope',
    emoji: '◆',
    engine: 'claude-code',
    secretName: 'DASHSCOPE_API_KEY',
    baseUrl: {
      intl: 'https://dashscope-intl.aliyuncs.com/api/v2/apps/claude-code-proxy',
      cn: 'https://dashscope.aliyuncs.com/api/v2/apps/claude-code-proxy',
    },
    models: ['qwen3-coder-plus', 'qwen3-coder-flash', 'qwen3-max'],
    hasEffort: true,
  },
  {
    id: 'glm',
    label: 'GLM',
    vendor: 'Zhipu / Z.ai',
    emoji: '❖',
    engine: 'claude-code',
    secretName: 'ZAI_API_KEY',
    baseUrl: {
      intl: 'https://api.z.ai/api/anthropic',
      cn: 'https://open.bigmodel.cn/api/anthropic',
    },
    models: ['glm-5', 'glm-4.6', 'glm-4.5-air'],
    hasEffort: true,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    vendor: 'minimax.io',
    emoji: '▣',
    engine: 'claude-code',
    secretName: 'MINIMAX_API_KEY',
    baseUrl: {
      intl: 'https://api.minimax.io/anthropic',
      cn: 'https://api.minimaxi.com/anthropic',
    },
    models: ['MiniMax-M2.5', 'MiniMax-M2.1'],
    hasEffort: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    vendor: 'one key, every model',
    emoji: '⌘',
    engine: 'claude-code',
    secretName: 'OPENROUTER_API_KEY',
    baseUrl: { intl: 'https://openrouter.ai/api' },
    models: [
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.2',
      'google/gemini-3-pro',
      'deepseek/deepseek-v4',
      'qwen/qwen3-coder',
      'moonshotai/kimi-k2.5',
      'z-ai/glm-5',
      'minimax/minimax-m2.5',
    ],
    hasEffort: true,
    notes: 'Model list loads live from openrouter.ai when reachable.',
  },
  {
    id: 'local',
    label: 'Local LLM',
    vendor: 'ollama · omlx · LM Studio',
    emoji: '⌂',
    engine: 'claude-code',
    baseUrl: { intl: 'http://127.0.0.1:8000' },
    models: [],
    hasEffort: false,
  },
  {
    id: 'custom',
    label: 'Custom',
    vendor: 'raw env vars',
    emoji: '⚙',
    engine: 'claude-code',
    models: [],
  },
];

export const CLAUDE_EFFORT_LEVELS = ['(default)', 'low', 'medium', 'high', 'max'] as const;
export const CODEX_EFFORT_LEVELS = ['(default)', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const CODEX_SANDBOXES = ['workspace-write', 'read-only', 'danger-full-access'] as const;

export interface BuilderState {
  typeId: ProviderTypeId;
  name: string;
  auth: 'cli' | 'key';
  apiKey: string;
  model: string;
  customModel: string;
  effort: string;
  sandbox: string;
  region: 'intl' | 'cn';
  baseUrl: string;
  localToken: string;
}

export function initialBuilderState(typeId: ProviderTypeId): BuilderState {
  const type = PROVIDER_TYPES.find((t) => t.id === typeId)!;
  return {
    typeId,
    name: type.id === 'custom' ? '' : type.id,
    auth: type.hasCliAuth ? 'cli' : 'key',
    apiKey: '',
    model: type.models[0] ?? '',
    customModel: '',
    effort: '(default)',
    sandbox: 'workspace-write',
    region: 'intl',
    baseUrl: type.baseUrl?.intl ?? '',
    localToken: 'local',
  };
}

export interface BuiltProvider {
  name: string;
  engine: EngineId;
  modelLabel: string | null;
  env: Record<string, string>;
  /** Secret to store before creating the provider (when a key was typed). */
  secret?: { name: string; value: string };
}

export function buildProvider(s: BuilderState): BuiltProvider {
  const type = PROVIDER_TYPES.find((t) => t.id === s.typeId)!;
  const model = s.model === 'custom' ? s.customModel.trim() : s.model === '(default)' ? '' : s.model;
  const env: Record<string, string> = {};
  const secret =
    s.auth === 'key' && s.apiKey.trim() && type.secretName
      ? { name: type.secretName, value: s.apiKey.trim() }
      : undefined;

  const keyRef = type.secretName ? `\${SECRET:${type.secretName}}` : '';

  if (type.engine === 'codex') {
    if (s.auth === 'key') env.OPENAI_API_KEY = keyRef;
    env.CODEX_SANDBOX = s.sandbox;
    if (s.effort !== '(default)') env.CODEX_REASONING_EFFORT = s.effort;
    return { name: s.name.trim(), engine: 'codex', modelLabel: model || null, env, secret };
  }

  // claude-code engines
  if (s.typeId === 'claude') {
    if (s.auth === 'key') env.ANTHROPIC_API_KEY = keyRef;
    if (model) env.ANTHROPIC_MODEL = model;
  } else if (s.typeId === 'local') {
    env.ANTHROPIC_BASE_URL = s.baseUrl.trim();
    env.ANTHROPIC_AUTH_TOKEN = s.localToken.trim() || 'local';
    const localModel = s.customModel.trim();
    if (localModel) {
      env.ANTHROPIC_MODEL = localModel;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = localModel;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = localModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = localModel;
    }
    env.API_TIMEOUT_MS = '3000000';
  } else if (type.baseUrl) {
    env.ANTHROPIC_BASE_URL = s.region === 'cn' && type.baseUrl.cn ? type.baseUrl.cn : type.baseUrl.intl;
    env.ANTHROPIC_AUTH_TOKEN = keyRef;
    if (model) {
      env.ANTHROPIC_MODEL = model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    }
    env.API_TIMEOUT_MS = '3000000';
  }
  if (type.hasEffort && s.effort !== '(default)') env.CLAUDE_CODE_EFFORT_LEVEL = s.effort;

  return {
    name: s.name.trim(),
    engine: 'claude-code',
    modelLabel: model || (s.typeId === 'local' ? s.customModel.trim() || null : null),
    env,
    secret,
  };
}
