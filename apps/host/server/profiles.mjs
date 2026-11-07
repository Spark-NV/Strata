/**
 * Chat profiles: Chat, Code and RP. Each chat belongs to one; the profile gives its system prompt, thinking level, sampling,
 * whether it has tools at all, its default approval mode, and which tools and skills it may use.
 *
 * Where each setting takes effect:
 *   - A plain turn (a profile with tools off) is sent by this host: the profile's prompt, sampling and output cap go into the request.
 *   - An agent turn is sent by the Harness through this host's forwarding endpoint on a route marked with the profile (llm-shape.mjs):
 *     the endpoint adds the prompt and sampling, drops the tools the profile does not allow from the request and trims the skill list.
 *   - The approval gate (agent/plugins/strata-gate.mjs) reads the policy file this module writes and refuses a tool or skill outside
 *     the chat's profile even if the model names it anyway, so hiding is never the only guard.
 *
 * Pure functions plus a small file store; the gate imports the pure part from inside the Harness process.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const PROFILE_IDS = Object.freeze(['chat', 'code', 'rp']);
export const EFFORTS = Object.freeze(['Medium', 'High']);   // High is sent as "high", which the Qwen template reads as xhigh
export const MODES = Object.freeze(['manual', 'plan', 'bypass']);
export const PLACEMENTS = Object.freeze(['add', 'replace']);
export const SAMPLING_FIELDS = Object.freeze({
  temperature: [0, 2], top_p: [0, 1], top_k: [1, 64], min_p: [0, 1], presence_penalty: [0, 2], frequency_penalty: [0, 2], repetition_penalty: [0.5, 2], seed: [0, 2147483647],
});

/** The tool names each Settings -> Tools group stands for (the Harness's own tool names). */
export const TOOL_NAMES = Object.freeze({
  shell: ['bash', 'pwsh'],
  files: ['read', 'write', 'edit', 'read_image'],
  find: ['glob', 'grep'],
  jobs: ['job_kill', 'job_list', 'job_output'],
  fetch: ['web_fetch'],
  search: ['web_search'],
  helpers: ['subagent', 'subagent_fork', 'list_agents', 'list_subagent_models', 'send_message', 'interrupt_agent'],
  goals: ['create_goal', 'get_goal', 'update_goal'],
  questions: ['ask_user_question'],
  todo: ['todo_write'],
  skills: ['skill'],
  present: ['present'],
});
export const TOOL_GROUP_IDS = Object.freeze(Object.keys(TOOL_NAMES));
const GROUP_OF = new Map(Object.entries(TOOL_NAMES).flatMap(([group, names]) => names.map(n => [n, group])));

const allGroups = (on, except = []) => Object.fromEntries(TOOL_GROUP_IDS.map(g => [g, except.includes(g) ? !on : on]));
/** The memory tools (agent/memory-mcp.mjs): allowed by the profile's memory switches, not by a tool group. */
export const MEMORY_TOOL_PREFIX = 'mcp__memory__';

const CHAT_PROMPT = [
  'When an answer depends on recent events, prices, versions, schedules or any fact you are not sure of, search the web first, read the best pages, and cite the ones you used as Markdown links. For broad or disputed questions, compare several sources and say where they disagree.',
  'Answer the question first, then the detail. Use headings, lists and tables when they make an answer easier to read; keep simple answers short. Say plainly when you do not know.',
].join('\n\n');
const CODE_PROMPT = [
  'Work like a careful senior engineer. Read the relevant code before changing it and follow the project\'s conventions (AGENTS.md / CLAUDE.md are loaded for you). Make the smallest change that solves the task.',
  'For a task with several steps, keep a todo list with todo_write. Delegate wide searches of a codebase to the @explorer agent and an independent review to @reviewer when it helps.',
  'After a change, verify it: run the build, the tests or the program, and report what you ran and what passed or failed. Never claim something works without checking it.',
].join('\n\n');

/** Starting agents and commands (each profile's can be edited in Settings -> Profiles). */
const CHAT_AGENTS = [
  { name: 'researcher', description: 'Researches one question on the web in depth and reports the findings with sources.', instructions: 'You are a research agent. Search the web several times with different wordings, open and read the most relevant pages (not just the result snippets), and cross-check facts between sources. Report a concise summary of what you found, the key facts with a Markdown link to the source of each, and anything uncertain or disputed.', tools: ['search', 'fetch'] },
];
const CODE_AGENTS = [
  { name: 'explorer', description: 'Searches and reads a codebase to answer a question about it; changes nothing.', instructions: 'You are a read-only code explorer. Use glob, grep and read (and read-only shell commands) to find the answer. Do not edit, write or run anything that changes files. Report the answer with the relevant file paths and line numbers, and short quotes of the key code.', tools: ['find', 'read', 'read_image', 'shell'] },
  { name: 'reviewer', description: 'Reviews a change (a diff or files) for bugs, edge cases and risks.', instructions: 'You are a strict code reviewer. Read the change and the code around it. Look for correctness bugs, unhandled edge cases, broken error handling, security problems, and places where the change does not match the surrounding code. Do not edit files. Report each problem with the file and line, why it is wrong, and a concrete fix, most severe first. Say so if you found nothing.', tools: ['find', 'read', 'shell'] },
  { name: 'tester', description: 'Runs the project\'s tests or build and reports exactly what failed.', instructions: 'You run the project\'s tests or build. Find the right command (package.json, Makefile, pyproject, README), run it, and report the result: the command, how many passed and failed, and for each failure the test name, the error and the likely cause. Do not change code.', tools: ['find', 'read', 'shell', 'jobs'] },
];
const CHAT_COMMANDS = [
  { name: 'summarize', description: 'Summarize a text, page or file', prompt: 'Summarize the following clearly: the main points first as a short list, then anything important that is easy to miss.\n\n$ARGUMENTS' },
  { name: 'explain', description: 'Explain something simply', prompt: 'Explain this in plain words, as to a smart person new to the subject. Start with a one-sentence answer, then build up, with an example.\n\n$ARGUMENTS' },
  { name: 'proofread', description: 'Fix spelling, grammar and clarity', prompt: 'Proofread the text below. Return the corrected text first, then a short list of the changes that were more than spelling.\n\n$ARGUMENTS' },
  { name: 'compare', description: 'Compare options with sources', prompt: 'Compare these options for me. Search the web for current information, then give a table of the differences that matter, a recommendation for typical use, and the sources.\n\n$ARGUMENTS' },
];
const CODE_COMMANDS = [
  { name: 'review', description: 'Review the uncommitted changes', prompt: 'Review the uncommitted changes in this repository (git diff and git diff --staged) for bugs, edge cases and risky code. Report problems with file and line, most severe first. Do not change anything. $ARGUMENTS' },
  { name: 'test', description: 'Run the tests and fix failures', prompt: 'Run this project\'s tests. If any fail, find the cause and fix it, then run them again until they pass or you are sure the failure is not caused by the code. Report what you ran and the result. $ARGUMENTS' },
  { name: 'commit', description: 'Commit the changes with a good message', prompt: 'Look at the uncommitted changes (git status, git diff), then commit them with a clear message in the style of this repository\'s recent commits (git log). Do not push. $ARGUMENTS' },
  { name: 'fix', description: 'Find and fix a bug', prompt: 'Find and fix this bug. Reproduce it first if you can, find the root cause (not just the symptom), make the smallest fix, and verify it.\n\n$ARGUMENTS' },
  { name: 'explain', description: 'Explain how some code works', prompt: 'Explain how this works in this codebase: the files involved, the flow from start to end, and anything surprising. Read the code; do not guess.\n\n$ARGUMENTS' },
];
const noSampling = () => Object.fromEntries(Object.keys(SAMPLING_FIELDS).map(k => [k, null]));

export const DEFAULT_PROFILES = Object.freeze({
  chat: {
    id: 'chat', name: 'Chat', systemPrompt: CHAT_PROMPT, promptPlacement: 'add', effort: 'High', thinkingBudget: 0, agent: true, mode: 'manual',
    sampling: noSampling(), maxTokens: null, historyLimit: 0,
    tools: { groups: allGroups(true, ['shell', 'files', 'jobs']), connected: false }, skills: { all: true, allow: [] },
    memory: { read: true, write: true }, webWithoutAsking: true, agents: CHAT_AGENTS, commands: CHAT_COMMANDS,
  },
  code: {
    id: 'code', name: 'Code', systemPrompt: CODE_PROMPT, promptPlacement: 'add', effort: 'High', thinkingBudget: 0, agent: true, mode: 'manual',
    sampling: noSampling(), maxTokens: null, historyLimit: 0,
    tools: { groups: allGroups(true), connected: true }, skills: { all: true, allow: [] },
    memory: { read: true, write: true }, webWithoutAsking: true, agents: CODE_AGENTS, commands: CODE_COMMANDS,
  },
  rp: {
    id: 'rp', name: 'RP', promptPlacement: 'replace', effort: 'Medium', thinkingBudget: 0, agent: false, mode: 'manual',
    systemPrompt: 'You are a creative roleplay partner. Stay in character, write vivid and consistent prose, keep track of the story so far, and let the user steer the scene. Do not speak or act for the user\'s character.',
    sampling: noSampling(), maxTokens: null, historyLimit: 0,
    tools: { groups: allGroups(false), connected: false }, skills: { all: false, allow: [] },
    memory: { read: false, write: false }, webWithoutAsking: false, agents: [], commands: [],
  },
});
/** Saved profiles from before this revision get the new default prompts where theirs was empty. */
export const PROFILE_REV = 2;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
function normalizeAgents(raw, base) {
  if (!Array.isArray(raw)) return base;
  const out = [];
  for (const a of raw.slice(0, 30)) {
    const name = String(a?.name ?? '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!NAME.test(name) || out.some(x => x.name === name)) continue;
    out.push({ name, description: String(a?.description ?? '').slice(0, 400), instructions: String(a?.instructions ?? '').slice(0, 20_000),
      tools: Array.isArray(a?.tools) ? a.tools.filter(t => TOOL_GROUP_IDS.includes(t) || GROUP_OF.has(t)) : null });
  }
  return out;
}
function normalizeCommands(raw, base) {
  if (!Array.isArray(raw)) return base;
  const out = [];
  for (const c of raw.slice(0, 60)) {
    const name = String(c?.name ?? '').toLowerCase().replace(/^\//, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!NAME.test(name) || out.some(x => x.name === name)) continue;
    out.push({ name, description: String(c?.description ?? '').slice(0, 200), prompt: String(c?.prompt ?? '').slice(0, 20_000) });
  }
  return out;
}

const num = (v, [lo, hi]) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : null);
const posInt = v => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** A profile from untrusted input, every field checked; what is missing or wrong takes the default. */
export function normalizeProfile(id, raw = {}) {
  const base = DEFAULT_PROFILES[id];
  if (!base) throw new Error(`Unknown profile ${id}`);
  const src = raw && typeof raw === 'object' ? raw : {};
  const sampling = {};
  for (const [k, range] of Object.entries(SAMPLING_FIELDS)) sampling[k] = num(src.sampling?.[k], range);
  if (sampling.seed !== null) sampling.seed = Math.round(sampling.seed) || null;
  const groups = {};
  for (const g of TOOL_GROUP_IDS) groups[g] = typeof src.tools?.groups?.[g] === 'boolean' ? src.tools.groups[g] : base.tools.groups[g];
  const allow = Array.isArray(src.skills?.allow) ? [...new Set(src.skills.allow.map(String).filter(s => /^[\w.:-]{1,128}$/.test(s)))] : base.skills.allow;
  return {
    id,
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 40) : base.name,
    systemPrompt: typeof src.systemPrompt === 'string' && (src.systemPrompt || src.rev === PROFILE_REV) ? src.systemPrompt.slice(0, 100_000) : base.systemPrompt,
    promptPlacement: PLACEMENTS.includes(src.promptPlacement) ? src.promptPlacement : base.promptPlacement,
    effort: EFFORTS.includes(src.effort) ? src.effort : base.effort,
    thinkingBudget: src.thinkingBudget === 0 ? 0 : posInt(src.thinkingBudget) ?? base.thinkingBudget,
    agent: typeof src.agent === 'boolean' ? src.agent : base.agent,
    mode: MODES.includes(src.mode) ? src.mode : base.mode,
    sampling,
    maxTokens: posInt(src.maxTokens),
    historyLimit: src.historyLimit === 0 ? 0 : posInt(src.historyLimit) ?? base.historyLimit,
    tools: { groups, connected: typeof src.tools?.connected === 'boolean' ? src.tools.connected : base.tools.connected },
    skills: { all: typeof src.skills?.all === 'boolean' ? src.skills.all : base.skills.all, allow },
    memory: { read: typeof src.memory?.read === 'boolean' ? src.memory.read : base.memory.read, write: typeof src.memory?.write === 'boolean' ? src.memory.write : base.memory.write },
    webWithoutAsking: typeof src.webWithoutAsking === 'boolean' ? src.webWithoutAsking : base.webWithoutAsking,
    agents: normalizeAgents(src.agents, base.agents),
    commands: normalizeCommands(src.commands, base.commands),
    rev: PROFILE_REV,
  };
}

/** May this profile use the tool `name`? Connected tools (MCP servers, the browser, the person's own) follow one switch. */
export function toolAllowed(profile, name) {
  if (!profile) return true;
  if (!profile.agent) return false;
  const tool = String(name ?? '');
  if (tool.startsWith(MEMORY_TOOL_PREFIX)) return tool === `${MEMORY_TOOL_PREFIX}recall` ? !!(profile.memory?.read || profile.memory?.write) : !!profile.memory?.write;
  const group = GROUP_OF.get(tool);
  if (group) return profile.tools.groups[group] !== false;
  if (tool.startsWith('mcp__')) return profile.tools.connected === true;
  return true;   // the Harness's own internals (the clock, compaction, ...): never a person-facing tool
}

/** May this profile load the skill `name`? */
export function skillAllowed(profile, name) {
  if (!profile) return true;
  if (!profile.agent || profile.tools.groups.skills === false) return false;
  return profile.skills.all || profile.skills.allow.includes(String(name ?? ''));
}

/** The sampling fields a request should carry (only the ones the profile sets). */
export function profileSampling(profile) {
  const out = {};
  for (const [k, v] of Object.entries(profile?.sampling ?? {})) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(p => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/** A skill catalog block with only the skills the profile may load. */
export function filterSkillCatalog(text, profile) {
  if (typeof text !== 'string' || !text.includes('<available_skills>')) return text;
  return text.replace(/<available_skills>\n([\s\S]*?)\n?<\/available_skills>/g, (_, body) => {
    const kept = body.split('\n').filter(line => { const m = /^- `([^`]+)`/.exec(line); return !m || skillAllowed(profile, m[1]); });
    return `<available_skills>\n${kept.join('\n')}${kept.length ? '\n' : ''}</available_skills>`;
  });
}

/**
 * An agent request (OpenAI chat body) as the profile wants it: its prompt added to (or in place of) the assistant's own system
 * message, its sampling set, its output cap applied, the tools it may not use left out and the skill list trimmed.
 */
/** Which of the profile's agents a (helper's) request is for: its task starts with "@name". */
export function agentOfRequest(messages, profile) {
  if (!profile?.agents?.length) return null;
  const first = messages.find(m => m?.role === 'user');
  const text = textOf(first?.content).slice(0, 4000);
  const m = /(?:^|\n)\s*@([a-z0-9][a-z0-9-]*)\b/.exec(text);
  return m ? profile.agents.find(a => a.name === m[1]) ?? null : null;
}

/** The profile's agents, for the system prompt of a profile that may delegate. */
export function agentsPrompt(profile) {
  if (!profile?.agents?.length || profile.tools.groups.helpers === false || !profile.agent) return '';
  return ['Specialist agents you can delegate to with the subagent tool. Start the subagent\'s task with @name (for example "@explorer Find where …") so it gets that agent\'s instructions:',
    ...profile.agents.map(a => `- @${a.name}: ${a.description}`)].join('\n');
}

export function applyProfileToAgentBody(body, profile, { memory = null } = {}) {
  if (!profile || !body || typeof body !== 'object' || !Array.isArray(body.messages)) return body;
  const out = { ...body, ...profileSampling(profile) };
  const helper = agentOfRequest(body.messages, profile);
  const prompt = [profile.systemPrompt.trim(), helper ? `You are the @${helper.name} agent.\n${helper.instructions}` : agentsPrompt(profile), memory ?? ''].filter(Boolean).join('\n\n');
  let messages = out.messages.map(m => {
    if (!m || typeof m !== 'object') return m;
    if (typeof m.content === 'string' && m.content.includes('<available_skills>')) return { ...m, content: filterSkillCatalog(m.content, profile) };
    if (Array.isArray(m.content) && m.content.some(p => typeof p?.text === 'string' && p.text.includes('<available_skills>')))
      return { ...m, content: m.content.map(p => (typeof p?.text === 'string' ? { ...p, text: filterSkillCatalog(p.text, profile) } : p)) };
    return m;
  });
  if (prompt) {
    const at = messages.findIndex(m => m?.role === 'system' || m?.role === 'developer');
    if (at < 0) messages = [{ role: 'system', content: prompt }, ...messages];
    else {
      const own = textOf(messages[at].content);
      messages = messages.map((m, i) => (i === at ? { ...m, content: profile.promptPlacement === 'replace' ? prompt : `${own}\n\n${prompt}` } : m));
    }
  }
  out.messages = messages;
  if (Array.isArray(out.tools)) {
    const agentAllows = name => { if (!helper?.tools) return true; const n = String(name ?? ''), g = GROUP_OF.get(n); return !g || helper.tools.includes(g) || helper.tools.includes(n); };
    out.tools = out.tools.filter(t => toolAllowed(profile, t?.function?.name ?? t?.name) && agentAllows(t?.function?.name ?? t?.name));
    if (!out.tools.length) { delete out.tools; delete out.tool_choice; delete out.parallel_tool_calls; }
  }
  if (profile.maxTokens) for (const key of ['max_tokens', 'max_completion_tokens']) if (Number.isFinite(out[key])) out[key] = Math.min(out[key], profile.maxTokens);
  if (profile.thinkingBudget > 0 && out.reasoning_budget_tokens === undefined && out.chat_template_kwargs?.enable_thinking !== false) out.reasoning_budget_tokens = profile.thinkingBudget;
  return out;
}

/* ------------------------------------------------------------------------------------------------------- the file store --- */

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

/**
 * The saved profiles (`<dataDir>/profiles.json`) and the gate's policy file (`<dataDir>/agent/profile-policy.json`: every profile
 * and which Harness session belongs to which profile).
 */
export function createProfileStore({ dataDir, changed = () => {} }) {
  const file = join(dataDir, 'profiles.json');
  const policyFile = join(dataDir, 'agent', 'profile-policy.json');
  let profiles = Object.fromEntries(PROFILE_IDS.map(id => [id, normalizeProfile(id, DEFAULT_PROFILES[id])]));
  try {
    if (existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      profiles = Object.fromEntries(PROFILE_IDS.map(id => [id, normalizeProfile(id, saved?.[id] ?? DEFAULT_PROFILES[id])]));
    }
  } catch { /* a damaged file: the defaults, rewritten on the next save */ }
  let sessions = {};
  try { if (existsSync(policyFile)) sessions = JSON.parse(readFileSync(policyFile, 'utf8'))?.sessions ?? {}; } catch { sessions = {}; }
  const writePolicy = () => writeJson(policyFile, { profiles, sessions });
  writePolicy();
  return {
    policyFile,
    list: () => profiles,
    get: id => profiles[PROFILE_IDS.includes(id) ? id : 'chat'],
    save(id, raw) {
      if (!PROFILE_IDS.includes(id)) throw new Error(`Unknown profile ${id}`);
      profiles = { ...profiles, [id]: normalizeProfile(id, raw) };
      writeJson(file, profiles);
      writePolicy();
      changed(profiles);
      return profiles[id];
    },
    reset(id) { return this.save(id, DEFAULT_PROFILES[id]); },
    /** The gate learns which profile a Harness session (one chat) is in. */
    bindSession(harnessSessionId, profileId) {
      if (!harnessSessionId || sessions[harnessSessionId] === profileId) return;
      sessions = { ...sessions, [harnessSessionId]: PROFILE_IDS.includes(profileId) ? profileId : 'chat' };
      writePolicy();
    },
  };
}

/** For the gate (inside the Harness): the policy file, read again only when it changed. */
export function policyReader(policyFile) {
  let cached = null, stamp = -1;
  return function profileOfSession(sessionId) {
    try {
      const m = statSync(policyFile).mtimeMs;
      if (m !== stamp) { cached = JSON.parse(readFileSync(policyFile, 'utf8')); stamp = m; }
    } catch { return null; }
    const id = cached?.sessions?.[sessionId];
    return id ? cached?.profiles?.[id] ?? null : null;
  };
}
