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

export interface SendMessageResponse {
  userMessage: Message;
  assistantMessage: Message;
  conversation: ConversationSummary;
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
}
