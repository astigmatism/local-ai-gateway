import type { ConversationSummary } from '../lib/types.js';

interface SidebarProps {
  activeUserId: string | null;
  conversations: ConversationSummary[];
  activeConversationId: string | null;
  onCreateConversation: () => Promise<void>;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversation: ConversationSummary) => Promise<void>;
  deletingConversationId: string | null;
  loadingConversations: boolean;
}

const formatTimestamp = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));

const conversationPreview = (conversation: ConversationSummary) => {
  const latestMessage = conversation.messages?.[0];
  const image = latestMessage?.metadata?.image;
  if (image && typeof image === 'object' && !Array.isArray(image)) {
    const prompt = typeof image.prompt === 'string' ? image.prompt.trim() : '';
    return prompt ? `Generated image: ${prompt}` : 'Generated image';
  }
  const content = latestMessage?.content?.trim();
  return content || 'Empty conversation';
};

const TrashIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
    <path d="M9.25 3.5a2 2 0 0 1 2-2h1.5a2 2 0 0 1 2 2v.75h4a.75.75 0 0 1 0 1.5h-.82l-.76 13.15a3 3 0 0 1-3 2.85H9.83a3 3 0 0 1-3-2.85L6.07 5.75h-.82a.75.75 0 0 1 0-1.5h4V3.5Zm1.5.75h2.5V3.5a.5.5 0 0 0-.5-.5h-1.5a.5.5 0 0 0-.5.5v.75Zm-3.18 1.5.75 13.06a1.5 1.5 0 0 0 1.5 1.44h4.36a1.5 1.5 0 0 0 1.5-1.44l.75-13.06H7.57Zm2.68 2.75a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Zm3.5 0a.75.75 0 0 1 .75.75v7.5a.75.75 0 0 1-1.5 0v-7.5a.75.75 0 0 1 .75-.75Z" />
  </svg>
);

export const Sidebar = ({
  activeUserId,
  conversations,
  activeConversationId,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation,
  deletingConversationId,
  loadingConversations
}: SidebarProps) => (
  <aside className="sidebar" aria-label="Conversation history">
    <section className="sidebar-actions">
      <button
        className="primary-button full-width"
        type="button"
        onClick={() => void onCreateConversation()}
        disabled={!activeUserId}
        aria-label="Create new conversation"
      >
        <span aria-hidden="true">+</span>
        New conversation
      </button>
    </section>

    <section className="conversation-list" aria-label="Conversation history">
      <div className="sidebar-label">Conversation History</div>
      {loadingConversations && <div className="muted padded">Loading conversations...</div>}
      {!loadingConversations && conversations.length === 0 && <div className="muted padded">No conversations yet.</div>}
      {conversations.map((conversation) => {
        const selected = conversation.id === activeConversationId;
        const preview = conversationPreview(conversation);
        const deleting = deletingConversationId === conversation.id;
        return (
          <div key={conversation.id} className={`conversation-item ${selected ? 'selected' : ''}`}>
            <button
              className="conversation-select"
              type="button"
              onClick={() => onSelectConversation(conversation.id)}
              aria-current={selected ? 'page' : undefined}
            >
              <span className="conversation-title">{conversation.title}</span>
              <span className="conversation-meta">
                {formatTimestamp(conversation.updatedAt)}
                {conversation._count ? ` · ${conversation._count.messages} msg` : ''}
              </span>
              <span className="conversation-preview">{preview}</span>
            </button>
            <button
              className="conversation-delete"
              type="button"
              onClick={() => void onDeleteConversation(conversation)}
              disabled={deleting}
              aria-label={`Delete conversation ${conversation.title}`}
              title="Delete conversation"
            >
              <TrashIcon />
            </button>
          </div>
        );
      })}
    </section>
  </aside>
);
