"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../main.js');
const actualRequire = createRequire(file);
const code = fs.readFileSync(file, 'utf8');
function app({ fetcher, demo = false, active = true, accounts = [], clock, refreshSeconds = 60, saved = {}, saveFails = false } = {}) {
  const settings = { autoDetect: false, demoMode: demo, accounts, refreshSeconds, credentials: demo ? {} : { 'opencode-go': 'private-key' }, ...saved };
  const calls = [], commands = [];
  const sandbox = { Buffer, console, module: { exports: {} }, process: { env: {} }, require(name) {
    if (name === './lib/oauth') return { createAuth: () => ({ listAccounts: async () => [], stop: async () => {} }) };
    return actualRequire(name);
  }, pi: {
    plugin: { getSettings: async () => settings, setSettings: async (patch) => { if (saveFails) throw new Error('disk'); Object.assign(settings, patch); } },
    commands: { register: async (x) => commands.push(x), unregister: async (x) => calls.push(['unregister', x]) },
    session: { getActive: async () => active ? { sessionId: 'current-session' } : null },
    ui: { openPanel: async (x) => calls.push(['panel', x]), revealView: async (x) => calls.push(['view', x]) },
    net: { fetch: fetcher || (async () => ({ status: 200, bodyText: JSON.stringify({ usage: { rolling: { percent: 17 } } }) })) },
  } };
  if (clock) sandbox.Date = class extends Date { static now() { return clock.now; } };
  vm.runInNewContext(code, sandbox, { filename: file });
  return { ...sandbox.module.exports, calls, commands, settings };
}
const settle = () => new Promise((r) => setImmediate(r));

test('compact renderer call returns immediately while quota network is pending and deduplicates refresh', async () => {
  let resolve, requests = 0;
  const pending = new Promise((r) => { resolve = r; });
  const a = app({ fetcher: () => { requests++; return pending; } });
  const first = await a.onRendererCall('compact', {});
  assert.equal(first.loading, true);
  assert.equal(first.accounts.length, 0);
  await settle();
  await a.onRendererCall('compact', { force: true });
  assert.equal(requests, 1);
  resolve({ status: 200, bodyText: JSON.stringify({ usage: { rolling: { percent: 17 } } }) });
  await settle();
  const next = await a.onRendererCall('compact', {});
  assert.equal(next.loading, false);
  assert.equal(next.accounts[0].windows[0].remainingPercent, 83);
  assert.ok(!JSON.stringify(next).includes('private-key'));
  assert.equal(requests, 1);
  await a.onRendererCall('compact', { force: true });
  await settle();
  assert.equal(requests, 2);
});

test('panel bridge and renderer share snapshots; error bodies never reach compact data', async () => {
  const a = app({ fetcher: async () => ({ status: 401, bodyText: 'private-key' }) });
  await a.onPanelInvoke('quota.compact', {});
  await settle();
  const data = await a.onRendererCall('compact', {});
  assert.equal(data.accounts[0].status, 'error');
  assert.ok(!JSON.stringify(data).includes('private-key'));
  assert.equal((await a.onPanelInvoke('quota.compact', {})).accounts[0].id, data.accounts[0].id);
});

test('renderer detail action uses active-session view and rejects removed widget action', async () => {
  const a = app({ demo: true });
  await assert.rejects(a.onRendererCall('widget', {}));
  await a.onRendererCall('details', {});
  assert.equal(a.calls[0][0], 'view');
  assert.equal(a.calls[0][1].viewId, 'quota');
  assert.equal(a.calls[0][1].sessionId, 'current-session');
  await assert.rejects(a.onRendererCall('unknown', {}));
  const home = app({ active: false });
  await assert.rejects(home.onRendererCall('details', {}), /请先打开/);
  assert.equal((await home.onPanelInvoke('quota.details', {})).ok, false);
});

test('full-panel command registers, opens, and unregisters; demo compact is offline', async () => {
  const a = app({ demo: true, fetcher: () => { throw new Error('must stay offline'); } });
  await a.onLoad();
  await settle();
  assert.equal(a.commands[0].id, 'quota.open');
  await a.commands[0].run();
  const data = await a.onRendererCall('compact', {});
  assert.equal(data.demo, true);
  assert.ok(data.accounts.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 60 * 1024);
  await a.onUnload();
  assert.ok(a.calls.some((c) => c[0] === 'unregister' && c[1] === 'quota.open'));
});

test('display model selects lowest valid window, includes exhaustion, rejects stale or malformed windows', async () => {
  const { tightest, remaining, summary, resetLabel, periodLabel } = await import('../renderer/model.mjs');
  const now = Date.now();
  const a = { id: 'a', status: 'ok', windows: [{ period: 'week', remainingPercent: 80 }, { period: 'session', remainingPercent: 20 }] };
  const b = { id: 'b', status: 'ok', windows: [{ period: 'month', remainingPercent: 0 }] };
  assert.equal(tightest([a]).value, 20);
  assert.equal(tightest([a, b]).account.id, 'b');
  assert.equal(tightest([{ ...b, status: 'error' }, a]).account.id, 'a');
  for (const w of [{ remainingPercent: null }, { remainingPercent: '80' }, { remainingPercent: NaN }, { remainingPercent: 40, resetsAt: new Date(now - 1).toISOString() }, { remainingPercent: 40, resetsAt: 'bad' }]) assert.equal(remaining(w, now), null);
  assert.equal(summary({ accounts: [a] }), '额度 20%');
  assert.match(summary({ accounts: [a], demo: true }), /演示/);
  assert.equal(summary({ loading: true }), '额度更新中');
  assert.equal(summary({ accounts: [{ status: 'empty', windows: [] }] }), '额度未知');
  assert.match(resetLabel({}), /未知/);
  assert.match(resetLabel({ resetsAt: new Date(now - 1).toISOString() }, now), /等待刷新/);
  assert.match(resetLabel({ resetsAt: new Date(now + 60000).toISOString() }, now), /1 分钟/);
  assert.equal(periodLabel({ period: 'session' }), '5 小时');
});

test('manifest removes widget and preserves renderer and full work-panel view', () => {
  const m = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../manifest.json'), 'utf8'));
  assert.ok(m.permissions.includes('renderer.extension'));
  assert.ok(!m.permissions.includes('ui.panel'));
  assert.deepEqual(m.rendererCallMethods, ['compact', 'selectAccount', 'details']);
  assert.equal(m.ui, undefined);
  assert.equal(m.contributes.settings.find((s) => s.key === 'refreshSeconds').default, 60);
  assert.equal(m.contributes.views[0].entry, 'views/quota.html');
  for (const p of [m.renderer, m.contributes.views[0].entry]) assert.ok(fs.existsSync(path.resolve(__dirname, '..', p)));
  for (const p of ['views/widget.html', 'views/widget.mjs']) assert.ok(!fs.existsSync(path.resolve(__dirname, '..', p)));
});

test('compact respects 30-second refresh even inside the old 60-second cache TTL', async () => {
  const clock = { now: Date.now() };
  let requests = 0;
  const a = app({ clock, refreshSeconds: 30, fetcher: async () => {
    requests++; return { status: 200, bodyText: JSON.stringify({ usage: { rolling: { percent: requests } } }) };
  } });
  await a.onRendererCall('compact', {}); await settle();
  assert.equal(requests, 1);
  clock.now += 31000;
  await a.onRendererCall('compact', {}); await settle();
  assert.equal(requests, 2);
  assert.equal((await a.onRendererCall('compact', {})).accounts[0].windows[0].remainingPercent, 98);
});

test('compact limits bytes, preserves custom labels and computes tightest over all accounts and windows', async () => {
  const long = '长'.repeat(70000);
  const accounts = Array.from({ length: 32 }, (_, i) => ({ id: `manual-${i}`, label: `账号 ${i}`,
    windows: Array.from({ length: 10 }, (_, j) => ({ key: `${j}-${long}`, period: 'week', usedPercent: i === 31 && j === 9 ? 100 : 10, label: '自定义周额度' })) }));
  accounts[0].id = long;
  accounts[0].provider = long;
  const a = app({ accounts });
  await a.onRendererCall('compact', {}); await settle();
  const data = await a.onRendererCall('compact', {});
  assert.ok(Buffer.byteLength(JSON.stringify(data)) < 60 * 1024);
  assert.equal(data.truncated, true);
  assert.equal(data.tightest.value, 0);
  assert.equal(data.tightest.account.label, '账号 31');
  const manual = data.accounts.find((a) => a.label === '账号 0');
  assert.equal(manual.windows[0].customLabel, '自定义周额度');
  const { periodLabel, snapshotTightest, summary } = await import('../renderer/model.mjs');
  assert.equal(periodLabel(manual.windows[0]), '自定义周额度');
  assert.equal(periodLabel({ labelKey: 'window.week.opus', period: 'week' }), '每周 · Opus');
  assert.equal(snapshotTightest(data).value, 0);
  assert.equal(summary(data), '额度 0%');
});

test('toolbar account selection persists, restores, and can return to automatic', async () => {
  const a = app({ demo: true });
  await a.onLoad(); await settle();
  const initial = await a.onRendererCall('compact', {});
  const account = initial.accounts.find((a) => a.status === 'ok');
  const selected = await a.onRendererCall('selectAccount', { accountId: account.id });
  assert.equal(a.settings.toolbarAccountId, account.id);
  assert.equal(selected.toolbarSummary.account.id, account.id);
  const restored = app({ demo: true, saved: { ...a.settings } });
  await restored.onLoad(); await settle();
  assert.equal((await restored.onRendererCall('compact', {})).toolbarAccountId, account.id);
  await assert.rejects(a.onRendererCall('selectAccount', { accountId: 'missing' }), /不可用/);
  assert.equal((await a.onRendererCall('selectAccount', { accountId: '' })).toolbarAccountId, '');
});

test('failed account save preserves previous selection', async () => {
  const a = app({ demo: true, saveFails: true });
  await a.onRendererCall('compact', {}); await settle();
  const data = await a.onRendererCall('compact', {});
  await assert.rejects(a.onRendererCall('selectAccount', { accountId: data.accounts[0].id }), /保存失败/);
  assert.equal((await a.onRendererCall('compact', {})).toolbarAccountId, '');
});

test('one-minute migration applies once and preserves later refresh settings', async () => {
  const a = app({ demo: true, refreshSeconds: 300 });
  await a.onLoad(); await settle();
  assert.equal(a.settings.refreshSeconds, 60);
  assert.equal(a.settings.quotaDisplayVersion, 7);
  const b = app({ demo: true, refreshSeconds: 120, saved: { quotaDisplayVersion: 7 } });
  await b.onLoad(); await settle();
  assert.equal(b.settings.refreshSeconds, 120);
});

test('toolbar summary handles selected providers and unavailable accounts', async () => {
  const { toolbarSummary } = await import('../renderer/model.mjs');
  assert.equal(toolbarSummary({ toolbarAccountId: 'a', toolbarSummary: { account: { provider: 'opencode-go' }, window: { remainingPercent: 83 }, value: 83 } }), 'OpenCode Go 83%');
  assert.equal(toolbarSummary({ toolbarAccountId: 'missing', toolbarLabel: '旧账号', accounts: [] }), '旧账号 额度未知');
  const a = app({ demo: true, saved: { toolbarAccountId: 'missing', quotaDisplayVersion: 7 } });
  await a.onLoad(); await settle();
  assert.equal((await a.onRendererCall('compact', {})).toolbarSummary, null);
});

test('migration save failure does not prevent initialization', async () => {
  const a = app({ demo: true, saveFails: true, saved: { toolbarAccountId: 'missing' } });
  await a.onLoad(); await settle();
  assert.equal(a.commands[0].id, 'quota.open');
  const data = await a.onRendererCall('compact', {});
  assert.equal(data.toolbarAccountId, 'missing');
  assert.ok(data.accounts.length > 0);
});

test('long manual account IDs remain selectable through bounded stable IDs', async () => {
  const a = app({ accounts: [{ id: '长'.repeat(500), label: '长 ID 账号', windows: [{ period: 'week', usedPercent: 15 }] }] });
  await a.onRendererCall('compact', {}); await settle();
  const account = (await a.onRendererCall('compact', {})).accounts.find((a) => a.label === '长 ID 账号');
  assert.ok(account.id.length <= 200);
  const data = await a.onRendererCall('selectAccount', { accountId: account.id });
  assert.equal(data.toolbarSummary.value, 85);
  assert.equal(a.settings.toolbarAccountId, account.id);
});
