<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import { fetchGridField, type GridFieldResponse } from './api';
  import {
    DEFAULT_INTERPOLATION_METHOD,
    INTERPOLATION_METHOD_OPTIONS,
    type InterpolationMethod,
  } from './constants';
  import type { LatestRow, BBox } from './types';

  export let gridFieldData: GridFieldResponse | null = null;
  export let latestWithNames: LatestRow[] = [];
  export let outlineRings: [number, number][][] = [];
  export let bboxForMap: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };
  export let datetime: string | null = null;
  export let loading: boolean = false;
  export let prefName: string = '';
  export let oxDisplayMultiplier: number = 1;
  /** /v1/grid/field の補間 method（ヘッダセレクタから受け取る） */
  export let interpolationMethod: InterpolationMethod = DEFAULT_INTERPOLATION_METHOD;

  const REF_PPB = 120;

  let panelRoot: HTMLElement;
  let mapContainer: HTMLDivElement;
  let map: L.Map | null = null;
  let heatOverlay: L.ImageOverlay | null = null;
  let outlineLayer: L.LayerGroup | null = null;
  let windArrowLayer: L.LayerGroup | null = null;
  let stationLayer: L.LayerGroup | null = null;
  let resizeObserver: ResizeObserver | null = null;

  const SHOW_HEATMAP = true;

  let viewportGridData: GridFieldResponse | null = null;
  let currentGrid: GridFieldResponse | null = null;
  let gridLoading = false;
  let lastGridKey: string | null = null;
  let lastFittedBboxKey: string | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  let dataRangeMin: number = 0;
  let dataRangeMax: number = REF_PPB;
  let validStationWind = 0;
  let windSegments = 0;

  const DRAW_TEST_ARROW = false;
  $: currentInterpolationLabel =
    INTERPOLATION_METHOD_OPTIONS.find((m) => m.value === interpolationMethod)?.labelJa ??
    'ATPS';

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

  function valueToRgbaRelative(v: number | null, vMin: number, vMax: number): string {
    if (v == null || Number.isNaN(v)) return 'rgba(0,0,0,0)';
    const range = vMax - vMin;
    const t = range > 0 ? Math.max(0, Math.min(1, (v - vMin) / range)) : 0;
    const a = 0.8;
    let r: number, g: number, b: number;
    if (t <= 0.25) {
      const s = t / 0.25;
      r = 34 + s * (76 - 34);
      g = 139 + s * (175 - 139);
      b = 34 + s * (74 - 34);
    } else if (t <= 0.5) {
      const s = (t - 0.25) / 0.25;
      r = 76 + s * (255 - 76);
      g = 175 + s * (235 - 175);
      b = 74 + s * (59 - 74);
    } else if (t <= 0.75) {
      const s = (t - 0.5) / 0.25;
      r = 255;
      g = 235 + s * (224 - 235);
      b = 59 + s * (170 - 59);
    } else {
      const s = (t - 0.75) / 0.25;
      r = 255;
      g = 224 - s * 224;
      b = 170 - s * 170;
    }
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
  }

  function oxToColor(ox: number | null, zMin = 0, zMax = 250): string {
    if (ox == null || !Number.isFinite(ox)) return 'rgb(180,180,180)';
    const t = Math.max(0, Math.min(1, (ox - zMin) / (zMax - zMin || 1)));
    const colors: [number, string][] = [
      [0, 'rgb(34,139,34)'],
      [0.25, 'rgb(76,175,74)'],
      [0.5, 'rgb(255,235,59)'],
      [0.75, 'rgb(255,152,0)'],
      [1, 'rgb(227,26,28)'],
    ];
    let i = 0;
    while (i + 1 < colors.length && colors[i + 1][0] < t) i++;
    const [t0, c0] = colors[i];
    const [t1, c1] = colors[i + 1] ?? colors[i];
    const u = (t - t0) / (t1 - t0 || 1);
    const parseRgb = (s: string) => {
      const m = s.match(/rgb\((\d+),(\d+),(\d+)\)/);
      return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [128, 128, 128];
    };
    const [r0, g0, b0] = parseRgb(c0);
    const [r1, g1, b1] = parseRgb(c1);
    const r = Math.round(r0 + u * (r1 - r0));
    const g = Math.round(g0 + u * (g1 - g0));
    const b = Math.round(b0 + u * (b1 - b0));
    return `rgb(${r},${g},${b})`;
  }

  function computeGlobalRange(data: GridFieldResponse | null): [number, number] {
    let vMin = Infinity;
    let vMax = -Infinity;

    if (data) {
      const { values, tile_x_min, tile_x_max, tile_y_min, tile_y_max } = data;
      const nx = tile_x_max - tile_x_min + 1;
      const ny = tile_y_max - tile_y_min + 1;
      const mul = oxDisplayMultiplier;

      const getVal = (row: number, col: number): number | null => {
        const v = values[row]?.[col];
        if (v == null || Number.isNaN(v)) return null;
        return v * mul;
      };

      for (let row = 0; row < ny; row++) {
        for (let col = 0; col < nx; col++) {
          const val = getVal(row, col);
          if (val != null) {
            vMin = Math.min(vMin, val);
            vMax = Math.max(vMax, val);
          }
        }
      }
    }

    for (const row of latestWithNames) {
      if (row.ox != null && Number.isFinite(row.ox)) {
        vMin = Math.min(vMin, row.ox);
        vMax = Math.max(vMax, row.ox);
      }
    }

    if (!Number.isFinite(vMin) || !Number.isFinite(vMax)) {
      vMin = 0;
      vMax = REF_PPB;
    } else if (vMin === vMax) {
      vMin = Math.max(0, vMin - 5);
      vMax = vMax + 5;
    }

    dataRangeMin = vMin;
    dataRangeMax = vMax;
    return [vMin, vMax];
  }

  /** ヒートマップ彩色は絶対スケール（0～REF_PPB ppb）で行う */
  const HEATMAP_OX_ABS_MIN = 0;
  const HEATMAP_OX_ABS_MAX = REF_PPB;
  /** 1度あたりの距離（km） */
  const KM_PER_DEG_LAT = 111;
  /** 風向(16方位) → ベクトルに変換する場合の係数 */
  const WD_16_DEG_PER_DIV = 360 / 16;

  function updateHeatOverlay(data: GridFieldResponse) {
    if (!map) return;
    if (!SHOW_HEATMAP) {
      if (heatOverlay) {
        map.removeLayer(heatOverlay);
        heatOverlay = null;
      }
      return;
    }
    const { values, tile_x_min, tile_x_max, tile_y_min, tile_y_max, z } = data;
    const nx = tile_x_max - tile_x_min + 1;
    const ny = tile_y_max - tile_y_min + 1;
    const mul = oxDisplayMultiplier;

    const [vMin, vMax] = computeGlobalRange(data);
    dataRangeMin = vMin;
    dataRangeMax = vMax;

    const getVal = (row: number, col: number): number | null => {
      const v = values[row]?.[col];
      if (v == null || Number.isNaN(v)) return null;
      return v * mul;
    };

    const canvas = document.createElement('canvas');
    canvas.width = nx;
    canvas.height = ny;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Leaflet の ImageOverlay では画像の「上」が北になるため、
    // タイル配列（南→北）の行インデックスを上下反転して描画する
    for (let row = 0; row < ny; row++) {
      const canvasRow = ny - 1 - row;
      for (let col = 0; col < nx; col++) {
        const val = getVal(row, col);
        ctx.fillStyle = valueToRgbaRelative(val, HEATMAP_OX_ABS_MIN, HEATMAP_OX_ABS_MAX);
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

    if (heatOverlay) {
      map.removeLayer(heatOverlay);
      heatOverlay = null;
    }
    // ヒートマップは不透明でベースタイルの「上」、風矢印/マーカーの「下」に重ねる
    heatOverlay = L.imageOverlay(canvas.toDataURL('image/png'), bounds, {
      opacity: 1,
      pane: 'heatPane',
    });
    heatOverlay.addTo(map);
  }

  function updateOutlineLayer() {
    // 県境輪郭は白地図タイル上では省略
    if (!map) return;
    if (outlineLayer) {
      outlineLayer.clearLayers();
    }
  }

  /**
   * 測定局の風ベクトルから矢印の線分（各要素は [[lat,lng],[lat,lng]]）を生成。
   * - zoom と bounds でビューポート内の局のみ対象・鏃サイズをズーム連動に
   * - 新形式: wx/wy（東/北成分）を優先
   * - 旧形式: wd/ws（16方位/風速）にも後方互換で対応
   */
  function stationWindToArrowSegments(
    rows: LatestRow[],
    zoom: number,
    bounds: L.LatLngBounds,
  ): [number, number][][] {
    const points = rows.filter(
      (r) =>
        r.lat != null &&
        r.lon != null &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        bounds.contains([r.lat!, r.lon!]) &&
        ((r.wx != null && r.wy != null && Number.isFinite(r.wx) && Number.isFinite(r.wy)) ||
          (r.wd != null && r.ws != null && Number.isFinite(r.wd) && Number.isFinite(r.ws)))
    );
    const segments: [number, number][][] = [];
    // ズームレベルに連動した鏃サイズ（ピクセル換算で一定に見えるよう調整）
    const degPerPixel = 360 / (256 * Math.pow(2, zoom));
    const HEAD_BACK_DEG = degPerPixel * 10;
    const HEAD_WING_DEG = degPerPixel * 6;
    for (const r of points) {
      const lat = r.lat!;
      const lon = r.lon!;
      let dLon: number;
      let dLat: number;
      if (r.wx != null && r.wy != null && Number.isFinite(r.wx) && Number.isFinite(r.wy)) {
        // wx/wy は m/s（東/北成分）想定。1時間移動量（km）→ 度へ変換。
        const dxKm = r.wx * 3.6; // m/s * 3600 / 1000
        const dyKm = r.wy * 3.6;
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        dLat = dyKm / KM_PER_DEG_LAT;
        dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
      } else {
        // 旧: wd は「吹いてくる方向」なので 180°反転して「吹いていく方向」にする
        const wdDeg = (r.wd! % 16) * WD_16_DEG_PER_DIV;
        const blowDeg = (wdDeg + 180) % 360;
        const rad = (blowDeg * Math.PI) / 180;
        // station 側の WS は 0.1 m/s 単位（API互換）として扱う
        const speedMs = r.ws! * 0.1;
        const distKm = speedMs * 3.6; // 1時間移動量
        const dxKm = distKm * Math.sin(rad);
        const dyKm = distKm * Math.cos(rad);
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        dLat = dyKm / KM_PER_DEG_LAT;
        dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
      }
      const tipLon = lon + dLon;
      const tipLat = lat + dLat;
      segments.push([[lat, lon], [tipLat, tipLon]]);

      // 鏃（左右の羽）
      const len = Math.hypot(dLon, dLat);
      if (Number.isFinite(len) && len > 1e-6) {
        const ux = dLon / len;
        const uy = dLat / len;
        const back = HEAD_BACK_DEG;
        const wing = HEAD_WING_DEG;
        const bx = ux * back;
        const by = uy * back;
        const px = -uy * wing;
        const py = ux * wing;
        const left: [number, number] = [tipLat - by + py, tipLon - bx + px];
        const right: [number, number] = [tipLat - by - py, tipLon - bx - px];
        segments.push([
          [tipLat, tipLon],
          left,
        ]);
        segments.push([
          [tipLat, tipLon],
          right,
        ]);
      }
    }
    return segments;
  }

  function updateWindArrowLayer() {
    if (!map) return;
    if (windArrowLayer) {
      windArrowLayer.clearLayers();
    } else {
      windArrowLayer = L.layerGroup().addTo(map);
    }
    validStationWind = latestWithNames.filter(
      (r) =>
        r.lat != null &&
        r.lon != null &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        ((r.wx != null && r.wy != null && Number.isFinite(r.wx) && Number.isFinite(r.wy)) ||
          (r.wd != null && r.ws != null && Number.isFinite(r.wd) && Number.isFinite(r.ws)))
    ).length;
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const segs = stationWindToArrowSegments(latestWithNames, zoom, bounds);
    windSegments = segs.length;
    for (const seg of segs) {
      if (seg.length < 2) continue;
      L.polyline(seg, { color: '#fff', weight: 3, opacity: 0.95, pane: 'windPane' }).addTo(
        windArrowLayer!
      );
    }
    if (DRAW_TEST_ARROW) {
      const c = map.getCenter();
      const tip = L.latLng(c.lat + 0.08, c.lng + 0.12);
      L.polyline([c, tip], { color: '#000', weight: 5, opacity: 0.95, pane: 'windPane' }).addTo(
        windArrowLayer!
      );
    }
  }

  function updateStationLayer() {
    if (!map) return;
    if (stationLayer) {
      stationLayer.clearLayers();
    } else {
      stationLayer = L.layerGroup().addTo(map);
    }

    for (const row of latestWithNames) {
      if (
        row.lat == null ||
        row.lon == null ||
        !Number.isFinite(row.lat) ||
        !Number.isFinite(row.lon)
      )
        continue;
      const color = oxToColor(row.ox, HEATMAP_OX_ABS_MIN, HEATMAP_OX_ABS_MAX);
      const marker = L.circleMarker([row.lat, row.lon], {
        radius: 6,
        color: '#333',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
        pane: 'stationPane',
      });
      const popup = `${row.name}<br>OX: ${
        row.ox != null ? row.ox.toFixed(1) : '—'
      } ppb`;
      marker.bindPopup(popup);
      marker.addTo(stationLayer);
    }
    // 最後に追加したマーカー群が最前面になるよう、stationLayer は heatOverlay より後に addTo している
  }

  function fitToBbox() {
    if (!map || !bboxForMap) return;
    const bounds = L.latLngBounds(
      [bboxForMap.minLat, bboxForMap.minLon],
      [bboxForMap.maxLat, bboxForMap.maxLon]
    );
    map.fitBounds(bounds, { padding: [16, 16] });
  }

  $: currentGrid = viewportGridData ?? gridFieldData ?? null;

  $: if (map && currentGrid) {
    void oxDisplayMultiplier;
    updateHeatOverlay(currentGrid);
  }

  $: if (map) {
    void outlineRings.length;
    void latestWithNames.length;
    updateOutlineLayer();
    updateWindArrowLayer();
    updateStationLayer();
  }

  $: if (map && bboxForMap) {
    // bboxForMap が同値でも新しいオブジェクトになる場合があるため、無限 fit を防ぐ
    const k = `${bboxForMap.minLon.toFixed(4)},${bboxForMap.minLat.toFixed(4)},${bboxForMap.maxLon.toFixed(4)},${bboxForMap.maxLat.toFixed(4)}`;
    if (k !== lastFittedBboxKey) {
      lastFittedBboxKey = k;
      fitToBbox();
    }
  }

  // datetime / 補間method が更新されたら、viewarea でグリッドを取り直す
  $: if (map && datetime) {
    void datetime;
    void interpolationMethod;
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    refreshDebounceTimer = setTimeout(() => {
      if (!map) return;
      void loadGridForViewport();
    }, 0);
  }

  async function loadGridForViewport() {
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
    const key = `${bboxStr}|${datetime}|${interpolationMethod}`;
    lastGridKey = key;
    gridLoading = true;
    try {
      // viewarea に合わせて取得ズームを決める（Leaflet の現在ズームに追従）
      const z = Math.max(5, Math.min(15, Math.round(map.getZoom())));
      const res = await fetchGridField(
        bboxStr,
        'ox',
        datetime,
        z,
        interpolationMethod,
        '0.007'
      );
      if (lastGridKey !== key) return;
      viewportGridData = res;
    } catch (e) {
      console.warn('[MapPanelLeaflet] fetchGridField 失敗', e);
    } finally {
      if (lastGridKey === key) {
        gridLoading = false;
      }
    }
  }

  onMount(() => {
    map = L.map(mapContainer, {
      preferCanvas: true,
    });
    // 表示の重なり順を固定（ヒートマップ < 風矢印 < 測定局マーカー）
    map.createPane('heatPane');
    map.getPane('heatPane')!.style.zIndex = '250';
    map.createPane('windPane');
    // 風ベクトルは最前面（マーカーより上）
    map.getPane('windPane')!.style.zIndex = '650';
    map.createPane('stationPane');
    map.getPane('stationPane')!.style.zIndex = '600';
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '© <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    }).addTo(map);

    fitToBbox();

    updateOutlineLayer();
    updateWindArrowLayer();
    updateStationLayer();

    void loadGridForViewport();

    map.on('moveend', () => {
      void loadGridForViewport();
      updateWindArrowLayer();
    });

    map.on('zoomend', () => {
      void loadGridForViewport();
      updateWindArrowLayer();
    });

    tick().then(() => {
      const observeTarget = mapContainer?.parentElement ?? panelRoot;
      if (!observeTarget || !map) return;
      resizeObserver = new ResizeObserver(() => {
        if (map) {
          // resize による自動パンで moveend が発火しないようにする
          map.invalidateSize({ pan: false });
          // ただし表示内容は viewarea に依存するため、軽くデバウンスして再取得/再描画する
          if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
          resizeDebounceTimer = setTimeout(() => {
            if (!map) return;
            void loadGridForViewport();
            updateWindArrowLayer();
          }, 150);
        }
      });
      resizeObserver.observe(observeTarget);
    });
  });

  onDestroy(() => {
    resizeObserver?.disconnect();
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    if (refreshDebounceTimer) clearTimeout(refreshDebounceTimer);
    if (map) {
      map.remove();
    }
    map = null;
    heatOverlay = null;
    outlineLayer = null;
    windArrowLayer = null;
    stationLayer = null;
  });
</script>

<section class="section map-section" bind:this={panelRoot}>
  <h2>{prefName} OX 分布（補間・ヒートマップ）</h2>
  {#if datetime}
    <p class="map-datetime">
      対象時刻: {datetime}
      <span class="interp-label">／ 補間: {currentInterpolationLabel}</span>
    </p>
  {/if}
  {#if !gridFieldData && !loading}
    <p class="muted">
      グリッドデータを取得できませんでした（API /v1/grid/field を確認してください）。
    </p>
  {/if}
  <!-- 地図ドラッグ時に GridStack のパネルドラッグが始まらないよう、地図領域では伝播を止める -->
  <div
    class="map-wrap"
    role="application"
    aria-label="地図"
    use:stopGridDrag
  >
    <div class="map-leaflet" bind:this={mapContainer}></div>
  </div>
  <p class="map-legend">
    階調: 低（緑）→ 高（赤）。〇は測定局。風速・風向を測定している局では白い矢印（向き=風向、長さ=1時間の移動量）を表示。
    {#if gridFieldData && dataRangeMin !== dataRangeMax}
      — 表示範囲: <strong>{dataRangeMin.toFixed(0)} ～ {dataRangeMax.toFixed(0)} ppb</strong>
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

