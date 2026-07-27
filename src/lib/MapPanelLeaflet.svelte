<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import type { LatestRow, BBox } from './types';
  import {
    extractWindSamples,
    buildConvergenceOverlay,
    type ConvergenceBand,
    type ArrowSample,
  } from './windField';

  export let latestWithNames: LatestRow[] = [];
  /** 隣接県の測定局（県境付近の内挿補強＋地図表示）。対象県の表・順位には含めない */
  export let neighborRows: LatestRow[] = [];
  export let bboxForMap: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };
  export let datetime: string | null = null;
  export let prefName: string = '';
  /** 見出し。未指定時は prefName + 既定サフィックス */
  export let title: string | null = null;
  /** マーカー色: ox（光化学） / temp（気温・AMeDAS） */
  export let markerMode: 'ox' | 'temp' = 'ox';
  export let legend: string | null = null;
  /** 内挿グリッドの風ベクトルを細い線で重ね描き（OX / AMeDAS 共通） */
  export let showGridWind = true;

  /** 隣接県マーカー/矢印を表示する帯（対象県 bbox をこの度数だけ広げた範囲） */
  const NEIGHBOR_DISPLAY_PAD_DEG = 0.4;

  $: heading =
    title ??
    (markerMode === 'temp'
      ? `${prefName} AMeDAS 風・収束線`
      : `${prefName} OX 分布・収束線`);
  $: legendText =
    legend ??
    (markerMode === 'temp'
      ? '階調: 低温（青）→ 高温（赤）。〇は AMeDAS 局（小さい破線〇は隣接県側）。青矢印は観測風。細い灰緑矢印は adaptive IDW 後に Helmholtz–Hodge 分解で渦度成分を除いた収束・発散成分（長さは観測局矢印の約 55%）。赤の塗り／線は収束 −∇·V の絶対等高線（5×10⁻⁵ / 1×10⁻⁴ / 2×10⁻⁴ /s）。'
      : '階調: 低（緑）→ 高（赤）。〇は測定局（小さい破線〇は隣接県）。青矢印は観測風。細い灰緑矢印は adaptive IDW 後に Helmholtz–Hodge 分解で渦度成分を除いた収束・発散成分（長さは観測局矢印の約 55%）。赤の塗り／線は収束 −∇·V の絶対等高線（5×10⁻⁵ / 1×10⁻⁴ / 2×10⁻⁴ /s）。');

  function rowsInPaddedBbox(rows: LatestRow[], bbox: BBox, padDeg: number): LatestRow[] {
    const minLon = bbox.minLon - padDeg;
    const maxLon = bbox.maxLon + padDeg;
    const minLat = bbox.minLat - padDeg;
    const maxLat = bbox.maxLat + padDeg;
    return rows.filter(
      (r) =>
        r.lat != null &&
        r.lon != null &&
        Number.isFinite(r.lat) &&
        Number.isFinite(r.lon) &&
        r.lon! >= minLon &&
        r.lon! <= maxLon &&
        r.lat! >= minLat &&
        r.lat! <= maxLat
    );
  }

  $: neighborForDisplay = rowsInPaddedBbox(neighborRows, bboxForMap, NEIGHBOR_DISPLAY_PAD_DEG);

  const REF_PPB = 120;

  let panelRoot: HTMLElement;
  let mapContainer: HTMLDivElement;
  let map: L.Map | null = null;
  let windArrowLayer: L.LayerGroup | null = null;
  let gridWindLayer: L.LayerGroup | null = null;
  let stationLayer: L.LayerGroup | null = null;
  let convergenceLayer: L.LayerGroup | null = null;
  let resizeObserver: ResizeObserver | null = null;

  let lastFittedBboxKey: string | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let convergenceCacheKey = '';
  let cachedBands: ConvergenceBand[] = [];
  let cachedGridArrows: ArrowSample[] = [];

  /** 弱い→強い: 塗りは薄→濃、線は細→太 */
  const BAND_STYLES = [
    { fillOpacity: 0.12, weight: 1.5, color: '#e57373' },
    { fillOpacity: 0.22, weight: 2.5, color: '#c62828' },
    { fillOpacity: 0.32, weight: 3.5, color: '#b71c1c' },
  ] as const;

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

  function lerpColorStops(
    value: number | null,
    zMin: number,
    zMax: number,
    colors: [number, string][]
  ): string {
    if (value == null || !Number.isFinite(value)) return 'rgb(180,180,180)';
    const t = Math.max(0, Math.min(1, (value - zMin) / (zMax - zMin || 1)));
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

  function oxToColor(ox: number | null, zMin = 0, zMax = 250): string {
    return lerpColorStops(ox, zMin, zMax, [
      [0, 'rgb(34,139,34)'],
      [0.25, 'rgb(76,175,74)'],
      [0.5, 'rgb(255,235,59)'],
      [0.75, 'rgb(255,152,0)'],
      [1, 'rgb(227,26,28)'],
    ]);
  }

  function tempToColor(temp: number | null, zMin = -5, zMax = 35): string {
    return lerpColorStops(temp, zMin, zMax, [
      [0, 'rgb(33,150,243)'],
      [0.35, 'rgb(76,175,80)'],
      [0.55, 'rgb(255,235,59)'],
      [0.75, 'rgb(255,152,0)'],
      [1, 'rgb(211,47,47)'],
    ]);
  }

  function markerColor(row: LatestRow): string {
    if (markerMode === 'temp') return tempToColor(row.temp);
    return oxToColor(row.ox, HEATMAP_OX_ABS_MIN, HEATMAP_OX_ABS_MAX);
  }

  function markerPopup(row: LatestRow, neighbor: boolean): string {
    const prefix = neighbor ? '（隣接県）' : '';
    if (markerMode === 'temp') {
      const tempStr = row.temp != null ? `${row.temp.toFixed(1)} ℃` : '—';
      const windStr =
        row.wx != null && row.wy != null
          ? `${Math.hypot(row.wx, row.wy).toFixed(1)} m/s`
          : '—';
      return `${prefix}${row.name}<br>気温: ${tempStr}<br>風速: ${windStr}`;
    }
    return `${prefix}${row.name}<br>OX: ${
      row.ox != null ? row.ox.toFixed(1) : '—'
    } ppb`;
  }

  const HEATMAP_OX_ABS_MIN = 0;
  const HEATMAP_OX_ABS_MAX = REF_PPB;
  const KM_PER_DEG_LAT = 111;
  const WD_16_DEG_PER_DIV = 360 / 16;
  /** 観測局矢印の長さスケール（m/s → km） */
  const WIND_ARROW_KM_PER_MS = 3.6;
  /** 内挿格子矢印は観測局より短く描く（混雑回避）。凡例にも記載 */
  const GRID_WIND_ARROW_KM_PER_MS = 2.0;

  function stationWindToArrowSegments(
    rows: LatestRow[],
    zoom: number,
    bounds: L.LatLngBounds
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
    const degPerPixel = 360 / (256 * Math.pow(2, zoom));
    const HEAD_BACK_DEG = degPerPixel * 10;
    const HEAD_WING_DEG = degPerPixel * 6;
    for (const r of points) {
      const lat = r.lat!;
      const lon = r.lon!;
      let dLon: number;
      let dLat: number;
      if (r.wx != null && r.wy != null && Number.isFinite(r.wx) && Number.isFinite(r.wy)) {
        const dxKm = r.wx * WIND_ARROW_KM_PER_MS;
        const dyKm = r.wy * WIND_ARROW_KM_PER_MS;
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        dLat = dyKm / KM_PER_DEG_LAT;
        dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
      } else {
        const wdDeg = (r.wd! % 16) * WD_16_DEG_PER_DIV;
        const blowDeg = (wdDeg + 180) % 360;
        const rad = (blowDeg * Math.PI) / 180;
        const speedMs = r.ws! * 0.1;
        const distKm = speedMs * WIND_ARROW_KM_PER_MS;
        const dxKm = distKm * Math.sin(rad);
        const dyKm = distKm * Math.cos(rad);
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        dLat = dyKm / KM_PER_DEG_LAT;
        dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
      }
      const tipLon = lon + dLon;
      const tipLat = lat + dLat;
      segments.push([
        [lat, lon],
        [tipLat, tipLon],
      ]);

      const len = Math.hypot(dLon, dLat);
      if (Number.isFinite(len) && len > 1e-6) {
        const ux = dLon / len;
        const uy = dLat / len;
        const bx = ux * HEAD_BACK_DEG;
        const by = uy * HEAD_BACK_DEG;
        const px = -uy * HEAD_WING_DEG;
        const py = ux * HEAD_WING_DEG;
        segments.push([
          [tipLat, tipLon],
          [tipLat - by + py, tipLon - bx + px],
        ]);
        segments.push([
          [tipLat, tipLon],
          [tipLat - by - py, tipLon - bx - px],
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
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    // 隣接県の矢印は淡い青（対象県は濃い青）
    const neighborSegs = stationWindToArrowSegments(neighborForDisplay, zoom, bounds);
    for (const seg of neighborSegs) {
      if (seg.length < 2) continue;
      L.polyline(seg, {
        color: '#5c85d6',
        weight: 2.5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(windArrowLayer!);
    }
    const segs = stationWindToArrowSegments(latestWithNames, zoom, bounds);
    for (const seg of segs) {
      if (seg.length < 2) continue;
      L.polyline(seg, {
        color: '#0d47a1',
        weight: 3.5,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round',
      }).addTo(windArrowLayer!);
    }
    updateGridWindLayer();
  }

  /** IDW 内挿格子の風（AMeDAS 検算時のみ）。観測局矢印より短く細い灰緑 */
  function gridWindToArrowSegments(
    arrows: ArrowSample[],
    zoom: number,
    bounds: L.LatLngBounds
  ): [number, number][][] {
    const segments: [number, number][][] = [];
    const degPerPixel = 360 / (256 * Math.pow(2, zoom));
    const HEAD_BACK_DEG = degPerPixel * 6;
    const HEAD_WING_DEG = degPerPixel * 3.5;
    for (const a of arrows) {
      if (!bounds.contains([a.lat, a.lon])) continue;
      if (!Number.isFinite(a.u) || !Number.isFinite(a.v)) continue;
      if (Math.hypot(a.u, a.v) < 1e-6) continue;
      const cosLat = Math.max(0.2, Math.cos((a.lat * Math.PI) / 180));
      const dLat = (a.v * GRID_WIND_ARROW_KM_PER_MS) / KM_PER_DEG_LAT;
      const dLon = (a.u * GRID_WIND_ARROW_KM_PER_MS) / (KM_PER_DEG_LAT * cosLat);
      const tipLat = a.lat + dLat;
      const tipLon = a.lon + dLon;
      segments.push([
        [a.lat, a.lon],
        [tipLat, tipLon],
      ]);
      const len = Math.hypot(dLon, dLat);
      if (len > 1e-6) {
        const ux = dLon / len;
        const uy = dLat / len;
        const bx = ux * HEAD_BACK_DEG;
        const by = uy * HEAD_BACK_DEG;
        const px = -uy * HEAD_WING_DEG;
        const py = ux * HEAD_WING_DEG;
        segments.push([
          [tipLat, tipLon],
          [tipLat - by + py, tipLon - bx + px],
        ]);
        segments.push([
          [tipLat, tipLon],
          [tipLat - by - py, tipLon - bx - px],
        ]);
      }
    }
    return segments;
  }

  function updateGridWindLayer() {
    if (!map) return;
    if (!showGridWind) {
      if (gridWindLayer) {
        gridWindLayer.clearLayers();
      }
      return;
    }
    if (gridWindLayer) {
      gridWindLayer.clearLayers();
    } else {
      gridWindLayer = L.layerGroup().addTo(map);
    }
    const zoom = map.getZoom();
    const bounds = map.getBounds();
    const segs = gridWindToArrowSegments(cachedGridArrows, zoom, bounds);
    for (const seg of segs) {
      if (seg.length < 2) continue;
      L.polyline(seg, {
        color: '#546e7a',
        weight: 1,
        opacity: 0.55,
        lineCap: 'round',
        lineJoin: 'round',
        pane: 'gridWindPane',
        interactive: false,
      }).addTo(gridWindLayer!);
    }
  }

  function updateStationLayer() {
    if (!map) return;
    if (stationLayer) {
      stationLayer.clearLayers();
    } else {
      stationLayer = L.layerGroup().addTo(map);
    }

    // 隣接県マーカー（控えめ: 小さめ・半透過・破線枠）を先に敷く
    for (const row of neighborForDisplay) {
      if (
        row.lat == null ||
        row.lon == null ||
        !Number.isFinite(row.lat) ||
        !Number.isFinite(row.lon)
      )
        continue;
      const color = markerColor(row);
      const marker = L.circleMarker([row.lat, row.lon], {
        radius: 4,
        color: '#666',
        weight: 1,
        dashArray: '2,2',
        fillColor: color,
        fillOpacity: 0.55,
        pane: 'stationPane',
      });
      marker.bindPopup(markerPopup(row, true));
      marker.addTo(stationLayer);
    }

    for (const row of latestWithNames) {
      if (
        row.lat == null ||
        row.lon == null ||
        !Number.isFinite(row.lat) ||
        !Number.isFinite(row.lon)
      )
        continue;
      const color = markerColor(row);
      const marker = L.circleMarker([row.lat, row.lon], {
        radius: 6,
        color: '#333',
        weight: 1,
        fillColor: color,
        fillOpacity: 0.9,
        pane: 'stationPane',
      });
      marker.bindPopup(markerPopup(row, false));
      marker.addTo(stationLayer);
    }
  }

  /** 収束線の内挿サンプルは対象県＋隣接県。県境付近の片側欠けを補う */
  function windRowsForConvergence(): LatestRow[] {
    return [...latestWithNames, ...neighborRows];
  }

  function convergenceKey(): string {
    const samples = extractWindSamples(windRowsForConvergence());
    const b = `${bboxForMap.minLon.toFixed(4)},${bboxForMap.minLat.toFixed(4)},${bboxForMap.maxLon.toFixed(4)},${bboxForMap.maxLat.toFixed(4)}`;
    const sig = samples
      .map((s) => `${s.lat.toFixed(4)},${s.lon.toFixed(4)},${s.u.toFixed(3)},${s.v.toFixed(3)}`)
      .join('|');
    // adaptive IDW・格子矢印密度をキャッシュキーに含める
    const idwMode = 'adapt4x80';
    const stride = showGridWind ? 1 : 0;
    return `${b}#${samples.length}#${idwMode}#s${stride}#${sig}`;
  }

  function ensureConvergenceCache() {
    const key = convergenceKey();
    if (key === convergenceCacheKey) return;
    convergenceCacheKey = key;
    const samples = extractWindSamples(windRowsForConvergence());
    if (samples.length < 2) {
      cachedBands = [];
      cachedGridArrows = [];
      return;
    }
    // OX / AMeDAS 共通: adaptive IDW（最低4局・上限80km）。格子矢印は全点描画
    const { bands, arrows } = buildConvergenceOverlay(samples, bboxForMap, {
      gridArrowStride: showGridWind ? 1 : undefined,
      adaptive: true,
    });
    cachedBands = bands;
    cachedGridArrows = showGridWind ? arrows : [];
  }

  function updateConvergenceLayer() {
    if (!map) return;
    ensureConvergenceCache();
    if (convergenceLayer) {
      convergenceLayer.clearLayers();
    } else {
      convergenceLayer = L.layerGroup().addTo(map);
    }

    // 弱い帯から塗る → 強い帯を重ねる。その後に各閾値の等高線
    for (let bi = 0; bi < cachedBands.length; bi++) {
      const band = cachedBands[bi];
      const style = BAND_STYLES[Math.min(bi, BAND_STYLES.length - 1)];
      for (const poly of band.polygons) {
        if (poly.length < 3) continue;
        L.polygon(poly, {
          stroke: false,
          fillColor: style.color,
          fillOpacity: style.fillOpacity,
          interactive: false,
          pane: 'convergencePane',
        }).addTo(convergenceLayer!);
      }
    }
    for (let bi = 0; bi < cachedBands.length; bi++) {
      const band = cachedBands[bi];
      const style = BAND_STYLES[Math.min(bi, BAND_STYLES.length - 1)];
      for (const line of band.lines) {
        if (line.length < 2) continue;
        L.polyline(line, {
          color: style.color,
          weight: style.weight,
          opacity: 0.95,
          pane: 'convergencePane',
        }).addTo(convergenceLayer!);
      }
    }
    updateGridWindLayer();
  }

  function fitToBbox() {
    if (!map || !bboxForMap) return;
    const bounds = L.latLngBounds(
      [bboxForMap.minLat, bboxForMap.minLon],
      [bboxForMap.maxLat, bboxForMap.maxLon]
    );
    map.fitBounds(bounds, { padding: [16, 16] });
  }

  $: if (map) {
    void latestWithNames.length;
    void latestWithNames;
    void neighborRows;
    void neighborForDisplay;
    void bboxForMap;
    void markerMode;
    void showGridWind;
    updateWindArrowLayer();
    updateStationLayer();
    updateConvergenceLayer();
  }

  $: if (map && bboxForMap) {
    const k = `${bboxForMap.minLon.toFixed(4)},${bboxForMap.minLat.toFixed(4)},${bboxForMap.maxLon.toFixed(4)},${bboxForMap.maxLat.toFixed(4)}`;
    if (k !== lastFittedBboxKey) {
      lastFittedBboxKey = k;
      fitToBbox();
      convergenceCacheKey = '';
      updateConvergenceLayer();
    }
  }

  onMount(() => {
    // 塗りつぶしポリゴンは SVG の方が安定
    map = L.map(mapContainer, {
      preferCanvas: false,
    });
    map.createPane('gridWindPane');
    map.getPane('gridWindPane')!.style.zIndex = '440';
    map.createPane('convergencePane');
    map.getPane('convergencePane')!.style.zIndex = '450';
    map.createPane('stationPane');
    map.getPane('stationPane')!.style.zIndex = '600';
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '© <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    }).addTo(map);

    fitToBbox();
    updateConvergenceLayer();
    updateWindArrowLayer();
    updateStationLayer();

    // 風矢印の頭サイズのみビューに合わせて更新。収束場はパンで再計算しない
    map.on('moveend', updateWindArrowLayer);
    map.on('zoomend', updateWindArrowLayer);

    tick().then(() => {
      const observeTarget = mapContainer?.parentElement ?? panelRoot;
      if (!observeTarget || !map) return;
      resizeObserver = new ResizeObserver(() => {
        if (map) {
          map.invalidateSize({ pan: false });
          if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
          resizeDebounceTimer = setTimeout(() => {
            if (!map) return;
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
    if (map) {
      map.remove();
    }
    map = null;
    windArrowLayer = null;
    gridWindLayer = null;
    stationLayer = null;
    convergenceLayer = null;
  });
</script>

<section class="section map-section" bind:this={panelRoot}>
  <h2>{heading}</h2>
  {#if datetime}
    <p class="map-datetime">対象時刻: {datetime}</p>
  {/if}
  <div
    class="map-wrap"
    role="application"
    aria-label="地図"
    use:stopGridDrag
  >
    <div class="map-leaflet" bind:this={mapContainer}></div>
  </div>
  <p class="map-legend">{legendText}</p>
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
</style>
