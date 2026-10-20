# Shelfsight — is your brand on the AI shelf?

Buyers now ask ChatGPT or Gemini "which face wash should I buy?" before they ever open Google or Amazon.
If the assistant doesn't name your brand, you're not in the consideration set. Shelfsight measures that.

1. Enter a category, market, your brand (with aliases) and competitors.
2. Generate brand-neutral **buyer prompts** (built-in templates, or have the LLM write realistic shopper questions).
3. Shelfsight asks the model every prompt (3–4 in parallel), detects which brands are named and in what order, and scores:
   - **Inclusion rate**: % of answers naming you
   - **First pick**: % of answers where you're named first
   - **Share of voice**: your mentions ÷ all tracked mentions
   - **Shelf index** (0–100) = 60% inclusion + 25% first pick + 15% share of voice
4. The report shows a leaderboard, the **gap prompts** where you're missing and who took the slot, the domains the model cited, highlighted answers, a trend across re-runs, and CSV/PDF export.

Three engines:
- **Your key (browser)**: paste a free Gemini key (aistudio.google.com) or an OpenAI key. It stays in your browser's localStorage and is sent only to the provider.
- **FastAPI backend**: keys live in server env, audits persist in Postgres.
- **Paste answers**: no key needed. Ask any assistant yourself and paste its answers; scoring is identical.

## Stack
- `src/`: React 19 + Vite + TypeScript, no UI kit (Fraunces / Space Grotesk / JetBrains Mono)
- `backend/`: FastAPI (async), SQLAlchemy 2 async + asyncpg, PostgreSQL, httpx, `asyncio.gather` with a semaphore for concurrent LLM calls

## Run the full version locally
```bash
cd backend
export GEMINI_API_KEY=your_key        # or OPENAI_API_KEY
docker compose up --build             # Postgres 16 + API on :8000
# API: POST /api/audits, GET /api/audits, GET /api/audits/{id}, POST /api/ask, docs at /docs
cd .. && npm install && npm run dev   # then ⚙ → "FastAPI backend" → http://localhost:8000
```

## Tests
- `cd backend && pip install -r requirements.txt pytest pytest-asyncio aiosqlite && pytest`: scoring and API round-trip (LLM mocked)
- `npm run build && npm run preview & npm run test:e2e`: Playwright end-to-end with a mocked Gemini API (validation, generated prompts, audit run, scores, gaps, CSV, trend, API-error state, manual mode). Screenshots go to `shots/`.

Answers are probabilistic. Treat one run as a sample and track the trend.

Built by Mohammed Jeelan · github.com/MohammadJeelan
