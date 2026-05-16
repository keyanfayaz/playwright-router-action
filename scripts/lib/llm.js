/*
 * Shared OpenAI-compatible LLM helpers.
 *
 * Extracted verbatim from route-ai.js so the strict-JSON discipline and the
 * provider-agnostic chat client can be reused by the test-plan agent loop
 * without behavioral drift. route-ai.js requires these back in unchanged.
 */
const fs = require('fs');

const PROVIDER_DEFAULTS = {
  openrouter: 'https://openrouter.ai/api/v1',
  together: 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
};

function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, `${key}=${value}\n`);
}

async function chat({ baseUrl, apiKey, model, messages }) {
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 400)}`);
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content || '';
  return content;
}

function tryParseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch {}
  // Pull the first {...} block out of the string if the model wrapped it.
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}

module.exports = { chat, tryParseJson, PROVIDER_DEFAULTS, setOutput };
