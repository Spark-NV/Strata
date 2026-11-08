/** Shared shapes for the Strata host API. Mirrors server/types.d.ts. */

export type CheckState = 'pass' | 'warn' | 'fail';
export interface SoftwareUpdate {
  installedVersion?: string;
  status: 'available' | 'current' | 'unavailable' | 'error' | 'no-releases';
  latestVersion?: string;
  releaseUrl?: string;
  canInstall: boolean;
  message: string;
  /** The technical reason behind `message`, shown only behind the Details disclosure. */
  details?: string;
}
export interface UpdateCheckResult { checkedAt: string; strata: SoftwareUpdate; engine: SoftwareUpdate }

export interface HardwareCheck {
  id: 'gpu' | 'memory' | 'cpu' | 'storage';
  label: string;
  state: CheckState;
  detail: string;
  value?: string;
}

export interface ProcessorInfo { id:string; socket:string; model:string; cores:number; threads:number; arch:string; ghz:number; logicalIds?:number[] }
export interface CpuReading { id:string; utilizationPct:number|null }
export interface GpuReading { id:string; temperatureC:number|null; utilizationPct:number|null; memoryUsedGb:number|null; source:string; sampledAt:string; powerW?:number|null; powerLimitW?:number|null; pcieGen?:number|null; pcieGenMax?:number|null; pcieWidth?:number|null; pcieRxMbs?:number|null; fanPct?:number|null; clockMhz?:number|null }

export interface GpuInfo {
  id?: string;
  index: number;
  vendor: 'apple' | 'nvidia' | 'amd' | 'intel' | 'unknown';
  name: string;
  vramGb: number;
  freeVramGb?: number;
  unified: boolean;
  backend: 'metal' | 'cuda' | 'rocm' | 'vulkan' | 'cpu';
  driver?: string;
}

export interface Hardware {
  probedAt: string;
  host: { name: string; platform: string; release: string; arch: string; app: string };
  processors?: ProcessorInfo[];
  cpu: { topologyKnown?:boolean; model: string; cores: number; threads: number; arch: string; ghz: number };
  memory: { totalGb: number; freeGb: number; usedGb: number; pressure: 'low' | 'medium' | 'high' };
  disk: { path: string; totalGb: number; freeGb: number; modelsDir: string };
  gpus: GpuInfo[];
  accelerator: { backend: string; label: string; usableVramGb: number; unified: boolean };
  checks: HardwareCheck[];
  verdict: { ok: boolean; headline: string; detail: string };
  recommendedVariantId: string;
}

export type VariantState =
  | 'available'
  | 'downloading'
  | 'installed'
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'error';

export interface ModelVariant {
  local?: { path: string; files: { path: string; bytes: number; mtimeMs: number; ctimeMs: number }[]; architecture: string; contextLength: number; hasChatTemplate: boolean; shards: number; metadataSignature: string };
  source?: { repo: string; file: string; bytes?: number };
  downloadUrl?: string;
  kvKbPerToken?: number;
  catalog?: { family: string; version: string; purpose: string; capabilities: string[]; agentApproved: boolean; balancedRank: number; review: string };
  performance?: import('./experience').SpeedEvidence[];
  id: string;
  name: string;
  family: string;
  quant: string;
  label: string;
  params: string;
  blurb: string;
  role: 'best-fit' | 'option';
  ramClass: { minGb: number; maxGb: number; label: string };
  diskGb: number;
  downloadGb: number;
  contextMax: number;
  layerCount: number;
  experts: number;
  hasDraft: boolean;
  kvModes: string[];
  tags: string[];
  state: VariantState;
  progress?: { pct: number; mbps: number; etaSec: number; stage: string };
  error?: string;
  installedAt?: string;
}

export interface LocalModelPreview { variant: ModelVariant; files: string[]; warnings: string[] }
export interface LocalModelFolder { directory: string; parent: string | null; entries: { name: string; path: string; kind: 'folder' | 'model'; bytes?: number }[]; truncated: boolean; shortcuts: { name: string; path: string }[] }

export interface ModelLibrary {
  mode?: 'real' | 'simulated';
  current: string | null;
  loaded: string | null;
  variants: ModelVariant[];
  downloads: { active: number; queued: number; totalGbToday: number };
  disk: { modelsDir: string; usedGb: number; freeGb: number };
}

export type ImageModelChoice = 'off' | 'q4' | 'q5' | 'q6' | 'q8';
export interface ImageModelVariant {
  id: Exclude<ImageModelChoice, 'off'>;
  label: string;
  quant: string;
  file: string;
  bytes: number;
  downloadGb: number;
  downloadUrl: string;
  state: 'available' | 'downloading' | 'installed' | 'error';
  progress?: { pct: number; stage: string };
  error?: string;
}
export interface ImageModelLibrary {
  mode: 'real' | 'simulated';
  family: string;
  sourceUrl: string;
  revision: string;
  selected: ImageModelChoice;
  applied: ImageModelChoice;
  generationAvailable: boolean;
  variants: ImageModelVariant[];
}

export type ModelProtocol = 'openai-chat' | 'openai-responses' | 'anthropic';
export interface ApiModel { id: string; name: string; contextMax?: number | null; /** What the person ticked ("This model reads pictures"): true, false, or null for not set. */ vision?: boolean | null; /** The answer in use: the tick, else what the server said; null when nobody knows. */ reads?: boolean | null; /** The provider says the model can think (OpenRouter's supported_parameters): the Reasoning menu then works. */ reasoning?: boolean | null; thinks?: boolean | null }
export interface ModelProviderPreset { id: string; name: string; baseUrl: string; protocol: ModelProtocol; baseUrlHint?: string }
export interface ModelConnection {
  id: string; kind: 'provider' | 'custom'; provider: string | null; name: string;
  baseUrl: string; protocol: ModelProtocol; apiKeySet: boolean; models: ApiModel[];
}
export interface ModelProviders { catalog: ModelProviderPreset[]; connections: ModelConnection[] }
export interface RemoteModelSelection { connectionId: string; modelId: string }
/** The chat profiles (server/profiles.mjs): each chat is in one, which gives its prompt, thinking, sampling, tools and skills. */
export type ChatProfileId = 'chat' | 'code' | 'rp' | 'vibe';
export const CHAT_PROFILE_IDS: ChatProfileId[] = ['chat', 'code', 'vibe', 'rp'];
/** A chat's group in the sidebar: a profile, or Image (images from the image model; no text profile). */
export type SessionProfileId = ChatProfileId | 'image';
export type ProfileSampling = { temperature: number | null; top_p: number | null; top_k: number | null; min_p: number | null; presence_penalty: number | null; frequency_penalty: number | null; repetition_penalty: number | null; seed: number | null };
export interface ChatProfile {
  id: ChatProfileId; name: string; systemPrompt: string; promptPlacement: 'add' | 'replace'; effort: 'Medium' | 'High'; thinkingBudget: number;
  agent: boolean; mode: 'manual' | 'plan' | 'bypass'; sampling: ProfileSampling; maxTokens: number | null; historyLimit: number;
  tools: { groups: Record<string, boolean>; connected: boolean }; skills: { all: boolean; allow: string[] };
  /** Memory across chats: read puts the saved memories in the prompt; write gives the agent its remember / forget tools. */
  memory: { read: boolean; write: boolean };
  /** Web search and pages in Manual mode without the once-per-chat question. */
  webWithoutAsking: boolean;
  /** Named helpers the model can delegate to ("@name task" in the subagent tool); tools: groups or tool names, null for all. */
  agents: ProfileAgent[];
  /** The person's own slash commands: /name text, where $ARGUMENTS in the prompt is the text. */
  commands: ProfileCommand[];
}
export interface ProfileAgent { name: string; description: string; instructions: string; tools: string[] | null }
export interface ProfileCommand { name: string; description: string; prompt: string }
export interface ToolGroupInfo { id: string; area: string; name: string; about: string }
export interface ProfilesState { profiles: Record<ChatProfileId, ChatProfile>; toolGroups: ToolGroupInfo[] }
/** The one model the app runs on when the launcher pins it (server/pinned-model.mjs). */
export interface PinnedModelState { enabled: boolean; phase: 'off' | 'checking' | 'starting' | 'ready' | 'error' | 'stopping' | 'released'; name: string | null; modelId: string | null; connectionId: string | null; error: string | null; context: number | null; released?: { reason: 'idle' | 'game' | 'image'; detail: string | null; at: number } | null }
/** The image model of Image chats (server/image-model.mjs). */
export interface ImageModelState {
  enabled: boolean; phase: 'disabled' | 'off' | 'freeing' | 'loading' | 'ready' | 'stopping' | 'error'; name: string | null; error: string | null;
  loadedAt: number | null; usedAt: number | null; job: { step: number; steps: number; index: number; n: number; startedAt: number } | null;
  unloaded: { reason: 'text' | 'idle' | 'game' | 'person'; detail: string | null; at: number } | null;
  defaults: { steps: number; cfg: number; width: number; height: number } | null;
}
/** An Image chat's settings for its next images. */
export interface ImageSettings { width: number; height: number; steps: number; cfg: number; n: number; negative: string; seed: number | null }
/** An Image chat's reply while it is drawn and after: what was asked, the step, the live preview. */
export interface ImageJob { phase: 'waiting' | 'freeing' | 'loading' | 'drawing' | 'done'; width?: number; height?: number; step: number; steps: number; index: number; n: number; preview: string | null; seconds?: number; request?: { width: number; height: number; steps: number; cfg: number; seed: number; negative: string } }
export interface ModelConnectionDraft {
  id?: string; kind: 'provider' | 'custom'; provider: string | null; name: string;
  baseUrl: string; protocol: ModelProtocol; apiKey: string; clearKey?: boolean; models: ApiModel[];
}

export type Effort = 'fastest' | 'balanced' | 'quality' | 'max';

export interface BeginnerConfig {
  priority: 'speed' | 'balanced' | 'quality' | 'coding';
  contextLength: 'recommended' | `${number}k`;
  readImages: boolean;
  gpuIdle: 'never' | '5m' | '15m' | '1h';
}

export interface ExpertParam {
  applies?: string;
  id: string;
  group: string;
  label: string;
  effect: string;
  type: 'select' | 'number' | 'text' | 'toggle';
  options?: string[];
  value: string | number | boolean;
  recommended: string | number | boolean;
  advanced?: boolean;
}

export interface EngineConfig {
  extra?: Record<string, unknown>;
  variantId: string;
  beginner: BeginnerConfig;
  expert: ExpertParam[];
  predicted: {
    responseSpeed: string;
    memory: string;
    restartNeeded: boolean;
    notes: string[];
  };
  dirty: boolean;
  appliedAt?: string;
  engine: {
    status?: string;
    error?: string | null;
    port?: number;
    running: boolean;
    pid?: number;
    uptimeSec: number;
    version: string;
    backend: string;
    startedAt?: string;
  };
}

export interface RuntimeModel {
  id:string; apiModelId:string; variantId:string; family:string; name:string; quant:string;
  gpuIds:string[]; loadedAt:string; status:'ready'; phase:MonitorState['phase'];
  active:number; queued:number; prompt:MonitorState['prompt']; outputTps:number; promptTps:number;
  context:MonitorState['context'];
  memory:{context:number;ramGb:number;gpuGb:number;spillGb:number;reserveGb:number;totalGb:number;devices:{id:string;gb:number}[]};
}
export interface RuntimeModels {
  revision:number; mode:'real'|'simulated'; capabilities:{multipleModels:boolean;deviceAssignment:boolean}; defaultId:string|null;
  instances:RuntimeModel[];
  memory:{ramGb:number;budgetGb:number;reserveGb:number;totalGb:number;fits:boolean;devices:{id:string;name:string;usedGb:number;budgetGb:number}[]};
}

export interface ServeRequest {
  instanceId?:string;
  gpuIds?:string[];
  id: string;
  at: string;
  client: string;
  endpoint: string;
  state: 'generating' | 'queued' | 'done' | 'error';
  tokensIn: number | null;
  tokensOut: number | null;
  cancellable?: boolean;
  cancelRequested?: boolean;
  usageSource?: 'reported' | 'demo' | 'unavailable' | 'estimated';
  durationMs: number;
  error?: string;
  model: string;
  cachedTokens?: number | null;
  tps?: number | null;
  promptTps?: number | null;
  hitRate?: number | null;
  pcieShare?: number | null;
  finishReason?: string | null;
}

export interface TunnelState { status: 'idle' | 'starting' | 'connected' | 'stopping' | 'error'; mode: 'quick' | 'domain' | null; url: string | null; error: string | null; warning?: string | null; installed: boolean; originUrl: string; connector?: { path: string; version: string | null; source: string; label: string; summary: string } | null; external?: { kind: 'service' | 'process'; others: number[]; own: number[]; message: string } | null; }

export interface ServingState {
  tunnel?: TunnelState;
  sharing?: { active: boolean; url: string | null; warning?: string | null };
  revision?: number;
  running: boolean;
  baseUrl: string;
  /** The address on this computer (the app's own port); baseUrl is the network address while sharing is on. */
  localUrl?: string;
  port: number;
  endpoints: { openai: string; anthropic: string; models: string };
  access: { otherDevices: boolean; apiKeySet: boolean; apiKeyHint: string | null; allowOrigin: string };
  stats: { running: number; waiting: number; completed: number; failed: number; tokensOut: number };
  requests: ServeRequest[];
  pauseServing: boolean;
}

export interface MonitorSample {
  /** Device IDs covered by aggregate GPU history; omitted for legacy host-wide samples. */
  gpuIds?: string[];
  t: number;
  outputTps: number | null;
  promptTps: number | null;
  gpuLoad: number | null;
  vramUsedGb: number | null;
  ramUsedGb: number | null;
  gpuTempC: number | null;
  diskReadGbs: number | null;
  cpuLoad?: number | null;
  powerW?: number | null;
  pcieRxMbs?: number | null;
  gpus?: GpuReading[];
  cpus?: CpuReading[];
}

export interface MonitorState {
  telemetry?: { throughput: string; thermals: string; memory: string; system?:string; context?: string; ttftMs?: number | null };
  phase: 'idle' | 'reading' | 'thinking' | 'generating' | 'loading' | 'error';
  phaseLabel: string;
  variantId: string | null;
  prompt: { done: number; total: number; pct: number };
  generation?: { done:number|null; total:number|null };
  outputTps: number;
  promptTps: number;
  queue: { running: number; waiting: number };
  context: {
    requestId?: string;
    sessionId?: string;
    usedTokens: number;
    maxTokens: number;
    pct: number;
    parts?: { system: number; tools: number; messages: number };
  };
  expertCache: { used: number; total: number; memoryGb?:number|null; source?:string };
  hardware: {
    gpus?: GpuReading[];
    cpus?: CpuReading[];
    cpuLoad?: number | null;
    powerW?: number | null;
    powerLimitW?: number | null;
    pcieRxMbs?: number | null;
    /** CPU and SSD temperatures (only where this PC can give one) and the GPU energy used since the host started, in Wh (#3628). */
    cpuTempC?: number | null;
    ssdTempC?: number | null;
    energyWh?: number | null;
    diskReadGbs?: number | null;
    diskWriteMbs?: number | null;
    gpuLoad: number | null;
    vramUsedGb: number | null;
    vramTotalGb: number;
    ramUsedGb: number | null;
    ramTotalGb: number;
    gpuTempC: number | null;
    tempLimitC: number;
  };
  history: MonitorSample[];
  requests?: ServeRequest[];
  conversationCache?: { enabled?:boolean; parked?:number; slots?:number; memoryGb?:number; budgetGb?:number; parks?:number; restores?:number; evictions?:number; lastEvent?:string; lastAt?:number; lastTokens?:number; requests?:number;requestsReused?:number;lastPrompt?:number;lastReused?:number; source:string };
  mcp?: { servers:{ name:string; state:string; transport?:string; info?:{name?:string;version?:string}; error?:string; tools:{name:string;description?:string}[] }[]; tools:number };
  totals: {
    promptMs?: number;
    decodeMs?: number;
    usageRequests?: number;
    latencyRequests?: number;
    tokensIn: number;
    tokensOut: number;
    requests: number;
    avgTps: number;
    since: string;
    ttftMs: number;
    cachedTokens: number;
    uncachedTokens: number;
  };
}

export interface ChatMessage {
  /** Roleplay: the other versions of this reply (swipes); `content` is swipes[swipeIndex]. */
  swipes?: string[];
  swipeIndex?: number;
  /** Roleplay: the reasoning of each swipe, by index. */
  swipeReasoning?: string[];
  /** Roleplay: which character wrote this reply (a group chat has several). */
  characterId?: string;
  /** Roleplay: the speaker's name as shown (the persona for the person's messages). */
  name?: string;
  /** Roleplay: left out of the prompt (the message stays on screen). */
  hidden?: boolean;
  /** Tool calls the model is writing right now (a file, a command): live data for the writing card; see ToolDraft. */
  drafts?: ToolDraft[];
  /** The person's message is written with Markdown (a task handover: bold headings and lists), so the bubble draws it as such. */
  markdown?: boolean;
  photos?:import('./chat-photos').ChatPhoto[];
  /** An Image chat's reply: the drawing's progress and settings. */
  image?: ImageJob;
  /** Reply came from a saved API connection, rather than the local engine. */
  remoteModel?: boolean;
  timeSkipId?: string;
  /** The plan this reply proposed: shown as the plan card in place of the reply text. */
  planId?: string;
  /** The reply in the order it came: text and grouped activity lines (round 8, item 12). Absent on older replies. */
  blocks?: import('./deliverables').MessageBlock[];
  /** The saved skills this reply used (the line under the answer), in the order they were loaded. */
  skills?: { name: string; description: string }[];
  /** Files the assistant made or changed in this reply, one card each. */
  deliverables?: import('./deliverables').Deliverable[];
  /** A line from the app itself (for example from /loop), never sent to the model. */
  local?: boolean;
  ttftMs?: number;
  example?: boolean;
  media?: {kind: 'image' | 'video' | 'gif'; src:string; title:string; caption?:string; poster?:string}[];
  artifacts?: import('./artifacts').PreviewArtifact[];
  requestId?: string;
  model?: string;
  inputTokens?: number;
  /** What the context held after this reply (the last model request's prompt + reply); an agent turn's inputTokens add every request up. */
  contextUsed?: number;
  /** When the first reasoning arrived, and how long the model reasoned before it began the answer (for "Thought for 38s"). */
  reasoningStartedAt?: number;
  reasoningMs?: number;
  contextMax?: number;
  usageSource?: 'reported' | 'demo' | 'unavailable' | 'estimated';
  skillsUsed?: string[];
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  at: string;
  streaming?: boolean;
  demo?: boolean;
  reasoning?: string;
  reasoningOpen?: boolean;
  tokens?: number;
  tps?: number;
  promptTps?: number;
  durationMs?: number;
  error?: string;
  /** What went wrong, as a code the page acts on (a context error offers its own recovery buttons). */
  errorCode?: string;
  /** The engine's own text of the error, kept behind Details. */
  errorDetail?: string;
  tools?: ToolCall[];
}

export type ToolState = 'proposed' | 'approved' | 'running' | 'done' | 'denied' | 'error';

/**
 * A tool call the model is still writing (a whole file in one call, say), as the host streams it: the name, the file it is for, a growing size
 * and the tail of the text. It lives on the assistant message while the call is written and is removed when the call is complete (the
 * ordinary tool card takes over) or the reply was cut and the call was lost (`lost`).
 */
export interface ToolDraft {
  id: string;
  name: string;
  /** The file (or address) the call is for; empty until the model has written it. */
  target: string;
  /** Characters of the call's arguments so far (a file's size, a little more because of escapes). */
  bytes: number;
  /** Lines of text written so far. */
  lines: number;
  /** The last part of the text being written, read back from its JSON form (at most 1,600 characters). */
  preview: string;
  /** What the call is: 'write', 'edit', 'shell', ... (same as ToolCall.scope). */
  scope?: 'read' | 'write' | 'shell' | 'connected';
  /** The plain verb for the card while it is written ("Writing"). */
  verb?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  preview: string;
  effect: string;
  scope: 'read' | 'write' | 'shell' | 'connected';
  /** The card's headline in plain words for its current state ("Wrote a file"); the host sends it, the UI translates it. */
  verb?: string;
  /** What the action is on: a file path, the command, a web address. */
  target?: string;
  /** The question an approval card asks in plain words (server/agent/ask.mjs); the page translates it. */
  ask?: { id: string; params?: (string | number)[]; why?: string; detail?: string };
  state: ToolState;
  result?: string;
  durationMs?: number;
  /** Reported by the agent runtime: an approval answers a real request. Absent for design-build examples. */
  live?: boolean;
  /** The person approved this call. A finished card without it was never asked about. */
  approved?: boolean;
}

/** A folder the model may read, and that sessions are grouped under. */
export interface Workspace {
  id: string;
  name: string;
  path: string;
  /** Earlier folders whose chats belong here (the first workspace moved off the app's own folder). */
  aliases?: string[];
}

export interface SessionAgent {
  id: string;
  name: string;
  description: string;
  status: 'working' | 'completed' | 'failed' | 'queued' | 'cancelled';
  durationMs: number;
  tokens: number;
  /** Time the latest duration measurement was received. */
  updatedAt?: number;
}

export type ChatMode = 'auto' | 'manual' | 'accept-edits' | 'plan' | 'bypass';

/**
 * What the board needs to know about a /loop after the window closes: loops live in memory, so the chat keeps a small record of the
 * last one (running, or how it ended). A record that says `running` with no loop behind it is a loop the window closed on.
 */
export interface LoopRecord {
  prompt: string;
  everyMs: number;
  startedAt: number;
  state: 'running' | 'ended';
  answers: number;
  maxRuns?: number;
  /** When the next answer is due (ms), while running. */
  nextAt?: number;
  endedAt?: number;
  /** count, said-done, time, failures, cap; `stopped` when the person typed /loop stop; `closed` when the window closed on it. */
  endedWhy?: 'count' | 'said-done' | 'time' | 'failures' | 'cap' | 'stopped' | 'closed';
  /** The last answer's first words, for the card. */
  lastText?: string;
}

/** A roleplay chat's own setup (server/rp/): who is in it, who the person plays, its lorebooks, its author's note and its variables. */
export interface RpChat {
  characterIds: string[];
  personaId?: string | null;
  lorebookIds?: string[];
  authorsNote?: RpAuthorsNote;
  vars?: Record<string, string>;
  /** Group members who do not speak on their own turn. */
  muted?: string[];
}
export type RpRole = 'system' | 'user' | 'assistant';
export interface RpAuthorsNote { text: string; depth: number; interval: number; role: RpRole; position: 'depth' | 'top' | 'bottom' }
export interface RpEntry {
  uid: number; comment: string; keys: string[]; secondaryKeys: string[]; selectiveLogic: 'and_any' | 'not_all' | 'not_any' | 'and_all';
  content: string; constant: boolean; enabled: boolean; position: 'before_char' | 'after_char' | 'an_top' | 'an_bottom' | 'depth' | 'em_top' | 'em_bottom';
  depth: number; role: RpRole; order: number; probability: number; caseSensitive: boolean | null; matchWholeWords: boolean | null;
  scanDepth: number | null; excludeRecursion: boolean; preventRecursion: boolean; group: string; sticky: number; cooldown: number; delay: number;
}
export interface RpLorebook { id: string; name: string; description: string; scanDepth: number | null; tokenBudget: number | null; recursive: boolean; entries: RpEntry[] }
export interface RpCharacter {
  id: string; name: string; avatar: boolean; description: string; personality: string; scenario: string; firstMessage: string;
  alternateGreetings: string[]; exampleDialogues: string; systemPrompt: string; postHistoryInstructions: string; creatorNotes: string;
  creator: string; characterVersion: string; tags: string[]; talkativeness: number; favorite: boolean;
  depthPrompt: { text: string; depth: number; role: RpRole }; book: RpLorebook | null; lorebookIds: string[]; createdAt: string; updatedAt: string;
}
export interface RpPersona { id: string; name: string; description: string; avatar: boolean; position: 'prompt' | 'depth' | 'none'; depth: number; role: RpRole; lorebookId: string | null }
export interface RpCustomPrompt { id: string; name: string; role: RpRole; content: string; enabled: boolean; depth: number | null }
export interface RpReplacement { id: string; name: string; find: string; replace: string; flags: string; on: 'output' | 'input' | 'both'; enabled: boolean }
export interface RpSettings {
  userName: string; mainPrompt: string; formatPrompt: string; auxiliaryPrompt: string; postHistoryPrompt: string; preferCharPrompt: boolean; preferCharInstructions: boolean;
  impersonationPrompt: string; continuePrompt: string; groupNudgePrompt: string; newChatPrompt: string; newGroupChatPrompt: string; newExampleChatPrompt: string;
  examplesBehavior: 'gradual' | 'always' | 'disabled'; namesBehavior: 'groups' | 'always' | 'never'; squashSystem: boolean;
  promptOrder: { id: string; enabled: boolean }[]; customPrompts: RpCustomPrompt[];
  worldInfo: { scanDepth: number; budgetPercent: number; budgetCap: number; recursive: boolean; maxRecursion: number; caseSensitive: boolean; matchWholeWords: boolean; includeNames: boolean; globalBooks: string[] };
  authorsNote: RpAuthorsNote; contextLimit: number; responseReserve: number; autoStops: boolean; customStops: string[]; trimIncomplete: boolean;
  replacements: RpReplacement[]; group: { strategy: 'natural' | 'list' | 'random' | 'manual'; allowSelfResponses: boolean; cards: 'speaker' | 'all' };
  defaultPersonaId: string | null;
}
export interface RpLibrary { characters: RpCharacter[]; personas: RpPersona[]; lorebooks: RpLorebook[]; settings: RpSettings }

export interface Session {
  /** Roleplay chats: the characters, persona, lorebooks and author's note (absent: an ordinary chat). */
  rp?: RpChat;
  /** The profile this chat belongs to (Chat, Code, RP, Image); a chat from before profiles is a Chat. */
  profile?: SessionProfileId;
  /** An Image chat's settings for its next images. */
  imageSettings?: ImageSettings;
  /** The person dismissed this chat's (or its loop's) card on the board at this time. A later problem brings it back. */
  ackedAt?: string;
  loop?: LoopRecord;
  timeSkips?: import('./time-skip').TimeSkipRun[];
  showcase?: boolean;
  agents?: SessionAgent[];
  previewOpen?: string;
  closedPreviews?: string[];
  showcaseAgentStates?: boolean;
  preferences?: { access?: 'read' | 'write' | 'full'; thinking?: string; thinkingBudget?: number; mode?: ChatMode; useTools?:boolean; /** false: plain conversation, no tools of any kind. */ agent?: boolean; /** This chat's API model; absent or null means the local model. */ remoteModel?: RemoteModelSelection | null };
  /** A branch does not have retained per-turn input usage. */
  statsAvailable?: boolean;
  id: string;
  title: string;
  defaultTitle?: boolean;
  updatedAt: string;
  createdAt: string;
  messages: ChatMessage[];
  workspace: string;
  tokensIn: number;
  tokensOut: number;
  pinned?: boolean;
  /** Put away without deleting. Archiving is for "done with this for now" —
   *  deleting is for "never want to see it again", and conflating the two makes
   *  people keep things they are finished with. */
  archived?: boolean;
  /** When this conversation was last on screen. A session is unread when it has
   *  been updated since — which is the only way to tell, with more than a
   *  handful of conversations, which ones have something new in them. */
  lastReadAt?: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: 'bundled' | 'workspace' | 'user';
  enabled: boolean;
  triggers: string[];
  /** The instruction text itself — what the model is actually told. Deciding
   *  whether to trust a skill means reading this, not its name. */
  body?: string;
  /** When set, the skill applies only in this workspace. A skill written for
   *  one project is noise in another, and on/off cannot express "here, not
   *  there". */
  onlyIn?: string | null;
  /** How many times a prompt has actually triggered this skill, and when last. */
  useCount?: number;
  lastUsedAt?: string | null;
  sizeKb: number;
}

export interface WorkspaceFile {
  path: string;
  kind: 'file' | 'dir';
  sizeKb?: number;
  updatedAt?: string;
}

export interface SetupState {
  flowVersion?: number;
  dismissed?: boolean;
  choices?: { onboarding?: { step:number; family?:string; size?:string; context?:number; vision?:boolean; directory?:string; profile?:'work'|'performance'; installJobId?:string; tuneJobId?:string; calibrate?:boolean; manual?:boolean }; variantId?: string; contextLength?: BeginnerConfig["contextLength"]; profile?: import("./experience").Profile; batch?: number; batchAuto?: boolean };
  complete: boolean;
  step: number;
  completedAt?: string;
  history: { step: number; at: string }[];
  app: { version: string; modelsDir: string; dataDir: string; modelsDirNotice?: string };
}

export interface EngineEvent {
  type: 'engine' | 'monitor' | 'models' | 'serving' | 'download' | 'log';
  at: string;
  payload: unknown;
}
