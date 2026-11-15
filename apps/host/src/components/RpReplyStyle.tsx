import { tr } from '../lib/i18n';
/**
 * How a roleplay reply is written (server/rp/prompt.mjs replyStyleText): its length, inner thoughts, one turn or several, and the person's
 * own guidance. Used in Settings → Roleplay (the default) and in a chat's Reply style dialog (that chat's own).
 */
import type { RpReplyStyle } from '../lib/types';
import { Field, Select } from './ui';

export const NO_REPLY_STYLE: RpReplyStyle = { length: 'any', thoughts: 'any', shape: 'any', guidance: '' };
/** True when the style asks for something (otherwise the prompt gets no reply-style line). */
export const replyStyleSet = (s?: RpReplyStyle | null) => !!s && (s.length !== 'any' || s.thoughts !== 'any' || s.shape !== 'any' || !!s.guidance.trim());

export function ReplyStyleFields({ value, onChange }: { value: RpReplyStyle; onChange: (v: RpReplyStyle) => void }) {
  const set = (p: Partial<RpReplyStyle>) => onChange({ ...value, ...p });
  return <>
    <Field label={tr('Length')} hint={tr('How long each reply is. Profiles → RP has a hard limit too (Longest reply).')}>
      <Select value={value.length} onChange={v => set({ length: v })} ariaLabel={tr('Length')} options={[
        { value: 'any', label: 'As the model likes' }, { value: 'short', label: 'Short: a few sentences' }, { value: 'medium', label: 'Medium: one or two paragraphs' }, { value: 'long', label: 'Long: several paragraphs' }]} />
    </Field>
    <Field label={tr('One turn')} hint={tr('The character answers once and stops, instead of speech, thoughts, more speech and more thoughts in one reply.')}>
      <button className="st-toggle" role="switch" aria-checked={value.shape === 'single'} aria-label={tr('One turn')} onClick={() => set({ shape: value.shape === 'single' ? 'any' : 'single' })} />
    </Field>
    <Field label={tr('Inner thoughts')} hint={tr('The character’s thoughts in ((double parentheses)).')}>
      <Select value={value.thoughts} onChange={v => set({ thoughts: v })} ariaLabel={tr('Inner thoughts')} options={[
        { value: 'any', label: 'As the model likes' }, { value: 'few', label: 'At most one short thought' }, { value: 'none', label: 'None' }]} />
    </Field>
    <Field label={tr('Your guidance')} hint={tr('Anything else about how to reply, in your own words. {{char}} and {{user}} work.')} wide>
      <textarea className="st-input" rows={3} style={{ width: '100%' }} value={value.guidance} onChange={e => set({ guidance: e.target.value })}
        placeholder={tr('For example: Answer like a real conversation. Let {{user}} lead.')} />
    </Field>
  </>;
}
