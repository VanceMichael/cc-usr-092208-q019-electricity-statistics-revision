// 发布修订账：接收各地区分产业报送，自动校验后冻结公开版本；
// 迟报、单位换算错误、行业重分类、基期修正与勘误一律不改旧版本，
// 只生成差异说明并形成新的生效版本。
//
// 全部状态为可序列化的普通对象，默认保存在内存中，也可整体落库。

import { SECTORS, SECTOR_LABELS, applyReclassification } from './classification.js';
import { validateSubmission, SEVERITY } from './validation.js';
import { toYiKwh } from './units.js';

export const CHANGE_TYPES = {
  LATE_REPORT: 'late-report', // 迟报 / 后补计量
  UNIT_CORRECTION: 'unit-correction', // 单位换算错误
  RECLASSIFICATION: 'reclassification', // 行业重分类
  BASE_REVISION: 'base-revision', // 同比基期修正
  ERRATUM: 'erratum', // 勘误
};

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
};

export class RevisionLedger {
  constructor({ regions = [], clock = () => new Date().toISOString() } = {}) {
    this.regions = [...regions];
    this.clock = clock;
    this.actors = new Map();
    // 最新报送（按地区+期间），发布后被冻结进快照，不再受后续改动影响。
    this.submissions = new Map();
    // 期间 -> 审核签章与结论（发布后随快照冻结）。
    this.reviews = new Map();
    // 不可变发布版本，按发布时间追加。
    this.releases = [];
  }

  registerActor(actor) {
    if (!actor?.id || !actor.role) throw new Error('参与方缺少 id 或 role');
    this.actors.set(actor.id, actor);
    return actor;
  }

  #requireActor(actorId, role) {
    const actor = this.actors.get(actorId);
    if (!actor) throw new Error(`未知参与方：${actorId}`);
    if (role && actor.role !== role) throw new Error(`参与方 ${actorId} 角色为 ${actor.role}，需要 ${role}`);
    return actor;
  }

  // 报送单位只能维护本辖区数据。
  submit(actorId, submission) {
    const actor = this.#requireActor(actorId, 'reporter');
    if (actor.jurisdiction !== submission.region) {
      throw new Error(`报送单位 ${actor.name} 只能维护 ${actor.jurisdiction}，不能报送 ${submission.region}`);
    }
    if (!this.regions.includes(submission.region)) {
      throw new Error(`未登记的辖区：${submission.region}`);
    }
    if (!submission.period) throw new Error('报送缺少统计期间');

    const result = validateSubmission(submission);
    if (!result.ok) {
      const err = new Error(`报送未通过勾稽校验，共 ${result.findings.filter((f) => f.severity === SEVERITY.ERROR).length} 个错误`);
      err.findings = result.findings;
      throw err;
    }

    const key = `${submission.region}|${submission.period}`;
    const prior = this.submissions.get(key);
    const stored = {
      ...submission,
      receivedAt: submission.receivedAt ?? this.clock(),
      warnings: result.findings.filter((f) => f.severity === SEVERITY.WARNING),
      supersedes: prior ? prior.revisionOf ?? prior.id : undefined,
    };
    this.submissions.set(key, stored);
    return deepFreeze({ accepted: true, submission: stored, warnings: stored.warnings });
  }

  // 分析人员定位不平衡来源：按地区列出错误级校验问题。
  diagnose(period) {
    const report = [];
    for (const region of this.regions) {
      const current = this.submissions.get(`${region}|${period}`);
      if (!current) {
        report.push({ region, status: 'missing', findings: [] });
        continue;
      }
      const { findings } = validateSubmission(current);
      report.push({
        region,
        status: 'reported',
        findings,
        errors: findings.filter((f) => f.severity === SEVERITY.ERROR),
      });
    }
    return report;
  }

  // 审核签章：分析人员复核，管理者批准。
  review(actorId, period, decision, { note = '' } = {}) {
    const actor = this.actors.get(actorId);
    if (!actor || !['analyst', 'administrator'].includes(actor.role)) {
      throw new Error('只有分析人员或管理者可以签章审核');
    }
    if (!['approved', 'rejected'].includes(decision)) throw new Error('审核结论须为 approved 或 rejected');
    const list = this.reviews.get(period) ?? [];
    const signature = { actorId, name: actor.name, role: actor.role, decision, note, at: this.clock() };
    list.push(signature);
    this.reviews.set(period, list);
    return deepFreeze(signature);
  }

  #aggregate(period) {
    const empty = () => Object.fromEntries([...SECTORS, 'total'].map((k) => [k, 0]));
    const month = empty();
    const cumulative = empty();
    const baseMonth = empty();
    const baseCumulative = empty();
    const sources = [];

    for (const region of this.regions) {
      const s = this.submissions.get(`${region}|${period}`);
      if (!s) throw new Error(`${region} 尚未完成 ${period} 报送，无法汇总`);
      sources.push({ region, submissionId: s.id, receivedAt: s.receivedAt, batches: [...(s.batches ?? [])] });

      const add = (target, group, unit) => {
        if (!group) return;
        for (const k of [...SECTORS, 'total']) {
          if (group[k] !== undefined) target[k] += toYiKwh(group[k], unit);
        }
      };
      add(month, s.month, s.unit);
      add(cumulative, s.cumulative, s.unit);
      add(baseMonth, s.baseYearMonth, s.unit);
      add(baseCumulative, s.baseYearCumulative, s.unit);
    }

    const yoy = (current, base) =>
      Object.fromEntries(
        [...SECTORS, 'total']
          .filter((k) => base[k] !== 0)
          .map((k) => [k, Number((((current[k] - base[k]) / base[k]) * 100).toFixed(2))]),
      );

    return {
      period,
      unit: '亿千瓦时',
      month: roundGroup(month),
      cumulative: roundGroup(cumulative),
      yoy: { month: yoy(month, baseMonth), cumulative: yoy(cumulative, baseCumulative) },
      sources,
    };
  }

  // 发布：冻结全国表、来源报送、校验结论与签章为不可变版本。
  publish(actorId, period, { changeNotice = null } = {}) {
    const actor = this.#requireActor(actorId, 'administrator');
    const prior = this.#latestRelease(period);

    // 发布前重新做全量校验，任何地区存在错误即拒绝。
    const diagnosis = this.diagnose(period);
    const blocking = diagnosis.flatMap((d) => d.errors ?? []);
    const missing = diagnosis.filter((d) => d.status === 'missing').map((d) => d.region);
    if (missing.length) throw new Error(`以下辖区迟报或缺报：${missing.join('、')}`);
    if (blocking.length) {
      const err = new Error(`存在 ${blocking.length} 个未解决的勾稽错误，不能发布`);
      err.findings = blocking;
      throw err;
    }

    // 修订原因只允许五类，非法参数在签章检查之前拒绝。
    if (changeNotice && !Object.values(CHANGE_TYPES).includes(changeNotice.type)) {
      throw new Error(`不支持的修订原因类型：${changeNotice.type}`);
    }

    const signatures = [...(this.reviews.get(period) ?? [])];
    const latestApproval = signatures
      .filter((s) => s.role === 'analyst' && s.decision === 'approved')
      .map((s) => s.at)
      .sort()
      .at(-1);
    if (!latestApproval) {
      throw new Error('发布前缺少分析人员的核准签章');
    }
    // 自最近一次核准以来又有新报送或旧版发布，须重新核准，防止旧签章覆盖新数据。
    const latestInput = this.regions
      .map((region) => this.submissions.get(`${region}|${period}`)?.receivedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    if ((latestInput && latestInput > latestApproval) || (prior && prior.publishedAt > latestApproval)) {
      throw new Error('数据在核准后发生变化，须由分析人员重新签章');
    }

    const table = this.#aggregate(period);

    // 若相对上一版有任何数值或结构变化，必须附差异说明（限定五类原因）。
    const diff = prior ? diffReleases(prior.table, table) : null;
    if (prior && diff && diff.changed && !changeNotice) {
      throw new Error('数据相对上一发布版本发生变化，必须出具差异说明（迟报/单位/重分类/基期/勘误）');
    }

    const version = prior ? prior.version + 1 : 1;
    const release = deepFreeze({
      releaseId: `R-${period}-v${version}`,
      period,
      version,
      publishedAt: this.clock(),
      publishedBy: { actorId: actor.id, name: actor.name },
      table,
      diagnosis: diagnosis.map((d) => ({ region: d.region, status: d.status, findings: d.findings ?? [] })),
      signatures,
      changeNotice: changeNotice
        ? { ...changeNotice, fromVersion: prior?.version ?? null, diff }
        : null,
      supersedes: prior?.releaseId ?? null,
    });
    this.releases.push(release);
    return release;
  }

  #latestRelease(period) {
    return [...this.releases].reverse().find((r) => r.period === period) ?? null;
  }

  listReleases(period) {
    return this.releases.filter((r) => !period || r.period === period);
  }

  // 公众查询：复现任意发布日期当时能看到的表格（as-of 可见性）。
  tableAsOf(period, date) {
    const visible = this.releases
      .filter((r) => r.period === period && r.publishedAt <= date)
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
    return visible[0] ?? null;
  }

  // 管理者举证：某个增速/峰值/原因说明经历了哪些审核与版本。
  auditFigure(period, scope, key) {
    return this.releases
      .filter((r) => r.period === period)
      .map((r) => ({
        releaseId: r.releaseId,
        version: r.version,
        publishedAt: r.publishedAt,
        value: r.table[scope]?.[key] ?? null,
        label: SECTOR_LABELS[key] ?? key,
        yoy: r.table.yoy?.[scope]?.[key] ?? null,
        signatures: r.signatures.map((s) => ({ name: s.name, role: s.role, decision: s.decision, at: s.at, note: s.note })),
        changeNotice: r.changeNotice
          ? { type: r.changeNotice.type, summary: r.changeNotice.summary }
          : null,
      }));
  }
}

function roundGroup(group) {
  return Object.fromEntries(Object.entries(group).map(([k, v]) => [k, Number(v.toFixed(4))]));
}

// 两版全国表的逐项差异，供差异说明引用。
export function diffReleases(before, after) {
  const scopes = ['month', 'cumulative'];
  const changes = [];
  for (const scope of scopes) {
    for (const key of [...SECTORS, 'total']) {
      const a = before[scope]?.[key];
      const b = after[scope]?.[key];
      if (a === undefined && b === undefined) continue;
      if (Math.abs((a ?? 0) - (b ?? 0)) > 1e-6) {
        changes.push({
          scope,
          sector: key,
          label: SECTOR_LABELS[key] ?? key,
          from: a ?? null,
          to: b ?? null,
          delta: Number(((b ?? 0) - (a ?? 0)).toFixed(4)),
        });
      }
    }
  }
  return { changed: changes.length > 0, changes };
}
