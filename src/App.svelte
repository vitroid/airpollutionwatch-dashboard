<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import 'gridstack/dist/gridstack.min.css';
  import { GridStack } from 'gridstack';
  import {
    fetchPrefectures,
    fetchLatest,
    fetchStations,
    fetchMeasurementsSeries,
    fetchGridField,
    fetchAmedasField,
    fetchPrefectureOutline,
    type LatestResponse,
    type LatestStationValues,
    type PrefectureInfo,
    type StationItem,
    type TimeSeriesResponse,
    type GridFieldResponse,
    type AmedasFieldResponse,
  } from './lib/api';
  import {
    getOxLevel,
    DEFAULT_INTERPOLATION_METHOD,
    INTERPOLATION_METHOD_OPTIONS,
    type InterpolationMethod,
  } from './lib/constants';
  import { normalizeStationId } from './lib/utils';
  import type { LatestRow, OxSeriesItem, BBox } from './lib/types';
  import MapPanelLeaflet from './lib/MapPanelLeaflet.svelte';
  import MapPanelAmedasLeaflet from './lib/MapPanelAmedasLeaflet.svelte';
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

  /** /v1/grid/field の補間 method（地図パネル・Leaflet/Plotly 共通） */
  let interpolationMethod: InterpolationMethod = DEFAULT_INTERPOLATION_METHOD;

  const DEFAULT_LAYOUT = [
    { id: 'panel-map', x: 0, y: 0, w: 6, h: 6 },
    { id: 'panel-amedas', x: 6, y: 0, w: 6, h: 6 },
    { id: 'panel-timeseries', x: 0, y: 6, w: 6, h: 6 },
    { id: 'panel-table', x: 6, y: 6, w: 6, h: 6 },
    { id: 'panel-appendix', x: 0, y: 12, w: 12, h: 2 },
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

  let latest: LatestResponse | null = null;
  let stations: StationItem[] = [];
  let timeseries: TimeSeriesResponse | null = null;
  let gridFieldData: GridFieldResponse | null = null;
  let amedasFieldData: AmedasFieldResponse | null = null;
  let loading = true;
  let error: string | null = null;
  let lastFetched: Date | null = null;
  let outlineRings: [number, number][][] = [];
  let outlineBbox: { minLon: number; minLat: number; maxLon: number; maxLat: number } | null = null;
  /** MapPanel にデータ更新を通知するカウンター */
  let dataVersion = 0;

  const DEFAULT_BBOX: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };

  const stationMap = new Map<string, StationItem>();
  $: {
    stationMap.clear();
    stations.forEach((s) => {
      const key = normalizeStationId(s.station_id);
      stationMap.set(key, s);
    });
  }

  $: bboxFromStations = (() => {
    const withCoords = stations.filter((s) => s.lat != null && s.lon != null && Number.isFinite(s.lat!) && Number.isFinite(s.lon!));
    if (withCoords.length === 0) return DEFAULT_BBOX;
    const lons = withCoords.map((s) => s.lon!);
    const lats = withCoords.map((s) => s.lat!);
    const pad = 0.05;
    return {
      minLon: Math.min(...lons) - pad,
      minLat: Math.min(...lats) - pad,
      maxLon: Math.max(...lons) + pad,
      maxLat: Math.max(...lats) + pad,
    };
  })();

  $: bboxForMap = outlineBbox ?? bboxFromStations ?? DEFAULT_BBOX;

  let latestWithNames: LatestRow[] = [];
  $: latestWithNames = latest
    ? (() => {
        const byNorm = new Map<string, LatestStationValues>();
        for (const s of latest!.stations) {
          const key = normalizeStationId(s.station_id);
          const existing = byNorm.get(key);
          const hasOx = (v: LatestStationValues) => v.values['OX'] != null && !Number.isNaN(v.values['OX']);
          if (!existing || (hasOx(s) && !hasOx(existing))) byNorm.set(key, s);
        }
        return Array.from(byNorm.values())
          .map((s) => {
            const key = normalizeStationId(s.station_id);
            const meta = stationMap.get(key);
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
      })()
    : [];

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

  async function load() {
    loading = true;
    error = null;
    try {
      outlineRings = [];
      outlineBbox = null;
      const outlineRes = await fetchPrefectureOutline(PREF).catch(() => null);
      if (outlineRes) {
        outlineRings = outlineRes.rings;
        if (outlineRes.bbox && outlineRes.bbox.length >= 4) {
          outlineBbox = {
            minLon: outlineRes.bbox[0],
            minLat: outlineRes.bbox[1],
            maxLon: outlineRes.bbox[2],
            maxLat: outlineRes.bbox[3],
          };
        }
      }
      const [latestRes, stationsRes, tsRes] = await Promise.all([
        fetchLatest(PREF, 'ox,nox,no2,pm25,temp,hum,wd,ws,wx,wy'),
        fetchStations(PREF, 'ox'),
        loadLast24hSeries(),
      ]);
      latest = latestRes;
      stations = stationsRes;
      timeseries = tsRes;
      lastFetched = new Date();
      const loadBbox =
        outlineBbox
          ? `${outlineBbox.minLon},${outlineBbox.minLat},${outlineBbox.maxLon},${outlineBbox.maxLat}`
          : (() => {
              const withCoords = stationsRes.filter((s) => s.lat != null && s.lon != null && Number.isFinite(s.lat!) && Number.isFinite(s.lon!));
              if (withCoords.length === 0) return `${DEFAULT_BBOX.minLon},${DEFAULT_BBOX.minLat},${DEFAULT_BBOX.maxLon},${DEFAULT_BBOX.maxLat}`;
              const pad = 0.05;
              const lons = withCoords.map((s) => s.lon!);
              const lats = withCoords.map((s) => s.lat!);
              return `${Math.min(...lons) - pad},${Math.min(...lats) - pad},${Math.max(...lons) + pad},${Math.max(...lats) + pad}`;
            })();
      if (latestRes.datetime) {
        try {
          gridFieldData = await fetchGridField(
            loadBbox,
            'ox',
            latestRes.datetime,
            13,
            interpolationMethod,
            '0.007'
          );
          const v = gridFieldData?.values;
          console.log('[load] gridField 取得成功 values.length=', v?.length ?? 0, 'values[0]?.length=', Array.isArray(v?.[0]) ? (v[0] as unknown[]).length : '-');
        } catch (e) {
          gridFieldData = null;
          console.warn('[load] gridField 取得失敗', e);
        }
        try {
          amedasFieldData = await fetchAmedasField(
            loadBbox,
            latestRes.datetime,
            'temp,wx,wy',
            13,
            interpolationMethod,
            '0.001'
          );
        } catch (e) {
          amedasFieldData = null;
          console.warn('[load] amedasField 取得失敗', e);
        }
      } else {
        gridFieldData = null;
        amedasFieldData = null;
        console.log('[load] latestRes.datetime がないため gridField は取得しません');
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
      await tick();
      dataVersion++;
    }
  }

  function toJstIsoHour(d: Date): string {
    const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const y = jst.getUTCFullYear();
    const m = jst.getUTCMonth() + 1;
    const day = jst.getUTCDate();
    const h = jst.getUTCHours();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${y}-${pad(m)}-${pad(day)}T${pad(h)}:00:00+09:00`;
  }

  async function loadLast24hSeries(): Promise<TimeSeriesResponse | null> {
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - 24 * 60 * 60 * 1000);
    const fromIso = toJstIsoHour(fromDate);
    const toIso = toJstIsoHour(toDate);
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

  function handleInterpolationChange(method: string) {
    if (method === interpolationMethod) return;
    interpolationMethod = method as InterpolationMethod;
    // 補間 method 変更後に「更新」ボタンを押さなくても反映されるよう、グリッドのみ再取得する
    if (latest?.datetime) {
      const loadBbox =
        outlineBbox
          ? `${outlineBbox.minLon},${outlineBbox.minLat},${outlineBbox.maxLon},${outlineBbox.maxLat}`
          : (() => {
              const withCoords = stations.filter(
                (s) =>
                  s.lat != null &&
                  s.lon != null &&
                  Number.isFinite(s.lat!) &&
                  Number.isFinite(s.lon!)
              );
              if (withCoords.length === 0)
                return `${DEFAULT_BBOX.minLon},${DEFAULT_BBOX.minLat},${DEFAULT_BBOX.maxLon},${DEFAULT_BBOX.maxLat}`;
              const pad = 0.05;
              const lons = withCoords.map((s) => s.lon!);
              const lats = withCoords.map((s) => s.lat!);
              return `${Math.min(...lons) - pad},${Math.min(...lats) - pad},${Math.max(
                ...lons
              ) + pad},${Math.max(...lats) + pad}`;
            })();
      Promise.allSettled([
        fetchGridField(loadBbox, 'ox', latest.datetime, 13, interpolationMethod, '0.007'),
        fetchAmedasField(loadBbox, latest.datetime, 'temp,wx,wy', 13, interpolationMethod, '0.001'),
      ])
        .then((results) => {
          const [gridRes, amedasRes] = results;
          if (gridRes.status === 'fulfilled') gridFieldData = gridRes.value;
          else {
            console.warn('[App] gridField 再取得失敗', gridRes.reason);
            gridFieldData = null;
          }
          if (amedasRes.status === 'fulfilled') amedasFieldData = amedasRes.value;
          else {
            console.warn('[App] amedasField 再取得失敗', amedasRes.reason);
            amedasFieldData = null;
          }
        })
        .finally(async () => {
          await tick();
          dataVersion++;
        });
    }
  }

  function getSavedLayout(): LayoutItem[] | null {
    try {
      const raw = localStorage.getItem(GRID_LAYOUT_KEY) ?? sessionStorage.getItem(GRID_LAYOUT_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return null;
      const normalized = parsed.map((item: LayoutItem & { width?: number; height?: number }) => {
        const w = Number(item.w ?? item.width ?? 6);
        const h = Number(item.h ?? item.height ?? 3);
        let id = item.id;
        if (id === 'panel-weather') id = 'panel-appendix';
        return {
          id,
          x: Number(item.x ?? 0),
          y: Number(item.y ?? 0),
          w: Math.max(MIN_ITEM_W, w),
          h: Math.max(MIN_ITEM_H, h),
        };
      });
      const looksValid = normalized.some((n) => (n.w ?? 0) >= 5 && (n.h ?? 0) >= 4);
      return looksValid ? normalized : null;
    } catch {
      return null;
    }
  }

  function getInitialLayout(): LayoutItem[] {
    const saved = getSavedLayout();
    if (saved?.length) return saved;
    return DEFAULT_LAYOUT;
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
            '.map-wrap, .leaflet-container, .plotly-map-wrap, .plotly-map, canvas, svg, input, select, textarea, button, a',
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
        <label class="pref-selector">
          <span class="pref-selector-label">補間アルゴリズム</span>
          <select
            value={interpolationMethod}
            on:change={(e) => handleInterpolationChange(e.currentTarget.value)}
            class="pref-select"
          >
            {#each INTERPOLATION_METHOD_OPTIONS as m}
              <option value={m.value} selected={m.value === interpolationMethod}>
                {m.labelJa}
              </option>
            {/each}
          </select>
        </label>
        <button type="button" on:click={load} disabled={loading}>{loading ? '取得中…' : '更新'}</button>
        {#if lastFetched}
          <span class="updated">最終更新: {lastFetched.toLocaleString('ja-JP')}</span>
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
        gs-w="6"
        gs-h="6"
        gs-min-w="3"
        gs-min-h="3"
      >
        <div class="grid-stack-item-content">
          <MapPanelLeaflet
            {gridFieldData}
            {latestWithNames}
            {outlineRings}
            {bboxForMap}
            datetime={latest?.datetime ?? null}
            {loading}
            {prefName}
            oxDisplayMultiplier={OX_DISPLAY_MULTIPLIER}
            interpolationMethod={interpolationMethod}
          />
        </div>
      </div>
      <div
        class="grid-stack-item"
        id="panel-amedas"
        gs-id="panel-amedas"
        gs-x="6"
        gs-y="0"
        gs-w="6"
        gs-h="6"
        gs-min-w="3"
        gs-min-h="3"
      >
        <div class="grid-stack-item-content">
          <MapPanelAmedasLeaflet
            {amedasFieldData}
            {bboxForMap}
            datetime={latest?.datetime ?? null}
            {loading}
            {prefName}
            interpolationMethod={interpolationMethod}
          />
        </div>
      </div>
      <div
        class="grid-stack-item"
        id="panel-timeseries"
        gs-id="panel-timeseries"
        gs-x="0"
        gs-y="6"
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
        gs-y="6"
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
        gs-y="12"
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
    max-width: 1400px;
    margin: 0 auto;
    padding: 1.5rem;
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
  .header-actions button {
    padding: 0.5rem 1rem; border-radius: 8px; border: none;
    background: rgba(255, 255, 255, 0.2); color: #fff; cursor: pointer; font-weight: 600;
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
