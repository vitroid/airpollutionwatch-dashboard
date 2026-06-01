import type { OxLevel } from './constants';

export interface LatestRow {
  station_id: string;
  name: string;
  municipality: string;
  lat: number | null;
  lon: number | null;
  ox: number | null;
  nox: number | null;
  no2: number | null;
  pm25: number | null;
  temp: number | null;
  hum: number | null;
  /** 旧形式: 風向(16方位) */
  wd: number | null;
  /** 旧形式: 風速（0.1m/s単位想定） */
  ws: number | null;
  /** 新形式: 東向き成分（単位は API 側に依存。矢印描画は相対スケール） */
  wx: number | null;
  /** 新形式: 北向き成分（単位は API 側に依存。矢印描画は相対スケール） */
  wy: number | null;
  level: OxLevel;
}

export interface OxSeriesItem {
  station_id: string;
  name: string;
  values: { datetime: string; value: number | null }[];
}

export interface BBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}
