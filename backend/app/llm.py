import os
import httpx

SYSTEM = "You are a helpful shopping assistant. Answer the buyer's question naturally, naming specific brands or products where relevant."
DEFAULT_MODELS = {"gemini": "gemini-2.5-flash", "openai": "gpt-4o-mini"}


class LLMError(Exception):
    pass


async def ask(client: httpx.AsyncClient, provider: str, model: str | None, prompt: str) -> str:
    model = model or DEFAULT_MODELS[provider]
    if provider == "gemini":
        key = os.getenv("GEMINI_API_KEY")
        if not key:
            raise LLMError("GEMINI_API_KEY is not set on the server")
        r = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": key},
            json={"systemInstruction": {"parts": [{"text": SYSTEM}]}, "contents": [{"role": "user", "parts": [{"text": prompt}]}]},
        )
        j = r.json()
        if r.status_code != 200:
            raise LLMError(j.get("error", {}).get("message", f"Gemini HTTP {r.status_code}"))
        return "".join(p.get("text", "") for p in j["candidates"][0]["content"]["parts"])
    if provider == "openai":
        key = os.getenv("OPENAI_API_KEY")
        if not key:
            raise LLMError("OPENAI_API_KEY is not set on the server")
        r = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}]},
        )
        j = r.json()
        if r.status_code != 200:
            raise LLMError(j.get("error", {}).get("message", f"OpenAI HTTP {r.status_code}"))
        return j["choices"][0]["message"]["content"]
    raise LLMError(f"Unknown provider {provider}")
