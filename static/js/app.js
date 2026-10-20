(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const POLL_MS = 1000;
  const HISTORY_REFRESH_MS = { live: 1000, "1h": 10000, "24h": 30000 };
  const TOUCH_GRACE_MS = 2000;

  const COLORS = {
    ink: "#16222b",
    slate: "#5b6975",
    line: "#d3dade",
    amber: "#d9822b",
    amberFill: "rgba(242, 160, 61, 0.22)",
    blue: "#2a6bdb",
    blueFill: "rgba(42, 107, 219, 0.16)",
  };

  const el = {
    status: $("status"),
    statusText: $("status-text"),
    notice: $("notice"),
    soundPanel: $("sound-panel"),
    soundValue: $("sound-value"),
    soundUnit: $("sound-unit"),
    soundState: $("sound-state"),
    soundFill: $("sound-fill"),
    soundTick: $("sound-tick"),
    rainPanel: $("rain-panel"),
    rainState: $("rain-state"),
    rainMoisture: $("rain-moisture"),
    rainFill: $("rain-fill"),
    alerts: $("alerts"),
    threshold: $("threshold"),
    thresholdOut: $("threshold-out"),
    ledRadios: Array.from(document.querySelectorAll('input[name="led"]')),
    rangeRadios: Array.from(document.querySelectorAll('input[name="range"]')),
    ledLamp: $("led-lamp"),
    buzzerLamp: $("buzzer-lamp"),
    testBuzzer: $("test-buzzer"),
    mockButtons: $("mock-buttons"),
    events: $("events"),
    eventsEmpty: $("events-empty"),
  };

  let range = "live";
  let lastHistoryAt = 0;
  let pollCount = 0;
  let currentThreshold = 40;
  let soundChart = null;
  let rainChart = null;

  // Controls the person is using right now must not be overwritten by a poll.
  const touched = { alerts: 0, threshold: 0, led: 0 };
  let holdingSlider = false;

  function recentlyTouched(name) {
    if (name === "threshold" && holdingSlider) return true;
    return Date.now() - touched[name] < TOUCH_GRACE_MS;
  }

  // ------------------------------------------------------------ network
  async function fetchJSON(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, Object.assign({}, options, { signal: controller.signal }));
      if (!response.ok) throw new Error("HTTP " + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function postJSON(url, body) {
    return fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  // ------------------------------------------------------------ helpers
  function clampPct(value) {
    if (value == null || Number.isNaN(value)) return 0;
    return Math.max(0, Math.min(100, value));
  }

  function timeLabel(ts, withSeconds) {
    const options = { hour: "2-digit", minute: "2-digit" };
    if (withSeconds) options.second = "2-digit";
    return new Date(ts * 1000).toLocaleTimeString([], options);
  }

  function setStatus(state, text) {
    el.status.dataset.state = state;
    el.statusText.textContent = text;
  }

  function setLamp(lamp, name, on) {
    lamp.dataset.on = on ? "true" : "false";
    lamp.setAttribute("aria-label", name + (on ? " on" : " off"));
  }

  // ------------------------------------------------------------- render
  function render(data) {
    const sound = data.sound;
    const rain = data.rain;
    const settings = data.settings;
    currentThreshold = settings.sound_threshold;

    // Sound panel
    const soundState = !sound.online ? "offline" : sound.detected ? "alert" : "idle";
    el.soundPanel.dataset.state = soundState;
    el.soundValue.textContent = sound.level == null ? "–" : String(Math.round(sound.level));
    el.soundUnit.hidden = sound.level == null;
    el.soundState.textContent =
      soundState === "offline" ? "Offline" : soundState === "alert" ? "Loud" : "Quiet";
    el.soundFill.style.width = clampPct(sound.level) + "%";
    if (!recentlyTouched("threshold")) {
      el.soundTick.style.left = clampPct(settings.sound_threshold) + "%";
    }

    // Rain panel
    const rainState = !rain.online ? "offline" : rain.detected ? "alert" : "idle";
    el.rainPanel.dataset.state = rainState;
    el.rainState.textContent =
      rainState === "offline" ? "Offline" : rainState === "alert" ? "Raining" : "Dry";
    el.rainMoisture.textContent =
      rain.moisture == null ? "\u00a0" : "Moisture " + Math.round(rain.moisture) + "%";
    el.rainFill.style.width = clampPct(rain.moisture) + "%";

    // Header status and notice
    let state = "live";
    let text = "Live";
    if (data.mode === "mock") {
      state = "sim";
      text = "Simulated data";
    }
    if (data.errors.length > 0) {
      state = "problem";
      text = "Check sensors";
    }
    setStatus(state, text);
    if (data.errors.length > 0) {
      el.notice.textContent = data.errors.join(" ");
      el.notice.hidden = false;
    } else {
      el.notice.hidden = true;
    }

    document.title =
      sound.detected || rain.detected ? "Alert - Environment monitor" : "Environment monitor";

    // Outputs
    setLamp(el.ledLamp, "LED", data.led);
    setLamp(el.buzzerLamp, "Buzzer", data.buzzer);
    el.mockButtons.hidden = data.mode !== "mock";

    // Controls (skip any the person is touching)
    if (!recentlyTouched("alerts")) el.alerts.checked = settings.alerts_enabled;
    if (!recentlyTouched("threshold")) {
      el.threshold.value = settings.sound_threshold;
      el.thresholdOut.textContent = String(settings.sound_threshold);
    }
    if (!recentlyTouched("led")) {
      el.ledRadios.forEach((radio) => {
        radio.checked = radio.value === settings.led_mode;
      });
    }
  }

  function eventText(item) {
    if (item.kind === "rain") return "Rain started";
    if (item.kind === "dry") return "Rain stopped";
    return item.value == null ? "Loud sound" : "Loud sound, " + Math.round(item.value) + "%";
  }

  function renderEvents(events) {
    el.events.replaceChildren();
    events.forEach((item) => {
      const li = document.createElement("li");
      li.dataset.kind = item.kind;
      const time = document.createElement("time");
      time.dateTime = new Date(item.t * 1000).toISOString();
      time.textContent = timeLabel(item.t, true);
      const text = document.createElement("span");
      text.textContent = eventText(item);
      li.append(time, text);
      el.events.append(li);
    });
    el.eventsEmpty.hidden = events.length > 0;
  }

  // ------------------------------------------------------------- charts
  function baseOptions() {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          grid: { display: false },
          ticks: { maxTicksLimit: 6, maxRotation: 0, autoSkip: true },
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: COLORS.line },
          border: { display: false },
          ticks: { stepSize: 25, callback: (value) => value + "%" },
        },
      },
    };
  }

  function makeCharts() {
    if (!window.Chart) {
      el.notice.textContent = "Charts could not load. Reload the page.";
      el.notice.hidden = false;
      return;
    }
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
    Chart.defaults.color = COLORS.slate;

    const soundOptions = baseOptions();
    soundOptions.plugins = {
      legend: { display: false },
      tooltip: {
        filter: (item) => item.datasetIndex === 0,
        callbacks: {
          label: (ctx) => (ctx.parsed.y == null ? "" : "Sound " + Math.round(ctx.parsed.y) + "%"),
        },
      },
    };
    soundChart = new Chart($("sound-chart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Sound",
            data: [],
            borderColor: COLORS.amber,
            backgroundColor: COLORS.amberFill,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
            fill: true,
          },
          {
            label: "Threshold",
            data: [],
            borderColor: COLORS.ink,
            borderWidth: 1,
            borderDash: [5, 5],
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
          },
        ],
      },
      options: soundOptions,
    });

    const rainOptions = baseOptions();
    rainOptions.plugins = {
      legend: { display: false },
      tooltip: {
        callbacks: {
          label: (ctx) => {
            if (ctx.parsed.y == null) return "";
            if (ctx.datasetIndex === 0) return ctx.parsed.y > 0 ? "Raining" : "Dry";
            return "Moisture " + Math.round(ctx.parsed.y) + "%";
          },
        },
      },
    };
    rainChart = new Chart($("rain-chart"), {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "Raining",
            data: [],
            stepped: true,
            fill: "origin",
            backgroundColor: COLORS.blueFill,
            borderWidth: 0,
            pointRadius: 0,
            pointHoverRadius: 0,
          },
          {
            label: "Moisture",
            data: [],
            borderColor: COLORS.blue,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0.25,
            fill: false,
          },
        ],
      },
      options: rainOptions,
    });
  }

  function renderHistory(points) {
    if (!soundChart || !rainChart) return;
    const labels = points.map((p) => timeLabel(p.t, range === "live"));

    soundChart.data.labels = labels;
    soundChart.data.datasets[0].data = points.map((p) => p.sound);
    soundChart.data.datasets[1].data = points.map(() => currentThreshold);
    soundChart.update("none");

    rainChart.data.labels = labels;
    rainChart.data.datasets[0].data = points.map((p) => (p.rain ? 100 : 0));
    rainChart.data.datasets[1].data = points.map((p) => p.moisture);
    rainChart.update("none");
  }

  async function refreshHistory() {
    const requested = range;
    lastHistoryAt = Date.now();
    try {
      const data = await fetchJSON("/api/history?range=" + encodeURIComponent(requested));
      if (requested !== range) return; // the person switched range meanwhile
      renderHistory(data.points);
    } catch (err) {
      // the next poll will try again
    }
  }

  async function refreshEvents() {
    try {
      const data = await fetchJSON("/api/events?limit=8");
      renderEvents(data.events);
    } catch (err) {
      // the next poll will try again
    }
  }

  // ----------------------------------------------------------- controls
  async function saveSettings(patch) {
    try {
      await postJSON("/api/settings", patch);
    } catch (err) {
      // Let the next poll put the controls back to what the server has.
      touched.alerts = 0;
      touched.threshold = 0;
      touched.led = 0;
    }
  }

  el.alerts.addEventListener("change", () => {
    touched.alerts = Date.now();
    saveSettings({ alerts_enabled: el.alerts.checked });
  });

  el.threshold.addEventListener("pointerdown", () => {
    holdingSlider = true;
  });
  window.addEventListener("pointerup", () => {
    if (holdingSlider) touched.threshold = Date.now();
    holdingSlider = false;
  });
  window.addEventListener("pointercancel", () => {
    holdingSlider = false;
  });
  el.threshold.addEventListener("input", () => {
    touched.threshold = Date.now();
    el.thresholdOut.textContent = el.threshold.value;
    el.soundTick.style.left = el.threshold.value + "%";
    currentThreshold = Number(el.threshold.value);
  });
  el.threshold.addEventListener("change", () => {
    touched.threshold = Date.now();
    saveSettings({ sound_threshold: Number(el.threshold.value) });
  });

  el.ledRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      touched.led = Date.now();
      saveSettings({ led_mode: radio.value });
    });
  });

  el.testBuzzer.addEventListener("click", () => {
    postJSON("/api/buzzer/test").catch(() => {});
  });

  el.mockButtons.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mock]");
    if (!button) return;
    postJSON("/api/mock", { action: button.dataset.mock }).catch(() => {});
  });

  el.rangeRadios.forEach((radio) => {
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      range = radio.value;
      lastHistoryAt = 0;
      refreshHistory();
    });
  });

  // --------------------------------------------------------------- loop
  async function poll() {
    const started = performance.now();
    try {
      const data = await fetchJSON("/api/data");
      render(data);
      if (pollCount % 3 === 0) refreshEvents();
      if (Date.now() - lastHistoryAt >= HISTORY_REFRESH_MS[range]) refreshHistory();
    } catch (err) {
      setStatus("disconnected", "Disconnected");
    }
    pollCount += 1;
    setTimeout(poll, Math.max(200, POLL_MS - (performance.now() - started)));
  }

  makeCharts();
  poll();
})();
