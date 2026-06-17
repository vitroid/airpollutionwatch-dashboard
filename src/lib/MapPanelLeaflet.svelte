<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import L from 'leaflet';
  import 'leaflet/dist/leaflet.css';
  import type { LatestRow, BBox } from './types';

  export let latestWithNames: LatestRow[] = [];
  export let bboxForMap: BBox = { minLon: 128, minLat: 30, maxLon: 146, maxLat: 46 };
  export let datetime: string | null = null;
  export let prefName: string = '';

  const REF_PPB = 120;

  let panelRoot: HTMLElement;
  let mapContainer: HTMLDivElement;
  let map: L.Map | null = null;
  let windArrowLayer: L.LayerGroup | null = null;
  let stationLayer: L.LayerGroup | null = null;
  let resizeObserver: ResizeObserver | null = null;

  let lastFittedBboxKey: string | null = null;
  let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

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

  const HEATMAP_OX_ABS_MIN = 0;
  const HEATMAP_OX_ABS_MAX = REF_PPB;
  const KM_PER_DEG_LAT = 111;
  const WD_16_DEG_PER_DIV = 360 / 16;

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
    const degPerPixel = 360 / (256 * Math.pow(2, zoom));
    const HEAD_BACK_DEG = degPerPixel * 10;
    const HEAD_WING_DEG = degPerPixel * 6;
    for (const r of points) {
      const lat = r.lat!;
      const lon = r.lon!;
      let dLon: number;
      let dLat: number;
      if (r.wx != null && r.wy != null && Number.isFinite(r.wx) && Number.isFinite(r.wy)) {
        const dxKm = r.wx * 3.6;
        const dyKm = r.wy * 3.6;
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        dLat = dyKm / KM_PER_DEG_LAT;
        dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
      } else {
        const wdDeg = (r.wd! % 16) * WD_16_DEG_PER_DIV;
        const blowDeg = (wdDeg + 180) % 360;
        const rad = (blowDeg * Math.PI) / 180;
        const speedMs = r.ws! * 0.1;
        const distKm = speedMs * 3.6;
        const dxKm = distKm * Math.sin(rad);
        const dyKm = distKm * Math.cos(rad);
        const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
        dLat = dyKm / KM_PER_DEG_LAT;
        dLon = dxKm / (KM_PER_DEG_LAT * cosLat);
      }
      const tipLon = lon + dLon;
      const tipLat = lat + dLat;
      segments.push([[lat, lon], [tipLat, tipLon]]);

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
        segments.push([[tipLat, tipLon], left]);
        segments.push([[tipLat, tipLon], right]);
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
    const segs = stationWindToArrowSegments(latestWithNames, zoom, bounds);
    for (const seg of segs) {
      if (seg.length < 2) continue;
      L.polyline(seg, { color: '#fff', weight: 3, opacity: 0.95, pane: 'windPane' }).addTo(
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
    updateWindArrowLayer();
    updateStationLayer();
  }

  $: if (map && bboxForMap) {
    const k = `${bboxForMap.minLon.toFixed(4)},${bboxForMap.minLat.toFixed(4)},${bboxForMap.maxLon.toFixed(4)},${bboxForMap.maxLat.toFixed(4)}`;
    if (k !== lastFittedBboxKey) {
      lastFittedBboxKey = k;
      fitToBbox();
    }
  }

  onMount(() => {
    map = L.map(mapContainer, {
      preferCanvas: true,
    });
    map.createPane('windPane');
    map.getPane('windPane')!.style.zIndex = '650';
    map.createPane('stationPane');
    map.getPane('stationPane')!.style.zIndex = '600';
    L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '© <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>',
    }).addTo(map);

    fitToBbox();
    updateWindArrowLayer();
    updateStationLayer();

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
    stationLayer = null;
  });
</script>

<section class="section map-section" bind:this={panelRoot}>
  <h2>{prefName} OX 分布（測定局）</h2>
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
  <p class="map-legend">
    階調: 低（緑）→ 高（赤）。〇は測定局。風速・風向を測定している局では白い矢印（向き=風向、長さ=1時間の移動量）を表示。
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
</style>
