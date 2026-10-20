import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test.db"
import pytest
from httpx import ASGITransport, AsyncClient
from app import llm
from app.main import app
from app.db import init_db
from app.scoring import Entity, detect

FAKE = {
    "best face wash": "Top picks: 1. Cetaphil Gentle Cleanser 2. Minimalist Salicylic 3. CeraVe.",
    "budget face wash": "Try The Derma Co or CeraVe for value.",
}


async def fake_ask(client, provider, model, prompt):
    return FAKE[prompt]


def test_detect_ranks_by_position_and_aliases():
    m = detect("Go with dermaco, or Minimalist.", [Entity("Minimalist"), Entity("The Derma Co", ["dermaco"])])
    assert [x["name"] for x in m] == ["The Derma Co", "Minimalist"]
    assert detect("Cetaphilia is not a brand", [Entity("Cetaphil")]) == []


@pytest.mark.asyncio
async def test_audit_roundtrip(monkeypatch):
    monkeypatch.setattr(llm, "ask", fake_ask)
    if os.path.exists("test.db"):
        os.remove("test.db")
    await init_db()
    import httpx
    app.state.http = httpx.AsyncClient()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/audits", json={"category": "face wash", "brand": {"name": "Minimalist"},
                                              "competitors": [{"name": "Cetaphil"}, {"name": "CeraVe"}, {"name": "The Derma Co"}],
                                              "prompts": list(FAKE)})
        assert r.status_code == 201, r.text
        a = r.json()
        assert a["inclusion"] == 0.5
        assert (await c.get(f"/api/audits/{a['id']}")).json()["brand"] == "Minimalist"
        assert len((await c.get("/api/audits")).json()) == 1
        assert (await c.post("/api/audits", json={"category": "x"})).status_code == 422
