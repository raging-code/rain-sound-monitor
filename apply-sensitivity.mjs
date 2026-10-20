#!/usr/bin/env node
/**
 * apply-sensitivity.mjs
 *
 * Adds a "Sound: sensitivity" slider to the Calibration section of the
 * rain-sound-monitor website. It decides how easily a sound counts as loud.
 *
 *   Slider to the right  -> more sensitive: quieter sounds read higher and
 *                           trigger "Loud" sooner.
 *   Slider to the left   -> less sensitive: only big sounds trigger "Loud".
 *   Middle (50)          -> exactly the SOUND_FULL_SCALE from config.py.
 *
 * Under the hood the slider scales the swing that counts as 100 % (from 4x
 * more sensitive to 4x less). The existing "Sound threshold" slider in
 * Controls still sets the percentage that counts as loud, so the two work
 * together. The value is saved and survives a restart.
 *
 * Needs the calibration patch (apply-calibration.mjs) to be applied first.
 *
 * Usage (run it inside the project folder):
 *
 *   node apply-sensitivity.mjs            apply the patch
 *   node apply-sensitivity.mjs --dry-run  only check, change nothing
 *   node apply-sensitivity.mjs <folder>   patch a folder other than the current one
 *
 * Safe to run twice: it detects that the patch is already applied.
 * Nothing is written unless every change can be made, and the original
 * files are copied to data/sensitivity-patch-backup/ first.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------- options
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const folderArg = args.find((a) => !a.startsWith("--"));
const root = path.resolve(folderArg || process.cwd());

// One marker per patched file. All present = already applied.
const MARKERS = {
  "config.py": "sound_sensitivity",
  "calibration.py": "effective_full_scale",
  "monitor.py": "_sound_full_scale",
  "templates/index.html": "cal-sensitivity",
  "static/js/calibration.js": "renderSensitivity",
  "static/css/calibration.css": ".cal-sens",
};

const EDITS = {};

// ------------------------------------------------------------- config.py
EDITS["config.py"] = [
  {
    after: /^SOUND_WINDOW_S = .*$/m,
    add: String.raw`
# Sensitivity slider (Calibration section of the web page): 1-100, 50 = SOUND_FULL_SCALE as is.
# At 100 the sensor reacts this many times more easily, at 0 this many times less easily.
SOUND_SENSITIVITY_MAX_GAIN = 4.0
SOUND_MIN_SPAN = 10            # the 100 % level always stays at least this far above the quiet level`,
  },
  {
    after: /^([ \t]+)"sound_threshold": 40,.*$/m,
    add: '"sound_sensitivity": 50,   # 1-100, 50 = use SOUND_FULL_SCALE as it is',
  },
];

// -------------------------------------------------------- calibration.py
EDITS["calibration.py"] = [
  {
    append: String.raw`

def effective_full_scale(full_scale, sensitivity, baseline=0.0, max_gain=4.0, min_span=10.0):
    """Swing (ADC counts) that reads 100 %, after the sensitivity setting.

    sensitivity runs from 0 to 100 and 50 keeps full_scale as it is. Moving it
    up makes the sensor react to quieter sounds (up to max_gain times more
    easily at 100); moving it down makes it react less (up to max_gain times
    less easily at 0). The result stays at least min_span counts above the
    quiet level and never goes past the largest possible swing (1023).
    """
    try:
        level = float(sensitivity)
    except (TypeError, ValueError):
        level = 50.0
    level = max(0.0, min(100.0, level))
    gain = float(max_gain) ** ((level - 50.0) / 50.0)
    scaled = max(float(full_scale) / gain, float(baseline) + float(min_span))
    return min(scaled, 1023.0)
`,
  },
];

// ------------------------------------------------------------ monitor.py
EDITS["monitor.py"] = [
  {
    // accept and validate the new setting
    before: /^([ \t]+)elif key == "led_mode":[ \t]*$/m,
    add: String.raw`elif key == "sound_sensitivity":
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("sound_sensitivity must be a number.")
    if not 1 <= value <= 100:
        raise ValueError("sound_sensitivity must be between 1 and 100.")
    clean[key] = int(round(value))`,
  },
  {
    // helper used by the live readings and by the status shown on the page
    before: /^([ \t]+)def _calibrate\(self, raw, settings, now\):[ \t]*$/m,
    add: String.raw`def _sound_full_scale(self, settings):
    """Swing (ADC counts) that reads 100 %, after the sensitivity slider."""
    return calibration.effective_full_scale(
        config.SOUND_FULL_SCALE,
        settings.get("sound_sensitivity"),
        settings.get("sound_baseline") or 0.0,
        config.SOUND_SENSITIVITY_MAX_GAIN,
        config.SOUND_MIN_SPAN,
    )
`,
  },
  {
    // live sound percentage now uses the adjusted full scale
    replace: 'swing, settings.get("sound_baseline") or 0.0, config.SOUND_FULL_SCALE',
    with: 'swing, settings.get("sound_baseline") or 0.0, self._sound_full_scale(settings)',
  },
  {
    // report the sensitivity and where "loud" starts to the page
    replace: 'out["sound"]["full_scale"] = config.SOUND_FULL_SCALE',
    with: [
      'baseline = self.settings.get("sound_baseline") or 0.0',
      '            full_scale = self._sound_full_scale(self.settings)',
      '            out["sound"]["full_scale"] = round(full_scale)',
      '            out["sound"]["sensitivity"] = int(self.settings.get("sound_sensitivity", 50))',
      '            out["sound"]["default_sensitivity"] = config.DEFAULT_SETTINGS["sound_sensitivity"]',
      '            out["sound"]["loud_swing"] = round(',
      '                baseline + self.settings["sound_threshold"] / 100.0 * (full_scale - baseline)',
      '            )',
    ].join("\n"),
  },
];

// -------------------------------------------------------- templates/index.html
EDITS["templates/index.html"] = [
  {
    replace: '      </div>\n      <p class="cal-levels" id="cal-levels"></p>',
    with: String.raw`
        <div class="cal-card cal-sens" id="cal-sensitivity" data-state="idle">
          <div class="cal-head">
            <h3 id="sens-title">Sound: sensitivity</h3>
            <output id="sensitivity-out" for="sensitivity">50</output>
          </div>
          <p class="cal-help">Decide how easily a sound counts as loud. Move right if clapping or talking is not picked up. Move left if everyday noise sets it off.</p>
          <div class="sens-control">
            <input type="range" id="sensitivity" min="1" max="100" step="1" value="50" aria-labelledby="sens-title" aria-describedby="sens-note">
            <div class="sens-ends" aria-hidden="true"><span>Less sensitive</span><span>More sensitive</span></div>
          </div>
          <p class="cal-status" id="sens-status" role="status" aria-live="polite"></p>
          <p class="cal-saved" id="sens-note"></p>
          <div class="cal-actions">
            <button type="button" id="sens-reset">Reset</button>
          </div>
        </div>
      </div>
      <p class="cal-levels" id="cal-levels"></p>`,
  },
];

// -------------------------------------------------- static/js/calibration.js
EDITS["static/js/calibration.js"] = [
  {
    // every calibration refresh also refreshes the sensitivity card
    replace: "    running = status.running;\n",
    with: "    running = status.running;\n    renderSensitivity(status.sound);\n",
  },
  {
    replace: "  poll();\n})();",
    with: String.raw`  // ---- Sound sensitivity: how easily a sound counts as loud ----------
  const sens = {
    card: document.getElementById("cal-sensitivity"),
    slider: document.getElementById("sensitivity"),
    out: document.getElementById("sensitivity-out"),
    note: document.getElementById("sens-note"),
    status: document.getElementById("sens-status"),
    reset: document.getElementById("sens-reset"),
  };
  const SENS_GRACE_MS = 2000;
  let sensHolding = false;
  let sensTouched = 0;
  let sensDefault = 50;

  function renderSensitivity(data) {
    if (!sens.slider || !data || data.sensitivity == null) return;
    sensDefault = data.default_sensitivity || 50;
    // Do not move the slider while the person is using it.
    if (!sensHolding && Date.now() - sensTouched > SENS_GRACE_MS) {
      sens.slider.value = data.sensitivity;
      sens.out.textContent = String(data.sensitivity);
    }
    sens.reset.disabled = data.sensitivity === sensDefault && !sensHolding;
    sens.note.textContent =
      "A sound counts as loud from a swing of about " + Math.round(data.loud_swing) +
      ". A swing of " + Math.round(data.full_scale) + " reads 100 %.";
  }

  async function saveSensitivity(value) {
    sensTouched = Date.now();
    try {
      await request("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sound_sensitivity: value }),
      });
      sens.card.dataset.state = "done";
      sens.status.textContent = "Saved.";
    } catch (err) {
      sensTouched = 0; // let the next refresh show what the server really has
      sens.card.dataset.state = "failed";
      sens.status.textContent = err.message;
    }
    poll();
  }

  if (sens.slider) {
    sens.slider.addEventListener("pointerdown", () => {
      sensHolding = true;
    });
    window.addEventListener("pointerup", () => {
      if (sensHolding) sensTouched = Date.now();
      sensHolding = false;
    });
    window.addEventListener("pointercancel", () => {
      sensHolding = false;
    });
    sens.slider.addEventListener("input", () => {
      sensTouched = Date.now();
      sens.out.textContent = sens.slider.value;
      sens.card.dataset.state = "idle";
      sens.status.textContent = "";
    });
    sens.slider.addEventListener("change", () => {
      saveSensitivity(Number(sens.slider.value));
    });
    sens.reset.addEventListener("click", () => {
      sens.slider.value = sensDefault;
      sens.out.textContent = String(sensDefault);
      saveSensitivity(sensDefault);
    });
  }

  poll();
})();`,
  },
];

// -------------------------------------------------- static/css/calibration.css
EDITS["static/css/calibration.css"] = [
  {
    append: String.raw`
/* Sound sensitivity card */
.cal-sens {
  grid-column: 1 / -1;
}

.cal-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.cal-head output {
  font-size: 1.1rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.sens-control {
  max-width: 720px;
}

.sens-ends {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  color: var(--slate);
  font-size: 0.95rem;
}
`,
  },
];

// ------------------------------------------------------------- README.md
EDITS["README.md"] = [
  {
    append: String.raw`

## 10. Sound sensitivity

The **Sound: sensitivity** slider in the Calibration section decides how easily a sound counts as loud.

- Move it **right** if claps or speech are not picked up (quieter sounds read higher and trigger "Loud" sooner).
- Move it **left** if everyday noise keeps setting it off.
- **Reset** goes back to the middle (50), which uses SOUND_FULL_SCALE from config.py as it is.

The text under the slider shows the sound swing where "Loud" starts and the swing that reads 100 %. The slider works together with **Calibrate sound** (the quiet level stays at 0 %) and with the **Sound threshold** slider in Controls (the percentage that counts as loud). The range of the slider is set by SOUND_SENSITIVITY_MAX_GAIN in config.py (default 4, meaning from 4 times less to 4 times more sensitive). The setting is saved and survives a restart.
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
      } else {
        text = text.slice(0, m.index) + indentLines(step.add, indent) + "\n" + text.slice(m.index);
      }
    }
  }
  return src.crlf ? text.replace(/\n/g, "\r\n") : text;
}

// ------------------------------------------------------------------ main
log("Project folder: " + root);

for (const required of ["app.py", "monitor.py", "config.py", "calibration.py", "templates/index.html", "static/js/calibration.js", "static/css/calibration.css"]) {
  if (!fs.existsSync(path.join(root, required))) {
    fail(
      "Cannot find " + required + ". Run this script inside the rain-sound-monitor folder, or pass the folder as an argument." +
        (required.includes("calibration") ? "\n  The calibration patch (apply-calibration.mjs) must be applied first." : "")
    );
  }
}

const applied = Object.entries(MARKERS).filter(([file, marker]) => readText(file).text.includes(marker));
if (applied.length === Object.keys(MARKERS).length) {
  log("The sensitivity patch is already applied. Nothing to do.");
  process.exit(0);
}
if (applied.length > 0) {
  fail(
    "The patch looks half-applied (found it in: " + applied.map(([f]) => f).join(", ") +
      "). Restore the originals first (git checkout . or data/sensitivity-patch-backup/) and run it again."
  );
}

// 1. work out every change in memory
const results = {};
for (const [file, steps] of Object.entries(EDITS)) {
  if (file === "README.md" && !fs.existsSync(path.join(root, file))) continue;
  results[file] = applyEdits(file, steps);
}

log("All " + Object.keys(results).length + " files can be patched.");
if (dryRun) {
  log("Dry run: nothing was written.");
  process.exit(0);
}

// 2. back up the originals
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = path.join(root, "data", "sensitivity-patch-backup", stamp);
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

log("\nDone. Restart the app:\n\n  python app.py\n\nThen scroll to the Calibration section and use the new Sound: sensitivity slider.");
