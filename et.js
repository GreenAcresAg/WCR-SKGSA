/* ── OpenET Field Explorer ────────────────────────────── */

// Replace with your deployed Google Apps Script proxy URL
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbzuDcSVIPTwyEwtkXoeu1MoGFpilKXQXQ02G3dSYA9BP_AvIzr8JL8dpWhEpM6wNu7Q/exec';

/* ── Unit conversions ────────────────────────────────── */
const MM_TO_IN = 0.0393701;
function mmToIn(mm) { return mm * MM_TO_IN; }
function etAcreFeet(etInches, acres) { return (etInches * acres) / 12; }

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

    // Click marker for selected point
    map.addSource("selected-point", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({
        id: "selected-point-ring", type: "circle", source: "selected-point",
        paint: {
            "circle-radius": 8,
            "circle-color": "transparent",
            "circle-stroke-color": "#3b82f6",
            "circle-stroke-width": 3,
        },
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
        <div style="font-size:11px;color:#64748b;margin-top:4px">Click for ET data</div>
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
    const acres = p.ACRES ? Number(p.ACRES) : 0;

    // Use click point for display, field geometry for ET query
    const lng = e.lngLat.lng;
    const lat = e.lngLat.lat;
    const geom = feature.geometry;
    const coordKey = `${lng.toFixed(6)},${lat.toFixed(6)}`;

    selectedField = { lng, lat, cropName, color, acres, coordKey, geom };

    // Show selected point marker (not polygon — avoids tile clipping artifacts)
    map.getSource("selected-point").setData({
        type: "FeatureCollection",
        features: [{
            type: "Feature",
            geometry: { type: "Point", coordinates: [lng, lat] },
        }],
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
            <span class="field-info-value">${acres ? acres.toFixed(1) : "—"}</span>
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

    // Load annual summary
    await loadAnnualSummary(lng, lat, coordKey, acres, geom);
});

/* ── Load annual ET summary ──────────────────────────── */

async function loadAnnualSummary(lng, lat, coordKey, acres, geom) {
    const summaryEl = document.getElementById("annual-summary");
    const yearSelector = document.getElementById("year-selector");
    const currentYear = new Date().getFullYear();
    const startYear = 2018;

    summaryEl.innerHTML = `<div class="loading"><div class="spinner"></div>Loading ET data...</div>`;
    yearSelector.style.display = "none";
    if (etChart) { etChart.destroy(); etChart = null; }
    document.getElementById("chart-title").textContent = "";

    const years = [];
    for (let y = startYear; y <= currentYear; y++) years.push(y);

    const annualTotals = {};
    const allMonthly = {};
    let hasData = false;

    // Check if we already have all years cached
    const uncachedYears = years.filter(y => !monthlyCache[`${coordKey}:${y}`]);
    for (const year of years) {
        const cacheKey = `${coordKey}:${year}`;
        if (monthlyCache[cacheKey]) {
            allMonthly[year] = monthlyCache[cacheKey];
            annualTotals[year] = monthlyCache[cacheKey].reduce((s, dd) => s + (dd.et || 0), 0);
            hasData = true;
        }
    }

    // Single API call for all uncached years
    if (uncachedYears.length > 0) {
        try {
            const raw = await fetchET(lng, lat, `${startYear}-01-01`, `${currentYear}-12-31`, geom);
            if (raw && Array.isArray(raw) && raw.length > 0) {
                // Normalize and group by year
                const normalized = raw.map(d => ({
                    time: d.time || d.date,
                    et: d.et ?? d.ET ?? d.value ?? 0,
                }));
                for (const d of normalized) {
                    const year = new Date(d.time).getFullYear();
                    if (!allMonthly[year]) allMonthly[year] = [];
                    allMonthly[year].push(d);
                }
                // Cache each year and compute totals
                for (const year of years) {
                    if (allMonthly[year] && allMonthly[year].length > 0) {
                        monthlyCache[`${coordKey}:${year}`] = allMonthly[year];
                        annualTotals[year] = allMonthly[year].reduce((s, d) => s + (d.et || 0), 0);
                        hasData = true;
                    }
                }
            }
        } catch (err) {
            console.error("ET fetch failed:", err);
            summaryEl.innerHTML = `<div class="error-msg">Error loading ET data: ${err.message}</div>`;
            return;
        }
    }

    if (!hasData) {
        summaryEl.innerHTML = `<div class="error-msg">No ET data available for this location.</div>`;
        return;
    }

    // Render annual summary bars (in inches + acre-feet)
    const maxET_in = Math.max(...Object.values(annualTotals).map(v => mmToIn(v)), 1);
    let html = `<div class="annual-summary-title">Annual ET Summary</div>`;
    const sortedYears = [...years].reverse();
    for (const year of sortedYears) {
        const val_mm = annualTotals[year];
        if (val_mm === undefined) continue;
        const val_in = mmToIn(val_mm);
        const val_af = etAcreFeet(val_in, acres);
        const pct = (val_in / maxET_in * 100).toFixed(1);
        html += `
            <div class="annual-row">
                <span class="annual-year">${year}</span>
                <div class="annual-bar-bg"><div class="annual-bar" style="width:${pct}%"></div></div>
                <span class="annual-value">${val_in.toFixed(1)} in</span>
                <span class="annual-af">${val_af.toFixed(2)} AF</span>
            </div>
        `;
    }
    summaryEl.innerHTML = `<div class="annual-summary">${html}</div>`;

    // Show year buttons
    yearSelector.style.display = "flex";
    yearSelector.innerHTML = `<label>Monthly Detail:</label>`;
    const displayYears = [...years].reverse();
    for (const year of displayYears) {
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
    const latestYear = displayYears.find(y => allMonthly[y]);
    if (latestYear) {
        const btns = yearSelector.querySelectorAll(".year-btn");
        btns.forEach(b => { if (b.textContent == latestYear) b.click(); });
    }
}

/* ── Fetch ET from proxy ─────────────────────────────── */

async function fetchET(lng, lat, dateStart, dateEnd, geom) {
    const params = new URLSearchParams({ start: dateStart, end: dateEnd });

    if (geom && geom.type && geom.coordinates) {
        // Polygon query — field-averaged ET
        params.set("geom", JSON.stringify(geom));
        console.log("Fetching ET (polygon avg):", geom.type, "vertices:", JSON.stringify(geom.coordinates).length);
    } else {
        // Point fallback
        params.set("lng", lng.toFixed(6));
        params.set("lat", lat.toFixed(6));
    }

    const url = PROXY_URL + '?' + params.toString();
    console.log("Fetching ET:", url.substring(0, 150) + "...");

    const resp = await fetch(url);

    if (!resp.ok) {
        const text = await resp.text();
        console.error("Proxy error:", resp.status, text.substring(0, 200));
        throw new Error(`Proxy returned ${resp.status}`);
    }

    const text = await resp.text();
    console.log("Proxy response:", text.substring(0, 300));

    let result;
    try {
        result = JSON.parse(text);
    } catch (e) {
        console.error("Non-JSON response:", text.substring(0, 200));
        throw new Error("Proxy returned non-JSON response");
    }

    if (!result.success) {
        console.error("OpenET error detail:", JSON.stringify(result.data));
        const detail = result.data?.detail || result.data?.message || JSON.stringify(result.data);
        throw new Error(result.error || `OpenET API error (${result.status}): ${detail}`);
    }

    return result.data;
}

/* ── Render monthly chart ────────────────────────────── */

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function renderMonthlyChart(data, year) {
    const chartTitle = document.getElementById("chart-title");
    const acres = selectedField ? selectedField.acres : 0;
    chartTitle.textContent = `Monthly ET — ${year}`;

    // Ensure 12 months (fill missing with 0), convert mm → inches
    const values_in = new Array(12).fill(0);
    data.forEach(d => {
        const month = new Date(d.time).getMonth();
        values_in[month] = mmToIn(d.et || 0);
    });

    const values_af = values_in.map(v => etAcreFeet(v, acres));
    const color = selectedField ? selectedField.color : "#3b82f6";

    if (etChart) etChart.destroy();

    const ctx = document.getElementById("et-chart").getContext("2d");
    etChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: MONTH_LABELS,
            datasets: [{
                label: "ET (in)",
                data: values_in,
                backgroundColor: color + "99",
                borderColor: color,
                borderWidth: 1,
                borderRadius: 4,
                yAxisID: "y",
            }, {
                label: "Acre-Feet",
                data: values_af,
                type: "line",
                borderColor: "#60a5fa",
                backgroundColor: "transparent",
                borderWidth: 2,
                pointRadius: 3,
                pointBackgroundColor: "#60a5fa",
                tension: 0.3,
                yAxisID: "y1",
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: "#94a3b8", font: { size: 11 } },
                    position: "bottom",
                },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            if (ctx.dataset.label === "ET (in)") {
                                return `ET: ${ctx.parsed.y.toFixed(2)} in`;
                            }
                            return `Volume: ${ctx.parsed.y.toFixed(3)} AF`;
                        },
                    },
                },
            },
            scales: {
                x: {
                    grid: { color: "#334155" },
                    ticks: { color: "#94a3b8", font: { size: 11 } },
                },
                y: {
                    position: "left",
                    grid: { color: "#334155" },
                    ticks: {
                        color: "#94a3b8", font: { size: 11 },
                        callback: (v) => v.toFixed(1) + " in",
                    },
                    beginAtZero: true,
                    title: { display: true, text: "ET (inches)", color: "#94a3b8", font: { size: 11 } },
                },
                y1: {
                    position: "right",
                    grid: { drawOnChartArea: false },
                    ticks: {
                        color: "#60a5fa", font: { size: 11 },
                        callback: (v) => v.toFixed(2) + " AF",
                    },
                    beginAtZero: true,
                    title: { display: true, text: "Acre-Feet", color: "#60a5fa", font: { size: 11 } },
                },
            },
        },
    });
}
