"use strict";

// Public installed-app OAuth configuration, not a user/account secret.
// Verified against NoeFabris/opencode-antigravity-auth src/constants.ts,
// src/antigravity/oauth.ts and src/plugin/{project,quota}.ts.
const GOOGLE_ANTIGRAVITY = Object.freeze({
  clientId: "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com",
  clientSecret: "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",
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  redirect: "http://localhost:51121/oauth-callback",
  scope: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ].join(" "),
});
const ENDPOINT = "https://cloudcode-pa.googleapis.com";
const USERINFO = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

// loadCodeAssist's protobuf enum names are not the same as Client-Metadata.
// PI v0.57.1 packages/ai/src/utils/oauth/google-antigravity.ts uses these values.
function metadata() {
  return { ideType: "IDE_UNSPECIFIED", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
}

function clientMetadata() {
  return { ideType: "ANTIGRAVITY", platform: process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX", pluginType: "GEMINI" };
}

// Only fixed diagnostic identifiers are exposed, never Google's messages,
// arbitrary field names, offending values or echoed request/credential bodies.
function errorDetails(data) {
  const statuses = new Set(["INVALID_ARGUMENT", "FAILED_PRECONDITION", "UNAUTHENTICATED", "PERMISSION_DENIED", "RESOURCE_EXHAUSTED", "UNAVAILABLE"]);
  const status = statuses.has(data?.error?.status) ? data.error.status : null;
  const allowedFields = new Set(["metadata", "metadata.ideType", "metadata.ide_type", "metadata.platform", "metadata.pluginType", "metadata.plugin_type", "project"]);
  const fields = new Set();
  const details = data?.error?.details;
  if (Array.isArray(details)) for (const detail of details) {
    if (!Array.isArray(detail?.fieldViolations)) continue;
    for (const violation of detail.fieldViolations) {
      if (allowedFields.has(violation?.field)) fields.add(violation.field);
    }
  }
  const identifiers = [...(status ? [status] : []), ...fields];
  return identifiers.length ? ` [${identifiers.join(", ")}]` : "";
}

function projectId(data) {
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data?.[key];
    const id = typeof value === "string" ? value : value?.id;
    if (typeof id === "string" && id.trim() && id.length <= 200) return id.trim();
  }
  return null;
}

function modelWindows(data) {
  const models = data?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return [];
  const windows = [];
  for (const [id, model] of Object.entries(models)) {
    const fraction = model?.quotaInfo?.remainingFraction;
    // Missing or malformed quota is unknown, never invented as 0% or 100%.
    if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
    const remainingPercent = Math.round(fraction * 1000) / 10;
    const reset = model.quotaInfo.resetTime;
    const timestamp = typeof reset === "string" && reset.trim() ? Date.parse(reset) : NaN;
    const label = typeof model.displayName === "string" && model.displayName.trim() ? model.displayName.trim() : id;
    windows.push({
      key: `antigravity:${id}`, period: "other", labelKey: "window.other", customLabel: label,
      family: [id, model.modelName, label].some((value) => typeof value === "string" && /(^|[^a-z])gemini(?=$|[^a-z])/i.test(value)) ? "gemini" : "other",
      windowMinutes: null, usedPercent: Math.round((100 - remainingPercent) * 10) / 10, remainingPercent,
      resetsAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    });
  }
  return windows;
}

// Display categories, not a claim that the vendor exposes two shared quota pools.
// Never sum/average percentages. Preserve every reading for details and freshness checks.
function quotaWindows(data) {
  const readings = modelWindows(data);
  return ["gemini", "other"].flatMap((family) => {
    const members = readings.filter((row) => row.family === family);
    if (!members.length) return [];
    const remainingPercent = Math.min(...members.map((row) => row.remainingPercent));
    const limiting = members.filter((row) => row.remainingPercent === remainingPercent);
    const resets = new Set(limiting.map((row) => row.resetsAt));
    return [{
      key: `antigravity-group:${family}`, period: "other", labelKey: `window.antigravity.${family}`,
      windowMinutes: null, remainingPercent, usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
      resetsAt: resets.size === 1 ? limiting[0].resetsAt : null, members,
    }];
  });
}

// Identity lookup is best-effort and never surfaces upstream bodies or tokens.
async function accountEmail(net, token) {
  try {
    const response = await net.fetch({ url: USERINFO, method: "GET", timeoutMs: 8_000,
      headers: { accept: "application/json", authorization: `Bearer ${token}` } });
    if (response.status < 200 || response.status >= 300) return null;
    const email = JSON.parse(response.bodyText)?.email;
    return typeof email === "string" && email.trim() && email.trim().length <= 200 ? email.trim() : null;
  } catch { return null; }
}

module.exports = { GOOGLE_ANTIGRAVITY, ENDPOINT, metadata, clientMetadata, errorDetails, projectId, modelWindows, quotaWindows, accountEmail };
