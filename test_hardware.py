"""
Hardware check - run this on the Raspberry Pi BEFORE starting the website.

    python test_hardware.py

It blinks the LED, beeps the buzzer once, then prints live readings so you can:
  * confirm the ADC and both sensors respond (activity Step 4: troubleshooting)
  * see whether each digital pin goes HIGH or LOW when triggered
    (flip SOUND_DO_ACTIVE_HIGH / RAIN_DO_ACTIVE_HIGH in config.py if reversed)
  * choose SOUND_FULL_SCALE and the RAIN_DRY_RAW / RAIN_WET_RAW numbers

Press Ctrl+C to stop.
"""

import time

from sensors import HardwareSensors, running_on_pi


def fmt(value, width=4):
    return str(value).rjust(width) if value is not None else "n/a".rjust(width)


def level_name(pin_level):
    if pin_level is None:
        return "n/a "
    return "HIGH" if pin_level else "LOW "


def main():
    if not running_on_pi():
        print("This script needs a Raspberry Pi with the sensors connected.")
        print("On a PC, just run: python app.py  (it uses simulated data).")
        return

    sensors = HardwareSensors()
    errors = sensors.read()["errors"]
    if errors:
        print("Problems found:")
        for message in sorted(set(errors.values())):
            print("  - " + message)
        print()

    print("LED on for half a second...")
    sensors.set_led(True)
    time.sleep(0.5)
    sensors.set_led(False)
    print("Buzzer beep...")
    sensors.set_buzzer("on")
    time.sleep(0.3)
    sensors.set_buzzer("off")
    print()
    print("Make some noise and touch the rain sensor with a wet finger.")
    print("Ctrl+C to stop.")
    print()
    print("Sound swing (0-1023) | Sound pin  | Rain ADC (0-1023) | Rain pin")
    print("-" * 66)

    try:
        while True:
            raw = sensors.read_raw()
            swing = None
            if raw["sound_lo"] is not None:
                swing = raw["sound_hi"] - raw["sound_lo"]
            line = "%s           | %s (%s) | %s              | %s (%s)" % (
                fmt(swing),
                level_name(raw["sound_pin"]),
                "active" if raw["sound_do"] else "idle  ",
                fmt(None if raw["rain_raw"] is None else int(raw["rain_raw"])),
                level_name(raw["rain_pin"]),
                "active" if raw["rain_do"] else "idle  ",
            )
            print(line)
            time.sleep(0.4)
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        sensors.close()


if __name__ == "__main__":
    main()
