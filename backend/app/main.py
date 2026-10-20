import asyncio
import os
import time
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import llm
from .db import AuditRow, get_session, init_db
from .scoring import Entity, detect, score

CONCURRENCY = int(os.getenv("LLM_CONCURRENCY", "4"))


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    app.state.http = httpx.AsyncClient(timeout=60)
    yield
    await app.state.http.aclose()


app = FastAPI(title="Shelfsight API", version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=os.getenv("CORS_ORIGINS", "*").split(","), allow_methods=["*"], allow_headers=["*"])


class EntityIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    aliases: list[str] = []


class AskIn(BaseModel):
    prompt: str = Field(min_length=3, max_length=2000)
    provider: Literal["gemini", "openai"] = "gemini"
    model: str | None = None


class AuditIn(BaseModel):
    category: str = Field(min_length=3, max_length=200)
    market: str = ""
    brand: EntityIn
    competitors: list[EntityIn] = Field(min_length=1, max_length=15)
    prompts: list[str] = Field(min_length=2, max_length=30)
    provider: Literal["gemini", "openai"] = "gemini"
    model: str | None = None


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/ask")
async def ask(body: AskIn):
    try:
        return {"answer": await llm.ask(app.state.http, body.provider, body.model, body.prompt)}
    except llm.LLMError as e:
        raise HTTPException(502, str(e))


@app.post("/api/audits", status_code=201)
async def create_audit(body: AuditIn, db: AsyncSession = Depends(get_session)):
    entities = [Entity(body.brand.name, body.brand.aliases)] + [Entity(c.name, c.aliases) for c in body.competitors]
    sem = asyncio.Semaphore(CONCURRENCY)

    async def run(p: str) -> dict:
        async with sem:
            t = time.perf_counter()
            try:
                ans = await llm.ask(app.state.http, body.provider, body.model, p)
                return {"prompt": p, "answer": ans, "mentions": detect(ans, entities), "ms": round((time.perf_counter() - t) * 1000)}
            except (llm.LLMError, httpx.HTTPError) as e:
                return {"prompt": p, "answer": "", "mentions": [], "error": str(e)}

    results = await asyncio.gather(*(run(p) for p in body.prompts))
    if all(r.get("error") for r in results):
        raise HTTPException(502, f"All prompts failed: {results[0]['error']}")
    rows = score(results, entities)
    me = next(r for r in rows if r["is_brand"])
    row = AuditRow(brand=body.brand.name, category=body.category, market=body.market, provider=body.provider,
                   model=body.model or llm.DEFAULT_MODELS[body.provider], inclusion=me["inclusion"], shelf_index=me["shelf_index"],
                   payload={"entities": [e.__dict__ for e in entities], "results": results, "scores": rows})
    db.add(row)
    await db.commit()
    return _out(row)


@app.get("/api/audits")
async def list_audits(brand: str | None = None, db: AsyncSession = Depends(get_session)):
    q = select(AuditRow).order_by(AuditRow.created_at.desc()).limit(100)
    if brand:
        q = q.where(AuditRow.brand.ilike(brand))
    return [{"id": r.id, "created_at": r.created_at, "brand": r.brand, "category": r.category, "inclusion": r.inclusion, "shelf_index": r.shelf_index}
            for r in (await db.scalars(q)).all()]


@app.get("/api/audits/{audit_id}")
async def get_audit(audit_id: int, db: AsyncSession = Depends(get_session)):
    row = await db.get(AuditRow, audit_id)
    if not row:
        raise HTTPException(404, "Audit not found")
    return _out(row)


def _out(r: AuditRow) -> dict:
    return {"id": r.id, "created_at": r.created_at, "brand": r.brand, "category": r.category, "market": r.market,
            "provider": r.provider, "model": r.model, "inclusion": r.inclusion, "shelf_index": r.shelf_index, **r.payload}
