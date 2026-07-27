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
 * 収束帯の基準絶対閾値（1/s）。
 * 等高線は基準の 1/2・1・2 倍の3段階を描く。
 * 目安: 局間 ~10 km・風差 ~1 m/s → ~1×10⁻⁴ /s。
 */
export const ABS_CONVERGENCE_THRESHOLD = 1e-4;

/** 弱い→強いの3段階（基準の 1/2, 1, 2 倍） */
export const ABS_CONVERGENCE_LEVELS: readonly number[] = [
  ABS_CONVERGENCE_THRESHOLD * 0.5,
  ABS_CONVERGENCE_THRESHOLD,
  ABS_CONVERGENCE_THRESHOLD * 2,
];

/** 1閾値分の収束帯（線＋塗り） */
export interface ConvergenceBand {
  level: number;
  lines: ConvergenceLine[];
  polygons: ConvergencePolygon[];
}

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

/**
 * Adaptive IDW: 近い順に少なくとも minNeighbors 局を使い、
 * それより遠い局は maxRadiusKm 以内なら追加しない（k-NN 型）。
 * 疎な海域でも穴が空きにくく、密な陸上では自然に短い影響半径になる。
 */
function idwAtAdaptive(
  samples: WindSample[],
  lat: number,
  lon: number,
  options: { minNeighbors: number; maxRadiusKm: number }
): { u: number; v: number } | null {
  const { minNeighbors, maxRadiusKm } = options;
  const ranked: { d: number; u: number; v: number }[] = [];
  for (const s of samples) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d > maxRadiusKm) continue;
    if (d < 1e-6) {
      return { u: s.u, v: s.v };
    }
    ranked.push({ d, u: s.u, v: s.v });
  }
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => a.d - b.d);

  // 近い minNeighbors 局は必ず使う。k 番目より遠い局は使わない。
  const k = Math.min(Math.max(1, minNeighbors), ranked.length);
  const cutoff = ranked[k - 1].d;
  let wSum = 0;
  let uSum = 0;
  let vSum = 0;
  for (const s of ranked) {
    if (s.d > cutoff + 1e-9) break;
    const w = 1 / s.d ** IDW_POWER;
    wSum += w;
    uSum += w * s.u;
    vSum += w * s.v;
  }
  if (wSum <= 0) return null;
  return { u: uSum / wSum, v: vSum / wSum };
}

/** adaptive IDW の既定（最低 4 局・上限 80 km） */
export const ADAPTIVE_IDW_DEFAULTS = {
  minNeighbors: 4,
  maxRadiusKm: 80,
} as const;

/** サンプル点から IDW でグリッドベクトル場を作る（格子間隔は z14 タイル相当で固定） */
export function interpolateVectorField(
  samples: WindSample[],
  bbox: BBox,
  options?: {
    cellDeg?: number;
    maxCellsPerSide?: number;
    /** 近傍半径 (km) を直接指定。未指定なら格子間隔から算出（下限 minRadiusKm） */
    radiusKm?: number;
    /** 固定半径モードの下限 (km)。大気測定局密度向け既定 20 km */
    minRadiusKm?: number;
    /**
     * true のとき adaptive IDW（近い順に minNeighbors 局）。
     * 疎密に応じて実効半径が変わる。未指定時は false（固定半径）。
     */
    adaptive?: boolean;
    /** adaptive 時: 最低利用局数（既定 4） */
    minNeighbors?: number;
    /** adaptive 時: 探索上限 km（既定 80） */
    maxRadiusKm?: number;
  }
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

  const adaptive = options?.adaptive === true;
  const minNeighbors = options?.minNeighbors ?? ADAPTIVE_IDW_DEFAULTS.minNeighbors;
  const maxRadiusKm = options?.maxRadiusKm ?? ADAPTIVE_IDW_DEFAULTS.maxRadiusKm;

  // 固定半径モード: 格子間隔の数倍（下限 minRadiusKm）。大気測定局密度向け既定 20 km。
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const cosLat = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const cellKm =
    0.5 *
    (KM_PER_DEG_LAT * stepLat + KM_PER_DEG_LAT * cosLat * stepLon);
  const minRadiusKm = options?.minRadiusKm ?? 20;
  const radiusKm = options?.radiusKm ?? Math.max(cellKm * 3.5, minRadiusKm);

  const u: (number | null)[][] = [];
  const v: (number | null)[][] = [];
  for (let j = 0; j < nLat; j++) {
    const rowU: (number | null)[] = [];
    const rowV: (number | null)[] = [];
    for (let i = 0; i < nLon; i++) {
      const res = adaptive
        ? idwAtAdaptive(samples, lats[j], lons[i], { minNeighbors, maxRadiusKm })
        : idwAt(samples, lats[j], lons[i], radiusKm);
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

/**
 * 局所直交座標（東=x, 北=y）での水平発散 ∇·V = ∂u/∂x + ∂v/∂y (1/s)。
 * u,v は m/s、dx/dy は隣接点間の地理距離 (m)。中央差分。
 */
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
      const lon = lons[i];
      // 東西・南北の実距離 (m)。haversine で風向成分に対する正しい尺度にする
      const dx = Math.max(haversineKm(lat, lons[i - 1], lat, lons[i + 1]) * 1000, 1e-3);
      const dy = Math.max(haversineKm(lats[j - 1], lon, lats[j + 1], lon) * 1000, 1e-3);
      const duDx = (uR - uL) / dx;
      const dvDy = (vN - vS) / dy;
      div[j][i] = duDx + dvDy;
    }
  }
  return div;
}

function gridSpacingMeters(grid: VectorGrid): { dx: number; dy: number } {
  const midJ = Math.floor(grid.nLat / 2);
  const midI = Math.floor(grid.nLon / 2);
  const lat = grid.lats[midJ];
  const lon = grid.lons[midI];
  const dx =
    grid.nLon > 1
      ? haversineKm(lat, grid.lons[0], lat, grid.lons[grid.nLon - 1]) *
        1000 /
        (grid.nLon - 1)
      : 1;
  const dy =
    grid.nLat > 1
      ? haversineKm(grid.lats[0], lon, grid.lats[grid.nLat - 1], lon) *
        1000 /
        (grid.nLat - 1)
      : 1;
  return {
    dx: Math.max(dx, 1e-3),
    dy: Math.max(dy, 1e-3),
  };
}

/**
 * Helmholtz–Hodge 分解の非回転（発散）成分を得る。
 *
 *   V = ∇φ + Vrot,  ∇²φ = ∇·V
 *
 * Poisson 方程式を有限差分 SOR 法（外周 φ=0）で解き、∇φ のみを返す。
 * これにより渦度を持つ回転成分と一様な調和成分は描画場から除外される。
 * 欠損セルは領域外として扱い、出力も null のままにする。
 */
export function extractDivergentComponent(
  grid: VectorGrid,
  options?: { iterations?: number; tolerance?: number }
): VectorGrid {
  const divergence = computeDivergence(grid);
  const { nLat, nLon } = grid;
  const { dx, dy } = gridSpacingMeters(grid);
  const invDx2 = 1 / (dx * dx);
  const invDy2 = 1 / (dy * dy);
  const denominator = 2 * invDx2 + 2 * invDy2;
  const iterations = options?.iterations ?? 600;
  const tolerance = options?.tolerance ?? 1e-5;
  const relaxation = 1.7;

  const phi: number[][] = Array.from({ length: nLat }, () =>
    Array.from({ length: nLon }, () => 0)
  );

  for (let iteration = 0; iteration < iterations; iteration++) {
    let maxDelta = 0;
    let maxAbs = 0;

    for (let j = 1; j < nLat - 1; j++) {
      for (let i = 1; i < nLon - 1; i++) {
        const rhs = divergence[j][i];
        if (rhs == null) continue;
        const target =
          ((phi[j][i - 1] + phi[j][i + 1]) * invDx2 +
            (phi[j - 1][i] + phi[j + 1][i]) * invDy2 -
            rhs) /
          denominator;
        const value = phi[j][i] + relaxation * (target - phi[j][i]);
        maxDelta = Math.max(maxDelta, Math.abs(value - phi[j][i]));
        maxAbs = Math.max(maxAbs, Math.abs(value));
        phi[j][i] = value;
      }
    }

    if (maxDelta <= tolerance * Math.max(1, maxAbs)) break;
  }

  const u: (number | null)[][] = Array.from({ length: nLat }, () =>
    Array.from({ length: nLon }, () => null)
  );
  const v: (number | null)[][] = Array.from({ length: nLat }, () =>
    Array.from({ length: nLon }, () => null)
  );

  for (let j = 1; j < nLat - 1; j++) {
    for (let i = 1; i < nLon - 1; i++) {
      if (divergence[j][i] == null) continue;
      u[j][i] = (phi[j][i + 1] - phi[j][i - 1]) / (2 * dx);
      v[j][i] = (phi[j + 1][i] - phi[j - 1][i]) / (2 * dy);
    }
  }

  return {
    nLat,
    nLon,
    lats: [...grid.lats],
    lons: [...grid.lons],
    u,
    v,
  };
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

/** 収束場 C = −∇·V（正＝収束）。単位 1/s */
function convergenceFieldFromDivergence(
  divergence: (number | null)[][]
): (number | null)[][] {
  return divergence.map((row) => row.map((d) => (d == null ? null : -d)));
}

/**
 * 発散場から収束線を抽出。
 * C = −div が絶対閾値以上の等高線（相対パーセンタイルではない）。
 */
export function extractConvergenceLines(
  grid: VectorGrid,
  divergence: (number | null)[][],
  options?: { minSegmentDeg?: number; level?: number }
): ConvergenceLine[] {
  const minSeg = options?.minSegmentDeg ?? 0.02;
  const field = convergenceFieldFromDivergence(divergence);
  const level = options?.level ?? ABS_CONVERGENCE_THRESHOLD;
  if (!(level > 0)) return [];

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
  options?: { level?: number }
): ConvergencePolygon[] {
  const field = convergenceFieldFromDivergence(divergence);
  const level = options?.level ?? ABS_CONVERGENCE_THRESHOLD;
  if (!(level > 0)) return [];

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
 * 線と塗りを同じ絶対閾値でまとめて抽出。
 * level 未指定時は ABS_CONVERGENCE_THRESHOLD (1/s)。
 */
export function extractConvergenceFeatures(
  grid: VectorGrid,
  divergence: (number | null)[][],
  options?: { minSegmentDeg?: number; level?: number }
): { lines: ConvergenceLine[]; polygons: ConvergencePolygon[]; level: number | null } {
  const level = options?.level ?? ABS_CONVERGENCE_THRESHOLD;
  if (!(level > 0)) {
    return { lines: [], polygons: [], level: null };
  }
  const lines = extractConvergenceLines(grid, divergence, {
    ...options,
    level,
  });
  const polygons = extractConvergencePolygons(grid, divergence, { level });
  return { lines, polygons, level };
}

/**
 * 複数絶対閾値で収束帯を抽出（弱い→強いの順）。
 * levels 未指定時は ABS_CONVERGENCE_LEVELS（基準の 1/2・1・2 倍）。
 */
export function extractConvergenceBands(
  grid: VectorGrid,
  divergence: (number | null)[][],
  options?: { minSegmentDeg?: number; levels?: readonly number[] }
): ConvergenceBand[] {
  const levels = options?.levels ?? ABS_CONVERGENCE_LEVELS;
  const bands: ConvergenceBand[] = [];
  for (const level of levels) {
    if (!(level > 0)) continue;
    const { lines, polygons } = extractConvergenceFeatures(grid, divergence, {
      minSegmentDeg: options?.minSegmentDeg,
      level,
    });
    bands.push({ level, lines, polygons });
  }
  return bands;
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

/**
 * 解析範囲（県 bbox 等）でサンプル→場→Helmholtz 分解→収束線／塗りまで計算。
 * 格子は z14 相当で固定。矢印には非回転成分のみを返す。
 */
export function buildConvergenceOverlay(
  samples: WindSample[],
  analysisBBox: BBox,
  options?: {
    gridArrowStride?: number;
    minRadiusKm?: number;
    /** adaptive IDW（k-NN）。true で疎密に応じた実効半径 */
    adaptive?: boolean;
    minNeighbors?: number;
    maxRadiusKm?: number;
  }
): {
  grid: VectorGrid | null;
  arrows: ArrowSample[];
  /** 弱い→強いの3段階（基準の 1/2・1・2 倍） */
  bands: ConvergenceBand[];
  /** 互換: 基準閾値の線（bands 中央） */
  lines: ConvergenceLine[];
  /** 互換: 基準閾値の塗り（bands 中央） */
  polygons: ConvergencePolygon[];
} {
  if (samples.length < 2) {
    return { grid: null, arrows: [], bands: [], lines: [], polygons: [] };
  }
  // わずかな余白のみ（viewport 追従はしない）
  const bbox = padBBox(analysisBBox, 0.02);
  const grid = interpolateVectorField(samples, bbox, {
    minRadiusKm: options?.minRadiusKm,
    adaptive: options?.adaptive,
    minNeighbors: options?.minNeighbors,
    maxRadiusKm: options?.maxRadiusKm,
  });
  if (!grid) {
    return { grid: null, arrows: [], bands: [], lines: [], polygons: [] };
  }
  // Helmholtz–Hodge 分解: 速度ポテンシャルの勾配だけを残し、渦度成分を捨てる。
  const divergentGrid = extractDivergentComponent(grid);

  // 発散は回転成分に依存しない。等高線は離散誤差の少ない元の発散を使い、
  // 補間矢印には上で射影した非回転成分を使う。
  const div = computeDivergence(grid);
  const bands = extractConvergenceBands(grid, div, {
    // z14 格子では短い線分でも地理的に意味があるので閾値を下げる
    minSegmentDeg: ZOOM14_CELL_DEG * 0.75,
  });
  const mid = bands.find((b) => b.level === ABS_CONVERGENCE_THRESHOLD) ?? bands[1] ?? {
    level: ABS_CONVERGENCE_THRESHOLD,
    lines: [],
    polygons: [],
  };
  const autoStride = Math.max(2, Math.round(Math.max(grid.nLat, grid.nLon) / 28));
  const stride = options?.gridArrowStride ?? autoStride;
  const arrows = subsampleArrows(divergentGrid, stride);
  return {
    grid: divergentGrid,
    arrows,
    bands,
    lines: mid.lines,
    polygons: mid.polygons,
  };
}
