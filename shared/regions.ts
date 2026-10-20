import type { Point } from "./geometry.ts";
import { pointInPolygon } from "./geometry.ts";
import type { RegionDoc, RegionShape, TokenDoc } from "./protocol.ts";

/** Polygon (flat x,y list) approximating a region shape, used both to draw and to test containment. */
export function shapePolygon(s: RegionShape): number[] {
  const ring = (cx: number, cy: number, rx: number, ry: number, rot = 0, from = 0, to = Math.PI * 2, steps = 48) => {
    const out: number[] = [];
    const c = Math.cos(rot), sn = Math.sin(rot);
    for (let i = 0; i <= steps; i++) {
      const a = from + ((to - from) * i) / steps;
      const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
      out.push(cx + x * c - y * sn, cy + x * sn + y * c);
    }
    return out;
  };
  const rad = (deg: number) => (deg * Math.PI) / 180;
  switch (s.type) {
    case "rectangle": {
      const r = rad(s.rotation ?? 0), c = Math.cos(r), sn = Math.sin(r);
      const corners = [[0, 0], [s.width, 0], [s.width, s.height], [0, s.height]];
      return corners.flatMap(([x, y]) => [s.x + x * c - y * sn, s.y + x * sn + y * c]);
    }
    case "circle":
      return ring(s.x, s.y, s.radius, s.radius);
    case "ellipse":
      return ring(s.x, s.y, s.radiusX, s.radiusY, rad(s.rotation ?? 0));
    case "cone": {
      const dir = rad(s.rotation ?? 0), half = rad(s.angle) / 2;
      return [s.x, s.y, ...ring(s.x, s.y, s.radius, s.radius, 0, dir - half, dir + half, 32)];
    }
    case "line": {
      const r = rad(s.rotation ?? 0), c = Math.cos(r), sn = Math.sin(r), hw = s.width / 2;
      const corners = [[0, -hw], [s.length, -hw], [s.length, hw], [0, hw]];
      return corners.flatMap(([x, y]) => [s.x + x * c - y * sn, s.y + x * sn + y * c]);
    }
    case "polygon":
      return s.points;
  }
}

function toPoints(flat: number[]): Point[] {
  const out: Point[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push({ x: flat[i], y: flat[i + 1] });
  return out;
}

/** Whether a point is inside any of the region's shapes (shapes are united, like Foundry's). */
export function regionContainsPoint(region: Pick<RegionDoc, "shapes">, p: Point): boolean {
  return region.shapes.some(s => pointInPolygon(p, toPoints(shapePolygon(s))));
}

/** Whether a token is in the region: centre inside a shape, elevation in the band, on one of its levels. */
export function tokenInRegion(region: RegionDoc, token: TokenDoc, gridSize: number, tokenLevel: string | null): boolean {
  if (region.levels.length && (!tokenLevel || !region.levels.includes(tokenLevel))) return false;
  const e = token.elevation ?? 0;
  if (e < (region.elevation.bottom ?? -Infinity) || e > (region.elevation.top ?? Infinity)) return false;
  const centre = { x: token.x + (token.width * gridSize) / 2, y: token.y + (token.height * gridSize) / 2 };
  return regionContainsPoint(region, centre);
}

/** A random point inside the region (for teleport destinations), snapped to grid centres when possible. */
export function randomPointIn(region: Pick<RegionDoc, "shapes">, gridSize: number, random = Math.random): Point | null {
  const all = region.shapes.flatMap(s => toPoints(shapePolygon(s)));
  if (!all.length) return null;
  const minX = Math.min(...all.map(p => p.x)), maxX = Math.max(...all.map(p => p.x));
  const minY = Math.min(...all.map(p => p.y)), maxY = Math.max(...all.map(p => p.y));
  for (let i = 0; i < 200; i++) {
    const raw = { x: minX + random() * (maxX - minX), y: minY + random() * (maxY - minY) };
    const snapped = { x: Math.floor(raw.x / gridSize) * gridSize + gridSize / 2, y: Math.floor(raw.y / gridSize) * gridSize + gridSize / 2 };
    if (regionContainsPoint(region, snapped)) return snapped;
    if (regionContainsPoint(region, raw)) return raw;
  }
  return null;
}
