#!/usr/bin/env python3
"""
Shows what a Vibe Head said to its helpers and what they did, as one HTML page.

It only reads the Harness's saved sessions (~/.strata/data/agent/home/sessions/<folder>/<id>/session.v4.jsonl.zstd).
Nothing in the app or the running chat is changed, so it is safe while a project is being built.

  python3 tools/vibe_conversations.py ~/Videos/test            # writes ~/Videos/test-conversations.html... see --out
  python3 tools/vibe_conversations.py ~/Videos/test --watch 30 # rewrite every 30 s; the page reloads itself
"""
import argparse, html, json, os, subprocess, sys, time
from datetime import datetime
from pathlib import Path

SESSIONS = Path.home() / '.strata/data/agent/home/sessions'


def folder_key(root):
    return '--' + str(Path(root).expanduser().resolve()).strip('/').replace('/', '-') + '--'


def records(path):
    # A session that is still running has an unfinished last frame: keep what decodes, drop the rest.
    out = subprocess.run(['zstd', '-dc', str(path)], capture_output=True).stdout.decode('utf-8', 'replace')
    rows = []
    for line in out.splitlines():
        try: rows.append(json.loads(line))
        except ValueError: pass
    return rows


def load(root):
    base = SESSIONS / folder_key(root)
    if not base.is_dir(): sys.exit(f'No saved conversations for {root} (looked in {base}).')
    sessions = {}
    for f in base.glob('*/session.v4.jsonl.zstd'):
        rows = records(f)
        head = next((r for r in rows if r.get('type') == 'session'), None)
        if not head: continue
        desc = next((r['data'] for r in rows if r.get('type') == 'subagent/descriptor'), {})
        sessions[head['id']] = {'id': head['id'], 'parent': head.get('parentSession'), 'depth': head.get('delegationDepth', 0),
                                'created': head.get('createdAt', 0), 'label': desc.get('label'), 'rows': rows,
                                'updated': max((r.get('time', 0) for r in rows), default=head.get('createdAt', 0))}
    return sessions


def when(ms):
    return datetime.fromtimestamp(ms / 1000).strftime('%H:%M:%S') if ms else ''


def esc(text, limit=None):
    text = str(text or '')
    if limit and len(text) > limit: text = text[:limit] + f'\n… ({len(text) - limit} more characters)'
    return html.escape(text)


def texts(content):
    return '\n'.join(p.get('text', '') for p in content or [] if isinstance(p, dict) and p.get('type') == 'text')


def args_of(raw):
    try: a = json.loads(raw) if isinstance(raw, str) else (raw or {})
    except ValueError: return {'arguments': raw}
    return a if isinstance(a, dict) else {'arguments': a}


def tool_line(name, a):
    if name == 'bash': return a.get('description') or a.get('command', '')
    for k in ('path', 'file_path', 'pattern', 'query', 'url'):
        if a.get(k): return f'{a[k]}'
    return ''


def render_session(s, children, long):
    """One conversation as a list of turns. Calls to subagent link to that helper's section."""
    out, results = [], {}
    for r in s['rows']:
        if r.get('type') == 'tool/result':
            m = r['data'].get('message', {})
            results[m.get('toolCallId')] = texts(m.get('content'))
    spawned = iter(sorted(children, key=lambda c: c['created']))
    seen = set()

    def incoming(text, at):
        # The Harness records a message both when it is queued and when it is delivered: show it once.
        if not text.strip() or text.lstrip().startswith('<project_book>') or text in seen: return
        seen.add(text)
        if 'background subagent' in text.lower(): who = 'Report from a helper'
        elif s['parent']: who = 'From the Head'
        else: who = 'From you (or the app)'
        out.append(f'<div class="msg in"><div class="who">{who} · {at}</div><pre>{esc(text, long)}</pre></div>')

    for r in s['rows']:
        t, d, at = r.get('type'), r.get('data') or {}, when(r.get('time'))
        if t == 'user/message':
            incoming(texts(d.get('content')), at)
        elif t == 'agent/inbox/spliced':
            for item in d.get('inserted') or []:
                incoming(texts(item.get('content')), at)
        elif t == 'assistant/message':
            for p in (d.get('message') or {}).get('content') or []:
                kind = p.get('type')
                if kind == 'reasoning' and p.get('text', '').strip():
                    out.append(f'<details class="think"><summary>Thinking · {at}</summary><pre>{esc(p["text"], long)}</pre></details>')
                elif kind == 'text' and p.get('text', '').strip():
                    out.append(f'<div class="msg out"><div class="who">Says · {at}</div><pre>{esc(p["text"], long)}</pre></div>')
                elif kind == 'tool-call':
                    name, a = p.get('name', ''), args_of(p.get('arguments'))
                    res = results.get(p.get('id'), '')
                    if name in ('subagent', 'subagent_fork'):
                        child = next(spawned, None)
                        link = f' → <a href="#{child["id"]}">{esc(child["label"] or "helper")}</a>' if child else ''
                        prompt = a.get('prompt') or a.get('description') or ''
                        out.append(f'<div class="msg delegate"><div class="who">Hands work to a helper{link} · {at}</div><pre>{esc(prompt, long)}</pre></div>')
                    else:
                        detail = json.dumps(a, indent=1, ensure_ascii=False)
                        out.append(f'<details class="tool"><summary><b>{esc(name)}</b> {esc(tool_line(name, a), 160)}</summary>'
                                   f'<pre class="args">{esc(detail, long)}</pre><pre>{esc(res, long)}</pre></details>')
    return '\n'.join(out)


def page(root, sessions, refresh, long):
    by_parent = {}
    for s in sessions.values(): by_parent.setdefault(s['parent'], []).append(s)
    heads = sorted((s for s in sessions.values() if not s['parent']), key=lambda s: s['created'])
    nav, body = [], []

    def add(s, level):
        kids = by_parent.get(s['id'], [])
        name = 'Head' if level == 0 else (s['label'] or 'Helper')
        live = time.time() * 1000 - s['updated'] < 120_000
        nav.append(f'<a class="l{level}" href="#{s["id"]}">{"● " if live else ""}{esc(name)} <span>{when(s["created"])}</span></a>')
        body.append(f'<section id="{s["id"]}" class="l{level}"><h2>{esc(name)} <span>started {when(s["created"])}, last activity {when(s["updated"])}'
                    f'{" · working now" if live else ""}</span></h2>{render_session(s, kids, long)}</section>')
        for k in sorted(kids, key=lambda c: c['created']): add(k, level + 1)

    for h in heads: add(h, 0)
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ''
    return f'''<!doctype html><html><head><meta charset="utf-8">{meta}<title>Vibe conversations</title><style>
:root{{--bg:#fff;--fg:#1d1d1f;--muted:#6e6e73;--line:#e3e3e8;--in:#f3f6ff;--out:#f5f5f7;--del:#fff6e8;--think:#fafafa}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151517;--fg:#e8e8ea;--muted:#9a9aa0;--line:#2c2c30;--in:#1b2233;--out:#1e1e21;--del:#2e2516;--think:#19191b}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;display:flex}}
nav{{position:sticky;top:0;height:100vh;overflow:auto;width:260px;flex:none;border-right:1px solid var(--line);padding:12px}}
nav a{{display:block;color:inherit;text-decoration:none;padding:3px 6px;border-radius:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
nav a:hover{{background:var(--out)}} nav a span,h2 span{{color:var(--muted);font-size:12px;font-weight:400}}
nav .l1{{padding-left:18px}} nav .l2{{padding-left:30px}} main{{flex:1;min-width:0;padding:0 20px 40px}}
section{{border-bottom:1px solid var(--line);padding:8px 0 20px}} h1{{font-size:18px}} h2{{font-size:16px;position:sticky;top:0;background:var(--bg);padding:8px 0;margin:0}}
pre{{white-space:pre-wrap;word-break:break-word;margin:4px 0;font:12.5px/1.45 ui-monospace,monospace}}
.msg{{border-radius:8px;padding:8px 10px;margin:8px 0}} .in{{background:var(--in)}} .out{{background:var(--out)}} .delegate{{background:var(--del)}}
.who{{font-size:12px;color:var(--muted)}} details{{margin:3px 0;border-left:3px solid var(--line);padding-left:8px}}
summary{{cursor:pointer;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}} .tool summary b{{color:var(--fg)}}
.think{{background:var(--think)}} .args{{color:var(--muted)}} a{{color:#3b82f6}}
@media (max-width:700px){{nav{{display:none}}}}
</style></head><body><nav><b>{esc(Path(root).name)}</b>{''.join(nav)}</nav><main>
<h1>Head and helpers in {esc(root)}</h1><p class="who">Made {datetime.now():%Y-%m-%d %H:%M:%S}{f", reloads every {refresh} s" if refresh else ""}. Read from the saved sessions; nothing was changed.
Click a tool line or “Thinking” to open it.</p>{''.join(body)}</main></body></html>'''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('folder', help='the Vibe project folder')
    ap.add_argument('--out', help='where to write the page (default: the scratch file next to nothing in the project: ~/.strata/vibe-conversations/<name>.html)')
    ap.add_argument('--watch', type=int, default=0, metavar='SECONDS', help='rewrite the page every SECONDS until stopped')
    ap.add_argument('--long', type=int, default=6000, help='cut texts longer than this many characters (0 keeps everything)')
    a = ap.parse_args()
    root = str(Path(a.folder).expanduser().resolve())
    out = Path(a.out).expanduser() if a.out else Path.home() / '.strata/vibe-conversations' / f'{Path(root).name}.html'
    out.parent.mkdir(parents=True, exist_ok=True)
    while True:
        sessions = load(root)
        out.write_text(page(root, sessions, a.watch, a.long or None), encoding='utf-8')
        helpers = sum(1 for s in sessions.values() if s['parent'])
        print(f'{datetime.now():%H:%M:%S} wrote {out} ({helpers} helper conversations)', flush=True)
        if not a.watch: break
        time.sleep(a.watch)


if __name__ == '__main__':
    main()
