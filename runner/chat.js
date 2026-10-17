// Provider-agnostic OpenAI-compatible chat transport. Zero dependencies.
//
// Free tiers meter tokens per minute. Getting a 429 and then guessing a wait is
// the wrong shape: we hammer the window and keep it full ourselves. So each
// provider declares paceMs (min gap between requests) and we simply stay under
// the cap. 429/408/5xx still retry with backoff, and the response body (which
// states the exact limit) is surfaced instead of thrown away.
const PROVIDERS = require("./providers.json");

const RETRYABLE = (status) => status === 429 || status === 408 || status >= 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Module-level: a run is single-threaded, so one clock is enough.
let nextAllowedAt = 0;
async function pace(ms) {
  if (ms <= 0) return;
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await sleep(wait);
  nextAllowedAt = Date.now() + ms;
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
  const paceMs = p.paceMs ?? 0;

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
    await pace(paceMs);
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
        const wait = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, maxDelayMs) : backoff;
        console.error(`   ${res.status} on ${model}, retry ${attempt}/${maxRetries} in ${(wait / 1000).toFixed(1)}s: ${detail}`);
        await sleep(wait * (0.7 + Math.random() * 0.6));
        continue;
      }

      if (!res.ok) {
        const bodyText = (await res.text().catch(() => "")).slice(0, 400);
        // A malformed tool call is stochastic and the provider rejects it with
        // 400 before we can hand it back to the model, so retrying the same
        // request is the only recovery we have. Without this, one bad generation
        // voids the whole run and the leaderboard measures the harness.
        if (/tool_use_failed/.test(bodyText) && attempt < maxRetries) {
          const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
          console.error(`   ${res.status} malformed tool call on ${model}, retry ${attempt}/${maxRetries}: ${bodyText}`);
          await sleep(backoff * (0.7 + Math.random() * 0.6));
          continue;
        }
        const err = new Error(`${provider} ${res.status} for ${model}: ${bodyText}`);
        err.noRetry = true; // other 4xx will not fix itself
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
      await sleep(backoff * (0.7 + Math.random() * 0.6));
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { chat, PROVIDERS, readKey };
