import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, File, Folder, ListTodo, RefreshCw, Square, Terminal, Users, Wrench, X } from 'lucide-react';
import { z } from 'zod';
import type { Attachment, FileEntry, FilePreview, Json, JsonObject, OwnerSnapshot, RpcCommand } from '../shared/contracts';
import { array, flag, jsonSchema, messageText, number, object, text } from '../shared/validation';
import { JsonDetails, Markdown } from './Chat';

export type PanelName = 'files' | 'tasks' | 'agents' | 'tools';
export interface PanelProps { owner?: OwnerSnapshot; workspace: string; panel: PanelName; events: JsonObject[]; onAttach: (attachment: Attachment) => void; onReference: (path: string) => void; onClose: () => void; onError: (message: string) => void }
const todoSchema = z.array(z.object({ name: z.string(), tasks: z.array(z.object({ content: z.string(), status: z.enum(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']), blocker: z.string().optional(), details: z.string().optional(), notes: z.array(z.string()).optional() })) }));
function RuntimeControls({ owner, events, rpc, onError }: { owner: OwnerSnapshot; events: JsonObject[]; rpc: (command: RpcCommand) => Promise<Json>; onError: (message: string) => void }) {
  const [pendingCount, setPendingCount] = useState(0);
  const pending = pendingCount > 0;
  const [objective, setObjective] = useState('');
  const [budget, setBudget] = useState('100000');
  const [goal, setGoal] = useState<Json>(owner.state.goal ?? null);
  const [liveStarted, setLiveStarted] = useState(false);
  const [muted, setMuted] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeState, setRuntimeState] = useState(owner.state);
  useEffect(() => { setRuntimeState(owner.state); setGoal(owner.state.goal ?? null); }, [owner.state]);
  const latestLive = [...events].reverse().find(frame => frame.type === 'live_phase' || frame.type === 'live_end');
  const live = latestLive?.type === 'live_end' ? false : latestLive?.type === 'live_phase' ? true : liveStarted;
  const transcripts: Record<string, JsonObject> = {};
  for (const frame of events) if (frame.type === 'live_transcript') transcripts[`${text(frame.role)}:${number(frame.turn)}`] = frame;
  async function invoke(command: RpcCommand) {
    setPendingCount(count => count + 1); setRuntimeError('');
    try {
      const data = await rpc(command);
      if (command.type === 'goal') setGoal(data);
      if (command.type === 'live_start') setLiveStarted(true);
      if (command.type === 'live_stop') setLiveStarted(false);
      if (command.type === 'live_mute') setMuted(command.muted === true);
      setRuntimeState(object(await rpc({ type: 'get_state' })));
    } catch (reason) { const message = reason instanceof Error ? reason.message : String(reason); setRuntimeError(message); onError(message); }
    finally { setPendingCount(count => Math.max(0, count - 1)); }
  }
  return <section className="panel-body runtime-controls">
    <h3>模型运行方式</h3>
    <div className="runtime-buttons"><button disabled={pending || owner.status !== 'ready'} aria-pressed={flag(runtimeState.fastModeEnabled)} onClick={() => void invoke({ type: 'set_fast_mode', enabled: !flag(runtimeState.fastModeEnabled) })}>快速模式 · {flag(runtimeState.fastModeEnabled) ? flag(runtimeState.fastModeActive) ? '已启用' : '待生效' : '关'}</button>{flag(runtimeState.slowModeSupported) && <button disabled={pending} aria-pressed={flag(runtimeState.slowModeEnabled)} onClick={() => void invoke({ type: 'set_slow_mode', enabled: !flag(runtimeState.slowModeEnabled) })}>低优先级 · {flag(runtimeState.slowModeEnabled) ? '开' : '关'}</button>}</div>
    {runtimeError && <p role="alert" className="inline-error">{runtimeError}</p>}
    <h3>目标模式</h3>
    {goal !== null && <JsonDetails value={goal} title="当前持久目标" />}
    <form onSubmit={event => { event.preventDefault(); const tokens = Number(budget); if (!objective.trim() || !Number.isSafeInteger(tokens) || tokens <= 0) { setRuntimeError('请填写目标和正整数 token 预算'); return; } void invoke({ type: 'goal', op: 'create', objective: objective.trim(), token_budget: tokens }); }}>
      <label className="field">目标<textarea rows={3} value={objective} onChange={event => setObjective(event.target.value)} placeholder="需要自主完成的具体目标" /></label>
      <label className="field">Token 预算<input type="number" min="1" step="1" value={budget} onChange={event => setBudget(event.target.value)} /></label>
      <button type="submit" disabled={pending || !objective.trim() || owner.status !== 'ready'}>创建目标</button>
    </form>
    <div className="runtime-buttons"><button disabled={pending || owner.status !== 'ready'} onClick={() => void invoke({ type: 'goal', op: 'get' })}>读取目标</button><button disabled={pending || goal === null} onClick={() => void invoke({ type: 'goal', op: 'pause' })}>暂停</button><button disabled={pending || goal === null} onClick={() => void invoke({ type: 'goal', op: 'resume' })}>继续</button><button disabled={pending || goal === null} className="danger" onClick={() => void invoke({ type: 'goal', op: 'drop' })}>移除</button></div>
    <h3>实时语音</h3>
    <p className="muted">由 OMP 原生语音运行时连接模型和音频设备。需要受支持的提供商与本机设备；不可用时显示真实错误。</p>
    <div className="runtime-buttons"><button disabled={(pending && !live) || owner.status !== 'ready'} onClick={() => void invoke({ type: live ? 'live_stop' : 'live_start' })}>{live ? '停止语音' : '开始语音'}</button>{live && <button disabled={pending} aria-pressed={muted} onClick={() => void invoke({ type: 'live_mute', muted: !muted })}>{muted ? '取消静音' : '静音麦克风'}</button>}</div>
    {latestLive && <p className={latestLive.error ? 'error-text' : 'muted'}>{latestLive.type === 'live_end' ? text(latestLive.error, '语音已结束') : text(latestLive.phase)}</p>}
    {Object.entries(transcripts).map(([key, frame]) => <p className="live-transcript" key={key}><strong>{frame.role === 'user' ? '你' : 'OMP'}：</strong>{text(frame.text)}{!flag(frame.final) && <small> · 转写中</small>}</p>)}
  </section>;
}

export default function Panels({ owner, workspace, panel, events, onAttach, onReference, onClose, onError }: PanelProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [path, setPath] = useState(workspace);
  const [parents, setParents] = useState<string[]>([]);
  const [preview, setPreview] = useState<FilePreview>();
  const [loading, setLoading] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [agents, setAgents] = useState<JsonObject[]>([]);
  const retainedAgents = useRef<JsonObject[]>([]);
  retainedAgents.current = array(owner?.state.subagents).map(object);
  const [agentId, setAgentId] = useState('');
  const [agentMessages, setAgentMessages] = useState<JsonObject[]>([]);
  const agentCursor = useRef(0);
  const selectedAgent = useRef('');
  const agentGeneration = useRef(0);
  const agentLoads = useRef(new Set<string>());
  const [steer, setSteer] = useState('');
  const [todoDraft, setTodoDraft] = useState('');
  const [todoEditing, setTodoEditing] = useState(false);
  const [command, setCommand] = useState('');
  const [bashRunning, setBashRunning] = useState(false);
  const [bashResult, setBashResult] = useState<Json>();
  const selectedAgentRecord = agents.find(agent => agent.id === agentId);
  const report = (reason: unknown) => { const message = reason instanceof Error ? reason.message : String(reason); setPanelError(message); onError(message); };
  const rpc = async (command: RpcCommand): Promise<Json> => { if (!owner) throw new Error('请先打开会话'); return jsonSchema.parse(await window.desktop.request(owner.id, command)); };
  async function loadFiles(target = path) { setLoading(true); setPanelError(''); try { setFiles(await window.desktop.listFiles(workspace, target)); setPath(target); } catch (reason) { report(reason); } finally { setLoading(false); } }
  async function loadAgents() {
    try {
      const received = array(object(await rpc({ type: 'get_subagents' })).subagents).map(object);
      setAgents(current => {
        const merged = new Map<string, JsonObject>();
        for (const agent of [...current, ...retainedAgents.current, ...received]) if (text(agent.id)) merged.set(text(agent.id), { ...(merged.get(text(agent.id)) ?? {}), ...agent });
        return [...merged.values()];
      });
    } catch (reason) { report(reason); }
  }
  async function loadAgentMessages(id = agentId, reset = false) {
    if (!id) return;
    const generation = agentGeneration.current;
    const loadKey = `${id}:${generation}`;
    if (agentLoads.current.has(loadKey)) return;
    agentLoads.current.add(loadKey);
    try {
      const agent = [...retainedAgents.current, ...agents].find(item => item.id === id);
      const sessionFile = text(agent?.sessionFile);
      let fromByte = reset ? 0 : agentCursor.current;
      let replace = reset;
      while (true) {
        const data = object(await rpc({ type: 'get_subagent_messages', subagentId: id, ...(sessionFile ? { sessionFile } : {}), fromByte }));
        if (selectedAgent.current !== id || generation !== agentGeneration.current) return;
        const nextByte = number(data.nextByte, fromByte);
        agentCursor.current = nextByte;
        const messages = array(data.messages).map(object);
        const resetPage = replace || flag(data.reset);
        setAgentMessages(current => resetPage ? messages : [...current, ...messages]);
        replace = false;
        if (!flag(data.hasMore) || !array(data.entries).length || (nextByte <= fromByte && !flag(data.reset))) break;
        fromByte = nextByte;
      }
    } catch (reason) { if (generation === agentGeneration.current) report(reason); }
    finally { agentLoads.current.delete(loadKey); }
  }
  useEffect(() => { setPath(workspace); setParents([]); setPreview(undefined); if (workspace) void loadFiles(workspace); }, [workspace]);
  useEffect(() => { selectedAgent.current = ''; agentGeneration.current += 1; setAgentId(''); setAgents([]); setAgentMessages([]); setBashResult(undefined); setTodoEditing(false); }, [owner?.id]);
  useEffect(() => {
    const retained = array(owner?.state.subagents).map(object);
    if (!retained.length) return;
    setAgents(current => {
      const merged = new Map<string, JsonObject>();
      for (const agent of [...current, ...retained]) if (text(agent.id)) merged.set(text(agent.id), { ...(merged.get(text(agent.id)) ?? {}), ...agent });
      return [...merged.values()];
    });
  }, [owner?.state.subagents]);
  useEffect(() => { if (panel === 'agents' && owner?.status === 'ready') void loadAgents(); }, [panel, owner?.id, events]);
  useEffect(() => { if (panel === 'agents' && agentId) void loadAgentMessages(); }, [events, panel, agentId, selectedAgentRecord?.status, selectedAgentRecord?.lastUpdate, selectedAgentRecord?.live]);
  const phases = array(owner?.state.todoPhases).map(object);
  const toolErrors = owner?.messages.filter(message => message.role === 'toolResult' && flag(message.isError)) ?? [];
  const selectedAgentCanControl = flag(selectedAgentRecord?.canControl);
  const title = { files: '文件', tasks: '任务', agents: '智能体', tools: '工具与命令' }[panel];
  return <aside className="inspector"><header className="inspector-header"><strong>{title}</strong><button aria-label="关闭侧栏" onClick={onClose}><X size={16} /></button></header>{panelError && <div className="inline-error" role="alert">{panelError}</div>}
    {panel === 'tools' && owner && <RuntimeControls key={owner.id} owner={owner} events={events} rpc={rpc} onError={onError} />}
    {panel === 'files' && <><div className="panel-toolbar"><button disabled={!parents.length} onClick={() => { const target = parents[parents.length - 1]; setParents(current => current.slice(0, -1)); void loadFiles(target); }}><ChevronLeft size={14} />上级</button><button disabled={loading} onClick={() => void loadFiles()}><RefreshCw size={14} />刷新</button></div><div className="file-path" title={path}>{path || '请先选择工作区'}</div><div className="file-list">{loading && <p className="muted">读取文件…</p>}{!loading && !files.length && <p className="empty-small">文件夹为空</p>}{files.map(entry => <button className="file-row" key={entry.path} onClick={() => { if (entry.directory) { setParents(current => [...current, path]); setPreview(undefined); void loadFiles(entry.path); } else { void window.desktop.previewFile(workspace, entry.path).then(setPreview).catch(report); } }}>{entry.directory ? <Folder size={16} /> : <File size={16} />}<span>{entry.name}</span>{!entry.directory && <small>{entry.size > 1024 ? `${Math.round(entry.size / 1024)} KB` : `${entry.size} B`}</small>}</button>)}</div>{preview && <section className="file-preview"><h3>{preview.path.split(/[\\/]/).pop()}</h3>{preview.kind === 'text' ? <pre>{preview.content}</pre> : preview.kind === 'image' ? <img alt="文件预览" src={preview.content} /> : <p className="muted">二进制文件无法预览</p>}{preview.truncated && <p className="muted">仅显示文件开头</p>}<>{preview.kind === 'image' ? <button onClick={() => { void window.desktop.attachmentFromPath(workspace, preview.path).then(onAttach).catch(report); }}>添加图像附件</button> : <button onClick={() => onReference(preview.path)}>引用文件</button>}</></section>}</>}
    {panel === 'tasks' && <div className="panel-body"><div className="panel-toolbar"><span><ListTodo size={16} />会话待办</span><button disabled={!owner} onClick={() => { setTodoDraft(JSON.stringify(phases, null, 2)); setTodoEditing(true); }}>编辑</button></div>{todoEditing ? <form onSubmit={event => { event.preventDefault(); void (async () => { try { const parsed: unknown = JSON.parse(todoDraft); const validated = todoSchema.parse(parsed); await rpc({ type: 'set_todos', phases: validated }); setTodoEditing(false); } catch (reason) { report(reason); } })(); }}><label className="field">任务阶段 JSON<textarea rows={18} value={todoDraft} onChange={event => setTodoDraft(event.target.value)} /></label><p className="muted">格式：阶段 name 与 tasks；任务 content 与 status（pending / in_progress / completed / abandoned / blocked）。</p><button type="submit" className="primary">保存任务</button><button type="button" onClick={() => setTodoEditing(false)}>取消</button></form> : phases.length ? phases.map((phase, index) => <section className="todo-phase" key={index}><h3>{text(phase.name)}</h3>{array(phase.tasks).map((item, taskIndex) => { const task = object(item); return <div className={`todo-item ${text(task.status)}`} key={taskIndex}><span className="todo-status">{text(task.status) === 'completed' ? '✓' : text(task.status) === 'in_progress' ? '◉' : text(task.status) === 'blocked' ? '!' : '○'}</span><div>{text(task.content)}<small>{text(task.blocker, text(task.details))}</small></div></div>; })}</section>) : <p className="empty-small">此会话还没有待办。点击编辑可创建真实任务阶段。</p>}{toolErrors.length > 0 && <section><h3 className="error-text">工具 / 任务失败</h3>{toolErrors.map((message, index) => <div className="error-card" key={index}><strong>{text(message.toolName)}</strong><p>{messageText(message)}</p><JsonDetails value={message.details ?? message} /></div>)}</section>}</div>}
    {panel === 'agents' && <div className="panel-body"><div className="panel-toolbar"><span><Users size={16} />并行智能体</span><button disabled={!owner} onClick={() => void loadAgents()}><RefreshCw size={14} />刷新</button></div>{!agents.length && <p className="empty-small">还没有子智能体。主智能体运行任务后将在这里显示。</p>}{agents.map(agent => <button className={`agent-row ${agentId === text(agent.id) ? 'selected' : ''}`} key={text(agent.id)} onClick={() => { const id = text(agent.id); selectedAgent.current = id; agentGeneration.current += 1; setAgentId(id); setAgentMessages([]); agentCursor.current = 0; void loadAgentMessages(id, true); }}><strong>{text(agent.agent, text(agent.id))}</strong><span className="badge">{text(agent.status)} · {flag(agent.live) ? '实时' : '存档'}</span><small>{text(agent.description, text(agent.task))}</small></button>)}{agentId && <section className="agent-detail"><div className="panel-toolbar"><button onClick={() => void loadAgentMessages()}>更新记录</button><button className="danger" disabled={!selectedAgentCanControl} onClick={() => { void rpc({ type: 'cancel_subagent', subagentId: agentId }).then(data => { if (!flag(object(data).cancelled)) throw new Error('子智能体未被取消，可能已经完成'); }).catch(report); }}><Square size={12} />取消任务</button></div><form onSubmit={event => { event.preventDefault(); if (selectedAgentCanControl && steer.trim()) void rpc({ type: 'steer_subagent', subagentId: agentId, message: steer }).then(() => setSteer('')).catch(report); }}><label className="field">指导此智能体<textarea rows={3} value={steer} disabled={!selectedAgentCanControl} onChange={event => setSteer(event.target.value)} /></label><><button type="submit" disabled={!selectedAgentCanControl || !steer.trim()}>发送指导</button>{!selectedAgentCanControl && <p className="muted">此智能体已完成或存档，可查看持久输出，不能再指导或取消。</p>}</></form><div className="agent-transcript">{agentMessages.map((message, index) => <article key={index}><strong>{text(message.role)} {text(message.toolName)}</strong><Markdown>{messageText(message)}</Markdown>{!messageText(message) && <JsonDetails value={message} />}</article>)}</div></section>}</div>}
    {panel === 'tools' && <div className="panel-body"><h3><Terminal size={16} />命令执行器</h3><p className="muted">点击“运行命令”表示你主动提交并授权此命令，由当前会话直接执行，不会再弹出智能体工具审批。工具审批仅适用于模型发起的调用。这里不是交互式终端。</p><form onSubmit={event => { event.preventDefault(); if (!command.trim() || bashRunning) return; setBashRunning(true); setBashResult(undefined); void rpc({ type: 'bash', command }).then(setBashResult).catch(report).finally(() => setBashRunning(false)); }}><label className="field">Shell 命令<textarea rows={3} value={command} onChange={event => setCommand(event.target.value)} placeholder="输入要执行的命令" /></label><button className="primary" type="submit" disabled={!owner || bashRunning || !command.trim()}>{bashRunning ? '执行中…' : '运行命令'}</button>{bashRunning && <button type="button" className="danger" onClick={() => { void rpc({ type: 'abort_bash' }).catch(report); }}>停止命令</button>}</form>{bashResult !== undefined && <section className="command-result"><pre>{text(object(bashResult).output, JSON.stringify(bashResult, null, 2))}</pre><JsonDetails value={bashResult} title="退出状态与详情" /></section>}<h3><Wrench size={16} />可用工具</h3>{array(owner?.state.dumpTools).map(item => { const tool = object(item); return <details className="tool-definition" key={text(tool.name)}><summary>{text(tool.name)}</summary><p>{text(tool.description)}</p><JsonDetails value={tool.parameters ?? null} title="参数定义" /></details>; })}{!array(owner?.state.dumpTools).length && <p className="empty-small">打开会话后显示核心提供的工具定义。</p>}<details><summary>当前会话状态</summary><JsonDetails value={owner?.state ?? {}} title="get_state" /></details></div>}
  </aside>;
}
