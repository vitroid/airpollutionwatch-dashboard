import type { BBox } from './types';

/** 測定局の風サンプル（東向き u=wx, 北向き v=wy） */
export interface WindSample {
  lat: number;
  lon: number;
  u: number;
  v: number;
}

/** グリッド上のベクトル場 */
export interface VectorGrid {
  /** 行数（緯度方向, lat が増える向きに index が増える） */
  nLat: number;
  /** 列数（経度方向） */
  nLon: number;
  /** 各格子点の緯度 */
  lats: number[];
  /** 各格子点の経度 */
  lons: number[];
  /** u[iLat][iLon] — 欠損は null */
  u: (number | null)[][];
  /** v[iLat][iLon] — 欠損は null */
  v: (number | null)[][];
}

/** 収束線（[lat, lon] の折れ線） */
export type ConvergenceLine = [number, number][];

/** 強い収束領域の塗りつぶしポリゴン（閉じた [lat, lon][]） */
export type ConvergencePolygon = [number, number][];

const KM_PER_DEG_LAT = 111;
const IDW_POWER = 2;
const WD_16_DEG_PER_DIV = 360 / 16;
/**
 * 国土地理院 Web メルカトルタイル z=14 の経度方向タイル幅（度）。
 * 格子間隔はこの値を基準に固定する（パン／ズームで変えない）。
 */
export const ZOOM14_CELL_DEG = 360 / 2 ** 14; // ≈ 0.02197°
/** 1辺あたりの最大格子数（広大な県で z14 厳密だと重すぎる場合に粗くする） */
const MAX_CELLS_PER_SIDE = 96;
const MIN_CELLS_PER_SIDE = 8;

/**
 * 旧形式 wd(1–16) + ws(0.1 m/s) を東向き/北向き成分 (m/s) に変換。
 * MapPanelLeaflet と同じ「風が吹いていく向き」定義。
 */
export function wdWsToUV(wd: number, ws: number): { u: number; v: number } {
  const wdDeg = (wd % 16) * WD_16_DEG_PER_DIV;
  const blowDeg = (wdDeg + 180) % 360;
  const rad = (blowDeg * Math.PI) / 180;
  const speedMs = ws * 0.1;
  return {
    u: speedMs * Math.sin(rad),
    v: speedMs * Math.cos(rad),
  };
}

/**
 * 測定局から風サンプルを抽出。
 * 優先: wx/wy。無い場合は wd/ws から換算（現行 API は WD/WS のみのことが多い）。
 */
export function extractWindSamples(
  rows: {
    lat: number | null;
    lon: number | null;
    wx: number | null;
    wy: number | null;
    wd?: number | null;
    ws?: number | null;
  }[]
): WindSample[] {
  const out: WindSample[] = [];
  for (const r of rows) {
    if (
      r.lat == null ||
      r.lon == null ||
      !Number.isFinite(r.lat) ||
      !Number.isFinite(r.lon)
    ) {
      continue;
    }
    if (
      r.wx != null &&
      r.wy != null &&
      Number.isFinite(r.wx) &&
      Number.isFinite(r.wy)
    ) {
      out.push({ lat: r.lat, lon: r.lon, u: r.wx, v: r.wy });
      continue;
    }
    const wd = r.wd ?? null;
    const ws = r.ws ?? null;
    if (
      wd != null &&
      ws != null &&
      Number.isFinite(wd) &&
      Number.isFinite(ws)
    ) {
      const { u, v } = wdWsToUV(wd, ws);
      out.push({ lat: r.lat, lon: r.lon, u, v });
    }
  }
  return out;
}

/** ビューポートをわずかにパディングした bbox */
export function padBBox(bbox: BBox, padFrac = 0.05): BBox {
  const dLon = bbox.maxLon - bbox.minLon;
  const dLat = bbox.maxLat - bbox.minLat;
  const padLon = Math.max(dLon * padFrac, 0.01);
  const padLat = Math.max(dLat * padFrac, 0.01);
  return {
    minLon: bbox.minLon - padLon,
    maxLon: bbox.maxLon + padLon,
    minLat: bbox.minLat - padLat,
    maxLat: bbox.maxLat + padLat,
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function idwAt(
  samples: WindSample[],
  lat: number,
  lon: number,
  radiusKm: number
): { u: number; v: number } | null {
  let wSum = 0;
  let uSum = 0;
  let vSum = 0;

  for (const s of samples) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d > radiusKm) continue;
    if (d < 1e-6) {
      return { u: s.u, v: s.v };
    }
    const w = 1 / d ** IDW_POWER;
    wSum += w;
    uSum += w * s.u;
    vSum += w * s.v;
  }

  if (wSum > 0) {
    return { u: uSum / wSum, v: vSum / wSum };
  }
  return null;
}

/** サンプル点から IDW でグリッドベクトル場を作る（格子間隔は z14 タイル相当で固定） */
export function interpolateVectorField(
  samples: WindSample[],
  bbox: BBox,
  options?: { cellDeg?: number; maxCellsPerSide?: number }
): VectorGrid | null {
  if (samples.length < 2) return null;

  const cellDeg = options?.cellDeg ?? ZOOM14_CELL_DEG;
  const maxSide = options?.maxCellsPerSide ?? MAX_CELLS_PER_SIDE;
  const dLon = Math.max(bbox.maxLon - bbox.minLon, 1e-6);
  const dLat = Math.max(bbox.maxLat - bbox.minLat, 1e-6);

  let nLon = Math.ceil(dLon / cellDeg);
  let nLat = Math.ceil(dLat / cellDeg);
  nLon = Math.min(maxSide, Math.max(MIN_CELLS_PER_SIDE, nLon));
  nLat = Math.min(maxSide, Math.max(MIN_CELLS_PER_SIDE, nLat));

  const stepLon = dLon / nLon;
  const stepLat = dLat / nLat;

  const lons: number[] = [];
  const lats: number[] = [];
  for (let i = 0; i < nLon; i++) {
    lons.push(bbox.minLon + (i + 0.5) * stepLon);
  }
  for (let j = 0; j < nLat; j++) {
    lats.push(bbox.minLat + (j + 0.5) * stepLat);
  }

  // 近傍半径: 格子間隔の数倍（最低 ~12km）。県外への過大な外挿を抑える
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const cellKm =
    0.5 *
    (KM_PER_DEG_LAT * stepLat + KM_PER_DEG_LAT * cosLat * stepLon);
  const radiusKm = Math.max(cellKm * 3.5, 12);

  const u: (number | null)[][] = [];
  const v: (number | null)[][] = [];
  for (let j = 0; j < nLat; j++) {
    const rowU: (number | null)[] = [];
    const rowV: (number | null)[] = [];
    for (let i = 0; i < nLon; i++) {
      const res = idwAt(samples, lats[j], lons[i], radiusKm);
      if (res) {
        rowU.push(res.u);
        rowV.push(res.v);
      } else {
        rowU.push(null);
        rowV.push(null);
      }
    }
    u.push(rowU);
    v.push(rowV);
  }

  return { nLat, nLon, lats, lons, u, v };
}

/** メートル系で発散 (1/s 相当、u/v が m/s のとき) を計算。欠損は null */
export function computeDivergence(grid: VectorGrid): (number | null)[][] {
  const { nLat, nLon, lats, lons, u, v } = grid;
  const div: (number | null)[][] = Array.from({ length: nLat }, () =>
    Array.from({ length: nLon }, () => null)
  );

  for (let j = 1; j < nLat - 1; j++) {
    for (let i = 1; i < nLon - 1; i++) {
      const uL = u[j][i - 1];
      const uR = u[j][i + 1];
      const vS = v[j - 1][i];
      const vN = v[j + 1][i];
      if (uL == null || uR == null || vS == null || vN == null) continue;
      if (u[j][i] == null || v[j][i] == null) continue;

      const lat = lats[j];
      const cosLat = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
      const dx =
        ((lons[i + 1] - lons[i - 1]) * KM_PER_DEG_LAT * cosLat * 1000) || 1e-6;
      const dy = ((lats[j + 1] - lats[j - 1]) * KM_PER_DEG_LAT * 1000) || 1e-6;
      const duDx = (uR - uL) / dx;
      const dvDy = (vN - vS) / dy;
      div[j][i] = duDx + dvDy;
    }
  }
  return div;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * (sortedAsc.length - 1)))
  );
  return sortedAsc[idx];
}

/**
 * marching squares の辺上の補間点（セル局所座標 0..1）
 * 辺番号: 0=下, 1=右, 2=上, 3=左
 */
function edgePoint(
  edge: number,
  va: number,
  vb: number,
  level: number
): [number, number] {
  const t = (level - va) / (vb - va || 1e-12);
  const clamped = Math.max(0, Math.min(1, t));
  switch (edge) {
    case 0:
      return [clamped, 0]; // bottom: (x,0) from left to right
    case 1:
      return [1, clamped]; // right: (1,y) from bottom to top
    case 2:
      return [clamped, 1]; // top: (x,1) from left to right
    case 3:
      return [0, clamped]; // left: (0,y) from bottom to top
    default:
      return [0.5, 0.5];
  }
}

// Corners (bit): BL=1, BR=2, TR=4, TL=8。辺: 0=下, 1=右, 2=上, 3=左
const MS_EDGES: number[][] = [
  [],
  [3, 0], // 1 BL
  [0, 1], // 2 BR
  [3, 1], // 3 BL+BR
  [1, 2], // 4 TR
  [3, 0, 1, 2], // 5 BL+TR saddle
  [0, 2], // 6 BR+TR
  [3, 2], // 7 BL+BR+TR
  [2, 3], // 8 TL
  [0, 2], // 9 BL+TL
  [0, 1, 2, 3], // 10 BR+TL saddle
  [1, 2], // 11 BL+BR+TL
  [1, 3], // 12 TR+TL
  [0, 1], // 13 BL+TR+TL
  [0, 3], // 14 BR+TR+TL
  [],
];

function cellToLatLon(
  grid: VectorGrid,
  i: number,
  j: number,
  lx: number,
  ly: number
): [number, number] {
  const lon0 = grid.lons[i];
  const lon1 = grid.lons[i + 1];
  const lat0 = grid.lats[j];
  const lat1 = grid.lats[j + 1];
  const lon = lon0 + lx * (lon1 - lon0);
  const lat = lat0 + ly * (lat1 - lat0);
  return [lat, lon];
}

function cornerVal(field: (number | null)[][], j: number, i: number): number | null {
  return field[j]?.[i] ?? null;
}

function convergenceFieldFromDivergence(
  divergence: (number | null)[][]
): (number | null)[][] {
  return divergence.map((row) => row.map((d) => (d == null ? null : -d)));
}

function convergenceLevel(
  field: (number | null)[][],
  percentileP: number
): number | null {
  const strengths: number[] = [];
  for (const row of field) {
    for (const c of row) {
      if (c == null || !Number.isFinite(c) || !(c > 0)) continue;
      strengths.push(c);
    }
  }
  if (strengths.length < 4) return null;
  strengths.sort((a, b) => a - b);
  const level = percentile(strengths, percentileP);
  return level > 0 ? level : null;
}

/**
 * 発散場から収束線を抽出。
 * -convergence = -div が強い（発散が負で大きい）領域の等高線。
 */
export function extractConvergenceLines(
  grid: VectorGrid,
  divergence: (number | null)[][],
  options?: { percentile?: number; minSegmentDeg?: number; level?: number }
): ConvergenceLine[] {
  const p = options?.percentile ?? 80;
  const minSeg = options?.minSegmentDeg ?? 0.02;
  const field = convergenceFieldFromDivergence(divergence);
  const level = options?.level ?? convergenceLevel(field, p);
  if (level == null) return [];

  const segments: [[number, number], [number, number]][] = [];

  for (let j = 0; j < grid.nLat - 1; j++) {
    for (let i = 0; i < grid.nLon - 1; i++) {
      const v00 = cornerVal(field, j, i); // BL
      const v10 = cornerVal(field, j, i + 1); // BR
      const v11 = cornerVal(field, j + 1, i + 1); // TR
      const v01 = cornerVal(field, j + 1, i); // TL
      if (v00 == null || v10 == null || v11 == null || v01 == null) continue;

      let code = 0;
      if (v00 >= level) code |= 1;
      if (v10 >= level) code |= 2;
      if (v11 >= level) code |= 4;
      if (v01 >= level) code |= 8;
      if (code === 0 || code === 15) continue;

      const edges = MS_EDGES[code];
      if (!edges || edges.length === 0) continue;

      const edgeVals: [number, number][] = [
        [v00, v10],
        [v10, v11],
        [v01, v11],
        [v00, v01],
      ];

      const pairs: [number, number][] = [];
      if (edges.length === 2) {
        pairs.push([edges[0], edges[1]]);
      } else if (edges.length === 4) {
        pairs.push([edges[0], edges[1]], [edges[2], edges[3]]);
      }

      for (const [e0, e1] of pairs) {
        const [a0, b0] = edgeVals[e0];
        const [a1, b1] = edgeVals[e1];
        const p0 = edgePoint(e0, a0, b0, level);
        const p1 = edgePoint(e1, a1, b1, level);
        const ll0 = cellToLatLon(grid, i, j, p0[0], p0[1]);
        const ll1 = cellToLatLon(grid, i, j, p1[0], p1[1]);
        segments.push([ll0, ll1]);
      }
    }
  }

  return connectSegments(segments, minSeg);
}

/**
 * 強い収束領域を marching squares セルの「閾値以上」多角形で返す。
 * 等高線と同じ分割なので、曲線の内側を塗る塗りつぶしになる。
 */
export function extractConvergencePolygons(
  grid: VectorGrid,
  divergence: (number | null)[][],
  options?: { percentile?: number; level?: number }
): ConvergencePolygon[] {
  const p = options?.percentile ?? 80;
  const field = convergenceFieldFromDivergence(divergence);
  const level = options?.level ?? convergenceLevel(field, p);
  if (level == null) return [];

  const polygons: ConvergencePolygon[] = [];

  for (let j = 0; j < grid.nLat - 1; j++) {
    for (let i = 0; i < grid.nLon - 1; i++) {
      const v00 = cornerVal(field, j, i);
      const v10 = cornerVal(field, j, i + 1);
      const v11 = cornerVal(field, j + 1, i + 1);
      const v01 = cornerVal(field, j + 1, i);
      if (v00 == null || v10 == null || v11 == null || v01 == null) continue;

      let code = 0;
      if (v00 >= level) code |= 1;
      if (v10 >= level) code |= 2;
      if (v11 >= level) code |= 4;
      if (v01 >= level) code |= 8;
      if (code === 0) continue;

      const edgeVals: [number, number][] = [
        [v00, v10],
        [v10, v11],
        [v01, v11],
        [v00, v01],
      ];
      const ep = (e: number): [number, number] => {
        const [a, b] = edgeVals[e];
        return edgePoint(e, a, b, level);
      };
      const bl: [number, number] = [0, 0];
      const br: [number, number] = [1, 0];
      const tr: [number, number] = [1, 1];
      const tl: [number, number] = [0, 1];

      // 各ケースの「閾値以上」側多角形（局所座標、CCW）
      const locals: [number, number][][] = [];
      switch (code) {
        case 1:
          locals.push([ep(3), bl, ep(0)]);
          break;
        case 2:
          locals.push([ep(0), br, ep(1)]);
          break;
        case 3:
          locals.push([ep(3), bl, br, ep(1)]);
          break;
        case 4:
          locals.push([ep(1), tr, ep(2)]);
          break;
        case 5:
          locals.push([ep(3), bl, ep(0)], [ep(1), tr, ep(2)]);
          break;
        case 6:
          locals.push([ep(0), br, tr, ep(2)]);
          break;
        case 7:
          locals.push([ep(3), bl, br, tr, ep(2)]);
          break;
        case 8:
          locals.push([ep(2), tl, ep(3)]);
          break;
        case 9:
          locals.push([ep(0), bl, tl, ep(2)]);
          break;
        case 10:
          locals.push([ep(0), br, ep(1)], [ep(2), tl, ep(3)]);
          break;
        case 11:
          locals.push([ep(1), br, bl, tl, ep(2)]);
          break;
        case 12:
          locals.push([ep(1), tr, tl, ep(3)]);
          break;
        case 13:
          locals.push([ep(0), bl, tl, tr, ep(1)]);
          break;
        case 14:
          locals.push([ep(0), br, tr, tl, ep(3)]);
          break;
        case 15:
          locals.push([bl, br, tr, tl]);
          break;
        default:
          break;
      }

      for (const ring of locals) {
        if (ring.length < 3) continue;
        const poly: ConvergencePolygon = ring.map(([lx, ly]) =>
          cellToLatLon(grid, i, j, lx, ly)
        );
        polygons.push(poly);
      }
    }
  }
  return polygons;
}

/**
 * 線と塗りを同じ閾値でまとめて抽出
 */
export function extractConvergenceFeatures(
  grid: VectorGrid,
  divergence: (number | null)[][],
  options?: { percentile?: number; minSegmentDeg?: number }
): { lines: ConvergenceLine[]; polygons: ConvergencePolygon[]; level: number | null } {
  const p = options?.percentile ?? 80;
  const field = convergenceFieldFromDivergence(divergence);
  const level = convergenceLevel(field, p);
  if (level == null) {
    return { lines: [], polygons: [], level: null };
  }
  const lines = extractConvergenceLines(grid, divergence, {
    ...options,
    level,
  });
  const polygons = extractConvergencePolygons(grid, divergence, { level });
  return { lines, polygons, level };
}
function approxEq(a: [number, number], b: [number, number], eps = 1e-7): boolean {
  return Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
}

function connectSegments(
  segments: [[number, number], [number, number]][],
  minSegmentDeg: number
): ConvergenceLine[] {
  if (segments.length === 0) return [];

  const used = new Array(segments.length).fill(false);
  const lines: ConvergenceLine[] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    const path: ConvergenceLine = [segments[start][0], segments[start][1]];

    let extended = true;
    while (extended) {
      extended = false;
      const head = path[0];
      const tail = path[path.length - 1];
      for (let i = 0; i < segments.length; i++) {
        if (used[i]) continue;
        const [a, b] = segments[i];
        if (approxEq(tail, a)) {
          path.push(b);
          used[i] = true;
          extended = true;
          break;
        }
        if (approxEq(tail, b)) {
          path.push(a);
          used[i] = true;
          extended = true;
          break;
        }
        if (approxEq(head, a)) {
          path.unshift(b);
          used[i] = true;
          extended = true;
          break;
        }
        if (approxEq(head, b)) {
          path.unshift(a);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }

    // 長さチェック（端点距離の簡易和）
    let len = 0;
    for (let k = 1; k < path.length; k++) {
      len += Math.hypot(path[k][0] - path[k - 1][0], path[k][1] - path[k - 1][1]);
    }
    if (len >= minSegmentDeg && path.length >= 2) {
      lines.push(path);
    }
  }

  return lines;
}

/** グリッド矢印用に間引きしたベクトル点 */
export interface ArrowSample {
  lat: number;
  lon: number;
  u: number;
  v: number;
}

export function subsampleArrows(grid: VectorGrid, stride = 2): ArrowSample[] {
  const out: ArrowSample[] = [];
  const s = Math.max(1, stride);
  for (let j = 0; j < grid.nLat; j += s) {
    for (let i = 0; i < grid.nLon; i += s) {
      const uu = grid.u[j][i];
      const vv = grid.v[j][i];
      if (uu == null || vv == null) continue;
      out.push({ lat: grid.lats[j], lon: grid.lons[i], u: uu, v: vv });
    }
  }
  return out;
}

/** 解析範囲（県 bbox 等）でサンプル→場→収束線／塗りまで計算。格子は z14 相当で固定 */
export function buildConvergenceOverlay(
  samples: WindSample[],
  analysisBBox: BBox
): {
  grid: VectorGrid | null;
  arrows: ArrowSample[];
  lines: ConvergenceLine[];
  polygons: ConvergencePolygon[];
} {
  if (samples.length < 2) {
    return { grid: null, arrows: [], lines: [], polygons: [] };
  }
  // わずかな余白のみ（viewport 追従はしない）
  const bbox = padBBox(analysisBBox, 0.02);
  const grid = interpolateVectorField(samples, bbox);
  if (!grid) {
    return { grid: null, arrows: [], lines: [], polygons: [] };
  }
  const div = computeDivergence(grid);
  const { lines, polygons } = extractConvergenceFeatures(grid, div, {
    // z14 格子では短い線分でも地理的に意味があるので閾値を下げる
    minSegmentDeg: ZOOM14_CELL_DEG * 0.75,
  });
  // 格子が細かいので間引き
  const stride = Math.max(2, Math.round(Math.max(grid.nLat, grid.nLon) / 28));
  const arrows = subsampleArrows(grid, stride);
  return { grid, arrows, lines, polygons };
}
