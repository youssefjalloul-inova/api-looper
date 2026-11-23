#!/usr/bin/env node
// API Looper — lets Claude Desktop hand work to any model billed to YOUR API key.
// Providers: Moonshot (Kimi), OpenAI, OpenRouter, DeepSeek, Gemini, Anthropic, or any OpenAI-compatible URL.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------- Config (filled in by Claude Desktop from the extension settings) ----------
const PRESETS = {
  moonshot:   { label: "Moonshot (Kimi)", kind: "openai",    baseUrl: "https://api.moonshot.ai/v1" },
  kimi:       { label: "Moonshot (Kimi)", kind: "openai",    baseUrl: "https://api.moonshot.ai/v1" },
  openai:     { label: "OpenAI",          kind: "openai",    baseUrl: "https://api.openai.com/v1" },
  openrouter: { label: "OpenRouter",      kind: "openai",    baseUrl: "https://openrouter.ai/api/v1" },
  deepseek:   { label: "DeepSeek",        kind: "openai",    baseUrl: "https://api.deepseek.com/v1" },
  gemini:     { label: "Google Gemini",   kind: "openai",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  anthropic:  { label: "Anthropic API",   kind: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
  custom:     { label: "Custom (OpenAI-compatible)", kind: "openai", baseUrl: "" },
};

const env = (k) => {
  const v = (process.env[k] ?? "").trim();
  // Claude Desktop passes "${user_config.x}" literally when a field is left empty in some versions.
  return v.startsWith("${") ? "" : v;
};

const providerKey = (env("LOOPER_PROVIDER") || "moonshot").toLowerCase();
const preset = PRESETS[providerKey] ?? PRESETS.custom;
const API_KEY = env("LOOPER_API_KEY");
const BASE_URL = (env("LOOPER_BASE_URL") || preset.baseUrl).replace(/\/+$/, "");
const DEFAULT_MODEL = env("LOOPER_DEFAULT_MODEL");
const BUDGET = Number(env("LOOPER_MONTHLY_TOKEN_BUDGET")) || 0; // 0 = no cap
const TIMEOUT_MS = 5 * 60 * 1000;

// ---------- Local usage ledger (never leaves your machine) ----------
const DATA_DIR = env("LOOPER_DATA_DIR") || path.join(os.homedir(), ".api-looper");
const LEDGER = path.join(DATA_DIR, "usage.jsonl");

function record(entry) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(entry) + "\n");
  } catch (e) {
    console.error("[api-looper] could not write usage ledger:", e.message);
  }
}

function readLedger() {
  try {
    return fs.readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

function since(period) {
  const now = new Date();
  if (period === "today") return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return 0;
}

function monthTokens() {
  const from = since("month");
  return readLedger().filter((e) => e.ts >= from).reduce((s, e) => s + (e.input || 0) + (e.output || 0), 0);
}

// ---------- Provider calls ----------
async function http(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const msg = typeof body === "object" ? body?.error?.message || JSON.stringify(body) : String(body).slice(0, 500);
    const err = new Error(`${preset.label} returned ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return body;
}

function headers() {
  if (preset.kind === "anthropic") {
    return { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" };
  }
  return { "content-type": "application/json", authorization: `Bearer ${API_KEY}` };
}

async function listModels() {
  const body = await http(`${BASE_URL}/models`, { headers: headers() });
  const ids = (body?.data ?? body?.models ?? []).map((m) => m.id ?? m.name).filter(Boolean);
  return ids.sort();
}

async function complete({ model, system, prompt, max_tokens, temperature }) {
  if (preset.kind === "anthropic") {
    const body = await http(`${BASE_URL}/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model, max_tokens, ...(temperature != null && { temperature }),
        ...(system && { system }),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    return {
      text: (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
      input: body.usage?.input_tokens ?? 0,
      output: body.usage?.output_tokens ?? 0,
      stop: body.stop_reason,
    };
  }
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const body = await http(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ model, messages, max_tokens, ...(temperature != null && { temperature }) }),
  });
  const choice = body.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    input: body.usage?.prompt_tokens ?? 0,
    output: body.usage?.completion_tokens ?? 0,
    stop: choice?.finish_reason,
  };
}

// ---------- MCP server ----------
const server = new McpServer({ name: "api-looper", version: "1.0.0" });

const fail = (text) => ({ content: [{ type: "text", text }], isError: true });

function setupProblem() {
  if (!API_KEY) return "No API key set. Open Claude Desktop → Settings → Extensions → API Looper → Configure, and paste your key.";
  if (!BASE_URL) return "Provider is 'custom' but no Base URL is set. Add one in the extension settings.";
  return null;
}

server.registerTool(
  "delegate_to_model",
  {
    title: "Delegate to your own model",
    description:
      `Send a self-contained task to ${preset.label} (billed to the user's own API key, not their Claude plan) and get the answer back. ` +
      "Use it for drafting, rewriting, summarising, translating, bulk variations, first-pass code, or a second opinion — " +
      "work that doesn't need Claude's judgement. The other model sees ONLY what you put in `prompt` and `system`, " +
      "so include all needed context. Review its output before using it." +
      (DEFAULT_MODEL ? ` Default model: ${DEFAULT_MODEL}.` : " No default model is set; pass `model` (call list_models to see options)."),
    inputSchema: {
      prompt: z.string().min(1).describe("The full task, with all context the model needs."),
      system: z.string().optional().describe("Optional system instructions (role, tone, format)."),
      model: z.string().optional().describe("Model ID to use; defaults to the one set in the extension settings."),
      max_tokens: z.number().int().min(1).max(64000).optional().describe("Max output tokens (default 4096)."),
      temperature: z.number().min(0).max(2).optional(),
    },
  },
  async ({ prompt, system, model, max_tokens = 4096, temperature }) => {
    const problem = setupProblem();
    if (problem) return fail(problem);
    const useModel = model || DEFAULT_MODEL;
    if (!useModel) return fail("No model given and no default model set. Call list_models, then retry with `model`.");
    if (BUDGET && monthTokens() >= BUDGET) {
      return fail(`Monthly token budget reached (${BUDGET.toLocaleString()} tokens). Raise it in the extension settings or wait for next month.`);
    }
    const started = Date.now();
    try {
      const r = await complete({ model: useModel, system, prompt, max_tokens, temperature });
      record({ ts: Date.now(), provider: providerKey, model: useModel, input: r.input, output: r.output, ms: Date.now() - started });
      const truncated = r.stop === "length" || r.stop === "max_tokens" ? " — hit max_tokens, output may be cut off" : "";
      return {
        content: [
          { type: "text", text: r.text || "(empty response)" },
          { type: "text", text: `[${preset.label} · ${useModel} · ${r.input.toLocaleString()} in / ${r.output.toLocaleString()} out tokens · ${((Date.now() - started) / 1000).toFixed(1)}s${truncated}]` },
        ],
      };
    } catch (e) {
      const hint = e.status === 401 ? " Check the API key in the extension settings."
        : e.status === 404 ? " The model ID may be wrong — call list_models."
        : e.status === 429 ? " Rate limit or out of credit on that account."
        : e.name === "TimeoutError" ? " The request took over 5 minutes." : "";
      return fail(`${e.message}${hint}`);
    }
  }
);

server.registerTool(
  "list_models",
  {
    title: "List available models",
    description: `List the model IDs your ${preset.label} API key can use.`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const problem = setupProblem();
    if (problem) return fail(problem);
    try {
      const ids = await listModels();
      return { content: [{ type: "text", text: `${preset.label} models (${ids.length}):\n` + ids.join("\n") + (DEFAULT_MODEL ? `\n\nDefault: ${DEFAULT_MODEL}` : "") }] };
    } catch (e) {
      return fail(e.message);
    }
  }
);

server.registerTool(
  "token_usage",
  {
    title: "Token usage on your key",
    description: "Show how many tokens have been sent through this extension, by model. Tracked locally on this computer.",
    inputSchema: { period: z.enum(["today", "month", "all"]).optional().describe("Default: month") },
    annotations: { readOnlyHint: true },
  },
  async ({ period = "month" }) => {
    const from = since(period);
    const rows = readLedger().filter((e) => e.ts >= from);
    const by = {};
    for (const e of rows) {
      const k = `${e.provider}/${e.model}`;
      by[k] ??= { calls: 0, input: 0, output: 0 };
      by[k].calls++; by[k].input += e.input || 0; by[k].output += e.output || 0;
    }
    const total = rows.reduce((s, e) => s + (e.input || 0) + (e.output || 0), 0);
    const lines = Object.entries(by).map(([k, v]) =>
      `${k}: ${v.calls} calls · ${v.input.toLocaleString()} in · ${v.output.toLocaleString()} out`);
    const budget = BUDGET ? `\nMonthly budget: ${monthTokens().toLocaleString()} / ${BUDGET.toLocaleString()} tokens used` : "";
    return { content: [{ type: "text", text: `Usage (${period}): ${total.toLocaleString()} tokens\n${lines.join("\n") || "No calls yet."}${budget}` }] };
  }
);

// Where each provider shows spend, and how (if possible) to read the balance with a normal API key.
const DASHBOARDS = {
  moonshot: "https://platform.kimi.ai (Console → Billing)",
  kimi: "https://platform.kimi.ai (Console → Billing)",
  openai: "https://platform.openai.com/usage",
  openrouter: "https://openrouter.ai/activity",
  deepseek: "https://platform.deepseek.com/usage",
  gemini: "https://aistudio.google.com (Usage & billing)",
  anthropic: "the Claude Console (Usage page)",
};

async function fetchBalance() {
  const root = BASE_URL.replace(/\/v1$/, "");
  if (providerKey === "moonshot" || providerKey === "kimi") {
    const b = await http(`${BASE_URL}/users/me/balance`, { headers: headers() });
    const d = b.data ?? b;
    return `Available: ${d.available_balance} (cash ${d.cash_balance}, voucher ${d.voucher_balance})`;
  }
  if (providerKey === "deepseek") {
    const b = await http(`${root}/user/balance`, { headers: headers() });
    return (b.balance_infos ?? []).map((i) => `${i.currency} ${i.total_balance} (topped up ${i.topped_up_balance}, granted ${i.granted_balance})`).join("; ")
      + (b.is_available === false ? " — balance too low for API calls" : "");
  }
  if (providerKey === "openrouter") {
    const b = await http(`${BASE_URL}/key`, { headers: headers() });
    const d = b.data ?? b;
    const f = (n) => (n == null ? "—" : `$${Number(n).toFixed(4)}`);
    return `This key spent: today ${f(d.usage_daily)}, this week ${f(d.usage_weekly)}, this month ${f(d.usage_monthly)}, all time ${f(d.usage)}` +
      (d.limit != null ? ` · limit remaining ${f(d.limit_remaining)}` : "");
  }
  return null;
}

server.registerTool(
  "check_balance",
  {
    title: "Check balance on your key",
    description: `Show the remaining balance / spend on the user's ${preset.label} account straight from the provider, plus where to see it in their dashboard.`,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const problem = setupProblem();
    if (problem) return fail(problem);
    const where = `Full spend history: ${DASHBOARDS[providerKey] ?? "your provider's dashboard"}`;
    try {
      const bal = await fetchBalance();
      return { content: [{ type: "text", text: `${preset.label}: ${bal ?? "this provider doesn't expose balance to a normal API key."}\n${where}` }] };
    } catch (e) {
      return fail(`${e.message}\n${where}`);
    }
  }
);

await server.connect(new StdioServerTransport());
console.error(`[api-looper] ready — ${preset.label} at ${BASE_URL || "(no base URL)"}`);
