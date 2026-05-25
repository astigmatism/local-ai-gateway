import type {
  AdminUser,
  AuthResponse,
  Conversation,
  ConversationSummary,
  GenerateConversationTitleResponse,
  LoginUser,
  ModelDeleteResponse,
  ModelDetailsResponse,
  ModelLoadResponse,
  ModelManagementStatus,
  ModelPullProgressEvent,
  SendMessageResponse,
  StatusResponse,
  TranscribeResponse
} from './types.js';

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
  voice?: string;
  speed?: number;
  signal?: AbortSignal;
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
  let errorEvent: ModelPullProgressEvent | null = null;

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
    return request<{ users: AdminUser[] }>('/api/admin/users');
  },

  async createAdminUser(displayName: string) {
    return jsonRequest<{ user: AdminUser }>('/api/admin/users', 'POST', { displayName });
  },

  async deactivateAdminUser(userId: string) {
    return jsonRequest<{ user: AdminUser }>(`/api/admin/users/${userId}/deactivate`, 'PATCH');
  },

  async resetAdminUserPassword(userId: string) {
    return jsonRequest<{ user: AdminUser }>(`/api/admin/users/${userId}/reset-password`, 'POST');
  },

  async listConversations(userId: string) {
    return request<{ conversations: ConversationSummary[] }>(`/api/users/${userId}/conversations`);
  },

  async createConversation(userId: string, title?: string) {
    return jsonRequest<{ conversation: ConversationSummary }>(`/api/users/${userId}/conversations`, 'POST', { title });
  },

  async getConversation(conversationId: string) {
    return request<{ conversation: Conversation }>(`/api/conversations/${conversationId}`);
  },

  async deleteConversation(userId: string, conversationId: string) {
    return jsonRequest<{ conversation: ConversationSummary }>(
      `/api/users/${userId}/conversations/${conversationId}`,
      'DELETE'
    );
  },

  async sendMessage(conversationId: string, content: string) {
    return jsonRequest<SendMessageResponse>(`/api/conversations/${conversationId}/messages`, 'POST', { content });
  },

  async generateConversationTitle(conversationId: string, source = 'first-message') {
    return jsonRequest<GenerateConversationTitleResponse>(
      `/api/conversations/${conversationId}/generate-title`,
      'POST',
      { source }
    );
  },

  async speakText(text: string, options: SpeakTextOptions = {}) {
    return requestBlob('/api/speak', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text,
        voice: options.voice,
        speed: options.speed
      }),
      signal: options.signal
    });
  },

  async transcribeAudio(file: Blob, options: { userId?: string; conversationId?: string }) {
    const formData = new FormData();
    const extension = file.type.includes('mp4') ? 'm4a' : file.type.includes('wav') ? 'wav' : 'webm';
    formData.append('file', file, `browser-recording.${extension}`);
    if (options.userId) formData.append('userId', options.userId);
    if (options.conversationId) formData.append('conversationId', options.conversationId);

    return request<TranscribeResponse>('/api/transcribe', {
      method: 'POST',
      body: formData
    });
  },

  async getStatus() {
    return request<StatusResponse>('/api/status');
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
