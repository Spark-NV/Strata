import { tr } from '../lib/i18n';
/**
 * The roleplay message box: plain typing, with Spoken / Action / Thought / Narration buttons. Select text and press one to restyle it, or
 * press one first and type. The text shows only the style (no markers); `value` is the markup the model gets (lib/rp-format.ts).
 * Enter sends, Shift+Enter is a new line; Alt+S, Alt+A, Alt+T and Alt+N are the buttons.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { parseRp, RP_KINDS, serializeRp, type RpKind, type RpSegment } from '../lib/rp-format';

const ZW = '​';

function render(root: HTMLElement, value: string) {
  const nodes: Node[] = [];
  for (const seg of parseRp(value)) {
    const parts = seg.text.split('\n');
    const into: Node[] = [];
    parts.forEach((p, i) => { if (i) into.push(document.createElement('br')); if (p) into.push(document.createTextNode(p)); });
    if (seg.kind === 'plain') nodes.push(...into);
    else { const span = document.createElement('span'); span.className = `rp-${seg.kind}`; span.dataset.k = seg.kind; span.append(...into); nodes.push(span); }
  }
  root.replaceChildren(...nodes);
}

function read(root: HTMLElement): RpSegment[] {
  const out: RpSegment[] = [];
  const push = (kind: RpKind, text: string) => { if (!text) return; const last = out[out.length - 1]; if (last && last.kind === kind) last.text += text; else out.push({ kind, text }); };
  const walk = (node: Node, kind: RpKind, first: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) { push(kind, (node.textContent ?? '').replace(/​/g, '')); return; }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') { push(kind, '\n'); return; }
    // A browser may wrap a new line in a <div>.
    if ((node.tagName === 'DIV' || node.tagName === 'P') && !first) push(kind, '\n');
    const k = (node.dataset.k as RpKind | undefined) ?? kind;
    [...node.childNodes].forEach((c, i) => walk(c, k, i === 0));
  };
  [...root.childNodes].forEach((c, i) => walk(c, 'plain', i === 0));
  // A trailing new line the browser keeps after the last <br> is not part of the message.
  const last = out[out.length - 1];
  if (last) last.text = last.text.replace(/\n$/, '');
  return out.filter(s => s.text);
}

/** Characters of text (a <br> counts one) before a point in the editor. */
function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  let n = 0, done = false;
  const walk = (cur: Node) => {
    if (done) return;
    if (cur === node && cur.nodeType !== Node.TEXT_NODE) { [...cur.childNodes].slice(0, offset).forEach(c => count(c)); done = true; return; }
    if (cur.nodeType === Node.TEXT_NODE) { if (cur === node) { n += (cur.textContent ?? '').slice(0, offset).replace(/​/g, '').length; done = true; return; } n += (cur.textContent ?? '').replace(/​/g, '').length; return; }
    if ((cur as HTMLElement).tagName === 'BR') { n += 1; return; }
    for (const c of [...cur.childNodes]) { walk(c); if (done) return; }
  };
  const count = (c: Node) => { if (c.nodeType === Node.TEXT_NODE) n += (c.textContent ?? '').replace(/​/g, '').length; else if ((c as HTMLElement).tagName === 'BR') n += 1; else c.childNodes.forEach(count); };
  walk(root);
  return n;
}
function placeCaret(root: HTMLElement, target: number) {
  let left = target;
  const range = document.createRange();
  const walk = (cur: Node): boolean => {
    if (cur.nodeType === Node.TEXT_NODE) { const len = (cur.textContent ?? '').length; if (left <= len) { range.setStart(cur, left); return true; } left -= len; return false; }
    if ((cur as HTMLElement).tagName === 'BR') { if (left === 0) { range.setStartBefore(cur); return true; } left -= 1; return false; }
    for (const c of [...cur.childNodes]) if (walk(c)) return true;
    return false;
  };
  if (!walk(root)) { range.selectNodeContents(root); range.collapse(false); } else range.collapse(true);
  const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
}

export function RpEditor({ value, onChange, onSubmit, placeholder, autoFocus = false, className, label = 'Message' }: {
  value: string; onChange: (v: string) => void; onSubmit?: () => void; placeholder?: string; autoFocus?: boolean; className?: string; label?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const last = useRef<string | null>(null);
  const [active, setActive] = useState<RpKind>('plain');
  // Draw the value when it changed from outside (a send cleared it, Impersonate filled it); typing keeps the DOM as it is.
  useLayoutEffect(() => { const el = root.current; if (!el || value === last.current) return; render(el, value); last.current = value; }, [value]);
  useEffect(() => { if (autoFocus && root.current) { root.current.focus(); placeCaret(root.current, Number.MAX_SAFE_INTEGER); } }, [autoFocus]);
  useEffect(() => {
    const onSel = () => {
      const el = root.current, sel = window.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      const host = (sel.anchorNode.nodeType === Node.TEXT_NODE ? sel.anchorNode.parentElement : sel.anchorNode as HTMLElement)?.closest<HTMLElement>('[data-k]');
      setActive(host && el.contains(host) ? (host.dataset.k as RpKind) : 'plain');
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);
  const emit = () => {
    const el = root.current; if (!el) return;
    // The browser may carry formatting of its own into new text (<font>, <i>, a <div> per line): redraw from the text, caret kept.
    if (el.querySelector('font, i, b, em, strong, u, div, p, span:not([data-k])')) {
      const sel = window.getSelection();
      const at = sel?.anchorNode && el.contains(sel.anchorNode) ? offsetOf(el, sel.anchorNode, sel.anchorOffset) : Number.MAX_SAFE_INTEGER;
      render(el, serializeRp(read(el)));
      placeCaret(el, at);
    }
    const v = serializeRp(read(el)); last.current = v; if (!v && el.childNodes.length && !el.textContent?.replace(/​/g, '')) el.replaceChildren(); onChange(v); };

  function apply(kind: RpKind) {
    const el = root.current, sel = window.getSelection();
    if (!el) return;
    el.focus();
    if (!sel || !sel.rangeCount || !el.contains(sel.anchorNode)) { placeCaret(el, Number.MAX_SAFE_INTEGER); }
    const range = window.getSelection()!.getRangeAt(0);
    if (range.collapsed) {
      // No selection: what is typed next has this style.
      const span = document.createElement('span');
      span.dataset.k = kind; if (kind !== 'plain') span.className = `rp-${kind}`;
      const t = document.createTextNode(ZW); span.append(t);
      range.insertNode(span);
      const r = document.createRange(); r.setStart(t, 1); r.collapse(true);
      const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r);
      setActive(kind);
      return;
    }
    // A selection: restyle exactly that text, then redraw so styles never nest, and keep the caret after it.
    const text = range.toString().replace(/​/g, '');
    range.deleteContents();
    const span = document.createElement('span');
    span.dataset.k = kind;
    text.split('\n').forEach((p, i) => { if (i) span.append(document.createElement('br')); if (p) span.append(document.createTextNode(p)); });
    range.insertNode(span);
    const end = offsetOf(el, span, span.childNodes.length);
    const v = serializeRp(read(el));
    render(el, v); last.current = v; onChange(v);
    placeCaret(el, end);
    setActive(kind);
  }

  return <div className={`rp-editor-box ${className ?? ''}`}>
    <div className="rp-format" role="toolbar" aria-label={tr('Text style')}>
      {RP_KINDS.map(k => <button key={k.kind} type="button" className={`rp-format__btn rp-format__btn--${k.kind}`} aria-pressed={active === k.kind} title={`${tr(k.hint)} (Alt+${k.key})`}
        onMouseDown={e => e.preventDefault()} onClick={() => apply(k.kind)}><span className={k.kind === 'plain' ? undefined : `rp-${k.kind}`}>{tr(k.label)}</span></button>)}
    </div>
    <div ref={root} className="rp-input" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label={tr(label)} data-placeholder={placeholder ?? ''}
      onInput={emit}
      onPaste={e => { e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain')); }}
      onKeyDown={e => {
        if (e.altKey && !e.ctrlKey && !e.metaKey) {
          const k = RP_KINDS.find(x => x.key === e.key.toUpperCase());
          if (k) { e.preventDefault(); e.stopPropagation(); apply(k.kind); return; }
        }
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (e.shiftKey || !onSubmit) { document.execCommand('insertLineBreak'); emit(); }
          else onSubmit();
        }
      }} />
  </div>;
}

/** A roleplay message on screen: paragraphs, with speech, actions and thoughts styled and their markers hidden. **bold** stays bold. */
export function RpText({ text }: { text: string }) {
  return <div className="rp-text">{text.split(/\n{2,}/).map((para, i) => <p key={i}>{parseRp(para).map((s, j) => {
    // Emphasis inside a styled run (*what* inside a quote) shows as emphasis, not as asterisks; **bold** in narration stays bold.
    const inner = s.kind === 'plain' ? s.text.split(/\*\*([^*]+)\*\*/g).map((t, n) => (n % 2 ? <strong key={n}>{t}</strong> : t)) : s.text.split(/\*{1,2}([^*]+)\*{1,2}/g).map((t, n) => (n % 2 ? <em key={n}>{t}</em> : t));
    return s.kind === 'plain' ? <span key={j}>{inner}</span> : <span key={j} className={`rp-${s.kind}`}>{inner}</span>;
  })}</p>)}</div>;
}
