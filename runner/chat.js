// Provider-agnostic OpenAI-compatible chat transport. Zero dependencies.
// Free tiers throttle hard, so 429/408/5xx use exponential backoff + jitter and
// honour Retry-After. Non-retryable 4xx (auth, bad request) fail immediately.
const PROVIDERS = require("./providers.json");

const RETRYABLE = (status) => status === 429 || status === 408 || status >= 500;

function readKey(provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  // Secrets are often pasted with a trailing newline or wrapped in quotes.
  let k = String(process.env[p.keyEnv] ?? "").trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  if (!k) throw new Error(`${p.keyEnv} not set (needed for provider ${provider})`);
  return k;
}

async function chat({
  provider = "openrouter",
  model,
  messages,
  tools,
  temperature = 0.2,
  maxRetries = 10,
  timeoutMs = 180_000,
  baseDelayMs = 3_000,
  maxDelayMs = 65_000,
}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider: ${provider}`);
  const key = readKey(provider);

  const body = { model, messages, temperature };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(p.headers || {}),
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${p.base}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (RETRYABLE(res.status)) {
        // The provider states the exact limit (RPM/TPM/daily) in the body and in
        // x-ratelimit-* headers. Without them a 429 is just a mystery wall.
        const detail = (await res.text().catch(() => "")).slice(0, 400);
        const limits = [
          "retry-after",
          "x-ratelimit-limit-requests",
          "x-ratelimit-remaining-requests",
          "x-ratelimit-limit-tokens",
          "x-ratelimit-remaining-tokens",
          "x-ratelimit-reset-tokens",
        ]
          .map((h) => (res.headers.get(h) ? `${h}=${res.headers.get(h)}` : null))
          .filter(Boolean)
          .join(" ");
        if (attempt === maxRetries) {
          throw new Error(
            `${provider} ${res.status} for ${model} after ${maxRetries} attempts${limits ? ` [${limits}]` : ""}: ${detail}`
          );
        }
        const retryAfter = parseFloat(res.headers.get("retry-after"));
        const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const wait =
          (Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, maxDelayMs) : backoff) *
          (0.7 + Math.random() * 0.6);
        console.error(`   ${res.status} on ${model}, retry ${attempt}/${maxRetries} in ${(wait / 1000).toFixed(1)}s: ${detail}`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }

      if (!res.ok) {
        const err = new Error(`${provider} ${res.status} for ${model}: ${(await res.text()).slice(0, 300)}`);
        err.noRetry = true; // 4xx that is not 429/408 will not fix itself
        throw err;
      }

      const json = await res.json();
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error(`empty completion from ${model}`);
      return { message, usage: json.usage || {} };
    } catch (e) {
      if (e.noRetry || attempt === maxRetries) {
        throw new Error(`request failed for ${provider}/${model}: ${e.message}`);
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await new Promise((r) => setTimeout(r, backoff * (0.7 + Math.random() * 0.6)));
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { chat, PROVIDERS, readKey };
