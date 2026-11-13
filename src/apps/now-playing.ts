import { Font, type LedMatrixInstance } from "../module";
import { wait } from "../utils";

/**
 * Now Playing: shows a fading "EllieStream" header with "Song Name by Artist"
 * scrolling underneath, for an AirPlay speaker that is exposed to Home
 * Assistant as a media_player entity.
 *
 * Config (environment variables):
 *   HA_URL       e.g. http://homeassistant.local:8123
 *   HA_TOKEN     Long-lived access token (Profile -> Security in Home Assistant)
 *   HA_ENTITIES  Comma separated media_player entity ids, e.g.
 *                media_player.kitchen,media_player.living_room
 *                The first one that is "playing" wins, then the first "paused".
 */

const HA_URL = (process.env.HA_URL ?? "http://homeassistant.local:8123").replace(
  /\/+$/,
  "",
);
const HA_TOKEN = process.env.HA_TOKEN ?? "";
const ENTITIES = (process.env.HA_ENTITIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const HEADER_TEXT = "EllieStream";
const ON_AIR_TEXT = "ON AIR";
const PAUSED_TEXT = "PAUSED";

const POLL_MS = 2000;
const FRAME_MS = 40; // scroll speed: 1px per frame (lower = faster)
const SCROLL_GAP = 24; // px of blank space between marquee repeats
const SCROLL_PAUSE_FRAMES = 25; // hold at the start before scrolling
const ALWAYS_SCROLL = true; // scroll even when the text would fit

// Header colors: each one fades in and back out, then the next one starts.
const HEADER_COLORS: [number, number, number][] = [
  [0, 200, 255], // cyan
  [255, 0, 160], // magenta
  [255, 200, 0], // amber
  [0, 255, 120], // green
  [160, 80, 255], // violet
  [255, 80, 40], // orange-red
];
const COLOR_PERIOD_MS = 4000; // time each color takes to fade in and out

const headerFont = new Font("header", "./fonts/spleen-5x8.bdf");
const titleFont = new Font("title", "./fonts/7x14B.bdf");

type Track = {
  state: "playing" | "paused";
  title: string;
  artist: string;
};

/** BDF fonts only cover basic Latin: strip accents, replace the rest. */
const toDisplay = (s: unknown): string =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "?")
    .trim();

type HAState = {
  state: string;
  attributes: Record<string, unknown>;
};

async function fetchState(entity: string): Promise<HAState | null> {
  try {
    const res = await fetch(`${HA_URL}/api/states/${entity}`, {
      headers: { Authorization: `Bearer ${HA_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as HAState;
  } catch {
    return null;
  }
}

async function fetchTrack(): Promise<Track | null> {
  const states = await Promise.all(ENTITIES.map(fetchState));
  const pick =
    states.find((s) => s?.state === "playing") ??
    states.find((s) => s?.state === "paused");
  if (!pick) return null;

  const a = pick.attributes;
  const title = toDisplay(a.media_title);
  if (!title) return null;

  return {
    state: pick.state as Track["state"],
    title,
    artist: toDisplay(a.media_artist),
  };
}

/** One row of text that marquee-scrolls. */
class Marquee {
  private text = "";
  private offset = 0;
  private pause = SCROLL_PAUSE_FRAMES;

  constructor(private font: InstanceType<typeof Font>) {}

  set(text: string) {
    if (text !== this.text) {
      this.text = text;
      this.offset = 0;
      this.pause = SCROLL_PAUSE_FRAMES;
    }
  }

  draw(matrix: LedMatrixInstance, y: number) {
    if (!this.text) return;
    matrix.font(this.font);
    const w = matrix.width();
    const textW = this.font.stringWidth(this.text);

    if (textW <= w && !ALWAYS_SCROLL) {
      matrix.drawText(this.text, Math.floor((w - textW) / 2), y);
      return;
    }

    // Draw as many copies as it takes to fill the panel, so the loop is seamless.
    const cycle = textW + SCROLL_GAP;
    for (let x = -this.offset; x < w; x += cycle) {
      matrix.drawText(this.text, x, y);
    }

    if (this.pause > 0) {
      this.pause--;
      return;
    }
    this.offset++;
    if (this.offset >= cycle) {
      this.offset = 0;
      this.pause = SCROLL_PAUSE_FRAMES;
    }
  }
}

/** Current header color: one palette entry at a time, fading 0 -> 1 -> 0. */
function headerColor(now: number): number {
  const index = Math.floor(now / COLOR_PERIOD_MS) % HEADER_COLORS.length;
  const t = (now % COLOR_PERIOD_MS) / COLOR_PERIOD_MS;
  const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * t); // 0 -> 1 -> 0
  const level = wave * wave; // squared so the fade looks even on LEDs
  const [r, g, b] = HEADER_COLORS[index];
  return (
    (Math.round(r * level) << 16) |
    (Math.round(g * level) << 8) |
    Math.round(b * level)
  );
}

function drawHeader(matrix: LedMatrixInstance) {
  matrix.fgColor(headerColor(Date.now()));
  matrix.font(headerFont);
  const x = Math.floor((matrix.width() - headerFont.stringWidth(HEADER_TEXT)) / 2);
  matrix.drawText(HEADER_TEXT, x, 0);
}

/** Draws text centered horizontally at row y, in the current color. */
function drawCentered(
  matrix: LedMatrixInstance,
  font: InstanceType<typeof Font>,
  text: string,
  y: number,
) {
  matrix.font(font);
  const x = Math.floor((matrix.width() - font.stringWidth(text)) / 2);
  matrix.drawText(text, x, y);
}

/** Bottom line: red ON AIR while playing, amber PAUSED while paused. */
function drawStatus(matrix: LedMatrixInstance, text: string, color: number) {
  matrix.fgColor(color);
  drawCentered(matrix, headerFont, text, 24);
}

// Optional IANA time zone, e.g. America/New_York. Defaults to the Pi's own
// zone, which is often UTC on a fresh install.
const TIMEZONE = process.env.TIMEZONE || undefined;

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZone: TIMEZONE,
});
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: TIMEZONE,
});

/** Newer Node/Bun versions put a narrow no-break space before AM/PM. */
const plainSpaces = (s: string) => s.replace(/[^\x20-\x7e]/g, " ");

/** Idle screen: dim 12-hour time in the middle and the date along the bottom. */
function drawIdle(matrix: LedMatrixInstance) {
  const now = new Date();
  matrix.fgColor(0x504000); // dim amber so it's not distracting
  drawCentered(matrix, titleFont, plainSpaces(timeFormatter.format(now)), 9);
  matrix.fgColor(0x403000);
  drawCentered(matrix, headerFont, plainSpaces(dateFormatter.format(now)), 24);
}

export const run = async (matrix: LedMatrixInstance) => {
  if (!HA_TOKEN || ENTITIES.length === 0) {
    console.error("now-playing: set HA_TOKEN and HA_ENTITIES (and HA_URL).");
  }

  matrix.brightness(70);

  const song = new Marquee(titleFont);

  let track = null as Track | null;

  // Poll Home Assistant in the background; rendering never waits on the network.
  const poll = async () => {
    while (true) {
      if (HA_TOKEN && ENTITIES.length > 0) {
        track = await fetchTrack();
      }
      await wait(POLL_MS);
    }
  };
  poll();

  try {
    while (true) {
      matrix.clear();
      drawHeader(matrix);

      if (!track) {
        drawIdle(matrix);
      } else {
        const paused = track.state === "paused";
        song.set(
          track.artist ? `${track.title} by ${track.artist}` : track.title,
        );
        matrix.fgColor(paused ? 0x707070 : 0xffdc00);
        song.draw(matrix, 9);
        if (paused) drawStatus(matrix, PAUSED_TEXT, 0xffa000);
        else drawStatus(matrix, ON_AIR_TEXT, 0xff2020);
      }

      matrix.sync();
      await wait(FRAME_MS);
    }
  } catch (error) {
    console.error(`${__filename} caught: `, error);
  }
};
