import { readFileSync } from "node:fs";
import type { LedMatrixInstance } from "../module";

/**
 * A line of text drawn pixel by pixel from a BDF font, with lights that chase
 * around the outline of the whole word.
 *
 * Because the text is drawn here from the font's own bitmaps, we know exactly
 * which pixels are letters and can trace the outline around them.
 */

type Glyph = {
  advance: number;
  width: number;
  height: number;
  xOff: number;
  yOff: number;
  rows: number[][]; // rows[r][c] is 1 when the pixel is lit
};

type Font = {
  ascent: number;
  glyphs: Map<number, Glyph>;
};

type Point = [number, number];

export type BannerOptions = {
  fontPath: string;
  text: string;
  top: number; // y of the top of the font cell
  letterColor: number;
  outlineColor: number; // dim ring that is always lit
  chaseColor: [number, number, number]; // brightest part of a moving light
  pixelsPerLight?: number; // one moving light per this many outline pixels
  trail?: number; // length of each light's fading tail, in pixels
};

export function parseBdf(src: string): Font {
  const glyphs = new Map<number, Glyph>();
  let ascent: number | null = null;
  let boxHeight = 0;
  let boxYOff = 0;

  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const [key, ...rest] = lines[i].trim().split(/\s+/);
    if (key === "FONT_ASCENT") ascent = Number(rest[0]);
    if (key === "FONTBOUNDINGBOX") {
      boxHeight = Number(rest[1]);
      boxYOff = Number(rest[3]);
    }
    if (key !== "STARTCHAR") continue;

    let encoding = -1;
    let advance = 0;
    let width = 0;
    let height = 0;
    let xOff = 0;
    let yOff = 0;
    const rows: number[][] = [];

    for (i++; i < lines.length; i++) {
      const [k, ...r] = lines[i].trim().split(/\s+/);
      if (k === "ENCODING") encoding = Number(r[0]);
      else if (k === "DWIDTH") advance = Number(r[0]);
      else if (k === "BBX") {
        width = Number(r[0]);
        height = Number(r[1]);
        xOff = Number(r[2]);
        yOff = Number(r[3]);
      } else if (k === "BITMAP") {
        for (let n = 0; n < height; n++) {
          const hex = lines[++i].trim();
          const value = Number.parseInt(hex, 16);
          const bits = hex.length * 4;
          const row: number[] = [];
          for (let c = 0; c < width; c++) {
            row.push((value >> (bits - 1 - c)) & 1);
          }
          rows.push(row);
        }
      } else if (k === "ENDCHAR") break;
    }
    if (encoding >= 0) {
      glyphs.set(encoding, { advance, width, height, xOff, yOff, rows });
    }
  }

  return { ascent: ascent ?? boxHeight + boxYOff, glyphs };
}

/** Lit pixels of `text` laid out from `x0`, with the font cell's top at `top`. */
export function layoutText(
  font: Font,
  text: string,
  x0: number,
  top: number,
): Set<string> {
  const lit = new Set<string>();
  let pen = x0;
  for (const ch of text) {
    const g = font.glyphs.get(ch.codePointAt(0) ?? 32);
    if (!g) continue;
    for (let r = 0; r < g.height; r++) {
      for (let c = 0; c < g.width; c++) {
        if (g.rows[r][c]) {
          const x = pen + g.xOff + c;
          const y = top + font.ascent - (g.yOff + g.height) + r;
          lit.add(`${x},${y}`);
        }
      }
    }
    pen += g.advance;
  }
  return lit;
}

export function textWidth(font: Font, text: string): number {
  let w = 0;
  for (const ch of text) w += font.glyphs.get(ch.codePointAt(0) ?? 32)?.advance ?? 0;
  return w;
}

// Neighbours in clockwise order, starting from the west.
const RING: Point[] = [
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
];

/**
 * Ordered pixels of the outer outline of a shape (Moore-neighbour tracing).
 * `filled` is the shape grown by one pixel, so its edge sits just outside the
 * letters.
 */
export function traceOutline(
  filled: Set<string>,
  width: number,
  height: number,
): Point[] {
  const on = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && filled.has(`${x},${y}`);

  let start: Point | null = null;
  for (let y = 0; y < height && !start; y++) {
    for (let x = 0; x < width; x++) {
      if (on(x, y)) {
        start = [x, y];
        break;
      }
    }
  }
  if (!start) return [];

  const path: Point[] = [start];
  let cur: Point = start;
  let from = 0; // index in RING of the neighbour we came from (west of start)
  const limit = width * height * 4;

  for (let step = 0; step < limit; step++) {
    let next: Point | null = null;
    let nextFrom = 0;
    for (let k = 1; k <= 8; k++) {
      const idx = (from + k) % 8;
      const nx = cur[0] + RING[idx][0];
      const ny = cur[1] + RING[idx][1];
      if (on(nx, ny)) {
        next = [nx, ny];
        // we arrive at `next` from the previous ring position around `cur`
        const back = (idx + 7) % 8;
        const bx = cur[0] + RING[back][0] - nx;
        const by = cur[1] + RING[back][1] - ny;
        nextFrom = RING.findIndex(([dx, dy]) => dx === bx && dy === by);
        break;
      }
    }
    if (!next) break; // single isolated pixel
    if (next[0] === start[0] && next[1] === start[1] && path.length > 2) break;
    path.push(next);
    cur = next;
    from = nextFrom < 0 ? 0 : nextFrom;
  }
  return path;
}

const grow = (lit: Set<string>): Set<string> => {
  const out = new Set(lit);
  for (const key of lit) {
    const [x, y] = key.split(",").map(Number);
    for (const [dx, dy] of RING) out.add(`${x + dx},${y + dy}`);
  }
  return out;
};

/** Splits a pixel set into groups of touching pixels (8-connected). */
export function components(filled: Set<string>): Set<string>[] {
  const seen = new Set<string>();
  const groups: Set<string>[] = [];
  for (const key of filled) {
    if (seen.has(key)) continue;
    const group = new Set<string>();
    const stack = [key];
    seen.add(key);
    while (stack.length > 0) {
      const k = stack.pop() as string;
      group.add(k);
      const [x, y] = k.split(",").map(Number);
      for (const [dx, dy] of RING) {
        const n = `${x + dx},${y + dy}`;
        if (filled.has(n) && !seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    groups.push(group);
  }
  return groups;
}

const mix = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

export class OutlineBanner {
  private letters: Point[];
  private loops: Point[][];

  constructor(
    private opts: BannerOptions,
    panelWidth: number,
    panelHeight: number,
  ) {
    const font = parseBdf(readFileSync(opts.fontPath, "utf8"));
    const x0 = Math.floor((panelWidth - textWidth(font, opts.text)) / 2);
    const lit = layoutText(font, opts.text, x0, opts.top);
    this.letters = [...lit].map((k) => k.split(",").map(Number) as Point);

    // One outline loop around each cluster of touching letters.
    this.loops = components(grow(lit))
      .map((group) =>
        traceOutline(group, panelWidth, panelHeight).filter(
          ([x, y]) => !lit.has(`${x},${y}`),
        ),
      )
      .filter((loop) => loop.length > 0)
      .sort((a, b) => a[0][0] - b[0][0]);
  }

  /** Draws the letters, the dim outline and the moving lights for `frame`. */
  draw(matrix: LedMatrixInstance, frame: number, framesPerStep = 2) {
    const { letterColor, outlineColor, chaseColor } = this.opts;
    const trail = this.opts.trail ?? 6;
    const perLight = this.opts.pixelsPerLight ?? 30;
    const step = Math.floor(frame / framesPerStep);
    const base = [
      (outlineColor >> 16) & 255,
      (outlineColor >> 8) & 255,
      outlineColor & 255,
    ];

    matrix.fgColor(letterColor);
    for (const [x, y] of this.letters) matrix.setPixel(x, y);

    this.loops.forEach((loop, loopIndex) => {
      const n = loop.length;
      const lights = Math.max(1, Math.round(n / perLight));
      const phase = loopIndex * 5; // keeps neighbouring loops out of step
      for (let i = 0; i < n; i++) {
        // distance behind the nearest light, so each light has a tail
        let best = Number.POSITIVE_INFINITY;
        for (let l = 0; l < lights; l++) {
          const pos = (step + phase + Math.floor((l * n) / lights)) % n;
          const behind = (pos - i + n) % n;
          if (behind < best) best = behind;
        }
        const t = best < trail ? 1 - best / trail : 0;
        const r = mix(base[0], chaseColor[0], t);
        const g = mix(base[1], chaseColor[1], t);
        const b = mix(base[2], chaseColor[2], t);
        matrix.fgColor((r << 16) | (g << 8) | b);
        matrix.setPixel(loop[i][0], loop[i][1]);
      }
    });
  }
}
