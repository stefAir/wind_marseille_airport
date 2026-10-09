"use strict";

const LE_JAI_LAT = 43.436188;
const LE_JAI_LON = 5.192063;
const FR_TIME_ZONE = "Europe/Paris";
const HISTORY_HOURS = 30 * 24;
const HOUR_MS = 60 * 60 * 1000;
const frenchTimestamp = new Intl.DateTimeFormat("fr-FR", {
  timeZone: FR_TIME_ZONE,
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short"
});

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
  return date.toLocaleTimeString("fr-FR", {
    timeZone: FR_TIME_ZONE, hour: "2-digit", minute: "2-digit", timeZoneName: "short"
  });
}

function defaultChartRange() {
  const now = Date.now();
  return { min: now - 24 * HOUR_MS, max: now + 24 * HOUR_MS };
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

async function fetchForecasts(latitude, longitude, pastHours) {
  const models = [
    { id: "meteofrance_arome_france_hd", label: "AROME France HD", color: "#ff9f43", forecastHours: 48, gridResolutionKm: 1.5 },
    { id: "icon_eu", label: "ICON-EU", color: "#a55eea", forecastHours: 120, gridResolutionKm: 7 }
  ];

  return Promise.all(models.map(async m => {
    try {
      return {
        label: m.label,
        color: m.color,
        gridResolutionKm: m.gridResolutionKm,
        forecast: await fetchWindForecast(latitude, longitude, m.id, pastHours, m.forecastHours)
      };
    } catch (error) {
      return { label: m.label, color: m.color, gridResolutionKm: m.gridResolutionKm, error: error.message };
    }
  }));
}

function initChart() {
  const ctx = $("windChart").getContext("2d");

  const daylightBackgroundPlugin = {
    id: 'daylightBackground',
    beforeDraw(chart) {
      const { ctx, chartArea, scales: { x } } = chart;
      if (!chartArea || !Number.isFinite(x.min) || !Number.isFinite(x.max)) return;
      const { left, right, top, bottom } = chartArea;
      let day = luxon.DateTime.fromMillis(x.min, { zone: FR_TIME_ZONE }).startOf('day');
      ctx.save();
      ctx.fillStyle = '#0e1626';
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.fillStyle = '#384039';
      while (day.toMillis() <= x.max) {
        const { sunrise, sunset } = SunCalc.getTimes(day.plus({ hours: 12 }).toJSDate(), LE_JAI_LAT, LE_JAI_LON);
        const start = Math.max(left, x.getPixelForValue(sunrise.getTime()));
        const end = Math.min(right, x.getPixelForValue(sunset.getTime()));
        if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
          ctx.fillRect(start, top, end - start, bottom - top);
          if (end - start >= 24) {
            ctx.save();
            ctx.fillStyle = '#ffd166';
            ctx.font = '20px "Segoe UI Symbol", sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('\u2600', (start + end) / 2, top + 16);
            ctx.restore();
          }
        }
        day = day.plus({ days: 1 });
      }
      ctx.restore();
    }
  };

  const referenceLinesPlugin = {
    id: 'referenceLines',
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea: { left, right, top, bottom }, scales: { x, y } } = chart;
      const thresholdY = y.getPixelForValue(15 * unit().factor);
      const nowX = x.getPixelForValue(Date.now());
      ctx.save();
      ctx.lineWidth = 1;
      ctx.font = '11px sans-serif';
      if (thresholdY >= top && thresholdY <= bottom) {
        ctx.strokeStyle = '#69e69b';
        ctx.fillStyle = '#69e69b';
        ctx.beginPath();
        ctx.moveTo(left, thresholdY);
        ctx.lineTo(right, thresholdY);
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText('15 kn', right - 4, thresholdY < top + 18 ? thresholdY + 13 : thresholdY - 5);
      }
      if (nowX >= left && nowX <= right) {
        ctx.strokeStyle = '#d5e3ed';
        ctx.fillStyle = '#d5e3ed';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(nowX, top);
        ctx.lineTo(nowX, bottom);
        ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillText('Now', Math.min(nowX + 5, right - 27), top + 32);
      }
      ctx.restore();
    }
  };

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
        let lastArrowX = -Infinity;

        points.forEach(p => {
          if (!p.time || p.direction === null || p.speed === 0) return;

          // Align arrow X position with Chart.js time scale
          const xPos = x.getPixelForValue(p.time);
          if (xPos < left || xPos > right) return;

          // Show every ~2 hours for forecasts, or every observation if spaced out
          if (!isObs && luxon.DateTime.fromJSDate(p.time, { zone: FR_TIME_ZONE }).hour % 2 !== 0) return;
          if (xPos - lastArrowX < 14) return;
          lastArrowX = xPos;

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
    plugins: [daylightBackgroundPlugin, referenceLinesPlugin, directionArrowsPlugin],
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
          ...defaultChartRange(),
          adapters: {
            date: { zone: FR_TIME_ZONE, locale: 'fr-FR' }
          },
          title: {
            display: true,
            text: 'Europe/Paris (CET / CEST)',
            color: '#a4b3ca'
          },
          time: {
            tooltipFormat: 'dd LLL yyyy HH:mm ZZZZ',
            displayFormats: {
              hour: 'dd/MM HH:mm',
              day: 'dd/MM'
            }
          },
          grid: { color: '#354258' },
          ticks: {
            color: '#a4b3ca',
            maxTicksLimit: 6,
            maxRotation: 0,
            minRotation: 0,
            autoSkipPadding: 12,
            callback(value) {
              const time = luxon.DateTime.fromMillis(Number(value), { zone: FR_TIME_ZONE });
              return this.max - this.min <= 7 * 24 * HOUR_MS
                ? [time.toFormat('HH:mm'), time.toFormat('dd/MM')]
                : time.toFormat('dd/MM');
            }
          }
        },
        y: {
          beginAtZero: true,
          suggestedMax: 16 * unit().factor,
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
  chartInstance.options.scales.y.suggestedMax = 16 * unit().factor;
  const timestamps = datasets.flatMap(dataset => dataset.data.map(point => point.x.getTime()));
  if (timestamps.length) {
    chartInstance.options.plugins.zoom.limits = {
      x: { min: Math.min(...timestamps), max: Math.max(...timestamps), minRange: HOUR_MS }
    };
  }
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

function forecastSpeedAtTime(speedsByTime, time) {
  const timestamp = time.getTime();
  if (speedsByTime.has(timestamp)) return speedsByTime.get(timestamp);
  const before = Math.floor(timestamp / HOUR_MS) * HOUR_MS;
  const beforeSpeed = speedsByTime.get(before);
  const afterSpeed = speedsByTime.get(before + HOUR_MS);
  if (beforeSpeed == null || afterSpeed == null) return null;
  return beforeSpeed + (afterSpeed - beforeSpeed) * (timestamp - before) / HOUR_MS;
}

function gridDistanceKm(latitude, longitude) {
  const toRadians = degrees => degrees * Math.PI / 180;
  const deltaLatitude = toRadians(latitude - LE_JAI_LAT);
  const deltaLongitude = toRadians(longitude - LE_JAI_LON);
  const haversine = Math.min(1, Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(LE_JAI_LAT)) * Math.cos(toRadians(latitude)) * Math.sin(deltaLongitude / 2) ** 2);
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function render() {
  const modelSpeeds = forecasts.map(model => new Map(
    (model.forecast?.points ?? []).map(point => [point.time.getTime(), point.speed])
  ));
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

    $("measurement").textContent = "Obs: " + frenchTimestamp.format(latest.time);

    $("rows").innerHTML = [...observations].reverse().map(row => `
      <tr>
        <td>${frenchTimestamp.format(row.time)}</td>
        <td>${formatSpeed(row.speed)} ${unit().label}</td>
        <td>${directionText(row)}</td>
        ${modelSpeeds.map(speeds => {
          const speed = forecastSpeedAtTime(speeds, row.time);
          const description = speed === null ? "Model value unavailable"
            : speeds.has(row.time.getTime()) ? "Hourly model value" : "Linearly interpolated hourly model value";
          return `<td title="${description}">${speed === null ? "—" : `${formatSpeed(speed)} ${unit().label}`}</td>`;
        }).join("")}
      </tr>
    `).join("");
  }

  let detailsHtml = `<strong>Target Coordinates (Le Jaï):</strong> ${LE_JAI_LAT}, ${LE_JAI_LON}<br>`;
  forecasts.forEach(f => {
    if (f.forecast) {
      const distance = gridDistanceKm(f.forecast.gridLatitude, f.forecast.gridLongitude);
      detailsHtml += `<strong>${f.label}:</strong> Approx. grid resolution ${f.gridResolutionKm} km; nearest grid cell center at ${f.forecast.gridLatitude.toFixed(4)}°, ${f.forecast.gridLongitude.toFixed(4)}°; ${distance.toFixed(2)} km from Le Jaï<br>`;
    } else {
      detailsHtml += `<strong>${f.label}:</strong> Approx. grid resolution ${f.gridResolutionKm} km; failed to load (${f.error})<br>`;
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

  try {
    const [obsResult, fcResults] = await Promise.all([
      fetchObservations(HISTORY_HOURS),
      fetchForecasts(LE_JAI_LAT, LE_JAI_LON, HISTORY_HOURS)
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

$("units").addEventListener("change", () => {
  try { localStorage.setItem(UNIT_KEY, $("units").value); } catch (_) {}
  render();
});

$("showGusts").addEventListener("change", () => {
  try { localStorage.setItem(GUST_KEY, $("showGusts").checked); } catch (_) {}
  updateChart();
});

$("resetZoom").addEventListener("click", () => {
  if (chartInstance) chartInstance.zoomScale('x', defaultChartRange(), 'none');
});

// Initialize Chart and Load Initial Data
initChart();
load();

// Auto-refresh every 5 minutes when page is active
setInterval(() => { if (!document.hidden) load(); }, 5 * 60 * 1000);