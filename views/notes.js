"use strict";
// Card-local notes. No credentials, no quota request and no draft persistence.
window.createQuotaNotes = function ({ invoke, getSnapshot, onSaved, isBlocked, isEnglish }) {
  const drafts = new Map();
  const saved = new Map();
  const copy = () => isEnglish()
    ? { edit: "Edit note", save: "Save", cancel: "Cancel", saving: "Saving…", saved: "Saved", label: "Account note", invalid: "Enter 1–80 characters", failed: "Save failed. Retry." }
    : { edit: "修改备注", save: "保存", cancel: "取消", saving: "保存中…", saved: "已保存", label: "账号备注", invalid: "请输入 1–80 个字符", failed: "保存失败，请重试" };
  const escape = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  function account(id) { return getSnapshot()?.accounts?.find((a) => a.id === `plugin:${id}` && a.source === "plugin"); }
  function apply(a, label) {
    const vendorName = a.accountLabel && a.label.endsWith(` · ${a.accountLabel}`)
      ? a.label.slice(0, -a.accountLabel.length - 3) : a.provider;
    a.accountLabel = label;
    a.label = `${vendorName} · ${label}`;
  }
  function sync() {
    for (const [id, label] of saved) { const a = account(id); if (a) apply(a, label); }
  }
  function markup(a) {
    if (a.source !== "plugin" || !a.id.startsWith("plugin:") || isBlocked()) return "";
    const id = a.id.slice(7), state = drafts.get(id), c = copy();
    if (!state) return `<div class="qp-rename"><button class="qp-btn" type="button" data-note-action="edit" data-note-id="${escape(id)}">${c.edit}</button></div>`;
    return `<form class="qp-rename" data-note-form="${escape(id)}"><label>${c.label}<input class="qa-input" data-note-input="${escape(id)}" value="${escape(state.value)}" maxlength="160" autocomplete="off" ${state.busy ? "disabled" : ""}></label><button class="qp-btn" type="submit" ${state.busy ? "disabled" : ""}>${state.busy ? c.saving : c.save}</button> <button class="qp-btn" type="button" data-note-action="cancel" data-note-id="${escape(id)}" ${state.busy ? "disabled" : ""}>${c.cancel}</button><span class="qp-rename-message" role="status" aria-live="polite">${escape(state.message)}</span></form>`;
  }
  function repaint() { onSaved(); }
  async function save(id) {
    const state = drafts.get(id);
    if (!state || state.busy || !account(id) || isBlocked()) return;
    const value = state.value.trim();
    if (!value || [...value].length > 80) { state.message = copy().invalid; repaint(); return; }
    state.busy = true; state.message = ""; repaint();
    try {
      const result = await invoke("quota.auth.rename", { accountId: id, label: value });
      const updated = result?.ok && result.accounts?.find((a) => a.id === id);
      if (!updated) throw new Error("rename failed");
      saved.set(id, updated.label);
      state.value = updated.label; state.message = copy().saved;
      sync();
    } catch { state.message = copy().failed; }
    finally { state.busy = false; repaint(); }
  }
  document.addEventListener("input", (event) => {
    const id = event.target.dataset.noteInput;
    if (id && drafts.has(id)) { drafts.get(id).value = event.target.value; drafts.get(id).message = ""; }
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-note-action]");
    if (!button || button.disabled || isBlocked()) return;
    const id = button.dataset.noteId, a = account(id);
    if (!a) return;
    if (button.dataset.noteAction === "edit") drafts.set(id, { value: a.accountLabel || "", busy: false, message: "" });
    else if (drafts.get(id)?.busy) return;
    else drafts.delete(id);
    repaint();
    const input = [...document.querySelectorAll("[data-note-input]")].find((n) => n.dataset.noteInput === id);
    input?.focus();
  });
  document.addEventListener("submit", (event) => {
    const form = event.target.closest("[data-note-form]");
    if (!form) return;
    event.preventDefault();
    const id = form.dataset.noteForm;
    const input = form.querySelector("[data-note-input]");
    if (input && drafts.has(id)) drafts.get(id).value = input.value;
    void save(id);
  });
  return { markup, sync };
};
