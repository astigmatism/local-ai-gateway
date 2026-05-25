export type MessageRole = 'user' | 'assistant' | 'system';

export interface User {
  id: string;
  displayName: string;
  loginName?: string;
  isAdmin?: boolean;
  mustChangePassword?: boolean;
  isActive?: boolean;
  lockedUntil?: string | null;
  lastLoginAt?: string | null;
  passwordChangedAt?: string | null;
  deletedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface LoginUser {
  id: string;
  displayName: string;
  initials: string;
}

export interface AuthUser {
  id: string;
  displayName: string;
  loginName: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

export interface PasswordPolicy {
  minLength: number;
}

export interface AdminUser extends AuthUser {
  isActive: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  passwordChangedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  userId: string;
  title: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: Array<Pick<Message, 'content' | 'role' | 'createdAt'>>;
  _count?: {
    messages: number;
  };
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
  user?: User;
}

export interface TelemetryEntry {
  data: Record<string, unknown> | null;
  last_success_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  stale: boolean;
}

export interface ServiceTelemetryStatus {
  health: TelemetryEntry;
  gpu: TelemetryEntry;
}

export interface GatewayStatus {
  llm: ServiceTelemetryStatus;
  voice: ServiceTelemetryStatus;
}

export interface StatusResponse {
  status: GatewayStatus;
  generated_at: string;
}


export type ModelSourceState = 'ok' | 'error' | 'skipped';

export interface ModelSourceStatus {
  status: ModelSourceState;
  message?: string;
}

export interface ModelRuntimeInfo {
  name: string;
  size?: number;
  sizeVram?: number;
  contextLength?: number;
  expiresAt?: string;
  digest?: string;
  details?: Record<string, unknown>;
  source?: 'health' | 'ollamaPs' | 'combined';
}

export interface AvailableModelInfo {
  name: string;
  size?: number;
  modifiedAt?: string;
  digest?: string;
  details?: {
    family?: string;
    families?: string[];
    format?: string;
    parameterSize?: string;
    quantization?: string;
    [key: string]: unknown;
  };
  source?: 'health' | 'ollamaTags' | 'combined';
}

export interface DiskStorageInfo {
  path?: string;
  filesystem?: string;
  usedBytes?: number;
  availableBytes?: number;
  totalBytes?: number;
  usedPercent?: number;
  ollamaModelsBytes?: number;
}

export interface ModelStorageSummary {
  installedModelBytes: number;
  installedModelCount: number;
  disk: DiskStorageInfo | null;
  lowSpace: boolean | null;
  warning?: string;
}

export interface ModelCatalogCapability {
  mode: 'manual';
  stableApiAvailable: false;
  libraryUrl: string;
  message: string;
}

export interface ModelManagementStatus {
  defaultModel: string | null;
  defaultModelSource: 'local-ai-llm' | 'gateway-fallback';
  defaultModelLoaded: boolean | null;
  loadedModels: ModelRuntimeInfo[];
  availableModels: AvailableModelInfo[];
  storage: ModelStorageSummary;
  catalog: ModelCatalogCapability;
  source: {
    health: ModelSourceStatus;
    ollamaTags: ModelSourceStatus;
    ollamaPs: ModelSourceStatus;
    storage: ModelSourceStatus;
  };
  generatedAt: string;
}

export interface ModelLoadResponse extends ModelManagementStatus {
  message?: string;
}

export interface ModelDeleteResponse extends ModelManagementStatus {
  message?: string;
}

export interface ModelDetailsSummary {
  name: string;
  size?: number;
  digest?: string;
  modifiedAt?: string;
  format?: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  capabilities?: string[];
  license?: string;
  template?: string;
  system?: string;
  modelfile?: string;
  parameters?: string;
  modelInfo?: Record<string, unknown>;
}

export interface ModelDetailsResponse {
  model: string;
  summary: ModelDetailsSummary;
  raw: Record<string, unknown>;
  generatedAt: string;
}

export type ModelPullEventType = 'progress' | 'complete' | 'error';

export interface ModelPullProgressEvent {
  type: ModelPullEventType;
  model: string;
  status: string;
  completedBytes?: number;
  totalBytes?: number;
  percent?: number;
  error?: string;
  raw?: Record<string, unknown>;
  generatedAt: string;
}

export interface ConversationTitleGenerationResult {
  needed: boolean;
  generated?: boolean;
  fallbackUsed?: boolean;
  reason?: string;
  model?: string;
}

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessage: Message;
  conversation: ConversationSummary;
  titleGeneration?: ConversationTitleGenerationResult;
}

export interface GenerateConversationTitleResponse {
  conversation: ConversationSummary;
  titleGeneration: ConversationTitleGenerationResult;
}

export interface TranscribeResponse {
  transcript: string;
  metadata?: Record<string, unknown>;
  audioSnippet?: Record<string, unknown> | null;
}

export interface AuthResponse {
  user: AuthUser;
  mustChangePassword: boolean;
  csrfToken: string;
  passwordPolicy: PasswordPolicy;
}
