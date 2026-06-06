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
      a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />,
      pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={0} />,
      table: ({ node: _node, ...props }) => (
        <div className="markdown-table-scroll" role="region" aria-label="Scrollable table" tabIndex={0}>
          <table {...props} />
        </div>
      )
    }}
  >
    {content}
  </ReactMarkdown>
);
