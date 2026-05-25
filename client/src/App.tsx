import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AdminUserManagement } from './components/AdminUserManagement.js';
import { ChatInput } from './components/ChatInput.js';
import { LoginScreen } from './components/LoginScreen.js';
import { MessageThread } from './components/MessageThread.js';
import { PasswordChangeScreen } from './components/PasswordChangeScreen.js';
import { SettingsModal } from './components/SettingsModal.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusCards } from './components/StatusCards.js';
import { TopBar } from './components/TopBar.js';
import { useAudioRecorder } from './hooks/useAudioRecorder.js';
import { api, ApiClientError } from './lib/api.js';
import { appendTranscript } from './lib/transcripts.js';
import type { AuthUser, Conversation, ConversationSummary, GatewayStatus, Message, PasswordPolicy } from './lib/types.js';

const layoutStorageKeys = {
  leftColumnWidth: 'bearCastleAi.layout.leftColumnWidth',
  healthPaneHeight: 'bearCastleAi.layout.healthPaneHeight',
  composerPaneHeight: 'bearCastleAi.layout.composerPaneHeight',
  legacyBottomRowHeight: 'bearCastleAi.layout.bottomRowHeight',
  healthCollapsed: 'bearCastleAi.layout.healthCollapsed'
} as const;

const splitterSize = 8;
const collapsedHealthPaneHeight = 52;
const defaultLeftColumnWidth = 300;
const defaultHealthPaneHeight = 190;
const defaultComposerPaneHeight = 220;
const defaultPasswordPolicy: PasswordPolicy = { minLength: 8 };

interface WorkspaceLayout {
  leftColumnWidth: number;
  healthPaneHeight: number;
  composerPaneHeight: number;
  healthCollapsed: boolean;
}

interface LayoutBounds {
  minLeftColumnWidth: number;
  maxLeftColumnWidth: number;
  minHealthPaneHeight: number;
  maxHealthPaneHeight: number;
  minComposerPaneHeight: number;
  maxComposerPaneHeight: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

const getStoredNumber = (key: string, fallback: number) => {
  const value = window.localStorage.getItem(key);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const getStoredBoolean = (key: string, fallback: boolean) => {
  const value = window.localStorage.getItem(key);
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
};

const calculateVerticalSplitBounds = (
  height: number,
  preferredMinTopPaneHeight: number,
  preferredMinBottomPaneHeight: number,
  absoluteMinTopPaneHeight: number,
  absoluteMinBottomPaneHeight: number
) => {
  const paneSpace = Math.max(height - splitterSize, 1);
  let minTopPaneHeight = preferredMinTopPaneHeight;
  let minBottomPaneHeight = preferredMinBottomPaneHeight;

  if (minTopPaneHeight + minBottomPaneHeight > paneSpace) {
    const scale = paneSpace / (minTopPaneHeight + minBottomPaneHeight);
    minTopPaneHeight = Math.max(absoluteMinTopPaneHeight, Math.floor(minTopPaneHeight * scale));
    minBottomPaneHeight = Math.max(absoluteMinBottomPaneHeight, Math.floor(minBottomPaneHeight * scale));
  }

  if (minTopPaneHeight + minBottomPaneHeight > paneSpace) {
    const absoluteTotal = absoluteMinTopPaneHeight + absoluteMinBottomPaneHeight;

    if (absoluteTotal <= paneSpace) {
      const extraSpace = paneSpace - absoluteTotal;
      const topExtra = Math.floor(extraSpace * 0.6);
      minTopPaneHeight = absoluteMinTopPaneHeight + topExtra;
      minBottomPaneHeight = absoluteMinBottomPaneHeight + (extraSpace - topExtra);
    } else {
      minTopPaneHeight = Math.max(0, Math.floor(paneSpace * 0.58));
      minBottomPaneHeight = Math.max(0, paneSpace - minTopPaneHeight);
    }
  }

  return {
    minBottomPaneHeight,
    maxBottomPaneHeight: Math.max(minBottomPaneHeight, paneSpace - minTopPaneHeight)
  };
};

const calculateLayoutBounds = (workspace: HTMLDivElement | null): LayoutBounds => {
  const rect = workspace?.getBoundingClientRect();
  const width = Math.max(rect?.width ?? window.innerWidth, 320);
  const height = Math.max(rect?.height ?? window.innerHeight - 64, 320);
  const columnSpace = Math.max(width - splitterSize, 1);

  let minLeftColumnWidth = width >= 840 ? 240 : 180;
  let minRightColumnWidth = width >= 840 ? 520 : 260;

  if (minLeftColumnWidth + minRightColumnWidth > columnSpace) {
    const scale = columnSpace / (minLeftColumnWidth + minRightColumnWidth);
    minLeftColumnWidth = Math.max(140, Math.floor(minLeftColumnWidth * scale));
    minRightColumnWidth = Math.max(180, Math.floor(minRightColumnWidth * scale));
  }

  if (minLeftColumnWidth + minRightColumnWidth > columnSpace) {
    minRightColumnWidth = Math.max(120, columnSpace - minLeftColumnWidth);
  }

  const maxLeftColumnWidth = Math.max(minLeftColumnWidth, columnSpace - minRightColumnWidth);
  const healthBounds = calculateVerticalSplitBounds(
    height,
    height >= 620 ? 220 : 130,
    height >= 620 ? 140 : 92,
    96,
    collapsedHealthPaneHeight
  );
  const composerBounds = calculateVerticalSplitBounds(
    height,
    height >= 620 ? 320 : 210,
    height >= 620 ? 170 : 150,
    150,
    132
  );

  return {
    minLeftColumnWidth,
    maxLeftColumnWidth,
    minHealthPaneHeight: healthBounds.minBottomPaneHeight,
    maxHealthPaneHeight: healthBounds.maxBottomPaneHeight,
    minComposerPaneHeight: composerBounds.minBottomPaneHeight,
    maxComposerPaneHeight: composerBounds.maxBottomPaneHeight
  };
};

const clampLayout = (layout: WorkspaceLayout, workspace: HTMLDivElement | null): WorkspaceLayout => {
  const bounds = calculateLayoutBounds(workspace);
  return {
    leftColumnWidth: clamp(layout.leftColumnWidth, bounds.minLeftColumnWidth, bounds.maxLeftColumnWidth),
    healthPaneHeight: clamp(layout.healthPaneHeight, bounds.minHealthPaneHeight, bounds.maxHealthPaneHeight),
    composerPaneHeight: clamp(layout.composerPaneHeight, bounds.minComposerPaneHeight, bounds.maxComposerPaneHeight),
    healthCollapsed: layout.healthCollapsed
  };
};

const getInitialLayout = (): WorkspaceLayout =>
  clampLayout(
    {
      leftColumnWidth: getStoredNumber(layoutStorageKeys.leftColumnWidth, defaultLeftColumnWidth),
      healthPaneHeight: getStoredNumber(layoutStorageKeys.healthPaneHeight, defaultHealthPaneHeight),
      composerPaneHeight: getStoredNumber(
        layoutStorageKeys.composerPaneHeight,
        getStoredNumber(layoutStorageKeys.legacyBottomRowHeight, defaultComposerPaneHeight)
      ),
      healthCollapsed: getStoredBoolean(layoutStorageKeys.healthCollapsed, false)
    },
    null
  );

const errorMessage = (error: unknown) => {
  if (error instanceof ApiClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Unexpected error.';
};

const newConversationTitle = 'New conversation';

type OptimisticDeliveryStatus = 'pending' | 'thinking' | 'error';

const createTemporaryId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getDeliveryStatus = (message: Message): OptimisticDeliveryStatus | null => {
  const status = message.metadata?.deliveryStatus;
  return status === 'pending' || status === 'thinking' || status === 'error' ? status : null;
};

const isOptimisticMessage = (message: Message) => message.metadata?.optimistic === true;

const getSubmittedAt = (message: Message) => {
  const submittedAt = message.metadata?.submittedAt;
  return typeof submittedAt === 'string' ? submittedAt : message.createdAt;
};

const createOptimisticMessage = ({
  conversationId,
  role,
  content,
  deliveryStatus,
  createdAt,
  submittedAt
}: {
  conversationId: string;
  role: Message['role'];
  content: string;
  deliveryStatus: OptimisticDeliveryStatus;
  createdAt: Date;
  submittedAt: string;
}): Message => ({
  id: createTemporaryId(deliveryStatus === 'thinking' ? 'temp-assistant-thinking' : `temp-${role}`),
  conversationId,
  role,
  content,
  metadata: {
    optimistic: true,
    deliveryStatus,
    submittedAt
  },
  createdAt: createdAt.toISOString()
});

const createConversationFromSummary = (
  conversation: ConversationSummary,
  messages: Message[],
  fallbackConversation?: Conversation | null
): Conversation => ({
  ...conversation,
  messages,
  user: fallbackConversation?.user
});

const createOptimisticConversationShell = ({
  conversationId,
  userId,
  title,
  createdAt
}: {
  conversationId: string;
  userId: string;
  title: string;
  createdAt: string;
}): Conversation => ({
  id: conversationId,
  userId,
  title,
  archived: false,
  createdAt,
  updatedAt: createdAt,
  messages: []
});

const appendUniqueMessages = (currentMessages: Message[], messagesToAppend: Message[]) => {
  const seen = new Set(currentMessages.map((message) => message.id));
  const nextMessages = [...currentMessages];

  for (const message of messagesToAppend) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    nextMessages.push(message);
  }

  return nextMessages;
};

const shouldShowOptimisticMessage = (message: Message, persistedMessages: Message[]) => {
  const deliveryStatus = getDeliveryStatus(message);
  const submittedAt = Date.parse(getSubmittedAt(message));

  if (message.role === 'user' && (deliveryStatus === 'pending' || deliveryStatus === 'error')) {
    return !persistedMessages.some(
      (persistedMessage) =>
        persistedMessage.role === 'user' &&
        persistedMessage.content === message.content &&
        (!Number.isFinite(submittedAt) || Date.parse(persistedMessage.createdAt) >= submittedAt - 1000)
    );
  }

  if (message.role === 'assistant' && deliveryStatus === 'thinking') {
    return !persistedMessages.some(
      (persistedMessage) =>
        persistedMessage.role === 'assistant' &&
        (!Number.isFinite(submittedAt) || Date.parse(persistedMessage.createdAt) >= submittedAt - 1000)
    );
  }

  return true;
};

const mergeVisibleMessages = (persistedMessages: Message[], optimisticMessages: Message[]) => [
  ...persistedMessages,
  ...optimisticMessages.filter((message) => shouldShowOptimisticMessage(message, persistedMessages))
];

const upsertConversationSummary = (
  conversations: ConversationSummary[],
  conversation: ConversationSummary
): ConversationSummary[] => {
  const withoutConversation = conversations.filter((item) => item.id !== conversation.id);
  return [conversation, ...withoutConversation];
};

const isPersistedMessage = (value: unknown): value is Message => {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.conversationId === 'string' &&
    (value.role === 'user' || value.role === 'assistant' || value.role === 'system') &&
    typeof value.content === 'string' &&
    typeof value.createdAt === 'string'
  );
};

const savedUserMessageFromError = (error: unknown) => {
  if (!(error instanceof ApiClientError) || !isRecord(error.details)) return null;
  const userMessage = error.details.userMessage;
  return isPersistedMessage(userMessage) && userMessage.role === 'user' ? userMessage : null;
};

export const App = () => {
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);
  const composerNoticeTimerRef = useRef<number | null>(null);
  const titleGenerationFramesRef = useRef<Map<string, number>>(new Map());
  const titleGenerationTimersRef = useRef<Map<string, number>>(new Map());
  const titleGenerationInFlightRef = useRef<Set<string>>(new Set());
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [passwordPolicy, setPasswordPolicy] = useState<PasswordPolicy>(defaultPasswordPolicy);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [optimisticConversation, setOptimisticConversation] = useState<Conversation | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [composerNotice, setComposerNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loadingConversations, setLoadingConversations] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState<string | null>(null);
  const [layout, setLayout] = useState<WorkspaceLayout>(() => getInitialLayout());

  const activeUserId = authUser?.id ?? null;

  const cancelScheduledTitleGeneration = useCallback((conversationId: string) => {
    const frameId = titleGenerationFramesRef.current.get(conversationId);
    if (frameId !== undefined) {
      window.cancelAnimationFrame(frameId);
      titleGenerationFramesRef.current.delete(conversationId);
    }

    const timerId = titleGenerationTimersRef.current.get(conversationId);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      titleGenerationTimersRef.current.delete(conversationId);
    }
  }, []);

  const clearScheduledTitleGenerations = useCallback(() => {
    for (const frameId of titleGenerationFramesRef.current.values()) {
      window.cancelAnimationFrame(frameId);
    }
    titleGenerationFramesRef.current.clear();

    for (const timerId of titleGenerationTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    titleGenerationTimersRef.current.clear();
  }, []);

  const resetConversationState = useCallback(() => {
    clearScheduledTitleGenerations();
    setConversations([]);
    setActiveConversationId(null);
    setActiveConversation(null);
    setOptimisticConversation(null);
    setOptimisticMessages([]);
    setDraft('');
    setStatus(null);
    setError(null);
  }, [clearScheduledTitleGenerations]);

  const handleUnauthenticated = useCallback(() => {
    api.setCsrfToken(null);
    setAuthUser(null);
    setPasswordPolicy(defaultPasswordPolicy);
    setMustChangePassword(false);
    setShowPasswordChange(false);
    setShowUserManagement(false);
    setShowSettings(false);
    resetConversationState();
    setAuthLoading(false);
  }, [resetConversationState]);

  const visibleConversation = useMemo(() => {
    const baseConversation = activeConversationId
      ? activeConversation?.id === activeConversationId
        ? activeConversation
        : optimisticConversation?.id === activeConversationId
          ? optimisticConversation
          : null
      : optimisticConversation;

    if (!baseConversation) return null;

    const matchingOptimisticMessages = optimisticMessages.filter(
      (message) => message.conversationId === baseConversation.id
    );

    if (matchingOptimisticMessages.length === 0) return baseConversation;

    return {
      ...baseConversation,
      updatedAt: matchingOptimisticMessages.at(-1)?.createdAt ?? baseConversation.updatedAt,
      messages: mergeVisibleMessages(baseConversation.messages, matchingOptimisticMessages)
    };
  }, [activeConversation, activeConversationId, optimisticConversation, optimisticMessages]);

  const visibleHealthPaneHeight = layout.healthCollapsed ? collapsedHealthPaneHeight : layout.healthPaneHeight;

  const workspaceStyle = {
    '--left-column-width': `${layout.leftColumnWidth}px`,
    '--health-pane-height': `${visibleHealthPaneHeight}px`,
    '--composer-pane-height': `${layout.composerPaneHeight}px`
  } as CSSProperties;

  useEffect(() => {
    api.setUnauthorizedHandler(handleUnauthenticated);
    return () => api.setUnauthorizedHandler(null);
  }, [handleUnauthenticated]);

  useEffect(() => {
    let cancelled = false;

    const loadMe = async () => {
      setAuthLoading(true);
      try {
        const response = await api.me();
        if (cancelled) return;
        setAuthUser(response.user);
        setPasswordPolicy(response.passwordPolicy);
        setMustChangePassword(response.mustChangePassword);
      } catch (authError) {
        if (!cancelled && !(authError instanceof ApiClientError && authError.status === 401)) {
          setError(`Could not restore session: ${errorMessage(authError)}`);
        }
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    };

    void loadMe();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(layoutStorageKeys.leftColumnWidth, String(layout.leftColumnWidth));
  }, [layout.leftColumnWidth]);

  useEffect(() => {
    window.localStorage.setItem(layoutStorageKeys.healthPaneHeight, String(layout.healthPaneHeight));
  }, [layout.healthPaneHeight]);

  useEffect(() => {
    window.localStorage.setItem(layoutStorageKeys.composerPaneHeight, String(layout.composerPaneHeight));
  }, [layout.composerPaneHeight]);

  useEffect(() => {
    window.localStorage.setItem(layoutStorageKeys.healthCollapsed, String(layout.healthCollapsed));
  }, [layout.healthCollapsed]);

  useEffect(() => {
    const clampCurrentLayout = () => {
      setLayout((current) => clampLayout(current, workspaceRef.current));
    };

    clampCurrentLayout();
    window.addEventListener('resize', clampCurrentLayout);
    return () => window.removeEventListener('resize', clampCurrentLayout);
  }, []);

  const updateLayout = useCallback((updater: (current: WorkspaceLayout) => WorkspaceLayout) => {
    setLayout((current) => clampLayout(updater(current), workspaceRef.current));
  }, []);

  useEffect(
    () => () => {
      if (composerNoticeTimerRef.current) window.clearTimeout(composerNoticeTimerRef.current);
      clearScheduledTitleGenerations();
    },
    [clearScheduledTitleGenerations]
  );

  const showComposerNotice = useCallback((message: string) => {
    if (composerNoticeTimerRef.current) window.clearTimeout(composerNoticeTimerRef.current);
    setComposerNotice(message);
    composerNoticeTimerRef.current = window.setTimeout(() => setComposerNotice(null), 2200);
  }, []);

  const focusComposerAtEnd = useCallback(() => {
    window.requestAnimationFrame(() => {
      const composer = composerRef.current;
      if (!composer) return;

      composer.focus({ preventScroll: false });
      const cursorPosition = composer.value.length;
      try {
        composer.setSelectionRange(cursorPosition, cursorPosition);
      } catch {
        // Some browsers may refuse selection changes on inactive controls; focusing still succeeds when possible.
      }
    });
  }, []);

  const beginColumnResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const workspace = workspaceRef.current;
    if (!workspace) return;

    event.preventDefault();
    const rect = workspace.getBoundingClientRect();
    document.body.classList.add('layout-resizing');

    const resize = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const leftColumnWidth = moveEvent.clientX - rect.left;
      setLayout((current) => clampLayout({ ...current, leftColumnWidth }, workspace));
    };

    const stopResize = () => {
      document.body.classList.remove('layout-resizing');
      document.removeEventListener('pointermove', resize);
      document.removeEventListener('pointerup', stopResize);
      document.removeEventListener('pointercancel', stopResize);
    };

    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stopResize, { once: true });
    document.addEventListener('pointercancel', stopResize, { once: true });
  }, []);

  const beginHealthResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const workspace = workspaceRef.current;
    const column = event.currentTarget.parentElement as HTMLDivElement | null;
    if (!workspace || !column) return;

    event.preventDefault();
    const rect = column.getBoundingClientRect();
    document.body.classList.add('layout-resizing');

    const resize = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const healthPaneHeight = rect.bottom - moveEvent.clientY;
      setLayout((current) => clampLayout({ ...current, healthCollapsed: false, healthPaneHeight }, workspace));
    };

    const stopResize = () => {
      document.body.classList.remove('layout-resizing');
      document.removeEventListener('pointermove', resize);
      document.removeEventListener('pointerup', stopResize);
      document.removeEventListener('pointercancel', stopResize);
    };

    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stopResize, { once: true });
    document.addEventListener('pointercancel', stopResize, { once: true });
  }, []);

  const beginComposerResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    const workspace = workspaceRef.current;
    const column = event.currentTarget.parentElement as HTMLDivElement | null;
    if (!workspace || !column) return;

    event.preventDefault();
    const rect = column.getBoundingClientRect();
    document.body.classList.add('layout-resizing');

    const resize = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      const composerPaneHeight = rect.bottom - moveEvent.clientY;
      setLayout((current) => clampLayout({ ...current, composerPaneHeight }, workspace));
    };

    const stopResize = () => {
      document.body.classList.remove('layout-resizing');
      document.removeEventListener('pointermove', resize);
      document.removeEventListener('pointerup', stopResize);
      document.removeEventListener('pointercancel', stopResize);
    };

    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stopResize, { once: true });
    document.addEventListener('pointercancel', stopResize, { once: true });
  }, []);

  const handleColumnResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 60 : 24;
      const bounds = calculateLayoutBounds(workspaceRef.current);

      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, leftColumnWidth: current.leftColumnWidth - step }));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, leftColumnWidth: current.leftColumnWidth + step }));
      } else if (event.key === 'Home') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, leftColumnWidth: bounds.minLeftColumnWidth }));
      } else if (event.key === 'End') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, leftColumnWidth: bounds.maxLeftColumnWidth }));
      }
    },
    [updateLayout]
  );

  const handleHealthResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 60 : 24;
      const bounds = calculateLayoutBounds(workspaceRef.current);

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        updateLayout((current) => ({
          ...current,
          healthCollapsed: false,
          healthPaneHeight: current.healthPaneHeight + step
        }));
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        updateLayout((current) => ({
          ...current,
          healthCollapsed: false,
          healthPaneHeight: current.healthPaneHeight - step
        }));
      } else if (event.key === 'Home') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, healthCollapsed: false, healthPaneHeight: bounds.minHealthPaneHeight }));
      } else if (event.key === 'End') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, healthCollapsed: false, healthPaneHeight: bounds.maxHealthPaneHeight }));
      }
    },
    [updateLayout]
  );

  const handleComposerResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 60 : 24;
      const bounds = calculateLayoutBounds(workspaceRef.current);

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, composerPaneHeight: current.composerPaneHeight + step }));
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, composerPaneHeight: current.composerPaneHeight - step }));
      } else if (event.key === 'Home') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, composerPaneHeight: bounds.minComposerPaneHeight }));
      } else if (event.key === 'End') {
        event.preventDefault();
        updateLayout((current) => ({ ...current, composerPaneHeight: bounds.maxComposerPaneHeight }));
      }
    },
    [updateLayout]
  );

  const loadConversations = useCallback(async (userId: string) => {
    setLoadingConversations(true);
    try {
      const response = await api.listConversations(userId);
      setConversations(response.conversations);
    } catch (loadError) {
      if (!(loadError instanceof ApiClientError && loadError.status === 401)) {
        setError(`Could not load conversations: ${errorMessage(loadError)}`);
      }
    } finally {
      setLoadingConversations(false);
    }
  }, []);

  const loadConversation = useCallback(async (conversationId: string) => {
    setLoadingConversation(true);
    try {
      const response = await api.getConversation(conversationId);
      setActiveConversation(response.conversation);
    } catch (loadError) {
      if (!(loadError instanceof ApiClientError && loadError.status === 401)) {
        setError(`Could not open conversation: ${errorMessage(loadError)}`);
      }
    } finally {
      setLoadingConversation(false);
    }
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const response = await api.getStatus();
      setStatus(response.status);
    } catch (statusError) {
      if (statusError instanceof ApiClientError && statusError.status === 401) return;
      setStatus((current) => current);
    }
  }, []);

  const applyConversationTitleUpdate = useCallback((conversation: ConversationSummary) => {
    setConversations((current) =>
      current.some((item) => item.id === conversation.id) ? upsertConversationSummary(current, conversation) : current
    );

    setActiveConversation((current) =>
      current?.id === conversation.id ? createConversationFromSummary(conversation, current.messages, current) : current
    );

    setOptimisticConversation((current) =>
      current?.id === conversation.id ? createConversationFromSummary(conversation, current.messages, current) : current
    );
  }, []);

  const runDeferredTitleGeneration = useCallback(
    async (conversationId: string) => {
      if (titleGenerationInFlightRef.current.has(conversationId)) return;
      titleGenerationInFlightRef.current.add(conversationId);

      try {
        const response = await api.generateConversationTitle(conversationId);
        applyConversationTitleUpdate(response.conversation);
      } catch (titleError) {
        if (
          titleError instanceof ApiClientError &&
          (titleError.status === 401 ||
            titleError.status === 403 ||
            titleError.status === 404 ||
            titleError.status === 429)
        ) {
          return;
        }
      } finally {
        titleGenerationInFlightRef.current.delete(conversationId);
      }
    },
    [applyConversationTitleUpdate]
  );

  const scheduleDeferredTitleGeneration = useCallback(
    (conversationId: string) => {
      if (
        titleGenerationInFlightRef.current.has(conversationId) ||
        titleGenerationFramesRef.current.has(conversationId) ||
        titleGenerationTimersRef.current.has(conversationId)
      ) {
        return;
      }

      const frameId = window.requestAnimationFrame(() => {
        titleGenerationFramesRef.current.delete(conversationId);
        const timerId = window.setTimeout(() => {
          titleGenerationTimersRef.current.delete(conversationId);
          void runDeferredTitleGeneration(conversationId);
        }, 0);
        titleGenerationTimersRef.current.set(conversationId, timerId);
      });

      titleGenerationFramesRef.current.set(conversationId, frameId);
    },
    [runDeferredTitleGeneration]
  );

  useEffect(() => {
    if (!activeUserId || mustChangePassword) {
      setConversations([]);
      setActiveConversationId(null);
      setActiveConversation(null);
      setOptimisticConversation(null);
      setOptimisticMessages([]);
      return;
    }

    void loadConversations(activeUserId);
  }, [activeUserId, loadConversations, mustChangePassword]);

  useEffect(() => {
    if (!activeConversationId || mustChangePassword) {
      setActiveConversation(null);
      return;
    }

    void loadConversation(activeConversationId);
  }, [activeConversationId, loadConversation, mustChangePassword]);

  useEffect(() => {
    if (!authUser || mustChangePassword) return undefined;

    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 3000);
    return () => window.clearInterval(timer);
  }, [authUser, mustChangePassword, refreshStatus]);

  const handleAuthenticated = (
    user: AuthUser,
    passwordChangeRequired: boolean,
    token: string,
    nextPasswordPolicy: PasswordPolicy
  ) => {
    api.setCsrfToken(token);
    setAuthUser(user);
    setPasswordPolicy(nextPasswordPolicy);
    setMustChangePassword(passwordChangeRequired);
    setShowPasswordChange(false);
    setShowUserManagement(false);
    setShowSettings(false);
    resetConversationState();
  };

  const handlePasswordChanged = (user: AuthUser, token: string, nextPasswordPolicy: PasswordPolicy) => {
    api.setCsrfToken(token);
    setAuthUser(user);
    setPasswordPolicy(nextPasswordPolicy);

    if (user.mustChangePassword) {
      setMustChangePassword(true);
      setError('Password update did not complete. The account is still marked as requiring a password change.');
      return;
    }

    setMustChangePassword(false);
    setShowPasswordChange(false);
    setError(null);
  };

  const handleLogout = async () => {
    try {
      await api.logout();
    } finally {
      handleUnauthenticated();
    }
  };

  const closeSettings = useCallback(() => {
    setShowSettings(false);
    window.requestAnimationFrame(() => settingsButtonRef.current?.focus());
  }, []);

  const handleCreateConversation = useCallback(async () => {
    if (!activeUserId) return;
    setError(null);
    setOptimisticConversation(null);
    setOptimisticMessages([]);
    const response = await api.createConversation(activeUserId);
    setConversations((current) => upsertConversationSummary(current, response.conversation));
    setActiveConversationId(response.conversation.id);
    setDraft('');
  }, [activeUserId]);

  const handleDeleteConversation = useCallback(
    async (conversation: ConversationSummary) => {
      if (!activeUserId || deletingConversationId) return;

      const title = conversation.title.trim() || 'this conversation';
      const confirmed = window.confirm(`Delete "${title}"? This cannot be undone.`);
      if (!confirmed) return;

      setDeletingConversationId(conversation.id);
      setError(null);
      cancelScheduledTitleGeneration(conversation.id);

      try {
        await api.deleteConversation(activeUserId, conversation.id);
        setConversations((current) => current.filter((item) => item.id !== conversation.id));

        if (activeConversationId === conversation.id || optimisticConversation?.id === conversation.id) {
          setActiveConversationId(null);
          setActiveConversation(null);
          setOptimisticConversation(null);
          setOptimisticMessages([]);
          setDraft('');
        }
      } catch (deleteError) {
        setError(`Delete failed: ${errorMessage(deleteError)}`);
        void loadConversations(activeUserId);
      } finally {
        setDeletingConversationId(null);
      }
    },
    [
      activeConversationId,
      activeUserId,
      cancelScheduledTitleGeneration,
      deletingConversationId,
      loadConversations,
      optimisticConversation
    ]
  );

  const handleReusePrompt = useCallback(
    (content: string) => {
      if (content.trim().length === 0) return;

      if (draft.trim().length > 0) {
        const replaceDraft = window.confirm('Replace the current draft with this prompt?');
        if (!replaceDraft) return;
      }

      setDraft(content);
      showComposerNotice('Prompt loaded for editing.');
      focusComposerAtEnd();
    },
    [draft, focusComposerAtEnd, showComposerNotice]
  );

  const handleSend = useCallback(async () => {
    const content = draft.trim();
    if (!content || isSending || !activeUserId) return;

    const submittedAt = new Date();
    const submittedAtIso = submittedAt.toISOString();
    const optimisticConversationId = activeConversationId ?? createTemporaryId('temp-conversation');
    const optimisticTitle =
      activeConversation?.id === optimisticConversationId ? activeConversation.title : newConversationTitle;
    const optimisticUserMessage = createOptimisticMessage({
      conversationId: optimisticConversationId,
      role: 'user',
      content,
      deliveryStatus: 'pending',
      createdAt: submittedAt,
      submittedAt: submittedAtIso
    });
    const optimisticThinkingMessage = createOptimisticMessage({
      conversationId: optimisticConversationId,
      role: 'assistant',
      content: 'Thinking\u2026',
      deliveryStatus: 'thinking',
      createdAt: new Date(submittedAt.getTime() + 1),
      submittedAt: submittedAtIso
    });
    const optimisticShell = createOptimisticConversationShell({
      conversationId: optimisticConversationId,
      userId: activeUserId,
      title: optimisticTitle,
      createdAt: submittedAtIso
    });

    setIsSending(true);
    setError(null);
    setDraft('');
    setOptimisticMessages([optimisticUserMessage, optimisticThinkingMessage]);
    setOptimisticConversation(activeConversation?.id === optimisticConversationId ? null : optimisticShell);

    let conversationId = activeConversationId;
    let createdConversation: ConversationSummary | null = null;

    try {
      if (!conversationId) {
        const createResponse = await api.createConversation(activeUserId);
        createdConversation = createResponse.conversation;
        conversationId = createResponse.conversation.id;
        setOptimisticConversation(createConversationFromSummary(createResponse.conversation, []));
        setOptimisticMessages((current) =>
          current.map((message) =>
            message.conversationId === optimisticConversationId
              ? { ...message, conversationId: createResponse.conversation.id }
              : message
          )
        );
      }

      const response = await api.sendMessage(conversationId, content);
      setActiveConversationId(response.conversation.id);
      setActiveConversation((current) => {
        const currentConversation = current?.id === response.conversation.id ? current : null;
        const baseMessages = currentConversation
          ? currentConversation.messages.filter((message) => !isOptimisticMessage(message))
          : [];
        const messages = appendUniqueMessages(baseMessages, [response.userMessage, response.assistantMessage]);
        return createConversationFromSummary(response.conversation, messages, currentConversation);
      });
      setOptimisticMessages([]);
      setOptimisticConversation(null);
      setConversations((current) => upsertConversationSummary(current, response.conversation));

      if (response.titleGeneration?.needed) {
        scheduleDeferredTitleGeneration(response.conversation.id);
      }
    } catch (sendError) {
      const savedUserMessage = savedUserMessageFromError(sendError);
      const failedConversationId = savedUserMessage?.conversationId ?? conversationId ?? optimisticConversationId;
      const failedAt = new Date();
      const assistantErrorMessage = createOptimisticMessage({
        conversationId: failedConversationId,
        role: 'assistant',
        content: 'Could not send message.',
        deliveryStatus: 'error',
        createdAt: failedAt,
        submittedAt: submittedAtIso
      });
      const failedConversationShell = createdConversation
        ? createConversationFromSummary(createdConversation, [], null)
        : createOptimisticConversationShell({
            conversationId: failedConversationId,
            userId: activeUserId,
            title: optimisticTitle,
            createdAt: submittedAtIso
          });

      setError(`Send failed: ${errorMessage(sendError)}`);

      if (conversationId) {
        setActiveConversationId(conversationId);
      }

      if (createdConversation) {
        const conversationToAdd = createdConversation;
        setConversations((current) => upsertConversationSummary(current, conversationToAdd));
      }

      setOptimisticConversation((current) => {
        if (activeConversation?.id === failedConversationId) return null;
        if (current?.id === failedConversationId) return current;
        if (current?.id === optimisticConversationId) {
          return { ...current, id: failedConversationId, updatedAt: failedAt.toISOString() };
        }
        return failedConversationShell;
      });

      if (savedUserMessage) {
        setDraft('');
        setActiveConversation((current) => {
          const currentConversation = current?.id === failedConversationId ? current : null;
          const baseConversation = currentConversation
            ? currentConversation
            : createdConversation
              ? createConversationFromSummary(createdConversation, [], null)
              : failedConversationShell;
          const baseMessages = currentConversation
            ? currentConversation.messages.filter((message) => !isOptimisticMessage(message))
            : [];
          return {
            ...baseConversation,
            updatedAt: savedUserMessage.createdAt,
            messages: appendUniqueMessages(baseMessages, [savedUserMessage])
          };
        });
        setOptimisticMessages([assistantErrorMessage]);
      } else {
        setDraft(content);
        setOptimisticMessages([
          {
            ...optimisticUserMessage,
            conversationId: failedConversationId,
            metadata: {
              ...(optimisticUserMessage.metadata ?? {}),
              deliveryStatus: 'error'
            }
          },
          assistantErrorMessage
        ]);
      }

      if (conversationId) void loadConversation(conversationId);
      if (activeUserId) void loadConversations(activeUserId);
    } finally {
      setIsSending(false);
    }
  }, [
    activeConversation,
    activeConversationId,
    activeUserId,
    draft,
    isSending,
    loadConversation,
    loadConversations,
    scheduleDeferredTitleGeneration
  ]);

  const handleRecordingComplete = useCallback(
    async (blob: Blob) => {
      setIsTranscribing(true);
      setError(null);
      try {
        const response = await api.transcribeAudio(blob, {
          userId: activeUserId ?? undefined,
          conversationId: activeConversationId ?? undefined
        });
        setDraft((current) => appendTranscript(current, response.transcript));
      } catch (transcribeError) {
        setError(`Transcription failed: ${errorMessage(transcribeError)}`);
      } finally {
        setIsTranscribing(false);
      }
    },
    [activeConversationId, activeUserId]
  );

  const recorder = useAudioRecorder({
    onRecordingComplete: handleRecordingComplete,
    onError: (message) => setError(message)
  });

  if (authLoading) {
    return (
      <main className="auth-screen">
        <section className="auth-card password-card">
          <div className="auth-brand login-brand" aria-label="Bear Castle AI">
            <span className="app-brand-mark">BC</span>
            <h1>Bear Castle AI</h1>
          </div>
          <p className="auth-help">Checking your session...</p>
        </section>
      </main>
    );
  }

  if (!authUser) {
    return <LoginScreen onAuthenticated={handleAuthenticated} />;
  }

  if (mustChangePassword) {
    return (
      <PasswordChangeScreen
        user={authUser}
        passwordPolicy={passwordPolicy}
        required
        onChanged={handlePasswordChanged}
      />
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        activeUser={authUser}
        settingsButtonRef={settingsButtonRef}
        onOpenSettings={() => setShowSettings(true)}
        onChangePassword={() => setShowPasswordChange(true)}
        onOpenUserManagement={() => setShowUserManagement(true)}
        onLogout={handleLogout}
      />

      <div className="workspace" ref={workspaceRef} style={workspaceStyle}>
        <div className="workspace-column workspace-column-left">
          <Sidebar
            activeUserId={activeUserId}
            conversations={conversations}
            activeConversationId={activeConversationId}
            onCreateConversation={handleCreateConversation}
            onSelectConversation={(conversationId) => {
              setError(null);
              setOptimisticConversation(null);
              setOptimisticMessages([]);
              setActiveConversationId(conversationId);
            }}
            onDeleteConversation={handleDeleteConversation}
            deletingConversationId={deletingConversationId}
            loadingConversations={loadingConversations}
          />

          <div
            className="workspace-resizer workspace-resizer-horizontal workspace-resizer-horizontal-left"
            role="separator"
            aria-label="Resize conversation history and system health"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(visibleHealthPaneHeight)}
            tabIndex={0}
            onPointerDown={beginHealthResize}
            onKeyDown={handleHealthResizeKeyDown}
          />

          <section className="health-pane" aria-label="System health">
            <StatusCards
              status={status}
              collapsed={layout.healthCollapsed}
              onToggleCollapsed={() =>
                updateLayout((current) => ({ ...current, healthCollapsed: !current.healthCollapsed }))
              }
            />
          </section>
        </div>

        <div
          className="workspace-resizer workspace-resizer-vertical"
          role="separator"
          aria-label="Resize conversation column"
          aria-orientation="vertical"
          aria-valuenow={Math.round(layout.leftColumnWidth)}
          tabIndex={0}
          onPointerDown={beginColumnResize}
          onKeyDown={handleColumnResizeKeyDown}
        />

        <div className="workspace-column workspace-column-right">
          <section className="main-pane" aria-label="Main conversation">
            {error && (
              <div className="error-banner" role="alert">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                  Dismiss
                </button>
              </div>
            )}

            <MessageThread
              conversation={visibleConversation}
              loading={loadingConversation && !visibleConversation}
              onReusePrompt={handleReusePrompt}
            />
          </section>

          <div
            className="workspace-resizer workspace-resizer-horizontal workspace-resizer-horizontal-right"
            role="separator"
            aria-label="Resize conversation and message composer"
            aria-orientation="horizontal"
            aria-valuenow={Math.round(layout.composerPaneHeight)}
            tabIndex={0}
            onPointerDown={beginComposerResize}
            onKeyDown={handleComposerResizeKeyDown}
          />

          <section className="composer-pane" aria-label="Message composer">
            <ChatInput
              ref={composerRef}
              draft={draft}
              setDraft={setDraft}
              onSend={handleSend}
              onToggleRecording={recorder.toggleRecording}
              isRecording={recorder.isRecording}
              isTranscribing={isTranscribing}
              isSending={isSending}
              disabled={!activeUserId}
              composerNotice={composerNotice}
            />
          </section>
        </div>
      </div>

      {showPasswordChange && (
        <div className="modal-backdrop" role="presentation">
          <PasswordChangeScreen
            user={authUser}
            passwordPolicy={passwordPolicy}
            onChanged={handlePasswordChanged}
            onCancel={() => setShowPasswordChange(false)}
          />
        </div>
      )}

      {showSettings && (
        <SettingsModal currentUser={authUser} returnFocusRef={settingsButtonRef} onClose={closeSettings} />
      )}

      {showUserManagement && authUser.isAdmin && authUser.displayName.trim().toLowerCase() === 'eric' && (
        <AdminUserManagement currentUser={authUser} onClose={() => setShowUserManagement(false)} />
      )}
    </div>
  );
};
