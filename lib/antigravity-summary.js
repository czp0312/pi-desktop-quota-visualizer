"use strict";

// Schema and endpoint order verified from dsh-cliproxyapi 2.4.2
// src/quota.js: ANTIGRAVITY_QUOTA_URLS and parseAntigravityQuota.
// No proxy, account file, onboarding or project-creation calls are used here.
const SUMMARY_ENDPOINTS = Object.freeze([
  "https://daily-cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
]);
const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;

function unwrapSummary(payload) {
  const root = record(payload);
  if (!root) return null;
  if (Array.isArray(root.groups)) return root;
  if (typeof root.body === "string") {
    try { return record(JSON.parse(root.body)); } catch { return null; }
  }
  return record(root.body) ?? root;
}

function fractionValue(value) {
  if (record(value) && Object.hasOwn(value, "val")) value = value.val;
  let percent = false;
  if (typeof value === "string") {
    let input = value.trim();
    if (!input) return null;
    if (input.endsWith("%")) { percent = true; input = input.slice(0, -1).trim(); }
    // Decimal numeric strings only, not booleans, null, hex or arbitrary strings.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(input)) return null;
    value = Number(input);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (percent) value /= 100;
  return value >= 0 && value <= 1 ? value : null;
}

function windowKind(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (["5h", "five-hour"].includes(normalized)) return "session";
  if (["weekly", "week"].includes(normalized)) return "week";
  return null;
}

function resetValue(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = typeof value === "number" ? value : /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const ms = Number.isFinite(numeric) ? (numeric > 1e11 ? numeric : numeric * 1000) : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function summaryWindows(payload) {
  const groups = unwrapSummary(payload)?.groups;
  if (!Array.isArray(groups)) return [];
  const readings = [];
  for (let g = 0; g < groups.length; g++) {
    const group = record(groups[g]);
    if (!group || !Array.isArray(group.buckets)) continue;
    const name = group.display_name ?? group.displayName;
    const label = typeof name === "string" && name.trim() ? name.trim() : "";
    const family = /(^|[^a-z])gemini(?=$|[^a-z])/i.test(label) ? "gemini" : "other";
    for (let b = 0; b < group.buckets.length; b++) {
      const bucket = record(group.buckets[b]);
      if (!bucket) continue;
      // Explicit window takes precedence. A conflicting display label must not relabel it.
      const period = windowKind(bucket.window ?? bucket.display_name ?? bucket.displayName);
      const fraction = fractionValue(bucket.remaining_fraction ?? bucket.remainingFraction);
      if (!period || fraction === null) continue;
      const remainingPercent = Math.round(fraction * 1000) / 10;
      readings.push({
        key: `antigravity-summary:${g}:${b}`, family, period,
        customLabel: label || null, labelKey: `window.${period}`, windowMinutes: period === "session" ? 300 : 10080,
        remainingPercent, usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
        resetsAt: resetValue(bucket.reset_time ?? bucket.resetTime),
      });
    }
  }
  return ["gemini", "other"].flatMap((family) => ["session", "week"].flatMap((period) => {
    const members = readings.filter((row) => row.family === family && row.period === period);
    if (!members.length) return [];
    const remainingPercent = Math.min(...members.map((row) => row.remainingPercent));
    const limiting = members.filter((row) => row.remainingPercent === remainingPercent);
    const resets = new Set(limiting.map((row) => row.resetsAt));
    return [{
      key: `antigravity-group:${family}:${period}`, period, labelKey: `window.antigravity.${family}.${period}`,
      windowMinutes: period === "session" ? 300 : 10080, remainingPercent,
      usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
      resetsAt: resets.size === 1 ? limiting[0].resetsAt : null, members,
    }];
  }));
}

module.exports = { SUMMARY_ENDPOINTS, unwrapSummary, fractionValue, windowKind, summaryWindows };
