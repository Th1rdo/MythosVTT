import type { Point } from "./geometry.ts";

/** Same numbering as Foundry's GRID_TYPES, so imported scenes keep their grid. */
export const GRID = { GRIDLESS: 0, SQUARE: 1, HEX_ODD_R: 2, HEX_EVEN_R: 3, HEX_ODD_Q: 4, HEX_EVEN_Q: 5 } as const;

export interface GridSpec {
  type: number;
  /** Square side, or hex width (rows) / height (columns), in pixels. */
  size: number;
  /** Scene units per cell. */
  distance: number;
}

export const isHex = (g: GridSpec) => g.type >= GRID.HEX_ODD_R && g.type <= GRID.HEX_EVEN_Q;
/** Row hexes (R) are pointy-topped; column hexes (Q) are flat-topped. */
const columns = (g: GridSpec) => g.type === GRID.HEX_ODD_Q || g.type === GRID.HEX_EVEN_Q;
const even = (g: GridSpec) => g.type === GRID.HEX_EVEN_R || g.type === GRID.HEX_EVEN_Q;

/** Width and height of one hex in pixels. */
export function hexSize(g: GridSpec): { w: number; h: number } {
  return columns(g) ? { w: (g.size * 2) / Math.sqrt(3), h: g.size } : { w: g.size, h: (g.size * 2) / Math.sqrt(3) };
}

/** Centre of the hex at (row, col). */
export function hexCenter(g: GridSpec, row: number, col: number): Point {
  const { w, h } = hexSize(g);
  if (columns(g)) {
    const shifted = (col & 1) === (even(g) ? 0 : 1);
    return { x: col * w * 0.75 + w / 2, y: row * h + h / 2 + (shifted ? h / 2 : 0) };
  }
  const shifted = (row & 1) === (even(g) ? 0 : 1);
  return { x: col * w + w / 2 + (shifted ? w / 2 : 0), y: row * h * 0.75 + h / 2 };
}

/** The hex (row, col) whose centre is nearest to `p`. */
export function hexAt(g: GridSpec, p: Point): { row: number; col: number } {
  const { w, h } = hexSize(g);
  const approxRow = columns(g) ? Math.floor(p.y / h) : Math.floor(p.y / (h * 0.75));
  const approxCol = columns(g) ? Math.floor(p.x / (w * 0.75)) : Math.floor(p.x / w);
  let best = { row: approxRow, col: approxCol, d: Infinity };
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const row = approxRow + dr, col = approxCol + dc;
      const c = hexCenter(g, row, col);
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (d < best.d) best = { row, col, d };
    }
  }
  return { row: best.row, col: best.col };
}

/** Cube coordinates of an offset hex (for distances). */
function cube(g: GridSpec, row: number, col: number): [number, number, number] {
  if (columns(g)) {
    const x = col;
    const z = even(g) ? row - (col + (col & 1)) / 2 : row - (col - (col & 1)) / 2;
    return [x, -x - z, z];
  }
  const z = row;
  const x = even(g) ? col - (row + (row & 1)) / 2 : col - (row - (row & 1)) / 2;
  return [x, -x - z, z];
}

/** Corners of the hex around `center`. */
export function hexPolygon(g: GridSpec, center: Point): number[] {
  const { w, h } = hexSize(g);
  const out: number[] = [];
  for (let k = 0; k < 6; k++) {
    const a = ((columns(g) ? 0 : 30) + 60 * k) * (Math.PI / 180);
    const r = columns(g) ? w / 2 : h / 2;
    out.push(center.x + Math.cos(a) * r, center.y + Math.sin(a) * r);
  }
  return out;
}

/** Centre of the cell containing `p` (gridless: `p` itself). */
export function cellCenter(g: GridSpec, p: Point): Point {
  if (g.type === GRID.GRIDLESS) return p;
  if (isHex(g)) {
    const { row, col } = hexAt(g, p);
    return hexCenter(g, row, col);
  }
  return { x: Math.floor(p.x / g.size) * g.size + g.size / 2, y: Math.floor(p.y / g.size) * g.size + g.size / 2 };
}

/**
 * Snap a point for placing walls, lights, templates: square grids use corners and centres (half
 * steps), hex grids use centres and corners, gridless doesn't snap.
 */
export function snapPoint(g: GridSpec, p: Point): Point {
  if (g.type === GRID.GRIDLESS) return { x: Math.round(p.x), y: Math.round(p.y) };
  if (isHex(g)) {
    const c = cellCenter(g, p);
    const pts = hexPolygon(g, c);
    let best = c, bd = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    for (let i = 0; i < pts.length; i += 2) {
      const d = (pts[i] - p.x) ** 2 + (pts[i + 1] - p.y) ** 2;
      if (d < bd) { bd = d; best = { x: pts[i], y: pts[i + 1] }; }
    }
    return { x: Math.round(best.x), y: Math.round(best.y) };
  }
  const step = g.size / 2;
  return { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step };
}

/**
 * Where a token's top-left goes so it sits on the grid: square grids align to cells; hex grids put the
 * token's centre on the nearest hex centre; gridless keeps the position.
 */
export function snapTokenPosition(g: GridSpec, topLeft: Point, widthCells: number, heightCells: number): Point {
  const w = widthCells * g.size, h = heightCells * g.size;
  if (g.type === GRID.GRIDLESS) return { x: Math.round(topLeft.x), y: Math.round(topLeft.y) };
  if (isHex(g)) {
    const c = cellCenter(g, { x: topLeft.x + w / 2, y: topLeft.y + h / 2 });
    return { x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2) };
  }
  return { x: Math.round(topLeft.x / g.size) * g.size, y: Math.round(topLeft.y / g.size) * g.size };
}

/**
 * Distance between two points in scene units: square grids count diagonals as one cell (Foundry's
 * default "equidistant"), hex grids count hexes, gridless measures straight lines.
 */
export function measure(g: GridSpec, a: Point, b: Point): number {
  if (g.type === GRID.GRIDLESS) return Math.round((Math.hypot(b.x - a.x, b.y - a.y) / g.size) * g.distance * 10) / 10;
  if (isHex(g)) {
    const A = hexAt(g, a), B = hexAt(g, b);
    const [ax, ay, az] = cube(g, A.row, A.col), [bx, by, bz] = cube(g, B.row, B.col);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by), Math.abs(az - bz)) * g.distance;
  }
  return Math.round(Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / g.size) * g.distance;
}

/** Hex centres covering a scene (for drawing hex grids). */
export function hexCenters(g: GridSpec, width: number, height: number): Point[] {
  const { w, h } = hexSize(g);
  const rows = Math.ceil(height / (columns(g) ? h : h * 0.75)) + 1;
  const cols = Math.ceil(width / (columns(g) ? w * 0.75 : w)) + 1;
  const out: Point[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = hexCenter(g, row, col);
      if (c.x <= width && c.y <= height) out.push(c);
    }
  }
  return out;
}
