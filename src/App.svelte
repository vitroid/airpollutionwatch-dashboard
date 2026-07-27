<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import 'gridstack/dist/gridstack.min.css';
  import { GridStack } from 'gridstack';
  import {
    fetchPrefectures,
    fetchLatest,
    fetchMeasurementsSnapshot,
    fetchStations,
    fetchMeasurementsSeries,
    fetchPrefectureOutline,
    type LatestResponse,
    type LatestStationValues,
    type PrefectureInfo,
    type StationItem,
    type TimeSeriesResponse,
  } from './lib/api';
  import { getOxLevel } from './lib/constants';
  import { normalizeStationId } from './lib/utils';
  import type { LatestRow, OxSeriesItem, BBox } from './lib/types';
  import neighborMap from './data/neighbor.json';
  import { loadAmedasForBBox } from './lib/amedasApi';
  import MapPanelLeaflet from './lib/MapPanelLeaflet.svelte';
  import AmedasPanel from './lib/AmedasPanel.svelte';
  import TimeSeriesPanel from './lib/TimeSeriesPanel.svelte';
  import LatestTable from './lib/LatestTable.svelte';
  import AppendixPanel from './lib/AppendixPanel.svelte';
  import LogOverview from './lib/LogOverview.svelte';

  const OX_DISPLAY_MULTIPLIER: number = 1;

  const PREF_STORAGE_KEY = 'airpollutionwatch_selected_pref';
  const GRID_LAYOUT_KEY = 'airpollutionwatch_grid_layout';

  type LayoutItem = { id?: string; x?: number; y?: number; w?: number; h?: number };

  let gridContainer: HTMLDivElement;
  let grid: ReturnType<typeof GridStack.init> | undefined;
  let gridLayoutLoading = false;

  type ViewMode = 'dashboard' | 'log';
  let view: ViewMode = 'dashboard';

  const DEFAULT_LAYOUT = [
    { id: 'panel-map', x: 0, y: 0, w: 12, h: 6 },
    { id: 'panel-amedas', x: 0, y: 6, w: 12, h: 6 },
    { id: 'panel-timeseries', x: 0, y: 12, w: 6, h: 6 },
    { id: 'panel-table', x: 6, y: 12, w: 6, h: 6 },
    { id: 'panel-appendix', x: 0, y: 18, w: 12, h: 2 },
  ];

  const MIN_ITEM_W = 3;
  const MIN_ITEM_H = 3;

  function savePref(id: string) {
    try {
      localStorage.setItem(PREF_STORAGE_KEY, id);
      sessionStorage.setItem(PREF_STORAGE_KEY, id);
    } catch {
      // プライベートモード等で storage が使えない場合
    }
  }

  function loadSavedPref(): string | null {
    try {
      return localStorage.getItem(PREF_STORAGE_KEY) ?? sessionStorage.getItem(PREF_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  let PREF = '';

  let prefectures: PrefectureInfo[] = [];
  $: prefName = prefectures.find((p) => p.id === PREF)?.name_ja ?? PREF;

  /** 隣接県マップ（Delaunay 由来）。キー・値とも API の pref id */
  const NEIGHBORS = neighborMap as Record<string, string[]>;

  let latest: LatestResponse | null = null;
  let stations: StationItem[] = [];
  let timeseries: TimeSeriesResponse | null = null;
  let loading = true;
  let error: string | null = null;
  let lastFetched: Date | null = null;
  let outlineBbox: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null = null;

  /** 隣接県の測定局（収束線の内挿サンプル＋地図表示用）。対象県の表・順位には混ぜない */
  let neighborRows: LatestRow[] = [];
  /** 隣接県の局メタ（静的）はキャッシュして再取得を避ける */
  const neighborStationCache = new Map<string, StationItem[]>();

  /** AMeDAS（収束線検算）。本体の load 失敗とは独立 */
  let amedasRows: LatestRow[] = [];
  let amedasNeighborRows: LatestRow[] = [];
  let amedasDatetime: string | null = null;
  let amedasLoading = false;
  let amedasError: string | null = null;
  let amedasLoadSeq = 0;

  /** true のとき /v1/latest（現在）。false のとき選択正時の snapshot */
  let liveMode = true;
  /** datetime-local 用（JST 想定の `YYYY-MM-DDTHH:mm`） */
  let datetimeLocalValue = '';

  const LATEST_ITEMS = 'ox,nox,no2,pm25,temp,hum,wd,ws,wx,wy';

  const DEFAULT_BBOX: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };

  const stationMap = new Map<string, StationItem>();
  $: {
    stationMap.clear();
    stations.forEach((s) => {
      const key = normalizeStationId(s.station_id);
      stationMap.set(key, s);
    });
  }

  function computeStationsBBox(list: StationItem[]): BBox | null {
    const withCoords = list.filter((s) => s.lat != null && s.lon != null && Number.isFinite(s.lat!) && Number.isFinite(s.lon!));
    if (withCoords.length === 0) return null;
    const lons = withCoords.map((s) => s.lon!);
    const lats = withCoords.map((s) => s.lat!);
    const pad = 0.05;
    return {
      minLon: Math.min(...lons) - pad,
      minLat: Math.min(...lats) - pad,
      maxLon: Math.max(...lons) + pad,
      maxLat: Math.max(...lats) + pad,
    };
  }

  $: bboxFromStations = computeStationsBBox(stations) ?? DEFAULT_BBOX;

  $: bboxForMap = outlineBbox ?? bboxFromStations ?? DEFAULT_BBOX;

  /** LatestStationValues[] を局メタと結合して LatestRow[] へ（OX 降順）。対象県・隣接県で共用 */
  function mapValuesToRows(
    values: LatestStationValues[],
    metaMap: Map<string, StationItem>
  ): LatestRow[] {
    const byNorm = new Map<string, LatestStationValues>();
    for (const s of values) {
      const key = normalizeStationId(s.station_id);
      const existing = byNorm.get(key);
      const hasOx = (v: LatestStationValues) => v.values['OX'] != null && !Number.isNaN(v.values['OX']);
      if (!existing || (hasOx(s) && !hasOx(existing))) byNorm.set(key, s);
    }
    return Array.from(byNorm.values())
      .map((s) => {
        const key = normalizeStationId(s.station_id);
        const meta = metaMap.get(key);
        const rawOx = s.values['OX'] ?? null;
        const ox = rawOx != null ? rawOx * OX_DISPLAY_MULTIPLIER : null;
        const level = getOxLevel(ox);
        const name = meta?.name ?? meta?.name_short ?? null;
        return {
          station_id: s.station_id,
          name: name ?? s.station_id,
          municipality: meta?.municipality ?? '—',
          lat: meta?.lat ?? null,
          lon: meta?.lon ?? null,
          ox,
          nox: s.values['NOX'] ?? null,
          no2: s.values['NO2'] ?? null,
          pm25: s.values['PM25'] ?? null,
          temp: s.values['TEMP'] ?? null,
          hum: s.values['HUM'] ?? null,
          // 風は API 側のキー表記ゆれ（大文字/小文字）を吸収
          wd: (s.values['WD'] ?? s.values['wd'] ?? null) as number | null,
          ws: (s.values['WS'] ?? s.values['ws'] ?? null) as number | null,
          wx: (s.values['WX'] ?? s.values['wx'] ?? null) as number | null,
          wy: (s.values['WY'] ?? s.values['wy'] ?? null) as number | null,
          level,
        } satisfies LatestRow;
      })
      .sort((a, b) => (b.ox ?? -1) - (a.ox ?? -1));
  }

  let latestWithNames: LatestRow[] = [];
  $: latestWithNames = latest ? mapValuesToRows(latest.stations, stationMap) : [];

  let oxSeriesByStation: OxSeriesItem[] = [];
  $: oxSeriesByStation = timeseries?.timeseries
    ? (() => {
        const byStation = new Map<string, { datetime: string; value: number | null }[]>();
        for (const ts of timeseries.timeseries) {
          const itemKey = ts.pollutant ?? ts.item;
          if (itemKey !== 'OX') continue;
          const stationKey = normalizeStationId(ts.station_id);
          if (!byStation.has(stationKey)) byStation.set(stationKey, ts.values);
        }
        return Array.from(byStation.entries()).map(([key, values]) => ({
          station_id: key,
          name: stationMap.get(key)?.name_short ?? stationMap.get(key)?.name ?? key,
          values,
        }));
      })()
    : [];

  function toJstIsoHour(d: Date): string {
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const y = jst.getUTCFullYear();
    const m = jst.getUTCMonth() + 1;
    const day = jst.getUTCDate();
    const h = jst.getUTCHours();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(day)}T${pad(h)}:00:00+09:00`;
  }

  function isoToDatetimeLocalValue(iso: string): string {
    const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    return m ? `${m[1]}T${m[2]}:${m[3]}` : '';
  }

  /** datetime-local 値を JST 正時 ISO に（分は切り捨て） */
  function datetimeLocalToJstHourIso(local: string): string {
    const m = local.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})/);
    if (!m) return toJstIsoHour(new Date());
    return `${m[1]}T${m[2]}:00:00+09:00`;
  }

  function maxDatetimeLocalValue(): string {
    return isoToDatetimeLocalValue(toJstIsoHour(new Date()));
  }

  function syncDatetimeInputFromData() {
    if (latest?.datetime) {
      datetimeLocalValue = isoToDatetimeLocalValue(latest.datetime);
    } else if (!datetimeLocalValue) {
      datetimeLocalValue = maxDatetimeLocalValue();
    }
  }

  async function load() {
    loading = true;
    error = null;
    neighborRows = [];
    amedasRows = [];
    amedasNeighborRows = [];
    amedasDatetime = null;
    amedasError = null;
    try {
      outlineBbox = null;
      const outlineRes = await fetchPrefectureOutline(PREF).catch(() => null);
      if (outlineRes) {
        if (outlineRes.bbox && outlineRes.bbox.length >= 4) {
          outlineBbox = {
            minLon: outlineRes.bbox[0],
            minLat: outlineRes.bbox[1],
            maxLon: outlineRes.bbox[2],
            maxLat: outlineRes.bbox[3],
          };
        }
      }

      const hourIso = liveMode
        ? null
        : datetimeLocalToJstHourIso(datetimeLocalValue || maxDatetimeLocalValue());

      const [latestRes, stationsRes, tsRes] = await Promise.all([
        liveMode
          ? fetchLatest(PREF, LATEST_ITEMS)
          : fetchMeasurementsSnapshot(PREF, hourIso!, LATEST_ITEMS),
        fetchStations(PREF, 'ox'),
        loadSeriesEndingAt(hourIso),
      ]);
      latest = latestRes;
      stations = stationsRes;
      timeseries = tsRes;
      lastFetched = new Date();
      if (liveMode) syncDatetimeInputFromData();
      else if (hourIso) datetimeLocalValue = isoToDatetimeLocalValue(hourIso);

      // 隣接県は本体表示をブロックせず、解決後に非同期で追い込み反映
      const refBbox: BBox = outlineBbox ?? computeStationsBBox(stationsRes) ?? DEFAULT_BBOX;
      void loadNeighbors(PREF, hourIso, liveMode, refBbox);
      void loadAmedas(PREF, hourIso, liveMode, refBbox);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      await tick();
    }
  }

  /** 気象庁 AMeDAS。県 bbox＋隣接パッドで絞り、検算パネルへ渡す */
  async function loadAmedas(
    forPref: string,
    hourIso: string | null,
    live: boolean,
    refBbox: BBox
  ): Promise<void> {
    const seq = ++amedasLoadSeq;
    amedasLoading = true;
    amedasError = null;
    try {
      const result = await loadAmedasForBBox(refBbox, {
        live,
        hourIso,
        neighborPadDeg: 0.7,
      });
      if (seq !== amedasLoadSeq || forPref !== PREF) return;
      amedasRows = result.targetRows;
      amedasNeighborRows = result.neighborRows;
      amedasDatetime = result.datetimeDisplay;
    } catch (e) {
      if (seq !== amedasLoadSeq || forPref !== PREF) return;
      amedasError = e instanceof Error ? e.message : String(e);
      amedasRows = [];
      amedasNeighborRows = [];
      amedasDatetime = null;
    } finally {
      if (seq === amedasLoadSeq) amedasLoading = false;
    }
  }

  /**
   * 隣接県（neighbor.json）の測定局を取得し neighborRows に反映。
   * IDW 内挿・地図表示に使う。対象県の表・OX 順位には影響させない。
   * 参照 bbox を広げた範囲と交差する県だけ残し、Delaunay 由来の遠方ペアを除外する。
   */
  async function loadNeighbors(
    forPref: string,
    hourIso: string | null,
    live: boolean,
    refBbox: BBox
  ): Promise<void> {
    const available = new Set(prefectures.filter((p) => p.has_data).map((p) => p.id));
    const ids = (NEIGHBORS[forPref] ?? []).filter((id) => id !== forPref && available.has(id));
    if (ids.length === 0) return;

    const margin = 0.7;
    const eb: BBox = {
      minLon: refBbox.minLon - margin,
      minLat: refBbox.minLat - margin,
      maxLon: refBbox.maxLon + margin,
      maxLat: refBbox.maxLat + margin,
    };
    const anyStationInside = (list: StationItem[]): boolean =>
      list.some(
        (s) =>
          s.lat != null &&
          s.lon != null &&
          Number.isFinite(s.lat) &&
          Number.isFinite(s.lon) &&
          s.lon >= eb.minLon &&
          s.lon <= eb.maxLon &&
          s.lat >= eb.minLat &&
          s.lat <= eb.maxLat
      );

    try {
      const stationLists = await Promise.all(
        ids.map(async (id) => {
          const cached = neighborStationCache.get(id);
          if (cached) return { id, list: cached };
          const list = await fetchStations(id).catch(() => [] as StationItem[]);
          neighborStationCache.set(id, list);
          return { id, list };
        })
      );

      const kept = stationLists.filter(({ list }) => anyStationInside(list));
      if (kept.length === 0) return;

      const fetched = await Promise.all(
        kept.map(async ({ id, list }) => {
          const resp = await (live
            ? fetchLatest(id, LATEST_ITEMS)
            : fetchMeasurementsSnapshot(id, hourIso!, LATEST_ITEMS)
          ).catch(() => null);
          return { list, resp };
        })
      );

      // 県切り替え等で対象が変わっていたら破棄
      if (forPref !== PREF) return;

      const rows: LatestRow[] = [];
      for (const { list, resp } of fetched) {
        if (!resp) continue;
        const meta = new Map<string, StationItem>();
        for (const s of list) meta.set(normalizeStationId(s.station_id), s);
        rows.push(...mapValuesToRows(resp.stations, meta));
      }
      neighborRows = rows;
    } catch {
      // 隣接県の取得失敗は本体に影響させない
      neighborRows = [];
    }
  }

  /** 終端時刻の直前24時間の OX 時系列。null 終端＝現在 */
  async function loadSeriesEndingAt(toHourIso: string | null): Promise<TimeSeriesResponse | null> {
    const toDate = toHourIso ? new Date(toHourIso) : new Date();
    const fromDate = new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
    const fromIso = toJstIsoHour(fromDate);
    const toIso = toHourIso ?? toJstIsoHour(toDate);
    try {
      return await fetchMeasurementsSeries(PREF, fromIso, toIso, 'ox');
    } catch {
      return null;
    }
  }

  function selectPref(id: string) {
    if (id === PREF) return;
    PREF = id;
    savePref(PREF);
    load();
  }

  function onDatetimeInput(e: Event) {
    const v = (e.currentTarget as HTMLInputElement).value;
    if (!v) return;
    datetimeLocalValue = v;
    liveMode = false;
    load();
  }

  function goNow() {
    liveMode = true;
    load();
  }

  function getSavedLayout(): LayoutItem[] | null {
    try {
      const raw = localStorage.getItem(GRID_LAYOUT_KEY) ?? sessionStorage.getItem(GRID_LAYOUT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const normalized: LayoutItem[] = [];
      for (const item of parsed as (LayoutItem & { width?: number; height?: number })[]) {
        const w = Number(item.w ?? item.width ?? 6);
        const h = Number(item.h ?? item.height ?? 3);
        let id = item.id;
        if (id === 'panel-weather') id = 'panel-appendix';
        if (id === 'panel-convergence') continue;
        normalized.push({
          id,
          x: Number(item.x ?? 0),
          y: Number(item.y ?? 0),
          w: Math.max(MIN_ITEM_W, w),
          h: Math.max(MIN_ITEM_H, h),
        });
      }
      const looksValid = normalized.some((n) => (n.w ?? 0) >= 5 && (n.h ?? 0) >= 4);
      return looksValid ? normalized : null;
    } catch {
      return null;
    }
  }

  function getInitialLayout(): LayoutItem[] {
    const saved = getSavedLayout();
    if (!saved?.length) return DEFAULT_LAYOUT;
    // 旧レイアウトに無いパネルを DEFAULT から補完
    const have = new Set(saved.map((s) => s.id).filter(Boolean));
    const merged = [...saved];
    let maxY = 0;
    for (const s of saved) {
      maxY = Math.max(maxY, (s.y ?? 0) + (s.h ?? 0));
    }
    for (const d of DEFAULT_LAYOUT) {
      if (d.id && !have.has(d.id)) {
        merged.push({ ...d, y: maxY });
        maxY += d.h ?? 6;
      }
    }
    return merged;
  }

  function initGrid() {
    if (!gridContainer || grid != null) return;
    grid = GridStack.init(
      {
        column: 12,
        cellHeight: 80,
        margin: 8,
        float: true,
        // 地図/グラフ内のドラッグはパネル移動にしない（パン/ズーム操作を優先）
        draggable: {
          cancel:
            '.map-wrap, .leaflet-container, canvas, svg, input, select, textarea, button, a',
        },
      },
      gridContainer
    );
    const layoutToApply = getInitialLayout();
    if (layoutToApply.length) {
      gridLayoutLoading = true;
      grid.load(layoutToApply, false);
      requestAnimationFrame(() => {
        gridLayoutLoading = false;
      });
    }
    grid.on('change', saveLayout);
    grid.on('resizestop', saveLayout);
    grid.on('dragstop', saveLayout);
  }

  function saveLayout() {
    if (grid == null || gridLayoutLoading) return;
    try {
      const raw = grid.save(false) as LayoutItem[];
      const layout = raw.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }));
      const json = JSON.stringify(layout);
      localStorage.setItem(GRID_LAYOUT_KEY, json);
      sessionStorage.setItem(GRID_LAYOUT_KEY, json);
    } catch {
      // ignore
    }
  }

  $: if (view === 'log' && grid != null) {
    grid.destroy(false);
    grid = undefined;
  }

  $: if (view === 'dashboard') {
    tick().then(() => {
      if (view !== 'dashboard' || !gridContainer) return;
      initGrid();
    });
  }

  onMount(async () => {
    const prefs = await fetchPrefectures().catch(() => [] as PrefectureInfo[]);
    prefectures = prefs;

    const saved = loadSavedPref();
    const available = prefs.filter((p) => p.has_data);

    if (saved && available.some((p) => p.id === saved)) {
      PREF = saved;
    } else {
      PREF = available[0]?.id ?? '';
    }

    if (PREF) {
      savePref(PREF);
      load();
    }

    await tick();
    if (view === 'dashboard' && gridContainer) {
      initGrid();
    }
  });

  onDestroy(() => {
    if (grid != null) {
      grid.destroy(false);
    }
  });
</script>

<main class="dashboard">
  <header class="header">
    <div class="header-title">
      {#if view === 'dashboard'}
        <h1>{prefName} 光化学オキシダント 監視ダッシュボード</h1>
      {:else}
        <h1>収集ジョブログ / 巡回状況</h1>
      {/if}
    </div>
    <div class="header-actions">
      {#if view === 'dashboard'}
        <label class="pref-selector">
          <span class="pref-selector-label">都道府県</span>
          <select value={PREF} on:change={(e) => selectPref(e.currentTarget.value)} class="pref-select">
            {#if prefectures.length === 0}
              <option value={PREF}>読み込み中…</option>
            {:else}
              {#each prefectures as p}
                <option value={p.id} selected={p.id === PREF} disabled={!p.has_data}>{p.name_ja}{#if !p.has_data}（データなし）{/if}</option>
              {/each}
            {/if}
          </select>
        </label>
        <label class="datetime-selector">
          <span class="pref-selector-label">対象時刻</span>
          <input
            type="datetime-local"
            class="datetime-input"
            step="3600"
            max={maxDatetimeLocalValue()}
            value={datetimeLocalValue}
            on:change={onDatetimeInput}
            disabled={loading || !PREF}
          />
        </label>
        <button type="button" class:live={liveMode} on:click={goNow} disabled={loading || liveMode} title="最新時刻のデータを表示">
          Now
        </button>
        <button type="button" on:click={load} disabled={loading}>{loading ? '取得中…' : '更新'}</button>
        {#if lastFetched}
          <span class="updated">最終更新: {lastFetched.toLocaleString('ja-JP')}{#if !liveMode}（過去表示）{/if}</span>
        {/if}
      {/if}
      <button type="button" class:secondary={view === 'dashboard'} on:click={() => (view = view === 'dashboard' ? 'log' : 'dashboard')}>
        {view === 'dashboard' ? '巡回ログビューを開く' : 'ダッシュボードに戻る'}
      </button>
    </div>
  </header>

  {#if view === 'dashboard'}
    {#if error}
      <div class="error" role="alert">
        <strong>データ取得エラー:</strong> {error}
        <br /><small>API ベース URL を確認してください（.env の VITE_API_BASE_URL）</small>
      </div>
    {/if}

    <div class="grid-stack grid-stack-dashboard" bind:this={gridContainer}>
      <div
        class="grid-stack-item"
        id="panel-map"
        gs-id="panel-map"
        gs-x="0"
        gs-y="0"
        gs-w="12"
        gs-h="6"
        gs-min-w="3"
        gs-min-h="3"
      >
        <div class="grid-stack-item-content">
          <MapPanelLeaflet
            {latestWithNames}
            {neighborRows}
            {bboxForMap}
            datetime={latest?.datetime ?? null}
            {prefName}
          />
        </div>
      </div>
      <div
        class="grid-stack-item"
        id="panel-amedas"
        gs-id="panel-amedas"
        gs-x="0"
        gs-y="6"
        gs-w="12"
        gs-h="6"
        gs-min-w="3"
        gs-min-h="3"
      >
        <div class="grid-stack-item-content">
          <AmedasPanel
            latestWithNames={amedasRows}
            neighborRows={amedasNeighborRows}
            {bboxForMap}
            datetime={amedasDatetime}
            {prefName}
            loading={amedasLoading}
            error={amedasError}
          />
        </div>
      </div>
      <div
        class="grid-stack-item"
        id="panel-timeseries"
        gs-id="panel-timeseries"
        gs-x="0"
        gs-y="12"
        gs-w="6"
        gs-h="6"
        gs-min-w="3"
        gs-min-h="3"
      >
        <div class="grid-stack-item-content">
          <TimeSeriesPanel
            {oxSeriesByStation}
            oxDisplayMultiplier={OX_DISPLAY_MULTIPLIER}
          />
        </div>
      </div>
      <div
        class="grid-stack-item"
        id="panel-table"
        gs-id="panel-table"
        gs-x="6"
        gs-y="12"
        gs-w="6"
        gs-h="6"
        gs-min-w="3"
        gs-min-h="3"
      >
        <div class="grid-stack-item-content">
          <LatestTable
            {latestWithNames}
            datetime={latest?.datetime ?? null}
            oxDisplayMultiplier={OX_DISPLAY_MULTIPLIER}
          />
        </div>
      </div>
      <div
        class="grid-stack-item"
        id="panel-appendix"
        gs-id="panel-appendix"
        gs-x="0"
        gs-y="18"
        gs-w="12"
        gs-h="2"
        gs-min-w="6"
        gs-min-h="1"
      >
        <div class="grid-stack-item-content">
          <AppendixPanel />
        </div>
      </div>
    </div>
  {:else}
    <LogOverview />
  {/if}

  <footer class="site-footer">
    <p>&copy; {new Date().getFullYear()} Masakazu Matsumoto. <a href="http://andersan.net:8089/docs" target="_blank" rel="noopener">airpollutionwatch API</a></p>
  </footer>
</main>

<style>
  .dashboard {
    width: 100%;
    max-width: none;
    margin: 0;
    padding: 1.5rem;
    box-sizing: border-box;
    font-family: 'Segoe UI', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', sans-serif;
    color: #1a1a1a;
    background: #f5f6f8;
    min-height: 100vh;
  }
  .header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    background: linear-gradient(135deg, #0d47a1 0%, #1565c0 100%);
    color: #fff;
    padding: 1.5rem 2rem;
    border-radius: 12px;
    margin-bottom: 1.5rem;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  .header-title { flex: 1 1 auto; min-width: 0; }
  .header-title h1 { margin: 0 0 0.25rem 0; font-size: 1.6rem; font-weight: 700; }
  .header-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
  }
  .pref-selector { display: inline-flex; align-items: center; gap: 0.5rem; }
  .pref-selector-label { font-size: 0.9rem; opacity: 0.95; }
  .pref-select {
    padding: 0.4rem 0.6rem;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    font-size: 0.95rem;
    cursor: pointer;
  }
  .pref-select option { background: #1a1a1a; color: #fff; }
  .datetime-selector { display: inline-flex; align-items: center; gap: 0.5rem; }
  .datetime-input {
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.4);
    background: rgba(255, 255, 255, 0.15);
    color: #fff;
    font-size: 0.9rem;
    font-family: inherit;
    color-scheme: dark;
  }
  .datetime-input:disabled {
    opacity: 0.7;
    cursor: not-allowed;
  }
  .header-actions button {
    padding: 0.5rem 1rem; border-radius: 8px; border: none;
    background: rgba(255, 255, 255, 0.2); color: #fff; cursor: pointer; font-weight: 600;
  }
  .header-actions button.live {
    background: rgba(255, 255, 255, 0.45);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  }
  .header-actions button.secondary {
    background: rgba(0, 0, 0, 0.15);
  }
  .header-actions button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.35); }
  .header-actions button:disabled { opacity: 0.7; cursor: not-allowed; }
  .updated { font-size: 0.85rem; opacity: 0.9; }
  .error {
    background: #ffebee; color: #c62828; padding: 1rem 1.5rem; border-radius: 8px; margin-bottom: 1.5rem;
  }
  .grid-stack-dashboard {
    margin-bottom: 1.5rem;
  }
  .grid-stack-dashboard :global(.grid-stack-item-content) {
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .grid-stack-dashboard :global(.grid-stack-item-content) > :global(*) {
    min-height: 0;
    flex: 1 1 0;
    overflow: auto;
  }
  .site-footer {
    margin-top: 1rem;
    text-align: center;
  }
  .site-footer p {
    margin: 0;
    font-size: 0.75rem;
    color: #aaa;
  }
  .site-footer a {
    color: #aaa;
    text-decoration: none;
  }
  .site-footer a:hover {
    text-decoration: underline;
  }
</style>
