import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownMessageContentProps {
  content: string;
}

export const MarkdownMessageContent = ({ content }: MarkdownMessageContentProps) => (
  <ReactMarkdown
    skipHtml
    remarkPlugins={[remarkGfm]}
    components={{
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />
    }}
  >
    {content}
  </ReactMarkdown>
);
