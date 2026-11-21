/**
 * The Monitor's token usage card: what the agent's model calls read and wrote (cache hits, cache misses, output), from the Harness's own
 * logs (server/token-usage.mjs), and what the same tokens would cost on popular cloud models or at prices the person types in.
 */
import { useEffect, useMemo, useState } from 'react';
import { localeTag, tr } from '../lib/i18n';
import { api } from '../lib/client';
import { tokens } from '../lib/format';
import { Select, Seg } from './ui';
import {
  PRICE_PRESETS, DEFAULT_CUSTOM, byHour, customCost, presetCost, readCustom, sumCells, usageCells,
  type CustomPrice, type Rates, type UsageRange, type UsageSnapshot,
} from '../lib/token-pricing';

const PREFS = 'strata.tokenUsage.v1';
interface Saved { session: string; range: UsageRange; costs: boolean; custom: CustomPrice }
function loadSaved(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS) ?? 'null');
    return { session: typeof v?.session === 'string' ? v.session : 'latest', range: ['today', 'week', 'all'].includes(v?.range) ? v.range : 'all', costs: v?.costs === true, custom: readCustom(v?.custom) };
  } catch { return { session: 'latest', range: 'all', costs: false, custom: DEFAULT_CUSTOM }; }
}

const usd = (n: number) => n.toLocaleString(localeTag(), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 0.01 ? 4 : 2 });
const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const shortDate = (t: number | null) => (t ? new Date(t).toLocaleString(localeTag(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

function RateInput({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => { const n = Number(text.replace(',', '.')); if (Number.isFinite(n) && n >= 0 && n < 10_000) onChange(n); else setText(String(value)); };
  return <label className="token-usage__rate"><span className="xs muted">{label}</span><span className="token-usage__rate-box"><span className="xs muted">$</span><input className="st-input" inputMode="decimal" size={7} aria-label={label} value={text} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit(); }}/></span></label>;
}

function RatesRow({ rates, onChange }: { rates: Rates; onChange: (r: Rates) => void }) {
  return <div className="token-usage__rates">
    <RateInput label={tr("Cache miss / 1M")} value={rates.miss} onChange={miss => onChange({ ...rates, miss })}/>
    <RateInput label={tr("Cache hit / 1M")} value={rates.hit} onChange={hit => onChange({ ...rates, hit })}/>
    <RateInput label={tr("Output / 1M")} value={rates.out} onChange={out => onChange({ ...rates, out })}/>
  </div>;
}

const hours = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

export function TokenUsage() {
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState<Saved>(loadSaved);
  const update = (patch: Partial<Saved>) => setSaved(s => { const next = { ...s, ...patch }; try { localStorage.setItem(PREFS, JSON.stringify(next)); } catch { /* kept for this visit */ } return next; });

  useEffect(() => {
    let live = true;
    const read = () => { if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void api.get<UsageSnapshot>('/api/usage/tokens').then(d => { if (live) { setData(d); setError(''); } }, e => { if (live) setError(e instanceof Error ? e.message : String(e)); }); };
    read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  const sessions = data?.sessions ?? [];
  const sessionId = saved.session === 'latest' ? sessions[0]?.id ?? 'all' : saved.session === 'all' || sessions.some(s => s.id === saved.session) ? saved.session : sessions[0]?.id ?? 'all';
  const session = sessions.find(s => s.id === sessionId);
  const cells = useMemo(() => usageCells(data, sessionId, saved.range), [data, sessionId, saved.range]);
  const sum = sumCells(cells), input = sum.miss + sum.hit, all = input + sum.out;
  const hourly = byHour(cells), peak = Math.max(1, ...hourly.map(h => h.miss + h.hit + h.out));
  const costs = useMemo(() => saved.costs ? [...PRICE_PRESETS.map(p => ({ id: p.id, name: p.name, provider: p.provider, note: p.note, cost: presetCost(cells, p) })), { id: 'custom', name: saved.custom.name, provider: tr("Your prices"), note: saved.custom.offPeak ? tr("Off-peak prices from {0}:00 to {1}:00 on this PC's clock.", [String(saved.custom.start).padStart(2, '0'), String(saved.custom.end).padStart(2, '0')]) : undefined, cost: customCost(cells, saved.custom) }].sort((a, b) => b.cost.total - a.cost.total) : [], [saved.costs, saved.custom, cells]);
  const maxCost = Math.max(0.000001, ...costs.map(c => c.cost.total));
  const setCustom = (patch: Partial<CustomPrice>) => update({ custom: { ...saved.custom, ...patch } });

  const options = [
    { value: 'latest', label: tr("Latest chat") },
    { value: 'all', label: tr("All agent chats") },
    ...sessions.slice(0, 60).map(s => ({ value: s.id, label: `${(s.chatTitle || s.title || s.id).slice(0, 48)} · ${shortDate(s.last)}` })),
  ];
  const scopeLine = saved.session === 'all' ? tr("{0} agent sessions", [String(sessions.length)]) : session ? `${session.chatTitle || session.title}${session.model ? ` · ${session.model}` : ''}` : '';

  return <section className="st-card token-usage" aria-label={tr("Token usage")}>
    <div className="section-toolbar token-usage__head">
      <div><h2 className="h4">{tr("Token usage")}</h2><p className="xs muted token-usage__scope">{scopeLine}</p></div>
      <div className="token-usage__controls">
        <Select ariaLabel={tr("Token usage chat")} value={saved.session === 'latest' || saved.session === 'all' ? saved.session : sessionId} options={options} translateLabels={false} menuMinWidth={360} onChange={v => update({ session: v })}/>
        <Seg ariaLabel={tr("Token usage range")} value={saved.range} options={[{ value: 'today', label: tr("Today") }, { value: 'week', label: tr("7 days") }, { value: 'all', label: tr("All time") }]} onChange={v => update({ range: v })}/>
      </div>
    </div>
    {error && !data ? <p className="small inline-error">{tr("Token usage could not be read ({0}). The host reads it after Strata restarts with this update.", [error])}</p> : !data ? <p className="small muted">{tr("Reading the agent's logs…")}</p> : !sum.calls ? <p className="small muted">{tr("No agent model calls in this range.")}</p> : <>
      <dl className="token-usage__facts">
        <div><dt>{tr("Model calls")}</dt><dd className="num">{sum.calls.toLocaleString(localeTag())}</dd></div>
        <div><dt>{tr("Input")}</dt><dd className="num">{tokens(input)}</dd></div>
        <div data-tone="hit"><dt>{tr("Cache hits")}</dt><dd className="num">{tokens(sum.hit)} <span className="xs muted">{pct(sum.hit, input).toFixed(1)}%</span></dd></div>
        <div data-tone="miss"><dt>{tr("Cache misses")}</dt><dd className="num">{tokens(sum.miss)} <span className="xs muted">{pct(sum.miss, input).toFixed(1)}%</span></dd></div>
        <div data-tone="out"><dt>{tr("Output")}</dt><dd className="num">{tokens(sum.out)}</dd></div>
        <div><dt>{tr("Average prompt")}</dt><dd className="num">{tokens(Math.round(input / sum.calls))}</dd></div>
      </dl>
      <div className="token-usage__stack" role="img" aria-label={tr("Cache hits {0}%, cache misses {1}%, output {2}% of all tokens", [pct(sum.hit, all).toFixed(1), pct(sum.miss, all).toFixed(1), pct(sum.out, all).toFixed(1)])}>
        <span data-tone="hit" style={{ width: `${pct(sum.hit, all)}%` }}/>
        <span data-tone="miss" style={{ width: `${pct(sum.miss, all)}%` }}/>
        <span data-tone="out" style={{ width: `${pct(sum.out, all)}%` }}/>
      </div>
      <div className="token-usage__legend xs muted"><span data-tone="hit">{tr("Cache hit: prompt reused")}</span><span data-tone="miss">{tr("Cache miss: prompt read fresh")}</span><span data-tone="out">{tr("Output: thinking and answer")}</span></div>
      <div className="token-usage__hours" aria-label={tr("Tokens by hour of day")}>
        {hourly.map((h, i) => { const total = h.miss + h.hit + h.out; return <div key={i} className="token-usage__hour" title={`${String(i).padStart(2, '0')}:00 · ${tokens(total)} · ${h.calls} calls`}>
          <div className="token-usage__hour-bar" style={{ height: `${(total / peak) * 100}%` }} data-off={saved.costs && saved.custom.offPeak && (saved.custom.start < saved.custom.end ? i >= saved.custom.start && i < saved.custom.end : i >= saved.custom.start || i < saved.custom.end) ? 'true' : undefined}>
            <span data-tone="out" style={{ flexGrow: h.out }}/><span data-tone="miss" style={{ flexGrow: h.miss }}/><span data-tone="hit" style={{ flexGrow: h.hit }}/>
          </div>
          {i % 3 === 0 ? <span className="xs muted">{String(i).padStart(2, '0')}</span> : <span className="xs"> </span>}
        </div>; })}
      </div>
      <p className="xs muted">{tr("Tokens by hour of day, on this PC's clock. Counts come from the agent's own records of every model call.")}</p>

      <div className="token-usage__cost-toggle"><label className="row"><input type="checkbox" checked={saved.costs} onChange={e => update({ costs: e.target.checked })}/> <span className="small">{tr("Show what this would cost on a cloud model")}</span></label></div>
      {saved.costs ? <div className="token-usage__costs">
        <div className="st-tablewrap"><table className="st-table"><thead><tr><th>{tr("Model")}</th><th className="num">{tr("Cache misses")}</th><th className="num">{tr("Cache hits")}</th><th className="num">{tr("Output")}</th><th className="num">{tr("Total")}</th></tr></thead>
          <tbody>{costs.map(c => <tr key={c.id} data-custom={c.id === 'custom' ? 'true' : undefined}>
            <td><strong>{c.name}</strong> <span className="xs muted">{c.provider}</span>{c.note ? <small className="xs muted token-usage__note">{c.note}</small> : null}<div className="token-usage__cost-bar"><span style={{ width: `${(c.cost.total / maxCost) * 100}%` }}/></div></td>
            <td className="num">{usd(c.cost.miss)}</td><td className="num">{usd(c.cost.hit)}</td><td className="num">{usd(c.cost.out)}</td><td className="num"><strong>{usd(c.cost.total)}</strong></td>
          </tr>)}</tbody></table></div>
        <div className="token-usage__custom">
          <div className="row row--between"><h3 className="h5">{tr("Your own prices")}</h3><input className="st-input" aria-label={tr("Custom price name")} value={saved.custom.name} maxLength={60} onChange={e => setCustom({ name: e.target.value })}/></div>
          <p className="xs muted">{tr("US dollars per million tokens.")}</p>
          <RatesRow rates={saved.custom.rates} onChange={rates => setCustom({ rates })}/>
          <label className="row"><input type="checkbox" checked={saved.custom.offPeak} onChange={e => setCustom({ offPeak: e.target.checked })}/> <span className="small">{tr("Different prices off-peak")}</span></label>
          {saved.custom.offPeak ? <>
            <div className="token-usage__window"><span className="small">{tr("Off-peak from")}</span><Select ariaLabel={tr("Off-peak starts")} value={String(saved.custom.start)} options={hours} translateLabels={false} onChange={v => setCustom({ start: Number(v) })}/><span className="small">{tr("to")}</span><Select ariaLabel={tr("Off-peak ends")} value={String(saved.custom.end)} options={hours} translateLabels={false} onChange={v => setCustom({ end: Number(v) })}/></div>
            <RatesRow rates={saved.custom.offRates} onChange={offRates => setCustom({ offRates })}/>
          </> : null}
        </div>
        <p className="xs muted">{tr("List prices from November 2026, from the providers' published rates as reported by price trackers. A cloud model counts tokens its own way and may think longer or shorter, so treat this as a rough comparison.")}</p>
      </div> : null}
    </>}
  </section>;
}
