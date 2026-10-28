export const periodLabel = (w) => w.customLabel || w.label || ({ 'window.week.sonnet': '每周 · Sonnet', 'window.week.opus': '每周 · Opus', 'window.week.oauth': '每周 · OAuth' }[w.labelKey]) || ({ session: '5 小时', day: '每日', week: '每周', month: '每月', credit: '余额' }[w.period] || '额度');
export function remaining(w, now = Date.now()) {
  if (typeof w?.remainingPercent !== 'number' || !Number.isFinite(w.remainingPercent)) return null;
  if (w.resetsAt && (!Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now)) return null;
  return Math.max(0, Math.min(100, w.remainingPercent));
}
export function tightest(accounts, now = Date.now()) {
  const rows = [];
  for (const a of accounts || []) {
    if (a.status !== 'ok') continue;
    for (const w of a.windows || []) {
      const value = remaining(w, now);
      if (value !== null) rows.push({ account: a, window: w, value });
    }
  }
  return rows.sort((a, b) => a.value - b.value)[0] || null;
}
export function resetLabel(w, now = Date.now()) {
  if (!w.resetsAt) return '重置时间未知';
  const diff = Date.parse(w.resetsAt) - now;
  if (!Number.isFinite(diff)) return '重置时间未知';
  if (diff <= 0) return '已到重置时间，等待刷新';
  const minutes = Math.ceil(diff / 60000);
  return minutes < 60 ? `${minutes} 分钟后重置` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟后重置` : `${Math.floor(minutes / 1440)} 天 ${Math.floor(minutes % 1440 / 60)} 小时后重置`;
}
export function summary(data) {
  const item = snapshotTightest(data);
  if (item) return `${data.demo ? '演示 · ' : ''}额度 ${item.value}%`;
  return data?.loading ? '额度更新中' : data?.accounts?.length ? '额度未知' : '订阅额度';
}
export function snapshotTightest(data) {
  if (data && Object.hasOwn(data, 'tightest')) {
    const item = data.tightest;
    return item && remaining(item.window) !== null ? item : null;
  }
  return tightest(data?.accounts);
}
export function toolbarSummary(data) {
  if (!data?.toolbarAccountId) return summary(data);
  const item = data.toolbarSummary;
  const provider = item?.account.provider || data.accounts?.find((a) => a.id === data.toolbarAccountId)?.provider;
  const name = ({ 'openai-codex': 'OpenAI', anthropic: 'Claude', 'github-copilot': 'Copilot', 'opencode-go': 'OpenCode Go', openrouter: 'OpenRouter' }[provider]) || data.toolbarLabel || '已选订阅';
  const prefix = data.demo ? '演示 · ' : '';
  return `${prefix}${name} ${item && remaining(item.window) !== null ? `${item.value}%` : '额度未知'}`;
}
