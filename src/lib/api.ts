/**
 * airpollutionwatch API クライアント
 * - 開発時: 同じオリジンへ /api でリクエストし、Vite がプロキシで API に転送（CORS 回避）
 * - 本番: VITE_API_BASE_URL が空なら同一オリジン（FastAPI 相乗り）、指定時はその URL にリクエスト
 */

const BASE =
  import.meta.env.DEV
    ? '/api'
    : (typeof import.meta.env.VITE_API_BASE_URL === 'string' && import.meta.env.VITE_API_BASE_URL
        ? import.meta.env.VITE_API_BASE_URL.replace(/\/$/, '')
        : '');

/** 本番で BASE が http なのにページが https だと Mixed Content でブロックされるため、同一ホストならページのオリジンを使う */
function resolveBaseUrl(): string {
  if (import.meta.env.DEV && typeof location !== 'undefined') return location.origin;
  const base = BASE || (typeof location !== 'undefined' ? location.origin : '');
  if (typeof location !== 'undefined' && base && location.origin) {
    try {
      const baseUrl = new URL(base);
      const pageOrigin = new URL(location.origin);
      if (baseUrl.host === pageOrigin.host && baseUrl.protocol !== pageOrigin.protocol)
        return location.origin;
    } catch {
      /* ignore */
    }
  }
  return base;
}

/** 指定 path へのリクエスト URL（デバッグ用） */
export function getApiUrl(path: string, params?: Record<string, string>): string {
  const baseUrl = resolveBaseUrl();
  const pathStr = import.meta.env.DEV ? '/api' + path : path;
  const url = new URL(pathStr, baseUrl || 'http://localhost');
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.toString();
}

export interface PrefectureInfo {
  id: string;
  name_ja: string;
  has_data: boolean;
  region: string;
}

export interface LatestStationValues {
  station_id: string;
  values: Record<string, number | null>;
}

export interface LatestResponse {
  datetime: string;
  stations: LatestStationValues[];
}

export interface StationItem {
  station_id: string;
  pref: string;
  name: string | null;
  name_short: string | null;
  municipality: string | null;
  lat: number | null;
  lon: number | null;
  has_pm25: boolean;
  has_ox: boolean;
}

export interface TimeSeriesPoint {
  datetime: string;
  value: number | null;
}

export interface TimeSeriesSeries {
  station_id: string;
  /** API側のキー変更に備えて両対応（旧: pollutant / 新: item） */
  pollutant?: string;
  item?: string;
  values: TimeSeriesPoint[];
}

export interface TimeSeriesResponse {
  timeseries: TimeSeriesSeries[];
}

export interface LogStatusItem {
  pref_id: string;
  name_ja: string;
  region: string;
  latest_datetime: string | null;
  hours_ago: number | null;
  oldest_continuous_datetime: string | null;
  continuous_days_ago: number | null;
  has_data: boolean;
  log_status: string;
  log_message: string | null;
  pref_url: string | null;
}

export interface LogOverviewResponse {
  status_items: LogStatusItem[];
  collect_log: string | null;
}

/** 県別収集履歴（〇/△/×。レスポンス形式はサーバ実装差分に備えて緩めに扱う） */
export type PrefectureLogHistoryResponse = Record<string, unknown>;

async function get<T>(path: string, params?: Record<string, string>): Promise<T> {
  const baseUrl = resolveBaseUrl();
  const pathStr = import.meta.env.DEV ? '/api' + path : path;
  const url = new URL(pathStr, baseUrl || 'http://localhost');
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** 都道府県一覧（id, name_ja, has_data, region） */
export async function fetchPrefectures(): Promise<PrefectureInfo[]> {
  return get<PrefectureInfo[]>('/v1/prefectures');
}

/** 都道府県の最新値（局ごと） */
export async function fetchLatest(
  pref: string,
  items: string = 'ox,nox,no2,pm25,temp,hum,wd,ws'
): Promise<LatestResponse> {
  // API 側は items クエリで指定（pollutants は旧クライアント互換）
  return get<LatestResponse>('/v1/latest', { pref, items });
}

/** /v1/measurements?format=snapshot の局1件（測定項目はカラム直下） */
export interface SnapshotStationPoint {
  station_id: string;
  target_datetime: string;
  observed_datetime: string;
  [key: string]: string | number | null | undefined;
}

export interface SnapshotResponse {
  target_datetime: string;
  data: SnapshotStationPoint[];
  spec: Record<string, unknown>;
}

function snapshotToLatest(res: SnapshotResponse): LatestResponse {
  const metaKeys = new Set(['station_id', 'target_datetime', 'observed_datetime']);
  const stations: LatestStationValues[] = res.data.map((pt) => {
    const values: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(pt)) {
      if (metaKeys.has(k)) continue;
      if (v == null || v === '') {
        values[k] = null;
      } else if (typeof v === 'number') {
        values[k] = Number.isFinite(v) ? v : null;
      } else {
        const n = Number(v);
        values[k] = Number.isFinite(n) ? n : null;
      }
    }
    return { station_id: String(pt.station_id), values };
  });
  return { datetime: res.target_datetime, stations };
}

/**
 * 指定正時のスナップショット（地図・表向け）。
 * format=snapshot かつ from=to で、各局の当該時刻以前の最新値を返す。
 */
export async function fetchMeasurementsSnapshot(
  pref: string,
  hourIso: string,
  items: string = 'ox,nox,no2,pm25,temp,hum,wd,ws'
): Promise<LatestResponse> {
  const res = await get<SnapshotResponse>('/v1/measurements', {
    pref,
    from: hourIso,
    to: hourIso,
    items,
    format: 'snapshot',
  });
  return snapshotToLatest(res);
}

/** 測定局一覧（県・測定項目で絞り込み） */
export async function fetchStations(
  pref: string,
  has?: string
): Promise<StationItem[]> {
  const params: Record<string, string> = { pref };
  if (has) params.has = has;
  return get<StationItem[]>('/v1/stations', params);
}

/** 時系列データ（局 or 県、期間、format=series） */
export async function fetchMeasurementsSeries(
  pref: string,
  fromIso: string,
  toIso: string,
  items: string = 'ox,nox,no2'
): Promise<TimeSeriesResponse> {
  return get<TimeSeriesResponse>('/v1/measurements', {
    pref,
    from: fromIso,
    to: toIso,
    items,
    format: 'series',
  });
}


/** 指定都道府県の輪郭（簡略化済み rings）と輪郭から算出した bbox。県単位で取得するため軽量。 */
export interface PrefectureOutlineResponse {
  rings: [number, number][][];
  /** [minLon, minLat, maxLon, maxLat]。輪郭から事前計算済み。 */
  bbox?: [number, number, number, number];
}
export async function fetchPrefectureOutline(prefId: string): Promise<PrefectureOutlineResponse> {
  return get<PrefectureOutlineResponse>(`/v1/geojson/outline/${prefId}`);
}

/** 収集ジョブログの概要（県別ステータス + collect.log 本文） */
export async function fetchLogOverview(): Promise<LogOverviewResponse> {
  return get<LogOverviewResponse>('/v1/log');
}

/** 県別収集履歴（/v1/log/prefectures/{pref_id}/history） */
export async function fetchLogPrefectureHistory(
  prefId: string
): Promise<PrefectureLogHistoryResponse> {
  return get<PrefectureLogHistoryResponse>(`/v1/log/prefectures/${encodeURIComponent(prefId)}/history`);
}
export { BASE as apiBaseUrl };
