import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDomain } from '../src/domain.js';
import { toYiKwh, approxEqual } from '../src/units.js';
import { applyReclassification, reclassificationBalanced, SECTORS } from '../src/classification.js';
import { validateSubmission, CHECK } from '../src/validation.js';
import { RevisionLedger, CHANGE_TYPES, diffReleases } from '../src/ledger.js';

const fixture = (name) =>
  readFile(new URL(`../fixtures/scenario/${name}.json`, import.meta.url), 'utf8').then((raw) => JSON.parse(raw));

const PERIOD = '2026-08';

function makeLedger(clock) {
  const ledger = new RevisionLedger({ regions: ['华东', '华南'], clock });
  ledger.registerActor({ id: 'r-hd', name: '华东能源统计报送员', role: 'reporter', jurisdiction: '华东' });
  ledger.registerActor({ id: 'r-hn', name: '华南能源统计报送员', role: 'reporter', jurisdiction: '华南' });
  ledger.registerActor({ id: 'a1', name: '国家能源局分析员', role: 'analyst' });
  ledger.registerActor({ id: 'm1', name: '能源统计发布负责人', role: 'administrator' });
  return ledger;
}

// 可控时钟，保证“报送—核准—发布”先后顺序可复现。
function timeline() {
  let i = 0;
  const stamps = [
    '2026-09-01T01:00:00Z',
    '2026-09-01T02:00:00Z',
    '2026-09-02T09:00:00Z',
    '2026-09-02T10:00:00Z',
    '2026-09-02T11:00:00Z',
    '2026-09-05T09:00:00Z',
    '2026-09-05T10:00:00Z',
    '2026-09-05T11:00:00Z',
  ];
  return () => stamps[i++];
}

test('样例领域标识正确', async () => {
  const raw = await readFile(new URL('../fixtures/domain.json', import.meta.url), 'utf8');
  const value = parseDomain(raw);
  assert.equal(value.domain, 'electricity-statistics-revision');
  assert.ok(value.constraints.length >= 2);
});

test('万千瓦时统一折算为亿千瓦时', () => {
  assert.equal(toYiKwh(103200000, '万千瓦时'), 10320);
  assert.equal(toYiKwh(10332, '亿千瓦时'), 10332);
  assert.throws(() => toYiKwh(-1, '亿千瓦时'), /非负/);
  assert.throws(() => toYiKwh(1, '太瓦时'), /不支持/);
  assert.ok(approxEqual(10320.04, 10320.0));
});

test('分产业合计不等于总量时给出可定位的错误', () => {
  const broken = {
    region: '华东',
    period: PERIOD,
    unit: '亿千瓦时',
    month: { primary: 80, secondary: 4000, tertiary: 1200, residential: 900, total: 6100 },
  };
  const { ok, findings } = validateSubmission(broken);
  assert.equal(ok, false);
  const f = findings.find((x) => x.code === CHECK.SECTOR_SUM);
  assert.ok(f);
  assert.equal(f.detail.diff, 80);
});

test('累计值与当月、上月累计不衔接时报错', () => {
  const bad = {
    region: '华南',
    period: PERIOD,
    unit: '亿千瓦时',
    month: { primary: 1, secondary: 10, tertiary: 2, residential: 3, total: 16 },
    cumulative: { primary: 11, secondary: 110, tertiary: 22, residential: 33, total: 176 },
    priorCumulative: { primary: 9, secondary: 100, tertiary: 20, residential: 30, total: 159 },
  };
  const { findings } = validateSubmission(bad);
  assert.ok(findings.some((f) => f.code === CHECK.CUMULATIVE_FLOW && f.detail.sector === 'total'));
});

test('同比增速与基期推算不符时报错', () => {
  const bad = {
    region: '华东',
    period: PERIOD,
    unit: '亿千瓦时',
    month: { total: 110 },
    baseYearMonth: { total: 100, totalYoy: 15 },
  };
  const { ok, findings } = validateSubmission(bad);
  assert.equal(ok, false);
  const f = findings.find((x) => x.code === CHECK.YOY_BASE);
  assert.equal(f.detail.computed, 10);
});

test('居民用电下降但缺少气象注记不能通过', async () => {
  const hd = await fixture('huadong-2026-08');
  delete hd.weatherNote;
  const { ok, findings } = validateSubmission(hd);
  assert.equal(ok, false);
  assert.ok(findings.some((f) => f.code === CHECK.WEATHER_NOTE));
});

test('迟报批次缺少接收时间给出警告', async () => {
  const hn = await fixture('huanan-2026-08.final');
  hn.batches[2].receivedAt = undefined;
  const { ok, findings } = validateSubmission(hn);
  assert.equal(ok, true);
  assert.ok(findings.some((f) => f.code === CHECK.BATCH_GAP && f.severity === 'warning'));
});

test('报送单位只能维护本辖区数据', async () => {
  const ledger = makeLedger(timeline());
  const hd = await fixture('huadong-2026-08');
  assert.throws(() => ledger.submit('r-hn', hd), /只能维护/);
  assert.throws(() => ledger.submit('a1', hd), /角色/);
});

test('迟报阻断发布：辖区缺报时不能汇总', async () => {
  const clock = timeline();
  const ledger = makeLedger(clock);
  const hd = await fixture('huadong-2026-08');
  ledger.submit('r-hd', hd);
  ledger.review('a1', PERIOD, 'approved');
  assert.throws(() => ledger.publish('m1', PERIOD), /华南/);
});

test('初版发布冻结全国表：当月全社会用电量 10320 亿千瓦时', async () => {
  const clock = timeline();
  const ledger = makeLedger(clock);
  ledger.submit('r-hd', await fixture('huadong-2026-08'));
  ledger.submit('r-hn', await fixture('huanan-2026-08.provisional'));
  ledger.review('a1', PERIOD, 'approved', { note: '分项、累计与基期勾稽一致，气象注记齐备' });
  const release = ledger.publish('m1', PERIOD);

  assert.equal(release.version, 1);
  assert.equal(release.table.month.total, 10320);
  assert.equal(release.table.cumulative.total, 71010);
  assert.equal(release.table.yoy.month.residential, -5.38);
  assert.equal(release.changeNotice, null);
  assert.ok(Object.isFrozen(release));
  assert.ok(Object.isFrozen(release.table.month));

  // 发布后报送再变化，不影响已冻结快照。
  ledger.submit('r-hn', await fixture('huanan-2026-08.final'));
  assert.equal(release.table.month.total, 10320);
});

test('后补计量只能产生差异说明与新版本：终版 10332 亿千瓦时', async () => {
  const clock = timeline();
  const ledger = makeLedger(clock);
  ledger.submit('r-hd', await fixture('huadong-2026-08'));
  ledger.submit('r-hn', await fixture('huanan-2026-08.provisional'));
  ledger.review('a1', PERIOD, 'approved');
  const v1 = ledger.publish('m1', PERIOD);

  // 华南专线计量点后补回传。
  ledger.submit('r-hn', await fixture('huanan-2026-08.final'));

  // 无差异说明、未重新核准都不能发布。
  assert.throws(() => ledger.publish('m1', PERIOD), /重新签章/);
  ledger.review('a1', PERIOD, 'approved', { note: '后补批次 B-HN-0905 核实，补计第二产业 12 亿千瓦时' });
  assert.throws(() => ledger.publish('m1', PERIOD), /差异说明/);

  const v2 = ledger.publish('m1', PERIOD, {
    changeNotice: {
      type: CHANGE_TYPES.LATE_REPORT,
      summary: '华南专线计量点后补回传，当月与累计第二产业各补计 12 亿千瓦时',
      regions: ['华南'],
    },
  });

  assert.equal(v2.version, 2);
  assert.equal(v2.supersedes, v1.releaseId);
  assert.equal(v2.table.month.total, 10332);
  assert.equal(v2.changeNotice.fromVersion, 1);
  const changedTotal = v2.changeNotice.diff.changes.filter((c) => c.scope === 'month' && c.sector === 'total');
  assert.deepEqual(changedTotal.map((c) => c.delta), [12]);

  // 旧版仍然存在且数值不变。
  const releases = ledger.listReleases(PERIOD);
  assert.equal(releases.length, 2);
  assert.equal(releases[0].table.month.total, 10320);

  // 不支持的修订原因一律拒绝。
  assert.throws(
    () => ledger.publish('m1', PERIOD, { changeNotice: { type: 'internal-tweak', summary: '内部调整' } }),
    /不支持的修订原因/,
  );
});

test('公众查询可复现任意发布日期看到的表格', async () => {
  const clock = timeline();
  const ledger = makeLedger(clock);
  ledger.submit('r-hd', await fixture('huadong-2026-08'));
  ledger.submit('r-hn', await fixture('huanan-2026-08.provisional'));
  ledger.review('a1', PERIOD, 'approved');
  const v1 = ledger.publish('m1', PERIOD);
  ledger.submit('r-hn', await fixture('huanan-2026-08.final'));
  ledger.review('a1', PERIOD, 'approved');
  const v2 = ledger.publish('m1', PERIOD, {
    changeNotice: { type: CHANGE_TYPES.LATE_REPORT, summary: '后补计量批次回传', regions: ['华南'] },
  });

  assert.equal(ledger.tableAsOf(PERIOD, '2026-09-02T12:00:00Z').releaseId, v1.releaseId);
  assert.equal(ledger.tableAsOf(PERIOD, '2026-09-01T00:00:00Z'), null);
  assert.equal(ledger.tableAsOf(PERIOD, '2026-09-06T00:00:00Z').releaseId, v2.releaseId);
});

test('管理者可追溯总量增速经历的审核与版本', async () => {
  const clock = timeline();
  const ledger = makeLedger(clock);
  ledger.submit('r-hd', await fixture('huadong-2026-08'));
  ledger.submit('r-hn', await fixture('huanan-2026-08.provisional'));
  ledger.review('a1', PERIOD, 'approved', { note: '初核' });
  ledger.publish('m1', PERIOD);
  ledger.submit('r-hn', await fixture('huanan-2026-08.final'));
  ledger.review('a1', PERIOD, 'approved', { note: '复核后补批次' });
  ledger.publish('m1', PERIOD, {
    changeNotice: { type: CHANGE_TYPES.LATE_REPORT, summary: '后补计量', regions: ['华南'] },
  });

  const trail = ledger.auditFigure(PERIOD, 'month', 'total');
  assert.equal(trail.length, 2);
  assert.equal(trail[0].value, 10320);
  assert.equal(trail[1].value, 10332);
  assert.equal(trail[1].yoy, 7.84);
  assert.ok(trail[1].signatures.some((s) => s.note === '复核后补批次'));
  assert.equal(trail[1].changeNotice.type, 'late-report');
});

test('分析人员可按地区定位不平衡来源', async () => {
  const ledger = makeLedger(timeline());
  ledger.submit('r-hd', await fixture('huadong-2026-08'));
  const diagnosis = ledger.diagnose(PERIOD);
  const huanan = diagnosis.find((d) => d.region === '华南');
  assert.equal(huanan.status, 'missing');
});

test('行业重分类必须显式映射且保持总量平衡', () => {
  // 旧口径 A44 与新口径 D44 并存，仅 2026-08 起切换。
  const values = { A44: 100, B22: 50 };
  const mapping = { A44: { to: 'D44', effectiveFrom: '2026-08', reason: '行业分类标准修订' } };

  assert.deepEqual(applyReclassification(values, mapping, '2026-07'), { A44: 100, B22: 50 });
  assert.deepEqual(applyReclassification(values, mapping, '2026-08'), { D44: 100, B22: 50 });

  const before = { secondary: 150 };
  const after = { secondary: 150 };
  assert.equal(reclassificationBalanced(before, after, (a, b) => approxEqual(a, b)), true);
  assert.equal(reclassificationBalanced(before, { secondary: 149 }, (a, b) => approxEqual(a, b, 0.5)), false);
});

test('两版表格差异逐项列出', () => {
  const before = { month: { primary: 1, secondary: 10, tertiary: 2, residential: 3, total: 16 } };
  const after = { month: { primary: 1, secondary: 12, tertiary: 2, residential: 3, total: 18 } };
  const diff = diffReleases(before, after);
  assert.equal(diff.changed, true);
  assert.deepEqual(
    diff.changes.map((c) => [c.sector, c.delta]),
    [['secondary', 2], ['total', 2]],
  );
});

test('情景夹具均覆盖四个产业分项', async () => {
  for (const name of ['huadong-2026-08', 'huanan-2026-08.provisional', 'huanan-2026-08.final']) {
    const s = await fixture(name);
    for (const group of ['month', 'cumulative']) {
      for (const sector of SECTORS) assert.ok(s[group][sector] >= 0, `${name}.${group}.${sector}`);
    }
    assert.ok(s.weatherNote.events.length >= 1, `${name} 应登记气象事件`);
  }
});
