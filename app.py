"""
Sound and Raindrop monitor - Flask web server.

Run:   python app.py
Open:  http://localhost:5000   (or http://<pi-address>:5000 from another device)
"""

import atexit
import csv
import io
import logging
import signal
import socket
import sys
import time

from flask import Flask, Response, jsonify, render_template, request

import config
import database
from monitor import Monitor
from sensors import create_sensors

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("werkzeug").setLevel(logging.WARNING)

app = Flask(__name__)

database.init()
sensors = create_sensors()
monitor = Monitor(sensors)


@app.after_request
def no_cache_for_api(response):
    if request.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# ------------------------------------------------------------------ pages
@app.get("/")
def index():
    return render_template("index.html")


# -------------------------------------------------------------------- API
@app.get("/api/data")
def api_data():
    return jsonify(monitor.snapshot())


@app.get("/api/history")
def api_history():
    name = request.args.get("range", "live")
    if name not in config.HISTORY_RANGES:
        return jsonify(error="Unknown range."), 400
    return jsonify(range=name, points=database.history(name))


@app.get("/api/events")
def api_events():
    limit = request.args.get("limit", 8, type=int)
    limit = max(1, min(limit, 50))
    return jsonify(events=database.recent_events(limit))


@app.post("/api/settings")
def api_settings():
    payload = request.get_json(silent=True)
    try:
        settings = monitor.update_settings(payload)
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    return jsonify(settings)


@app.post("/api/buzzer/test")
def api_buzzer_test():
    monitor.test_buzzer()
    return jsonify(ok=True)


@app.post("/api/mock")
def api_mock():
    if sensors.mode != "mock":
        return jsonify(error="Only available with simulated data."), 400
    payload = request.get_json(silent=True) or {}
    try:
        sensors.trigger(payload.get("action"))
    except ValueError as exc:
        return jsonify(error=str(exc)), 400
    return jsonify(ok=True)


@app.get("/api/export.csv")
def api_export():
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["time", "sound_percent", "raining", "moisture_percent"])
    for row in database.export_rows(86400):
        writer.writerow(
            [
                time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(row["ts"])),
                "" if row["sound"] is None else round(row["sound"], 1),
                row["rain"],
                "" if row["moisture"] is None else round(row["moisture"], 1),
            ]
        )
    return Response(
        buffer.getvalue(),
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=sensor-readings.csv"},
    )


# ------------------------------------------------------------------- main
def _lan_ip():
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("10.255.255.255", 1))
        return probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()


def main():
    atexit.register(monitor.stop)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    monitor.start()

    print()
    print("  Sensor mode : %s" % ("SIMULATED data" if sensors.mode == "mock" else "real hardware"))
    print("  Dashboard   : http://localhost:%d" % config.PORT)
    ip = _lan_ip()
    if ip:
        print("  On your network: http://%s:%d" % (ip, config.PORT))
    print("  Press Ctrl+C to stop.")
    print()

    app.run(host=config.HOST, port=config.PORT, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
