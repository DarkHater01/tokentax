// Provider-agnostic OpenAI-compatible chat transport. Zero dependencies.
//
// Free tiers meter tokens per minute, so each provider declares paceMs (min gap
// between requests) and we stay under the cap instead of tripping it and guessing
// a wait. 429/408/5xx retry with backoff and the response body (which states the
// exact limit) is surfaced. See also the tool_use_failed branch below.
const PROVIDERS = require("./providers.json");

const RETRYABLE = (status) => status === 429 || status === 408 || status >= 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A 429 or a rejected tool call bills nothing back, so the prompt we re-send is
// costed here instead of vanishing: without it a model that thrashes against the
// provider looks cheaper than one that does not.
// shortcut: 4 chars/token, upgrade when a real tokenizer is available.
const estTokens = (s) => Math.ceil(String(s).length / 4);

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
  const toolNames = (tools || []).map((t) => t.function && t.function.name).filter(Boolean);
  const headers = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...(p.headers || {}),
  };

  // Carried into a retry after a rejected tool name. Lives here, not in the
  // harness transcript: it is transport-level recovery, not part of the run.
  let nudge = null;
  let retries = 0;
  let retry_tokens_in = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await pace(paceMs);
    const body = { model, messages: nudge ? [...messages, nudge] : messages, temperature };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

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
        retries++;
        retry_tokens_in += estTokens(JSON.stringify(body));
        await sleep(wait * (0.7 + Math.random() * 0.6));
        continue;
      }

      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 400);
        // gpt-oss class models sometimes call tools from their training-time
        // scaffold (repo_browser.search, ...) that this harness never defined,
        // and the provider rejects the call before we can answer "no such tool".
        // At this temperature a plain retry repeats the same bad call, so restate
        // the real tool list. Without this the run dies on turn three and the
        // leaderboard measures the harness instead of the model.
        if (/tool_use_failed/.test(detail) && attempt < maxRetries) {
          nudge = {
            role: "user",
            content: `(harness) Your last tool call was rejected: that tool does not exist. Available tools: ${
              toolNames.join(", ") || "(none)"
            }. Call one of those.`,
          };
          console.error(`   ${res.status} rejected tool call on ${model}, retry ${attempt}/${maxRetries} with the real tool list: ${detail}`);
          retries++;
          retry_tokens_in += estTokens(JSON.stringify(body));
          await sleep(1000 * (0.7 + Math.random() * 0.6));
          continue;
        }
        const err = new Error(`${provider} ${res.status} for ${model}: ${detail}`);
        err.noRetry = true; // other 4xx will not fix itself
        throw err;
      }

      const json = await res.json();
      const message = json.choices?.[0]?.message;
      if (!message) throw new Error(`empty completion from ${model}`);
      const usage = json.usage || {};
      // A missing usage block used to become 0 tokens and publish as tax 0.00x --
      // the perfect model, for free. Refuse to score what cannot be counted.
      if (!(usage.prompt_tokens ?? usage.input_tokens)) {
        const e = new Error(`no usage in response from ${provider}/${model}: refusing to score an uncounted run`);
        e.noRetry = true;
        throw e;
      }
      return { message, usage, retries, retry_tokens_in };
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
