import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, Sparkles, User, Wrench } from 'lucide-react';
import type { Json, JsonObject } from '../shared/contracts';
import { array, flag, messageText, object, text } from '../shared/validation';

export function JsonDetails({ value, title = 'JSON 详情' }: { value: Json; title?: string }) {
  return <details className="json-details"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
export function Markdown({ children }: { children: string }) {
  const [linkError, setLinkError] = useState('');
  return <><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children: label }) => <a href={href} onClick={event => { event.preventDefault(); if (href) { setLinkError(''); void window.desktop.openExternal(href).catch(reason => setLinkError(`无法打开链接：${reason instanceof Error ? reason.message : String(reason)}`)); } }}>{label}</a> }}>{children}</ReactMarkdown>{linkError && <p role="alert" className="inline-error">{linkError}</p>}</>;
}
function Message({ message }: { message: JsonObject }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const role = text(message.role);
  const tool = role === 'toolResult';
  const manualBash = role === 'bashExecution';
  const error = flag(message.isError) || text(message.stopReason) === 'error' || !!text(message.errorMessage) || (manualBash && typeof message.exitCode === 'number' && message.exitCode !== 0 && !flag(message.cancelled));
  const content = manualBash ? text(message.output) : messageText(message);
  return <article className={`message ${role} ${error ? 'message-error' : ''}`}>
    <header><span className="avatar">{tool || manualBash ? <Wrench size={15} /> : role === 'user' ? <User size={15} /> : <Sparkles size={15} />}</span><strong>{manualBash ? '手动命令' : tool ? text(message.toolName, '工具结果') : role === 'user' ? '你' : role === 'assistant' ? 'OMP' : role || '事件'}</strong>{error && <span className="badge error">失败</span>}{manualBash && flag(message.cancelled) && <span className="badge">已取消</span>}<button className="copy-message subtle" aria-label={manualBash ? '复制命令输出' : '复制消息'} onClick={() => { setCopyError(''); void navigator.clipboard.writeText(manualBash ? content : content || JSON.stringify(message, null, 2)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(reason => setCopyError(`复制失败：${reason instanceof Error ? reason.message : String(reason)}`)); }}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</button></header>
    {copyError && <p role="alert" className="inline-error">{copyError}</p>}
    {manualBash && <section className="bash-execution"><div className="bash-command"><span>命令</span><code>{text(message.command)}</code></div><pre aria-label="命令实际输出">{text(message.output) || '（无输出）'}</pre><div className="bash-status"><span className={error ? 'error-text' : 'muted'}>{flag(message.cancelled) ? '执行已取消' : typeof message.exitCode === 'number' ? message.exitCode === 0 ? '执行完成' : '命令失败' : '命令已返回'}{typeof message.exitCode === 'number' && ` · 退出码 ${message.exitCode}`}</span>{flag(message.truncated) && <span className="muted">输出已截断</span>}</div><JsonDetails value={message} title="命令执行详情" /></section>}
    <div className="message-body">{typeof message.content === 'string' && <Markdown>{message.content}</Markdown>}{array(message.content).map((value, index) => {
      const block = object(value);
      switch (text(block.type)) {
        case 'text': return <Markdown key={index}>{text(block.text)}</Markdown>;
        case 'thinking': return <details key={index} className="thinking"><summary>思考过程</summary><Markdown>{text(block.thinking)}</Markdown></details>;
        case 'image': return <img key={index} className="message-image" alt="消息附件" src={`data:${text(block.mimeType)};base64,${text(block.data)}`} />;
        case 'toolCall': return <div key={index} className="tool-card"><div><Wrench size={14} /><strong>{text(block.name)}</strong><span className="muted">工具调用</span></div><JsonDetails value={object(block.arguments)} title="查看参数" /></div>;
        default: return <JsonDetails key={index} value={value} title={text(block.type, '内容')} />;
      }
    })}{text(message.errorMessage) && <div role="alert" className="inline-error">{text(message.errorMessage)}</div>}{tool && <JsonDetails value={message.details ?? message} title="结果详情" />}{!message.content && !manualBash && <JsonDetails value={message} />}</div>
  </article>;
}
export default function Chat({ messages, busy, progress, error }: { messages: JsonObject[]; busy: boolean; progress: JsonObject[]; error?: string }) {
  const end = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current) end.current?.scrollIntoView({ block: 'end' }); }, [messages, progress, busy]);
  return <div className="chat-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120; }}><div className="chat-content">
    {error && <div className="inline-error" role="alert"><strong>最近的运行错误</strong><p>{error}</p></div>}
    {messages.length === 0 && <div className="welcome"><span className="welcome-icon"><Sparkles size={28} /></span><h1>从一个想法开始</h1><p>连接真实的 OMP 会话。在工作区内阅读文件、执行工具，和你的智能体一起完成工作。</p><div className="welcome-hints"><span>文件与图像附件</span><span>独立会话 · 并行任务</span><span>原生历史记录</span></div></div>}
    {messages.map((message, index) => <Message key={`${text(message.id, text(message.messageId, String(index)))}-${index}`} message={message} />)}
    {progress.map(item => <div className={`tool-progress ${flag(item.isError) ? 'message-error' : ''}`} key={text(item.toolCallId)}><Wrench size={15} /><strong>{text(item.toolName, '工具')}</strong><span>{text(item.phase, '运行中')}</span><JsonDetails value={item.partialResult ?? item.result ?? item} title="实时输出" /></div>)}
    {busy && <div className="working"><span className="busy-dot" /> OMP 正在工作</div>}<div ref={end} />
  </div></div>;
}
