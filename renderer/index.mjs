import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CSS } from './style.mjs';
import { periodLabel, remaining, resetLabel, toolbarSummary } from './model.mjs';
const h = React.createElement;
const icon = (kind) => h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  kind === 'close' ? h('path', { d: 'M6 6l12 12M18 6L6 18' }) : h(React.Fragment, null, h('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }), h('path', { d: 'M21 3v5h-5' })));
let host;
const call = (method, args) => host.dispatch('plugin.call', { method, args });
function useQuota() {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const update = useRef(null);
  useEffect(() => {
    let alive = true, busy = false, selecting = false, generation = 0;
    const read = async (force = false) => {
      if (busy || selecting) return;
      const current = generation;
      busy = true;
      try {
        const next = await call('compact', { force });
        if (alive && current === generation) { setData(next); setError(next.error || ''); }
      } catch { if (alive && current === generation) setError('无法读取额度，请重试或重新加载插件'); }
      finally { busy = false; }
    };
    const select = async (accountId) => {
      if (selecting) return;
      selecting = true;
      generation += 1;
      setSaving(true);
      try {
        const next = await call('selectAccount', { accountId });
        if (alive) { setData(next); setError(next.error || ''); }
      } catch { if (alive) setError('对话框显示设置保存失败，请重试'); }
      finally { selecting = false; if (alive) setSaving(false); }
    };
    update.current = { read, select };
    void read();
    const timer = setInterval(() => { if (!document.hidden) void read(); }, 5000);
    return () => { alive = false; update.current = null; clearInterval(timer); };
  }, []);
  return { data, error, saving, refresh: () => update.current?.read(true), select: (id) => update.current?.select(id) };
}
function QuotaLayer({ quota, close, closing }) {
  const [layer, setLayer] = useState(null);
  const [pendingSelection, setPendingSelection] = useState(null);
  const box = useRef(null);
  const { data, error, refresh, saving, select } = quota;
  const selectedId = data?.toolbarAccountId || '';
  const accounts = data?.accounts || [];
  const selectedMissing = selectedId && !accounts.some((a) => a.id === selectedId);
  useEffect(() => {
    const opened = host.ui.openLayer();
    setLayer(opened);
    return () => opened.close();
  }, []);
  useEffect(() => { if (layer) box.current?.focus(); }, [layer]);
  if (!layer) return null;
  return createPortal(h('div', { className: 'sq-overlay' },
    h('section', { className: `sq-dialog${closing ? ' sq-closing' : ''}`, role: 'dialog', 'aria-modal': 'false', 'aria-label': '订阅额度', tabIndex: -1, ref: box,
      onKeyDown: (e) => { if (e.key === 'Escape' && e.target.tagName !== 'SELECT') { e.stopPropagation(); close(); } } },
      h('header', { className: 'sq-head' },
        h('h2', null, data?.demo ? '订阅额度 · 演示' : '订阅额度'),
        h('div', { className: 'sq-head-tools' },
          h('span', { className: 'sq-muted', title: '最近更新时间' }, data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '尚未更新'),
          h('button', { type: 'button', className: 'sq-icon', onClick: refresh, disabled: data?.loading, title: data?.loading ? '更新中' : '刷新额度', 'aria-label': data?.loading ? '更新中' : '刷新额度' }, icon('refresh')),
          h('button', { type: 'button', className: 'sq-icon', onClick: close, title: '关闭', 'aria-label': '关闭' }, icon('close')))),
      h('div', { className: 'sq-picker' },
        h('label', { htmlFor: 'sq-toolbar-account' }, '对话框显示'),
        h('select', { id: 'sq-toolbar-account', value: pendingSelection ?? selectedId, disabled: !data, 'aria-busy': saving, onChange: (e) => {
          if (saving) return;
          const id = e.target.value;
          setPendingSelection(id);
          Promise.resolve(select(id)).finally(() => setPendingSelection(null));
        } },
          h('option', { value: '' }, '自动 · 全部账号最紧张窗口'),
          selectedMissing ? h('option', { value: selectedId, disabled: true }, data.toolbarLabel || '已选账号不可用') : null,
          accounts.map((a) => h('option', { key: a.id, value: a.id }, a.label)))),
      h('div', { className: 'sq-body' },
        error ? h('p', { className: 'sq-error', role: 'status' }, error) : null,
        !accounts.length ? h('p', { className: 'sq-empty' }, data?.loading ? '正在更新额度…' : '未发现账号。请打开完整面板管理账号或配置 OpenCode Go Key。') :
          accounts.map((a) => h('article', { className: 'sq-account', key: a.id }, h('h3', null, a.label),
            a.status !== 'ok' || !a.windows.length ? h('p', { className: a.status === 'error' ? 'sq-error' : 'sq-muted' }, a.error || '未返回额度窗口') :
              a.windows.map((w, i) => { const value = remaining(w); return h('div', { className: 'sq-meter', key: w.key || i, 'data-tone': value === null ? 'unknown' : value <= 10 ? 'critical' : value <= 30 ? 'low' : 'normal' },
                h('div', { className: 'sq-line' }, h('span', null, periodLabel(w)), h('span', { className: 'sq-value' }, value === null ? '待更新' : `${value}% 剩余`)),
                h('div', { className: 'sq-bar' }, h('span', { className: 'sq-fill', style: { width: `${value ?? 0}%` } })),
                h('div', { className: 'sq-muted' }, resetLabel(w))); }))),
        data?.truncated ? h('p', { className: 'sq-muted' }, '部分账号未展开，请从右侧工作面板查看。') : null))), layer.element);
}
function Launcher() {
  const quota = useQuota();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const button = useRef(null);
  const close = () => setClosing(true);
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => {
      setOpen(false);
      setClosing(false);
      button.current?.focus();
    }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180);
    return () => clearTimeout(timer);
  }, [closing]);
  const title = quota.data?.toolbarAccountId ? `对话框显示：${quota.data.toolbarLabel || '已选账号不可用'}（该账号最紧张窗口）` : '查看订阅额度（各账号中最紧张窗口）';
  return h(React.Fragment, null,
    h('button', { ref: button, type: 'button', className: 'sq-launch', title, 'aria-expanded': open, onClick: () => open ? close() : setOpen(true) }, toolbarSummary(quota.data)),
    open ? h(QuotaLayer, { quota, close, closing }) : null);
}
export function onLoad(pi) {
  host = pi;
  pi.ui.injectStyle(CSS);
  pi.slots.register({ slot: 'composerControl', positions: ['left'], component: Launcher });
}
