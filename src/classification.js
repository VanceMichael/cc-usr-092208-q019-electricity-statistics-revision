// 产业与行业分类。全社会用电量 = 分产业电量之和，
// 行业重分类只能通过显式映射完成，且映射必须保持总量平衡
// （只是在分项之间搬移，不凭空增减）。

// 四大产业分项键，固定顺序用于汇总与展示。
export const SECTORS = [
  'primary', // 第一产业
  'secondary', // 第二产业
  'tertiary', // 第三产业
  'residential', // 城乡居民生活
];

export const SECTOR_LABELS = {
  primary: '第一产业',
  secondary: '第二产业',
  tertiary: '第三产业',
  residential: '城乡居民生活',
  total: '全社会用电量',
};

// 重分类映射：旧行业代码 -> 新行业代码，附所在产业。
// 映射仅在指定生效月份起适用，历史发布仍按旧映射复现。
export function applyReclassification(valuesByIndustry, mapping, period) {
  const result = {};
  for (const [code, entry] of Object.entries(valuesByIndustry)) {
    const target = mapping[code];
    if (target && target.effectiveFrom <= period) {
      result[target.to] = (result[target.to] || 0) + entry;
    } else {
      result[code] = (result[code] || 0) + entry;
    }
  }
  return result;
}

// 平衡中性检查：重分类前后各产业合计必须一致（容差内）。
export function reclassificationBalanced(beforeSectorTotals, afterSectorTotals, approx) {
  return Object.keys(beforeSectorTotals).every((sector) =>
    approx(beforeSectorTotals[sector] ?? 0, afterSectorTotals[sector] ?? 0),
  );
}
