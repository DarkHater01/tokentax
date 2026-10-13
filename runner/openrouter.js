// OpenRouter chat transport with retries. Zero dependencies. Node 18+ fetch.
async function chat({ base, key, model, messages, tools, temperature = 0.2, maxRetries = 4, timeoutMs = 180_000 }) {
  const body = { model, messages, temperature };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "X-Title": "TokenTax",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === maxRetries) throw new Error(`OpenRouter ${res.status} for ${model}`);
        await new Promise((r) => setTimeout(r, 15_000));
        continue;
      }
      if (!res.ok) throw new Error(`OpenRouter ${res.status} for ${model}: ${(await res.text()).slice(0, 300)}`);
      const json = await res.json();
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error(`empty completion from ${model}`);
      return { message, usage: json.usage || {} };
    } catch (e) {
      if (attempt === maxRetries) throw new Error(`OpenRouter request failed for ${model}: ${e.message}`);
      await new Promise((r) => setTimeout(r, 15_000));
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { chat };
