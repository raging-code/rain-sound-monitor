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
                "moisture": None if raw["moisture"] is None else round(raw["moisture"], 1),
            },
            "led": led_on,
            "buzzer": buzzer_mode != "off",
            "errors": sorted(set(raw["errors"].values())),
        }
        with self._lock:
            self._state = state
