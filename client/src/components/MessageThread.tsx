import { useEffect, useRef } from 'react';
import { useTextToSpeechPlayback } from '../hooks/useTextToSpeechPlayback.js';
import type { TextToSpeechMessageState } from '../hooks/useTextToSpeechPlayback.js';
import type { Conversation, Message } from '../lib/types.js';
import { MarkdownMessageContent } from './MarkdownMessageContent.js';
import { MessageActions } from './MessageActions.js';

interface MessageThreadProps {
  conversation: Conversation | null;
  loading: boolean;
  onReusePrompt: (content: string) => void;
}

type DeliveryStatus = 'pending' | 'thinking' | 'streaming' | 'error';

const formatTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(value));

const roleLabel = (role: Message['role']) => {
  if (role === 'assistant') return 'Bear Castle AI';
  if (role === 'system') return 'System';
  return 'You';
};

const deliveryStatus = (message: Message): DeliveryStatus | null => {
  const status = message.metadata?.deliveryStatus;
  return status === 'pending' || status === 'thinking' || status === 'streaming' || status === 'error' ? status : null;
};

const timestampLabel = (message: Message) => {
  const status = deliveryStatus(message);
  if (status === 'pending') return 'Sending...';
  if (status === 'thinking') return 'Starting...';
  if (status === 'streaming') return 'Streaming...';
  if (status === 'error') return 'Needs attention';
  return formatTime(message.createdAt);
};

const canCopyMessage = (message: Message) => {
  const status = deliveryStatus(message);

  if (message.content.trim().length === 0) return false;
  if (status === 'thinking' || status === 'streaming') return false;
  if (message.role === 'assistant' && status === 'error') return false;

  return message.role === 'assistant' || message.role === 'user';
};

const canSpeakMessage = (message: Message) => canCopyMessage(message);

const canReusePrompt = (message: Message) =>
  message.role === 'user' && message.content.trim().length > 0 && !['thinking', 'streaming'].includes(deliveryStatus(message) ?? '');

const MessageContent = ({ message }: { message: Message }) => {
  const status = deliveryStatus(message);

  if (status === 'thinking') {
    return (
      <div className="message-content plain-message-content pending-message-content" aria-live="polite">
        <div className="typing-indicator" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <p>{'Thinking\u2026'}</p>
      </div>
    );
  }

  if (status === 'streaming') {
    if (message.content.trim().length === 0) {
      return (
        <div className="message-content plain-message-content pending-message-content" aria-live="polite">
          <div className="typing-indicator" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>Starting response…</p>
        </div>
      );
    }

    return (
      <div className="message-content markdown-content streaming-message-content" aria-live="polite">
        <MarkdownMessageContent content={message.content} />
        <span className="streaming-cursor" aria-hidden="true" />
      </div>
    );
  }

  if (status === 'error') {
    return <div className="message-content plain-message-content error-message-content">{message.content}</div>;
  }

  if (message.role === 'assistant') {
    return (
      <div className="message-content markdown-content">
        <MarkdownMessageContent content={message.content} />
      </div>
    );
  }

  return <div className="message-content plain-message-content">{message.content}</div>;
};

const MessageBubble = ({
  message,
  onReusePrompt,
  onSpeakMessage,
  getMessageSpeechState,
  speechError
}: {
  message: Message;
  onReusePrompt: (content: string) => void;
  onSpeakMessage: (messageId: string, content: string) => void;
  getMessageSpeechState: (messageId: string) => TextToSpeechMessageState;
  speechError: { messageId: string; message: string } | null;
}) => {
  const status = deliveryStatus(message);
  const canSpeak = canSpeakMessage(message);
  const speechState = canSpeak ? getMessageSpeechState(message.id) : 'idle';

  return (
    <div className={`message-row ${message.role} ${status ? status : ''}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === 'assistant' ? 'AI' : message.role === 'system' ? 'S' : 'You'}
      </div>
      <div className="message-bubble" aria-live={status === 'thinking' || status === 'streaming' || status === 'error' ? 'polite' : undefined}>
        <div className="message-meta">
          <span>{roleLabel(message.role)}</span>
          <span>{timestampLabel(message)}</span>
        </div>
        <MessageContent message={message} />
        <MessageActions
          role={message.role}
          content={message.content}
          canCopy={canCopyMessage(message)}
          canSpeak={canSpeak}
          speechState={speechState}
          speechError={speechError?.messageId === message.id ? speechError.message : null}
          canReusePrompt={canReusePrompt(message)}
          onSpeak={() => onSpeakMessage(message.id, message.content)}
          onReusePrompt={onReusePrompt}
        />
      </div>
    </div>
  );
};

export const MessageThread = ({ conversation, loading, onReusePrompt }: MessageThreadProps) => {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastMessage = conversation?.messages.at(-1);
  const lastMessageId = lastMessage?.id;
  const lastMessageContentLength = lastMessage?.content.length ?? 0;
  const messageCount =
    conversation?.messages.filter((message) => !['thinking', 'streaming'].includes(deliveryStatus(message) ?? '')).length ?? 0;
  const { speakMessage, getMessageSpeechState, speechError } = useTextToSpeechPlayback(conversation?.id ?? null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [conversation?.id, conversation?.messages.length, lastMessageContentLength, lastMessageId]);

  if (loading && !conversation) {
    return <main className="thread empty-state">Loading conversation...</main>;
  }

  if (!conversation) {
    return (
      <main className="thread empty-state">
        <div className="empty-state-card">
          <span className="empty-state-mark">BC</span>
          <h2>Start a new conversation</h2>
          <p>Use Bear Castle AI to talk with your local models.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="thread">
      <div className="thread-title">
        <h2>{conversation.title}</h2>
        <p>{messageCount} messages</p>
      </div>

      {conversation.messages.length === 0 && (
        <div className="empty-conversation">
          <h3>Start a new conversation</h3>
          <p>Type a message or record voice. Transcripts are appended to the input for editing before sending.</p>
        </div>
      )}

      {conversation.messages.map((message) => (
        <MessageBubble
          key={message.id}
          message={message}
          onReusePrompt={onReusePrompt}
          onSpeakMessage={(messageId, content) => void speakMessage(messageId, content)}
          getMessageSpeechState={getMessageSpeechState}
          speechError={speechError}
        />
      ))}

      <div ref={bottomRef} />
    </main>
  );
};
