"""Mention detection + scoring. Mirrors src/lib.ts so browser and server agree."""
import re
from dataclasses import dataclass, field


@dataclass
class Entity:
    name: str
    aliases: list[str] = field(default_factory=list)


def _first_index(text: str, e: Entity) -> int:
    best = -1
    for term in [e.name, *e.aliases]:
        if not term:
            continue
        m = re.search(rf"(?<![\w]){re.escape(term)}(?![\w])", text, re.IGNORECASE)
        if m and (best < 0 or m.start() < best):
            best = m.start()
    return best


def detect(answer: str, entities: list[Entity]) -> list[dict]:
    hits = [(e.name, _first_index(answer, e)) for e in entities]
    hits = sorted([h for h in hits if h[1] >= 0], key=lambda h: h[1])
    return [{"name": n, "offset": o, "rank": i + 1} for i, (n, o) in enumerate(hits)]


def score(results: list[dict], entities: list[Entity]) -> list[dict]:
    ok = [r for r in results if r.get("answer") and not r.get("error")]
    total = sum(len(r["mentions"]) for r in ok) or 1
    rows = []
    for i, e in enumerate(entities):
        ms = [m for r in ok for m in r["mentions"] if m["name"] == e.name]
        n = len(ok) or 1
        inc, first, share = len(ms) / n, sum(m["rank"] == 1 for m in ms) / n, len(ms) / total
        rows.append({
            "name": e.name, "is_brand": i == 0, "count": len(ms),
            "inclusion": inc if ok else 0, "first_pick": first if ok else 0, "share": share,
            "avg_rank": sum(m["rank"] for m in ms) / len(ms) if ms else None,
            "shelf_index": round(100 * (0.6 * inc + 0.25 * first + 0.15 * share)) if ok else 0,
        })
    return sorted(rows, key=lambda r: (-r["inclusion"], r["avg_rank"] or 99))
