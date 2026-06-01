<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import { fetchAmedasField, type AmedasFieldResponse } from './api';
  import {
    DEFAULT_INTERPOLATION_METHOD,
    INTERPOLATION_METHOD_OPTIONS,
    type InterpolationMethod,
  } from './constants';
  import type { BBox } from './types';

  export let amedasFieldData: AmedasFieldResponse | null = null;
  export let bboxForMap: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };
  export let datetime: string | null = null;
  export let loading: boolean = false;
  export let prefName: string = '';
  /** ヘッダセレクタの補間 method を流用（/v1/amedas 側も同名の method を持つ） */
  export let interpolationMethod: InterpolationMethod = DEFAULT_INTERPOLATION_METHOD;

  let panelRoot: HTMLElement;
  let mapContainer: HTMLDivElement;
  let map: L.Map | null = null;
  let tempOverlay: L.ImageOverlay | null = null;
  let windLayer: L.LayerGroup | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let viewportAmedasData: AmedasFieldResponse | null = null;
  let amedasLoading = false;
  let lastAmedasKey: string | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let suppressMoveFetchOnce = false;

  const SHOW_TEMP_HEATMAP = true;
  // heatmap はある程度細かさを保ちつつ、過剰に重くならないよう viewport/zoom から取得ズームを決める
  function chooseAmedasFetchZ(): number {
    if (!map) return 13;
    // 矢印密度は「ピクセル間隔」基準で決めるが、元の格子点が少ないと密度が上がらない。
    // そのためズームイン時ほど取得 z を上げ、viewport 内の格子点数を確保する。
    const z = Math.round(map.getZoom()) + 3;
    return Math.max(9, Math.min(15, z));
  }

  const AMEDAS_VIEW_STORAGE_KEY = 'airpollutionwatch_amedas_map_view';
  function saveMapView() {
    if (!map) return;
    try {
      const c = map.getCenter();
      const payload = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
      localStorage.setItem(AMEDAS_VIEW_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  function restoreMapView(): boolean {
    if (!map) return false;
    try {
      const raw = localStorage.getItem(AMEDAS_VIEW_STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw) as { lat?: unknown; lon?: unknown; zoom?: unknown };
      const lat = typeof parsed.lat === 'number' ? parsed.lat : null;
      const lon = typeof parsed.lon === 'number' ? parsed.lon : null;
      const zoom = typeof parsed.zoom === 'number' ? parsed.zoom : null;
      if (lat == null || lon == null || zoom == null) return false;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(zoom)) return false;
      map.setView([lat, lon], zoom, { animate: false });
      return true;
    } catch {
      return false;
    }
  }

  let currentAmedas: AmedasFieldResponse | null = null;
  let didInitialFit = false;

  let tempMin = 0;
  let tempMax = 30;
  const DRAW_TEST_ARROW = false;
  // 親(App)から渡される props だが、このパネルは県セレクタに追従しない（未使用警告抑止）
  let _ignoredPrefName = '';
  let _ignoredBboxForMap: BBox | null = null;
  $: _ignoredPrefName = prefName;
  $: _ignoredBboxForMap = bboxForMap;

  $: currentInterpolationLabel =
    INTERPOLATION_METHOD_OPTIONS.find((m) => m.value === interpolationMethod)?.labelJa ??
    interpolationMethod.toUpperCase();

  /** GridStack のパネルドラッグにイベントが伝播しないようにするためのアクション */
  function stopGridDrag(node: HTMLElement) {
    const handler = (e: PointerEvent | TouchEvent | MouseEvent) => {
      e.stopPropagation();
    };
    node.addEventListener('pointerdown', handler);
    node.addEventListener('touchstart', handler, { passive: true });
    return {
      destroy() {
        node.removeEventListener('pointerdown', handler);
        node.removeEventListener('touchstart', handler);
      },
    };
  }

  function tileXYToLonLat(x: number, y: number, zoom: number): [number, number] {
    const n = 2 ** zoom;
    const lon = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
    const lat = (180 / Math.PI) * latRad;
    return [lon, lat];
  }

  function clamp01(t: number): number {
    return Math.max(0, Math.min(1, t));
  }

  function tempToRgba(v: number | null, vMin: number, vMax: number): string {
    if (v == null || Number.isNaN(v)) return 'rgba(0,0,0,0)';
    const t = vMax > vMin ? clamp01((v - vMin) / (vMax - vMin)) : 0.5;
    // 青(寒) → 黄 → 赤(暑) の3点補間
    const a = 0.75;
    const lerp = (x: number, y: number, u: number) => x + (y - x) * u;
    const c0: [number, number, number] = [30, 136, 229]; // blue
    const c1: [number, number, number] = [255, 235, 59]; // yellow
    const c2: [number, number, number] = [229, 57, 53]; // red
    let r: number, g: number, b: number;
    if (t < 0.5) {
      const u = t / 0.5;
      r = lerp(c0[0], c1[0], u);
      g = lerp(c0[1], c1[1], u);
      b = lerp(c0[2], c1[2], u);
    } else {
      const u = (t - 0.5) / 0.5;
      r = lerp(c1[0], c2[0], u);
      g = lerp(c1[1], c2[1], u);
      b = lerp(c1[2], c2[2], u);
    }
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
  }

  function computeTempRange(data: AmedasFieldResponse | null): [number, number] {
    const tField = data?.fields?.temp;
    let vMin = Infinity;
    let vMax = -Infinity;
    if (tField && Array.isArray(tField)) {
      for (const row of tField) {
        for (const v of row ?? []) {
          if (v == null || Number.isNaN(v)) continue;
          vMin = Math.min(vMin, v);
          vMax = Math.max(vMax, v);
        }
      }
    }
    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
      vMin = 0;
      vMax = 30;
    } else if (vMin === vMax) {
      vMin = vMin - 1;
      vMax = vMax + 1;
    }
    tempMin = vMin;
    tempMax = vMax;
    return [vMin, vMax];
  }

  function updateTempOverlay(data: AmedasFieldResponse) {
    if (!map) return;
    if (!SHOW_TEMP_HEATMAP) {
      if (tempOverlay) {
        map.removeLayer(tempOverlay);
        tempOverlay = null;
      }
      return;
    }
    const tempField = data.fields?.temp;
    if (!tempField || tempField.length === 0) return;

    const { tile_x_min, tile_x_max, tile_y_min, tile_y_max, z } = data;
    const nx = tile_x_max - tile_x_min + 1;
    const ny = tile_y_max - tile_y_min + 1;

    const [vMin, vMax] = computeTempRange(data);

    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Leaflet の ImageOverlay は画像の「上」が北になるため、
    // データ（南→北）を上下反転して描画する
    for (let row = 0; row < ny; row++) {
      const canvasRow = ny - 1 - row;
      for (let col = 0; col < nx; col++) {
        const v = tempField[row]?.[col] ?? null;
        ctx.fillStyle = tempToRgba(v, vMin, vMax);
        ctx.fillRect(col, canvasRow, 1, 1);
      }
    }

    // 端のタイル境界で bounds を取る（中心+0.5 だと端が欠けて余白が出やすい）
    const southWest = tileXYToLonLat(tile_x_min, tile_y_max + 1, z);
    const northEast = tileXYToLonLat(tile_x_max + 1, tile_y_min, z);
    const bounds = L.latLngBounds(
      [southWest[1], southWest[0]],
      [northEast[1], northEast[0]]
    );

    if (tempOverlay) {
      map.removeLayer(tempOverlay);
      tempOverlay = null;
    }
    // 気温ヒートマップは風矢印より背面に固定
    tempOverlay = L.imageOverlay(canvas.toDataURL('image/png'), bounds, {
      opacity: 1,
      pane: 'tempPane',
    });
    tempOverlay.addTo(map);
  }

  function updateWindLayer(data: AmedasFieldResponse) {
    if (!map) return;
    const wxField = data.fields?.wx;
    const wyField = data.fields?.wy;
    if (!wxField || !wyField || wxField.length === 0 || wyField.length === 0) return;

    const { tile_x_min, tile_x_max, tile_y_min, tile_y_max, z } = data;
    const nx = tile_x_max - tile_x_min + 1;
    const ny = tile_y_max - tile_y_min + 1;

    if (windLayer) {
      windLayer.clearLayers();
    } else {
      windLayer = L.layerGroup().addTo(map);
    }

    // ---- ズームレベル連動の鏃サイズ ----
    const currentZoom = map.getZoom();
    const degPerPixel = 360 / (256 * Math.pow(2, currentZoom));
    const HEAD_BACK_DEG = degPerPixel * 10;
    const HEAD_WING_DEG = degPerPixel * 6;

    // ---- ビューポートをデータグリッドのタイル座標に変換 ----
    const mapBounds = map.getBounds();
    const n = Math.pow(2, z);
    const tileFromLon = (lon: number) => ((lon + 180) / 360) * n;
    const tileFromLat = (lat: number) => {
      const rad = (lat * Math.PI) / 180;
      return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
    };

    const viewTileXMin = tileFromLon(mapBounds.getWest());
    const viewTileXMax = tileFromLon(mapBounds.getEast());
    // Mercator: 北ほど tile_y が小さい
    const viewTileYMin = tileFromLat(mapBounds.getNorth()); // 北端（小）
    const viewTileYMax = tileFromLat(mapBounds.getSouth()); // 南端（大）

    // col = tile_x - tile_x_min
    const colMin = Math.max(0, Math.floor(viewTileXMin - tile_x_min));
    const colMax = Math.min(nx - 1, Math.ceil(viewTileXMax - tile_x_min));
    // row=0 → tileY=tile_y_max（南端）、row=ny-1 → tileY=tile_y_min（北端）
    // row = tile_y_max - tileY  →  rowMin = tile_y_max - viewTileYMax
    const rowMin = Math.max(0, Math.floor(tile_y_max - viewTileYMax));
    const rowMax = Math.min(ny - 1, Math.ceil(tile_y_max - viewTileYMin));

    if (colMin > colMax || rowMin > rowMax) return;

    // ---- 表示密度: 画面ピクセル間隔ベース（縦横の見た目差を抑える）----
    const size = map.getSize();
    // 矢印密度（小さいほど密）。45px ≒ 90px の縦横2倍密度。
    const TARGET_SPACING_PX = 45;
    const targetCountX = Math.max(1, Math.round(size.x / TARGET_SPACING_PX));
    const targetCountY = Math.max(1, Math.round(size.y / TARGET_SPACING_PX));
    const stepX = Math.max(1, Math.round((colMax - colMin + 1) / targetCountX));
    const stepY = Math.max(1, Math.round((rowMax - rowMin + 1) / targetCountY));
    // 縦横の間隔を揃える（正方格子感）
    const step = Math.max(stepX, stepY);

    // グローバルグリッドに揃えてパン時のジッターを防ぐ
    const colStart = colMin + ((step - (colMin % step)) % step);
    const rowStart = rowMin + ((step - (rowMin % step)) % step);

    const KM_PER_DEG_LAT = 111;

    for (let row = rowStart; row <= rowMax; row += step) {
      for (let col = colStart; col <= colMax; col += step) {
        const wx = wxField[row]?.[col] ?? null;
        const wy = wyField[row]?.[col] ?? null;
        if (wx == null || wy == null || !Number.isFinite(wx) || !Number.isFinite(wy)) continue;

        const tileX = tile_x_min + col;
        // データ配列は南→北想定のため row=0 が tile_y_max 側
        const tileY = tile_y_max - row;
        const [lon, lat] = tileXYToLonLat(tileX + 0.5, tileY + 0.5, z);

        // wx/wy は m/s（東/北成分）想定。1時間移動量（km）→ 度へ変換。
        const dxKm = wx * 3.6;
        const dyKm = wy * 3.6;
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        const dLat = dyKm / KM_PER_DEG_LAT;
        const dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
        const tipLon = lon + dLon;
        const tipLat = lat + dLat;

        L.polyline(
          [[lat, lon], [tipLat, tipLon]],
          { color: '#fff', weight: 2, opacity: 0.9, pane: 'windPane' },
        ).addTo(windLayer);

        // 鏃（左右の羽）
        const len = Math.hypot(dLon, dLat);
        if (Number.isFinite(len) && len > 1e-6) {
          const ux = dLon / len;
          const uy = dLat / len;
          const bx = ux * HEAD_BACK_DEG;
          const by = uy * HEAD_BACK_DEG;
          const px = -uy * HEAD_WING_DEG;
          const py = ux * HEAD_WING_DEG;
          const left: [number, number] = [tipLat - by + py, tipLon - bx + px];
          const right: [number, number] = [tipLat - by - py, tipLon - bx - px];
          L.polyline(
            [[tipLat, tipLon], left],
            { color: '#fff', weight: 2, opacity: 0.9, pane: 'windPane' },
          ).addTo(windLayer);
          L.polyline(
            [[tipLat, tipLon], right],
            { color: '#fff', weight: 2, opacity: 0.9, pane: 'windPane' },
          ).addTo(windLayer);
        }
      }
    }

    if (DRAW_TEST_ARROW) {
      const c = map.getCenter();
      const tip = L.latLng(c.lat + 0.08, c.lng + 0.12);
      L.polyline([c, tip], { color: '#000', weight: 5, opacity: 0.95, pane: 'windPane' }).addTo(
        windLayer,
      );
    }
  }

  function fitToBbox() {
    if (!map) return;
    // AMeDAS パネルは県セレクタと無関係（初回だけ日本全体にフィット）
    const DEFAULT_BBOX: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };
    const bounds = L.latLngBounds(
      [DEFAULT_BBOX.minLat, DEFAULT_BBOX.minLon],
      [DEFAULT_BBOX.maxLat, DEFAULT_BBOX.maxLon]
    );
    map.fitBounds(bounds, { padding: [16, 16] });
  }

  // AMeDAS は viewarea 追従で取得し、なければ親(App)のデータをフォールバックで使う
  $: currentAmedas = viewportAmedasData ?? amedasFieldData ?? null;

  async function loadAmedasForViewport() {
    if (!map || !datetime) return;
    // ヒートマップに余白が出ないよう、少し広めに取得する
    const bounds = map.getBounds().pad(0.15);
    const bboxStr = [
      bounds.getWest(),
      bounds.getSouth(),
      bounds.getEast(),
      bounds.getNorth(),
    ]
      .map((v) => v.toFixed(4))
      .join(',');
    const z = chooseAmedasFetchZ();
    const key = `${bboxStr}|${datetime}|${interpolationMethod}|z=${z}`;
    lastAmedasKey = key;
    amedasLoading = true;
    try {
      const res = await fetchAmedasField(
        bboxStr,
        datetime,
        'temp,wx,wy',
        z,
        interpolationMethod,
        '0.001'
      );
      if (lastAmedasKey !== key) return;
      viewportAmedasData = res;
    } catch (e) {
      console.warn('[MapPanelAmedasLeaflet] fetchAmedasField 失敗', e);
    } finally {
      if (lastAmedasKey === key) amedasLoading = false;
    }
  }

  $: if (map && currentAmedas) {
    updateTempOverlay(currentAmedas);
    updateWindLayer(currentAmedas);
  }

  // bboxForMap（県bbox）には追従しない

  onMount(() => {
    map = L.map(mapContainer, { preferCanvas: true });
    // 表示の重なり順を固定（気温ヒートマップ < 風矢印）
    map.createPane('tempPane');
    map.getPane('tempPane')!.style.zIndex = '250';
    map.createPane('windPane');
    // 風ベクトルは最前面
    map.getPane('windPane')!.style.zIndex = '650';
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '© <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    }).addTo(map);

    if (!didInitialFit) {
      didInitialFit = true;
      // 初回表示はレイアウト確定後に view を復元/初期化する（サイズ未確定で setView するとズレやすい）
      tick().then(() => {
        if (!map) return;
        const restored = restoreMapView();
        if (!restored) fitToBbox();
        // 中心を維持したままサイズ確定
        suppressMoveFetchOnce = true;
        map.invalidateSize({ pan: true, animate: false });
        void loadAmedasForViewport();
      });
    } else {
      void loadAmedasForViewport();
    }
    map.on('moveend', () => {
      if (suppressMoveFetchOnce) {
        suppressMoveFetchOnce = false;
      } else {
        void loadAmedasForViewport();
      }
      saveMapView();
    });
    map.on('zoomend', () => {
      void loadAmedasForViewport();
      saveMapView();
    });

    tick().then(() => {
      const observeTarget = mapContainer?.parentElement ?? panelRoot;
      if (!observeTarget || !map) return;
      resizeObserver = new ResizeObserver(() => {
        if (map) {
          // resize 後も「中心が画面中央」を維持する
          suppressMoveFetchOnce = true;
          map.invalidateSize({ pan: true, animate: false });
          if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
          resizeDebounceTimer = setTimeout(() => {
            if (!map) return;
            void loadAmedasForViewport();
          }, 150);
        }
      });
      resizeObserver.observe(observeTarget);
    });
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    if (map) map.remove();
    map = null;
    tempOverlay = null;
    windLayer = null;
  });
</script>

<section class="section map-section" bind:this={panelRoot}>
  <h2>気温・風向（AMeDAS）</h2>
  {#if datetime}
    <p class="map-datetime">
      対象時刻: {datetime}
      <span class="interp-label">／ 補間: {currentInterpolationLabel}</span>
    </p>
  {/if}
  {#if !amedasFieldData && !loading}
    <p class="muted">
      アメダスグリッドを取得できませんでした（API /v1/amedas を確認してください）。
    </p>
  {/if}
  <div class="map-wrap" role="application" aria-label="地図" use:stopGridDrag>
    <div class="map-leaflet" bind:this={mapContainer}></div>
  </div>
  <p class="map-legend">
    背景: 気温（青→黄→赤）。白い線: 風（向き=風向、長さ=風速の目安）。
    {#if currentAmedas}
      — 表示範囲: <strong>{tempMin.toFixed(1)} ～ {tempMax.toFixed(1)} ℃</strong>
    {/if}
  </p>
</section>

<style>
  .section {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: #fff;
    border-radius: 12px;
    padding: 1.25rem 1.5rem;
    margin-bottom: 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  }
  .section h2 {
    margin: 0 0 0.75rem 0;
    font-size: 1.1rem;
    font-weight: 600;
    color: #333;
  }
  .map-datetime {
    margin: 0 0 0.5rem 0;
    font-size: 0.9rem;
    color: #555;
  }
  .interp-label {
    opacity: 0.95;
  }
  .map-legend {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    color: #666;
  }
  .map-wrap {
    position: relative;
    flex: 1 1 0;
    min-height: 200px;
    border-radius: 8px;
    overflow: hidden;
    background: #e0e0e0;
  }
  .map-leaflet {
    width: 100%;
    height: 100%;
  }
  .map-wrap :global(.leaflet-container) {
    font-family: inherit;
  }
  .muted {
    font-size: 0.85rem;
    color: #888;
  }
</style>

