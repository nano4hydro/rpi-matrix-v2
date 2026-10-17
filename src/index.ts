import { run as runLetterClock } from "./apps/letter-clock";
import { run as runNowPlaying } from "./apps/now-playing";
import { GpioMapping, LedMatrix } from "./module";

const matrix = new LedMatrix(
  {
    ...LedMatrix.defaultMatrixOptions(),
    rows: 32,
    cols: 64,
    chainLength: 1,
    hardwareMapping: GpioMapping.AdafruitHat,
    parallel: 1,
    ledRgbSequence: "RBG",
  },
  LedMatrix.defaultRuntimeOptions(),
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
