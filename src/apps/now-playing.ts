import { Font, type LedMatrixInstance } from "../module";
import { wait } from "../utils";

/**
 * Now Playing: shows title / artist / album of an AirPlay speaker that is
 * exposed to Home Assistant as a media_player entity.
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

const POLL_MS = 2000;
const FRAME_MS = 60; // scroll speed: 1px per frame
const SCROLL_GAP = 24; // px of blank space between marquee repeats
const SCROLL_PAUSE_FRAMES = 20; // hold at start of marquee before scrolling

const titleFont = new Font("title", "./fonts/7x14B.bdf");
const smallFont = new Font("small", "./fonts/spleen-5x8.bdf");
const tinyFont = new Font("tiny", "./fonts/4x6.bdf");

type Track = {
  state: "playing" | "paused";
  title: string;
  artist: string;
  album: string;
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
    album: toDisplay(a.media_album_name),
  };
}

/** One row of text that marquee-scrolls if it is wider than the panel. */
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

    if (textW <= w) {
      matrix.drawText(this.text, Math.floor((w - textW) / 2), y);
      return;
    }

    matrix.drawText(this.text, -this.offset, y);
    // Second copy so the loop is seamless
    matrix.drawText(this.text, -this.offset + textW + SCROLL_GAP, y);

    if (this.pause > 0) {
      this.pause--;
      return;
    }
    this.offset++;
    if (this.offset >= textW + SCROLL_GAP) {
      this.offset = 0;
      this.pause = SCROLL_PAUSE_FRAMES;
    }
  }
}

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function drawIdle(matrix: LedMatrixInstance) {
  const t = timeFormatter.format(new Date());
  matrix.fgColor(0x403000); // dim amber so it's not distracting
  matrix.font(titleFont);
  const x = Math.floor((matrix.width() - titleFont.stringWidth(t)) / 2);
  matrix.drawText(t, x, Math.floor((matrix.height() - 14) / 2));
}

export const run = async (matrix: LedMatrixInstance) => {
  if (!HA_TOKEN || ENTITIES.length === 0) {
    console.error("now-playing: set HA_TOKEN and HA_ENTITIES (and HA_URL).");
  }

  matrix.brightness(70);

  const artist = new Marquee(smallFont);
  const title = new Marquee(titleFont);
  const album = new Marquee(tinyFont);

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

      if (!track) {
        drawIdle(matrix);
      } else {
        const paused = track.state === "paused";
        artist.set(track.artist);
        title.set(track.title);
        album.set(track.album);

        matrix.fgColor(paused ? 0x404040 : 0x00c8ff);
        artist.draw(matrix, 1);

        matrix.fgColor(paused ? 0x707070 : 0xffdc00);
        title.draw(matrix, 10);

        matrix.fgColor(paused ? 0x303030 : 0x909090);
        album.draw(matrix, 25);
      }

      matrix.sync();
      await wait(FRAME_MS);
    }
  } catch (error) {
    console.error(`${__filename} caught: `, error);
  }
};
