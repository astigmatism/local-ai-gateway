import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';
import type { AudioRecordingStatus } from '../hooks/useAudioRecorder.js';
import type { AuthUser, Conversation, ConversationSummary, GatewayStatus } from '../lib/types.js';
import { ChatInput } from './ChatInput.js';
import { MessageThread } from './MessageThread.js';
import { Sidebar } from './Sidebar.js';
import { StatusCards } from './StatusCards.js';
import { TopBar } from './TopBar.js';

interface MobileAppLayoutProps {
  activeUser: AuthUser;
  activeUserId: string | null;
  settingsButtonRef?: Ref<HTMLButtonElement>;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  activeConversation: Conversation | null;
  loadingConversations: boolean;
  loadingConversation: boolean;
  deletingConversationId: string | null;
  status: GatewayStatus | null;
  error: string | null;
  draft: string;
  composerNotice?: string | null;
  recordingStatus: AudioRecordingStatus;
  audioLevels: number[];
  isSending: boolean;
  enableThinking: boolean;
  setEnableThinking: (value: boolean) => void;
  composerRef: Ref<HTMLTextAreaElement>;
  setDraft: (value: string) => void;
  onCreateConversation: () => Promise<void>;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversation: ConversationSummary) => Promise<void>;
  onDismissError: () => void;
  onSend: () => Promise<void>;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  onReusePrompt: (content: string) => void;
  onOpenSettings: () => void;
  onChangePassword: () => void;
  onOpenUserManagement: () => void;
  onLogout: () => Promise<void>;
}

type MobilePanel = 'history' | 'health';

const HistoryIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M5 5.75A2.75 2.75 0 0 1 7.75 3h8.5A2.75 2.75 0 0 1 19 5.75v12.5A2.75 2.75 0 0 1 16.25 21h-8.5A2.75 2.75 0 0 1 5 18.25V5.75Zm2.75-1.25c-.69 0-1.25.56-1.25 1.25v12.5c0 .69.56 1.25 1.25 1.25h8.5c.69 0 1.25-.56 1.25-1.25V5.75c0-.69-.56-1.25-1.25-1.25h-8.5Zm1.5 3.75A.75.75 0 0 1 10 7.5h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1-.75-.75Zm0 3.75a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5h-4A.75.75 0 0 1 9.25 12Zm0 3.75A.75.75 0 0 1 10 15h2.5a.75.75 0 0 1 0 1.5H10a.75.75 0 0 1-.75-.75Z" />
  </svg>
);

const HealthIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M11.25 3.75a.75.75 0 0 1 1.4-.37l2.55 4.78 1.03-1.72A.75.75 0 0 1 16.87 6h3.38a.75.75 0 0 1 0 1.5h-2.96l-1.52 2.54a.75.75 0 0 1-1.3-.02l-1.72-3.23v12.46a.75.75 0 0 1-1.4.37L8.8 14.84l-1.03 1.72a.75.75 0 0 1-.64.44H3.75a.75.75 0 0 1 0-1.5h2.96l1.52-2.54a.75.75 0 0 1 1.3.02l1.72 3.23V3.75Z" />
  </svg>
);

const CloseIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M6.47 5.47a.75.75 0 0 1 1.06 0L12 9.94l4.47-4.47a.75.75 0 1 1 1.06 1.06L13.06 11l4.47 4.47a.75.75 0 1 1-1.06 1.06L12 12.06l-4.47 4.47a.75.75 0 0 1-1.06-1.06L10.94 11 6.47 6.53a.75.75 0 0 1 0-1.06Z" />
  </svg>
);

export const MobileAppLayout = ({
  activeUser,
  activeUserId,
  settingsButtonRef,
  conversations,
  activeConversationId,
  activeConversation,
  loadingConversations,
  loadingConversation,
  deletingConversationId,
  status,
  error,
  draft,
  composerNotice,
  recordingStatus,
  audioLevels,
  isSending,
  enableThinking,
  setEnableThinking,
  composerRef,
  setDraft,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
  onDismissError,
  onSend,
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  onReusePrompt,
  onOpenSettings,
  onChangePassword,
  onOpenUserManagement,
  onLogout
}: MobileAppLayoutProps) => {
  const [openPanel, setOpenPanel] = useState<MobilePanel | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement | null>(null);
  const healthButtonRef = useRef<HTMLButtonElement | null>(null);
  const historyCloseRef = useRef<HTMLButtonElement | null>(null);
  const healthCloseRef = useRef<HTMLButtonElement | null>(null);
  const activePanelRef = useRef<HTMLElement | null>(null);
  const activeConversationTitle = useMemo(
    () => activeConversation?.title.trim() || 'New conversation',
    [activeConversation?.title]
  );

  const closePanel = useCallback(() => {
    const panelToClose = openPanel;
    setOpenPanel(null);

    window.requestAnimationFrame(() => {
      if (panelToClose === 'history') historyButtonRef.current?.focus();
      if (panelToClose === 'health') healthButtonRef.current?.focus();
    });
  }, [openPanel]);

  useEffect(() => {
    if (!openPanel) return undefined;

    document.body.classList.add('mobile-panel-open');
    const focusTimer = window.setTimeout(() => {
      if (openPanel === 'history') historyCloseRef.current?.focus();
      if (openPanel === 'health') healthCloseRef.current?.focus();
    }, 0);

    const closeOrTrapFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePanel();
        return;
      }

      if (event.key !== 'Tab' || !activePanelRef.current) return;

      const focusable = Array.from(
        activePanelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.offsetParent !== null || element === document.activeElement);

      const first = focusable.at(0);
      const last = focusable.at(-1);

      if (!first || !last) {
        event.preventDefault();
        return;
      }

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', closeOrTrapFocus);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.classList.remove('mobile-panel-open');
      document.removeEventListener('keydown', closeOrTrapFocus);
    };
  }, [closePanel, openPanel]);

  const handleCreateConversation = async () => {
    try {
      await onCreateConversation();
      closePanel();
    } catch {
      // Keep the drawer open so the user can retry if creation fails.
    }
  };

  const handleSelectConversation = (conversationId: string) => {
    onSelectConversation(conversationId);
    closePanel();
  };

  return (
    <div className="mobile-app-shell">
      <div className="mobile-top-area">
        <TopBar
          activeUser={activeUser}
          settingsButtonRef={settingsButtonRef}
          onOpenSettings={onOpenSettings}
          onChangePassword={onChangePassword}
          onOpenUserManagement={onOpenUserManagement}
          onLogout={onLogout}
        />

        <nav className="mobile-toolbar" aria-label="Mobile panels">
          <button
            ref={historyButtonRef}
            className="mobile-toolbar-button"
            type="button"
            onClick={() => setOpenPanel('history')}
            aria-label="Open conversation history"
            aria-haspopup="dialog"
            aria-expanded={openPanel === 'history'}
          >
            <HistoryIcon />
            <span>Conversations</span>
          </button>

          <div className="mobile-active-conversation" aria-label="Active conversation" aria-live="polite">
            <span>{activeConversationTitle}</span>
          </div>

          <button
            ref={healthButtonRef}
            className="mobile-toolbar-button"
            type="button"
            onClick={() => setOpenPanel('health')}
            aria-label="Open system health"
            aria-haspopup="dialog"
            aria-expanded={openPanel === 'health'}
          >
            <HealthIcon />
            <span>Health</span>
          </button>
        </nav>
      </div>

      <main className="mobile-chat-layout" aria-label="Bear Castle AI chat">
        <section className="mobile-chat-panel" aria-label="Main conversation">
          {error && (
            <div className="error-banner mobile-error-banner" role="alert">
              <span>{error}</span>
              <button type="button" onClick={onDismissError} aria-label="Dismiss error">
                Dismiss
              </button>
            </div>
          )}

          <MessageThread conversation={activeConversation} loading={loadingConversation && !activeConversation} onReusePrompt={onReusePrompt} />
        </section>

        <section className="mobile-composer-pane" aria-label="Message composer">
          <ChatInput
            ref={composerRef}
            variant="mobile"
            draft={draft}
            setDraft={setDraft}
            onSend={onSend}
            onStartRecording={onStartRecording}
            onStopRecording={onStopRecording}
            onCancelRecording={onCancelRecording}
            recordingStatus={recordingStatus}
            audioLevels={audioLevels}
            isSending={isSending}
            disabled={!activeUserId}
            enableThinking={enableThinking}
            setEnableThinking={setEnableThinking}
            composerNotice={composerNotice}
          />
        </section>
      </main>

      {openPanel && <button className="mobile-overlay-backdrop" type="button" aria-label="Close mobile panel" onClick={closePanel} />}

      {openPanel === 'history' && (
        <aside
          ref={activePanelRef}
          className="mobile-panel mobile-history-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-history-title"
        >
          <header className="mobile-panel-header">
            <div>
              <span className="eyebrow">Bear Castle AI</span>
              <h2 id="mobile-history-title">Conversation History</h2>
            </div>
            <button ref={historyCloseRef} className="mobile-panel-close" type="button" onClick={closePanel} aria-label="Close conversation history">
              <CloseIcon />
            </button>
          </header>
          <div className="mobile-panel-body mobile-history-body">
            <Sidebar
              activeUserId={activeUserId}
              conversations={conversations}
              activeConversationId={activeConversationId}
              onCreateConversation={handleCreateConversation}
              onSelectConversation={handleSelectConversation}
              onDeleteConversation={onDeleteConversation}
              deletingConversationId={deletingConversationId}
              loadingConversations={loadingConversations}
            />
          </div>
        </aside>
      )}

      {openPanel === 'health' && (
        <aside
          ref={activePanelRef}
          className="mobile-panel mobile-health-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-health-title"
        >
          <header className="mobile-panel-header">
            <div>
              <span className="eyebrow">Telemetry</span>
              <h2 id="mobile-health-title">System Health</h2>
            </div>
            <button ref={healthCloseRef} className="mobile-panel-close" type="button" onClick={closePanel} aria-label="Close system health">
              <CloseIcon />
            </button>
          </header>
          <div className="mobile-panel-body mobile-health-body">
            <StatusCards status={status} collapsed={false} onToggleCollapsed={closePanel} />
          </div>
        </aside>
      )}
    </div>
  );
};
