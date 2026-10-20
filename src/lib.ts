// Core logic: prompt generation, LLM calls (BYOK / backend), mention scoring, storage.
export type Entity = { name: string; aliases: string[] };
export type Provider = 'gemini' | 'openai';
export type Mode = 'direct' | 'backend' | 'manual';
export type Mention = { name: string; offset: number; rank: number };
export type PromptResult = { prompt: string; answer: string; mentions: Mention[]; domains: string[]; error?: string; ms?: number };
export type Audit = {
  id: string; createdAt: string; category: string; market: string;
  brand: Entity; competitors: Entity[]; mode: Mode; provider: Provider; model: string;
  results: PromptResult[];
};
export type Settings = { provider: Provider; model: string; key: string; mode: Mode; backendUrl: string };

export const DEFAULT_MODELS: Record<Provider, string> = { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini' };

export function parseEntity(raw: string): Entity {
  // "Mamaearth | mama earth, mamaearth.in"
  const [name, rest = ''] = raw.split('|');
  return { name: name.trim(), aliases: rest.split(',').map(s => s.trim()).filter(Boolean) };
}

export function buyerPrompts(category: string, market: string): string[] {
  const c = category.trim(), m = market.trim();
  const inM = m ? ` in ${m}` : '';
  return [
    `What is the best ${c}${inM} right now?`,
    `Which ${c} brands would you recommend for a first-time buyer${inM}?`,
    `Top 5 ${c} brands${inM} ranked by quality and value`,
    `I have a tight budget. Which ${c} gives the most value for money${inM}?`,
    `Which ${c} brands are most trusted and have genuine reviews${inM}?`,
    `Best premium ${c}${inM} worth paying extra for`,
    `Which ${c} brand should I avoid, and what should I buy instead?`,
    `Recommend a ${c} I can order online with fast delivery${inM}`,
  ];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function firstIndex(text: string, e: Entity): number {
  let best = -1;
  for (const term of [e.name, ...e.aliases]) {
    if (!term) continue;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${esc(term)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    const m = re.exec(text);
    if (m) { const i = m.index + m[1].length; if (best < 0 || i < best) best = i; }
  }
  return best;
}

export function detect(answer: string, entities: Entity[]): Mention[] {
  const hits = entities.map(e => ({ name: e.name, offset: firstIndex(answer, e) })).filter(h => h.offset >= 0);
  hits.sort((a, b) => a.offset - b.offset);
  return hits.map((h, i) => ({ ...h, rank: i + 1 }));
}

export function domains(answer: string): string[] {
  const set = new Set<string>();
  for (const m of answer.matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|co|org|net|io|shop|store))\b/gi)) set.add(m[1].toLowerCase());
  return [...set];
}

export function analyse(prompt: string, answer: string, entities: Entity[]): PromptResult {
  return { prompt, answer, mentions: detect(answer, entities), domains: domains(answer) };
}

export type Score = { name: string; isBrand: boolean; inclusion: number; firstPick: number; avgRank: number | null; share: number; count: number };
export function score(a: Audit): { rows: Score[]; answered: number } {
  const ok = a.results.filter(r => !r.error && r.answer);
  const all = [a.brand, ...a.competitors];
  const totalMentions = ok.reduce((s, r) => s + r.mentions.length, 0) || 1;
  const rows = all.map((e, i) => {
    const ms = ok.map(r => r.mentions.find(m => m.name === e.name)).filter(Boolean) as Mention[];
    return {
      name: e.name, isBrand: i === 0, count: ms.length,
      inclusion: ok.length ? ms.length / ok.length : 0,
      firstPick: ok.length ? ms.filter(m => m.rank === 1).length / ok.length : 0,
      avgRank: ms.length ? ms.reduce((s, m) => s + m.rank, 0) / ms.length : null,
      share: ms.length / totalMentions,
    };
  });
  rows.sort((x, y) => y.inclusion - x.inclusion || (x.avgRank ?? 99) - (y.avgRank ?? 99));
  return { rows, answered: ok.length };
}

// Visibility index 0–100: 60% inclusion, 25% first-pick, 15% share of voice.
export const visIndex = (s: Score) => Math.round(100 * (0.6 * s.inclusion + 0.25 * s.firstPick + 0.15 * s.share));

export function gaps(a: Audit) {
  return a.results.filter(r => !r.error && r.answer && !r.mentions.some(m => m.name === a.brand.name))
    .map(r => ({ prompt: r.prompt, winners: r.mentions.map(m => m.name) }));
}

const SYSTEM = 'You are a helpful shopping assistant. Answer the buyer\'s question naturally, naming specific brands or products where relevant.';

export async function askLLM(s: Settings, prompt: string, signal?: AbortSignal): Promise<string> {
  if (s.mode === 'backend') {
    const r = await fetch(`${s.backendUrl.replace(/\/$/, '')}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, provider: s.provider, model: s.model }), signal });
    if (!r.ok) throw new Error(`Backend ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()).answer;
  }
  if (!s.key) throw new Error('No API key set');
  if (s.provider === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`, {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `Gemini HTTP ${r.status}`);
    return (j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  }
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.key}` },
    body: JSON.stringify({ model: s.model, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt }] }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `OpenAI HTTP ${r.status}`);
  return j.choices?.[0]?.message?.content ?? '';
}

export async function suggestPrompts(s: Settings, category: string, market: string): Promise<string[]> {
  const txt = await askLLM(s, `List 8 realistic questions a shopper${market ? ' in ' + market : ''} would type into an AI assistant before buying ${category}. Do not mention any brand names. One question per line, no numbering.`);
  return txt.split('\n').map(l => l.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(l => l.length > 8).slice(0, 10);
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>, onDone: (r: R, i: number) => void) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; onDone(await fn(items[i], i), i); }
  }));
}

// storage
const K = { settings: 'shelfsight.settings', audits: 'shelfsight.audits' };
export function loadSettings(): Settings {
  try { return { provider: 'gemini', model: DEFAULT_MODELS.gemini, key: '', mode: 'direct', backendUrl: 'http://localhost:8000', ...JSON.parse(localStorage.getItem(K.settings) || '{}') }; }
  catch { return { provider: 'gemini', model: DEFAULT_MODELS.gemini, key: '', mode: 'direct', backendUrl: 'http://localhost:8000' }; }
}
export const saveSettings = (s: Settings) => localStorage.setItem(K.settings, JSON.stringify(s));
export function loadAudits(): Audit[] { try { return JSON.parse(localStorage.getItem(K.audits) || '[]'); } catch { return []; } }
export function saveAudit(a: Audit) { const all = loadAudits().filter(x => x.id !== a.id); all.unshift(a); localStorage.setItem(K.audits, JSON.stringify(all.slice(0, 50))); }
export function deleteAudit(id: string) { localStorage.setItem(K.audits, JSON.stringify(loadAudits().filter(x => x.id !== id))); }

export function toCSV(a: Audit): string {
  const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const names = [a.brand, ...a.competitors].map(e => e.name);
  const head = ['prompt', ...names.map(n => `${n} rank`), 'domains', 'error'];
  const lines = a.results.map(r => [q(r.prompt), ...names.map(n => String(r.mentions.find(m => m.name === n)?.rank ?? '')), q(r.domains.join(' ')), q(r.error ?? '')].join(','));
  return [head.map(q).join(','), ...lines].join('\n');
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
