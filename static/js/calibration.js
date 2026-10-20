(() => {
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
