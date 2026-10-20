import { DOOR_STATE, SENSE, WALL_DIR } from "./protocol.ts";
import type { WallDoc } from "./protocol.ts";

export interface Point {
  x: number;
  y: number;
}

export type SenseKind = "move" | "sight" | "light" | "sound";

/** A wall segment as seen by one sense. */
export interface Edge {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** 10 = limited (one of these may be passed through), 20 = normal. */
  sense: number;
  dir: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EPS = 1e-9;

/** Walls that restrict `kind`, as edges. Open doors restrict nothing. */
export function wallEdges(walls: Iterable<WallDoc>, kind: SenseKind): Edge[] {
  const out: Edge[] = [];
  for (const w of walls) {
    if (w.door && w.ds === DOOR_STATE.OPEN) continue;
    const sense = w[kind] ?? SENSE.NORMAL;
    if (sense === SENSE.NONE) continue;
    const [ax, ay, bx, by] = w.c;
    if (ax === bx && ay === by) continue;
    out.push({ ax, ay, bx, by, sense, dir: w.dir ?? WALL_DIR.BOTH });
  }
  return out;
}

/**
 * Which side of the edge (a → b) a point lies on: 1 = left, 2 = right, 0 = collinear.
 * Matches the convention Foundry uses for one-way walls, so imported walls keep their facing.
 */
export function sideOf(e: Edge, p: Point): 0 | 1 | 2 {
  const o = (e.ay - p.y) * (e.bx - p.x) - (e.ax - p.x) * (e.by - p.y);
  if (Math.abs(o) < EPS) return 0;
  return o < 0 ? 1 : 2;
}

/** One-way walls are transparent when the viewer stands on the side named by `dir`. */
function blocksFrom(e: Edge, origin: Point): boolean {
  const side = sideOf(e, origin);
  if (side === 0) return false;
  return e.dir === WALL_DIR.BOTH || e.dir !== side;
}

/** Parameter t ∈ (0, ∞) along the ray origin + t·(dx, dy) where it hits the edge, or null. */
function rayHit(ox: number, oy: number, dx: number, dy: number, e: Edge): number | null {
  const ex = e.bx - e.ax;
  const ey = e.by - e.ay;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < EPS) return null;
  const t = ((e.ax - ox) * ey - (e.ay - oy) * ex) / denom;
  const u = ((e.ax - ox) * dy - (e.ay - oy) * dx) / denom;
  if (t <= EPS || u < -EPS || u > 1 + EPS) return null;
  return t;
}

/** Intersection point of two segments, if they cross. */
export function segmentIntersection(a: Edge, b: Edge): Point | null {
  const rx = a.bx - a.ax, ry = a.by - a.ay;
  const sx = b.bx - b.ax, sy = b.by - b.ay;
  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;
  const t = ((b.ax - a.ax) * sy - (b.ay - a.ay) * sx) / denom;
  const u = ((b.ax - a.ax) * ry - (b.ay - a.ay) * rx) / denom;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: a.ax + t * rx, y: a.ay + t * ry };
}

function distanceToSegment(p: Point, e: Edge): number {
  const ex = e.bx - e.ax, ey = e.by - e.ay;
  const len2 = ex * ex + ey * ey;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - e.ax) * ex + (p.y - e.ay) * ey) / len2)) : 0;
  return Math.hypot(p.x - (e.ax + t * ex), p.y - (e.ay + t * ey));
}

export interface PolygonOptions {
  /** Maximum reach in pixels; omit for unlimited (bounded by `bounds`). */
  radius?: number;
  /** Cone width in degrees; 360 or omitted = all round. */
  angle?: number;
  /** Cone facing in degrees, 0 = +y (down), clockwise. */
  rotation?: number;
  /** Rays used to approximate the radius circle. */
  density?: number;
}

/**
 * Visibility polygon: the region visible from `origin`, blocked by `edges`, clipped to `bounds`,
 * optionally limited by a radius and a cone. Vertices are returned in angular order.
 *
 * Method: cast rays towards every edge endpoint and edge–edge intersection (plus a hair either
 * side), towards evenly spaced angles for the radius circle, and along the cone limits. Each ray stops
 * at the first normal edge or the second limited edge. Connecting the hit points in angular order
 * gives the polygon.
 */
export function visibilityPolygon(origin: Point, edges: Edge[], bounds: Rect, opts: PolygonOptions = {}): Point[] {
  const { x: ox, y: oy } = origin;
  const radius = opts.radius && opts.radius > 0 ? opts.radius : Infinity;
  const cone = opts.angle !== undefined && opts.angle < 360 ? Math.max(1, opts.angle) : 360;

  const active: Edge[] = [];
  for (const e of edges) {
    if (!blocksFrom(e, origin)) continue;
    if (radius !== Infinity && distanceToSegment(origin, e) > radius) continue;
    active.push(e);
  }
  const { x, y, width, height } = bounds;
  const border: Edge[] = [
    { ax: x, ay: y, bx: x + width, by: y, sense: SENSE.NORMAL, dir: 0 },
    { ax: x + width, ay: y, bx: x + width, by: y + height, sense: SENSE.NORMAL, dir: 0 },
    { ax: x + width, ay: y + height, bx: x, by: y + height, sense: SENSE.NORMAL, dir: 0 },
    { ax: x, ay: y + height, bx: x, by: y, sense: SENSE.NORMAL, dir: 0 }
  ];
  const all = active.concat(border);

  // Candidate angles (radians, atan2 convention: 0 = +x, increasing towards +y).
  const angles: number[] = [];
  const toward = (px: number, py: number) => {
    const a = Math.atan2(py - oy, px - ox);
    angles.push(a - 1e-5, a, a + 1e-5);
  };
  for (const e of all) {
    toward(e.ax, e.ay);
    toward(e.bx, e.by);
  }
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const p = segmentIntersection(active[i], active[j]);
      if (p) toward(p.x, p.y);
    }
  }
  if (radius !== Infinity) {
    const n = opts.density ?? 96;
    for (let i = 0; i < n; i++) angles.push((i / n) * Math.PI * 2 - Math.PI);
  }

  // Cone limits. Mesa rotation 0 faces down (+y), i.e. atan2 angle π/2.
  let coneStart = -Infinity, coneEnd = Infinity;
  if (cone < 360) {
    const facing = ((opts.rotation ?? 0) * Math.PI) / 180 + Math.PI / 2;
    const half = (cone * Math.PI) / 360;
    coneStart = facing - half;
    coneEnd = facing + half;
    angles.push(coneStart, coneEnd);
  }

  const norm = (a: number) => {
    // Map into [coneStart, coneStart + 2π) when a cone is active, else (-π, π].
    if (coneStart === -Infinity) return Math.atan2(Math.sin(a), Math.cos(a));
    let v = a;
    while (v < coneStart) v += Math.PI * 2;
    while (v >= coneStart + Math.PI * 2) v -= Math.PI * 2;
    return v;
  };
  const unique = [...new Set(angles.map(a => Math.round(norm(a) * 1e7) / 1e7))]
    .filter(a => coneStart === -Infinity || a <= coneEnd + 1e-9)
    .sort((a, b) => a - b);

  const points: Point[] = [];
  if (cone < 360) points.push({ x: ox, y: oy });
  const hits: { t: number; sense: number }[] = [];
  for (const a of unique) {
    const dx = Math.cos(a), dy = Math.sin(a);
    hits.length = 0;
    for (const e of all) {
      const t = rayHit(ox, oy, dx, dy, e);
      if (t !== null) hits.push({ t, sense: e.sense });
    }
    hits.sort((p, q) => p.t - q.t);
    let reach = Infinity;
    let limitedSeen = false;
    for (const h of hits) {
      if (h.sense === SENSE.LIMITED && !limitedSeen) {
        limitedSeen = true;
        continue;
      }
      reach = h.t;
      break;
    }
    const d = Math.min(reach, radius);
    points.push({ x: ox + dx * d, y: oy + dy * d });
  }
  return points;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Whether moving in a straight line from `a` to `b` crosses a movement-blocking wall. */
export function movementBlocked(a: Point, b: Point, edges: Edge[]): boolean {
  if (a.x === b.x && a.y === b.y) return false;
  const path: Edge = { ax: a.x, ay: a.y, bx: b.x, by: b.y, sense: SENSE.NORMAL, dir: 0 };
  for (const e of edges) {
    if (!blocksFrom(e, a)) continue;
    if (segmentIntersection(path, e)) return true;
  }
  return false;
}

/**
 * Distance between two points on a square grid, in scene units, counting diagonal steps as one square
 * (Foundry's default "equidistant" rule).
 */
export function gridDistance(a: Point, b: Point, gridSize: number, gridDistanceUnits: number): number {
  const dx = Math.abs(b.x - a.x) / gridSize;
  const dy = Math.abs(b.y - a.y) / gridSize;
  return Math.round(Math.max(dx, dy)) * gridDistanceUnits;
}

/** Convert scene distance units (e.g. metres) to pixels. */
export function unitsToPixels(units: number, gridSize: number, gridDistanceUnits: number): number {
  return (units / (gridDistanceUnits || 1)) * gridSize;
}
