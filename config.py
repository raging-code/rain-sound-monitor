"""
Settings for the Sound and Raindrop monitor.

Everything you might need to change lives in this file.
Pin numbers are BCM (GPIO) numbers, NOT physical header pin numbers.
"""

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "monitor.db"

# --------------------------------------------------------------------------
# Run mode
#   "auto"     -> real sensors on a Raspberry Pi, simulated data on a PC
#   "hardware" -> always use real sensors
#   "mock"     -> always use simulated data
# You can also set it per run:  SENSOR_MODE=mock python app.py
# --------------------------------------------------------------------------
SENSOR_MODE = os.environ.get("SENSOR_MODE", "auto").strip().lower()

HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "5000"))

# --------------------------------------------------------------------------
# Wiring (BCM numbers)
# --------------------------------------------------------------------------
SOUND_DO_PIN = 17   # sound sensor digital output  -> GPIO 17 (physical pin 11)
RAIN_DO_PIN = 27    # raindrop sensor digital output -> GPIO 27 (physical pin 13)
LED_PIN = 23        # LED (through a 330 ohm resistor) -> GPIO 23 (physical pin 16)
BUZZER_PIN = 24     # active buzzer -> GPIO 24 (physical pin 18)

# MCP3008 ADC on SPI0 / CE0 (SCLK=GPIO11, MOSI=GPIO10, MISO=GPIO9, CE0=GPIO8)
SPI_BUS = 0
SPI_DEVICE = 0
SOUND_ADC_CHANNEL = 0        # sound sensor AO -> MCP3008 CH0
RAIN_ADC_CHANNEL = 1         # raindrop sensor AO -> MCP3008 CH1 (set to None if not wired)

# --------------------------------------------------------------------------
# Signal polarity
# Different modules behave differently. Run  python test_hardware.py  to see
# what YOUR modules do, then flip these if the result is reversed.
# --------------------------------------------------------------------------
SOUND_DO_ACTIVE_HIGH = True    # KY-037: DO goes HIGH when sound passes the threshold
RAIN_DO_ACTIVE_HIGH = False    # YL-83 / FC-37: DO usually goes LOW when wet
BUZZER_ACTIVE_HIGH = True      # set False for "low level trigger" buzzer modules

# --------------------------------------------------------------------------
# Calibration
# --------------------------------------------------------------------------
# Sound: the microphone output swings up and down, so we measure the size of
# the swing (peak-to-peak, 0-1023) over a short window and convert it to 0-100.
# A peak-to-peak swing of SOUND_FULL_SCALE counts or more shows as 100.
# Lower it if the dashboard barely moves when you clap; raise it if it pegs at 100.
SOUND_FULL_SCALE = 300
SOUND_WINDOW_S = 0.05          # how long each sound sample window lasts

# Rain: AO is high when dry and drops when wet.
RAIN_DRY_RAW = 1000            # ADC reading of the dry sensor  -> 0 % moisture
RAIN_WET_RAW = 300             # ADC reading of a fully wet sensor -> 100 % moisture
RAIN_ANALOG_THRESHOLD = 40     # only used if the rain digital pin is unavailable

# --------------------------------------------------------------------------
# Behaviour
# --------------------------------------------------------------------------
LOOP_INTERVAL_S = 0.2          # sensor loop speed (5 times per second)
SOUND_HOLD_S = 1.5             # keep "sound detected" this long after the last loud sample
RAIN_HOLD_S = 3.0              # keep "raining" this long after the sensor dries (debounce)
BUZZER_ALERT_S = 3.0           # how long the buzzer beeps for each new alert
BUZZER_TEST_S = 0.5            # length of the "Test buzzer" beep

ADC_FAULT_LIMIT = 10           # this many dead ADC readings in a row -> "ADC not responding"

# Defaults for the controls on the web page (saved in the database once changed)
DEFAULT_SETTINGS = {
    "alerts_enabled": True,    # buzzer on/off
    "sound_threshold": 40,     # 1-99, percent
    "led_mode": "auto",        # "auto", "on" or "off"
}

# Stored history
HISTORY_RETENTION_DAYS = 7
# range name -> (how far back in seconds, bucket size in seconds)
HISTORY_RANGES = {
    "live": (120, 1),
    "1h": (3600, 20),
    "24h": (86400, 300),
}
