import { useEffect, useState } from 'react';
import { ExternalLink, X } from 'lucide-react';
import type { JsonObject } from '../shared/contracts';
import { array, flag, number, object, text } from '../shared/validation';
import { JsonDetails } from './Chat';

export interface UiRequest { ownerId: string; scope: 'conversation' | 'settings'; frame: JsonObject; receivedAt: number }
export default function Dialogs({ request, onDone, onError }: { request: UiRequest; onDone: () => void; onError: (message: string) => void }) {
  const { ownerId, frame, receivedAt } = request;
  const method = text(frame.method);
  const [value, setValue] = useState(text(frame.prefill));
  const [answers, setAnswers] = useState<Record<string, { selectedOptions: string[]; customInput: string }>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [remaining, setRemaining] = useState<number | null>(null);
  const timeout = number(frame.timeout);
  const secret = flag(frame.secret);
  async function reply(payload: JsonObject) {
    if (method === 'open_url') { onDone(); return; }
    if (pending) return;
    setPending(true);
    try { await window.desktop.reply(ownerId, { type: 'extension_ui_response', id: text(frame.id), ...payload }); onDone(); }
    catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setError(message); onError(message); }
    finally { setPending(false); }
  }
  useEffect(() => {
    if (!timeout || method === 'open_url') return;
    const tick = () => { const left = Math.max(0, receivedAt + timeout - Date.now()); setRemaining(Math.ceil(left / 1000)); if (left === 0) { clearInterval(timer); void reply({ cancelled: true, timedOut: true }); } };
    const timer = setInterval(tick, 250); tick();
    return () => clearInterval(timer);
  }, [timeout, receivedAt]);
  useEffect(() => { const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); void reply({ cancelled: true }); } }; document.addEventListener('keydown', cancel, true); return () => document.removeEventListener('keydown', cancel, true); }, [pending]);
  function updateAnswer(id: string, label: string, multi: boolean) {
    setAnswers(current => { const old = current[id] ?? { selectedOptions: [], customInput: '' }; return { ...current, [id]: { ...old, selectedOptions: multi ? old.selectedOptions.includes(label) ? old.selectedOptions.filter(item => item !== label) : [...old.selectedOptions, label] : [label], customInput: multi ? old.customInput : '' } }; });
  }
  return <div className="modal-backdrop"><section className="modal dialog-modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><div><span className="eyebrow">{request.scope === 'settings' ? '设置授权' : `会话 ${ownerId.slice(0, 8)}`} · {method === 'open_url' ? '浏览器授权' : '需要输入'}</span><h2 id="dialog-title">{text(frame.title, method === 'ask' ? '请回答智能体的问题' : method === 'open_url' ? '浏览器授权' : 'OMP 请求')}</h2></div><button aria-label={method === 'open_url' ? '关闭授权提示' : '取消请求'} disabled={pending} onClick={() => void reply({ cancelled: true })}><X size={18} /></button></header>
    {remaining !== null && <p className="muted">将在 {remaining} 秒后{method === 'ask' ? '采用推荐选项（未推荐时采用第一项）' : '超时取消'}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {secret ? <p className="inline-error">此对话框不能接收密钥。请在设置中的凭据管理或 OMP 终端安全配置；密钥不会发送到聊天。</p> : <>
      {method === 'confirm' && <p className="preserve-lines">{text(frame.message)}</p>}
      {method === 'select' && <div className="select-options">{array(frame.options).map((option, index) => <button key={index} disabled={pending} onClick={() => void reply({ value: text(option) })}><strong>{text(option)}</strong><small>{text(object(array(frame.optionDetails)[index]).description)}</small></button>)}</div>}
      {(method === 'input' || method === 'editor') && <label className="field">{text(frame.title, '内容')}{method === 'editor' ? <textarea autoFocus rows={12} value={value} onChange={event => setValue(event.target.value)} /> : <input autoFocus placeholder={text(frame.placeholder)} value={value} onChange={event => setValue(event.target.value)} />}</label>}
      {method === 'ask' && array(frame.questions).map(item => { const question = object(item); const id = text(question.id); const answer = answers[id] ?? { selectedOptions: [], customInput: '' }; return <fieldset key={id}><legend>{text(question.header)} {text(question.question)}</legend>{array(question.options).map((option, index) => { const detail = object(option); const label = text(detail.label); return <label className="ask-option" key={label}><input type={flag(question.multi) ? 'checkbox' : 'radio'} name={id} checked={answer.selectedOptions.includes(label)} onChange={() => updateAnswer(id, label, flag(question.multi))} /><span><strong>{label}{number(question.recommended, -1) === index && <small> · 推荐</small>}</strong><small>{text(detail.description)}</small>{text(detail.preview) && <pre>{text(detail.preview)}</pre>}</span></label>; })}<label className="field">其他 / 补充<input value={answer.customInput} onChange={event => setAnswers(current => ({ ...current, [id]: { ...answer, selectedOptions: flag(question.multi) ? answer.selectedOptions : [], customInput: event.target.value } }))} /></label></fieldset>; })}
      {method === 'open_url' && <><p>{text(frame.instructions, '在浏览器完成授权，然后返回工作台。关闭此提示不会取消登录。')}</p><button className="primary" onClick={() => { void window.desktop.openExternal(text(frame.launchUrl, text(frame.url))).then(onDone).catch(reason => { const message = reason instanceof Error ? reason.message : String(reason); setError(message); onError(message); }); }}><ExternalLink size={16} />打开授权网页</button><button onClick={() => { void navigator.clipboard.writeText(text(frame.launchUrl, text(frame.url))).catch(reason => { const message = reason instanceof Error ? reason.message : String(reason); setError(message); onError(message); }); }}>复制授权链接</button><p className="muted">此提示仅用于打开网页，登录流程可能继续请求输入。</p></>}
      {!['select', 'confirm', 'input', 'editor', 'ask', 'open_url'].includes(method) && <JsonDetails value={frame} title="未支持的输入请求" />}
    </>}
    <footer><button disabled={pending} onClick={() => void reply({ cancelled: true })}>{method === 'open_url' ? '关闭提示（登录继续）' : '取消'}</button>{!secret && method === 'confirm' && <><button disabled={pending} onClick={() => void reply({ confirmed: false })}>否</button><button className="primary" disabled={pending} onClick={() => void reply({ confirmed: true })}>确认</button></>}{!secret && ['input', 'editor'].includes(method) && <button className="primary" disabled={pending} onClick={() => void reply({ value })}>提交</button>}{!secret && method === 'ask' && <button className="primary" disabled={pending} onClick={() => void reply({ answers: array(frame.questions).map(item => { const id = text(object(item).id); const answer = answers[id] ?? { selectedOptions: [], customInput: '' }; return { id, selectedOptions: answer.selectedOptions, ...(answer.customInput ? { customInput: answer.customInput } : {}) }; }) })}>提交答案</button>}{method === 'open_url' && <button onClick={onDone}>已打开，返回工作台</button>}</footer>
  </section></div>;
}
