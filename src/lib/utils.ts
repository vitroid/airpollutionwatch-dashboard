import type { OxLevel } from './constants';

export function normalizeStationId(id: string): string {
  const n = id.replace(/\D/g, '');
  return n ? n.padStart(8, '0').slice(-8) : id;
}

export function levelClass(level: OxLevel): string {
  return 'level-' + level;
}

export function formatNum(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return String(Math.round(v * 10) / 10);
}

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false });
  } catch {
    return iso;
  }
}

/** 風向 16 方位インデックス（1–16）を方位ラベルに変換する。1〜16 以外は「—」。 */
export function formatWindDirection16(wd: number | null | undefined): string {
  if (wd == null || Number.isNaN(wd)) return '—';
  // convert.py の wd_codes_JP の並びに合わせる（index 1〜16 が方位、0/17 は特殊扱い）
  const labelsJP = [
    '', // 0: 未使用
    '北北東', // 1
    '北東', // 2
    '東北東', // 3
    '東', // 4
    '東南東', // 5
    '南東', // 6
    '南南東', // 7
    '南', // 8
    '南南西', // 9
    '南西', // 10
    '西南西', // 11
    '西', // 12
    '西北西', // 13
    '北西', // 14
    '北北西', // 15
    '北', // 16
  ] as const;
  const n = Math.round(wd);
  if (n < 1 || n > 16) return '—';
  return labelsJP[n];
}
