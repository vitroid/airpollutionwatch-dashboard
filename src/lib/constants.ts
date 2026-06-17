/**
 * 光化学オキシダント 注意報・警報の基準値（環境省）
 * API の OX は ppb で返る想定（0.12 ppm = 120 ppb）
 */

export const OX_THRESHOLDS = {
  /** 要注目: 注意報前の警戒目安（100 ppb で色変更） */
  CAUTION_PPB: 100,
  /** 注意報: 1時間値 0.12 ppm = 120 ppb */
  WARNING_PPB: 120,
  /** 警報: 0.24 ppm = 240 ppb */
  ALERT_PPB: 240,
  /** 重大警報: 0.40 ppm = 400 ppb */
  SEVERE_PPB: 400,
} as const;

export type OxLevel = 'normal' | 'forecast' | 'warning' | 'alert' | 'severe';

export function getOxLevel(oxPpb: number | null | undefined): OxLevel {
  if (oxPpb == null || Number.isNaN(oxPpb)) return 'normal';
  if (oxPpb >= OX_THRESHOLDS.SEVERE_PPB) return 'severe';
  if (oxPpb >= OX_THRESHOLDS.ALERT_PPB) return 'alert';
  if (oxPpb >= OX_THRESHOLDS.WARNING_PPB) return 'warning';
  if (oxPpb >= OX_THRESHOLDS.CAUTION_PPB) return 'forecast'; // 100 ppb で要注目（色変更）
  return 'normal';
}

export const OX_LEVEL_LABELS: Record<OxLevel, string> = {
  normal: '平常',
  forecast: '要注目',
  warning: '注意報',
  alert: '警報',
  severe: '重大警報',
};

/** 地図・セレクターで扱う項目キー（そらまめ風の成分＋気象） */
export type PollutantKey = 'OX' | 'NOX' | 'NO2' | 'PM25' | 'TEMP' | 'HUM' | 'WS';

export interface PollutantMeta {
  /** 内部キー（LatestRow のフィールド名と対応） */
  key: PollutantKey;
  /** API パラメータ（/v1/latest の items 引数など） */
  apiParam: string;
  /** セレクター表示用ラベル */
  labelJa: string;
  /** 見出しなどで使う短いラベル */
  shortLabelJa: string;
  /** 単位（そらまめ互換の想定） */
  unit: string;
}

export const POLLUTANT_OPTIONS: PollutantMeta[] = [
  {
    key: 'OX',
    apiParam: 'ox',
    labelJa: '光化学オキシダント (OX)',
    shortLabelJa: 'OX',
    unit: 'ppb',
  },
  {
    key: 'NOX',
    apiParam: 'nox',
    labelJa: '窒素酸化物 (NOX)',
    shortLabelJa: 'NOX',
    unit: 'ppb',
  },
  {
    key: 'NO2',
    apiParam: 'no2',
    labelJa: '二酸化窒素 (NO2)',
    shortLabelJa: 'NO2',
    unit: 'ppb',
  },
  {
    key: 'PM25',
    apiParam: 'pm25',
    labelJa: '微小粒子状物質 (PM2.5)',
    shortLabelJa: 'PM2.5',
    unit: 'µg/m³',
  },
  {
    key: 'TEMP',
    apiParam: 'temp',
    labelJa: '気温',
    shortLabelJa: '気温',
    unit: '℃',
  },
  {
    key: 'HUM',
    apiParam: 'hum',
    labelJa: '相対湿度',
    shortLabelJa: '湿度',
    unit: '%',
  },
  {
    key: 'WS',
    apiParam: 'ws',
    labelJa: '風速',
    shortLabelJa: '風速',
    unit: 'm/s',
  },
] as const;

export const DEFAULT_POLLUTANT_KEY: PollutantKey = 'OX';

export function getPollutantMeta(key: PollutantKey): PollutantMeta {
  return POLLUTANT_OPTIONS.find((p) => p.key === key) ?? POLLUTANT_OPTIONS[0];
}
