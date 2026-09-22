// 电量单位归一化。各地区报送可能使用万千瓦时或亿千瓦时，
// 统一折算为亿千瓦时后再做勾稽，杜绝单位换算错误进入发布版本。

export const KWH = '千瓦时';
export const WAN_KWH = '万千瓦时';
export const YI_KWH = '亿千瓦时';

const TO_YI = {
  [KWH]: 1 / 1e8,
  [WAN_KWH]: 1 / 1e4,
  [YI_KWH]: 1,
};

export function toYiKwh(value, unit) {
  const factor = TO_YI[unit];
  if (factor === undefined) {
    throw new Error(`不支持的计量单位：${unit}`);
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`电量必须为非负有限数值，收到：${value}`);
  }
  return value * factor;
}

// 勾稽允许的四舍五入误差（亿千瓦时）。公开数据多保留一至两位小数。
export function approxEqual(a, b, tolerance = 0.5) {
  return Math.abs(a - b) <= tolerance;
}
