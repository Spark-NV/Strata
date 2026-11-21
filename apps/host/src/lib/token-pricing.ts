/**
 * Token usage of the agent's model calls (server/token-usage.mjs) and what the same tokens would cost on a cloud model.
 *
 * The host sends sums per local day, hour and prompt size; this file filters them to a time range and prices them. Prices are US dollars
 * per million tokens. A cache miss is a prompt token the model had to read; providers that charge for writing the cache charge it on
 * these same tokens, so a preset's miss price is the cache-write price where there is one.
 */

export type UsageBucket = [calls: number, miss: number, hit: number, out: number];
export interface UsageSession {
  id: string;
  chatId: string | null;
  chatTitle: string;
  title: string;
  model: string;
  first: number | null;
  last: number | null;
  totals: { calls: number; miss: number; hit: number; out: number; compactions: number };
  /** 'YYYY-MM-DD|hour|tier': tier 0 = prompt up to 100K tokens, 1 = up to 200K, 2 = above 200K */
  buckets: Record<string, UsageBucket>;
}
export interface UsageSnapshot { at: number; sessions: UsageSession[] }

export type UsageRange = 'today' | 'week' | 'all';
export interface UsageCell { day: string; hour: number; tier: number; calls: number; miss: number; hit: number; out: number }
export interface UsageSum { calls: number; miss: number; hit: number; out: number }

export interface Rates { miss: number; hit: number; out: number }
export interface PricePreset {
  id: string;
  name: string;
  provider: string;
  rates: Rates;
  /** Higher rates for a call whose prompt is above this many tokens (100K or 200K). */
  long?: { above: 100_000 | 200_000; rates: Rates };
  /** Cheaper rates outside the peak hours, given as [from, to) UTC hour ranges on weekdays; weekends (UTC) are off-peak. */
  offPeak?: { peakUtc: [number, number][]; rates: Rates };
  note?: string;
}
export interface CustomPrice {
  name: string;
  rates: Rates;
  offPeak: boolean;
  /** Off-peak hours on this PC's clock: from `start` up to (not including) `end`; it may wrap past midnight. */
  start: number;
  end: number;
  offRates: Rates;
}

/** Public list prices, November 2026 (US dollars per million tokens). */
export const PRICE_PRESETS: PricePreset[] = [
  { id: 'kimi-k3.1-pro', name: 'Kimi K3.1 Pro', provider: 'Moonshot', rates: { miss: 2, hit: 0.2, out: 10 } },
  { id: 'glm-5.3', name: 'GLM-5.3', provider: 'Z.ai', rates: { miss: 1.4, hit: 0.26, out: 4.4 } },
  { id: 'qwen4-max', name: 'Qwen4-Max', provider: 'Alibaba Cloud', rates: { miss: 1.5, hit: 0.075, out: 4.5 }, note: 'International (Singapore) prices.' },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', provider: 'DeepSeek', rates: { miss: 0.3, hit: 0.006, out: 1.2 },
    offPeak: { peakUtc: [[1, 4], [6, 10]], rates: { miss: 0.15, hit: 0.003, out: 0.6 } },
    note: 'Half price off-peak: outside 01:00–04:00 and 06:00–10:00 UTC on weekdays, and all weekend.' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', provider: 'DeepSeek', rates: { miss: 1.32, hit: 0.044, out: 3.96 },
    offPeak: { peakUtc: [[1, 4], [6, 10]], rates: { miss: 0.66, hit: 0.022, out: 1.98 } },
    note: 'DeepSeek\'s larger model (V4.1 has only Flash). Half price off-peak, same hours as V4.1 Flash; the off-peak cache-hit price is assumed to halve too.' },
  { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', provider: 'MiniMax', rates: { miss: 0.15, hit: 0.015, out: 0.6 } },
  { id: 'qwen3.6-35b-a3b', name: 'Qwen3.6 35B A3B', provider: 'OpenRouter', rates: { miss: 0.1, hit: 0.05, out: 0.95 }, note: 'Prices differ between OpenRouter providers.' },
];

export const DEFAULT_CUSTOM: CustomPrice = { name: 'Custom', rates: { miss: 1, hit: 0.1, out: 4 }, offPeak: false, start: 0, end: 8, offRates: { miss: 0.5, hit: 0.05, out: 2 } };

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The cells of the chosen sessions (all when `sessionId` is 'all') inside the range. */
export function usageCells(snapshot: UsageSnapshot | null, sessionId: string, range: UsageRange, now = new Date()): UsageCell[] {
  if (!snapshot) return [];
  const from = range === 'today' ? dayKey(now) : range === 'week' ? dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6)) : '';
  const out: UsageCell[] = [];
  for (const s of snapshot.sessions) {
    if (sessionId !== 'all' && s.id !== sessionId) continue;
    for (const [key, b] of Object.entries(s.buckets)) {
      const [day, hour, tier] = key.split('|');
      if (from && day < from) continue;
      out.push({ day, hour: Number(hour), tier: Number(tier), calls: b[0], miss: b[1], hit: b[2], out: b[3] });
    }
  }
  return out;
}

export const sumCells = (cells: UsageCell[]): UsageSum => cells.reduce((t, c) => ({ calls: t.calls + c.calls, miss: t.miss + c.miss, hit: t.hit + c.hit, out: t.out + c.out }), { calls: 0, miss: 0, hit: 0, out: 0 });

/** Tokens per hour of the day (0–23), summed over the days in range. */
export function byHour(cells: UsageCell[]): UsageSum[] {
  const hours = Array.from({ length: 24 }, () => ({ calls: 0, miss: 0, hit: 0, out: 0 }));
  for (const c of cells) { const h = hours[c.hour]; if (!h) continue; h.calls += c.calls; h.miss += c.miss; h.hit += c.hit; h.out += c.out; }
  return hours;
}

export const inWindow = (hour: number, start: number, end: number) => (start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end);

export interface Cost { miss: number; hit: number; out: number; total: number }
const add = (c: Cost, cell: UsageCell, r: Rates) => {
  const miss = cell.miss / 1e6 * r.miss, hit = cell.hit / 1e6 * r.hit, out = cell.out / 1e6 * r.out;
  c.miss += miss; c.hit += hit; c.out += out; c.total += miss + hit + out;
};

/** Whether a cell (a local day and hour) falls in a preset's peak hours, which are given in UTC. */
export function isPeak(cell: Pick<UsageCell, 'day' | 'hour'>, peakUtc: [number, number][]) {
  const [y, m, d] = cell.day.split('-').map(Number);
  const t = new Date(y, m - 1, d, cell.hour, 30);
  const day = t.getUTCDay(), h = t.getUTCHours();
  if (day === 0 || day === 6) return false;
  return peakUtc.some(([from, to]) => h >= from && h < to);
}

export function presetCost(cells: UsageCell[], p: PricePreset): Cost {
  const c: Cost = { miss: 0, hit: 0, out: 0, total: 0 };
  for (const cell of cells) {
    const r = p.long && (p.long.above === 100_000 ? cell.tier >= 1 : cell.tier >= 2) ? p.long.rates : p.offPeak && !isPeak(cell, p.offPeak.peakUtc) ? p.offPeak.rates : p.rates;
    add(c, cell, r);
  }
  return c;
}

export function customCost(cells: UsageCell[], p: CustomPrice): Cost {
  const c: Cost = { miss: 0, hit: 0, out: 0, total: 0 };
  for (const cell of cells) add(c, cell, p.offPeak && inWindow(cell.hour, p.start, p.end) ? p.offRates : p.rates);
  return c;
}

const rate = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) < 10_000 ? Number(v) : fallback);
const hour = (v: unknown, fallback: number) => (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 23 ? Number(v) : fallback);
const rates = (v: any, d: Rates): Rates => ({ miss: rate(v?.miss, d.miss), hit: rate(v?.hit, d.hit), out: rate(v?.out, d.out) });
/** A saved custom price, checked field by field so a damaged one falls back to the defaults. */
export function readCustom(raw: unknown): CustomPrice {
  const v = raw && typeof raw === 'object' ? raw as any : {};
  return {
    name: typeof v.name === 'string' && v.name.trim() ? v.name.slice(0, 60) : DEFAULT_CUSTOM.name,
    rates: rates(v.rates, DEFAULT_CUSTOM.rates),
    offPeak: v.offPeak === true,
    start: hour(v.start, DEFAULT_CUSTOM.start),
    end: hour(v.end, DEFAULT_CUSTOM.end),
    offRates: rates(v.offRates, DEFAULT_CUSTOM.offRates),
  };
}
