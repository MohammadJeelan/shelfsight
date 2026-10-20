import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Audit, type Settings, type PromptResult, DEFAULT_MODELS, analyse, askLLM, buyerPrompts, deleteAudit, gaps,
  loadAudits, loadSettings, parseEntity, pool, saveAudit, saveSettings, score, suggestPrompts, toCSV, uid, visIndex,
} from './lib';

function useHash() {
  const [h, setH] = useState(location.hash.slice(1) || '/');
  useEffect(() => { const f = () => setH(location.hash.slice(1) || '/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return h;
}
const go = (p: string) => { location.hash = p; };
const pct = (n: number) => `${Math.round(n * 100)}%`;

export default function App() {
  const route = useHash();
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showKey, setShowKey] = useState(false);
  const upd = (s: Settings) => { setSettings(s); saveSettings(s); };
  const ready = settings.mode !== 'direct' || !!settings.key;
  return (
    <div className="page">
      <header className="mast">
        <a className="wordmark" href="#/"><span className="shelf" aria-hidden>▤</span> Shelfsight</a>
        <nav>
          <a href="#/" className={route === '/' ? 'on' : ''}>New audit</a>
          <a href="#/history" className={route === '/history' ? 'on' : ''}>Ledger</a>
          <button className={`keychip ${ready ? 'ok' : ''}`} onClick={() => setShowKey(true)} data-testid="open-settings">
            {settings.mode === 'direct' ? (settings.key ? `● ${settings.provider} key set` : '○ add API key') : settings.mode === 'backend' ? '● FastAPI backend' : '● manual paste'}
          </button>
        </nav>
      </header>
      {showKey && <SettingsPanel s={settings} onSave={s => { upd(s); setShowKey(false); }} onClose={() => setShowKey(false)} />}
      <main>
        {route.startsWith('/audit/') ? <Report id={route.slice(7)} /> :
          route === '/history' ? <History /> :
            <NewAudit settings={settings} needKey={() => setShowKey(true)} />}
      </main>
      <footer className="foot">
        <span>Shelfsight measures how AI assistants recommend brands. Answers come from the model you choose; results vary run to run.</span>
        <span>Built by Mohammed Jeelan · <a href="https://github.com/MohammadJeelan">github.com/MohammadJeelan</a></span>
      </footer>
    </div>
  );
}

function SettingsPanel({ s, onSave, onClose }: { s: Settings; onSave: (s: Settings) => void; onClose: () => void }) {
  const [d, setD] = useState(s);
  return (
    <div className="scrim" onClick={onClose}>
      <form className="panel" onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); onSave(d); }}>
        <h2>Engine</h2>
        <div className="seg">
          {(['direct', 'backend', 'manual'] as const).map(m => (
            <label key={m} className={d.mode === m ? 'on' : ''}><input type="radio" name="mode" checked={d.mode === m} onChange={() => setD({ ...d, mode: m })} />
              {m === 'direct' ? 'Your key (browser)' : m === 'backend' ? 'FastAPI backend' : 'Paste answers'}</label>
          ))}
        </div>
        {d.mode !== 'manual' && <>
          <label className="fld">Provider
            <select value={d.provider} onChange={e => { const p = e.target.value as Settings['provider']; setD({ ...d, provider: p, model: DEFAULT_MODELS[p] }); }}>
              <option value="gemini">Google Gemini (free tier key)</option><option value="openai">OpenAI</option>
            </select></label>
          <label className="fld">Model<input value={d.model} onChange={e => setD({ ...d, model: e.target.value })} /></label>
        </>}
        {d.mode === 'direct' && <label className="fld">API key
          <input type="password" data-testid="api-key" value={d.key} placeholder={d.provider === 'gemini' ? 'AIza…' : 'sk-…'} onChange={e => setD({ ...d, key: e.target.value.trim() })} />
          <small>Stored only in this browser's localStorage and sent only to {d.provider === 'gemini' ? 'generativelanguage.googleapis.com' : 'api.openai.com'}. Get a free Gemini key at aistudio.google.com.</small></label>}
        {d.mode === 'backend' && <label className="fld">Backend URL<input value={d.backendUrl} onChange={e => setD({ ...d, backendUrl: e.target.value })} />
          <small>Run <code>docker compose up</code> in /backend. The key lives in the server's env, not the browser.</small></label>}
        {d.mode === 'manual' && <p className="note">No key? Ask ChatGPT / Perplexity each prompt yourself and paste the answers. Shelfsight scores them the same way.</p>}
        <div className="row"><button type="button" className="ghost" onClick={() => setD({ ...d, key: '' })}>Forget key</button><button className="ink" data-testid="save-settings">Save</button></div>
      </form>
    </div>
  );
}

function NewAudit({ settings, needKey }: { settings: Settings; needKey: () => void }) {
  const [category, setCategory] = useState('');
  const [market, setMarket] = useState('India');
  const [brand, setBrand] = useState('');
  const [comps, setComps] = useState('');
  const [prompts, setPrompts] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState<PromptResult[] | null>(null);
  const [manual, setManual] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);

  const validate = () => {
    if (category.trim().length < 3) return 'Tell us the category, e.g. "face wash for oily skin".';
    if (!brand.trim()) return 'Which brand are you auditing?';
    if (comps.split('\n').filter(l => l.trim()).length < 1) return 'Add at least one competitor so share of voice means something.';
    if (prompts.filter(p => p.trim()).length < 2) return 'Generate or write at least 2 buyer prompts.';
    if (settings.mode === 'direct' && !settings.key) return 'Add an API key (top right), or switch to manual paste.';
    return '';
  };
  const entities = () => ({ b: parseEntity(brand), c: comps.split('\n').filter(l => l.trim()).map(parseEntity) });

  async function suggest() {
    if (category.trim().length < 3) { setErr('Enter a category first.'); return; }
    setErr('');
    if (settings.mode === 'manual' || (settings.mode === 'direct' && !settings.key)) { setPrompts(buyerPrompts(category, market)); return; }
    setBusy('Asking the model for real buyer questions…');
    try { const p = await suggestPrompts(settings, category, market); setPrompts(p.length >= 3 ? p : buyerPrompts(category, market)); }
    catch (e) { setErr(`Couldn't get suggestions (${(e as Error).message}). Using built-in buyer prompts.`); setPrompts(buyerPrompts(category, market)); }
    finally { setBusy(''); }
  }

  function finish(results: PromptResult[]) {
    const { b, c } = entities();
    const a: Audit = { id: uid(), createdAt: new Date().toISOString(), category: category.trim(), market: market.trim(), brand: b, competitors: c, mode: settings.mode, provider: settings.provider, model: settings.mode === 'manual' ? 'manual' : settings.model, results };
    saveAudit(a); go(`/audit/${a.id}`);
  }

  async function run() {
    const v = validate(); if (v) { setErr(v); if (v.includes('API key')) needKey(); return; }
    setErr('');
    const ps = prompts.map(p => p.trim()).filter(Boolean);
    const { b, c } = entities();
    if (settings.mode === 'manual') { setManual(ps.map(() => '')); return; }
    abort.current = new AbortController();
    const res: PromptResult[] = ps.map(p => ({ prompt: p, answer: '', mentions: [], domains: [] }));
    setProgress([...res]);
    await pool(ps, 3, async (p) => {
      const t = performance.now();
      try { const ans = await askLLM(settings, p, abort.current!.signal); return { ...analyse(p, ans, [b, ...c]), ms: Math.round(performance.now() - t) }; }
      catch (e) { return { prompt: p, answer: '', mentions: [], domains: [], error: (e as Error).message }; }
    }, (r, i) => { res[i] = r; setProgress([...res]); });
    if (abort.current.signal.aborted) { setProgress(null); return; }
    if (res.every(r => r.error)) { setErr(`Every prompt failed: ${res[0].error}`); setProgress(null); return; }
    finish(res);
  }

  if (manual.length) {
    const ps = prompts.map(p => p.trim()).filter(Boolean);
    const { b, c } = entities();
    return (
      <section className="sheet">
        <p className="kicker">Manual mode · {ps.length} prompts</p>
        <h1 className="display">Paste what the assistant said.</h1>
        {ps.map((p, i) => (
          <label key={i} className="fld paste"><span className="q">“{p}”</span>
            <textarea rows={4} data-testid={`paste-${i}`} value={manual[i]} onChange={e => { const m = [...manual]; m[i] = e.target.value; setManual(m); }} placeholder="Paste the full answer here" /></label>
        ))}
        <div className="row"><button className="ghost" onClick={() => setManual([])}>Back</button>
          <button className="ink" data-testid="score-manual" onClick={() => {
            if (manual.filter(Boolean).length < 2) { setErr('Paste at least 2 answers.'); return; }
            finish(ps.map((p, i) => manual[i] ? analyse(p, manual[i], [b, ...c]) : { prompt: p, answer: '', mentions: [], domains: [], error: 'skipped' }));
          }}>Score answers</button></div>
        {err && <p className="err" role="alert">{err}</p>}
      </section>
    );
  }

  if (progress) {
    const done = progress.filter(r => r.answer || r.error).length;
    return (
      <section className="sheet" data-testid="running">
        <p className="kicker">Running · {settings.provider} / {settings.model}</p>
        <h1 className="display">Asking {progress.length} buyer questions…</h1>
        <div className="meter"><i style={{ width: pct(done / progress.length) }} /></div>
        <ol className="runlist">{progress.map((r, i) => <li key={i} className={r.error ? 'bad' : r.answer ? 'done' : 'wait'}>
          <span>{r.prompt}</span><em>{r.error ? 'failed' : r.answer ? `${r.mentions.length} brands · ${r.ms}ms` : '…'}</em></li>)}</ol>
        <button className="ghost" onClick={() => abort.current?.abort()}>Cancel</button>
      </section>
    );
  }

  return (
    <section className="sheet">
      <p className="kicker">AI shelf audit</p>
      <h1 className="display">When a buyer asks an AI what to buy, <em>are you on the shelf?</em></h1>
      <p className="lede">Shelfsight asks an AI assistant the questions your customers actually ask, then measures how often your brand is named, in what position, and who takes the slot when you're missing.</p>
      <div className="grid2">
        <label className="fld">Category<input data-testid="category" value={category} onChange={e => setCategory(e.target.value)} placeholder="face wash for oily skin" /></label>
        <label className="fld">Market<input data-testid="market" value={market} onChange={e => setMarket(e.target.value)} placeholder="India" /></label>
        <label className="fld">Your brand<input data-testid="brand" value={brand} onChange={e => setBrand(e.target.value)} placeholder="Minimalist | be minimalist" /><small>Name | aliases, comma-separated</small></label>
        <label className="fld">Competitors (one per line)<textarea data-testid="competitors" rows={4} value={comps} onChange={e => setComps(e.target.value)} placeholder={'Cetaphil\nThe Derma Co | dermaco\nCeraVe'} /></label>
      </div>
      <div className="prompts">
        <div className="row between"><h3>Buyer prompts <small>brand-neutral, the way customers ask</small></h3>
          <button className="ghost" data-testid="suggest" onClick={suggest} disabled={!!busy}>{busy ? 'Thinking…' : prompts.length ? 'Regenerate' : 'Generate prompts'}</button></div>
        {busy && <p className="note">{busy}</p>}
        {prompts.map((p, i) => (
          <div className="prow" key={i}><span>{String(i + 1).padStart(2, '0')}</span>
            <input value={p} onChange={e => { const n = [...prompts]; n[i] = e.target.value; setPrompts(n); }} />
            <button className="x" aria-label="remove" onClick={() => setPrompts(prompts.filter((_, j) => j !== i))}>×</button></div>
        ))}
        {prompts.length > 0 && <button className="link" onClick={() => setPrompts([...prompts, ''])}>+ add prompt</button>}
      </div>
      {err && <p className="err" role="alert" data-testid="error">{err}</p>}
      <button className="ink big" data-testid="run" onClick={run}>{settings.mode === 'manual' ? 'Continue to paste answers →' : 'Run audit →'}</button>
    </section>
  );
}

function Trend({ points }: { points: number[] }) {
  if (points.length < 2) return <span className="muted">Run again later to see a trend.</span>;
  const w = 220, h = 48, max = 100;
  const d = points.map((p, i) => `${(i / (points.length - 1)) * w},${h - (p / max) * h}`).join(' ');
  return <svg width={w} height={h} className="spark"><polyline points={d} fill="none" stroke="currentColor" strokeWidth="2" />{points.map((p, i) => <circle key={i} cx={(i / (points.length - 1)) * w} cy={h - (p / max) * h} r="3" />)}</svg>;
}

function Highlight({ text, names }: { text: string; names: string[] }) {
  const parts = useMemo(() => {
    if (!names.length) return [text];
    const re = new RegExp(`(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    return text.split(re);
  }, [text, names]);
  return <>{parts.map((p, i) => i % 2 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>)}</>;
}

function Report({ id }: { id: string }) {
  const a = loadAudits().find(x => x.id === id);
  const [open, setOpen] = useState<number | null>(null);
  if (!a) return <section className="sheet"><h1 className="display">Audit not found.</h1><a href="#/">Start a new one</a></section>;
  const { rows, answered } = score(a);
  const me = rows.find(r => r.isBrand)!;
  const g = gaps(a);
  const stealers = new Map<string, number>(); g.forEach(x => x.winners.forEach(w => stealers.set(w, (stealers.get(w) || 0) + 1)));
  const history = loadAudits().filter(x => x.brand.name.toLowerCase() === a.brand.name.toLowerCase() && x.category.toLowerCase() === a.category.toLowerCase()).reverse();
  const trend = history.map(h => visIndex(score(h).rows.find(r => r.isBrand)!));
  const allDomains = new Map<string, number>(); a.results.forEach(r => r.domains.forEach(d => allDomains.set(d, (allDomains.get(d) || 0) + 1)));
  const failed = a.results.filter(r => r.error).length;
  const download = () => { const b = new Blob([toCSV(a)], { type: 'text/csv' }); const u = URL.createObjectURL(b); const l = document.createElement('a'); l.href = u; l.download = `shelfsight-${a.brand.name}-${new Date(a.createdAt).toLocaleDateString('en-CA')}.csv`; l.click(); URL.revokeObjectURL(u); };
  return (
    <section className="sheet report" data-testid="report">
      <p className="kicker">{a.category}{a.market ? ` · ${a.market}` : ''} · {a.model} · {new Date(a.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} IST</p>
      <div className="hero">
        <div><h1 className="display">{a.brand.name}</h1>
          <p className="lede">Named in <b>{me.count} of {answered}</b> buyer answers{me.avgRank ? <>, average position <b>#{me.avgRank.toFixed(1)}</b></> : ''}.{failed ? ` ${failed} prompt(s) failed.` : ''}</p></div>
        <div className="index" data-testid="vis-index"><span>{visIndex(me)}</span><small>shelf index /100</small></div>
      </div>
      <div className="kpis">
        <div><b data-testid="inclusion">{pct(me.inclusion)}</b><span>inclusion rate</span></div>
        <div><b>{pct(me.firstPick)}</b><span>named first</span></div>
        <div><b>{pct(me.share)}</b><span>share of voice</span></div>
        <div><Trend points={trend} /><span>shelf index over {trend.length} run(s)</span></div>
      </div>
      <h2 className="rule">Leaderboard</h2>
      <table className="board"><thead><tr><th>Brand</th><th>Inclusion</th><th>First pick</th><th>Avg pos.</th><th>Index</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.name} className={r.isBrand ? 'me' : ''}><td>{r.name}</td>
          <td><div className="bar"><i style={{ width: pct(r.inclusion) }} /></div>{pct(r.inclusion)}</td><td>{pct(r.firstPick)}</td><td>{r.avgRank ? `#${r.avgRank.toFixed(1)}` : '—'}</td><td>{visIndex(r)}</td></tr>)}</tbody></table>
      <div className="grid2">
        <div><h2 className="rule">Where you're missing</h2>
          {g.length ? <ul className="gaps" data-testid="gaps">{g.map((x, i) => <li key={i}>“{x.prompt}”<small>{x.winners.length ? `Took the slot: ${x.winners.join(', ')}` : 'No tracked brand named'}</small></li>)}</ul> : <p className="note">On the shelf in every answered prompt. 🎯</p>}
        </div>
        <div><h2 className="rule">What to do next</h2>
          <ol className="todo">
            {[...stealers.entries()].sort((x, y) => y[1] - x[1]).slice(0, 1).map(([n, c]) => <li key={n}><b>{n}</b> replaces you in {c} prompt(s). Read those answers below. The reasons the model gives for {n} (claims, ingredients, price) are the attributes your catalog needs to state clearly.</li>)}
            {allDomains.size > 0 && <li>Sources the model referenced: {[...allDomains.keys()].slice(0, 6).join(', ')}. Get listed or reviewed there.</li>}
            <li>Re-run this audit weekly with the same prompts. Answers are probabilistic, so track the trend, not one run.</li>
          </ol></div>
      </div>
      <h2 className="rule">Answers</h2>
      <div className="answers">{a.results.map((r, i) => (
        <article key={i} className={r.mentions.some(m => m.name === a.brand.name) ? 'hit' : 'miss'}>
          <button className="ahead" onClick={() => setOpen(open === i ? null : i)}><span>{r.prompt}</span>
            <em>{r.error ? `error: ${r.error}` : r.mentions.map(m => `${m.rank}. ${m.name}`).join('  ') || 'no tracked brands'}</em></button>
          {open === i && r.answer && <p className="abody"><Highlight text={r.answer} names={[a.brand, ...a.competitors].flatMap(e => [e.name, ...e.aliases])} /></p>}
        </article>))}</div>
      <div className="row"><button className="ghost" onClick={download} data-testid="csv">Export CSV</button><button className="ghost" onClick={() => print()}>Print / PDF</button><a className="ghost btn" href="#/">New audit</a></div>
    </section>
  );
}

function History() {
  const [list, setList] = useState(loadAudits);
  return (
    <section className="sheet">
      <p className="kicker">Ledger</p><h1 className="display">Past audits</h1>
      {!list.length && <p className="note">Nothing yet. <a href="#/">Run your first audit.</a></p>}
      <table className="board"><tbody>{list.map(a => { const me = score(a).rows.find(r => r.isBrand)!; return (
        <tr key={a.id}><td><a href={`#/audit/${a.id}`}>{a.brand.name}</a><small className="muted"> · {a.category}</small></td>
          <td>{new Date(a.createdAt).toLocaleDateString('en-IN')}</td><td>{pct(me.inclusion)}</td><td>{visIndex(me)}</td>
          <td><button className="x" onClick={() => { deleteAudit(a.id); setList(loadAudits()); }}>×</button></td></tr>); })}</tbody></table>
    </section>
  );
}
