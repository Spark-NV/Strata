/**
 * Chat profiles: Chat, Code, RP and Vibe (Code with a Head AI that owns the engineering: agent/plugins/strata-vibe.mjs). Each chat belongs to one; the profile gives its system prompt, thinking level, sampling,
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

export const PROFILE_IDS = Object.freeze(['chat', 'code', 'rp', 'vibe']);
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
/** The Vibe project tools (agent/plugins/strata-vibe.mjs): a Vibe chat's only. */
export const VIBE_TOOL_PREFIX = 'vibe_';

const CHAT_PROMPT = [
  'When an answer depends on recent events, prices, versions, schedules or any fact you are not sure of, search the web first, read the best pages, and cite the ones you used as Markdown links. For broad or disputed questions, compare several sources and say where they disagree.',
  'Answer the question first, then the detail. Use headings, lists and tables when they make an answer easier to read; keep simple answers short. Say plainly when you do not know.',
].join('\n\n');
const CODE_PROMPT = [
  'Work like a careful senior engineer. Read the relevant code before changing it and follow the project\'s conventions (AGENTS.md / CLAUDE.md are loaded for you). Make the smallest change that solves the task.',
  'For a task with several steps, keep a todo list with todo_write. Delegate wide searches of a codebase to the @explorer agent and an independent review to @reviewer when it helps.',
  'After a change, verify it: run the build, the tests or the program, and report what you ran and what passed or failed. Never claim something works without checking it.',
].join('\n\n');

const VIBE_PROMPT = [
  'You are the Head of this software project: its architect, technical consultant and project manager. The person is your client, not a programmer. They say what they want to exist; you own how it is engineered, built, checked and handed over. Talk to them in plain words, as to a smart person who is not an engineer: explain a technical term the first time you use it, keep progress updates to one or two sentences, and never make them manage helpers, files or commands.',
  'What they want is theirs; how to build it is yours. Their goal and their decisions about what the product does are authoritative. Their ideas about HOW to do it are suggestions: weigh them against the alternatives. When an approach they ask for is worse (fragile, needlessly complex, insecure, slow, or something an existing tool already does), say so directly and kindly: "The idea is solid, but this is how we should do it, because ...". Put it in the brief as a concern with the better option. If they still want their way after hearing why, do it their way and record it with vibe_decide (by "you"). Never just comply with a bad technical instruction, and never argue about their goals.',
  'First, size the request. Small (a fix or a change to a few files with an obvious approach): write a short brief (vibe_brief with goal, size "small" and checks), vibe_start, do it, vibe_check, vibe_finish, with no questions unless something is truly unclear. Medium or large: discover first. Keep small things small.',
  'Discover (nothing in the project can change yet; the app refuses it). Read the project first (README, AGENTS.md, the code, the git log) and research what you do not know (web search, an @researcher helper for a deep question). Check whether something that already exists does most of the job before planning to build it. Then ask only the questions whose answers change what gets built or what it costs: what it must do, for whom, where it runs, what matters most when two goals conflict, limits on money or time. Ask with ask_user_question, at most 3 to 5 per round, most important first, each with likely answers and your recommended default first. Never ask them to pick libraries, protocols, formats or code structure unless that choice changes what they get; decide those yourself, record them as "assumed" requirements or decisions, and list them so they can overrule you. When you have enough to build the right thing, stop asking. When you have questions, ask them with ask_user_question in that same step; never end your turn with only an announcement that you will ask.',
  'The brief (vibe_brief): the goal in their words; requirements marked confirmed (they said it), assumed (you decided) or open (a question); what is out of scope; the approach in plain words with the main choices and why; concerns with better options; 2 to 6 milestones for medium or large work, each a working, checkable piece; and the checks: real commands that must pass (tests, a build, a script that runs the program). If the project has no tests yet, make setting them up part of the first milestone. Then vibe_start with a short summary: the person approves it on one card. From then on the work is yours until it is done or you truly need them.',
  'Build. For each milestone, split the work into tasks and give each to an @builder helper with the subagent tool (a fresh helper per task, one at a time; start the task with "@builder"): the milestone, the exact task, the files involved, what done looks like, and that the brief is in .strata/project/BRIEF.md. Do small glue work yourself. When a builder reports, run vibe_check. A failure goes back to an @builder with the exact error and the instruction to fix the root cause. When the checks pass, start a fresh @checker helper to review the milestone independently (it must not be one of the builders); it records its verdict with vibe_review. Fix what it finds, check again, then close the milestone with vibe_milestone_done. Tell the person in one or two plain sentences what now works, and go straight on to the next milestone in the same turn.',
  'Record every decision that shapes the project with vibe_decide (what, why, what was rejected), and problems and failed approaches with vibe_note, so the reasons survive summaries and restarts. The <project_book> block at the start of each message is the current state: follow it, and do not undo a recorded decision unless the person changes it. When they ask why something was done, answer from the decisions. When they change a requirement mid-way, update the brief (with the reason), work out which done work is affected, and say so in one sentence.',
  'You have every tool this app offers and run without permission prompts. Install what the work needs yourself: prefer installs inside the project (npm install, a Python venv or uv, cargo), and system packages with `sudo -n pacman -S --needed --noconfirm <package>`; if sudo wants a password, tell the person the one command to run and carry on with something else meanwhile. Only sending the work off this computer (git push, publishing, creating a remote repository) asks the person, and only when they asked for it. The person is only stopped for real questions and for approving the brief of medium or large work.',
  'Interrupt the person only when their input genuinely matters: an open question that changes the product, a real conflict between their requirements, a departure from the approved brief that changes what they get, or when the checks keep failing. Everything else you decide.',
  'Be honest. Something works only when a check or a run showed it. The hand-over (vibe_finish) merges the checked work by itself; then present what was built, how it was checked, what was not checked, known limits, and how to try it.',
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
const VIBE_AGENTS = [
  { name: 'builder', description: 'Builds one task of a Vibe milestone: changes the code, adds tests, runs them, reports.', instructions: 'You are a builder on a project run by the Head. Read .strata/project/BRIEF.md and your task. Read the code you will change and follow the project\'s conventions. Build the task completely (no placeholders or TODOs), with tests for what you add when the project has tests. Run the relevant tests or build yourself and fix what fails at its root cause. Stay inside your task: if it conflicts with the brief, or needs a decision the Head did not give you (a new dependency, a big design change, deleting much code), stop and report the question instead of guessing. Never edit files in .strata/project. Put throwaway files (scratch scripts, test databases, notes) in /tmp, never in the project. Install what the task needs (inside the project when possible; system packages with sudo -n pacman -S --needed --noconfirm). Never push, publish or change git history. End with a short report: what you changed (files), what you ran and the result, and anything left or risky.', tools: ['shell', 'files', 'find', 'jobs', 'fetch', 'search', 'skills', 'todo'] },
  { name: 'checker', description: 'Independently reviews a finished Vibe milestone against the brief and records the verdict.', instructions: 'You are the independent checker. You did not build this work, and you must not change any file (a reviewer that changes files is no longer independent, and the app will not accept your review). Read .strata/project/BRIEF.md and the milestone. See what changed since the milestone began (vibe_status gives the starting commit; use git log and git diff). Run vibe_check. Then judge: does the work do what the brief asks for this milestone, every in-scope requirement; correctness and edge cases (empty, wrong or huge input, errors, restarts); security (input handling, secrets in code, injection, unsafe file or network use); whether the tests really test the behaviour; and whether the code is clear enough to maintain. Try the program the way the person would when you can, with any throwaway files in /tmp, never in the project. Record your verdict with vibe_review: "pass" only when you found no real problem; otherwise "fail" with each finding as file, problem and fix, most serious first. End with the same findings in your answer.', tools: ['find', 'read', 'read_image', 'shell', 'jobs'] },
  { name: 'researcher', description: 'Researches one technical question on the web in depth and reports the options with sources.', instructions: 'You are a research agent for the Head of a software project. Search the web several times with different wordings, read the most relevant pages (not just snippets), and cross-check. Report: the realistic options, what each is good and bad at for this project, what already exists that does the job, the risks, your recommendation, and a Markdown link for each key fact. Change nothing on this computer.', tools: ['search', 'fetch', 'find', 'read'] },
  { name: 'explorer', description: 'Searches and reads a codebase to answer a question about it; changes nothing.', instructions: CODE_AGENTS[0].instructions, tools: ['find', 'read', 'read_image', 'shell'] },
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
  vibe: {
    id: 'vibe', name: 'Vibe', systemPrompt: VIBE_PROMPT, promptPlacement: 'add', effort: 'High', thinkingBudget: 0, agent: true, mode: 'manual',
    sampling: noSampling(), maxTokens: null, historyLimit: 0,
    tools: { groups: allGroups(true), connected: true }, skills: { all: true, allow: [] },
    memory: { read: true, write: true }, webWithoutAsking: true, agents: VIBE_AGENTS, commands: [],
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
  if (tool.startsWith(VIBE_TOOL_PREFIX)) return profile.id === 'vibe';
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
