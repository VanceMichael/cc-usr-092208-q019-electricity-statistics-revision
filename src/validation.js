// 自动校验：分项与总量勾稽、当月与累计勾稽、同比基期。
// 任何一类不通过都生成结构化校验问题，阻止发布；问题同时用于
// 分析人员定位不平衡来源。

import { SECTORS, SECTOR_LABELS } from './classification.js';
import { toYiKwh, approxEqual } from './units.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export const CHECK = {
  SECTOR_SUM: 'sector-sum', // 分产业合计不等于全社会总量
  CUMULATIVE_FLOW: 'cumulative-flow', // 累计值与当月、上月累计不衔接
  YOY_BASE: 'yoy-base', // 同比增速与基期数值不符
  BATCH_GAP: 'batch-gap', // 后补计量批次缺口或重复
  WEATHER_NOTE: 'weather-note', // 居民用电异常缺少气象注记
};

function sumSectors(values) {
  return SECTORS.reduce((acc, key) => acc + (values[key] ?? 0), 0);
}

// 归一化一组分项数据：把报送单位折算为亿千瓦时。
function normalizeGroup(group, unit) {
  const out = {};
  for (const key of [...SECTORS, 'total']) {
    if (group[key] !== undefined) out[key] = toYiKwh(group[key], unit);
  }
  return out;
}

export function validateSubmission(submission, opts = {}) {
  const tolerance = opts.tolerance ?? 0.5;
  const approx = (a, b) => approxEqual(a, b, tolerance);
  const findings = [];
  const push = (code, severity, message, detail) =>
    findings.push({ code, severity, message, region: submission.region, period: submission.period, ...(detail && { detail }) });

  const unit = submission.unit;
  const month = submission.month ? normalizeGroup(submission.month, unit) : null;
  const cumulative = submission.cumulative ? normalizeGroup(submission.cumulative, unit) : null;
  const priorCumulative = submission.priorCumulative ? normalizeGroup(submission.priorCumulative, unit) : null;

  // 一、分产业合计与全社会总量勾稽。
  for (const [name, group] of [['当月', month], ['累计', cumulative]]) {
    if (!group || group.total === undefined) continue;
    const diff = sumSectors(group) - group.total;
    if (!approx(sumSectors(group), group.total)) {
      push(
        CHECK.SECTOR_SUM,
        SEVERITY.ERROR,
        `${name}分产业合计（${sumSectors(group).toFixed(2)}）与全社会总量（${group.total.toFixed(2)}）不平衡`,
        { diff: Number(diff.toFixed(4)), bySector: SECTORS.map((k) => ({ sector: k, label: SECTOR_LABELS[k], value: group[k] ?? null })) },
      );
    }
  }

  // 二、当月与累计衔接：本期累计 = 上期累计 + 当月。
  if (cumulative && priorCumulative && month) {
    for (const key of [...SECTORS, 'total']) {
      if (cumulative[key] === undefined || priorCumulative[key] === undefined || month[key] === undefined) continue;
      const expected = priorCumulative[key] + month[key];
      if (!approx(expected, cumulative[key])) {
        push(
          CHECK.CUMULATIVE_FLOW,
          SEVERITY.ERROR,
          `${SECTOR_LABELS[key] ?? key}累计不衔接：上期累计 ${priorCumulative[key].toFixed(2)} + 当月 ${month[key].toFixed(2)} ≠ 本期累计 ${cumulative[key].toFixed(2)}`,
          { sector: key, priorCumulative: priorCumulative[key], month: month[key], cumulative: cumulative[key] },
        );
      }
    }
  }

  // 三、同比基期：增速须与本期值、上年同期基期值的算术一致。
  const yoyPairs = [
    ['当月', month, submission.baseYearMonth],
    ['累计', cumulative, submission.baseYearCumulative],
  ];
  for (const [name, current, rawBase] of yoyPairs) {
    if (!current || !rawBase) continue;
    const base = normalizeGroup(rawBase, unit);
    for (const key of [...SECTORS, 'total']) {
      if (current[key] === undefined || base[key] === undefined || base[key] === 0) continue;
      const computed = ((current[key] - base[key]) / base[key]) * 100;
      const reported = rawBase[`${key}Yoy`] ?? submission?.yoy?.[`${name}`]?.[key];
      if (reported !== undefined && Math.abs(reported - computed) > 0.1) {
        push(
          CHECK.YOY_BASE,
          SEVERITY.ERROR,
          `${name}${SECTOR_LABELS[key] ?? key}同比 ${reported}% 与基期推算值 ${computed.toFixed(2)}% 不符`,
          { sector: key, current: current[key], base: base[key], reported, computed: Number(computed.toFixed(2)) },
        );
      }
    }
  }

  // 四、后补计量批次：编号不得重复，迟报须登记预计/实际接收时间。
  const batches = submission.batches ?? [];
  const seen = new Set();
  for (const b of batches) {
    if (seen.has(b.id)) push(CHECK.BATCH_GAP, SEVERITY.ERROR, `计量批次 ${b.id} 重复登记`, { batchId: b.id });
    seen.add(b.id);
    if (b.late && !b.receivedAt) {
      push(CHECK.BATCH_GAP, SEVERITY.WARNING, `迟报批次 ${b.id} 缺少实际接收时间`, { batchId: b.id });
    }
  }

  // 五、居民用电同比为负时，必须附气象等原因注记（如台风、强降雨）。
  if (month && residentialDeclined(month, submission)) {
    const note = submission.weatherNote;
    if (!note || !Array.isArray(note.events) || note.events.length === 0) {
      push(CHECK.WEATHER_NOTE, SEVERITY.ERROR, '居民生活用电同比下降但缺少气象原因注记', {
        hint: '应登记台风、强降雨等天气事件及其对空调用电的影响',
      });
    }
  }

  return {
    ok: !findings.some((f) => f.severity === SEVERITY.ERROR),
    findings,
  };
}

function residentialDeclined(month, submission) {
  const rawBase = submission.baseYearMonth;
  if (!rawBase || month.residential === undefined || rawBase.residential === undefined) return false;
  const base = toYiKwh(rawBase.residential, submission.unit);
  return month.residential < base;
}
