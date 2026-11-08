/**
 * Tool calls the model wrote as text, made into real calls (the agent's model proxy, llm-shape.mjs).
 *
 * The model server reads `<tool_call><function=NAME><parameter=P>…` as a call only when NAME is a tool the request offered. A model that
 * guesses a name (`read_file` for `read`), or reaches for a tool this helper does not have (`skill` for a checker), gets its call back as
 * plain text, and the Harness takes that text as its final answer: the helper ends mid-work with a garbled report.
 *
 * At the end of a reply that is only text followed by one or more such blocks, this module turns the blocks into real tool calls:
 *   - a name that is an offered tool, or a common other name for one (read_file, file_read, view_file -> read; run_command -> bash; …),
 *     becomes a call of that tool, its parameter names matched to the tool's own (filename -> file_path) and its values typed from the
 *     tool's schema;
 *   - any other name becomes a call of `unavailable_<name>`, which no tool has: the Harness answers "unknown tool" and the model goes on in
 *     the same turn with the tools it has. Nothing the request did not offer can run this way.
 * Text that does not end in well-formed blocks (a reply that quotes the format, say) passes through unchanged.
 */

const CALL_START = '<tool_call>';
const CALL_END = '</tool_call>';

/** Other names models use for the Harness's tools (lower case, with _ - . and spaces removed when compared). */
const ALIASES = {
  read: ['read_file', 'file_read', 'readfile', 'view', 'view_file', 'open_file', 'get_file', 'cat', 'read_text_file', 'readtextfile'],
  write: ['write_file', 'file_write', 'create_file', 'save_file', 'writefile', 'write_to_file'],
  edit: ['edit_file', 'file_edit', 'str_replace', 'str_replace_editor', 'replace_in_file', 'modify_file', 'apply_edit', 'search_replace'],
  bash: ['shell', 'run', 'run_command', 'execute', 'execute_command', 'exec', 'terminal', 'run_shell', 'run_terminal_cmd', 'cmd', 'command', 'sh'],
  glob: ['find_files', 'list_files', 'file_search', 'glob_files'],
  grep: ['grep_search', 'search_files', 'search_code', 'ripgrep', 'rg', 'find_in_files', 'code_search'],
  web_fetch: ['fetch', 'fetch_url', 'open_url', 'browse', 'url_fetch', 'webfetch', 'read_url', 'get_url'],
  web_search: ['search_web', 'websearch', 'internet_search', 'google_search'],
  read_image: ['view_image', 'image_read', 'open_image', 'readimage'],
  todo_write: ['todo', 'todos', 'update_todos', 'write_todos', 'todowrite'],
  send_message: ['message_agent', 'send_to_agent', 'reply_to_parent', 'message'],
};
/** Other names for parameters, matched against the tool's own parameter names. */
const PARAM_ALIASES = [
  ['file_path', 'path', 'filepath', 'file', 'filename', 'file_name', 'target_file', 'absolute_path'],
  ['command', 'cmd', 'script', 'shell_command'],
  ['pattern', 'regex', 'query', 'search', 'glob'],
  ['old_string', 'old_str', 'old_text', 'search', 'find'],
  ['new_string', 'new_str', 'new_text', 'replace', 'replacement'],
  ['content', 'contents', 'text', 'data', 'file_text'],
  ['url', 'link', 'href'],
];

const squash = name => String(name ?? '').toLowerCase().replace(/[\s_.\-]/g, '');

/** The offered tools by name: their parameter names and types. */
export function toolIndex(tools) {
  const index = new Map();
  for (const t of Array.isArray(tools) ? tools : []) {
    const fn = t?.function ?? t;
    if (!fn?.name) continue;
    const props = fn.parameters?.properties ?? {};
    index.set(fn.name, { name: fn.name, props: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v?.type ?? null])) });
  }
  return index;
}

/** The offered tool a written name means, or null. */
export function resolveName(name, index) {
  if (index.has(name)) return name;
  const want = squash(name);
  for (const offered of index.keys()) if (squash(offered) === want) return offered;
  for (const [tool, others] of Object.entries(ALIASES)) {
    if (!index.has(tool)) continue;
    if (others.some(o => squash(o) === want)) return tool;
  }
  return null;
}

function typed(value, type) {
  if (typeof value !== 'string') return value;
  const v = value.trim();
  if (type === 'number' || type === 'integer') { const n = Number(v); return Number.isFinite(n) ? n : value; }
  if (type === 'boolean') return v === 'true' ? true : v === 'false' ? false : value;
  if (type === 'array' || type === 'object') { try { return JSON.parse(v); } catch { return value; } }
  return value;
}

/** The written arguments with their names matched to the tool's parameters and their values typed. */
export function matchArgs(args, tool) {
  if (!tool) return args;
  const props = tool.props, out = {};
  for (const [key, value] of Object.entries(args)) {
    let name = key;
    if (!(key in props)) {
      const group = PARAM_ALIASES.find(g => g.includes(key.toLowerCase()));
      const hit = group?.find(n => n in props && !(n in args) && !(n in out));
      if (hit) name = hit;
    }
    out[name] = typed(value, props[name]);
  }
  return out;
}

/**
 * `text` (from the first `<tool_call>`) as calls: `[{name, args}]`, or null when it is not one or more well-formed blocks with only
 * white space around them. Both forms models use: the XML one (`<function=NAME><parameter=P>V</parameter></function>`) and JSON
 * (`{"name": …, "arguments": {…}}`).
 */
export function parseCalls(text) {
  const calls = [];
  let rest = String(text ?? '');
  while (rest.trim()) {
    rest = rest.replace(/^\s+/, '');
    if (!rest.startsWith(CALL_START)) return null;
    const end = rest.indexOf(CALL_END);
    if (end < 0) return null;
    const body = rest.slice(CALL_START.length, end).trim();
    rest = rest.slice(end + CALL_END.length);
    const call = parseBody(body);
    if (!call) return null;
    calls.push(call);
  }
  return calls.length ? calls : null;
}

function parseBody(body) {
  const fn = /^<function=([^>\s]+)>([\s\S]*?)<\/function>$/.exec(body);
  if (fn) {
    const args = {};
    const re = /<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g;
    let m;
    while ((m = re.exec(fn[2]))) args[m[1]] = m[2];
    if (fn[2].replace(re, '').trim()) return null;
    return { name: fn[1], args };
  }
  try {
    const j = JSON.parse(body);
    if (j && typeof j.name === 'string') {
      const a = typeof j.arguments === 'string' ? JSON.parse(j.arguments) : (j.arguments ?? j.parameters ?? {});
      return a && typeof a === 'object' ? { name: j.name, args: a } : null;
    }
  } catch { /* not JSON */ }
  return null;
}

let counter = 0;
/** Parsed calls as OpenAI tool calls for this request's tools. */
export function toToolCalls(calls, index, { base = 0 } = {}) {
  return calls.map((c, i) => {
    const name = resolveName(c.name, index);
    const fnName = name ?? `unavailable_${String(c.name).replace(/[^\w-]/g, '_').slice(0, 60)}`;
    const args = name ? matchArgs(c.args, index.get(name)) : c.args;
    return { index: base + i, id: `call_text_${Date.now().toString(36)}_${(counter++).toString(36)}`, type: 'function', function: { name: fnName, arguments: JSON.stringify(args) } };
  });
}

/** A whole (not streamed) chat completion with any text calls at the end of its message made real. Returns the object unchanged otherwise. */
export function rewriteCompletion(obj, index) {
  const choice = obj?.choices?.[0], msg = choice?.message;
  if (!msg || typeof msg.content !== 'string') return obj;
  const at = msg.content.indexOf(CALL_START);
  if (at < 0) return obj;
  const calls = parseCalls(msg.content.slice(at));
  if (!calls) return obj;
  const before = msg.content.slice(0, at).trim();
  const existing = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  const made = toToolCalls(calls, index, { base: existing.length }).map(({ index: _i, ...c }) => c);
  return { ...obj, choices: [{ ...choice, finish_reason: 'tool_calls', message: { ...msg, content: before || null, tool_calls: [...existing, ...made] } }, ...obj.choices.slice(1)] };
}

/** The end of `text` that could be the start of `<tool_call>` (held back until the next piece says whether it is). */
function partialStart(text) {
  for (let n = Math.min(CALL_START.length - 1, text.length); n >= 2; n--) if (CALL_START.startsWith(text.slice(-n))) return n;
  return 0;
}

/**
 * A rewriter for a streamed chat completion (server-sent events). Events pass through byte for byte until a text delta contains
 * `<tool_call>`; from there the text is held, and at the end of the choice it goes out either as real tool-call deltas (with
 * finish_reason "tool_calls") or, when it did not read as calls, as the text it was.
 * @param {Map} index  toolIndex() of the request's tools
 * @param {(s:string)=>void} write
 */
export function createStreamRewriter(index, write) {
  let buffer = '', held = null, carry = '', template = null, base = 0, done = false;
  const chunkOf = (delta, finish = null) => ({ id: template?.id, object: template?.object ?? 'chat.completion.chunk', created: template?.created, model: template?.model, choices: [{ index: 0, delta, finish_reason: finish }] });
  const send = obj => write(`data: ${JSON.stringify(obj)}\n\n`);

  function settle(finishChunk) {
    if (done) return;
    if (carry && held === null) { send(chunkOf({ content: carry })); carry = ''; }
    if (held !== null) {
      const text = held + carry; held = null; carry = '';
      const calls = parseCalls(text);
      if (calls) {
        send(chunkOf({ tool_calls: toToolCalls(calls, index, { base }) }));
        if (finishChunk) { const ch = finishChunk.choices[0]; send({ ...finishChunk, choices: [{ ...ch, delta: { ...(ch.delta ?? {}), content: undefined }, finish_reason: 'tool_calls' }] }); done = true; return true; }
        send(chunkOf({}, 'tool_calls')); done = true; return true;
      }
      send(chunkOf({ content: text }));
    }
    return false;
  }

  function event(raw) {
    const data = raw.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) { write(`${raw}\n\n`); return; }
    if (data.trim() === '[DONE]') { settle(null); write(`${raw}\n\n`); return; }
    let obj;
    try { obj = JSON.parse(data); } catch { write(`${raw}\n\n`); return; }
    const ch = obj?.choices?.[0];
    if (!ch) { write(`${raw}\n\n`); return; }
    template = obj;
    for (const tc of ch.delta?.tool_calls ?? []) if (Number.isInteger(tc?.index)) base = Math.max(base, tc.index + 1);
    const content = ch.delta?.content;
    const finishing = ch.finish_reason != null;
    if (typeof content !== 'string' || !content) {
      if (finishing && (held !== null || carry)) { if (settle(obj)) return; }
      write(`${raw}\n\n`); return;
    }
    const strip = () => ({ ...obj, choices: [{ ...ch, delta: { ...ch.delta, content: undefined }, finish_reason: null }, ...obj.choices.slice(1)] });
    const others = Object.keys(ch.delta).some(k => k !== 'content' && k !== 'role' && ch.delta[k] != null);
    if (held !== null) {
      held += carry + content; carry = '';
      if (others) send(strip());
      if (finishing && settle(obj)) return;
      if (finishing) write(`data: ${JSON.stringify({ ...obj, choices: [{ ...ch, delta: {} }] })}\n\n`);
      return;
    }
    const text = carry + content;
    const at = text.indexOf(CALL_START);
    if (at >= 0) {
      carry = '';
      held = text.slice(at);
      const before = text.slice(0, at);
      if (before || others) send({ ...obj, choices: [{ ...ch, delta: { ...ch.delta, content: before || undefined }, finish_reason: null }, ...obj.choices.slice(1)] });
      if (finishing && settle(obj)) return;
      if (finishing) write(`data: ${JSON.stringify({ ...obj, choices: [{ ...ch, delta: {} }] })}\n\n`);
      return;
    }
    const keep = finishing ? 0 : partialStart(text);
    if (!keep && !carry) { write(`${raw}\n\n`); return; }
    carry = keep ? text.slice(-keep) : '';
    const out = keep ? text.slice(0, -keep) : text;
    if (out || others || finishing) send({ ...obj, choices: [{ ...ch, delta: { ...ch.delta, content: out || undefined } }, ...obj.choices.slice(1)] });
  }

  return {
    push(chunk) {
      buffer += chunk;
      let cut;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        if (raw.trim()) event(raw); else write('\n\n');
      }
    },
    end() {
      if (buffer.trim()) event(buffer);
      buffer = '';
      settle(null);
    },
  };
}
