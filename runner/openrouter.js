// OpenRouter chat transport with retries. Zero dependencies. Node 18+ fetch.
// Free endpoints throttle hard, so 429/408/5xx use exponential backoff + jitter
// and honour Retry-After. Non-retryable 4xx (auth, bad request) fail immediately.
const RETRYABLE = (status) => status === 429 || status === 408 || status >= 500;

async function chat({
  base,
  key,
  model,
  messages,
  tools,
  temperature = 0.2,
  maxRetries = 6,
  timeoutMs = 180_000,
  baseDelayMs = 3_000,
  maxDelayMs = 45_000,
}) {
  // Secrets are often pasted with a trailing newline or wrapped in quotes.
  let authKey = String(key ?? "").trim();
  if (
    (authKey.startsWith('"') && authKey.endsWith('"')) ||
    (authKey.startsWith("'") && authKey.endsWith("'"))
  ) {
    authKey = authKey.slice(1, -1);
  }

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
          Authorization: `Bearer ${authKey}`,
          "Content-Type": "application/json",
          "X-Title": "TokenTax",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (RETRYABLE(res.status)) {
        if (attempt === maxRetries) {
          throw new Error(`OpenRouter ${res.status} for ${model} after ${maxRetries} attempts`);
        }
        const retryAfter = parseFloat(res.headers.get("retry-after"));
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const wait = (Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, maxDelayMs) : backoff) * (0.7 + Math.random() * 0.6);
        console.error(`   ${res.status} on ${model}, retry ${attempt}/${maxRetries} in ${(wait / 1000).toFixed(1)}s`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const err = new Error(`OpenRouter ${res.status} for ${model}: ${(await res.text()).slice(0, 300)}`);
        err.noRetry = true; // 4xx that is not 429/408 will not fix itself
        throw err;
      }

      const json = await res.json();
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error(`empty completion from ${model}`);
      return { message, usage: json.usage || {} };
    } catch (e) {
      if (e.noRetry || attempt === maxRetries) {
        throw new Error(`OpenRouter request failed for ${model}: ${e.message}`);
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoff * (0.7 + Math.random() * 0.6)));
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { chat };
