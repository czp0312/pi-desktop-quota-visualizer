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
const endpoint = "https://opencode.ai/zen/go/v1/usage";
const reply = (data, status = 200) => ({ status, bodyText: JSON.stringify(data) });
const usage = { usage: {
  rolling: { status: "ok", percent: 17, resetsAt: "2030-01-01T12:30:14.366Z" },
  weekly: { status: "ok", percent: 1, resetsAt: "2030-01-07T00:00:00.366Z" },
  monthly: { status: "ok", percent: 0.5, resetsAt: "2030-02-01T00:00:00.366Z" },
} };
function app({ settings = {}, files = {}, env = {}, fetcher = () => reply(usage), saveError = false } = {}) {
  const requests = [], reads = [];
  const sandbox = { Buffer, console, module: { exports: {} }, process: { env },
    pi: { plugin: { getSettings: async () => settings, setSettings: async (partial) => {
      if (saveError) throw new Error("private-key");
      Object.assign(settings, partial);
    } }, net: { fetch: async (input) => {
      requests.push(input); return fetcher(input);
    } } },
    require(name) {
      if (name === "./lib/oauth") return { createAuth: () => ({ listAccounts: async () => [] }) };
      if (name === "node:os") return { homedir: () => "/test-home" };
      if (name === "node:fs/promises") return {
        stat: async (file) => {
          reads.push(file);
          if (!(file in files)) throw new Error("missing");
          return { isFile: () => true, size: Buffer.byteLength(files[file]) };
        },
        readFile: async (file) => files[file],
      };
      return actualRequire(name);
    },
  };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { invoke: sandbox.module.exports.onPanelInvoke, requests, reads };
}
const credentialFile = "/test-home/.local/share/opencode/auth.json";
const credentials = JSON.stringify({ "opencode-go": { type: "api", key: "cli-private-key" } });

test("OpenCode Go manual key maps all windows, percentages and reset timestamps", async () => {
  const a = app({ settings: { autoDetect: false, credentials: { "opencode-go": "private-key" } } });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  const account = result.accounts[0];
  assert.equal(account.provider, "opencode-go");
  assert.equal(account.source, "settings");
  assert.equal(account.label, "OpenCode Go");
  assert.equal(account.status, "ok");
  assert.deepEqual(Array.from(account.windows, (w) => w.period), ["session", "week", "month"]);
  assert.deepEqual(Array.from(account.windows, (w) => w.remainingPercent), [83, 99, 99.5]);
  assert.equal(account.windows[0].windowMinutes, 300);
  assert.equal(account.windows[0].resetsAt, usage.usage.rolling.resetsAt);
  assert.equal(a.requests.length, 1);
  assert.equal(account.windows[2].windowMinutes, null);
  assert.equal(a.requests[0].url, endpoint);
  assert.equal(a.requests[0].method, "GET");
  assert.equal(a.requests[0].headers.authorization, "Bearer private-key");
  assert.equal(a.requests[0].timeoutMs, 8000);
  assert.equal(a.reads.length, 0);
  assert.ok(!JSON.stringify(result).includes("private-key"));
  assert.equal((await a.invoke("quota.snapshot", {})).cached, true);
  assert.equal(a.requests.length, 1);
  await a.invoke("quota.refresh", {});
  assert.equal(a.requests.length, 2);
});

test("OpenCode Go discovers only the local Go API key and keeps credentials off the panel", async () => {
  const a = app({ files: { [credentialFile]: credentials } });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].source, "cli");
  assert.equal(a.requests[0].headers.authorization, "Bearer cli-private-key");
  assert.ok(a.reads.includes(credentialFile));
  assert.ok(!JSON.stringify(result).includes("cli-private-key"));
});

test("OpenCode Go respects XDG_DATA_HOME", async () => {
  const a = app({ env: { XDG_DATA_HOME: "/custom-data" }, files: { "/custom-data/opencode/auth.json": credentials } });
  assert.equal((await a.invoke("quota.refresh", {})).accounts.length, 1);
  assert.ok(a.reads.includes("/custom-data/opencode/auth.json"));
  assert.ok(!a.reads.includes(credentialFile));
});

test("OpenCode Go manual key takes precedence over CLI", async () => {
  const a = app({ settings: { credentials: { "opencode-go": { apiKey: "manual-key" } } }, files: { [credentialFile]: credentials } });
  assert.equal((await a.invoke("quota.refresh", {})).accounts[0].source, "settings");
  assert.equal(a.requests[0].headers.authorization, "Bearer manual-key");
  assert.ok(!a.reads.includes(credentialFile));
});

test("OpenCode Go automatic discovery can be disabled", async () => {
  const a = app({ settings: { autoDetect: false }, files: { [credentialFile]: credentials } });
  assert.equal((await a.invoke("quota.refresh", {})).accounts.length, 0);
  assert.equal(a.requests.length, 0);
  assert.equal(a.reads.length, 0);
});

for (const [label, data] of Object.entries({
  missing: null,
  malformed: "{",
  zenOnly: JSON.stringify({ opencode: { type: "api", key: "zen-private" } }),
  oauthOnly: JSON.stringify({ "opencode-go": { type: "oauth", access: "oauth-private" } }),
  blank: JSON.stringify({ "opencode-go": { type: "api", key: "  " } }),
})) test(`OpenCode Go ignores ${label} credentials without making requests`, async () => {
  const a = app({ files: data === null ? {} : { [credentialFile]: data } });
  assert.equal((await a.invoke("quota.refresh", {})).accounts.length, 0);
  assert.equal(a.requests.length, 0);
});

test("OpenCode Go omits absent or invalid meters instead of fabricating available quota", async () => {
  const a = app({ settings: { autoDetect: false, credentials: { "opencode-go": "key" } }, fetcher: () => reply({ usage: {
    rolling: { percent: null }, weekly: { percent: "10" }, monthly: { percent: 0, resetsAt: "invalid-date" },
  } }) });
  const account = (await a.invoke("quota.refresh", {})).accounts[0];
  assert.equal(account.windows.length, 1);
  assert.equal(account.windows[0].period, "month");
  assert.equal(account.windows[0].remainingPercent, 100);
  assert.equal(account.windows[0].resetsAt, null);
});

for (const data of [null, {}, { balance: 42 }, { usage: { rolling: { percent: null } } }]) {
  test(`OpenCode Go empty payload ${JSON.stringify(data)} has no invented quota`, async () => {
    const a = app({ settings: { autoDetect: false, credentials: { "opencode-go": "key" } }, fetcher: () => reply(data) });
    const account = (await a.invoke("quota.refresh", {})).accounts[0];
    assert.equal(account.status, "empty");
    assert.equal(account.windows.length, 0);
    assert.match(account.hint, /Go/);
  });
}

test("OpenCode Go exhausted windows remain at zero", async () => {
  const a = app({ settings: { autoDetect: false, credentials: { "opencode-go": "key" } }, fetcher: () => reply({ usage: {
    rolling: { status: "rate-limited", percent: 100 }, weekly: { percent: 110 },
  } }) });
  const account = (await a.invoke("quota.refresh", {})).accounts[0];
  assert.deepEqual(Array.from(account.windows, (w) => w.remainingPercent), [0, 0]);
});

for (const status of [401, 403, 404, 429, 500]) test(`OpenCode Go HTTP ${status} is sanitized, with no fallback request`, async () => {
  const a = app({ settings: { autoDetect: false, credentials: { "opencode-go": "secret-key" } },
    fetcher: () => reply({ error: "secret-key" }, status) });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "error");
  assert.match(result.accounts[0].error, new RegExp(String(status)));
  assert.ok(!JSON.stringify(result).includes("secret-key"));
  assert.equal(a.requests.length, 1);
  assert.equal(a.requests[0].url, endpoint);
});

test("OpenCode Go network error never exposes credentials", async () => {
  const a = app({ settings: { autoDetect: false, credentials: { "opencode-go": "secret-key" } },
    fetcher: () => { throw new Error("Bearer secret-key"); } });
  const result = await a.invoke("quota.refresh", {});
  assert.equal(result.accounts[0].status, "error");
  assert.match(result.accounts[0].error, /NETWORK/);
  assert.ok(!JSON.stringify(result).includes("secret-key"));
});

test("OpenCode Go requests no credentials or network in demo mode", async () => {
  const a = app({ settings: { demoMode: true, credentials: { "opencode-go": "key" } }, files: { [credentialFile]: credentials } });
  assert.equal((await a.invoke("quota.refresh", {})).demo, true);
  assert.equal(a.reads.length, 0);
  assert.equal(a.requests.length, 0);
});

test("OpenCode Go endpoint is permitted by the plugin manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../manifest.json"), "utf8"));
  assert.ok(manifest.net.domains.includes(new URL(endpoint).hostname));
});

test("panel saves and removes a Go key without replacing other settings, and invalidates cache", async () => {
  const settings = { autoDetect: false, credentials: JSON.stringify({ "github-copilot": "other-key" }), refreshSeconds: 120 };
  const a = app({ settings, fetcher: (req) => req.url === endpoint ? reply(usage) : reply({}) });
  await a.invoke("quota.snapshot", {});
  const saved = await a.invoke("quota.opencode.configure", { token: " private-key " });
  assert.equal(saved.ok, true);
  assert.ok(!JSON.stringify(saved).includes("private-key"));
  assert.equal(settings.credentials["github-copilot"], "other-key");
  assert.equal(settings.credentials["opencode-go"], "private-key");
  assert.equal(settings.refreshSeconds, 120);
  assert.ok((await a.invoke("quota.snapshot", {})).accounts.some((a) => a.provider === "opencode-go"));
  assert.equal((await a.invoke("quota.opencode.configure", { remove: true })).ok, true);
  assert.equal(settings.credentials["opencode-go"], undefined);
  assert.equal(settings.credentials["github-copilot"], "other-key");
  assert.ok(!(await a.invoke("quota.snapshot", {})).accounts.some((a) => a.provider === "opencode-go"));
});

test("panel rejects empty/invalid keys, demo writes, and sanitizes save errors", async () => {
  const a = app({ settings: { autoDetect: false } });
  for (const token of ["", "  ", "has space", "x".repeat(8193)]) {
    assert.equal((await a.invoke("quota.opencode.configure", { token })).code, "INVALID_KEY");
  }
  const demo = app({ settings: { demoMode: true } });
  assert.equal((await demo.invoke("quota.opencode.configure", { token: "key" })).code, "DEMO_MODE");
  assert.equal((await demo.invoke("quota.opencode.configure", { remove: true })).code, "DEMO_MODE");
  const broken = app({ saveError: true });
  const failure = await broken.invoke("quota.opencode.configure", { token: "private-key" });
  assert.equal(failure.code, "SAVE_FAILED");
  assert.ok(!JSON.stringify(failure).includes("private-key"));
});
