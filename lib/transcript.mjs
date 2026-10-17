// Real token numbers instead of chars/4: a Claude Code transcript (JSONL) carries the API usage of every
// assistant message. Streaming splits one message across several lines that repeat the same usage, so
// usage is counted once per message id.
const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('') : '');

export function summarizeTranscript(text, isTestCommand) {
  const usage = new Map();
  const bash = new Map();
  let toolChars = 0;
  let testChars = 0;
  let testCalls = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const content = Array.isArray(e?.message?.content) ? e.message.content : [];
    if (e.type === 'assistant') {
      const id = e.message?.id ?? e.requestId ?? e.uuid;
      if (e.message?.usage && id) usage.set(id, { model: e.message.model ?? 'unknown', u: e.message.usage });
      for (const c of content) if (c?.type === 'tool_use' && c.name === 'Bash') bash.set(c.id, String(c.input?.command ?? ''));
    } else if (e.type === 'user') {
      for (const c of content) {
        if (c?.type !== 'tool_result') continue;
        const n = textOf(c.content).length;
        toolChars += n;
        const cmd = bash.get(c.tool_use_id);
        if (cmd !== undefined && isTestCommand(cmd)) { testChars += n; testCalls++; }
      }
    }
  }
  const models = {};
  for (const { model, u } of usage.values()) {
    const m = (models[model] ??= { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    m.input += u.input_tokens ?? 0;
    m.cacheWrite += u.cache_creation_input_tokens ?? 0;
    m.cacheRead += u.cache_read_input_tokens ?? 0;
    m.output += u.output_tokens ?? 0;
  }
  return { messages: usage.size, models, toolChars, testChars, testCalls };
}
