"""
The monitor runs in a background thread. Several times a second it:
  1. reads the sensors
  2. decides whether sound / rain counts as "detected"
  3. drives the LED and buzzer
  4. stores one reading per second and logs alert events
The Flask routes only read the latest result from here.
"""

import logging
import threading
import time
from collections import deque

import config
import database
import calibration

log = logging.getLogger("monitor")

LED_MODES = ("auto", "on", "off")


class Monitor:
    def __init__(self, sensors):
        self.sensors = sensors
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._thread = None

        self.settings = database.load_settings()

        # sound detection
        self._recent = deque()            # (time, level) for the last second
        self._sound_hit_at = -1e9
        self._sound_active = False
        # rain detection
        self._rain_hit_at = -1e9
        self._rain_active = False
        # outputs
        self._buzzer_until = 0.0
        self._test_until = 0.0
        self._buzzer_mode = "off"
        self._led_on = False
        # logging
        self._last_log = -1e9
        self._last_prune = time.monotonic()
        # calibration (the Calibrate buttons on the web page)
        self._cal = None                  # the calibration that is recording right now
        self._cal_info = {
            "sound": {"state": "idle", "message": ""},
            "rain": {"state": "idle", "message": ""},
        }
        self._cal_available = {"sound": False, "rain": False}
        self._rain_idx = 0                # rain level number (0 = dry), kept with hysteresis

        self._state = {
            "mode": sensors.mode,
            "sound": {"online": False, "level": None, "detected": False},
            "rain": {"online": False, "detected": False, "moisture": None},
            "led": False,
            "buzzer": False,
            "errors": [],
        }

    # ------------------------------------------------------------ control
    def start(self):
        self._thread = threading.Thread(target=self._run, name="monitor", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        if self._thread is not None and self._thread.is_alive():
            self._thread.join(timeout=2)
        self.sensors.set_buzzer("off")
        self.sensors.set_led(False)
        self.sensors.close()

    def snapshot(self):
        with self._lock:
            state = dict(self._state)
            state["settings"] = dict(self.settings)
            state["calibration"] = self.calibration_status()
        state["time"] = int(time.time())
        return state

    def update_settings(self, patch):
        if not isinstance(patch, dict) or not patch:
            raise ValueError("No settings supplied.")
        clean = {}
        for key, value in patch.items():
            if key == "alerts_enabled":
                if not isinstance(value, bool):
                    raise ValueError("alerts_enabled must be true or false.")
                clean[key] = value
            elif key == "sound_threshold":
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError("sound_threshold must be a number.")
                if not 1 <= value <= 99:
                    raise ValueError("sound_threshold must be between 1 and 99.")
                clean[key] = int(round(value))
            elif key == "led_mode":
                if value not in LED_MODES:
                    raise ValueError("led_mode must be auto, on or off.")
                clean[key] = value
            else:
                raise ValueError("Unknown setting: %s" % key)
        with self._lock:
            self.settings.update(clean)
            merged = dict(self.settings)
        database.save_settings(merged)
        return merged

    def test_buzzer(self):
        self._test_until = time.monotonic() + config.BUZZER_TEST_S

    # -------------------------------------------------------- calibration
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

    # --------------------------------------------------------------- loop
    def _run(self):
        next_tick = time.monotonic()
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("Monitor tick failed")
            next_tick += config.LOOP_INTERVAL_S
            delay = next_tick - time.monotonic()
            if delay < 0:
                next_tick = time.monotonic()
                delay = 0.0
            self._stop.wait(max(delay, 0.01))

    def _tick(self):
        now = time.monotonic()
        wall = time.time()
        raw = self.sensors.read()
        with self._lock:
            settings = dict(self.settings)

        raw = self._calibrate(raw, settings, now)

        # ---- sound --------------------------------------------------
        level = raw["sound_level"]
        if level is not None:
            sound_online = True
            sound_hit = level >= settings["sound_threshold"]
            self._recent.append((now, level))
        elif raw["sound_do"] is not None:
            # No analog value (ADC problem): fall back to the digital pin.
            sound_online = True
            sound_hit = bool(raw["sound_do"])
        else:
            sound_online = False
            sound_hit = False

        while self._recent and now - self._recent[0][0] > 1.0:
            self._recent.popleft()
        shown_level = max((v for _, v in self._recent), default=None)

        if sound_hit:
            self._sound_hit_at = now
        sound_active = sound_hit or (now - self._sound_hit_at < config.SOUND_HOLD_S)

        # ---- rain ---------------------------------------------------
        if raw["rain_do"] is not None:
            rain_online = True
            rain_hit = bool(raw["rain_do"])
        elif raw["moisture"] is not None:
            rain_online = True
            rain_hit = raw["moisture"] >= config.RAIN_ANALOG_THRESHOLD
        else:
            rain_online = False
            rain_hit = False

        if rain_hit:
            self._rain_hit_at = now
        rain_active = rain_hit or (now - self._rain_hit_at < config.RAIN_HOLD_S)
        rain_level = self._rain_level_for(raw["moisture"], rain_active)

        # ---- events (only on a change) -------------------------------
        new_alert = False
        if sound_active and not self._sound_active:
            database.insert_event(wall, "sound", shown_level if shown_level is not None else level)
            new_alert = True
        if rain_active and not self._rain_active:
            database.insert_event(wall, "rain", raw["moisture"])
            new_alert = True
        if self._rain_active and not rain_active:
            database.insert_event(wall, "dry", raw["moisture"])
        self._sound_active = sound_active
        self._rain_active = rain_active
        if new_alert:
            self._buzzer_until = now + config.BUZZER_ALERT_S

        # ---- buzzer and LED -------------------------------------------
        if now < self._test_until:
            buzzer_mode = "on"
        elif settings["alerts_enabled"] and now < self._buzzer_until:
            buzzer_mode = "beep"
        else:
            buzzer_mode = "off"
        if buzzer_mode != self._buzzer_mode:
            self.sensors.set_buzzer(buzzer_mode)
            self._buzzer_mode = buzzer_mode

        if settings["led_mode"] == "on":
            led_on = True
        elif settings["led_mode"] == "off":
            led_on = False
        else:
            led_on = sound_active or rain_active
        if led_on != self._led_on:
            self.sensors.set_led(led_on)
            self._led_on = led_on

        # ---- history (one row per second) -------------------------------
        if now - self._last_log >= 1.0:
            self._last_log = now
            database.insert_reading(wall, shown_level, rain_active, raw["moisture"])
        if now - self._last_prune >= 3600:
            self._last_prune = now
            database.prune()

        # ---- publish the latest state -----------------------------------
        state = {
            "mode": self.sensors.mode,
            "sound": {
                "online": sound_online,
                "level": None if shown_level is None else round(shown_level, 1),
                "detected": sound_active,
            },
            "rain": {
                "online": rain_online,
                "detected": rain_active,
                "level": rain_level,
                "moisture": None if raw["moisture"] is None else round(raw["moisture"], 1),
            },
            "led": led_on,
            "buzzer": buzzer_mode != "off",
            "errors": sorted(set(raw["errors"].values())),
        }
        with self._lock:
            self._state = state
