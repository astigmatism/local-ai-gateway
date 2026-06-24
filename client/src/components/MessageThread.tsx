import { useEffect, useRef } from 'react';
import { useTextToSpeechPlayback } from '../hooks/useTextToSpeechPlayback.js';
import type { TextToSpeechMessageState } from '../hooks/useTextToSpeechPlayback.js';
import { sanitizeThinkingBlocks } from '../lib/thinkingBlocks.js';
import type { Conversation, GeneratedImageMessageMetadata, Message } from '../lib/types.js';
import { MarkdownMessageContent } from './MarkdownMessageContent.js';
import { MessageActions } from './MessageActions.js';

interface MessageThreadProps {
  conversation: Conversation | null;
  loading: boolean;
  onReusePrompt: (content: string) => void;
}

type DeliveryStatus = 'pending' | 'thinking' | 'streaming' | 'imageGenerating' | 'error';

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
  return status === 'pending' ||
    status === 'thinking' ||
    status === 'streaming' ||
    status === 'imageGenerating' ||
    status === 'error'
    ? status
    : null;
};

const isGeneratedImageMetadata = (value: unknown): value is GeneratedImageMessageMetadata => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.type !== 'image') return false;
  const image = record.image;
  if (!image || typeof image !== 'object' || Array.isArray(image)) return false;
  const imageRecord = image as Record<string, unknown>;
  return typeof imageRecord.url === 'string' && typeof imageRecord.prompt === 'string' && typeof imageRecord.model === 'string';
};

const generatedImageMetadata = (message: Message) => (isGeneratedImageMetadata(message.metadata) ? message.metadata : null);

const timestampLabel = (message: Message) => {
  const status = deliveryStatus(message);
  if (status === 'pending') return 'Sending...';
  if (status === 'thinking') return 'Starting...';
  if (status === 'streaming') return 'Streaming...';
  if (status === 'imageGenerating') return 'Generating image...';
  if (status === 'error') return 'Needs attention';
  return formatTime(message.createdAt);
};

const visibleMessageContent = (message: Message) =>
  message.role === 'assistant'
    ? sanitizeThinkingBlocks(message.content, { trim: true, extractUntaggedReasoning: true }).content
    : message.content;

const copyContent = (message: Message) => generatedImageMetadata(message)?.image.prompt ?? visibleMessageContent(message);

const canCopyMessage = (message: Message) => {
  const status = deliveryStatus(message);
  const imageMetadata = generatedImageMetadata(message);
  const textToCopy = imageMetadata?.image.prompt ?? visibleMessageContent(message);

  if (textToCopy.trim().length === 0) return false;
  if (status === 'thinking' || status === 'streaming' || status === 'imageGenerating') return false;
  if (message.role === 'assistant' && status === 'error') return false;

  return message.role === 'assistant' || message.role === 'user';
};

const canSpeakMessage = (message: Message) => canCopyMessage(message) && !generatedImageMetadata(message);

const canReusePrompt = (message: Message) =>
  message.role === 'user' &&
  message.content.trim().length > 0 &&
  !['thinking', 'streaming', 'imageGenerating'].includes(deliveryStatus(message) ?? '');

const imageDimensionsLabel = (image: GeneratedImageMessageMetadata['image']) => {
  if (image.width && image.height) return `${image.width}x${image.height}`;
  return null;
};

const promptStartStatuses: DeliveryStatus[] = ['thinking', 'streaming', 'imageGenerating'];

const isOptimisticMessage = (message: Message) => message.metadata?.optimistic === true;

const submittedAtMetadata = (message: Message) => {
  const submittedAt = message.metadata?.submittedAt;
  return typeof submittedAt === 'string' ? submittedAt : null;
};

const getPromptStartSnapKey = (messages: Message[]) => {
  const userMessage = messages.at(-2);
  const assistantMessage = messages.at(-1);

  if (!userMessage || !assistantMessage) return null;
  if (userMessage.role !== 'user' || assistantMessage.role !== 'assistant') return null;
  if (!isOptimisticMessage(userMessage) || !isOptimisticMessage(assistantMessage)) return null;

  const assistantStatus = deliveryStatus(assistantMessage);
  if (!assistantStatus || !promptStartStatuses.includes(assistantStatus)) return null;

  const userSubmittedAt = submittedAtMetadata(userMessage);
  const assistantSubmittedAt = submittedAtMetadata(assistantMessage);
  if (!userSubmittedAt || userSubmittedAt !== assistantSubmittedAt) return null;

  return userSubmittedAt;
};

const GeneratedImageContent = ({ metadata, fallbackContent }: { metadata: GeneratedImageMessageMetadata; fallbackContent: string }) => {
  const image = metadata.image;
  const altText = `Generated image for: ${image.prompt || fallbackContent}`;
  const dimensions = imageDimensionsLabel(image);

  return (
    <figure className="generated-image-message">
      <div className="generated-image-frame">
        <img src={image.url} alt={altText} loading="lazy" />
      </div>
      <figcaption className="generated-image-caption">
        <span className="generated-image-prompt">{image.prompt}</span>
        <span className="generated-image-details">
          {image.model}
          {dimensions ? ` - ${dimensions}` : ''}
        </span>
        <span className="generated-image-links">
          <a href={image.url} target="_blank" rel="noreferrer" aria-label="Open generated image">
            Open image
          </a>
          <a href={image.url} download aria-label="Download generated image">
            Download image
          </a>
        </span>
      </figcaption>
    </figure>
  );
};

const PendingImageContent = () => (
  <div className="message-content plain-message-content pending-message-content" aria-live="polite">
    <div className="typing-indicator" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
    <p>Generating image...</p>
  </div>
);

const metadataRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const messageMetadataRecord = (message: Message) => metadataRecord(message.metadata);

const messageThinkingContent = (message: Message) => {
  const value = messageMetadataRecord(message)?.thinkingContent;
  return typeof value === 'string' ? value.trim() : '';
};

const formatThinkingDuration = (durationMs: number) => {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
};

const messageThinkingMarker = (message: Message) => {
  const metadata = messageMetadataRecord(message);
  const thinking = metadataRecord(metadata?.thinking);
  const label = metadata?.thinkingLabel ?? thinking?.label;

  if (typeof label === 'string' && label.trim().length > 0) {
    return label.trim();
  }

  const durationMs = metadata?.thinkingDurationMs ?? thinking?.durationMs;
  if (typeof durationMs === 'number') {
    const duration = formatThinkingDuration(durationMs);
    if (duration) return `Thought for ${duration}`;
  }

  if (
    metadata?.thinkingContentDiscarded === true ||
    metadata?.thinkingContentSuppressed === true ||
    metadata?.hasThinkingField === true ||
    metadata?.hasRawThinkingTag === true ||
    metadata?.hasUntaggedReasoning === true ||
    thinking?.discarded === true ||
    thinking?.suppressed === true
  ) {
    return 'Thought';
  }

  return '';
};

const messageThinkingEnabled = (message: Message) => messageMetadataRecord(message)?.thinkingEnabled === true;

const ThinkingTrace = ({ message, status }: { message: Message; status: DeliveryStatus | null }) => {
  const content = messageThinkingContent(message);
  const marker = messageThinkingMarker(message);
  const isActive = status === 'thinking' || status === 'streaming';
  const shouldRenderLive = message.role === 'assistant' && isActive && (messageThinkingEnabled(message) || content.length > 0);
  const shouldRenderMarker = message.role === 'assistant' && !isActive && marker.length > 0;

  if (!shouldRenderLive && !shouldRenderMarker) return null;

  if (!isActive) {
    return (
      <div className="thinking-trace thinking-marker" aria-label={marker}>
        <span>{marker}</span>
        <small>Reasoning discarded after generation</small>
      </div>
    );
  }

  return (
    <details className="thinking-trace active" open>
      <summary>
        <span>{marker || 'Thinking...'}</span>
        <small>{content.length > 0 ? 'Reasoning is streaming separately' : 'Waiting for reasoning'}</small>
      </summary>
      {content.length > 0 ? (
        <div className="thinking-trace-content">{content}</div>
      ) : (
        <div className="thinking-trace-placeholder">The model has not emitted reasoning text yet.</div>
      )}
    </details>
  );
};

const MessageContent = ({ message }: { message: Message }) => {
  const status = deliveryStatus(message);
  const imageMetadata = generatedImageMetadata(message);
  const visibleContent = visibleMessageContent(message);

  if (status === 'imageGenerating') {
    return <PendingImageContent />;
  }

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
    if (visibleContent.trim().length === 0) {
      return (
        <div className="message-content plain-message-content pending-message-content" aria-live="polite">
          <div className="typing-indicator" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p>Starting response...</p>
        </div>
      );
    }

    return (
      <div className="message-content markdown-content streaming-message-content" aria-live="polite">
        <MarkdownMessageContent content={visibleContent} />
        <span className="streaming-cursor" aria-hidden="true" />
      </div>
    );
  }

  if (status === 'error') {
    return <div className="message-content plain-message-content error-message-content">{message.content}</div>;
  }

  if (imageMetadata) {
    return <GeneratedImageContent metadata={imageMetadata} fallbackContent={message.content} />;
  }

  if (message.role === 'assistant') {
    return (
      <div className="message-content markdown-content">
        <MarkdownMessageContent content={visibleContent} />
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
  const imageMetadata = generatedImageMetadata(message);
  const copiedContent = copyContent(message);
  const canSpeak = canSpeakMessage(message);
  const speechState = canSpeak ? getMessageSpeechState(message.id) : 'idle';

  return (
    <div className={`message-row ${message.role} ${status ? status : ''} ${imageMetadata ? 'image-message' : ''}`}>
      <div className="message-avatar" aria-hidden="true">
        {message.role === 'assistant' ? 'AI' : message.role === 'system' ? 'S' : 'You'}
      </div>
      <div className="message-stack">
        <ThinkingTrace message={message} status={status} />
        <div
          className="message-bubble"
          aria-live={status === 'thinking' || status === 'streaming' || status === 'imageGenerating' || status === 'error' ? 'polite' : undefined}
        >
          <div className="message-meta">
            <span>{roleLabel(message.role)}</span>
            <span>{timestampLabel(message)}</span>
          </div>
          <MessageContent message={message} />
          <MessageActions
            role={message.role}
            content={copiedContent}
            canCopy={canCopyMessage(message)}
            canSpeak={canSpeak}
            speechState={speechState}
            speechError={speechError?.messageId === message.id ? speechError.message : null}
            canReusePrompt={canReusePrompt(message)}
            copyLabel={imageMetadata ? 'Copy image prompt' : undefined}
            copiedLabel={imageMetadata ? 'Image prompt copied' : undefined}
            onSpeak={() => onSpeakMessage(message.id, visibleMessageContent(message))}
            onReusePrompt={onReusePrompt}
          />
        </div>
      </div>
    </div>
  );
};

export const MessageThread = ({ conversation, loading, onReusePrompt }: MessageThreadProps) => {
  const threadRef = useRef<HTMLElement | null>(null);
  const snappedPromptStartKeysRef = useRef<Set<string>>(new Set());
  const messageCount =
    conversation?.messages.filter((message) => !['thinking', 'streaming', 'imageGenerating'].includes(deliveryStatus(message) ?? '')).length ?? 0;
  const { speakMessage, getMessageSpeechState, speechError } = useTextToSpeechPlayback(conversation?.id ?? null);
  const promptStartSnapKey = getPromptStartSnapKey(conversation?.messages ?? []);

  useEffect(() => {
    if (!promptStartSnapKey) return;
    if (snappedPromptStartKeysRef.current.has(promptStartSnapKey)) return;

    const thread = threadRef.current;
    if (!thread) return;

    snappedPromptStartKeysRef.current.add(promptStartSnapKey);
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'auto' });
  }, [promptStartSnapKey]);

  if (loading && !conversation) {
    return (
      <main className="thread empty-state" ref={threadRef}>
        Loading conversation...
      </main>
    );
  }

  if (!conversation) {
    return (
      <main className="thread empty-state" ref={threadRef}>
        <div className="empty-state-card">
          <span className="empty-state-mark">BC</span>
          <h2>Start a new conversation</h2>
          <p>Use Bear Castle AI to talk with your local models.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="thread" ref={threadRef}>
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
    </main>
  );
};
