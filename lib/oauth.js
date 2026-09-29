"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const { createAuthStore } = require("./auth-store");

// Public OAuth client identifiers and endpoints used by PI's supported flows.
// No client secrets, host credentials or private host RPC are used here.
const PROVIDERS = Object.freeze({
  "openai-codex": {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorize: "https://auth.openai.com/oauth/authorize",
    token: "https://auth.openai.com/oauth/token",
    redirect: "http://localhost:1455/auth/callback",
    scope: "openid profile email offline_access",
  },
  anthropic: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorize: "https://claude.ai/oauth/authorize",
    token: "https://platform.claude.com/v1/oauth/token",
    redirect: "http://localhost:53692/callback",
    scope: "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  },
  "github-copilot": { clientId: "Iv1.b507a08c87ecfe98" },
});
const VENDORS = Object.keys(PROVIDERS);
const ACTIVE = new Set(["starting", "waiting", "exchanging"]);
const LOGIN_TTL = 10 * 60_000;
const REFRESH_MARGIN = 60_000;

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}
function validVendor(vendor) {
  if (!VENDORS.includes(vendor)) throw fail("INVALID_ARGUMENT", "此服务商暂不支持插件内 OAuth 登录");
  return PROVIDERS[vendor];
}
function text(value) { return typeof value === "string" && value.length > 0 && value.length < 32768; }
function accountId(token) {
  try {
    const data = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const id = data["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id) ? id : null;
  } catch { return null; }
}

// Loopback only; no remote listener. A busy port leaves the manual redirect
// fallback available, instead of stealing another app's callback server.
async function listenCallback(redirect, accept) {
  const target = new URL(redirect);
  const server = http.createServer((req, res) => {
    const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" };
    if (req.method !== "GET" || !req.url || req.url.length > 16384 ||
        ![target.host, `127.0.0.1:${target.port}`].includes(req.headers.host)) {
      res.writeHead(400, headers).end("Invalid callback");
      return;
    }
    let url;
    try { url = new URL(req.url, target.origin); } catch { res.writeHead(400, headers).end("Invalid callback"); return; }
    if (url.origin !== target.origin || url.pathname !== target.pathname) {
      res.writeHead(404, headers).end("Not found");
      return;
    }
    const accepted = accept(url.href);
    res.writeHead(accepted ? 200 : 400, headers).end(accepted
      ? "授权已接收，请返回订阅额度面板查看结果。Authorization received; return to the quota panel."
      : "回调无效或已过期，请在插件内重新登录。Invalid or expired callback.");
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  const ok = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(Number(target.port), "127.0.0.1", () => resolve(true));
  });
  if (!ok) { server.close(); return null; }
  server.unref();
  return () => { server.close(); server.closeAllConnections?.(); };
}

function createAuth(pi, options = {}) {
  const store = options.store ?? createAuthStore(() => pi.plugin.getDataPath());
  const clock = options.now ?? Date.now;
  const listen = options.listen ?? listenCallback;
  const changed = options.onChange ?? (() => {});
  let credentials = null;
  let loading;
  let writes = Promise.resolve();
  let login = null;
  let stopped = false;
  const epochs = new Map();
  const refreshing = new Map();
  const epoch = (vendor) => epochs.get(vendor) ?? 0;
  const bump = (vendor) => epochs.set(vendor, epoch(vendor) + 1);

  async function load() {
    if (credentials) return;
    if (!loading) loading = store.load().then((saved) => {
      credentials = {};
      for (const vendor of VENDORS) {
        const c = saved[vendor];
        if (c && text(c.access) && (vendor === "github-copilot" ||
            (text(c.refresh) && Number.isFinite(c.expires)))) credentials[vendor] = c;
      }
    }).finally(() => { loading = null; });
    await loading;
  }
  function update(vendor, value, expectedEpoch, notify = true, expectedCredential) {
    const task = writes.then(async () => {
      await load();
      if (stopped || epoch(vendor) !== expectedEpoch) throw fail("AUTH_CANCELLED", "授权操作已取消");
      if (expectedCredential && credentials[vendor] !== expectedCredential)
        throw fail("AUTH_CANCELLED", "账号已重新授权，已丢弃旧令牌刷新结果");
      const next = { ...credentials };
      if (value) next[vendor] = value;
      else delete next[vendor];
      await store.save(next);
      if (stopped || epoch(vendor) !== expectedEpoch) {
        // Cancellation during an asynchronous disk write must not persist login.
        await store.save(credentials);
        throw fail("AUTH_CANCELLED", "授权操作已取消");
      }
      credentials = next;
      if (notify) changed();
    });
    writes = task.catch(() => {});
    return task;
  }
  function active(flow) { return !stopped && login === flow && ACTIVE.has(flow.status); }
  function cleanup(flow) {
    clearTimeout(flow.timer);
    clearTimeout(flow.pollTimer);
    flow.close?.();
    flow.close = null;
    flow.verifier = null;
    flow.deviceCode = null;
  }
  function end(flow, status, message) {
    if (status === "error" && active(flow)) bump(flow.vendor);
    flow.status = status;
    flow.message = message;
    cleanup(flow);
  }
  function safeError(error) {
    // Never forward network exception text, response bodies or credential fields.
    return ["AUTH_STORAGE", "AUTH_EXPIRED", "AUTH_INVALID_RESPONSE", "AUTH_NETWORK", "AUTH_HTTP", "AUTH_CANCELLED"].includes(error?.code)
      ? error.message : "授权失败，请重试或重新登录";
  }
  function checkFlow(flow) {
    if (active(flow) && clock() >= flow.expiresAt) end(flow, "error", "授权已超时，请重新登录");
    if (!active(flow)) throw fail("AUTH_CANCELLED", "授权操作已取消或过期");
  }
  async function request(url, body, json = false) {
    let response;
    try {
      response = await pi.net.fetch({ url, method: "POST", timeoutMs: 8_000,
        headers: { accept: "application/json", "content-type": json ? "application/json" : "application/x-www-form-urlencoded" },
        body: json ? JSON.stringify(body) : new URLSearchParams(body).toString() });
    } catch { throw fail("AUTH_NETWORK", "授权网络请求失败，请检查网络及插件权限后重试"); }
    let data;
    try { data = JSON.parse(response.bodyText); } catch { throw fail("AUTH_INVALID_RESPONSE", "授权服务返回了无效响应"); }
    if (!data || typeof data !== "object" || Array.isArray(data)) throw fail("AUTH_INVALID_RESPONSE", "授权服务返回了无效响应");
    if (response.status < 200 || response.status >= 300) {
      if (data.error === "invalid_grant") throw fail("AUTH_EXPIRED", "授权已失效，请在插件内重新登录");
      throw fail("AUTH_HTTP", `授权请求失败（HTTP ${Number(response.status) || 0}），请稍后重试`);
    }
    return data;
  }
  function tokenResult(vendor, data, old) {
    if (data.error === "invalid_grant") throw fail("AUTH_EXPIRED", "授权已失效，请在插件内重新登录");
    const refresh = data.refresh_token ?? old?.refresh;
    if (!text(data.access_token) || !text(refresh) || typeof data.expires_in !== "number" ||
        !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 365 * 86400) {
      throw fail("AUTH_INVALID_RESPONSE", "授权服务返回的令牌字段不完整，请重新登录");
    }
    return { access: data.access_token, refresh, expires: clock() + data.expires_in * 1000,
      accountId: vendor === "openai-codex" ? accountId(data.access_token) ?? old?.accountId ?? null : null };
  }
  async function saveLogin(flow, value) {
    checkFlow(flow);
    await update(flow.vendor, value, flow.epoch);
    // A logout may have been queued during the disk write; never revive the UI.
    if (active(flow)) end(flow, "success", "插件授权已保存");
  }
  function parseCallback(flow, input) {
    if (typeof input !== "string" || input.length > 16384) return null;
    let url;
    try { url = new URL(input.trim()); } catch { return null; }
    const target = new URL(PROVIDERS[flow.vendor].redirect);
    if (url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password || url.hash ||
        url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== flow.state) return null;
    if (url.searchParams.has("error")) return { denied: true };
    const code = url.searchParams.get("code");
    return text(code) && url.searchParams.getAll("code").length === 1 ? { code } : null;
  }
  async function exchange(flow, code) {
    try {
      checkFlow(flow);
      const p = PROVIDERS[flow.vendor];
      const body = { grant_type: "authorization_code", client_id: p.clientId, code,
        code_verifier: flow.verifier, redirect_uri: p.redirect };
      if (flow.vendor === "anthropic") body.state = flow.state;
      const data = await request(p.token, body, flow.vendor === "anthropic");
      await saveLogin(flow, tokenResult(flow.vendor, data));
    } catch (error) { if (active(flow)) end(flow, "error", safeError(error)); }
  }
  function acceptCallback(flow, input) {
    if (!active(flow) || flow.status !== "waiting" || clock() >= flow.expiresAt) return false;
    const parsed = parseCallback(flow, input);
    if (!parsed) return false;
    if (parsed.denied) { end(flow, "error", "用户取消或拒绝了授权"); return true; }
    flow.status = "exchanging";
    flow.message = "正在完成授权";
    // Defer closing the listener until its response has been written.
    flow.exchange = Promise.resolve().then(() => exchange(flow, parsed.code));
    return true;
  }
  function scheduleDevice(flow) {
    if (!active(flow)) return;
    flow.pollTimer = setTimeout(() => { void pollDevice(flow); }, flow.interval);
    flow.pollTimer.unref?.();
  }
  async function pollDevice(flow) {
    try {
      checkFlow(flow);
      const data = await request("https://github.com/login/oauth/access_token", {
        client_id: PROVIDERS[flow.vendor].clientId, device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code" });
      checkFlow(flow);
      if (data.error === "authorization_pending") { scheduleDevice(flow); return; }
      if (data.error === "slow_down") {
        flow.interval = Math.max(flow.interval + 5000, Math.min(60_000, Number(data.interval) * 1000 || 0));
        scheduleDevice(flow); return;
      }
      if (data.error || !text(data.access_token)) throw fail("AUTH_EXPIRED", "设备码授权被拒绝或已过期，请重新登录");
      await saveLogin(flow, { access: data.access_token, expires: null });
    } catch (error) { if (active(flow)) end(flow, "error", safeError(error)); }
  }
  async function openFlow(flow) {
    checkFlow(flow);
    if (!flow.url) throw fail("INVALID_ARGUMENT", "授权页面尚未就绪");
    try { await pi.shell.openExternal(flow.url); }
    catch { if (active(flow)) flow.message = "无法自动打开浏览器，请复制授权链接到浏览器打开"; }
  }
  function findFlow(id) {
    if (!login || typeof id !== "string" || login.id !== id) throw fail("INVALID_ARGUMENT", "登录流程不存在或已被替换");
    return login;
  }
  async function status() {
    await load();
    if (login && active(login) && clock() >= login.expiresAt) end(login, "error", "授权已超时，请重新登录");
    // Explicit allowlist; never serialize the flow or stored credential objects.
    const visible = login ? { id: login.id, vendor: login.vendor, status: login.status,
      method: login.method, expiresAt: login.expiresAt, message: login.message,
      ...(ACTIVE.has(login.status) ? { url: login.url, userCode: login.userCode, manual: login.manual } : {}) } : null;
    return { ok: true, accounts: VENDORS.map((vendor) => ({ vendor, connected: !!credentials[vendor] })), login: visible };
  }
  return {
    status,
    async start(vendor) {
      const p = validVendor(vendor);
      await load();
      if (stopped) throw fail("AUTH_CANCELLED", "插件已卸载");
      if (login && active(login)) throw fail("AUTH_BUSY", "请先完成或取消当前登录");
      bump(vendor);
      const flow = { id: crypto.randomUUID(), vendor, epoch: epoch(vendor), status: "starting",
        method: vendor === "github-copilot" ? "device" : "browser", expiresAt: clock() + LOGIN_TTL,
        message: "正在准备授权" };
      login = flow;
      flow.timer = setTimeout(() => { if (active(flow)) end(flow, "error", "授权已超时，请重新登录"); }, LOGIN_TTL);
      flow.timer.unref?.();
      try {
        if (flow.method === "device") {
          const data = await request("https://github.com/login/device/code", { client_id: p.clientId, scope: "read:user" });
          checkFlow(flow);
          if (!text(data.device_code) || !text(data.user_code) || !(data.expires_in > 0) || !Number.isFinite(data.expires_in))
            throw fail("AUTH_INVALID_RESPONSE", "授权服务返回了无效设备码");
          // Do not open a server-supplied URL: use GitHub's fixed HTTPS page.
          flow.url = "https://github.com/login/device";
          flow.userCode = data.user_code;
          flow.deviceCode = data.device_code;
          flow.interval = Math.max(5000, Math.min(60_000, Number(data.interval) * 1000 || 5000));
          flow.expiresAt = Math.min(flow.expiresAt, clock() + data.expires_in * 1000);
          flow.status = "waiting";
          flow.message = "请在 GitHub 输入设备码并授权";
          scheduleDevice(flow);
        } else {
          flow.verifier = crypto.randomBytes(32).toString("base64url");
          flow.state = crypto.randomBytes(32).toString("base64url");
          const params = new URLSearchParams({ client_id: p.clientId, response_type: "code", redirect_uri: p.redirect,
            scope: p.scope, code_challenge: crypto.createHash("sha256").update(flow.verifier).digest("base64url"),
            code_challenge_method: "S256", state: flow.state });
          if (vendor === "anthropic") params.set("code", "true");
          else { params.set("id_token_add_organizations", "true"); params.set("codex_cli_simplified_flow", "true"); params.set("originator", "codex_cli_rs"); }
          flow.url = `${p.authorize}?${params}`;
          const close = await listen(p.redirect, (input) => acceptCallback(flow, input));
          if (!active(flow)) { close?.(); throw fail("AUTH_CANCELLED", "授权操作已取消"); }
          flow.close = close;
          flow.manual = true;
          flow.status = "waiting";
          flow.message = close ? "请在浏览器完成授权；若未自动返回，可粘贴完整回调 URL" : "本机回调端口不可用；请完成授权后粘贴浏览器最终跳转的完整 URL";
        }
        await openFlow(flow);
      } catch (error) { if (active(flow)) end(flow, "error", safeError(error)); }
      return status();
    },
    async open(id) { await openFlow(findFlow(id)); return status(); },
    async submit(id, input) {
      const flow = findFlow(id);
      if (flow.method !== "browser" || !acceptCallback(flow, input)) throw fail("INVALID_ARGUMENT", "请粘贴本次授权的完整 localhost 回调 URL（必须包含匹配的 state）");
      await flow.exchange;
      return status();
    },
    async cancel(id) {
      const flow = findFlow(id);
      if (active(flow)) { bump(flow.vendor); end(flow, "cancelled", "授权已取消"); }
      return status();
    },
    async logout(vendor) {
      validVendor(vendor);
      await load();
      bump(vendor);
      if (login?.vendor === vendor && active(login)) end(login, "cancelled", "授权已取消");
      await update(vendor, null, epoch(vendor));
      return status();
    },
    async credential(vendor, { force = false } = {}) {
      validVendor(vendor);
      await load();
      const old = credentials[vendor];
      if (!old) return null;
      if (vendor === "github-copilot" || (!force && old.expires > clock() + REFRESH_MARGIN))
        return { token: old.access, accountId: old.accountId ?? null, source: "plugin" };
      const currentEpoch = epoch(vendor);
      const pending = refreshing.get(vendor);
      if (pending?.epoch === currentEpoch) return pending.promise;
      const promise = (async () => {
        const p = PROVIDERS[vendor];
        const data = await request(p.token, { grant_type: "refresh_token", client_id: p.clientId, refresh_token: old.refresh }, vendor === "anthropic");
        const value = tokenResult(vendor, data, old);
        await update(vendor, value, currentEpoch, false, old);
        return { token: value.access, accountId: value.accountId, source: "plugin" };
      })();
      refreshing.set(vendor, { epoch: currentEpoch, promise });
      try { return await promise; }
      finally { if (refreshing.get(vendor)?.promise === promise) refreshing.delete(vendor); }
    },
    async stop() {
      stopped = true;
      if (login) end(login, "cancelled", "插件已卸载");
      for (const vendor of VENDORS) bump(vendor);
      await writes;
      credentials = null;
    },
  };
}

module.exports = { createAuth, listenCallback };
