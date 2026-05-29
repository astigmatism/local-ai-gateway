import dotenv from 'dotenv';
import crypto from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';

dotenv.config();

const booleanFromString = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['true', '1', 'yes', 'y'].includes(value.toLowerCase());
  return value;
}, z.boolean());

const commaList = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}, z.array(z.string()).default([]));

const httpsRedirectStatusCodeSchema = z.coerce
  .number()
  .pipe(z.union([z.literal(301), z.literal(308)]))
  .default(308);

const sameSiteSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.enum(['lax', 'strict', 'none']))
  .default('lax');

const emptyStringToUndefined = (value: unknown) => {
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
};

const optionalSecret = z.string().trim().optional();
const optionalNonEmptyString = z.preprocess(emptyStringToUndefined, z.string().trim().min(1).optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().trim().min(1).default('0.0.0.0'),
  APP_NAME: z.string().min(1).default('Bear Castle AI'),
  DATABASE_URL: z.string().min(1),
  APP_DEFAULT_USER_NAME: z.string().min(1).default('Eric'),

  AUTH_ENABLED: booleanFromString.default(true),
  INITIAL_ADMIN_PASSWORD: optionalSecret,
  NEW_USER_DEFAULT_PASSWORD: optionalSecret,
  AUTH_MIN_PASSWORD_LENGTH: z.coerce.number().int().min(8).default(8),
  SESSION_SECRET: optionalSecret,
  SESSION_COOKIE_NAME: z.string().trim().min(1).default('bear_castle_ai_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  SESSION_COOKIE_SECURE: booleanFromString.optional(),
  SESSION_COOKIE_SAME_SITE: sameSiteSchema,
  AUTH_TRUST_PROXY: booleanFromString.default(true),
  AUTH_MAX_FAILED_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(3),
  AUTH_LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().positive().default(5),
  AUTH_LOCKOUT_DURATION_MINUTES: z.coerce.number().int().positive().default(5),
  AUTH_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  AUTH_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  CSRF_ENABLED: booleanFromString.default(true),
  CSRF_HEADER_NAME: z.string().trim().min(1).default('X-CSRF-Token'),
  CHAT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  CHAT_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  TRANSCRIBE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  TRANSCRIBE_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  TTS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  TTS_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  ADMIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  CORS_ALLOWED_ORIGINS: commaList,
  SECURITY_HEADERS_ENABLED: booleanFromString.default(true),
  HTTPS_REDIRECT_ENABLED: booleanFromString.default(false),
  HTTPS_REDIRECT_ALLOWED_HOSTS: commaList,
  HTTPS_REDIRECT_STATUS_CODE: httpsRedirectStatusCodeSchema,

  LLM_BASE_URL: z.string().url().default('http://192.168.1.5:11434'),
  LLM_MONITOR_BASE_URL: z.string().url().default('http://192.168.1.5:8000'),
  LLM_MODEL: z.string().min(1).default('qwen3:30b'),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  MODEL_DISCOVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MODEL_DETAILS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MODEL_PULL_TIMEOUT_MS: z.coerce.number().int().positive().default(3600000),
  MODEL_DELETE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  MODEL_MAX_CONCURRENT_PULLS: z.coerce.number().int().positive().default(1),
  LLM_STORAGE_ENDPOINT: z
    .string()
    .trim()
    .regex(/^\/[A-Za-z0-9/_-]*$/, 'must be a monitor path such as /storage or /disk')
    .default('/storage'),
  IMAGE_GENERATION_ENABLED: booleanFromString.default(false),
  IMAGE_GENERATION_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  IMAGE_GENERATION_MAX_PROMPT_CHARS: z.coerce.number().int().positive().default(4000),
  IMAGE_GENERATION_STORAGE_DIR: z.string().min(1).default('./storage/generated-images'),
  STORAGE_LOW_DISK_WARNING_PERCENT: z.coerce.number().min(1).max(100).default(85),
  STORAGE_LOW_DISK_WARNING_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024 * 1024),

  VOICE_BASE_URL: z.string().url().default('http://192.168.1.8:8000'),
  VOICE_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),

  TTS_ENABLED: booleanFromString.default(true),
  TTS_DEFAULT_VOICE: z.string().trim().min(1).default('af_heart'),
  TTS_DEFAULT_SPEED: z.coerce.number().min(0.5).max(2).default(1.0),
  TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  TTS_MAX_TEXT_CHARS: z.coerce.number().int().positive().default(12000),

  TRANSCRIPT_FORMATTING_ENABLED: booleanFromString.default(false),
  TRANSCRIPT_FORMATTING_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  TRANSCRIPT_FORMATTING_MODEL: optionalNonEmptyString,
  TRANSCRIPT_FORMATTING_MAX_CHARS: z.coerce.number().int().positive().default(12000),

  CONVERSATION_TITLE_GENERATION_ENABLED: booleanFromString.default(true),
  CONVERSATION_TITLE_MODEL: optionalNonEmptyString,
  CONVERSATION_TITLE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),
  CONVERSATION_TITLE_MAX_CHARS: z.coerce.number().int().positive().default(4000),
  CONVERSATION_TITLE_MAX_LENGTH: z.coerce.number().int().positive().default(80),

  HEALTH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  GPU_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  TELEMETRY_STALE_AFTER_MS: z.coerce.number().int().positive().default(15000),

  CONVERSATION_CONTEXT_MAX_MESSAGES: z.coerce.number().int().positive().default(20),
  CONVERSATION_CONTEXT_MAX_CHARS: z.coerce.number().int().positive().default(24000),

  MAX_AUDIO_UPLOAD_MB: z.coerce.number().int().positive().default(50),
  STORE_AUDIO_UPLOADS: booleanFromString.default(false),
  UPLOAD_DIR: z.string().min(1).default('./storage/uploads'),

  LOG_LEVEL: z.string().min(1).default('info')
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const formatted = parsed.error.issues
    .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${formatted}`);
}

const env = parsed.data;

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');

const placeholderValues = new Set([
  'change_this_admin_password',
  'change_this_default_user_password',
  'change_this_to_a_long_random_secret',
  'password',
  'changeme',
  'change_me',
  'defaultpassword',
  'admin',
  'eric'
]);

const isMissingOrPlaceholder = (value: string | undefined) => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return placeholderValues.has(normalized) || normalized.includes('change_this');
};

const isWeakSessionSecret = (value: string | undefined) => {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return normalized.length < 16 || placeholderValues.has(normalized) || normalized.includes('change_this');
};

const requireAuthSecret = (name: string, value: string | undefined) => {
  if (value) return value;
  if (env.NODE_ENV === 'test') return `test_${name.toLowerCase()}_${crypto.randomBytes(24).toString('base64url')}`;
  throw new Error(`${name} must be set. Copy .env.example to .env and configure authentication secrets before starting Bear Castle AI.`);
};

const sessionCookieSecure = env.SESSION_COOKIE_SECURE ?? (env.NODE_ENV === 'production');

const configuredAuthPasswords: Array<[string, string | undefined]> = [
  ['INITIAL_ADMIN_PASSWORD', env.INITIAL_ADMIN_PASSWORD],
  ['NEW_USER_DEFAULT_PASSWORD', env.NEW_USER_DEFAULT_PASSWORD]
];

const authPasswordLengthFailures = configuredAuthPasswords.flatMap(([name, value]) =>
  value && value.length < env.AUTH_MIN_PASSWORD_LENGTH
    ? [`${name} must be at least ${env.AUTH_MIN_PASSWORD_LENGTH} characters.`]
    : []
);

if (authPasswordLengthFailures.length > 0) {
  throw new Error(`Invalid authentication password configuration:\n${authPasswordLengthFailures.join('\n')}`);
}

if (env.NODE_ENV === 'production') {
  const failures: string[] = [];
  if (!env.AUTH_ENABLED) failures.push('AUTH_ENABLED must remain true in production.');
  if (isMissingOrPlaceholder(env.INITIAL_ADMIN_PASSWORD)) {
    failures.push('INITIAL_ADMIN_PASSWORD must be set to a non-placeholder value.');
  }
  if (isMissingOrPlaceholder(env.NEW_USER_DEFAULT_PASSWORD)) {
    failures.push('NEW_USER_DEFAULT_PASSWORD must be set to a non-placeholder value.');
  }
  if (isWeakSessionSecret(env.SESSION_SECRET)) {
    failures.push('SESSION_SECRET must be set to a long random non-placeholder value.');
  }
  if (env.INITIAL_ADMIN_PASSWORD && env.NEW_USER_DEFAULT_PASSWORD && env.INITIAL_ADMIN_PASSWORD === env.NEW_USER_DEFAULT_PASSWORD) {
    failures.push('INITIAL_ADMIN_PASSWORD and NEW_USER_DEFAULT_PASSWORD must be different values.');
  }
  if (env.SESSION_COOKIE_SAME_SITE === 'none' && !sessionCookieSecure) {
    failures.push('SESSION_COOKIE_SECURE must be true when SESSION_COOKIE_SAME_SITE=none.');
  }

  if (!sessionCookieSecure) {
    console.warn('SESSION_COOKIE_SECURE=false in production. Only use this for trusted local HTTP deployments; prefer HTTPS for production access.');
  }

  if (failures.length > 0) {
    throw new Error(`Invalid production authentication configuration:\n${failures.join('\n')}`);
  }
} else {
  if (!env.AUTH_ENABLED) {
    console.warn('AUTH_ENABLED=false is unsafe and should not be used beyond local development.');
  }
  if (env.INITIAL_ADMIN_PASSWORD && env.NEW_USER_DEFAULT_PASSWORD && env.INITIAL_ADMIN_PASSWORD === env.NEW_USER_DEFAULT_PASSWORD) {
    console.warn('INITIAL_ADMIN_PASSWORD and NEW_USER_DEFAULT_PASSWORD should be different values.');
  }
  for (const [name, value] of [
    ['INITIAL_ADMIN_PASSWORD', env.INITIAL_ADMIN_PASSWORD],
    ['NEW_USER_DEFAULT_PASSWORD', env.NEW_USER_DEFAULT_PASSWORD]
  ] as const) {
    if (value && isMissingOrPlaceholder(value) && env.NODE_ENV !== 'test') {
      console.warn(`${name} appears to be a placeholder. Change it before exposing Bear Castle AI beyond local development.`);
    }
  }
  if (env.SESSION_SECRET && isWeakSessionSecret(env.SESSION_SECRET) && env.NODE_ENV !== 'test') {
    console.warn('SESSION_SECRET appears weak or placeholder. Change it before exposing Bear Castle AI beyond local development.');
  }
}

const initialAdminPassword = requireAuthSecret('INITIAL_ADMIN_PASSWORD', env.INITIAL_ADMIN_PASSWORD);
const newUserDefaultPassword = requireAuthSecret('NEW_USER_DEFAULT_PASSWORD', env.NEW_USER_DEFAULT_PASSWORD);
const sessionSecret = requireAuthSecret('SESSION_SECRET', env.SESSION_SECRET);

export const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  host: env.HOST,
  appName: env.APP_NAME,
  databaseUrl: env.DATABASE_URL,
  defaultUserName: 'Eric',
  auth: {
    enabled: env.AUTH_ENABLED,
    minPasswordLength: env.AUTH_MIN_PASSWORD_LENGTH,
    initialAdminPassword,
    newUserDefaultPassword,
    maxFailedLoginAttempts: env.AUTH_MAX_FAILED_LOGIN_ATTEMPTS,
    lockoutWindowMinutes: env.AUTH_LOCKOUT_WINDOW_MINUTES,
    lockoutDurationMinutes: env.AUTH_LOCKOUT_DURATION_MINUTES,
    loginRateLimitWindowMs: env.AUTH_LOGIN_RATE_LIMIT_WINDOW_MS,
    loginRateLimitMax: env.AUTH_LOGIN_RATE_LIMIT_MAX,
    trustProxy: env.AUTH_TRUST_PROXY
  },
  session: {
    secret: sessionSecret,
    cookieName: env.SESSION_COOKIE_NAME,
    ttlHours: env.SESSION_TTL_HOURS,
    cookieSecure: sessionCookieSecure,
    sameSite: env.SESSION_COOKIE_SAME_SITE
  },
  csrf: {
    enabled: env.CSRF_ENABLED,
    headerName: env.CSRF_HEADER_NAME
  },
  rateLimits: {
    chat: {
      windowMs: env.CHAT_RATE_LIMIT_WINDOW_MS,
      max: env.CHAT_RATE_LIMIT_MAX
    },
    transcribe: {
      windowMs: env.TRANSCRIBE_RATE_LIMIT_WINDOW_MS,
      max: env.TRANSCRIBE_RATE_LIMIT_MAX
    },
    tts: {
      windowMs: env.TTS_RATE_LIMIT_WINDOW_MS,
      max: env.TTS_RATE_LIMIT_MAX
    },
    admin: {
      windowMs: env.ADMIN_RATE_LIMIT_WINDOW_MS,
      max: env.ADMIN_RATE_LIMIT_MAX
    }
  },
  cors: {
    allowedOrigins: env.CORS_ALLOWED_ORIGINS
  },
  securityHeaders: {
    enabled: env.SECURITY_HEADERS_ENABLED
  },
  httpsRedirect: {
    enabled: env.HTTPS_REDIRECT_ENABLED,
    allowedHosts: env.HTTPS_REDIRECT_ALLOWED_HOSTS,
    statusCode: env.HTTPS_REDIRECT_STATUS_CODE
  },
  llm: {
    baseUrl: stripTrailingSlash(env.LLM_BASE_URL),
    monitorBaseUrl: stripTrailingSlash(env.LLM_MONITOR_BASE_URL),
    model: env.LLM_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS
  },
  imageGeneration: {
    enabled: env.IMAGE_GENERATION_ENABLED,
    timeoutMs: env.IMAGE_GENERATION_TIMEOUT_MS,
    maxPromptChars: env.IMAGE_GENERATION_MAX_PROMPT_CHARS,
    storageDir: path.resolve(process.cwd(), env.IMAGE_GENERATION_STORAGE_DIR)
  },
  modelManagement: {
    discoveryTimeoutMs: Math.min(env.MODEL_DISCOVERY_TIMEOUT_MS, env.LLM_TIMEOUT_MS),
    detailsTimeoutMs: env.MODEL_DETAILS_TIMEOUT_MS,
    pullTimeoutMs: env.MODEL_PULL_TIMEOUT_MS,
    deleteTimeoutMs: env.MODEL_DELETE_TIMEOUT_MS,
    maxConcurrentPulls: env.MODEL_MAX_CONCURRENT_PULLS,
    storageEndpoint: env.LLM_STORAGE_ENDPOINT,
    lowDiskWarningPercent: env.STORAGE_LOW_DISK_WARNING_PERCENT,
    lowDiskWarningBytes: env.STORAGE_LOW_DISK_WARNING_BYTES
  },
  voice: {
    baseUrl: stripTrailingSlash(env.VOICE_BASE_URL),
    timeoutMs: env.VOICE_TIMEOUT_MS
  },
  tts: {
    enabled: env.TTS_ENABLED,
    defaultVoice: env.TTS_DEFAULT_VOICE,
    defaultSpeed: env.TTS_DEFAULT_SPEED,
    timeoutMs: env.TTS_TIMEOUT_MS,
    maxTextChars: env.TTS_MAX_TEXT_CHARS
  },
  transcriptFormatting: {
    enabled: env.TRANSCRIPT_FORMATTING_ENABLED,
    timeoutMs: env.TRANSCRIPT_FORMATTING_TIMEOUT_MS,
    model: env.TRANSCRIPT_FORMATTING_MODEL,
    maxChars: env.TRANSCRIPT_FORMATTING_MAX_CHARS
  },
  conversationTitle: {
    enabled: env.CONVERSATION_TITLE_GENERATION_ENABLED,
    model: env.CONVERSATION_TITLE_MODEL,
    timeoutMs: env.CONVERSATION_TITLE_TIMEOUT_MS,
    maxPromptChars: env.CONVERSATION_TITLE_MAX_CHARS,
    maxLength: env.CONVERSATION_TITLE_MAX_LENGTH
  },
  telemetry: {
    healthPollIntervalMs: env.HEALTH_POLL_INTERVAL_MS,
    gpuPollIntervalMs: env.GPU_POLL_INTERVAL_MS,
    staleAfterMs: env.TELEMETRY_STALE_AFTER_MS,
    requestTimeoutMs: Math.min(4000, env.HEALTH_POLL_INTERVAL_MS)
  },
  conversation: {
    contextMaxMessages: env.CONVERSATION_CONTEXT_MAX_MESSAGES,
    contextMaxChars: env.CONVERSATION_CONTEXT_MAX_CHARS
  },
  audio: {
    maxUploadMb: env.MAX_AUDIO_UPLOAD_MB,
    maxUploadBytes: env.MAX_AUDIO_UPLOAD_MB * 1024 * 1024,
    storeUploads: env.STORE_AUDIO_UPLOADS,
    uploadDir: path.resolve(process.cwd(), env.UPLOAD_DIR)
  },
  logLevel: env.LOG_LEVEL,
  clientDistPath: path.resolve(process.cwd(), 'dist/client')
} as const;
