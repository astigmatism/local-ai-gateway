import type {
  AdminUser,
  AdminUserPurgeResponse,
  AdminUsersResponse,
  AuthResponse,
  Conversation,
  ConversationSummary,
  GenerateConversationTitleResponse,
  LlmStreamDoneEvent,
  LlmStreamErrorEvent,
  LlmStreamEvent,
  LoadSttModelRequest,
  LoadTtsModelRequest,
  LoginUser,
  ModelDeleteResponse,
  ModelDetailsResponse,
  ModelLoadResponse,
  ModelManagementStatus,
  ModelPullProgressEvent,
  SendMessageResponse,
  StatusResponse,
  TranscribeResponse,
  TtsProviderId,
  UserTtsPreference,
  UserTtsPreferencePatch,
  UnloadTtsModelRequest,
  UnloadVoiceModelRequest,
  UpdateSttConfigRequest,
  UpdateTtsConfigRequest,
  VoiceConfigResponse,
  VoiceDescriptorsResponse,
  VoiceGpuResponse,
  VoiceModelCatalogResponse,
  VoiceModelsResponse,
  VoiceMutationResponse,
  VoiceReferencesResponse,
  VoiceOverviewResponse
} from './types.js';
import { audioMimeTypeToFileExtension } from './audioRecording.js';
import { sanitizeThinkingBlocks, ThinkingBlockExtractor, type ThinkingBlockExtractionResult } from './thinkingBlocks.js';

interface ApiErrorShape {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

interface RequestOptions {
  handleUnauthorized?: boolean;
}

interface SpeakTextOptions {
  provider?: TtsProviderId;
  voice?: string;
  speed?: number;
  exaggeration?: number;
  cfgWeight?: number;
  temperature?: number;
  language?: string;
  model?: string;
  referenceAudioId?: string;
  referenceAudioPath?: string;
  format?: 'wav';
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
}

interface TranscribeAudioOptions {
  userId?: string;
  conversationId?: string;
  model?: string;
  language?: string;
  vadFilter?: boolean;
  minSilenceDurationMs?: number;
  beamSize?: number;
  wordTimestamps?: boolean;
}

interface SendMessageStreamOptions {
  signal?: AbortSignal;
  enableThinking?: boolean;
  onEvent?: (event: LlmStreamEvent) => void;
}

export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code?: string;
  public readonly details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let csrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

const parseJson = async <T>(response: Response, options: RequestOptions = {}): Promise<T> => {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const errorData = data as ApiErrorShape | null;
    if (response.status === 401 && options.handleUnauthorized !== false) unauthorizedHandler?.();
    throw new ApiClientError(
      errorData?.error?.message || `Request failed with HTTP ${response.status}`,
      response.status,
      errorData?.error?.code,
      errorData?.error?.details
    );
  }

  return data as T;
};

const parseBlob = async (response: Response, options: RequestOptions = {}): Promise<Blob> => {
  if (response.ok) return response.blob();

  const text = await response.text();
  let errorData: ApiErrorShape | null = null;

  if (text) {
    try {
      errorData = JSON.parse(text) as ApiErrorShape;
    } catch {
      errorData = null;
    }
  }

  if (response.status === 401 && options.handleUnauthorized !== false) unauthorizedHandler?.();

  throw new ApiClientError(
    errorData?.error?.message || text || `Request failed with HTTP ${response.status}`,
    response.status,
    errorData?.error?.code,
    errorData?.error?.details
  );
};

const isMutatingMethod = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());

const request = async <T>(path: string, init: RequestInit = {}, options: RequestOptions = {}) => {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);

  if (isMutatingMethod(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  return parseJson<T>(
    await fetch(path, {
      ...init,
      method,
      headers,
      credentials: 'include'
    }),
    options
  );
};

const requestBlob = async (path: string, init: RequestInit = {}, options: RequestOptions = {}) => {
  const method = init.method ?? 'GET';
  const headers = new Headers(init.headers);

  if (isMutatingMethod(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  return parseBlob(
    await fetch(path, {
      ...init,
      method,
      headers,
      credentials: 'include'
    }),
    options
  );
};

const assertPasswordChangeCompleted = (response: AuthResponse) => {
  if (response.mustChangePassword || response.user.mustChangePassword) {
    throw new ApiClientError(
      'Password update did not complete. The account is still marked as requiring a password change.',
      500,
      'PASSWORD_CHANGE_NOT_COMPLETED'
    );
  }
};

const jsonRequest = async <T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
  options: RequestOptions = {}
) =>
  request<T>(
    path,
    {
      method,
      headers: {
        'Content-Type': 'application/json'
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    },
    options
  );

const parseJsonErrorResponse = async (response: Response, options: RequestOptions = {}): Promise<never> => {
  const text = await response.text();
  let errorData: ApiErrorShape | null = null;

  if (text) {
    try {
      errorData = JSON.parse(text) as ApiErrorShape;
    } catch {
      errorData = null;
    }
  }

  if (response.status === 401 && options.handleUnauthorized !== false) unauthorizedHandler?.();

  throw new ApiClientError(
    errorData?.error?.message || text || `Request failed with HTTP ${response.status}`,
    response.status,
    errorData?.error?.code,
    errorData?.error?.details
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type MessageContentShape = {
  role: string;
  content: string;
  metadata?: Record<string, unknown> | null;
};

const metadataRecord = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

const uniqueThinkingContent = (...parts: Array<string | undefined>) => {
  const seen = new Set<string>();
  return parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part.length > 0)
    .filter((part) => {
      if (seen.has(part)) return false;
      seen.add(part);
      return true;
    })
    .join('\n\n');
};

const metadataThinkingContent = (metadata: Record<string, unknown> | undefined) =>
  typeof metadata?.thinkingContent === 'string' ? metadata.thinkingContent : '';

type ThinkingSuppressionFlags = {
  hasThinkingBlock: boolean;
  suppressedThinkingBlock: boolean;
  hasUntaggedReasoning?: boolean;
  suppressedUntaggedReasoning?: boolean;
};

const mergeThinkingMetadata = (
  metadata: Record<string, unknown> | undefined,
  flags: ThinkingSuppressionFlags,
  thinkingContent = ''
) => {
  const trimmedThinkingContent = uniqueThinkingContent(metadataThinkingContent(metadata), thinkingContent);
  const hasUntaggedReasoning = Boolean(flags.hasUntaggedReasoning);
  const suppressedUntaggedReasoning = Boolean(flags.suppressedUntaggedReasoning);
  if (
    !flags.hasThinkingBlock &&
    !flags.suppressedThinkingBlock &&
    !hasUntaggedReasoning &&
    !suppressedUntaggedReasoning &&
    !trimmedThinkingContent
  ) {
    return metadata;
  }

  return {
    ...(metadata ?? {}),
    hasRawThinkingTag: Boolean(metadata?.hasRawThinkingTag) || flags.hasThinkingBlock,
    rawThinkingTagSuppressed: Boolean(metadata?.rawThinkingTagSuppressed) || flags.suppressedThinkingBlock,
    hasUntaggedReasoning: Boolean(metadata?.hasUntaggedReasoning) || hasUntaggedReasoning,
    untaggedReasoningSuppressed: Boolean(metadata?.untaggedReasoningSuppressed) || suppressedUntaggedReasoning,
    ...(trimmedThinkingContent ? { thinkingContent: trimmedThinkingContent } : {})
  };
};

const sanitizeAssistantMessage = <T extends MessageContentShape>(message: T): T => {
  if (message.role !== 'assistant') return message;

  const currentMetadata = metadataRecord(message.metadata);
  const sanitized = sanitizeThinkingBlocks(message.content, { trim: true, extractUntaggedReasoning: true });
  const nextMetadata = mergeThinkingMetadata(
    currentMetadata,
    {
      hasThinkingBlock: sanitized.hasThinkingBlock,
      suppressedThinkingBlock: sanitized.suppressedThinkingBlock,
      hasUntaggedReasoning: sanitized.hasUntaggedReasoning,
      suppressedUntaggedReasoning: sanitized.suppressedUntaggedReasoning
    },
    sanitized.thinking
  );

  if (
    !sanitized.hasThinkingBlock &&
    !sanitized.hasUntaggedReasoning &&
    sanitized.content === message.content &&
    nextMetadata === currentMetadata
  ) return message;

  return {
    ...message,
    content: sanitized.content,
    ...(nextMetadata ? { metadata: nextMetadata } : {})
  } as T;
};

const sanitizeConversationSummary = <T extends { messages?: MessageContentShape[] }>(conversation: T): T => {
  if (!conversation.messages) return conversation;

  let changed = false;
  const messages = conversation.messages.map((message) => {
    const sanitized = sanitizeAssistantMessage(message);
    changed = changed || sanitized !== message;
    return sanitized;
  });

  return changed ? ({ ...conversation, messages } as T) : conversation;
};

const sanitizeConversation = <T extends { messages: MessageContentShape[] }>(conversation: T): T => {
  let changed = false;
  const messages = conversation.messages.map((message) => {
    const sanitized = sanitizeAssistantMessage(message);
    changed = changed || sanitized !== message;
    return sanitized;
  });

  return changed ? ({ ...conversation, messages } as T) : conversation;
};

const recordThinkingBlockResult = (
  current: ThinkingSuppressionFlags,
  result: ThinkingBlockExtractionResult
): ThinkingSuppressionFlags => ({
  hasThinkingBlock: current.hasThinkingBlock || result.hasThinkingBlock,
  suppressedThinkingBlock: current.suppressedThinkingBlock || result.suppressedThinkingBlock,
  hasUntaggedReasoning: Boolean(current.hasUntaggedReasoning || result.hasUntaggedReasoning),
  suppressedUntaggedReasoning: Boolean(current.suppressedUntaggedReasoning || result.suppressedUntaggedReasoning)
});

const sanitizeDoneEvent = (
  event: LlmStreamDoneEvent,
  streamedContent: string,
  flags: ThinkingSuppressionFlags,
  streamedThinkingContent: string,
  exposeThinking: boolean
): LlmStreamDoneEvent => {
  const eventMetadata = metadataRecord(event.metadata);
  const assistantMetadata = metadataRecord(event.assistantMessage.metadata);
  const finalSanitized = sanitizeThinkingBlocks(event.assistantMessage.content, { trim: true, extractUntaggedReasoning: true });
  const streamedSanitized = sanitizeThinkingBlocks(streamedContent, { trim: true, extractUntaggedReasoning: true });
  const finalContent = finalSanitized.content || streamedSanitized.content;
  const nextFlags: ThinkingSuppressionFlags = {
    hasThinkingBlock: flags.hasThinkingBlock || finalSanitized.hasThinkingBlock || streamedSanitized.hasThinkingBlock,
    suppressedThinkingBlock:
      flags.suppressedThinkingBlock || finalSanitized.suppressedThinkingBlock || streamedSanitized.suppressedThinkingBlock,
    hasUntaggedReasoning: Boolean(
      flags.hasUntaggedReasoning || finalSanitized.hasUntaggedReasoning || streamedSanitized.hasUntaggedReasoning
    ),
    suppressedUntaggedReasoning: Boolean(
      flags.suppressedUntaggedReasoning ||
        finalSanitized.suppressedUntaggedReasoning ||
        streamedSanitized.suppressedUntaggedReasoning
    )
  };
  const combinedThinkingContent = exposeThinking
    ? uniqueThinkingContent(
        streamedThinkingContent,
        finalSanitized.thinking,
        streamedSanitized.thinking,
        metadataThinkingContent(eventMetadata),
        metadataThinkingContent(assistantMetadata)
      )
    : '';
  const nextEventMetadata = mergeThinkingMetadata(eventMetadata, nextFlags, combinedThinkingContent);
  const nextAssistantMetadata = mergeThinkingMetadata(assistantMetadata, nextFlags, combinedThinkingContent);

  return {
    ...event,
    assistantMessage: {
      ...event.assistantMessage,
      content: finalContent,
      ...(nextAssistantMetadata ? { metadata: nextAssistantMetadata } : {})
    },
    conversation: sanitizeConversationSummary(event.conversation),
    ...(nextEventMetadata ? { metadata: nextEventMetadata } : {})
  };
};

const isLlmStreamEvent = (value: unknown): value is LlmStreamEvent => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;

  switch (value.type) {
    case 'start':
      return typeof value.conversationId === 'string' && isRecord(value.userMessage);
    case 'metadata':
      return value.provider === 'ollama' && value.endpoint === '/api/generate' && typeof value.model === 'string';
    case 'delta':
      return typeof value.delta === 'string' && typeof value.content === 'string';
    case 'thinking_delta':
      return typeof value.delta === 'string' && typeof value.thinking === 'string';
    case 'done':
      return isRecord(value.assistantMessage) && isRecord(value.conversation);
    case 'error':
      return typeof value.message === 'string';
    default:
      return false;
  }
};

const parseLlmStreamEventLine = (line: string): LlmStreamEvent | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    throw new ApiClientError('Chat stream included invalid JSON.', 502, 'CHAT_STREAM_INVALID_JSON');
  }

  if (!isLlmStreamEvent(parsed)) {
    throw new ApiClientError('Chat stream included an unknown event.', 502, 'CHAT_STREAM_INVALID_EVENT', parsed);
  }

  return parsed;
};

const parseLlmChatStream = async (
  response: Response,
  onEvent?: (event: LlmStreamEvent) => void,
  options: { exposeThinking?: boolean } = {}
): Promise<LlmStreamDoneEvent> => {
  if (!response.body) {
    throw new ApiClientError('Chat response did not include a stream.', 502, 'CHAT_STREAM_MISSING');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const exposeThinking = options.exposeThinking === true;
  const thinkingBlockExtractor = new ThinkingBlockExtractor({ extractUntaggedReasoning: true });
  let buffer = '';
  let visibleContent = '';
  let thinkingContent = '';
  let thinkingBlockFlags: ThinkingSuppressionFlags = { hasThinkingBlock: false, suppressedThinkingBlock: false };
  let doneEvent: LlmStreamDoneEvent | null = null;
  let errorEvent: LlmStreamErrorEvent | null = null as LlmStreamErrorEvent | null;

  const emitVisibleDelta = (delta: string, generatedAt: string) => {
    const visibleDelta = visibleContent.length === 0 ? delta.replace(/^\s+/, '') : delta;
    if (visibleDelta.length === 0) return;

    visibleContent += visibleDelta;
    onEvent?.({
      type: 'delta',
      delta: visibleDelta,
      content: visibleContent,
      generatedAt
    });
  };

  const emitThinkingDelta = (delta: string, generatedAt: string) => {
    const thinkingDelta = thinkingContent.length === 0 ? delta.replace(/^\s+/, '') : delta;
    if (thinkingDelta.length === 0) return;

    if (!exposeThinking) return;

    thinkingContent += thinkingDelta;
    onEvent?.({
      type: 'thinking_delta',
      delta: thinkingDelta,
      thinking: thinkingContent,
      generatedAt
    });
  };

  const emitExtractedDeltas = (extracted: ThinkingBlockExtractionResult, generatedAt: string) => {
    thinkingBlockFlags = recordThinkingBlockResult(thinkingBlockFlags, extracted);
    emitThinkingDelta(extracted.thinkingDelta, generatedAt);
    emitVisibleDelta(extracted.contentDelta, generatedAt);
  };

  const handleLine = (line: string) => {
    const event = parseLlmStreamEventLine(line);
    if (!event) return;

    if (event.type === 'delta') {
      emitExtractedDeltas(thinkingBlockExtractor.feed(event.delta), event.generatedAt);
      return;
    }

    if (event.type === 'thinking_delta') {
      emitThinkingDelta(event.delta, event.generatedAt);
      return;
    }

    if (event.type === 'done') {
      const flushed = thinkingBlockExtractor.flush();
      emitExtractedDeltas(flushed, event.assistantMessage.createdAt);

      const sanitizedDoneEvent = sanitizeDoneEvent(event, visibleContent, thinkingBlockFlags, thinkingContent, exposeThinking);
      doneEvent = sanitizedDoneEvent;
      onEvent?.(sanitizedDoneEvent);
      return;
    }

    onEvent?.(event);

    if (event.type === 'error') {
      errorEvent = event;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }

  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);

  if (errorEvent) {
    throw new ApiClientError(errorEvent.message, 502, errorEvent.code ?? 'CHAT_STREAM_FAILED', errorEvent);
  }

  if (!doneEvent) {
    throw new ApiClientError('Chat stream ended before the assistant response completed.', 502, 'CHAT_STREAM_INCOMPLETE');
  }

  return doneEvent;
};

const parseModelPullStream = async (
  response: Response,
  onProgress?: (event: ModelPullProgressEvent) => void
): Promise<ModelPullProgressEvent> => {
  if (!response.body) {
    throw new ApiClientError('Model pull response did not include a progress stream.', 502, 'MODEL_PULL_STREAM_MISSING');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let lastEvent: ModelPullProgressEvent | null = null;
  let errorEvent: ModelPullProgressEvent | null = null as ModelPullProgressEvent | null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: ModelPullProgressEvent;
    try {
      parsed = JSON.parse(trimmed) as ModelPullProgressEvent;
    } catch {
      throw new ApiClientError('Model pull progress stream included invalid JSON.', 502, 'MODEL_PULL_STREAM_INVALID');
    }
    lastEvent = parsed;
    onProgress?.(parsed);

    if (parsed.type === 'error') {
      errorEvent = parsed;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  }

  buffer += decoder.decode();
  if (buffer.trim()) handleLine(buffer);

  if (errorEvent) {
    throw new ApiClientError(errorEvent.error || errorEvent.status || 'Model pull failed.', 502, 'MODEL_PULL_FAILED', errorEvent);
  }

  return (
    lastEvent ?? {
      type: 'complete',
      model: 'unknown',
      status: 'success',
      generatedAt: new Date().toISOString()
    }
  );
};

export const api = {
  setCsrfToken(token: string | null) {
    csrfToken = token;
  },

  setUnauthorizedHandler(handler: (() => void) | null) {
    unauthorizedHandler = handler;
  },

  async listLoginUsers() {
    return request<{ users: LoginUser[] }>('/api/auth/login-users');
  },

  async login(userId: string, password: string) {
    const response = await jsonRequest<AuthResponse>('/api/auth/login', 'POST', { userId, password });
    csrfToken = response.csrfToken;
    return response;
  },

  async me() {
    const response = await request<AuthResponse>('/api/auth/me');
    csrfToken = response.csrfToken;
    return response;
  },

  async logout() {
    try {
      return await jsonRequest<{ ok: boolean }>('/api/auth/logout', 'POST');
    } finally {
      csrfToken = null;
    }
  },

  async changePassword(currentPassword: string, newPassword: string, confirmPassword: string) {
    const response = await jsonRequest<AuthResponse>(
      '/api/auth/change-password',
      'POST',
      {
        currentPassword,
        newPassword,
        confirmPassword
      },
      { handleUnauthorized: false }
    );
    csrfToken = response.csrfToken;
    assertPasswordChangeCompleted(response);

    const verifiedResponse = await request<AuthResponse>('/api/auth/me', {}, { handleUnauthorized: false });
    csrfToken = verifiedResponse.csrfToken;
    assertPasswordChangeCompleted(verifiedResponse);

    return verifiedResponse;
  },

  async listAdminUsers() {
    return request<AdminUsersResponse>('/api/admin/users');
  },

  async createAdminUser(displayName: string) {
    return jsonRequest<{ user: AdminUser }>('/api/admin/users', 'POST', { displayName });
  },

  async purgeAdminUser(userId: string) {
    return jsonRequest<AdminUserPurgeResponse>(`/api/admin/users/${userId}`, 'DELETE');
  },

  async resetAdminUserPassword(userId: string) {
    return jsonRequest<{ user: AdminUser }>(`/api/admin/users/${userId}/reset-password`, 'POST');
  },

  async listConversations() {
    const response = await request<{ conversations: ConversationSummary[] }>('/api/conversations');
    return { conversations: response.conversations.map(sanitizeConversationSummary) };
  },

  async createConversation(title?: string) {
    const response = await jsonRequest<{ conversation: ConversationSummary }>('/api/conversations', 'POST', { title });
    return { conversation: sanitizeConversationSummary(response.conversation) };
  },

  async getConversation(conversationId: string) {
    const response = await request<{ conversation: Conversation }>(`/api/conversations/${conversationId}`);
    return { conversation: sanitizeConversation(response.conversation) };
  },

  async deleteConversation(conversationId: string) {
    const response = await jsonRequest<{ conversation: ConversationSummary }>(`/api/conversations/${conversationId}`, 'DELETE');
    return { conversation: sanitizeConversationSummary(response.conversation) };
  },

  async sendMessage(conversationId: string, content: string, enableThinking = false) {
    const response = await jsonRequest<SendMessageResponse>(`/api/conversations/${conversationId}/messages`, 'POST', {
      content,
      enableThinking
    });
    return {
      ...response,
      assistantMessage: sanitizeAssistantMessage(response.assistantMessage),
      conversation: sanitizeConversationSummary(response.conversation)
    };
  },

  async sendMessageStream(conversationId: string, content: string, options: SendMessageStreamOptions = {}) {
    const headers = new Headers({
      'Content-Type': 'application/json',
      Accept: 'application/x-ndjson'
    });
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);

    const response = await fetch(`/api/conversations/${conversationId}/messages/stream`, {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ content, enableThinking: options.enableThinking === true }),
      signal: options.signal
    });

    if (!response.ok) {
      return parseJsonErrorResponse(response);
    }

    return parseLlmChatStream(response, options.onEvent, { exposeThinking: options.enableThinking === true });
  },

  async generateConversationTitle(conversationId: string, source = 'first-message') {
    const response = await jsonRequest<GenerateConversationTitleResponse>(
      `/api/conversations/${conversationId}/generate-title`,
      'POST',
      { source }
    );
    return {
      ...response,
      conversation: sanitizeConversationSummary(response.conversation)
    };
  },

  async speakText(text: string, options: SpeakTextOptions = {}) {
    const visibleText = sanitizeThinkingBlocks(text, { trim: true, extractUntaggedReasoning: true }).content;

    return requestBlob('/api/speak', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'audio/wav'
      },
      body: JSON.stringify({
        provider: options.provider,
        text: visibleText,
        voice: options.voice,
        speed: options.speed,
        exaggeration: options.exaggeration,
        cfgWeight: options.cfgWeight,
        temperature: options.temperature,
        language: options.language,
        model: options.model,
        referenceAudioId: options.referenceAudioId,
        referenceAudioPath: options.referenceAudioPath,
        format: options.format,
        metadata: options.metadata
      }),
      signal: options.signal
    });
  },

  async transcribeAudio(file: Blob, options: TranscribeAudioOptions) {
    const formData = new FormData();
    const extension = audioMimeTypeToFileExtension(file.type);
    formData.append('file', file, `browser-recording.${extension}`);
    if (options.userId) formData.append('userId', options.userId);
    if (options.conversationId) formData.append('conversationId', options.conversationId);
    if (options.model) formData.append('model', options.model);
    if (options.language) formData.append('language', options.language);
    if (options.vadFilter !== undefined) formData.append('vad_filter', String(options.vadFilter));
    if (options.minSilenceDurationMs !== undefined) {
      formData.append('min_silence_duration_ms', String(options.minSilenceDurationMs));
    }
    if (options.beamSize !== undefined) formData.append('beam_size', String(options.beamSize));
    if (options.wordTimestamps !== undefined) formData.append('word_timestamps', String(options.wordTimestamps));

    return request<TranscribeResponse>('/api/transcribe', {
      method: 'POST',
      body: formData
    });
  },

  async getStatus() {
    return request<StatusResponse>('/api/status');
  },


  async getVoiceOverview() {
    return request<VoiceOverviewResponse>('/api/settings/voice');
  },

  async getVoiceTtsPreference() {
    return request<UserTtsPreference>('/api/settings/voice/preference');
  },

  async updateVoiceTtsPreference(body: UserTtsPreferencePatch) {
    return jsonRequest<UserTtsPreference>('/api/settings/voice/preference', 'PATCH', body);
  },

  async getVoiceHealth() {
    return request<Record<string, unknown>>('/api/settings/voice/health');
  },

  async getVoiceGpu() {
    return request<VoiceGpuResponse>('/api/settings/voice/gpu');
  },

  async getVoiceModels() {
    return request<VoiceModelsResponse>('/api/settings/voice/models');
  },

  async getSttModels() {
    return request<VoiceModelCatalogResponse>('/api/settings/voice/models/stt');
  },

  async getTtsModels() {
    return request<VoiceModelCatalogResponse>('/api/settings/voice/models/tts');
  },

  async loadSttModel(body: LoadSttModelRequest) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/models/stt/load', 'POST', body);
  },

  async unloadSttModel(body: UnloadVoiceModelRequest = { strategy: 'soft', clearCache: true }) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/models/stt/unload', 'POST', body);
  },

  async loadTtsModel(body: LoadTtsModelRequest) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/models/tts/load', 'POST', body);
  },

  async unloadTtsModel(body: UnloadTtsModelRequest) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/models/tts/unload', 'POST', body);
  },

  async reloadTtsModel(body: { provider: TtsProviderId; model?: string; language?: string; options?: Record<string, unknown> }) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/models/tts/reload', 'POST', body);
  },

  async getVoiceConfig() {
    return request<VoiceConfigResponse>('/api/settings/voice/config');
  },

  async updateSttConfig(body: UpdateSttConfigRequest) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/config/stt', 'PATCH', body);
  },

  async updateTtsConfig(body: UpdateTtsConfigRequest) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/config/tts', 'PATCH', body);
  },

  async listVoices() {
    return request<VoiceDescriptorsResponse>('/api/settings/voice/voices');
  },

  async listVoiceReferences() {
    return request<VoiceReferencesResponse>('/api/settings/voice/references');
  },

  async selectVoiceReference(id: string) {
    return jsonRequest<VoiceMutationResponse>('/api/settings/voice/references/select', 'POST', { id });
  },

  async deleteVoiceReference(id: string) {
    return jsonRequest<VoiceMutationResponse>(`/api/settings/voice/references/${encodeURIComponent(id)}`, 'DELETE');
  },

  async uploadReferenceAudio(file: File | Blob, options: { filename?: string; displayName?: string } = {}) {
    const filename = options.filename || (typeof (file as { name?: unknown }).name === 'string' ? (file as { name: string }).name : 'reference.wav');
    const formData = new FormData();
    formData.append('reference_audio', file, filename);
    if (options.displayName) formData.append('displayName', options.displayName);
    return request<VoiceMutationResponse>('/api/settings/voice/reference-audio', {
      method: 'POST',
      body: formData
    });
  },

  async getModelSettings() {
    return request<ModelManagementStatus>('/api/settings/models');
  },

  async getModelDetails(model: string) {
    return jsonRequest<ModelDetailsResponse>('/api/settings/models/details', 'POST', { model });
  },

  async loadModel(model: string, makeDefault: boolean) {
    return jsonRequest<ModelLoadResponse>('/api/settings/models/load', 'POST', { model, makeDefault });
  },

  async pullModel(model: string, onProgress?: (event: ModelPullProgressEvent) => void) {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);

    const response = await fetch('/api/settings/models/pull', {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ model })
    });

    if (!response.ok) {
      return parseJsonErrorResponse(response);
    }

    return parseModelPullStream(response, onProgress);
  },

  async deleteModel(model: string) {
    return jsonRequest<ModelDeleteResponse>('/api/settings/models', 'DELETE', { model });
  }
};
