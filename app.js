"use strict";

// Le Jaï Spot Coordinates from Windguru
const LE_JAI_LAT = 43.4111;
const LE_JAI_LON = 5.1604;

const UNIT_KEY = "lfml-wind-units";
const GUST_KEY = "lfml-show-gusts";
const $ = id => document.getElementById(id);

const unitSettings = {
  kt:  { factor: 1, label: "knots" },
  kmh: { factor: 1.852, label: "km/h" },
  ms:  { factor: 0.514444, label: "m/s" }
};

let observations = [];
let forecasts = [];
let lastFetched = null;
let busy = false;
let chartInstance = null;

try {
  const savedUnit = localStorage.getItem(UNIT_KEY);
  if (unitSettings[savedUnit]) $("units").value = savedUnit;
  $("showGusts").checked = localStorage.getItem(GUST_KEY) === "true";
} catch (_) {}

function unit() {
  return unitSettings[$("units").value];
}

function formatSpeed(value) {
  return value === null ? "—" : (value * unit().factor).toFixed(1);
}

function clock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "M") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compassPoint(degrees) {
  const points = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return points[Math.round(degrees / 22.5) % 16];
}

function directionText(row) {
  if (row.speed === 0) return "Calm";
  if (row.direction === null) return "Variable / unavailable";
  return `${compassPoint(row.direction)} · ${row.direction}°`;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(line => line.trim() && !line.startsWith("#"));
  const headerIndex = lines.findIndex(line => line.toLowerCase().startsWith("station,valid,"));
  if (headerIndex < 0) throw new Error("Unexpected CSV format.");

  const headers = lines[headerIndex].split(",").map(s => s.trim());
  const index = name => headers.indexOf(name);

  const unique = new Map();
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.split(",").map(s => s.trim());
    if (cells[index("station")] !== "LFML") continue;

    const rawTime = cells[index("valid")];
    if (!rawTime) continue;
    const time = new Date(rawTime.replace(" ", "T") + "Z");
    if (!Number.isFinite(time.getTime())) continue;

    const speed = numberOrNull(cells[index("sknt")]);
    const gust = numberOrNull(cells[index("gust")]);
    const direction = numberOrNull(cells[index("drct")]);

    unique.set(time.getTime(), {
      time,
      speed: speed !== null && speed >= 0 ? speed : null,
      gust: gust !== null && gust >= 0 ? gust : null,
      direction: direction !== null && direction >= 0 && direction <= 360 ? direction % 360 : null
    });
  }

  return [...unique.values()].sort((a, b) => a.time - b.time);
}

async function fetchObservations(pastHours) {
  const url = "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py" +
    `?station=LFML&data=sknt&data=drct&data=gust&hours=${pastHours}&format=onlycomma&tz=UTC`;

  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`IEM HTTP ${response.status}`);
  const csv = await response.text();
  return parseCSV(csv);
}

async function fetchWindForecast(latitude, longitude, model, pastHours, forecastHours) {
  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    models: model,
    wind_speed_unit: "kn",
    timeformat: "unixtime",
    timezone: "GMT",
    past_hours: String(pastHours),
    forecast_hours: String(forecastHours),
    cell_selection: "nearest"
  });

  const response = await fetch("https://api.open-meteo.com/v1/forecast?" + params);
  const json = await response.json();

  if (!response.ok || json.error) throw new Error(json.reason || `HTTP ${response.status}`);

  const hourly = json.hourly;
  if (!hourly || !Array.isArray(hourly.time)) throw new Error("No hourly forecast returned.");

  function values(name) {
    const result = hourly[name] ?? hourly[`${name}_${model}`];
    return Array.isArray(result) ? result : [];
  }

  const speeds = values("wind_speed_10m");
  const directions = values("wind_direction_10m");
  const gusts = values("wind_gusts_10m");

  const points = hourly.time.map((seconds, i) => ({
    time: new Date(seconds * 1000),
    speed: numberOrNull(speeds[i]),
    direction: numberOrNull(directions[i]),
    gust: numberOrNull(gusts[i])
  }));

  return {
    model,
    gridLatitude: json.latitude,
    gridLongitude: json.longitude,
    points
  };
}

async function fetchForecasts(latitude, longitude, pastHours, forecastHours) {
  const models = [
    { id: "meteofrance_arome_france_hd", label: "AROME France HD", color: "#ff9f43" },
    { id: "icon_eu", label: "ICON-EU", color: "#a55eea" }
  ];

  return Promise.all(models.map(async m => {
    try {
      return {
        label: m.label,
        color: m.color,
        forecast: await fetchWindForecast(latitude, longitude, m.id, pastHours, forecastHours)
      };
    } catch (error) {
      return { label: m.label, color: m.color, error: error.message };
    }
  }));
}

function initChart() {
  const ctx = $("windChart").getContext("2d");

  // Custom Chart.js Plugin to draw direction arrows below the X-axis
  const directionArrowsPlugin = {
    id: 'directionArrows',
    afterDraw(chart) {
      const { ctx, chartArea: { left, right }, scales: { x } } = chart;
      const showGusts = $("showGusts").checked;

      // Filter points to show roughly every 2 hours to avoid overcrowding
      function drawArrowTrack(points, yOffset, color, isObs = false) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1.5;

        points.forEach(p => {
          if (!p.time || p.direction === null || p.speed === 0) return;

          // Align arrow X position with Chart.js time scale
          const xPos = x.getPixelForValue(p.time);
          if (xPos < left || xPos > right) return;

          // Show every ~2 hours for forecasts, or every observation if spaced out
          if (!isObs && p.time.getHours() % 2 !== 0) return;

          // Wind direction + 180° so the arrow points where wind is blowing
          const angle = ((p.direction + 180) % 360) * (Math.PI / 180);

          ctx.save();
          ctx.translate(xPos, yOffset);
          ctx.rotate(angle);

          // Draw Arrow Path
          ctx.beginPath();
          ctx.moveTo(0, 7);
          ctx.lineTo(0, -7);
          ctx.lineTo(-3, -2);
          ctx.moveTo(0, -7);
          ctx.lineTo(3, -2);
          ctx.stroke();

          ctx.restore();
        });

        ctx.restore();
      }

      // Track positions below the chart
      const baseTop = chart.height - 45;

      if (observations.length) {
        drawArrowTrack(observations, baseTop, '#60c8ff', true);
      }

      forecasts.forEach((f, idx) => {
        if (f.forecast) {
          drawArrowTrack(f.forecast.points, baseTop + 18 + (idx * 16), f.color, false);
        }
      });
    }
  };

  chartInstance = new Chart(ctx, {
    type: 'line',
    data: { datasets: [] },
    plugins: [directionArrowsPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          bottom: 55 // Leave room at the bottom for arrow tracks
        }
      },
      interaction: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          type: 'time',
          time: {
            displayFormats: {
              hour: 'M/d HH:mm'
            }
          },
          grid: { color: '#354258' },
          ticks: { color: '#a4b3ca' }
        },
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: unit().label,
            color: '#a4b3ca'
          },
          grid: { color: '#354258' },
          ticks: { color: '#a4b3ca' }
        }
      },
      plugins: {
        legend: {
          labels: { color: '#edf3ff' }
        },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x',
          },
          zoom: {
            wheel: { enabled: true },
            pinch: { enabled: true },
            mode: 'x',
          }
        }
      }
    }
  });
}

function updateChart() {
  if (!chartInstance) return;

  const showGusts = $("showGusts").checked;
  const datasets = [];

  // 1. Observed Wind
  datasets.push({
    label: 'Observed Wind (LFML)',
    data: observations.map(o => ({ x: o.time, y: o.speed === null ? null : o.speed * unit().factor })),
    borderColor: '#60c8ff',
    backgroundColor: '#60c8ff',
    borderWidth: 2,
    pointRadius: 2,
    spanGaps: false
  });

  if (showGusts) {
    datasets.push({
      label: 'Observed Gust (LFML)',
      data: observations.map(o => ({ x: o.time, y: o.gust === null ? null : o.gust * unit().factor })),
      borderColor: '#ffbd69',
      backgroundColor: '#ffbd69',
      borderWidth: 1,
      pointRadius: 2,
      borderDash: [2, 2],
      spanGaps: false
    });
  }

  // 2. Forecasts
  forecasts.forEach(f => {
    if (f.forecast) {
      datasets.push({
        label: `${f.label} Speed`,
        data: f.forecast.points.map(p => ({ x: p.time, y: p.speed === null ? null : p.speed * unit().factor })),
        borderColor: f.color,
        backgroundColor: f.color,
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        spanGaps: true
      });

      if (showGusts) {
        datasets.push({
          label: `${f.label} Gust`,
          data: f.forecast.points.map(p => ({ x: p.time, y: p.gust === null ? null : p.gust * unit().factor })),
          borderColor: f.color,
          backgroundColor: f.color,
          borderWidth: 1,
          borderDash: [2, 4],
          pointRadius: 0,
          spanGaps: true
        });
      }
    }
  });

  chartInstance.data.datasets = datasets;
  chartInstance.options.scales.y.title.text = unit().label;
  chartInstance.update();
}

function updateAge() {
  if (!observations.length) return;
  const latest = observations[observations.length - 1];
  const minutes = Math.max(0, Math.floor((Date.now() - latest.time) / 60000));
  const stale = minutes > 60;

  $("age").textContent = `${stale ? "STALE · " : ""}Measured ${minutes}m ago`;
  $("age").classList.toggle("stale", stale);

  if (lastFetched) {
    $("status").textContent = `Fetched ${clock(lastFetched)}`;
  }
}

function render() {
  if (observations.length) {
    const latest = observations[observations.length - 1];

    $("speed").textContent = formatSpeed(latest.speed);
    $("speedUnit").textContent = unit().label;
    $("direction").textContent = directionText(latest);
    $("gust").textContent = latest.gust === null
      ? "Gust —"
      : `Gust ${formatSpeed(latest.gust)} ${unit().label}`;

    $("needle").style.visibility = latest.direction === null || latest.speed === 0 ? "hidden" : "visible";
    $("needle").style.transform = `rotate(${(latest.direction + 180) % 360}deg)`;

    $("measurement").textContent = "Obs: " + latest.time.toLocaleString([], {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short"
    });

    $("rows").innerHTML = [...observations].reverse().map(row => `
      <tr>
        <td>${row.time.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
        <td>${formatSpeed(row.speed)} ${unit().label}</td>
        <td>${directionText(row)}</td>
        <td>${row.gust === null ? "—" : formatSpeed(row.gust)}</td>
      </tr>
    `).join("");
  }

  let detailsHtml = `<strong>Target Coordinates (Le Jaï):</strong> ${LE_JAI_LAT}, ${LE_JAI_LON}<br>`;
  forecasts.forEach(f => {
    if (f.forecast) {
      detailsHtml += `<strong>${f.label}:</strong> Nearest grid cell at ${f.forecast.gridLatitude.toFixed(4)}°, ${f.forecast.gridLongitude.toFixed(4)}°<br>`;
    } else {
      detailsHtml += `<strong>${f.label}:</strong> Failed to load (${f.error})<br>`;
    }
  });
  $("modelDetails").innerHTML = detailsHtml;

  updateAge();
  updateChart();
}

async function load() {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  $("status").textContent = "Loading…";
  $("error").textContent = "";

  const pastHours = $("historyHours").value;
  const forecastHours = $("forecastHours").value;

  try {
    const [obsResult, fcResults] = await Promise.all([
      fetchObservations(pastHours),
      fetchForecasts(LE_JAI_LAT, LE_JAI_LON, pastHours, forecastHours)
    ]);

    observations = obsResult;
    forecasts = fcResults;
    lastFetched = new Date();

    render();
  } catch (error) {
    $("error").textContent = `Error loading data: ${error.message}\nClick Refresh to retry.`;
    $("status").textContent = "Load failed";
  } finally {
    busy = false;
    $("refresh").disabled = false;
  }
}

// Event Listeners
$("refresh").addEventListener("click", load);
$("historyHours").addEventListener("change", load);
$("forecastHours").addEventListener("change", load);

$("units").addEventListener("change", () => {
  try { localStorage.setItem(UNIT_KEY, $("units").value); } catch (_) {}
  render();
});

$("showGusts").addEventListener("change", () => {
  try { localStorage.setItem(GUST_KEY, $("showGusts").checked); } catch (_) {}
  updateChart();
});

$("resetZoom").addEventListener("click", () => {
  if (chartInstance) chartInstance.resetZoom();
});

// Initialize Chart and Load Initial Data
initChart();
load();

// Auto-refresh every 5 minutes when page is active
setInterval(() => { if (!document.hidden) load(); }, 5 * 60 * 1000);