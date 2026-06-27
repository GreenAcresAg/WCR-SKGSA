/* ── OpenET Field Explorer ────────────────────────────── */

// Replace with your deployed Google Apps Script proxy URL
const PROXY_URL = 'https://script.google.com/macros/s/AKfycbzAYl1QRgHS6_5a2mU8-IKVOQaeUjmH1hYXj6GjwxtZFoiUDA1Y6g844q7sMpENbVvo/exec';

/* ── Unit conversions ────────────────────────────────── */
const MM_TO_IN = 0.0393701;
function mmToIn(mm) { return mm * MM_TO_IN; }
function etAcreFeet(etInches, acres) { return (etInches * acres) / 12; }

/* ── Polygon simplification (Douglas-Peucker) ────────── */
const MAX_POLYGON_VERTICES = 80;

function perpDist(pt, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.sqrt((pt[0] - a[0]) ** 2 + (pt[1] - a[1]) ** 2);
    const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / len2));
    const px = a[0] + t * dx, py = a[1] + t * dy;
    return Math.sqrt((pt[0] - px) ** 2 + (pt[1] - py) ** 2);
}

function dpSimplify(ring, epsilon) {
    if (ring.length <= 2) return ring;
    let maxDist = 0, maxIdx = 0;
    for (let i = 1; i < ring.length - 1; i++) {
        const d = perpDist(ring[i], ring[0], ring[ring.length - 1]);
        if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > epsilon) {
        const left = dpSimplify(ring.slice(0, maxIdx + 1), epsilon);
        const right = dpSimplify(ring.slice(maxIdx), epsilon);
        return left.slice(0, -1).concat(right);
    }
    return [ring[0], ring[ring.length - 1]];
}

function simplifyGeometry(geom) {
    if (!geom || !geom.coordinates) return geom;
    const simplifyRing = (ring) => {
        if (ring.length <= MAX_POLYGON_VERTICES) return ring;
        // Start with small epsilon, increase until under limit
        let eps = 0.00001;
        let result = ring;
        while (result.length > MAX_POLYGON_VERTICES && eps < 0.01) {
            result = dpSimplify(ring, eps);
            eps *= 2;
        }
        // Ensure ring is closed
        if (result.length > 2 && (result[0][0] !== result[result.length-1][0] || result[0][1] !== result[result.length-1][1])) {
            result.push(result[0]);
        }
        console.log(`Simplified ring: ${ring.length} → ${result.length} vertices (eps=${eps/2})`);
        return result;
    };

    const copy = JSON.parse(JSON.stringify(geom));
    if (copy.type === "Polygon") {
        copy.coordinates = copy.coordinates.map(simplifyRing);
    } else if (copy.type === "MultiPolygon") {
        copy.coordinates = copy.coordinates.map(poly => poly.map(simplifyRing));
    }
    return copy;
}

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
    "Almond": "#a3e635", "Safflower": "#eab308", "Solar Farm": "#64748b",
    "Onion/Garlic": "#c084fc", "Clover": "#22c55e", "Pecan": "#84cc16",
    "Sudangrass": "#65a30d", "Idle/Fallow": "#a8a29e",
    "Pasture (Irrigated)": "#4ade80",
};
const CROP_DEFAULT_COLOR = "#6b7280";

/* ── LandIQ Raster ET lookup ────────────────────────── */
let zonalLookup = null;  // centroid key → {c, a, ann, m}

fetch("data/zonal_et_lookup.json")
    .then(r => r.json())
    .then(data => {
        zonalLookup = data;
        console.log(`Loaded zonal ET lookup: ${Object.keys(data).length} fields`);
    })
    .catch(err => console.warn("Zonal ET lookup not available:", err));

function findZonalData(geom) {
    if (!zonalLookup || !geom) return null;
    // Compute centroid of outer ring
    let ring;
    if (geom.type === "Polygon") ring = geom.coordinates[0];
    else if (geom.type === "MultiPolygon") {
        ring = geom.coordinates.reduce((a, b) => a[0].length > b[0].length ? a : b)[0];
    } else return null;

    const cx = ring.reduce((s, p) => s + p[0], 0) / ring.length;
    const cy = ring.reduce((s, p) => s + p[1], 0) / ring.length;
    const key = `${cx.toFixed(5)},${cy.toFixed(5)}`;

    // Exact match first
    if (zonalLookup[key]) return zonalLookup[key];

    // Nearest within 0.001° (~100m)
    let best = null, bestDist = 0.001;
    for (const k of Object.keys(zonalLookup)) {
        const [kx, ky] = k.split(",").map(Number);
        const d = Math.sqrt((cx - kx) ** 2 + (cy - ky) ** 2);
        if (d < bestDist) { bestDist = d; best = zonalLookup[k]; }
    }
    return best;
}

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

    // Crop boundaries — 2024 (displayed)
    map.addSource("crops", {
        type: "vector",
        url: "pmtiles://data/kings_crops_2024.pmtiles",
    });

    map.addLayer({
        id: "crops-fill", type: "fill", source: "crops", "source-layer": "crops2024",
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
        id: "crops-outline", type: "line", source: "crops", "source-layer": "crops2024",
        minzoom: 12,
        paint: { "line-color": "#1e293b", "line-width": 0.5, "line-opacity": 0.5 },
    });

    map.addLayer({
        id: "crops-labels", type: "symbol", source: "crops", "source-layer": "crops2024",
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

    // Crop boundaries — 2023 (hidden, for label lookup only)
    map.addSource("crops2023", {
        type: "vector",
        url: "pmtiles://data/kings_crops_2023.pmtiles",
    });

    map.addLayer({
        id: "crops2023-fill", type: "fill", source: "crops2023", "source-layer": "crops",
        minzoom: 10,
        paint: { "fill-color": "transparent", "fill-opacity": 0 },
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

/* ── Crop year lookup helper ────────────────────────── */

function getCrop2023AtPoint(point) {
    const features = map.queryRenderedFeatures(point, { layers: ["crops2023-fill"] });
    if (features && features.length > 0) {
        const p = features[0].properties;
        return p.CROP_NAME || p.MAIN_CROP || null;
    }
    return null;
}

/* ── Hover popup ─────────────────────────────────────── */

const popup = document.getElementById("popup");

map.on("mousemove", "crops-fill", (e) => {
    if (!e.features || !e.features.length) return;
    map.getCanvas().style.cursor = "pointer";
    const p = e.features[0].properties;
    const crop2024 = p.CROP_NAME || p.MAIN_CROP || "Unknown";
    const crop2023 = getCrop2023AtPoint(e.point);
    const changed = crop2023 && crop2023 !== crop2024;
    popup.innerHTML = `
        <div class="popup-title">${crop2024}</div>
        <div class="popup-row"><span class="popup-label">2024</span><span class="popup-value">${crop2024}</span></div>
        ${crop2023 ? `<div class="popup-row"><span class="popup-label">2023</span><span class="popup-value" style="${changed ? 'color:#fbbf24' : ''}">${crop2023}${changed ? ' ⚠' : ''}</span></div>` : ''}
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
    const crop2024 = p.CROP_NAME || p.MAIN_CROP || "Unknown";
    const crop2023 = getCrop2023AtPoint(e.point);
    const cropName = crop2024;
    const color = CROP_COLORS[cropName] || CROP_DEFAULT_COLOR;
    const acres = p.ACRES ? Number(p.ACRES) : 0;
    const changed = crop2023 && crop2023 !== crop2024;

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
            <span class="field-info-label">Crop (2024)</span>
            <span class="field-crop-badge" style="background:${color}20;color:${color}">${crop2024}</span>
        </div>
        ${crop2023 ? `<div class="field-info-row">
            <span class="field-info-label">Crop (2023)</span>
            <span class="field-info-value" style="${changed ? 'color:#fbbf24' : ''}">${crop2023}${changed ? ' (changed)' : ''}</span>
        </div>` : ''}
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
    const currentMonth = new Date().getMonth();
    const currentWY = currentMonth >= 9 ? currentYear + 1 : currentYear;
    const startWY = 2019;  // WY 2019 = Oct 2018 – Sep 2019

    summaryEl.innerHTML = `<div class="loading"><div class="spinner"></div>Loading ET data...</div>`;
    yearSelector.style.display = "none";
    if (etChart) { etChart.destroy(); etChart = null; }
    document.getElementById("chart-title").textContent = "";

    const waterYears = [];
    for (let wy = startWY; wy <= currentWY; wy++) waterYears.push(wy);

    const annualTotals = {};   // wy → total ET mm
    const allMonthly = {};     // wy → [{time, et, calMonth}]
    let hasData = false;

    // Check cache (keyed by water year)
    const uncachedWYs = waterYears.filter(wy => !monthlyCache[`${coordKey}:wy${wy}`]);
    for (const wy of waterYears) {
        const cacheKey = `${coordKey}:wy${wy}`;
        if (monthlyCache[cacheKey]) {
            allMonthly[wy] = monthlyCache[cacheKey];
            annualTotals[wy] = monthlyCache[cacheKey].reduce((s, dd) => s + (dd.et || 0), 0);
            hasData = true;
        }
    }

    // Single API call for full date range
    if (uncachedWYs.length > 0) {
        try {
            const raw = await fetchET(lng, lat, `${startWY - 1}-10-01`, `${currentWY}-09-30`, geom);
            if (raw && Array.isArray(raw) && raw.length > 0) {
                const normalized = raw.map(d => ({
                    time: d.time || d.date,
                    et: d.et ?? d.ET ?? d.value ?? 0,
                }));
                // Group by water year
                for (const d of normalized) {
                    const wy = getWaterYear(d.time);
                    if (!allMonthly[wy]) allMonthly[wy] = [];
                    allMonthly[wy].push(d);
                }
                for (const wy of waterYears) {
                    if (allMonthly[wy] && allMonthly[wy].length > 0) {
                        monthlyCache[`${coordKey}:wy${wy}`] = allMonthly[wy];
                        annualTotals[wy] = allMonthly[wy].reduce((s, d) => s + (d.et || 0), 0);
                        hasData = true;
                    }
                }
            }
        } catch (err) {
            console.error("ET fetch failed:", err);
            // Don't return — raster data may still be available
        }
    }

    // Look up LandIQ raster data for this field (already in water year)
    const zonalData = findZonalData(geom);
    const zonalAnnual = {};   // wy → {mm, months, af}
    const zonalMonthly = {};  // wy → [{month, et_mm}]
    if (zonalData) {
        for (const [wy, nMonths, totalMm, af] of zonalData.ann) {
            zonalAnnual[wy] = { mm: totalMm, months: nMonths, af };
        }
        for (const [wy, mo, etMm] of zonalData.m) {
            if (!zonalMonthly[wy]) zonalMonthly[wy] = [];
            zonalMonthly[wy].push({ month: mo, et_mm: etMm });
        }
    }
    selectedField.zonalMonthly = zonalMonthly;

    if (!hasData && Object.keys(zonalAnnual).length === 0) {
        summaryEl.innerHTML = `<div class="error-msg">No ET data available for this location.</div>`;
        return;
    }

    // Render water year summary bars
    const allWYSet = new Set([...Object.keys(annualTotals).map(Number), ...Object.keys(zonalAnnual).map(Number)]);
    const allWYList = [...allWYSet].sort((a, b) => a - b);
    const maxET_in = Math.max(
        ...Object.values(annualTotals).map(v => mmToIn(v)),
        ...Object.values(zonalAnnual).map(v => mmToIn(v.mm)),
        1
    );
    let html = `<div class="annual-summary-title">Water Year ET Summary (Oct–Sep)</div>`;
    html += `<div style="display:flex;gap:16px;margin-bottom:8px;font-size:11px">
        <span style="color:#3b82f6">● OpenET API</span>
        <span style="color:#f59e0b">● LandIQ Raster</span>
    </div>`;
    const sortedWYs = [...allWYList].reverse();
    for (const wy of sortedWYs) {
        const api_mm = annualTotals[wy];
        const raster = zonalAnnual[wy];
        if (api_mm === undefined && !raster) continue;

        const api_in = api_mm !== undefined ? mmToIn(api_mm) : null;
        const api_af = api_in !== null ? etAcreFeet(api_in, acres) : null;
        const raster_in = raster ? mmToIn(raster.mm) : null;
        const raster_af = raster ? raster.af : null;

        const pctApi = api_in !== null ? (api_in / maxET_in * 100).toFixed(1) : 0;
        const pctRaster = raster_in !== null ? (raster_in / maxET_in * 100).toFixed(1) : 0;

        html += `<div class="annual-row">
            <span class="annual-year">WY ${wy}</span>
            <div class="annual-bar-bg" style="position:relative;height:12px">
                ${api_in !== null ? `<div class="annual-bar" style="width:${pctApi}%;background:#3b82f6;height:5px;position:absolute;top:0"></div>` : ''}
                ${raster_in !== null ? `<div class="annual-bar" style="width:${pctRaster}%;background:#f59e0b;height:5px;position:absolute;bottom:0"></div>` : ''}
            </div>
            <span class="annual-value">${api_in !== null ? api_in.toFixed(1) : '—'}</span>
            <span class="annual-af">${api_af !== null ? api_af.toFixed(2) + ' AF' : ''}${raster_af !== null ? (api_af !== null ? ' / ' : '') + raster_af.toFixed(2) + ' AF' : ''}</span>
        </div>`;
        if (raster && raster.months < 12) {
            html += `<div style="font-size:10px;color:#64748b;text-align:right;margin-top:-2px">${raster.months}/12 months raster</div>`;
        }
    }
    summaryEl.innerHTML = `<div class="annual-summary">${html}</div>`;

    // Show water year buttons
    yearSelector.style.display = "flex";
    yearSelector.innerHTML = `<label>Monthly Detail:</label>`;
    const chartWYSet = new Set([
        ...Object.keys(allMonthly).map(Number),
        ...Object.keys(zonalMonthly).map(Number),
    ]);
    const displayWYs = [...chartWYSet].sort((a, b) => b - a);
    for (const wy of displayWYs) {
        if (!allMonthly[wy] && !zonalMonthly[wy]) continue;
        const btn = document.createElement("button");
        btn.className = "year-btn";
        btn.textContent = `WY ${wy}`;
        btn.addEventListener("click", () => {
            document.querySelectorAll(".year-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderMonthlyChart(allMonthly[wy] || [], wy);
        });
        yearSelector.appendChild(btn);
    }

    // Auto-select most recent water year with data
    const latestWY = displayWYs.find(wy => allMonthly[wy] || zonalMonthly[wy]);
    if (latestWY) {
        const btns = yearSelector.querySelectorAll(".year-btn");
        btns.forEach(b => { if (b.textContent === `WY ${latestWY}`) b.click(); });
    }
}

/* ── Fetch ET from proxy ─────────────────────────────── */

async function fetchET(lng, lat, dateStart, dateEnd, geom) {
    const params = new URLSearchParams({ start: dateStart, end: dateEnd });

    let usePolygon = geom && geom.type && geom.coordinates;

    if (usePolygon) {
        // Simplify complex polygons to stay within URL/API limits
        const simplified = simplifyGeometry(geom);
        const geomStr = JSON.stringify(simplified);
        // Check URL length — fall back to point if too large
        if (geomStr.length > 4000) {
            console.warn(`Geometry too large (${geomStr.length} chars), falling back to point query`);
            usePolygon = false;
        } else {
            params.set("geom", geomStr);
            console.log(`Fetching ET (polygon avg): ${geomStr.length} chars`);
        }
    }

    if (!usePolygon) {
        params.set("lng", lng.toFixed(6));
        params.set("lat", lat.toFixed(6));
    }

    const url = PROXY_URL + '?' + params.toString();
    console.log("Fetching ET:", url.length, "chars", usePolygon ? "(polygon)" : "(point)");

    const resp = await fetch(url);

    if (!resp.ok) {
        const text = await resp.text();
        console.error("Proxy error:", resp.status, text.substring(0, 200));
        throw new Error(`Proxy returned ${resp.status}`);
    }

    const text = await resp.text();

    let result;
    try {
        result = JSON.parse(text);
    } catch (e) {
        console.error("Non-JSON response:", text.substring(0, 200));
        throw new Error("Proxy returned non-JSON response");
    }

    // If polygon query failed, retry with point
    if (!result.success && usePolygon) {
        console.warn("Polygon query failed, retrying with point:", result.data?.detail || result.status);
        const pointParams = new URLSearchParams({
            start: dateStart, end: dateEnd,
            lng: lng.toFixed(6), lat: lat.toFixed(6),
        });
        const pointUrl = PROXY_URL + '?' + pointParams.toString();
        const pointResp = await fetch(pointUrl);
        const pointText = await pointResp.text();
        try {
            result = JSON.parse(pointText);
        } catch (e) {
            throw new Error("Proxy returned non-JSON response");
        }
    }

    if (!result.success) {
        const detail = result.data?.detail || result.data?.message || JSON.stringify(result.data);
        throw new Error(result.error || `OpenET API error (${result.status}): ${detail}`);
    }

    return result.data;
}

/* ── Render monthly chart ────────────────────────────── */

// Water year order: Oct–Sep
const MONTH_LABELS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];
// Map calendar month (0-based) to water year month index (0-based)
function calMonthToWYIndex(calMonth) {
    return (calMonth + 3) % 12;  // Oct(9)→0, Nov(10)→1, ..., Sep(8)→11
}
// Water year for a calendar date: Oct-Dec → next year, Jan-Sep → same year
function getWaterYear(date) {
    const d = new Date(date);
    return d.getMonth() >= 9 ? d.getFullYear() + 1 : d.getFullYear();
}

function renderMonthlyChart(data, wy) {
    const chartTitle = document.getElementById("chart-title");
    const acres = selectedField ? selectedField.acres : 0;
    chartTitle.textContent = `Monthly ET — WY ${wy} (Oct ${wy-1} – Sep ${wy})`;

    // OpenET API data: map to water year month slots (Oct=0, Nov=1, ..., Sep=11)
    const values_in = new Array(12).fill(0);
    data.forEach(d => {
        const calMonth = new Date(d.time).getMonth(); // 0-based
        const wyIdx = calMonthToWYIndex(calMonth);
        values_in[wyIdx] = mmToIn(d.et || 0);
    });

    // LandIQ raster data for same water year
    const raster_in = new Array(12).fill(null);
    if (selectedField && selectedField.zonalMonthly && selectedField.zonalMonthly[wy]) {
        for (const m of selectedField.zonalMonthly[wy]) {
            const wyIdx = calMonthToWYIndex(m.month - 1); // m.month is 1-based
            raster_in[wyIdx] = mmToIn(m.et_mm);
        }
    }

    // Cumulative acre-feet for OpenET
    const cumAF_api = [];
    let runningAPI = 0;
    for (let i = 0; i < 12; i++) {
        runningAPI += etAcreFeet(values_in[i], acres);
        cumAF_api.push(runningAPI);
    }

    // Cumulative acre-feet for LandIQ raster
    const cumAF_raster = [];
    let runningRaster = 0;
    let hasRasterCum = false;
    for (let i = 0; i < 12; i++) {
        if (raster_in[i] !== null) {
            runningRaster += etAcreFeet(raster_in[i], acres);
            hasRasterCum = true;
        }
        cumAF_raster.push(hasRasterCum ? runningRaster : null);
    }

    const color = selectedField ? selectedField.color : "#3b82f6";
    const hasRaster = raster_in.some(v => v !== null);

    if (etChart) etChart.destroy();

    const datasets = [{
        label: "OpenET (in)",
        data: values_in,
        backgroundColor: color + "99",
        borderColor: color,
        borderWidth: 1,
        borderRadius: 4,
        yAxisID: "y",
    }];

    if (hasRaster) {
        datasets.push({
            label: "LandIQ Raster (in)",
            data: raster_in,
            backgroundColor: "#f59e0b66",
            borderColor: "#f59e0b",
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: "y",
        });
    }

    // Cumulative AF lines
    const hasApiData = values_in.some(v => v > 0);
    if (hasApiData) {
        datasets.push({
            label: "OpenET Cum. AF",
            data: cumAF_api,
            type: "line",
            borderColor: "#60a5fa",
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: "#60a5fa",
            tension: 0.3,
            yAxisID: "y1",
        });
    }

    if (hasRaster) {
        datasets.push({
            label: "LandIQ Cum. AF",
            data: cumAF_raster,
            type: "line",
            borderColor: "#fbbf24",
            backgroundColor: "transparent",
            borderWidth: 2,
            borderDash: [5, 3],
            pointRadius: 3,
            pointBackgroundColor: "#fbbf24",
            tension: 0.3,
            yAxisID: "y1",
        });
    }

    const ctx = document.getElementById("et-chart").getContext("2d");
    etChart = new Chart(ctx, {
        type: "bar",
        data: {
            labels: MONTH_LABELS,
            datasets,
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
                            if (ctx.dataset.label.includes("Cum. AF")) {
                                return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} AF`;
                            }
                            return `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} in`;
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
                    title: { display: true, text: "Cumulative AF", color: "#60a5fa", font: { size: 11 } },
                },
            },
        },
    });
}
