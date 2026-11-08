import { useEffect, useState } from 'react';
import { tr } from '../lib/i18n';
import { api } from '../lib/client';
import { useStore } from '../lib/store';

/** How long the pinned model ran and was stopped (server/model-release.mjs, GET /api/pinned/activity). */
interface Totals { running: number; idle: number; game: number; image: number; other: number }
export interface ModelActivity {
    current: { up: boolean; since: number; reason: 'idle' | 'game' | 'image' | 'other' | null; detail: string | null } | null;
    working: boolean;
    idleMs: number | null;
    idleLimitMs: number;
    today: Totals;
    week: Totals;
}

/** A length of time in words: "45 s", "12 min", "2 h 14 min", "3 d 4 h". */
export function span(ms: number): string {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const PARTS: { key: keyof Totals; label: string }[] = [
    { key: 'running', label: 'Running' },
    { key: 'idle', label: 'Stopped, idle' },
    { key: 'game', label: 'Stopped for games' },
    { key: 'image', label: 'Stopped for images' },
    { key: 'other', label: 'Stopped, other' },
];

function TimeBar({ title, totals }: { title: string; totals: Totals }) {
    const all = PARTS.reduce((n, p) => n + totals[p.key], 0);
    return <div className="model-time__period">
        <div className="model-time__period-head"><span>{tr(title)}</span><span className="muted num">{tr(all ? span(all) : '—')}</span></div>
        <div className="model-time__bar" role="img" aria-label={tr('{0}: {1}', [tr(title), PARTS.filter(p => totals[p.key]).map(p => `${tr(p.label)} ${span(totals[p.key])}`).join(', ') || tr('nothing recorded yet')])}>
            {all ? PARTS.map(p => totals[p.key] ? <span key={p.key} data-part={p.key} style={{ width: `${totals[p.key] / all * 100}%` }}/> : null) : null}
        </div>
        <dl className="model-time__legend">{PARTS.map(p => <div key={p.key} data-part={p.key}><dt>{tr(p.label)}</dt><dd className="num">{tr(totals[p.key] ? span(totals[p.key]) : '—')}</dd></div>)}</dl>
    </div>;
}

/** The pinned model's running and stopped time on the Monitor: now (with idle time), today and the last 7 days. */
export function ModelTime() {
    const enabled = useStore(s => !!s.pinned?.enabled);
    const [data, setData] = useState<(ModelActivity & { readAt: number }) | null>(null);
    const [, setTick] = useState(0);
    useEffect(() => {
        if (!enabled) { setData(null); return; }
        let live = true;
        const read = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            void api.get<ModelActivity>('/api/pinned/activity').then(d => { if (live) setData({ ...d, readAt: Date.now() }); }, () => { if (live) setData(null); }); };
        read();
        const timer = setInterval(read, 5000);
        // The "for 12 s" counters move every second between reads.
        const clock = setInterval(() => setTick(n => n + 1), 1000);
        return () => { live = false; clearInterval(timer); clearInterval(clock); };
    }, [enabled]);
    if (!enabled || !data) return null;
    const cur = data.current, since = cur ? Date.now() - cur.since : null;
    // The totals and the idle time move with the clock between reads, in the bucket of the state now.
    const gone = Math.max(0, Date.now() - data.readAt), bucket: keyof Totals | null = !cur ? null : cur.up ? 'running' : cur.reason ?? 'other';
    const grow = (t: Totals): Totals => bucket ? { ...t, [bucket]: (t[bucket] ?? 0) + gone } : t;
    const idleMs = data.idleMs !== null ? data.idleMs + gone : null;
    const stoppedWhy = cur?.reason === 'image' ? (cur.detail ? tr('For images: {0}', [cur.detail]) : tr('For images')) : cur?.reason === 'game' ? (cur.detail ? tr('For a game: {0}', [cur.detail]) : tr('For a game')) : cur?.reason === 'idle' ? tr('After {0} idle', [cur.detail ?? span(data.idleLimitMs)]) : tr('Outside the app, or while it was closed');
    const head = !cur ? tr('Nothing recorded yet') : cur.up ? tr('Running for {0}', [span(since ?? 0)]) : tr('Stopped for {0}', [span(since ?? 0)]);
    const detail = !cur ? '' : !cur.up ? stoppedWhy : data.working ? tr('Working now') : idleMs !== null ? data.idleLimitMs ? tr('Idle for {0} · stops after {1}', [span(idleMs), span(data.idleLimitMs)]) : tr('Idle for {0}', [span(idleMs)]) : '';
    const idlePct = cur?.up && idleMs !== null && data.idleLimitMs ? Math.min(100, idleMs / data.idleLimitMs * 100) : null;
    return <section className="st-card model-time" aria-label={tr('Model time')}>
        <div className="section-toolbar"><h2 className="h4">{tr('Model time')}</h2><span className="st-badge" data-state={cur?.up ? 'running' : 'stopped'}>{tr(cur?.up ? 'Running' : 'Stopped')}</span></div>
        <div className="monitor-bar-reading"><span>{head}</span><span className="muted num">{detail}</span></div>
        {idlePct !== null ? <div className="model-time__idle" role="progressbar" aria-label={tr('Idle time before the model stops')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(idlePct)}><span style={{ width: `${idlePct}%` }}/></div> : null}
        <div className="model-time__periods">
            <TimeBar title="Today" totals={grow(data.today)}/>
            <TimeBar title="Last 7 days" totals={grow(data.week)}/>
        </div>
    </section>;
}
