/* ── OpenET Field Explorer ────────────────────────────── */

// Replace with your deployed Google Apps Script proxy URL
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbwKcSnbzf9KmIe8X09_wJqSzhZCERsz7Y9mjzCELIJGCEihkr_SzfQut77ig7CvA71R/exec';

/* ── Crop colors (same as main map) ──────────────────── */

const CROP_COLORS = {
    "Corn (Grain)": "#eab308", "Walnut": "#65a30d", "Pomegranate": "#dc2626",
    "Pistachio": "#16a34a", "Fallow": "#a8a29e", "Alfalfa": "#15803d",
    "Idle (1yr)": "#d6d3d1", "Winter Wheat/Hay": "#ca8a04", "Cotton": "#f5f5f4",
    "Tomato": "#ef4444", "Peach/Nectarine": "#fb923c", "Wheat": "#d97706",
    "Pasture (Mixed/Irrigated)": "#4ade80", "Plum": "#7c3aed",
    "Vineyard": "#7e22ce", "Cherry": "#be123c", "Citrus": "#f59e0b",
    "Young Perennial": "#86efac", "Apricot": "#fdba74", "Olive": "#365314",
    "Carrot": "#ea580c", "Celery": "#a3e635",
};
const CROP_DEFAULT_COLOR = "#6b7280";

/* ── State ────────────────────────────────────────────── */

let etChart = null;
let selectedField = null;
let annualCache = {};    // key: "lng,lat" → { year: totalET }
let monthlyCache = {};   // key: "lng,lat:year" → [{time, et}]

/* ── PMTiles + Map init ──────────────────────────────── */

const pmtilesProtocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", pmtilesProtocol.tile);

const map = new maplibregl.Map({
    container: "map",
    style: {
        version: 8,
        sources: {
            "satellite": {
                type: "raster",
                tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
                tileSize: 256, maxzoom: 19,
            },
            "roads": {
                type: "raster",
                tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
                tileSize: 256, maxzoom: 19,
            },
            "labels": {
                type: "raster",
                tiles: ["https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
                tileSize: 256, maxzoom: 19,
            },
        },
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        layers: [
            { id: "satellite", type: "raster", source: "satellite" },
            { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.8 } },
            { id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.7 } },
        ],
    },
    center: [-119.81, 36.28],
    zoom: 11,
    maxZoom: 18,
});

map.addControl(new maplibregl.NavigationControl(), "top-right");

/* ── Load layers on map ready ────────────────────────── */

map.on("load", () => {
    // GSA boundary
    fetch("data/sfkgsa.geojson")
        .then(r => r.json())
        .then(data => {
            map.addSource("gsa", { type: "geojson", data });
            map.addLayer({
                id: "gsa-boundary", type: "line", source: "gsa",
                paint: { "line-color": "#f59e0b", "line-width": 3, "line-opacity": 0.9 },
            });
        });

    // Crop boundaries
    map.addSource("crops", {
        type: "vector",
        url: "pmtiles://data/kings_crops_2023.pmtiles",
    });

    map.addLayer({
        id: "crops-fill", type: "fill", source: "crops", "source-layer": "crops",
        minzoom: 10,
        paint: {
            "fill-color": [
                "match", ["get", "CROP_NAME"],
                ...Object.entries(CROP_COLORS).flat(),
                CROP_DEFAULT_COLOR,
            ],
            "fill-opacity": 0.4,
        },
    });

    map.addLayer({
        id: "crops-outline", type: "line", source: "crops", "source-layer": "crops",
        minzoom: 12,
        paint: { "line-color": "#1e293b", "line-width": 0.5, "line-opacity": 0.5 },
    });

    map.addLayer({
        id: "crops-labels", type: "symbol", source: "crops", "source-layer": "crops",
        minzoom: 14,
        layout: {
            "text-field": ["get", "CROP_NAME"],
            "text-size": ["interpolate", ["linear"], ["zoom"], 13, 8, 16, 11],
            "text-allow-overlap": false,
        },
        paint: {
            "text-color": "#f8fafc",
            "text-halo-color": "rgba(0,0,0,0.8)",
            "text-halo-width": 1.5,
        },
    });

    // Selected field highlight
    map.addSource("selected-field", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
        id: "selected-field-outline", type: "line", source: "selected-field",
        paint: { "line-color": "#3b82f6", "line-width": 3 },
    });
});

/* ── Hover popup ─────────────────────────────────────── */

const popup = document.getElementById("popup");

map.on("mousemove", "crops-fill", (e) => {
    if (!e.features || !e.features.length) return;
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    const cropName = p.CROP_NAME || p.MAIN_CROP || "Unknown";
    popup.innerHTML = `
        <div class="popup-title">${cropName}</div>
        <div class="popup-row"><span class="popup-label">Acres</span><span class="popup-value">${p.ACRES ? Number(p.ACRES).toFixed(1) : "—"}</span></div>
    `;
    popup.style.left = (e.point.x + 12) + "px";
    popup.style.top = (e.point.y - 12) + "px";
    popup.classList.remove("hidden");
});

map.on("mouseleave", "crops-fill", () => {
    map.getCanvas().style.cursor = "";
    popup.classList.add("hidden");
});

/* ── Click field → load ET data ──────────────────────── */

map.on("click", "crops-fill", async (e) => {
    if (!e.features || !e.features.length) return;
    const feature = e.features[0];
    const p = feature.properties;
    const cropName = p.CROP_NAME || p.MAIN_CROP || "Unknown";
    const color = CROP_COLORS[cropName] || CROP_DEFAULT_COLOR;

    // Compute centroid from click point (good enough for the API query)
    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;
    const coordKey = `${lng.toFixed(6)},${lat.toFixed(6)}`;

    selectedField = { lng, lat, cropName, color, acres: p.ACRES, coordKey };

    // Highlight selected field
    map.getSource("selected-field").setData({
        type: "FeatureCollection",
        features: [feature],
    });

    // Update field info
    const fieldInfo = document.getElementById("field-info");
    fieldInfo.classList.remove("empty");
    fieldInfo.innerHTML = `
        <div class="field-info-row">
            <span class="field-info-label">Crop</span>
            <span class="field-crop-badge" style="background:${color}20;color:${color}">${cropName}</span>
        </div>
        <div class="field-info-row">
            <span class="field-info-label">Acres</span>
            <span class="field-info-value">${p.ACRES ? Number(p.ACRES).toFixed(1) : "—"}</span>
        </div>
        <div class="field-info-row">
            <span class="field-info-label">Location</span>
            <span class="field-info-value">${lng.toFixed(5)}, ${lat.toFixed(5)}</span>
        </div>
    `;

    // Check proxy URL
    if (PROXY_URL === 'YOUR_APPS_SCRIPT_PROXY_URL_HERE') {
        document.getElementById("annual-summary").innerHTML = `
            <div class="config-notice">
                <strong>Proxy not configured.</strong><br>
                Deploy <code>et_proxy.gs</code> as a Google Apps Script web app,
                then set <code>PROXY_URL</code> in <code>et.js</code>.
            </div>
        `;
        return;
    }

    // Load annual summary (last 5 years)
    await loadAnnualSummary(lng, lat, coordKey);
});

/* ── Load annual ET summary ──────────────────────────── */

async function loadAnnualSummary(lng, lat, coordKey) {
    const summaryEl = document.getElementById("annual-summary");
    const yearSelector = document.getElementById("year-selector");
    const currentYear = new Date().getFullYear();
    const startYear = 2018;

    summaryEl.innerHTML = `<div class="loading"><div class="spinner"></div>Loading ET data...</div>`;

    // Fetch 5+ years of monthly data
    const years = [];
    for (let y = startYear; y <= currentYear; y++) years.push(y);

    const annualTotals = {};
    const allMonthly = {};

    // Fetch each year (or use cache)
    for (const year of years) {
        const cacheKey = `${coordKey}:${year}`;
        if (monthlyCache[cacheKey]) {
            allMonthly[year] = monthlyCache[cacheKey];
            annualTotals[year] = monthlyCache[cacheKey].reduce((s, d) => s + (d.et || 0), 0);
            continue;
        }

        try {
            const data = await fetchET(lng, lat, `${year}-01-01`, `${year}-12-31`);
            if (data && Array.isArray(data)) {
                monthlyCache[cacheKey] = data;
                allMonthly[year] = data;
                annualTotals[year] = data.reduce((s, d) => s + (d.et || 0), 0);
            }
        } catch (err) {
            console.error(`ET fetch failed for ${year}:`, err);
        }
    }

    annualCache[coordKey] = annualTotals;

    // Render annual summary bars
    const maxET = Math.max(...Object.values(annualTotals), 1);
    let html = `<div class="annual-summary-title">Annual ET Total (mm)</div>`;
    for (const year of years.reverse()) {
        const val = annualTotals[year];
        if (val === undefined) continue;
        const pct = (val / maxET * 100).toFixed(1);
        html += `
            <div class="annual-row">
                <span class="annual-year">${year}</span>
                <div class="annual-bar-bg"><div class="annual-bar" style="width:${pct}%"></div></div>
                <span class="annual-value">${Math.round(val)} mm</span>
            </div>
        `;
    }
    summaryEl.innerHTML = `<div class="annual-summary">${html}</div>`;

    // Show year buttons
    yearSelector.style.display = "flex";
    yearSelector.innerHTML = `<label>Monthly Detail:</label>`;
    for (const year of years.reverse()) {
        if (!allMonthly[year]) continue;
        const btn = document.createElement("button");
        btn.className = "year-btn";
        btn.textContent = year;
        btn.addEventListener("click", () => {
            document.querySelectorAll(".year-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderMonthlyChart(allMonthly[year], year);
        });
        yearSelector.appendChild(btn);
    }

    // Auto-select most recent year with data
    const latestYear = years.find(y => allMonthly[y]);
    if (latestYear) {
        const btns = yearSelector.querySelectorAll(".year-btn");
        btns.forEach(b => { if (b.textContent == latestYear) b.click(); });
    }
}

/* ── Fetch ET from proxy ─────────────────────────────── */

async function fetchET(lng, lat, dateStart, dateEnd) {
    const body = {
        endpoint: "/raster/timeseries/point",
        body: {
            date_range: [dateStart, dateEnd],
            interval: "monthly",
            geometry: [lng, lat],
            model: "Ensemble",
            variable: "ET",
            reference_et: "cimis",
            units: "mm",
            file_format: "JSON",
        },
    };

    const resp = await fetch(PROXY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    // Apps Script returns opaque response with no-cors, but let's try
    const result = await resp.json();

    if (!result.success) {
        throw new Error(result.error || `API error: ${result.status}`);
    }

    return result.data;
}

/* ── Render monthly chart ────────────────────────────── */

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function renderMonthlyChart(data, year) {
    const chartTitle = document.getElementById("chart-title");
    chartTitle.textContent = `Monthly ET — ${year}`;

    // Ensure 12 months (fill missing with 0)
    const values = new Array(12).fill(0);
    data.forEach(d => {
        const month = new Date(d.time).getMonth();
        values[month] = d.et || 0;
    });

    const color = selectedField ? selectedField.color : "#3b82f6";

    if (etChart) etChart.destroy();

    const ctx = document.getElementById("et-chart").getContext("2d");
    etChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: MONTH_LABELS,
            datasets: [{
                label: "ET (mm)",
                data: values,
                backgroundColor: color + "99",
                borderColor: color,
                borderWidth: 1,
                borderRadius: 4,
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => `${ctx.parsed.y.toFixed(1)} mm`,
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: "#334155" },
                    ticks: { color: "#94a3b8", font: { size: 11 } },
                },
                y: {
                    grid: { color: "#334155" },
                    ticks: {
                        color: "#94a3b8",
                        font: { size: 11 },
                        callback: (v) => v + " mm",
                    },
                    beginAtZero: true,
                },
            },
        },
    });
}
