/**
 * Roleplay text: what is spoken, what is done, what is thought. On the wire (to the model, in the saved chat) it is the notation models
 * are trained on: "spoken words", *actions*, ((thoughts)); anything else is narration. On screen the markers are hidden and each kind has
 * its own look (rp-speech, rp-action, rp-thought in app.css).
 */
export type RpKind = 'plain' | 'speech' | 'action' | 'thought';
export interface RpSegment { kind: RpKind; text: string }

const OPEN: Record<Exclude<RpKind, 'plain'>, string> = { speech: '"', action: '*', thought: '((' };
const CLOSE: Record<Exclude<RpKind, 'plain'>, string> = { speech: '"', action: '*', thought: '))' };

/*
 * A marker character that is only text (a quote inside a thought, an inch mark, a lone asterisk) is written with a backslash before it
 * (\" \* \( \)), so it never pairs with a marker of another part: a message read back always has exactly the parts it was written with.
 * Typed pairs in plain text ("hi", *waves*, ((hm))) are markup, as the model reads them.
 */
const ESC = /\\(["*()“”\\])/g;
const unescape = (t: string) => t.replace(ESC, '$1');
// Thought, action (one * each side; **bold** is not an action), straight or curly speech, or one escaped character.
const MARKUP = /\(\(((?:\\[\s\S]|(?!\)\))[^\\])+?)\)\)|(?<!(?<!\\)\*)\*(?!\*)((?:\\[\s\S]|[^*\\])+?)(?<!\\)\*(?!\*)|"((?:\\[\s\S]|[^"\\])+?)"|“((?:\\[\s\S]|[^”\\])+?)”|(\\["*()“”\\])/g;

// The pairs a person typed in plain text (no escapes there: a typed backslash is only a backslash).
const TYPED = /\(\(((?:(?!\)\))[\s\S])+?)\)\)|(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)|"([^"]+?)"|“([^”]+?)”/g;

/** Markup -> segments. Unclosed markers stay plain text. **bold** is not an action. */
export function parseRp(text: string): RpSegment[] { return split(text, MARKUP, unescape); }

function split(text: string, pattern: RegExp, clean: (t: string) => string): RpSegment[] {
  const out: RpSegment[] = [];
  const re = new RegExp(pattern.source, 'g');
  let at = 0, m: RegExpExecArray | null;
  const push = (kind: RpKind, t: string) => { if (!t) return; const last = out[out.length - 1]; if (last && last.kind === kind) last.text += t; else out.push({ kind, text: t }); };
  while ((m = re.exec(text))) {
    push('plain', text.slice(at, m.index));
    if (m[5] !== undefined) push('plain', m[5].slice(1));
    else if (m[1] !== undefined) push('thought', clean(m[1]));
    else if (m[2] !== undefined) push('action', clean(m[2]));
    else push('speech', clean(m[3] ?? m[4] ?? ''));
    at = m.index + m[0].length;
  }
  push('plain', text.slice(at));
  return out;
}

/** The text of one part, with the characters that would end it (or pair with a marker elsewhere) escaped. */
function escapeIn(kind: RpKind, text: string): string {
  const t = text.replace(/\\(?=["*()“”\\]|$)/g, '\\\\');
  if (kind === 'speech') return t.replace(/"/g, '\\"');
  if (kind === 'action') return t.replace(/\*/g, '\\*');
  if (kind === 'thought') return t.replace(/[()]/g, '\\$&');
  // Plain: a typed pair stays markup; every marker character left over is only text.
  if (kind === 'plain') return joinMarkup(split(text, TYPED, x => x).map(seg => (seg.kind === 'plain' ? seg.text.replace(/\\(?=["*()“”\\]|$)/g, '\\\\').replace(/(?<!\*)\*(?!\*)|["“”]|\(\(|\)\)|\($|^\)/g, c => c.replace(/./g, '\\$&')) : serializeRp([seg]))));
  return t;
}

/** Pieces of markup side by side: two actions that touch get a space between them (** would read as bold). */
function joinMarkup(pieces: string[]): string {
  let out = '';
  for (const p of pieces) out += out.endsWith('*') && !out.endsWith('\\*') && p.startsWith('*') ? ` ${p}` : p;
  return out;
}

/** Segments -> markup. Line breaks inside a styled run close and reopen it, so every line reads on its own. */
export function serializeRp(segments: RpSegment[]): string {
  return joinMarkup(segments.map(s => {
    if (s.kind === 'plain') return escapeIn('plain', s.text);
    const kind = s.kind;
    return s.text.split('\n').map(line => {
      const lead = /^\s*/.exec(line)![0], trail = /\s*$/.exec(line)![0], core = line.trim();
      return core ? `${lead}${OPEN[kind]}${escapeIn(kind, core)}${CLOSE[kind]}${trail}` : line;
    }).join('\n');
  }));
}

export const RP_KINDS: { kind: RpKind; label: string; key: string; hint: string }[] = [
  { kind: 'speech', label: 'Spoken', key: 'S', hint: 'Words said out loud' },
  { kind: 'action', label: 'Action', key: 'A', hint: 'What you do' },
  { kind: 'thought', label: 'Thought', key: 'T', hint: 'What you think; others cannot hear it' },
  { kind: 'plain', label: 'Narration', key: 'N', hint: 'Plain narration, no style' },
];
