import type {
  AdminUser,
  AuthResponse,
  Conversation,
  ConversationSummary,
  LoginUser,
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

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const errorData = data as ApiErrorShape | null;
    if (response.status === 401) unauthorizedHandler?.();
    throw new ApiClientError(
      errorData?.error?.message || `Request failed with HTTP ${response.status}`,
      response.status,
      errorData?.error?.code,
      errorData?.error?.details
    );
  }

  return data as T;
};

const isMutatingMethod = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());

const request = async <T>(path: string, init: RequestInit = {}) => {
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
    })
  );
};

const jsonRequest = async <T>(path: string, method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body?: unknown) =>
  request<T>(path, {
    method,
    headers: {
      'Content-Type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

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
    const response = await jsonRequest<AuthResponse>('/api/auth/change-password', 'POST', {
      currentPassword,
      newPassword,
      confirmPassword
    });
    csrfToken = response.csrfToken;
    return response;
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
  }
};
