/**
 * 気象庁 bosai AMeDAS JSON クライアント
 * - latest_time / map / amedastable
 */

import { getOxLevel } from './constants';
import type { BBox, LatestRow } from './types';

const JMA_AMEDAS_BASE = 'https://www.jma.go.jp/bosai/amedas';

const WD_16_DEG_PER_DIV = 360 / 16;

export type AmedasValue = [number | string | null, number] | null | undefined;

export interface AmedasStationMeta {
  type: string;
  elems: string;
  lat: [number, number];
  lon: [number, number];
  alt: number;
  kjName: string;
  knName: string;
  enName: string;
}

export type AmedasTable = Record<string, AmedasStationMeta>;

export type AmedasMapObservation = Record<string, AmedasValue>;

export type AmedasMapData = Record<string, AmedasMapObservation>;

let tableCache: AmedasTable | null = null;
let tablePromise: Promise<AmedasTable> | null = null;

export function degreeMinuteToDecimal(dm: [number, number] | number[] | null | undefined): number | null {
  if (!dm || dm.length < 2) return null;
  const deg = Number(dm[0]);
  const min = Number(dm[1]);
  if (!Number.isFinite(deg) || !Number.isFinite(min)) return null;
  return deg + min / 60;
}

/** [値, flag]。flag≠0・空文字・欠測は null */
export function parseAmedasValue(raw: AmedasValue): number | null {
  if (raw == null || !Array.isArray(raw) || raw.length < 2) return null;
  const flag = Number(raw[1]);
  if (!Number.isFinite(flag) || flag !== 0) return null;
  const v = raw[0];
  if (v === '' || v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * AMeDAS 風向(0=静穏, 1–16) + 風速(m/s) → 東向き/北向き成分 (m/s)。
 * MapPanelLeaflet / wdWsToUV と同じ「吹いていく向き」。
 * 静穏・欠測は null。
 */
export function amedasWindToUV(
  windDirection: number | null,
  windMs: number | null
): { u: number; v: number } | null {
  if (
    windDirection == null ||
    windMs == null ||
    !Number.isFinite(windDirection) ||
    !Number.isFinite(windMs)
  ) {
    return null;
  }
  if (windDirection === 0 || windMs <= 0) return null;
  const wdDeg = (windDirection % 16) * WD_16_DEG_PER_DIV;
  const blowDeg = (wdDeg + 180) % 360;
  const rad = (blowDeg * Math.PI) / 180;
  return {
    u: windMs * Math.sin(rad),
    v: windMs * Math.cos(rad),
  };
}

/** ISO (例: 2026-07-16T13:10:00+09:00) → YYYYMMDDHHMMSS */
export function isoToAmedasKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid AMeDAS datetime: ${iso}`);
  // JST 固定でフォーマット
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const min = String(jst.getUTCMinutes()).padStart(2, '0');
  const sec = String(jst.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}${h}${min}${sec}`;
}

/** datetime-local / 正時 ISO → 正時キー YYYYMMDDHH0000 */
export function hourIsoToAmedasKey(hourIso: string): string {
  const m = hourIso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})/);
  if (m) return `${m[1]}${m[2]}${m[3]}${m[4]}0000`;
  const key = isoToAmedasKey(hourIso);
  return key.slice(0, 10) + '0000';
}

/** AMeDAS キー → 表示用 ISO 風文字列 */
export function amedasKeyToDisplayIso(key: string): string {
  if (!/^\d{14}$/.test(key)) return key;
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${key.slice(8, 10)}:${key.slice(10, 12)}:${key.slice(12, 14)}+09:00`;
}

export async function fetchAmedasLatestTime(): Promise<string> {
  const res = await fetch(`${JMA_AMEDAS_BASE}/data/latest_time.txt`);
  if (!res.ok) throw new Error(`AMeDAS latest_time: HTTP ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error('AMeDAS latest_time: empty');
  return text;
}

export async function fetchAmedasTable(): Promise<AmedasTable> {
  if (tableCache) return tableCache;
  if (tablePromise) return tablePromise;
  tablePromise = (async () => {
    const res = await fetch(`${JMA_AMEDAS_BASE}/const/amedastable.json`);
    if (!res.ok) throw new Error(`AMeDAS table: HTTP ${res.status}`);
    const data = (await res.json()) as AmedasTable;
    tableCache = data;
    return data;
  })();
  try {
    return await tablePromise;
  } finally {
    tablePromise = null;
  }
}

export async function fetchAmedasMap(datetimeKey: string): Promise<AmedasMapData> {
  const res = await fetch(`${JMA_AMEDAS_BASE}/data/map/${datetimeKey}.json`);
  if (!res.ok) throw new Error(`AMeDAS map ${datetimeKey}: HTTP ${res.status}`);
  return (await res.json()) as AmedasMapData;
}

export function pointInBBox(lat: number, lon: number, bbox: BBox): boolean {
  return (
    lon >= bbox.minLon &&
    lon <= bbox.maxLon &&
    lat >= bbox.minLat &&
    lat <= bbox.maxLat
  );
}

export function expandBBox(bbox: BBox, padDeg: number): BBox {
  return {
    minLon: bbox.minLon - padDeg,
    minLat: bbox.minLat - padDeg,
    maxLon: bbox.maxLon + padDeg,
    maxLat: bbox.maxLat + padDeg,
  };
}

function observationToRow(
  stationId: string,
  meta: AmedasStationMeta,
  obs: AmedasMapObservation
): LatestRow | null {
  const lat = degreeMinuteToDecimal(meta.lat);
  const lon = degreeMinuteToDecimal(meta.lon);
  if (lat == null || lon == null) return null;

  const temp = parseAmedasValue(obs.temp);
  const hum = parseAmedasValue(obs.humidity);
  const windDirection = parseAmedasValue(obs.windDirection);
  const wind = parseAmedasValue(obs.wind);
  const uv = amedasWindToUV(windDirection, wind);

  return {
    station_id: stationId,
    name: meta.kjName || stationId,
    municipality: '—',
    lat,
    lon,
    ox: null,
    nox: null,
    no2: null,
    pm25: null,
    temp,
    hum,
    wd: windDirection,
    ws: wind != null ? wind * 10 : null, // 参考用（矢印は wx/wy 優先）
    wx: uv?.u ?? null,
    wy: uv?.v ?? null,
    level: getOxLevel(null),
  };
}

export interface AmedasRowsSplit {
  datetimeKey: string;
  datetimeDisplay: string;
  targetRows: LatestRow[];
  neighborRows: LatestRow[];
}

/**
 * 対象県 bbox 内 → target、拡張 bbox 内かつ対象外 → neighbor。
 */
export function buildAmedasRows(
  table: AmedasTable,
  mapData: AmedasMapData,
  targetBBox: BBox,
  neighborPadDeg = 0.7
): Omit<AmedasRowsSplit, 'datetimeKey' | 'datetimeDisplay'> {
  const expanded = expandBBox(targetBBox, neighborPadDeg);
  const targetRows: LatestRow[] = [];
  const neighborRows: LatestRow[] = [];

  for (const [stationId, meta] of Object.entries(table)) {
    const lat = degreeMinuteToDecimal(meta.lat);
    const lon = degreeMinuteToDecimal(meta.lon);
    if (lat == null || lon == null) continue;
    if (!pointInBBox(lat, lon, expanded)) continue;

    const obs = mapData[stationId];
    if (!obs) continue;
    const row = observationToRow(stationId, meta, obs);
    if (!row) continue;

    if (pointInBBox(lat, lon, targetBBox)) {
      targetRows.push(row);
    } else {
      neighborRows.push(row);
    }
  }

  return { targetRows, neighborRows };
}

/**
 * live なら latest_time、それ以外は正時キーで map を取得し、県 bbox で分割する。
 */
export async function loadAmedasForBBox(
  targetBBox: BBox,
  options: { live: boolean; hourIso?: string | null; neighborPadDeg?: number }
): Promise<AmedasRowsSplit> {
  const table = await fetchAmedasTable();
  let datetimeKey: string;
  if (options.live) {
    const latestIso = await fetchAmedasLatestTime();
    datetimeKey = isoToAmedasKey(latestIso);
  } else {
    const hourIso = options.hourIso;
    if (!hourIso) throw new Error('AMeDAS snapshot requires hourIso');
    datetimeKey = hourIsoToAmedasKey(hourIso);
  }
  const mapData = await fetchAmedasMap(datetimeKey);
  const { targetRows, neighborRows } = buildAmedasRows(
    table,
    mapData,
    targetBBox,
    options.neighborPadDeg ?? 0.7
  );
  return {
    datetimeKey,
    datetimeDisplay: amedasKeyToDisplayIso(datetimeKey),
    targetRows,
    neighborRows,
  };
}
