/**
 * Roleplay text: what is spoken, what is done, what is thought. On the wire (to the model, in the saved chat) it is the notation models
 * are trained on: "spoken words", *actions*, ((thoughts)); anything else is narration. On screen the markers are hidden and each kind has
 * its own look (rp-speech, rp-action, rp-thought in app.css).
 */
export type RpKind = 'plain' | 'speech' | 'action' | 'thought';
export interface RpSegment { kind: RpKind; text: string }

const OPEN: Record<Exclude<RpKind, 'plain'>, string> = { speech: '"', action: '*', thought: '((' };
const CLOSE: Record<Exclude<RpKind, 'plain'>, string> = { speech: '"', action: '*', thought: '))' };

/** Markup -> segments. Unclosed markers stay plain text. **bold** is not an action. */
export function parseRp(text: string): RpSegment[] {
  const out: RpSegment[] = [];
  const re = /\(\(([\s\S]+?)\)\)|(?<!\*)\*(?!\*)([^*]+?)\*(?!\*)|"([^"]+?)"|“([^”]+?)”/g;
  let at = 0, m: RegExpExecArray | null;
  const push = (kind: RpKind, t: string) => { if (!t) return; const last = out[out.length - 1]; if (last && last.kind === kind) last.text += t; else out.push({ kind, text: t }); };
  while ((m = re.exec(text))) {
    push('plain', text.slice(at, m.index));
    if (m[1] !== undefined) push('thought', m[1]);
    else if (m[2] !== undefined) push('action', m[2]);
    else push('speech', m[3] ?? m[4] ?? '');
    at = m.index + m[0].length;
  }
  push('plain', text.slice(at));
  return out;
}

/** Segments -> markup. Line breaks inside a styled run close and reopen it, so every line reads on its own. */
export function serializeRp(segments: RpSegment[]): string {
  return segments.map(s => {
    if (s.kind === 'plain') return s.text;
    const kind = s.kind;
    return s.text.split('\n').map(line => {
      const lead = /^\s*/.exec(line)![0], trail = /\s*$/.exec(line)![0], core = line.trim();
      return core ? `${lead}${OPEN[kind]}${core}${CLOSE[kind]}${trail}` : line;
    }).join('\n');
  }).join('');
}

export const RP_KINDS: { kind: RpKind; label: string; key: string; hint: string }[] = [
  { kind: 'speech', label: 'Spoken', key: 'S', hint: 'Words said out loud' },
  { kind: 'action', label: 'Action', key: 'A', hint: 'What you do' },
  { kind: 'thought', label: 'Thought', key: 'T', hint: 'What you think; others cannot hear it' },
  { kind: 'plain', label: 'Narration', key: 'N', hint: 'Plain narration, no style' },
];
