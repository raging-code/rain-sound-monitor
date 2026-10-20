#!/usr/bin/env node
/**
 * apply-calibration.mjs
 *
 * Adds "Calibrate" buttons to the rain-sound-monitor website.
 *
 *   Sound: records the quiet room, throws away spikes, saves the average
 *          as the quiet level (shown as 0 %).
 *   Rain:  records the dry pad, throws away spikes, saves the average as the
 *          dry level, then sorts moisture into Dry / Drizzle / Raining /
 *          Heavy rain.
 *
 * Usage (run it inside the project folder):
 *
 *   node apply-calibration.mjs            apply the patch
 *   node apply-calibration.mjs --dry-run  only check, change nothing
 *   node apply-calibration.mjs <folder>   patch a folder other than the current one
 *
 * Safe to run twice: it detects that the patch is already applied.
 * Nothing is written unless every change can be made, and the original
 * files are copied to data/calibration-patch-backup/ first.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- options
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const folderArg = args.find((a) => !a.startsWith("--"));
const root = path.resolve(folderArg || process.cwd());

const MARKER_FILE = "calibration.py";
const MARKER_TEXT = "calibration_command";

// ------------------------------------------------------------ new files
const NEW_FILES = {};

NEW_FILES["calibration.py"] = String.raw`"""
Calibration helpers: ignore spikes, average what is left, and convert raw
readings into percentages.
"""

import statistics


def robust_mean(values, tolerance):
    """Average of values after throwing the spikes away.

    A reading counts as a spike when it is further from the median than
    max(3 x MAD, tolerance). MAD (median absolute deviation) is a measure of
    spread that one clap or one splash cannot distort.
    Returns None when there are no values.
    """
    values = [float(v) for v in values]
    if not values:
        return None
    median = statistics.median(values)
    mad = statistics.median([abs(v - median) for v in values]) * 1.4826
    limit = max(3.0 * mad, float(tolerance))
    kept = [v for v in values if abs(v - median) <= limit]
    return {
        "mean": statistics.fmean(kept),
        "median": median,
        "kept": len(kept),
        "discarded": len(values) - len(kept),
        "total": len(values),
        "limit": limit,
    }


def sound_percent(swing, baseline, full_scale):
    """Sound swing (ADC counts) to 0-100 %. The calibrated quiet level is 0 %."""
    span = max(1.0, float(full_scale) - float(baseline))
    return max(0.0, min(100.0, (float(swing) - float(baseline)) / span * 100.0))


def moisture_percent(raw, dry, wet):
    """Rain ADC reading to 0-100 % moisture. The calibrated dry level is 0 %."""
    span = max(1.0, float(dry) - float(wet))
    return max(0.0, min(100.0, (float(dry) - float(raw)) / span * 100.0))
`;

NEW_FILES["static/css/calibration.css"] = String.raw`/* Calibration panel */
.calibration h2 {
  margin-bottom: 8px;
  font-size: 1.25rem;
}

.cal-intro {
  margin: 0 0 20px;
  color: var(--slate);
}

.cal-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.cal-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px 28px;
  border-radius: 28px;
  background: var(--sound-idle);
  color: var(--ink);
}

#cal-rain {
  background: var(--rain-idle);
}

.cal-card h3 {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
}

.cal-card p {
  margin: 0;
}

.cal-help {
  color: var(--slate);
}

.cal-progress {
  height: 8px;
  border-radius: 99px;
  background: rgba(22, 34, 43, 0.14);
  overflow: hidden;
}

.cal-bar {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--ink);
  transition: width 0.3s linear;
}

.cal-status {
  min-height: 1.5em;
  font-weight: 600;
}

.cal-card[data-state="done"] .cal-status {
  color: #1d6b47;
}

.cal-card[data-state="failed"] .cal-status {
  color: #a12d2d;
}

.cal-saved {
  color: var(--slate);
  font-variant-numeric: tabular-nums;
}

.cal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: auto;
}

.cal-card button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cal-card button:disabled:hover {
  background: transparent;
  color: var(--ink);
}

.cal-levels {
  margin: 16px 0 0;
  color: var(--slate);
  font-size: 0.95rem;
}

@media (max-width: 760px) {
  .cal-grid {
    grid-template-columns: 1fr;
  }

  .cal-card {
    padding: 22px;
  }
}
`;

NEW_FILES["static/js/calibration.js"] = String.raw`(() => {
  "use strict";

  const cards = {
    sound: document.getElementById("cal-sound"),
    rain: document.getElementById("cal-rain"),
  };
  if (!cards.sound || !cards.rain) return;

  const levelsNote = document.getElementById("cal-levels");
  const secondsNote = document.getElementById("cal-seconds");
  const LEVEL_NAMES = { drizzle: "Drizzle", rain: "Raining", heavy: "Heavy rain" };
  const BUTTON_TEXT = { sound: "Calibrate sound", rain: "Calibrate rain" };

  function parts(card) {
    return {
      start: card.querySelector("[data-cal-start]"),
      reset: card.querySelector("[data-cal-reset]"),
      track: card.querySelector(".cal-progress"),
      bar: card.querySelector(".cal-bar"),
      status: card.querySelector(".cal-status"),
      saved: card.querySelector(".cal-saved"),
    };
  }
  const ui = { sound: parts(cards.sound), rain: parts(cards.rain) };

  let running = null;
  let timer = null;

  async function request(url, options) {
    const controller = new AbortController();
    const stop = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      let data = {};
      try {
        data = await response.json();
      } catch (err) {
        data = {};
      }
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      return data;
    } finally {
      clearTimeout(stop);
    }
  }

  function when(ts) {
    return new Date(ts * 1000).toLocaleString([], {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function savedText(kind, data) {
    if (kind === "sound") {
      if (!data.calibrated_at) return "Not calibrated yet. The quiet level is 0.";
      return (
        "Quiet level: " + Math.round(data.baseline) + " of " + data.full_scale +
        ". Saved " + when(data.calibrated_at) + "."
      );
    }
    if (!data.calibrated_at) {
      return "Not calibrated yet. Using the default dry level " + data.default_dry + " from config.py.";
    }
    return "Dry level: " + Math.round(data.dry) + ". Saved " + when(data.calibrated_at) + ".";
  }

  function render(status) {
    running = status.running;
    if (secondsNote) secondsNote.textContent = String(Math.round(status.seconds));

    ["sound", "rain"].forEach((kind) => {
      const data = status[kind];
      const p = ui[kind];
      const isRunning = data.state === "running";

      cards[kind].dataset.state = data.state;
      p.track.hidden = !isRunning;
      if (isRunning) p.bar.style.width = Math.round(data.progress * 100) + "%";

      p.start.textContent = isRunning ? "Cancel" : BUTTON_TEXT[kind];
      p.start.dataset.action = isRunning ? "cancel" : "start";
      p.start.disabled = !isRunning && (status.running !== null || !data.available);
      p.reset.disabled = status.running !== null;

      if (isRunning) {
        p.status.textContent = "Recording... " + data.seconds_left + " s left";
      } else if (!data.available && data.state !== "done" && data.state !== "failed") {
        p.status.textContent = "Sensor offline. Check the wiring first.";
      } else {
        p.status.textContent = data.message || "";
      }
      p.saved.textContent = savedText(kind, data);
    });

    if (levelsNote && status.rain.levels) {
      const text = status.rain.levels
        .map((l) => (LEVEL_NAMES[l.name] || l.name) + " from " + l.from + "%")
        .join(", ");
      levelsNote.textContent = "Rain levels (moisture): Dry below " + status.rain.levels[0].from + "%, " + text + ".";
    }
  }

  async function poll() {
    clearTimeout(timer);
    try {
      render(await request("/api/calibration"));
    } catch (err) {
      // the next poll will try again
    }
    timer = setTimeout(poll, running ? 300 : 1500);
  }

  async function send(kind, action) {
    try {
      render(
        await request("/api/calibrate/" + kind, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: action }),
        })
      );
    } catch (err) {
      ui[kind].status.textContent = err.message;
      cards[kind].dataset.state = "failed";
    }
    poll();
  }

  Object.keys(cards).forEach((kind) => {
    ui[kind].start.addEventListener("click", () => {
      send(kind, ui[kind].start.dataset.action || "start");
    });
    ui[kind].reset.addEventListener("click", () => {
      send(kind, "reset");
    });
  });

  poll();
})();
`;

// ------------------------------------------------------------- the edits
// Each step: after / before = a regex that must match exactly ONE line.
//   add     = text to insert (lines get the indent of the matched line)
//   rawAdd  = text inserted exactly as written
// replace = an exact piece of text that must appear exactly once.
const EDITS = {};

EDITS["config.py"] = [
  {
    after: /^ADC_FAULT_LIMIT = .*$/m,
    add: String.raw`
# --------------------------------------------------------------------------
# Calibration buttons on the web page
# --------------------------------------------------------------------------
CALIBRATION_SECONDS = 10       # how long each calibration records
CALIBRATION_MIN_SAMPLES = 20   # fewer readings than this -> the calibration fails
CALIBRATION_MAX_DISCARD = 0.4  # more than 40 % of readings were spikes -> "too unstable"
SOUND_CAL_TOLERANCE = 4        # ADC counts: readings further than this from the median are spikes
RAIN_CAL_TOLERANCE = 6         # (the real limit is the larger of this and 3 x the normal spread)
RAIN_MIN_SPAN = 100            # the dry reading must be at least this far above RAIN_WET_RAW

# Rain levels by moisture percent (0 % = calibrated dry level, 100 % = RAIN_WET_RAW).
# Each entry is (name, percent where that level starts). Keep them in ascending order.
RAIN_LEVELS = (("drizzle", 10), ("rain", 35), ("heavy", 65))
RAIN_LEVEL_HYSTERESIS = 4      # percent a reading must fall below a level before it drops back`,
  },
  {
    after: /^([ \t]+)"led_mode": "auto",.*$/m,
    add: String.raw`"sound_baseline": 0.0,        # saved by "Calibrate sound" (ADC counts, 0 = not calibrated)
"sound_calibrated_at": None,
"rain_dry_raw": None,          # saved by "Calibrate rain" (None = use RAIN_DRY_RAW)
"rain_calibrated_at": None,`,
  },
];

EDITS["sensors.py"] = [
  // real hardware: also report the raw numbers
  {
    after: /^([ \t]+)sound_level = None[ \t]*$/m,
    add: "sound_swing = None",
  },
  {
    after: /^([ \t]+)sound_level = _clamp\(\(high - low\) \/ config\.SOUND_FULL_SCALE \* 100\.0\)[ \t]*$/m,
    add: "sound_swing = high - low",
  },
  {
    after: /^([ \t]+)"sound_level": sound_level,[ \t]*$/m,
    add: String.raw`"sound_swing": sound_swing,
"rain_raw": raw["rain_raw"],`,
  },
  // simulator: pretend to have raw numbers too, so the buttons work on a PC
  {
    before: /^([ \t]+)"errors": \{\},[ \t]*$/m,
    add: String.raw`"sound_swing": _clamp(self._level) / 100.0 * config.SOUND_FULL_SCALE,
"rain_raw": config.RAIN_DRY_RAW
- _clamp(self._moisture) / 100.0 * (config.RAIN_DRY_RAW - config.RAIN_WET_RAW),`,
  },
];

EDITS["monitor.py"] = [
  { after: /^import database[ \t]*$/m, add: "import calibration" },
  {
    after: /^([ \t]+)self\._last_prune = time\.monotonic\(\)[ \t]*$/m,
    add: String.raw`# calibration (the Calibrate buttons on the web page)
self._cal = None                  # the calibration that is recording right now
self._cal_info = {
    "sound": {"state": "idle", "message": ""},
    "rain": {"state": "idle", "message": ""},
}
self._cal_available = {"sound": False, "rain": False}
self._rain_idx = 0                # rain level number (0 = dry), kept with hysteresis`,
  },
  {
    after: /^([ \t]+)state\["settings"\] = dict\(self\.settings\)[ \t]*$/m,
    add: 'state["calibration"] = self.calibration_status()',
  },
  {
    before: /^([ \t]*)# -+ loop[ \t]*$/m,
    rawAdd: String.raw`    # -------------------------------------------------------- calibration
    def calibration_command(self, kind, action):
        """Start, cancel or reset a calibration. Raises ValueError with a message for the page."""
        if kind not in ("sound", "rain"):
            raise ValueError("Unknown calibration: %s" % kind)

        if action == "start":
            with self._lock:
                if self._cal is not None:
                    raise ValueError("A calibration is already running. Wait for it to finish or cancel it.")
                if not self._cal_available[kind]:
                    raise ValueError("The %s sensor is offline. Check the wiring first." % kind)
                self._cal = {"kind": kind, "started": time.monotonic(), "samples": []}
                self._cal_info[kind] = {"state": "running", "message": ""}
        elif action == "cancel":
            with self._lock:
                if self._cal is not None and self._cal["kind"] == kind:
                    self._cal = None
                    self._cal_info[kind] = {"state": "idle", "message": "Calibration cancelled."}
        elif action == "reset":
            with self._lock:
                if self._cal is not None and self._cal["kind"] == kind:
                    self._cal = None
                if kind == "sound":
                    self.settings["sound_baseline"] = 0.0
                    self.settings["sound_calibrated_at"] = None
                else:
                    self.settings["rain_dry_raw"] = None
                    self.settings["rain_calibrated_at"] = None
                merged = dict(self.settings)
                self._cal_info[kind] = {"state": "idle", "message": "Calibration cleared. Using the defaults from config.py."}
            database.save_settings(merged)
        else:
            raise ValueError("Unknown action: %s" % action)
        return self.calibration_status()

    def calibration_status(self):
        duration = float(config.CALIBRATION_SECONDS)
        now = time.monotonic()
        with self._lock:
            out = {"seconds": duration, "running": None if self._cal is None else self._cal["kind"]}
            for kind in ("sound", "rain"):
                info = dict(self._cal_info[kind])
                if self._cal is not None and self._cal["kind"] == kind:
                    remaining = duration - (now - self._cal["started"])
                    info = {
                        "state": "running",
                        "message": "",
                        "progress": round(max(0.0, min(1.0, 1.0 - remaining / duration)), 3),
                        "seconds_left": int(remaining) + 1 if remaining > 0 else 0,
                        "samples": len(self._cal["samples"]),
                    }
                info["available"] = self._cal_available[kind]
                out[kind] = info
            out["sound"]["baseline"] = self.settings.get("sound_baseline") or 0.0
            out["sound"]["calibrated_at"] = self.settings.get("sound_calibrated_at")
            out["sound"]["full_scale"] = config.SOUND_FULL_SCALE
            out["rain"]["dry"] = self.settings.get("rain_dry_raw") or config.RAIN_DRY_RAW
            out["rain"]["calibrated_at"] = self.settings.get("rain_calibrated_at")
            out["rain"]["default_dry"] = config.RAIN_DRY_RAW
            out["rain"]["wet"] = config.RAIN_WET_RAW
            out["rain"]["levels"] = [{"name": n, "from": p} for n, p in config.RAIN_LEVELS]
        return out

    def _calibrate(self, raw, settings, now):
        """Feed the running calibration, then turn raw readings into calibrated percentages."""
        swing = raw.get("sound_swing")
        rain_raw = raw.get("rain_raw")
        self._cal_available = {"sound": swing is not None, "rain": rain_raw is not None}

        cal = self._cal
        if cal is not None:
            value = swing if cal["kind"] == "sound" else rain_raw
            if value is not None:
                cal["samples"].append(float(value))
            if cal["kind"] == "rain" and raw.get("rain_do"):
                cal["wet_ticks"] = cal.get("wet_ticks", 0) + 1   # the digital pin says the pad is wet
            if now - cal["started"] >= config.CALIBRATION_SECONDS:
                self._finish_calibration()

        if swing is not None:
            raw["sound_level"] = calibration.sound_percent(
                swing, settings.get("sound_baseline") or 0.0, config.SOUND_FULL_SCALE
            )
        if rain_raw is not None:
            dry = settings.get("rain_dry_raw") or config.RAIN_DRY_RAW
            raw["moisture"] = calibration.moisture_percent(rain_raw, dry, config.RAIN_WET_RAW)
        return raw

    def _finish_calibration(self):
        with self._lock:
            cal = self._cal
            self._cal = None
        if cal is None:
            return
        kind = cal["kind"]
        tolerance = config.SOUND_CAL_TOLERANCE if kind == "sound" else config.RAIN_CAL_TOLERANCE
        stats = calibration.robust_mean(cal["samples"], tolerance)

        value = None
        message = ""
        if stats is None or stats["total"] < config.CALIBRATION_MIN_SAMPLES:
            count = 0 if stats is None else stats["total"]
            message = "Only %d readings came in. Check that the sensor is connected." % count
        elif stats["discarded"] > stats["total"] * config.CALIBRATION_MAX_DISCARD:
            message = "The readings were too unstable (%d of %d were spikes). Try again." % (
                stats["discarded"], stats["total"])
        elif kind == "sound" and stats["mean"] > config.SOUND_FULL_SCALE * 0.5:
            message = "The room was too loud (average %.0f of %d). Try again when it is quiet." % (
                stats["mean"], config.SOUND_FULL_SCALE)
        elif kind == "rain" and cal.get("wet_ticks", 0) > stats["total"] * 0.3:
            message = (
                "The rain sensor reported wet during the calibration. Dry the pad completely and try again. "
                "(If the pad is dry, turn the small screw on the module until its DO light goes off.)"
            )
        elif kind == "rain" and stats["mean"] - config.RAIN_WET_RAW < config.RAIN_MIN_SPAN:
            message = (
                "The dry reading (%.0f) is too close to the wet reference (%d). Is the pad wet? "
                "Dry it and try again." % (stats["mean"], config.RAIN_WET_RAW)
            )
        else:
            value = stats["mean"]

        if value is None:
            info = {"state": "failed", "message": message}
            log.warning("%s calibration failed: %s", kind, message)
        else:
            stamp = int(time.time())
            with self._lock:
                if kind == "sound":
                    self.settings["sound_baseline"] = round(value, 1)
                    self.settings["sound_calibrated_at"] = stamp
                else:
                    self.settings["rain_dry_raw"] = round(value, 1)
                    self.settings["rain_calibrated_at"] = stamp
                merged = dict(self.settings)
            database.save_settings(merged)
            info = {
                "state": "done",
                "message": "Saved %.1f. Used %d readings and ignored %d spike(s)." % (
                    value, stats["kept"], stats["discarded"]),
            }
            log.info("%s calibration saved: %.1f (%d kept, %d spikes)", kind, value, stats["kept"], stats["discarded"])
        with self._lock:
            self._cal_info[kind] = info

    def _rain_level_for(self, moisture, active):
        """dry / drizzle / rain / heavy from the moisture percentage (with hysteresis)."""
        levels = config.RAIN_LEVELS
        if moisture is None:
            return "rain" if active else "dry"
        idx = self._rain_idx
        while idx < len(levels) and moisture >= levels[idx][1]:
            idx += 1
        while idx > 0 and moisture < levels[idx - 1][1] - config.RAIN_LEVEL_HYSTERESIS:
            idx -= 1
        self._rain_idx = idx
        name = "dry" if idx == 0 else levels[idx - 1][0]
        if name == "dry" and active:
            name = levels[0][0]   # the digital pin says wet, so it is at least a drizzle
        return name

`,
  },
  {
    before: /^([ \t]+)# -+ sound -+[ \t]*$/m,
    add: String.raw`raw = self._calibrate(raw, settings, now)
`,
  },
  {
    after: /^([ \t]+)rain_active = rain_hit or .*$/m,
    add: 'rain_level = self._rain_level_for(raw["moisture"], rain_active)',
  },
  {
    after: /^([ \t]+)"detected": rain_active,[ \t]*$/m,
    add: '"level": rain_level,',
  },
];

EDITS["app.py"] = [
  {
    before: /^@app\.post\("\/api\/buzzer\/test"\)[ \t]*$/m,
    rawAdd: String.raw`@app.get("/api/calibration")
def api_calibration():
    return jsonify(monitor.calibration_status())


@app.post("/api/calibrate/<kind>")
def api_calibrate(kind):
    payload = request.get_json(silent=True) or {}
    try:
        status = monitor.calibration_command(kind, payload.get("action", "start"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    return jsonify(status)


`,
  },
];

EDITS["templates/index.html"] = [
  {
    before: /^[ \t]*<\/head>[ \t]*$/m,
    rawAdd: `  <link rel="stylesheet" href="{{ url_for('static', filename='css/calibration.css') }}">\n`,
  },
  {
    before: /^[ \t]*<\/main>[ \t]*$/m,
    rawAdd: String.raw`
    <section class="calibration" aria-label="Calibration">
      <h2>Calibration</h2>
      <p class="cal-intro">Each calibration records for <span id="cal-seconds">10</span> seconds, ignores sudden spikes and saves the average. It is kept after a restart.</p>
      <div class="cal-grid">
        <div class="cal-card" id="cal-sound" data-state="idle">
          <h3>Sound: quiet level</h3>
          <p class="cal-help">Keep the room quiet, then press the button. The average background noise becomes 0 %.</p>
          <div class="cal-progress" hidden><div class="cal-bar"></div></div>
          <p class="cal-status" role="status" aria-live="polite"></p>
          <p class="cal-saved"></p>
          <div class="cal-actions">
            <button type="button" data-cal-start>Calibrate sound</button>
            <button type="button" data-cal-reset>Reset</button>
          </div>
        </div>

        <div class="cal-card" id="cal-rain" data-state="idle">
          <h3>Rain: dry level</h3>
          <p class="cal-help">Wipe the pad completely dry, then press the button. The average dry reading becomes 0 % moisture.</p>
          <div class="cal-progress" hidden><div class="cal-bar"></div></div>
          <p class="cal-status" role="status" aria-live="polite"></p>
          <p class="cal-saved"></p>
          <div class="cal-actions">
            <button type="button" data-cal-start>Calibrate rain</button>
            <button type="button" data-cal-reset>Reset</button>
          </div>
        </div>
      </div>
      <p class="cal-levels" id="cal-levels"></p>
    </section>
`,
  },
  {
    before: /^[ \t]*<\/body>[ \t]*$/m,
    rawAdd: `  <script src="{{ url_for('static', filename='js/calibration.js') }}"></script>\n`,
  },
];

EDITS["static/js/app.js"] = [
  {
    replace: 'const rainState = !rain.online ? "offline" : rain.detected ? "alert" : "idle";',
    with: 'const rainState = !rain.online\n      ? "offline"\n      : rain.detected || (rain.level && rain.level !== "dry")\n        ? "alert"\n        : "idle";',
  },
  {
    replace: 'rainState === "offline" ? "Offline" : rainState === "alert" ? "Raining" : "Dry";',
    with:
      'rainState === "offline"\n        ? "Offline"\n        : { dry: "Dry", drizzle: "Drizzle", rain: "Raining", heavy: "Heavy rain" }[rain.level] ||\n          (rainState === "alert" ? "Raining" : "Dry");',
  },
];

EDITS["README.md"] = [
  {
    append: String.raw`

## 9. Calibration buttons

The **Calibration** section at the bottom of the dashboard has two buttons.

- **Calibrate sound**: keep the room quiet and press it. It records for 10 seconds, throws away spikes (claps, bumps) and saves the average background noise as the quiet level. After that, the quiet room reads 0 %.
- **Calibrate rain**: wipe the pad completely dry and press it. It records for 10 seconds, throws away spikes and saves the average dry reading. Moisture is then 0 % at that dry level and 100 % at RAIN_WET_RAW.

Rain is shown as Dry, Drizzle, Raining or Heavy rain. The moisture percentage where each level starts is set by RAIN_LEVELS in config.py (default 10 %, 35 % and 65 %).

If a calibration fails (room too loud, pad wet, readings unstable) nothing is saved and the page says why. **Reset** goes back to the defaults in config.py. The saved values survive a restart.
`,
  },
];

// ------------------------------------------------------------- machinery
const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error("\nERROR: " + msg);
  process.exit(1);
};

function readText(rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  const raw = fs.readFileSync(full, "utf8");
  const crlf = raw.includes("\r\n");
  return { text: raw.replace(/\r\n/g, "\n"), crlf };
}

function indentLines(block, indent) {
  return block
    .split("\n")
    .map((line) => (line.length ? indent + line : line))
    .join("\n");
}

function findOne(text, regex, file, label) {
  const flags = regex.flags.includes("g") ? regex.flags : regex.flags + "g";
  const matches = [...text.matchAll(new RegExp(regex.source, flags))];
  if (matches.length !== 1) {
    fail(
      file + ": expected to find exactly one place for " + label + " but found " + matches.length +
        ".\n  Pattern: " + regex + "\n  The file probably differs from the version this patch was made for." +
        "\n  Nothing was changed."
    );
  }
  return matches[0];
}

function applyEdits(file, steps) {
  const src = readText(file);
  if (!src) fail(file + " was not found in " + root + ". Run this from the project folder.");
  let text = src.text;

  for (const step of steps) {
    if (step.append !== undefined) {
      text = text.replace(/\n*$/, "\n") + step.append;
    } else if (step.replace !== undefined) {
      const first = text.indexOf(step.replace);
      if (first === -1 || text.indexOf(step.replace, first + 1) !== -1) {
        fail(file + ": could not find this text exactly once:\n  " + step.replace + "\n  Nothing was changed.");
      }
      text = text.slice(0, first) + step.with + text.slice(first + step.replace.length);
    } else {
      const regex = step.after || step.before;
      const m = findOne(text, regex, file, step.after ? "an 'after' step" : "a 'before' step");
      const indent = m[1] !== undefined && /^[ \t]*$/.test(m[1]) ? m[1] : "";
      if (step.after) {
        const at = m.index + m[0].length;
        text = text.slice(0, at) + "\n" + indentLines(step.add, indent) + text.slice(at);
      } else if (step.rawAdd !== undefined) {
        text = text.slice(0, m.index) + step.rawAdd + text.slice(m.index);
      } else {
        text = text.slice(0, m.index) + indentLines(step.add, indent) + "\n" + text.slice(m.index);
      }
    }
  }
  return src.crlf ? text.replace(/\n/g, "\r\n") : text;
}

// ------------------------------------------------------------------ main
log("Project folder: " + root);

for (const required of ["app.py", "monitor.py", "config.py", "sensors.py", "templates/index.html", "static/js/app.js"]) {
  if (!fs.existsSync(path.join(root, required))) {
    fail("Cannot find " + required + ". Run this script inside the rain-sound-monitor folder, or pass the folder as an argument.");
  }
}

const monitorNow = readText("monitor.py").text;
const hasNewFiles = fs.existsSync(path.join(root, MARKER_FILE));
const hasMonitorPatch = monitorNow.includes(MARKER_TEXT);
if (hasNewFiles && hasMonitorPatch) {
  log("The calibration patch is already applied. Nothing to do.");
  process.exit(0);
}
if (hasNewFiles || hasMonitorPatch) {
  fail("The patch looks half-applied. Restore the originals first (git checkout . or data/calibration-patch-backup/) and run it again.");
}

// 1. work out every change in memory
const results = {};
for (const [file, steps] of Object.entries(EDITS)) {
  if (file === "README.md" && !fs.existsSync(path.join(root, file))) continue;
  results[file] = applyEdits(file, steps);
}

log("All " + Object.keys(results).length + " files can be patched and " + Object.keys(NEW_FILES).length + " new files will be added.");
if (dryRun) {
  log("Dry run: nothing was written.");
  process.exit(0);
}

// 2. back up the originals
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(root, "data", "calibration-patch-backup", stamp);
for (const file of Object.keys(results)) {
  const dest = path.join(backupDir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, file), dest);
}
log("Originals copied to " + path.relative(root, backupDir));

// 3. write everything
for (const [file, text] of Object.entries(results)) {
  fs.writeFileSync(path.join(root, file), text);
  log("  patched  " + file);
}
for (const [file, text] of Object.entries(NEW_FILES)) {
  const dest = path.join(root, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, text);
  log("  added    " + file);
}

log("\nDone. Restart the app:\n\n  python app.py\n\nThen scroll to the Calibration section at the bottom of the dashboard.");
