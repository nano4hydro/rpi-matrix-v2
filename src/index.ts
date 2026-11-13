import { run as runLetterClock } from "./apps/letter-clock";
import { run as runNowPlaying } from "./apps/now-playing";
import { GpioMapping, LedMatrix } from "./module";

const matrix = new LedMatrix(
  {
    ...LedMatrix.defaultMatrixOptions(),
    rows: 32,
    cols: 64,
    chainLength: 1,
    // Pi 4 wired straight to the Waveshare panel (no Adafruit bonnet)
    hardwareMapping: GpioMapping.Regular,
    parallel: 1,
    disableHardwarePulsing: true,
    // If colors look wrong, try "RGB" or "GRB"
    ledRgbSequence: "RBG",
  },
  { ...LedMatrix.defaultRuntimeOptions(), gpioSlowdown: 4 },
);

// Graceful exit on Ctrl+C
process.on("SIGINT", () => {
  console.log("Received SIGINT");
  matrix.clear();
  matrix.sync();
  process.exit(0);
});

// APP=clock | now-playing (defaults to now-playing when HA_TOKEN is set)
const app = process.env.APP ?? (process.env.HA_TOKEN ? "now-playing" : "clock");

if (app === "now-playing") {
  runNowPlaying(matrix);
} else {
  runLetterClock(matrix);
}
