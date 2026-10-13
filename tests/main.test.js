"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const file = path.resolve(__dirname, "../main.js");
const actualRequire = createRequire(file);
const code = fs.readFileSync(file, "utf8");
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
function app(settings = {}, pluginCredentials = {}, fetcher, summaryFetcher = () => reply({}, 404)) {
  let changed, cliReads = 0;
  // Existing fixtures exercise the model fallback. New summary fixtures record every request too.
  const requests = [], summaryRequests = [], allRequests = [];
  let records = Array.isArray(pluginCredentials) ? pluginCredentials : Object.entries(pluginCredentials).map(([vendor, credential]) =>
    ({ id: `saved-${vendor}`, vendor, label: `${vendor} 1`, credential }));
  const metadata = () => records.map((r) => ({ id: r.id, vendor: r.vendor, label: r.label,
    priority: records.filter((a) => a.vendor === r.vendor).indexOf(r) + 1, connected: true }));
  const auth = {
    listAccounts: async () => metadata(),
    credential: async (id) => records.find((r) => r.id === id)?.credential ?? null,
    status: async () => ({ ok: true, accounts: metadata(), login: null }),
    logout: async (id) => { records = records.filter((r) => r.id !== id); changed(); return auth.status(); },
    move: async (id, direction) => {
      const i = records.findIndex((r) => r.id === id), j = i + (direction === "up" ? -1 : 1);
      [records[i], records[j]] = [records[j], records[i]]; changed(); return auth.status();
    },
    stop: async () => {},
    start: async () => { throw new Error("must not start in demo"); },
  };
  const pi = { plugin: { getSettings: async () => settings, setSettings: async (partial) => Object.assign(settings, partial) },
    commands: { unregister: async () => {} }, net: { fetch: async (input) => {
      allRequests.push(input);
      if (input.url.endsWith(":retrieveUserQuotaSummary")) { summaryRequests.push(input); return summaryFetcher(input); }
      requests.push(input); return fetcher(input);
    } } };
  const sandbox = { pi, module: { exports: {} }, console, Buffer,
    require(name) {
      if (name === "./lib/oauth") return { createAuth: (_pi, opts) => { changed = opts.onChange; return auth; } };
      if (name === "node:fs/promises") return { stat: async () => { cliReads++; throw new Error("no CLI installed"); } };
      if (name === "node:os") return { homedir: () => "/nonexistent-home" };
      return actualRequire(name);
    }, process: { env: {} } };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { invoke: sandbox.module.exports.onPanelInvoke, requests, summaryRequests, allRequests, get cliReads() { return cliReads; } };
}

test("plugin login drives ChatGPT quota with autoDetect off and no CLI", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "private-plugin-token", accountId: "acct-1", source: "plugin" } }, () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 75);
  assert.equal(a.requests[0].headers["chatgpt-account-id"], "acct-1");
  assert.equal(a.requests[0].headers.authorization, "Bearer private-plugin-token");
  assert.equal(a.cliReads, 0);
  assert.ok(!JSON.stringify(result).includes("private-plugin-token"));
  await a.invoke("quota.auth.logout", { accountId: "saved-openai-codex" });
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("manual tokens and plugin accounts are displayed independently with autoDetect off", async () => {
  const a = app({ autoDetect: false, credentials: { "openai-codex": { token: "manual", accountId: "manual-acct" }, openrouter: "or-key" } },
    { "openai-codex": { token: "plugin" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 3);
  const req = a.requests.find((r) => r.headers.authorization === "Bearer manual");
  assert.equal(req.headers.authorization, "Bearer manual");
  assert.equal(req.headers["chatgpt-account-id"], "manual-acct");
  assert.equal(a.cliReads, 0);
});

test("CLI discovery is optional fallback only", async () => {
  const a = app({ autoDetect: true }, { anthropic: { token: "saved" } }, () => reply({}));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].provider, "anthropic");
  assert.ok(a.cliReads > 0);
});

test("demo is offline and refuses new OAuth starts", async () => {
  const a = app({ demoMode: true, autoDetect: true });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.demo, true);
  assert.ok(result.accounts.length > 0);
  assert.equal(a.requests.length, 0);
  assert.equal(a.cliReads, 0);
  assert.equal((await a.invoke("quota.auth.start", { vendor: "openai-codex" })).code, "DEMO_MODE");
});

test("a revoked credential surfaces 401 without repeating another usage endpoint or leaking body", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "secret" } }, () => reply({ error: "secret" }, 401));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "error");
  assert.match(result.accounts[0].error, /401/);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(a.requests.length, 1);
});

test("logout invalidates an in-flight snapshot instead of caching the previous account", async () => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const a = app({ autoDetect: false }, { anthropic: { token: "old" } }, () => pending);
  const snapshot = a.invoke("quota.refresh", {});
  await new Promise((r) => setImmediate(r));
  await a.invoke("quota.auth.logout", { accountId: "saved-anthropic" });
  resolve(reply({ five_hour: { utilization: 10 } }));
  assert.equal((await snapshot).code, "AUTH_CHANGED");
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.length, 0);
});

test("generic mapped windows accept second-based periods without window_minutes", async () => {
  const a = app({ autoDetect: false, sources: [{ vendor: "xai", url: "https://api.x.ai/quota", token: "manual",
    windows: [{ path: "rate_limit" }] }] }, {}, () => reply({ rate_limit: { used_percent: 20, limit_window_seconds: 18000 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "ok");
  assert.equal(result.accounts[0].windows[0].windowMinutes, 300);
  assert.equal(result.accounts[0].windows[0].remainingPercent, 80);
});

test("multiple ChatGPT accounts keep headers isolated; exhausted/error accounts are not recommended", async () => {
  const records = ["a", "b", "c"].map((id) => ({ id, vendor: "openai-codex", label: `Account ${id}`,
    credential: { token: `private-${id}`, accountId: `upstream-${id}`, source: "plugin" } }));
  const a = app({ autoDetect: false }, records, (req) => {
    const id = req.headers.authorization.slice(-1);
    assert.equal(req.headers["chatgpt-account-id"], `upstream-${id}`);
    if (id === "c") return reply({}, 401);
    return reply({ rate_limit: { primary_window: { used_percent: id === "a" ? 100 : 20, limit_window_seconds: 18000 } } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.deepEqual(Array.from(result.accounts, (r) => r.id), ["plugin:a", "plugin:b", "plugin:c"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.availability), ["exhausted", "available", "unknown"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.recommended), [false, true, false]);
  assert.ok(!JSON.stringify(result).includes("private-"));
  assert.ok(!JSON.stringify(result).includes("upstream-"));
  await a.invoke("quota.auth.logout", { accountId: "a" });
  assert.deepEqual(Array.from((await a.invoke("quota.snapshot", {})).accounts, (r) => r.id), ["plugin:b", "plugin:c"]);
});

test("priority changes invalidate the snapshot cache and change the recommendation", async () => {
  const a = app({ autoDetect: false }, ["a", "b"].map((id) => ({ id, vendor: "anthropic", label: id,
    credential: { token: id, source: "plugin" } })), () => reply({ five_hour: { utilization: 10 } }));
  assert.equal((await a.invoke("quota.snapshot", {})).accounts.find((r) => r.recommended).id, "plugin:a");
  await a.invoke("quota.auth.move", { accountId: "b", direction: "up" });
  const snapshot = await a.invoke("quota.snapshot", {});
  assert.equal(snapshot.accounts[0].id, "plugin:b");
  assert.equal(snapshot.accounts[0].priority, 1);
  assert.equal(snapshot.accounts[0].recommended, true);
});

const fakeJwt = (claims) => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

test("ChatGPT plugin account prefers the profile name and still carries the email", async () => {
  const token = fakeJwt({ "https://api.openai.com/profile": { name: "山口 愛", email: "alice@example.com" } });
  const a = app({ autoDetect: false }, { "openai-codex": { token, accountId: "acct-1", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro) · 山口 愛");
  assert.equal(result.accounts[0].identity, "山口 愛");
  assert.equal(result.accounts[0].email, "alice@example.com");
  assert.equal(result.accounts[0].vendorName, "OpenAI (ChatGPT Plus/Pro)");
  assert.ok(!JSON.stringify(result).includes(token));
});

test("ChatGPT plugin account falls back to the email when the token has no name", async () => {
  const token = fakeJwt({ "https://api.openai.com/profile": { email: "alice@example.com" } });
  const a = app({ autoDetect: false }, { "openai-codex": { token, accountId: "acct-1", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro) · alice@example.com");
  assert.equal(result.accounts[0].identity, "alice@example.com");
});

test("ChatGPT account without a readable email falls back to the vendor name, not the default number", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "opaque-token", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "OpenAI (ChatGPT Plus/Pro)");
  assert.equal(result.accounts[0].identity, null);
});

test("Copilot plugin account shows the detected GitHub login", async () => {
  const a = app({ autoDetect: false }, { "github-copilot": { token: "gh", source: "plugin" } },
    () => reply({ login: "octocat", copilot_plan: "individual" }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "GitHub Copilot · octocat");
  assert.equal(result.accounts[0].identity, "octocat");
});

test("Claude plugin account shows the email from the OAuth profile endpoint", async () => {
  const a = app({ autoDetect: false }, { anthropic: { token: "claude-token", source: "plugin" } }, (req) =>
    req.url.includes("/api/oauth/profile")
      ? reply({ account: { uuid: "u1", email: "claude@example.com" } })
      : reply({ five_hour: { utilization: 10 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].label, "Anthropic (Claude Pro/Max) · claude@example.com");
  assert.equal(result.accounts[0].identity, "claude@example.com");
  assert.ok(!JSON.stringify(result).includes("claude-token"));
});

test("a stored Claude email skips the profile request", async () => {
  const a = app({ autoDetect: false }, { anthropic: { token: "t", email: "stored@example.com", source: "plugin" } }, (req) => {
    assert.ok(!req.url.includes("/api/oauth/profile"), "profile must not be fetched when the email is already known");
    return reply({ five_hour: { utilization: 10 } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].identity, "stored@example.com");
});

test("a failing Claude profile request only loses the name, not the quota", async () => {
  const a = app({ autoDetect: false }, { anthropic: { token: "t", source: "plugin" } }, (req) =>
    req.url.includes("/api/oauth/profile") ? reply({ error: "nope" }, 500) : reply({ five_hour: { utilization: 10 } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "ok");
  assert.equal(result.accounts[0].label, "Anthropic (Claude Pro/Max)");
  assert.equal(result.accounts[0].identity, null);
});

test("a stored ChatGPT email wins over the access token claims", async () => {
  const a = app({ autoDetect: false }, { "openai-codex": { token: "opaque", email: "id@example.com", source: "plugin" } },
    () => reply({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].identity, "id@example.com");
});

test("Antigravity plugin account queries its project then model quota without CLI or token leakage", async () => {
  const a = app({ autoDetect: false }, { "google-antigravity": { token: "google-private-access", source: "plugin", email: "me@example.com" } },
    (req) => req.url.endsWith(":loadCodeAssist") ? reply({ cloudaicompanionProject: { id: "private-project" }, currentTier: { id: "pro-tier" } })
      : reply({ models: { gemini: { displayName: "Gemini Pro", quotaInfo: { remainingFraction: 0.8, resetTime: "2030-01-01T00:00:00Z" } } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  const row = result.accounts[0];
  assert.equal(row.label, "Google Antigravity · me@example.com");
  assert.equal(row.plan, "pro-tier");
  assert.equal(row.windows[0].remainingPercent, 80);
  assert.equal(row.windows[0].labelKey, "window.antigravity.gemini");
  assert.equal(row.windows[0].members[0].customLabel, "Gemini Pro");
  assert.equal(row.recommended, true);
  assert.equal(a.requests.length, 2);
  assert.equal(a.requests[0].method, "POST");
  assert.deepEqual(JSON.parse(a.requests[0].body).metadata, { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" });
  assert.equal(JSON.parse(a.requests[0].headers["client-metadata"]).ideType, "ANTIGRAVITY");
  assert.equal(a.requests[0].headers["user-agent"], "google-api-nodejs-client/9.15.1");
  assert.equal(JSON.parse(a.requests[1].body).project, "private-project");
  assert.ok(a.requests.every((r) => r.headers.authorization === "Bearer google-private-access"));
  assert.equal(a.requests[0].timeoutMs, 8000);
  assert.equal(a.requests[1].timeoutMs, 4000);
  assert.equal(a.summaryRequests.length, 3);
  assert.equal(a.allRequests.length, 5);
  assert.equal(a.cliReads, 0);
  for (const secret of ["google-private-access", "private-project"]) assert.ok(!JSON.stringify(result).includes(secret));
});

test("Antigravity manual and plugin tokens remain independent; models without quota stay unknown", async () => {
  const a = app({ autoDetect: false, credentials: { "google-antigravity": "manual-google" } },
    { "google-antigravity": { token: "plugin-google", source: "plugin" } },
    (req) => req.url.endsWith(":loadCodeAssist") ? reply({ cloudaicompanionProject: "project" }) : reply({ models: { gemini: { quotaInfo: {} } } }));
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 2);
  assert.ok(result.accounts.every((r) => r.status === "empty" && r.windows.length === 0 && r.recommended !== true));
  assert.equal(a.requests.filter((r) => r.headers.authorization === "Bearer manual-google").length, 2);
  assert.equal(a.requests.filter((r) => r.headers.authorization === "Bearer plugin-google").length, 2);
});

test("Antigravity HTTP/network errors are actionable and do not echo upstream data", async () => {
  for (const mode of ["revoked", "quota-error", "network"]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-google-secret" } }, {}, (req) => {
      if (mode === "network") throw Error("private-google-secret");
      if (mode === "revoked") return reply({ error: "private-google-secret" }, 401);
      return req.url.endsWith(":loadCodeAssist") ? reply({ cloudaicompanionProject: "project" }) : reply({ error: "private-google-secret" }, 503);
    });
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.status, "error");
    assert.ok(!JSON.stringify(row).includes("private-google-secret"));
    assert.equal(a.requests.length, mode === "quota-error" ? 2 : 1);
  }
});

test("Antigravity multi-account projects stay isolated and exhaustion blocks only that account", async () => {
  const a = app({ autoDetect: false }, ["a", "b"].map((id) => ({ id, vendor: "google-antigravity", label: id,
    credential: { token: `google-private-${id}`, source: "plugin" } })), (req) => {
    const id = req.headers.authorization.slice(-1);
    if (req.url.endsWith(":loadCodeAssist")) return reply({ cloudaicompanionProject: `project-${id}` });
    assert.equal(JSON.parse(req.body).project, `project-${id}`);
    return reply({ models: { gemini: { quotaInfo: { remainingFraction: id === "a" ? 0 : 0.9 } } } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.deepEqual(Array.from(result.accounts, (r) => r.availability), ["exhausted", "available"]);
  assert.deepEqual(Array.from(result.accounts, (r) => r.recommended), [false, true]);
  await a.invoke("quota.auth.logout", { accountId: "a" });
  assert.equal((await a.invoke("quota.snapshot", {})).accounts[0].id, "plugin:b");
});

test("Antigravity is absent without credentials and demo mode does not query Google", async () => {
  const a = app({ autoDetect: false });
  assert.equal((await a.invoke("quota.refresh", {})).accounts.length, 0);
  assert.equal(a.requests.length, 0);
  const demo = app({ demoMode: true }, { "google-antigravity": { token: "private-google-token" } });
  assert.equal((await demo.invoke("quota.refresh", {})).demo, true);
  assert.equal(demo.requests.length, 0);
  assert.equal((await demo.invoke("quota.auth.start", { vendor: "google-antigravity" })).code, "DEMO_MODE");
});

test("Antigravity project discovery passes a strict enum contract instead of reproducing metadata HTTP 400", async () => {
  const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-google-token" } }, {}, (req) => {
    if (req.url.endsWith(":loadCodeAssist")) {
      const meta = JSON.parse(req.body).metadata;
      if (meta.ideType !== "IDE_UNSPECIFIED" || meta.platform !== "PLATFORM_UNSPECIFIED" || meta.pluginType !== "GEMINI")
        return reply({ error: { status: "INVALID_ARGUMENT", message: "Invalid enum value" } }, 400);
      return reply({ cloudaicompanionProject: "project" });
    }
    assert.equal(JSON.parse(req.body).project, "project");
    return reply({ models: { gemini: { quotaInfo: { remainingFraction: 0.8 } } } });
  });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "ok");
  assert.equal(result.accounts[0].windows[0].remainingPercent, 80);
  assert.equal(a.requests.length, 2);
});

test("Antigravity HTTP 400 identifies the failed endpoint with safe status/field diagnostics", async () => {
  for (const step of ["loadCodeAssist", "fetchAvailableModels"]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-google-secret" } }, {}, (req) =>
      req.url.endsWith(`:${step}`) ? reply({ error: { status: "INVALID_ARGUMENT", message: "private-google-secret", details: [{ fieldViolations: [
        { field: "metadata.platform", description: "private-google-secret" }, { field: "private-google-secret", description: "private-google-secret" },
      ] }] } }, 400) : reply({ cloudaicompanionProject: "project" }));
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.status, "error");
    assert.ok(row.error.includes(step));
    assert.match(row.error, /HTTP 400/);
    assert.match(row.error, /INVALID_ARGUMENT, metadata.platform/);
    assert.ok(!JSON.stringify(row).includes("private-google-secret"));
    assert.equal(a.requests.length, step === "loadCodeAssist" ? 1 : 2);
  }
});

test("Antigravity without a project queries account-scoped model quotas using an empty JSON body", async () => {
  for (const context of [{}, { currentTier: { id: "pro-tier" } }, { cloudaicompanionProject: { id: " " } }]) {
    const a = app({ autoDetect: false }, { "google-antigravity": { token: "private-google-token", source: "plugin" } }, (req) => {
      if (req.url.endsWith(":loadCodeAssist")) return reply(context);
      assert.ok(req.url.endsWith(":fetchAvailableModels"));
      assert.equal(req.method, "POST");
      assert.deepEqual(JSON.parse(req.body), {});
      return reply({ models: { gemini: { quotaInfo: { remainingFraction: 0.8 } } } });
    });
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.status, "ok");
    assert.equal(row.windows[0].remainingPercent, 80);
    assert.equal(row.plan, context.currentTier?.id ?? null);
    assert.equal(row.recommended, true);
    assert.equal(a.requests.length, 2);
    assert.ok(!JSON.stringify(row).includes("private-google-token"));
  }
});

test("Antigravity empty no-project quota remains unknown; API rejection retains safe endpoint diagnostics", async () => {
  for (const status of [200, 400, 403]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-google-token" } }, {}, (req) => {
      if (req.url.endsWith(":loadCodeAssist")) return reply({});
      assert.deepEqual(JSON.parse(req.body), {});
      return reply(status === 200 ? {} : { error: { status: "FAILED_PRECONDITION", message: "private-google-token" } }, status);
    });
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.windows.length, 0);
    assert.equal(row.recommended === true, false);
    assert.equal(a.requests.length, 2);
    assert.ok(!JSON.stringify(row).includes("private-google-token"));
    if (status === 200) { assert.equal(row.status, "empty"); assert.match(row.hint, /缺失 5 小时\/7 天窗口不占位/); }
    else { assert.equal(row.status, "error"); assert.match(row.error, /fetchAvailableModels.*无项目查询/); }
  }
});

test("Antigravity missing project on one account never reuses a sibling account's project", async () => {
  const a = app({ autoDetect: false }, ["a", "b"].map((id) => ({ id, vendor: "google-antigravity", label: id,
    credential: { token: `private-google-${id}`, source: "plugin" } })), (req) => {
    const id = req.headers.authorization.slice(-1);
    if (req.url.endsWith(":loadCodeAssist")) return reply(id === "a" ? { cloudaicompanionProject: "project-a" } : {});
    assert.deepEqual(JSON.parse(req.body), id === "a" ? { project: "project-a" } : {});
    return reply({ models: { gemini: { quotaInfo: { remainingFraction: 0.9 } } } });
  });
  const rows = (await a.invoke("quota.refresh", {})).accounts;
  assert.ok(rows.every((r) => r.status === "ok"));
  assert.equal(a.requests.length, 4);
});

test("Antigravity group summaries preserve original freshness for account recommendations", async () => {
  const a = app({ autoDetect: false }, { "google-antigravity": { token: "private", source: "plugin" } },
    (req) => req.url.endsWith(":loadCodeAssist") ? reply({}) : reply({ models: {
      "gemini-low": { quotaInfo: { remainingFraction: 0.2, resetTime: "2030-01-01T00:00:00Z" } },
      "gemini-stale": { quotaInfo: { remainingFraction: 0.8, resetTime: "2000-01-01T00:00:00Z" } },
      claude: { quotaInfo: { remainingFraction: 1 } },
    } }));
  const row = (await a.invoke("quota.refresh", {})).accounts[0];
  assert.equal(row.windows.length, 2);
  assert.equal(row.windows[0].remainingPercent, 20);
  assert.equal(row.availability, "unknown");
  assert.equal(row.recommended, false);
});

test("Antigravity snapshots no longer include diagnostics and the removed channel makes no requests", async () => {
  const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token" } }, {},
    (req) => req.url.endsWith(":loadCodeAssist") ? reply({}) : reply({ models: {
      gemini: { quotaInfo: { remainingFraction: 0.8 } },
    } }));
  const row = (await a.invoke("quota.refresh", {})).accounts[0];
  assert.equal(row.status, "ok");
  assert.equal(row.windows[0].remainingPercent, 80);
  assert.equal(Object.hasOwn(row, "diagnostics"), false);
  const requests = a.allRequests.length;
  assert.equal((await a.invoke("quota.diagnostics", { accountId: row.id })).ok, false);
  assert.equal(a.allRequests.length, requests);
  assert.equal(Object.hasOwn((await a.invoke("quota.snapshot", {})).accounts[0], "diagnostics"), false);
});

test("Antigravity failures retain safe endpoint errors without diagnostics", async () => {
  for (const step of ["loadCodeAssist", "fetchAvailableModels"]) for (const mode of ["http", "network"]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token" } }, {}, (req) => {
      if (!req.url.endsWith(`:${step}`)) return reply({});
      if (mode === "network") throw new Error("PRIVATE-NETWORK-EXCEPTION");
      return reply({ error: { message: "PRIVATE-HTTP-BODY" }, models: { "PRIVATE-DYNAMIC-KEY": { quotaInfo: { remainingFraction: 1, period: "week" } } } }, 400);
    });
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.status, "error");
    assert.equal(row.windows.length, 0);
    assert.equal(Object.hasOwn(row, "diagnostics"), false);
    if (mode === "http") assert.match(row.error, new RegExp(step));
    assert.equal(a.requests.length, step === "loadCodeAssist" ? 1 : 2);
    for (const secret of ["private-token", "PRIVATE-NETWORK-EXCEPTION", "PRIVATE-HTTP-BODY", "PRIVATE-DYNAMIC-KEY"]) assert.ok(!row.error.includes(secret));
  }
});

test("Antigravity empty and malformed quotas stay empty without diagnostics or fake windows", async () => {
  for (const data of [{}, { models: { gemini: { quotaInfo: {} } } }, { models: { gemini: { quotaInfo: { remainingFraction: "invalid-private-value" } } } }, null]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token", openrouter: "private-key" } }, {},
      (req) => req.url.endsWith(":loadCodeAssist") ? reply({}) : reply(data));
    const rows = (await a.invoke("quota.refresh", {})).accounts;
    const google = rows.find((r) => r.provider === "google-antigravity");
    assert.equal(google.status, "empty");
    assert.equal(google.windows.length, 0);
    assert.equal(google.diagnostics, undefined);
    const router = rows.find((r) => r.provider === "openrouter");
    assert.equal(router.diagnostics, undefined);
    assert.equal(a.requests.length, 3);
  }
});

test("Antigravity authorization failure has no diagnostics; refreshing still updates quota summaries", async () => {
  const noCredential = app({ autoDetect: false }, [{ id: "deleted", vendor: "google-antigravity", label: "old", credential: null }]);
  const errorRow = (await noCredential.invoke("quota.refresh", {})).accounts[0];
  assert.equal(errorRow.status, "error");
  assert.equal(errorRow.diagnostics, undefined);
  assert.equal(noCredential.requests.length, 0);
  let fraction = 0.7;
  const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token" } }, {},
    (req) => req.url.endsWith(":loadCodeAssist") ? reply({}) : reply({ models: { gemini: { quotaInfo: { remainingFraction: fraction } } } }));
  assert.equal((await a.invoke("quota.refresh", {})).accounts[0].windows[0].remainingPercent, 70);
  fraction = 0.5;
  assert.equal((await a.invoke("quota.refresh", {})).accounts[0].windows[0].remainingPercent, 50);
  assert.equal(a.requests.length, 4);
});

test("Antigravity summary endpoint supplies all four explicit windows without fetching model list", async () => {
  const groups = ["Gemini", "Claude"].map((displayName) => ({ displayName, buckets: [
    { window: "5h", remaining_fraction: 0.8, reset_time: "2030-01-01T00:00:00Z" },
    { window: "weekly", remainingFraction: "40%", resetTime: "2030-01-08T00:00:00Z" },
  ] }));
  const a = app({ autoDetect: false }, { "google-antigravity": { token: "private-token", email: "me@example.test", source: "plugin" } },
    (req) => { assert.ok(req.url.endsWith(":loadCodeAssist")); return reply({ projectId: "private-project" }); },
    (req) => { assert.deepEqual(JSON.parse(req.body), { project: "private-project" }); assert.equal(req.headers.authorization, "Bearer private-token"); return reply({ body: JSON.stringify({ groups }) }); });
  const row = (await a.invoke("quota.refresh", {})).accounts[0];
  assert.equal(row.quotaSource, "summary");
  assert.equal(row.status, "ok");
  assert.deepEqual(Array.from(row.windows, (w) => [w.period, w.remainingPercent]), [["session", 80], ["week", 40], ["session", 80], ["week", 40]]);
  assert.equal(a.allRequests.length, 2);
  assert.ok(a.summaryRequests[0].url.startsWith("https://daily-cloudcode-pa.googleapis.com/"));
  assert.equal(a.summaryRequests[0].method, "POST");
  assert.equal(a.summaryRequests[0].timeoutMs, 2000);
  assert.equal(row.diagnostics, undefined);
});

test("Antigravity summary retries empty/error endpoints in reference order; missing windows do not appear", async () => {
  const { SUMMARY_ENDPOINTS } = require("../lib/antigravity-summary");
  let index = 0;
  const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token" } }, {},
    (req) => { assert.ok(req.url.endsWith(":loadCodeAssist")); return reply({}); }, (req) => {
      assert.equal(req.url, `${SUMMARY_ENDPOINTS[index]}/v1internal:retrieveUserQuotaSummary`);
      assert.deepEqual(JSON.parse(req.body), {});
      return ++index === 1 ? reply({ groups: [] }) : index === 2 ? reply({}, 500)
        : reply({ groups: [{ display_name: "Gemini", buckets: [{ window: "week", remaining_fraction: 0.6 }] }] });
    });
  const row = (await a.invoke("quota.refresh", {})).accounts[0];
  assert.equal(row.quotaSource, "summary");
  assert.equal(row.windows.length, 1);
  assert.equal(row.windows[0].period, "week");
  assert.equal(row.windows[0].remainingPercent, 60);
  assert.equal(a.allRequests.length, 4);
});

test("summary failures or unknown windows fall back to unclassified readings without inventing session/week", async () => {
  for (const mode of ["empty", "network", "unknown"]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token" } }, {},
      (req) => req.url.endsWith(":loadCodeAssist") ? reply({}) : reply({ models: { gemini: { quotaInfo: { remainingFraction: 0.7 } } } }),
      () => { if (mode === "network") throw Error("PRIVATE-FAILURE"); return reply(mode === "empty" ? {} : { groups: [{ displayName: "Gemini", buckets: [{ remainingFraction: 0.4, resetTime: "2030-01-08T00:00:00Z" }] }] }); });
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.quotaSource, "model-fallback");
    assert.equal(row.windows[0].period, "other");
    assert.equal(row.windows[0].remainingPercent, 70);
    assert.match(row.note, /未分类额度汇总/);
    assert.equal(a.allRequests.length, 5);
    assert.equal(a.allRequests.reduce((n, req) => n + req.timeoutMs, 8000), 26000); // includes possible token refresh
    assert.equal(row.diagnostics, undefined);
  }
});

test("summary unauthorized responses stop without model-list fallback; account projects stay isolated", async () => {
  for (const status of [401, 403]) {
    const a = app({ autoDetect: false, credentials: { "google-antigravity": "private-token" } }, {}, () => reply({}), () => reply({ error: "private-token" }, status));
    const row = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(row.status, "error");
    assert.match(row.error, /retrieveUserQuotaSummary/);
    assert.equal(a.allRequests.length, 2);
    assert.ok(!row.error.includes("private-token"));
  }
  const a = app({ autoDetect: false }, ["a", "b"].map((id) => ({ id, vendor: "google-antigravity", label: id, credential: { token: id, source: "plugin" } })),
    (req) => reply({ project: { id: `project-${req.headers.authorization.slice(-1)}` } }),
    (req) => { const id = req.headers.authorization.slice(-1); assert.equal(JSON.parse(req.body).project, `project-${id}`);
      return reply({ groups: [{ displayName: "Gemini", buckets: [{ window: "5h", remainingFraction: id === "a" ? 0 : 0.9 }] }] }); });
  const rows = (await a.invoke("quota.refresh", {})).accounts;
  assert.deepEqual(Array.from(rows, (r) => r.availability), ["exhausted", "available"]);
  assert.deepEqual(Array.from(rows, (r) => r.recommended), [false, true]);
  assert.equal(a.allRequests.length, 4);
});
