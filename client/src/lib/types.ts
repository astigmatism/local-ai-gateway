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

export type HealthStatusState = 'healthy' | 'stale' | 'unavailable' | 'loading' | 'unknown' | string;

export interface RawGpuTelemetryDevice extends Record<string, unknown> {
  index?: number;
  uuid?: string;
  name?: string;
  gpu_name?: string;
  gpuName?: string;
  product_name?: string;
  productName?: string;
  driver_version?: string;
  driverVersion?: string;
  memory_total_mib?: number;
  memoryTotalMiB?: number;
  memory_used_mib?: number;
  memoryUsedMiB?: number;
  memory_free_mib?: number;
  memoryFreeMiB?: number;
  utilization_gpu_percent?: number;
  utilizationGpuPercent?: number;
  temperature_gpu_c?: number;
  temperature_c?: number;
  temperatureC?: number;
  power_draw_w?: number;
  powerDrawW?: number;
  power_limit_w?: number;
  powerLimitW?: number;
  fan_speed_percent?: number;
  fanSpeedPercent?: number;
  checked_at?: string;
  checkedAt?: string;
  source_endpoint?: string;
  sourceEndpoint?: string;
}

export interface GpuTelemetryData extends Record<string, unknown> {
  ok?: boolean;
  status?: string;
  gpus?: RawGpuTelemetryDevice[];
  gpu_count?: number;
  source_endpoint?: string;
  sourceEndpoint?: string;
}

export interface NormalizedGpuHealth {
  id: string;
  machineId: string;
  machineLabel: string;
  index?: number;
  uuid?: string;
  name: string;
  shortName: string;
  driverVersion?: string;
  memoryTotalMiB?: number;
  memoryUsedMiB?: number;
  memoryFreeMiB?: number;
  utilizationGpuPercent?: number;
  temperatureC?: number;
  powerDrawW?: number;
  powerLimitW?: number;
  fanSpeedPercent?: number;
  checkedAt?: string;
  sourceEndpoint?: string;
  status: HealthStatusState;
  gpuStatus?: string;
  healthError?: string | null;
  gpuError?: string | null;
  telemetryStale: boolean;
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

export interface LlmStreamStartEvent {
  type: 'start';
  conversationId: string;
  userMessage: Message;
  assistantMessageTempId: string;
  model: string;
  createdAt: string;
}

export interface LlmStreamDeltaEvent {
  type: 'delta';
  delta: string;
  content: string;
  generatedAt: string;
}

export interface LlmStreamMetadataEvent {
  type: 'metadata';
  provider: 'ollama';
  endpoint: '/api/generate';
  model: string;
  generatedAt: string;
}

export interface LlmStreamDoneEvent {
  type: 'done';
  assistantMessage: Message;
  conversation: ConversationSummary;
  titleGeneration?: ConversationTitleGenerationResult;
  metadata?: Record<string, unknown>;
}

export interface LlmStreamErrorEvent {
  type: 'error';
  message: string;
  code?: string;
  generatedAt: string;
}

export type LlmStreamEvent =
  | LlmStreamStartEvent
  | LlmStreamDeltaEvent
  | LlmStreamMetadataEvent
  | LlmStreamDoneEvent
  | LlmStreamErrorEvent;

export interface TranscribeSegment extends Record<string, unknown> {
  start?: number;
  end?: number;
  text?: string | null;
}

export interface TranscribeResponse {
  filename?: string;
  model?: string;
  defaultModel?: string;
  activeModel?: string;
  language?: string;
  languageProbability?: number;
  vadFilter?: boolean;
  minSilenceDurationMs?: number;
  beamSize?: number;
  wordTimestamps?: boolean;
  transcript: string;
  segments?: TranscribeSegment[];
  metadata?: Record<string, unknown>;
  audioSnippet?: Record<string, unknown> | null;
}

export interface AuthResponse {
  user: AuthUser;
  mustChangePassword: boolean;
  csrfToken: string;
  passwordPolicy: PasswordPolicy;
}

export interface VoiceGpuDevice {
  index?: number;
  name?: string;
  driverVersion?: string;
  memoryTotalMiB?: number;
  memoryUsedMiB?: number;
  memoryFreeMiB?: number;
  utilizationGpuPercent?: number;
  temperatureC?: number;
  raw?: unknown;
}

export interface VoiceGpuResponse {
  available: boolean;
  checkedAt?: string;
  devices: VoiceGpuDevice[];
  raw?: unknown;
}

export interface VoiceModelDescriptor {
  id: string;
  label: string;
  provider?: string;
  model?: string;
  name?: string;
  language?: string;
  languages?: string[];
  description?: string;
  raw?: unknown;
}

export interface VoiceModelCatalogResponse {
  kind: 'stt' | 'tts';
  provider?: string;
  defaultModel?: string;
  activeModel?: string;
  loadedModel?: string;
  computeType?: string;
  language?: string;
  status?: string;
  worker: Record<string, unknown> | null;
  models: VoiceModelDescriptor[];
  raw?: unknown;
}

export interface VoiceModelsResponse {
  stt: VoiceModelCatalogResponse;
  tts: VoiceModelCatalogResponse;
  raw?: unknown;
}

export interface VoiceConfigSection {
  defaultModel?: string;
  computeType?: string;
  language?: string;
  raw?: Record<string, unknown> | null;
}

export interface VoiceConfigResponse {
  stt: VoiceConfigSection;
  tts: VoiceConfigSection;
  raw?: unknown;
}

export interface VoiceReferenceDescriptor {
  id: string;
  displayName: string;
  originalFilename?: string;
  storedFilename?: string;
  path?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  createdAt?: string;
  modifiedAt?: string;
  provider?: string;
  model?: string;
  language?: string;
  description?: string;
  type?: string;
  isActive?: boolean;
  isSelected?: boolean;
  canDelete?: boolean;
  source: 'voice-vm' | 'bear-castle';
  raw?: unknown;
}

export interface VoiceReferenceSelectionCapability {
  mode: 'bear-castle-tts-voice';
  canSelect: boolean;
  activeReferenceExposedByVoiceVm: boolean;
  activeReferenceKnown: boolean;
  selectedReferenceId?: string;
  selectedReferenceDisplayName?: string;
  selectedReferencePersistsIn: 'bear-castle';
  ttsSpeakField: 'voice';
}

export interface VoiceReferenceDeletionCapability {
  mode: 'voice-vm-reference-audio-delete';
  canDelete: boolean;
  supportedBySuppliedVoiceVmContract: boolean;
  clearsBearCastleSelection: boolean;
  clearsBearCastleMetadata: boolean;
}

export interface VoiceReferencesResponse {
  references: VoiceReferenceDescriptor[];
  activeReference: VoiceReferenceDescriptor | null;
  selectedReference: VoiceReferenceDescriptor | null;
  activeReferenceKnown: boolean;
  selection: VoiceReferenceSelectionCapability;
  deletion?: VoiceReferenceDeletionCapability;
  raw?: unknown;
}

export interface VoiceDescriptor {
  id: string;
  label: string;
  provider?: string;
  model?: string;
  language?: string;
  description?: string;
  type?: string;
  raw?: unknown;
}

export interface VoiceDescriptorsResponse {
  voices: VoiceDescriptor[];
  raw?: unknown;
}

export interface VoiceOverviewResponse {
  health: Record<string, unknown> | null;
  services: Record<string, unknown> | null;
  gpu: VoiceGpuResponse | null;
  system: Record<string, unknown> | null;
  models: {
    stt: VoiceModelCatalogResponse | null;
    tts: VoiceModelCatalogResponse | null;
  };
  config: VoiceConfigResponse | null;
  voices: VoiceDescriptorsResponse | null;
  references?: VoiceReferencesResponse | null;
  errors: Record<string, string>;
  generatedAt: string;
}

export interface VoiceMutationResponse {
  result?: unknown;
  message?: string;
  references?: VoiceReferencesResponse;
  uploadedReferenceId?: string;
  deletedReferenceId?: string;
  deletedReference?: VoiceReferenceDescriptor;
  selectedReferenceCleared?: boolean;
  stillListed?: boolean;
  mappedOriginalFilename?: boolean;
}

export interface LoadSttModelRequest {
  provider: string;
  model: string;
  computeType: string;
  options?: Record<string, unknown>;
}

export interface LoadTtsModelRequest {
  provider: string;
  model: string;
  language?: string;
  options?: Record<string, unknown>;
}

export interface UnloadVoiceModelRequest {
  strategy?: 'soft' | 'hard';
  clearCache?: boolean;
}

export interface UpdateSttConfigRequest {
  defaultModel?: string;
  computeType?: string;
}

export interface UpdateTtsConfigRequest {
  defaultModel?: string;
  language?: string;
}
