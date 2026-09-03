const $ = selector => document.querySelector(selector);
let conversationId = null;
let busy = false;
let controller;
let ready = false;
let calls = 0;
const cards = new Map();

async function loadStatus() {
  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error();
    const data = await response.json();
    $('#model-name').textContent = data.model;
    $('#model-url').textContent = data.base_url;
    $('#model-status').textContent = data.model_verified ? '已验证' : '已配置';
    $('#model-status').className = 'badge';
    $('#mcp-status').textContent = data.mcp_connected ? '已连接' : '已断开';
    $('#mcp-status').className = data.mcp_connected ? 'badge' : 'badge error';
    $('#tool-schema').textContent = JSON.stringify(data.tools[0]?.input_schema || {}, null, 2);
    ready = data.mcp_connected && data.api_key_configured;
    if (!busy) $('#progress').textContent = ready ? '准备就绪，试着问一个问题吧' : 'MCP 未连接，请重启网页服务。';
  } catch { ready = false; $('#progress').textContent = '无法连接本地服务，请运行 npm run web。'; }
  $('#send').disabled = !ready || busy;
}

function bubble(role, text) {
  const wrap = document.createElement('article');
  wrap.className = `bubble ${role}`;
  const label = document.createElement('div');
  label.className = 'bubble-label';
  const avatar = document.createElement('span');
  avatar.className = 'avatar';
  avatar.textContent = role === 'user' ? '你' : 'OA';
  label.append(avatar, role === 'user' ? '你' : 'OA 助手');
  const content = document.createElement('div');
  content.className = 'bubble-content';
  content.textContent = text;
  wrap.append(label, content);
  $('#messages').append(wrap);
  scroll();
  return { wrap, content };
}

function scroll() { $('#messages').scrollTop = $('#messages').scrollHeight; }
function renderAnswer(element, text) {
  element.replaceChildren();
  for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
    if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong'); strong.textContent = part.slice(2, -2); element.append(strong);
    } else if (part.startsWith('`') && part.endsWith('`')) {
      const code = document.createElement('code'); code.textContent = part.slice(1, -1); element.append(code);
    } else element.append(document.createTextNode(part));
  }
}
function detail(title, data, open = false) {
  const block = document.createElement('details');
  block.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  const pre = document.createElement('pre');
  pre.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  block.append(summary, pre);
  return block;
}

function traceCall(event) {
  calls++;
  $('#trace-count').textContent = calls;
  $('#metric-calls').textContent = calls;
  const card = document.createElement('section');
  card.className = 'trace-card';
  const title = document.createElement('div');
  title.className = 'trace-title';
  const name = document.createElement('code');
  name.textContent = event.name;
  const state = document.createElement('span');
  state.className = 'trace-state';
  state.textContent = '查询中';
  title.append(name, state);
  card.append(title, detail('调用参数', event.arguments, true));
  $('#traces').append(card);
  cards.set(event.id, { card, state });
}

function traceResult(event) {
  const item = cards.get(event.id);
  if (!item) return;
  item.state.textContent = `${event.is_error ? '失败' : '完成'} · ${(event.duration_ms / 1000).toFixed(1)}s`;
  if (event.result && typeof event.result === 'object' && Number.isInteger(event.result.total)) {
    const summary = document.createElement('div');
    summary.className = 'result-summary';
    summary.textContent = `查询总数 ${event.result.total} 人${event.result.count_only ? ' · 仅统计' : ` · 本页 ${event.result.returned} 人`}`;
    item.card.append(summary);
  }
  item.card.append(detail(event.is_error ? '错误信息' : 'MCP 返回结果', event.result, event.is_error));
}

async function sendQuestion(message) {
  if (busy || !ready || !message.trim()) return;
  busy = true;
  controller = new AbortController();
  $('#welcome').hidden = true;
  $('#question').value = '';
  $('#send').disabled = true;
  $('#new-chat').disabled = true;
  $('#stop').hidden = false;
  $('#progress').className = 'progress busy';
  $('#progress').textContent = '正在发送问题…';
  $('#traces').replaceChildren();
  cards.clear(); calls = 0;
  $('#trace-count').textContent = '0';
  $('#metric-calls').textContent = '0';
  $('#metric-time').textContent = '…';
  $('#usage').textContent = '正在记录本次查询';
  bubble('user', message);
  const answer = bubble('pending', '正在查询，请稍候…');
  let completed = false;
  let failed = false;
  const started = Date.now();
  const onEvent = event => {
    if (event.type === 'session') conversationId = event.conversation_id;
    if (event.type === 'status') { $('#progress').textContent = event.message; answer.content.textContent = event.message; }
    if (event.type === 'tool_call') traceCall(event);
    if (event.type === 'tool_result') traceResult(event);
    if (event.type === 'answer') { answer.wrap.className = 'bubble assistant'; renderAnswer(answer.content, event.text); }
    if (event.type === 'error') { failed = true; throw new Error(event.message); }
    if (event.type === 'done') {
      completed = true;
      $('#metric-time').textContent = `${(event.duration_ms / 1000).toFixed(1)}s`;
      $('#usage').textContent = `输入 ${event.usage.input_tokens} / 输出 ${event.usage.output_tokens} tokens`;
      if (!event.tool_count) {
        const note = document.createElement('div'); note.className = 'trace-note';
        note.textContent = '本次模型直接回答，未调用 MCP 工具。'; $('#traces').append(note);
      }
    }
    scroll();
  };
  try {
    const response = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, conversation_id: conversationId }), signal: controller.signal,
    });
    if (!response.ok) { const data = await response.json(); throw new Error(data.error || '请求失败。'); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (line.trim()) onEvent(JSON.parse(line));
      }
      if (done) break;
    }
    if (!completed) throw new Error('连接已中断，请重新提问。');
  } catch (error) {
    failed = true;
    answer.wrap.className = 'bubble error';
    answer.content.textContent = controller.signal.aborted ? '已停止本次查询。可以重新提问。' : (error.message || '查询失败。');
    $('#metric-time').textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
    $('#usage').textContent = controller.signal.aborted ? '查询已停止' : '查询未完成，可查看调用记录';
    for (const item of cards.values()) if (item.state.textContent === '查询中') item.state.textContent = '未完成';
  } finally {
    busy = false;
    $('#stop').hidden = true;
    $('#new-chat').disabled = false;
    $('#progress').className = 'progress';
    await loadStatus();
    $('#progress').textContent = failed ? '本次查询未完成，可以重试或开始新对话' : '查询完成，可以继续追问';
    $('#question').focus(); scroll();
  }
}

$('#chat-form').addEventListener('submit', event => { event.preventDefault(); sendQuestion($('#question').value); });
$('#question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#chat-form').requestSubmit(); }
});
document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => sendQuestion(button.dataset.question)));
$('#stop').addEventListener('click', () => controller?.abort());
$('#new-chat').addEventListener('click', async () => {
  if (busy) return;
  if (conversationId) {
    const response = await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' }).catch(() => null);
    if (response && !response.ok) { $('#progress').textContent = '上一轮尚在停止，请稍后再次点击新对话。'; return; }
  }
  conversationId = null;
  document.querySelectorAll('.bubble').forEach(node => node.remove());
  $('#welcome').hidden = false;
  $('#traces').replaceChildren();
  $('#metric-calls').textContent = '—'; $('#metric-time').textContent = '—'; $('#trace-count').textContent = '0';
  $('#usage').textContent = '不预设查询结果，模型自主选择工具';
  $('#question').value = ''; $('#question').focus();
  await loadStatus();
});
loadStatus();
