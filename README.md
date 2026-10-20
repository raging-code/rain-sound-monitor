# Sound and Raindrop Monitor (Activity 5)

A Raspberry Pi environment monitor. It reads a **KY-037 sound sensor** and a **YL-83 raindrop sensor**, shows the readings live on a **Flask web dashboard**, drives an **LED** and **buzzer**, and graphs the history.

```
sound-rain-monitor/
  app.py              web server and API  (run this)
  monitor.py          background loop: thresholds, alerts, LED, buzzer, logging
  sensors.py          real hardware (Pi) and simulated sensors (PC)
  database.py         SQLite history, events and saved settings
  config.py           pins, polarity, calibration  (the only file you may need to edit)
  test_hardware.py    wiring and calibration check (Pi only)
  templates/ static/  the dashboard (Chart.js and the font are bundled, so it works offline)
```

## 1. Test on your PC first (Windows, VS Code)

Open the `sound-rain-monitor` folder in VS Code, open a terminal (PowerShell) and run:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

If PowerShell blocks the activate script, run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` and try again.

Open <http://localhost:5000>. On a PC the app uses **simulated sensors** (the header says "Simulated data"), and two extra buttons appear: **Simulate clap** and **Simulate rain**. Use them to try the alerts, graphs and controls before you touch any wires.

In VS Code you can also press F5 and pick "Dashboard (simulated data)".

## 2. Run it on the Raspberry Pi

Copy the folder to the Pi (USB drive, `scp`, or git), then in a terminal on the Pi:

```bash
sudo apt update
sudo apt install -y python3-gpiozero python3-lgpio python3-spidev python3-venv
sudo raspi-config nonint do_spi 0        # turns SPI on (needed for the ADC)
cd sound-rain-monitor
python3 -m venv --system-site-packages .venv
source .venv/bin/activate
pip install -r requirements.txt
python test_hardware.py                  # check the wiring first (section 4)
python app.py
```

Notes:
- `--system-site-packages` lets the virtual environment see the apt packages (gpiozero, spidev).
- On older Raspberry Pi OS (Bullseye) install `python3-rpi.gpio` instead of `python3-lgpio`.
- If SPI was just enabled and `ls /dev/spidev0.0` shows nothing, reboot once.
- On the Pi, `SENSOR_MODE=auto` picks the **real sensors** automatically. To force a mode: `SENSOR_MODE=mock python app.py` or `SENSOR_MODE=hardware python app.py`.

Open the dashboard on the Pi at <http://localhost:5000>, or from your PC or phone on the same network at `http://raspberrypi.local:5000` (or `http://<pi-ip>:5000`; find the IP with `hostname -I`).

If the Pi has no internet, its clock may be wrong. Set it with `sudo date -s "2026-10-19 14:30"` before you start, so the graphs show the right times.

## 3. Wiring

Use **3.3 V** for everything. The Pi's GPIO pins are not 5 V tolerant, and the sensor modules also work at 3.3 V. (The lab sheet says 5 V, but a 5 V digital output can damage a Pi pin.) Connect the Pi's 3.3 V and GND to the breadboard rails first.

All pin numbers below are **BCM (GPIO) numbers**, with the physical header pin in brackets.

| Part | Connects to |
|---|---|
| Sound sensor VCC / GND | 3.3 V (pin 1) / GND (pin 6) |
| Sound sensor **DO** | GPIO 17 (pin 11) |
| Sound sensor **AO** | MCP3008 **CH0** (chip pin 1) |
| Raindrop module VCC / GND | 3.3 V / GND |
| Raindrop module **DO** | GPIO 27 (pin 13) |
| Raindrop module **AO** | MCP3008 **CH1** (chip pin 2) |
| LED (long leg) via 330 ohm resistor | GPIO 23 (pin 16); short leg to GND |
| Active buzzer **+** / **-** | GPIO 24 (pin 18) / GND |

The raindrop module has two parts: the grid pad and a small control board. Connect the pad to the control board with its two-wire cable, and wire the control board to the Pi.

**MCP3008 ADC** (16 pins, notch at the top, pin 1 at the top left):

| MCP3008 pin | Name | Connects to |
|---|---|---|
| 1 | CH0 | Sound sensor AO |
| 2 | CH1 | Raindrop module AO |
| 9 | DGND | GND |
| 10 | CS | GPIO 8 / CE0 (pin 24) |
| 11 | DIN | GPIO 10 / MOSI (pin 19) |
| 12 | DOUT | GPIO 9 / MISO (pin 21) |
| 13 | CLK | GPIO 11 / SCLK (pin 23) |
| 14 | AGND | GND |
| 15 | VREF | 3.3 V |
| 16 | VDD | 3.3 V |

Buzzer: use an **active** buzzer (it beeps by itself when powered). A small one can run straight from the GPIO pin; a loud or high-current one needs a transistor. If your buzzer module is silent when it should beep and beeps when idle, it is "low level trigger": set `BUZZER_ACTIVE_HIGH = False` in `config.py`.

If you do not wire the rain AO pin, set `RAIN_ADC_CHANNEL = None` in `config.py`. Rain detection still works from the digital pin; you just lose the moisture percentage.

## 4. Check the hardware (Pi only)

```bash
python test_hardware.py
```

It blinks the LED, beeps the buzzer, then prints live readings. Clap near the sound sensor and touch the rain pad with a wet finger.

- **Everything shows `n/a`, or "ADC unavailable"**: SPI is off or the MCP3008 wiring is wrong (section 6).
- **Digital pin reversed** (it says "active" while it is quiet or dry): flip `SOUND_DO_ACTIVE_HIGH` or `RAIN_DO_ACTIVE_HIGH` in `config.py`. Most YL-83 modules pull DO **low** when wet, so the default for rain is `False`.
- **Sound swing too small or always maxed**: the dashboard shows the sound swing as a percentage of `SOUND_FULL_SCALE`. If the biggest swing you see when you clap is about 60, set `SOUND_FULL_SCALE = 80` so a clap reads close to 100 %. Turn the small screw on the sound module to change its sensitivity.
- **Moisture numbers**: note the "Rain ADC" value with a dry pad and with a wet pad, then set `RAIN_DRY_RAW` and `RAIN_WET_RAW` to those two numbers.

Press Ctrl+C to stop, then start `python app.py`.

## 5. Using the dashboard

- **Sound** shows the loudness from 0 to 100 and turns orange when it passes the threshold. The small tick on the bar is the threshold.
- **Rain** shows Dry or Raining plus the moisture percentage, and turns blue when it rains.
- **Graphs** show sound level (with the threshold as a dashed line) and rain over time. Switch between Live (last 2 minutes), 1 hour and 24 hours. Download CSV saves the last 24 hours.
- **Buzzer alerts** turns the buzzer on or off. The buzzer beeps for 3 seconds each time a new sound or rain alert starts.
- **Sound threshold** sets how loud a sound must be to count. It is saved, so it survives a restart.
- **LED** is Auto (lights while sound or rain is detected), On or Off.
- **Test buzzer** gives one short beep.
- **Recent events** lists when sound and rain alerts started and when rain stopped.
- The small dots next to Buzzer alerts and LED light up when those outputs are on.

## 6. Troubleshooting (lab sheet, Step 4)

| Problem | What to check |
|---|---|
| Header shows "Check sensors" and a red message | The message names the problem. |
| "ADC unavailable. Enable SPI..." | Run `sudo raspi-config nonint do_spi 0` and reboot. Check that `/dev/spidev0.0` exists. |
| "ADC not responding..." | MCP3008 power: VDD and VREF to 3.3 V, both grounds to GND, and CLK, DIN, DOUT, CS on the right pins. A loose breadboard wire is the usual cause. |
| "GPIO library missing" | `sudo apt install python3-gpiozero python3-lgpio` and recreate the venv with `--system-site-packages`. |
| Sound or rain stuck on "Offline" | Run `python test_hardware.py` and look for `n/a`. |
| Rain says Raining while dry (or the reverse) | Flip `RAIN_DO_ACTIVE_HIGH` in `config.py`, or turn the module's potentiometer. |
| Sound reacts too much or too little | Change the **Sound threshold** slider first, then `SOUND_FULL_SCALE`. |
| Pin numbers do not match | `config.py` uses BCM numbers (GPIO 17), not header pin numbers (pin 11). |
| Page does not open from another device | Use the address printed when the app starts. The PC and the Pi must be on the same network. |

## 7. Where each part of the activity is covered

| Lab sheet item | In this project |
|---|---|
| Read the sound sensor and raindrop sensor | `sensors.py` (analog through the MCP3008, digital through GPIO) |
| Flask web app that shows real-time data | `app.py` and the dashboard, refreshing every second |
| Website for control and monitoring | the Controls section (buzzer alerts, threshold, LED, test buzzer) |
| Buzzer that sounds when sound or rain is detected | `monitor.py` |
| Graph of sensor readings or real-time recordings | the Sound and Rain charts (Chart.js), history in SQLite |
| Challenge: plot sound levels and rain over time | the same charts, with Live, 1 hour and 24 hour ranges |
| Error handling for sensor malfunctions | "Offline" panels and the red message when a sensor or the ADC fails |

The complementary activity (adding temperature or humidity sensors) is not included.

## 8. A note on how sound is measured

A microphone signal swings up and down quickly, so a single ADC reading says very little. The app takes many readings over 50 milliseconds, measures the difference between the highest and lowest (peak-to-peak), and converts it to 0-100. That is why a clap gives a clear spike while a steady background hum stays low.
#   r a i n - s o u n d - m o n i t o r  
 


## 9. Calibration buttons

The **Calibration** section at the bottom of the dashboard has two buttons.

- **Calibrate sound**: keep the room quiet and press it. It records for 10 seconds, throws away spikes (claps, bumps) and saves the average background noise as the quiet level. After that, the quiet room reads 0 %.
- **Calibrate rain**: wipe the pad completely dry and press it. It records for 10 seconds, throws away spikes and saves the average dry reading. Moisture is then 0 % at that dry level and 100 % at RAIN_WET_RAW.

Rain is shown as Dry, Drizzle, Raining or Heavy rain. The moisture percentage where each level starts is set by RAIN_LEVELS in config.py (default 10 %, 35 % and 65 %).

If a calibration fails (room too loud, pad wet, readings unstable) nothing is saved and the page says why. **Reset** goes back to the defaults in config.py. The saved values survive a restart.
