"""
Sensor back ends.

HardwareSensors - real KY-037, YL-83, ADS1115 (I2C), LED and buzzer on a Raspberry Pi

MockSensors - simulated data so the website can be tested on a PC

Both classes offer the same methods:

read() -> dict of the latest readings

set_led(bool)

set_buzzer("off" | "on" | "beep")

close()

ADS1115 version: the ADS1115 is read over I2C with smbus2 and its 16-bit
result is scaled to 0-1023, so config.py and test_hardware.py keep working
with the same numbers as before.
"""

import logging

import random

import statistics

import threading

import time

from pathlib import Path

import config

log = logging.getLogger("sensors")

# ADS1115 settings (you can override any of these in config.py)
I2C_BUS = getattr(config, "I2C_BUS", 1)
ADS_ADDRESS = getattr(config, "ADS_ADDRESS", 0x48)
ADS_SUPPLY_V = getattr(config, "ADS_SUPPLY_V", 3.3)  # sensors are powered from 3.3 V

_ADS_REG_CONVERSION = 0x00
_ADS_REG_CONFIG = 0x01


def running_on_pi():

    try:

        model = Path("/proc/device-tree/model").read_text(errors="ignore")

    except OSError:

        return False

    return "raspberry pi" in model.lower()


def _clamp(value, low=0.0, high=100.0):

    return max(low, min(high, value))


# ======================================================================
# Simulator (PC testing)
# ======================================================================


class MockSensors:

    mode = "mock"

    def __init__(self):

        self._lock = threading.Lock()

        self._clap_until = 0.0

        self._rain_until = 0.0

        self._level = 6.0

        self._moisture = 1.0

        self.led = False

        self.buzzer_mode = "off"

    def trigger(self, action):

        now = time.monotonic()

        with self._lock:

            if action == "clap":

                self._clap_until = now + 1.2

            elif action == "rain":

                self._rain_until = now + 8.0

            else:

                raise ValueError("Unknown simulation action.")

    def read(self):

        now = time.monotonic()

        with self._lock:

            clap = now < self._clap_until

            raining = now < self._rain_until

            target = random.uniform(62, 96) if clap else random.uniform(3, 12)

            self._level += (target - self._level) * 0.7

            target_m = random.uniform(62, 78) if raining else random.uniform(0, 2)

            self._moisture += (target_m - self._moisture) * (0.3 if raining else 0.15)

            return {

                "sound_level": _clamp(self._level),

                "sound_do": self._level >= 50,

                "rain_do": self._moisture >= 35,

                "moisture": _clamp(self._moisture),

                "sound_swing": _clamp(self._level) / 100.0 * config.SOUND_FULL_SCALE,
                "rain_raw": config.RAIN_DRY_RAW
                - _clamp(self._moisture) / 100.0 * (config.RAIN_DRY_RAW - config.RAIN_WET_RAW),
                "errors": {},

            }

    def set_led(self, on):

        self.led = bool(on)

    def set_buzzer(self, mode):

        self.buzzer_mode = mode

    def close(self):

        pass


# ======================================================================
# Real hardware (Raspberry Pi)
# ======================================================================


class HardwareSensors:

    mode = "hardware"

    def __init__(self):

        self._errors = {}

        self._bus = None  # I2C bus to the ADS1115

        self._sound_do = None

        self._rain_do = None

        self._led = None

        self._buzzer = None

        self._adc_faults = 0

        self._adc_retry_at = 0.0

        self._open_gpio()

        self._open_adc()

    # ------------------------------------------------------------ setup

    def _try(self, key, message, factory):

        try:

            device = factory()

        except Exception as exc:  # pragma: no cover - needs real hardware

            log.error("%s (%s)", message, exc)

            self._errors[key] = message

            return None

        self._errors.pop(key, None)

        return device

    def _open_gpio(self):

        try:

            from gpiozero import LED, Buzzer, DigitalInputDevice

        except Exception as exc:

            log.error("gpiozero is not available: %s", exc)

            self._errors["gpio"] = "GPIO library missing. Run: sudo apt install python3-gpiozero"

            return

        self._sound_do = self._try(

            "sound_do",

            "Sound sensor pin unavailable.",

            lambda: DigitalInputDevice(

                config.SOUND_DO_PIN, pull_up=not config.SOUND_DO_ACTIVE_HIGH

            ),

        )

        self._rain_do = self._try(

            "rain_do",

            "Rain sensor pin unavailable.",

            lambda: DigitalInputDevice(

                config.RAIN_DO_PIN, pull_up=not config.RAIN_DO_ACTIVE_HIGH

            ),

        )

        self._led = self._try(

            "led",

            "LED pin unavailable.",

            lambda: LED(config.LED_PIN, initial_value=False),

        )

        self._buzzer = self._try(

            "buzzer",

            "Buzzer pin unavailable.",

            lambda: Buzzer(

                config.BUZZER_PIN,

                active_high=config.BUZZER_ACTIVE_HIGH,

                initial_value=False,

            ),

        )

    def _open_adc(self):

        try:

            from smbus2 import SMBus

            bus = SMBus(I2C_BUS)

            # Talk to the chip once: raises OSError if the ADS1115 is not wired.
            bus.read_i2c_block_data(ADS_ADDRESS, _ADS_REG_CONFIG, 2)

        except Exception as exc:

            if "adc" not in self._errors:  # log once, not on every retry

                log.error("Could not open the ADS1115 (I2C): %s", exc)

            self._bus = None

            self._errors["adc"] = (
                "ADS1115 not found. Enable I2C, run 'pip install smbus2' "
                "and check SDA, SCL, power and ADDR."
            )

            return

        self._bus = bus

        self._adc_faults = 0

        self._errors.pop("adc", None)

    def _close_adc(self):

        if self._bus is not None:

            try:

                self._bus.close()

            except Exception:

                pass

        self._bus = None

    # ----------------------------------------------------------- reading

    def _read_channel(self, channel):

        """One reading from the ADS1115, scaled to 0-1023 (0 V to 3.3 V)."""

        # Config: start single conversion, single-ended input A<channel>,
        # +/-4.096 V range, single-shot mode, 860 samples/s, comparator off.
        config_word = (
            0x8000 | (0x4000 + (channel << 12)) | 0x0200 | 0x0100 | 0x00E0 | 0x0003
        )

        self._bus.write_i2c_block_data(
            ADS_ADDRESS, _ADS_REG_CONFIG, [(config_word >> 8) & 0xFF, config_word & 0xFF]
        )

        # Wait for the conversion to finish (about 1.2 ms at 860 samples/s).
        deadline = time.perf_counter() + 0.05

        while True:

            status = self._bus.read_i2c_block_data(ADS_ADDRESS, _ADS_REG_CONFIG, 2)

            if status[0] & 0x80:

                break

            if time.perf_counter() > deadline:

                raise OSError("ADS1115 conversion timed out")

        data = self._bus.read_i2c_block_data(ADS_ADDRESS, _ADS_REG_CONVERSION, 2)

        raw = (data[0] << 8) | data[1]

        if raw & 0x8000:  # negative number

            raw -= 0x10000

        volts = raw * 4.096 / 32768.0

        return int(round(_clamp(volts / ADS_SUPPLY_V * 1023.0, 0, 1023)))

    def _sample_sound(self):

        """Lowest and highest reading over a short window (the microphone swings)."""

        end = time.perf_counter() + config.SOUND_WINDOW_S

        low, high = 1023, 0

        while True:

            value = self._read_channel(config.SOUND_ADC_CHANNEL)

            if value < low:

                low = value

            if value > high:

                high = value

            if time.perf_counter() >= end:

                break

        return low, high

    def _read_rain(self):

        samples = [self._read_channel(config.RAIN_ADC_CHANNEL) for _ in range(3)]

        return statistics.median(samples)

    @staticmethod
    def _pin_level(device):

        try:

            return int(device.pin.state)

        except Exception:

            return None

    def read_raw(self):

        """Raw numbers, used by test_hardware.py. Never raises."""

        raw = {

            "sound_lo": None,

            "sound_hi": None,

            "rain_raw": None,

            "sound_do": None,

            "rain_do": None,

            "sound_pin": None,

            "rain_pin": None,

        }

        if self._bus is None and time.monotonic() >= self._adc_retry_at:

            self._adc_retry_at = time.monotonic() + 5.0

            self._open_adc()

        if self._bus is not None:

            try:

                raw["sound_lo"], raw["sound_hi"] = self._sample_sound()

                if config.RAIN_ADC_CHANNEL is not None:

                    raw["rain_raw"] = self._read_rain()

            except Exception as exc:

                log.error("ADC read failed: %s", exc)

                self._close_adc()

                self._errors["adc"] = "ADS1115 read failed. Check the I2C wiring."

                raw["sound_lo"] = raw["sound_hi"] = raw["rain_raw"] = None

        if self._sound_do is not None:

            try:

                raw["sound_do"] = bool(self._sound_do.is_active)

                raw["sound_pin"] = self._pin_level(self._sound_do)

            except Exception as exc:

                log.error("Sound pin read failed: %s", exc)

        if self._rain_do is not None:

            try:

                raw["rain_do"] = bool(self._rain_do.is_active)

                raw["rain_pin"] = self._pin_level(self._rain_do)

            except Exception as exc:

                log.error("Rain pin read failed: %s", exc)

        return raw

    def read(self):

        raw = self.read_raw()

        sound_level = None
        sound_swing = None

        moisture = None

        if raw["sound_lo"] is not None:

            low, high = raw["sound_lo"], raw["sound_hi"]

            # A disconnected or unpowered ADC returns all zeros or all 1023s.

            dead = low == high and low in (0, 1023)

            self._adc_faults = self._adc_faults + 1 if dead else 0

            if self._adc_faults >= config.ADC_FAULT_LIMIT:

                self._errors["adc"] = "ADC not responding. Check I2C wiring and power."

            else:

                self._errors.pop("adc", None)

            sound_level = _clamp((high - low) / config.SOUND_FULL_SCALE * 100.0)
            sound_swing = high - low

        if raw["rain_raw"] is not None:

            span = max(1, config.RAIN_DRY_RAW - config.RAIN_WET_RAW)

            moisture = _clamp((config.RAIN_DRY_RAW - raw["rain_raw"]) / span * 100.0)

        return {

            "sound_level": sound_level,
            "sound_swing": sound_swing,
            "rain_raw": raw["rain_raw"],

            "sound_do": raw["sound_do"],

            "rain_do": raw["rain_do"],

            "moisture": moisture,

            "errors": dict(self._errors),

        }

    # ----------------------------------------------------------- outputs

    def set_led(self, on):

        if self._led is None:

            return

        try:

            self._led.on() if on else self._led.off()

        except Exception as exc:

            log.error("LED write failed: %s", exc)

    def set_buzzer(self, mode):

        if self._buzzer is None:

            return

        try:

            if mode == "on":

                self._buzzer.on()

            elif mode == "beep":

                self._buzzer.beep(on_time=0.2, off_time=0.2, background=True)

            else:

                self._buzzer.off()

        except Exception as exc:

            log.error("Buzzer write failed: %s", exc)

    def close(self):

        for device in (self._led, self._buzzer):

            if device is not None:

                try:

                    device.off()

                except Exception:

                    pass

        for device in (self._sound_do, self._rain_do, self._led, self._buzzer):

            if device is not None:

                try:

                    device.close()

                except Exception:

                    pass

        self._close_adc()


def create_sensors():

    mode = config.SENSOR_MODE

    if mode not in ("auto", "hardware", "mock"):

        raise ValueError('SENSOR_MODE must be "auto", "hardware" or "mock".')

    if mode == "auto":

        mode = "hardware" if running_on_pi() else "mock"

    if mode == "hardware":

        return HardwareSensors()

    return MockSensors()
