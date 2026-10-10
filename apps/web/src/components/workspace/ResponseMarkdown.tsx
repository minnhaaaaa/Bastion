import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Agent output is untrusted: no raw HTML, scripts, or automatically loaded remote images. */
export function ResponseMarkdown({ content }: { content: string }) {
  return <Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ alt }) => <span className="chat-image-reference">{alt ? `Image: ${alt}` : "Image omitted"}</span>,
    table: ({ children }) => <div className="chat-table"><table>{children}</table></div>,
  }}>{content}</Markdown>;
}
