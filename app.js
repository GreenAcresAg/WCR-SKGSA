/* ── Well type classification ──────────────────────────── */

function classifyWell(use) {
    if (!use) return "other";
    const u = use.toLowerCase();
    if (u.includes("irrigation") && u.includes("agriculture")) return "irrigation";
    if (u.includes("domestic")) return "domestic";
    if (u.includes("public") || u.includes("industrial")) return "public";
    if (u.includes("monitoring")) return "monitoring";
    return "other";
}

const TYPE_COLORS = {
    irrigation: "#22c55e",
    domestic:   "#3b82f6",
    public:     "#a855f7",
    monitoring: "#f97316",
    other:      "#6b7280",
};

/* ── State ────────────────────────────────────────────── */

let map, allWells = [], filteredWells = [];
const activeTypes = new Set(["irrigation", "domestic", "public", "monitoring", "other"]);

/* ── Map init ─────────────────────────────────────────── */

map = new maplibregl.Map({
    container: "map",
    style: {
        version: 8,
        sources: {
            "satellite": {
                type: "raster",
                tiles: [
                    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                ],
                tileSize: 256,
                attribution: "Esri, Maxar, Earthstar Geographics",
                maxzoom: 19,
            },
            "labels": {
                type: "raster",
                tiles: [
                    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
                ],
                tileSize: 256,
                maxzoom: 19,
            },
            "roads": {
                type: "raster",
                tiles: [
                    "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"
                ],
                tileSize: 256,
                maxzoom: 19,
            },
        },
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

map.on("load", () => {
    loadGSA();
    loadCorcoranClay();
    loadCorcoranDepth();
    loadWells();
});

/* ── Load GSA boundary ────────────────────────────────── */

function loadGSA() {
    fetch("data/sfkgsa.geojson")
        .then(r => r.json())
        .then(data => {
            map.addSource("gsa", { type: "geojson", data });
            map.addLayer({
                id: "gsa-boundary",
                type: "line",
                source: "gsa",
                paint: {
                    "line-color": "#f59e0b",
                    "line-width": 3,
                    "line-opacity": 0.9,
                },
            });
            map.addLayer({
                id: "gsa-fill",
                type: "fill",
                source: "gsa",
                paint: {
                    "fill-color": "#f59e0b",
                    "fill-opacity": 0.05,
                },
            }, "gsa-boundary");
        });
}

/* ── Load Corcoran Clay depth contours ───────────────── */

function loadCorcoranClay() {
    fetch("data/corcoran_clay.geojson")
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(data => {
            map.addSource("corcoran-clay", { type: "geojson", data });

            map.addLayer({
                id: "corcoran-clay",
                type: "line",
                source: "corcoran-clay",
                layout: { visibility: "visible" },
                paint: {
                    "line-color": [
                        "interpolate", ["linear"], ["get", "THICKNESS"],
                        10,  "#93c5fd",
                        60,  "#3b82f6",
                        120, "#1d4ed8",
                        200, "#1e3a5f",
                    ],
                    "line-width": [
                        "interpolate", ["linear"], ["zoom"],
                        8, 1.5, 14, 3,
                    ],
                    "line-opacity": 0.8,
                },
            });

            // Labels on contour lines
            map.addLayer({
                id: "corcoran-clay-labels",
                type: "symbol",
                source: "corcoran-clay",
                layout: {
                    visibility: "visible",
                    "symbol-placement": "line",
                    "text-field": ["concat", ["to-string", ["get", "THICKNESS"]], " ft"],
                    "text-size": 11,
                    "text-offset": [0, -0.8],
                    "symbol-spacing": 300,
                    "text-allow-overlap": false,
                },
                paint: {
                    "text-color": "#bfdbfe",
                    "text-halo-color": "rgba(0,0,0,0.7)",
                    "text-halo-width": 1.5,
                },
            });
        })
        .catch(err => console.error("Corcoran Clay load error:", err));
}

/* ── Load Corcoran Clay depth (top of clay) contours ─── */

function loadCorcoranDepth() {
    fetch("data/corcoran_depth.geojson")
        .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(data => {
            map.addSource("corcoran-depth", { type: "geojson", data });

            map.addLayer({
                id: "corcoran-depth",
                type: "line",
                source: "corcoran-depth",
                layout: { visibility: "visible" },
                paint: {
                    "line-color": [
                        "interpolate", ["linear"], ["get", "COR_DEPTH"],
                        50,  "#fca5a5",
                        250, "#ef4444",
                        500, "#b91c1c",
                        900, "#7f1d1d",
                    ],
                    "line-width": [
                        "interpolate", ["linear"], ["zoom"],
                        8, 1.5, 14, 3,
                    ],
                    "line-opacity": 0.8,
                },
            });

            map.addLayer({
                id: "corcoran-depth-labels",
                type: "symbol",
                source: "corcoran-depth",
                layout: {
                    visibility: "visible",
                    "symbol-placement": "line",
                    "text-field": ["concat", ["to-string", ["get", "COR_DEPTH"]], " ft"],
                    "text-size": 11,
                    "text-offset": [0, -0.8],
                    "symbol-spacing": 300,
                    "text-allow-overlap": false,
                },
                paint: {
                    "text-color": "#fecaca",
                    "text-halo-color": "rgba(0,0,0,0.7)",
                    "text-halo-width": 1.5,
                },
            });
        })
        .catch(err => console.error("Corcoran Depth load error:", err));
}

/* ── Load and parse wells CSV ─────────────────────────── */

function loadWells() {
    Papa.parse("data/wells.csv", {
        download: true,
        header: true,
        skipEmptyLines: true,
        complete: function(results) {
            allWells = results.data
                .filter(r => r.latitude && r.longitude && !isNaN(+r.latitude))
                .map(r => {
                    const permitMs = parseInt(r.PermitDate);
                    return {
                        ...r,
                        lat: +r.latitude,
                        lng: +r.longitude,
                        depth: r.TotalCompletedDepth ? +r.TotalCompletedDepth : null,
                        wellType: classifyWell(r.PlannedUseFormerUse),
                        permitYear: permitMs ? new Date(permitMs).getFullYear() : null,
                    };
                });

            populateFilters();
            applyFilters();
        },
    });
}

/* ── Populate filter dropdowns ────────────────────────── */

function populateFilters() {
    const uses = [...new Set(allWells.map(w => w.PlannedUseFormerUse).filter(Boolean))].sort();
    const townships = [...new Set(allWells.map(w => w.Township).filter(Boolean))].sort();
    const ranges = [...new Set(allWells.map(w => w.Range).filter(Boolean))].sort();
    const sections = [...new Set(allWells.map(w => w.Section).filter(Boolean))].sort();

    fillSelect("filter-use", uses);
    fillSelect("filter-township", townships);
    fillSelect("filter-range", ranges);
    fillSelect("filter-section", sections);
}

function fillSelect(id, values) {
    const sel = document.getElementById(id);
    values.forEach(v => {
        const opt = document.createElement("option");
        opt.value = v;
        opt.textContent = v;
        sel.appendChild(opt);
    });
}

/* ── Filter logic ─────────────────────────────────────── */

function getFilterState() {
    return {
        use:       document.getElementById("filter-use").value,
        township:  document.getElementById("filter-township").value,
        range:     document.getElementById("filter-range").value,
        section:   document.getElementById("filter-section").value,
        depthMin:  document.getElementById("filter-depth-min").value,
        depthMax:  document.getElementById("filter-depth-max").value,
        yearMin:   document.getElementById("filter-year-min").value,
        yearMax:   document.getElementById("filter-year-max").value,
    };
}

function applyFilters() {
    const f = getFilterState();

    filteredWells = allWells.filter(w => {
        if (!activeTypes.has(w.wellType)) return false;
        if (f.use && w.PlannedUseFormerUse !== f.use) return false;
        if (f.township && w.Township !== f.township) return false;
        if (f.range && w.Range !== f.range) return false;
        if (f.section && w.Section !== f.section) return false;
        if (f.depthMin && (w.depth === null || w.depth < +f.depthMin)) return false;
        if (f.depthMax && (w.depth === null || w.depth > +f.depthMax)) return false;
        if (f.yearMin && (w.permitYear === null || w.permitYear < +f.yearMin)) return false;
        if (f.yearMax && (w.permitYear === null || w.permitYear > +f.yearMax)) return false;
        return true;
    });

    const geojson = wellsToGeoJSON(filteredWells);
    updateMap(geojson);
    updateCounts(filteredWells);
    closeDetailPanel();
}

function wellsToGeoJSON(wells) {
    return {
        type: "FeatureCollection",
        features: wells.map(w => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: [w.lng, w.lat] },
            properties: {
                WCRNumber: w.WCRNumber,
                use: w.PlannedUseFormerUse || "Unknown",
                wellType: w.wellType,
                depth: w.depth,
                township: w.Township,
                range: w.Range,
                section: w.Section,
                mtrs: w.MTRS,
                permitYear: w.permitYear,
                box_link: w.box_link || "",
                color: TYPE_COLORS[w.wellType],
            },
        })),
    };
}

/* ── Update map layers ────────────────────────────────── */

function updateMap(geojson) {
    if (map.getSource("wells")) {
        map.getSource("wells").setData(geojson);
    } else {
        map.addSource("wells", {
            type: "geojson",
            data: geojson,
            cluster: true,
            clusterMaxZoom: 16,
            clusterRadius: 40,
        });

        // Heatmap layer (rendered BELOW clusters so it doesn't block clicks)
        map.addSource("wells-heat-src", { type: "geojson", data: geojson });
        map.addLayer({
            id: "wells-heat",
            type: "heatmap",
            source: "wells-heat-src",
            maxzoom: 15,
            paint: {
                "heatmap-weight": [
                    "interpolate", ["linear"],
                    ["coalesce", ["get", "depth"], 100],
                    0, 0.2, 500, 0.8, 2000, 1
                ],
                "heatmap-intensity": [
                    "interpolate", ["linear"], ["zoom"],
                    8, 0.5, 13, 1.5,
                ],
                "heatmap-radius": [
                    "interpolate", ["linear"], ["zoom"],
                    8, 8, 13, 20, 15, 30,
                ],
                "heatmap-color": [
                    "interpolate", ["linear"], ["heatmap-density"],
                    0,   "rgba(0,0,0,0)",
                    0.1, "rgba(0,255,128,0.3)",
                    0.3, "rgba(0,255,0,0.5)",
                    0.5, "rgba(128,255,0,0.6)",
                    0.7, "rgba(255,255,0,0.7)",
                    0.9, "rgba(255,128,0,0.8)",
                    1,   "rgba(255,0,0,0.9)",
                ],
                "heatmap-opacity": [
                    "interpolate", ["linear"], ["zoom"],
                    10, 0.8, 15, 0.4,
                ],
            },
        });

        // Individual well points (unclustered) — above heatmap, below clusters
        map.addLayer({
            id: "wells-points",
            type: "circle",
            source: "wells",
            filter: ["!", ["has", "point_count"]],
            paint: {
                "circle-radius": [
                    "interpolate", ["linear"], ["zoom"],
                    10, 2, 14, 5, 17, 8,
                ],
                "circle-color": ["get", "color"],
                "circle-stroke-width": 1.5,
                "circle-stroke-color": "rgba(255,255,255,0.5)",
                "circle-opacity": 0.9,
            },
        });

        // Cluster circles — rendered ON TOP of heatmap so they're clickable
        map.addLayer({
            id: "clusters",
            type: "circle",
            source: "wells",
            filter: ["has", "point_count"],
            paint: {
                "circle-color": [
                    "step", ["get", "point_count"],
                    "#3b82f6",   // < 10: blue
                    10, "#f59e0b", // 10-50: amber
                    50, "#ef4444", // 50+: red
                ],
                "circle-radius": [
                    "step", ["get", "point_count"],
                    12, 10, 16, 50, 20,
                ],
                "circle-stroke-width": 2,
                "circle-stroke-color": "rgba(255,255,255,0.6)",
            },
        });

        // Cluster count labels — topmost layer
        map.addLayer({
            id: "cluster-count",
            type: "symbol",
            source: "wells",
            filter: ["has", "point_count"],
            layout: {
                "text-field": ["get", "point_count_abbreviated"],
                "text-size": 12,
            },
            paint: {
                "text-color": "#ffffff",
                "text-halo-color": "rgba(0,0,0,0.5)",
                "text-halo-width": 1,
            },
        });
    }

    // Keep heatmap source in sync (it's separate because clusters break heatmap)
    if (map.getSource("wells-heat-src")) {
        map.getSource("wells-heat-src").setData(geojson);
    }
}

function updateCounts(filtered) {
    const counts = { irrigation: 0, domestic: 0, public: 0, monitoring: 0, other: 0 };
    filtered.forEach(w => counts[w.wellType]++);

    Object.keys(counts).forEach(t => {
        const el = document.getElementById("count-" + t);
        if (el) el.textContent = counts[t].toLocaleString();
    });

    document.getElementById("well-count").textContent = filtered.length.toLocaleString();
}

/* ── Find all wells at a coordinate (same location) ──── */

function findWellsAtLocation(lng, lat, radius) {
    // radius in degrees — ~0.0001 is roughly 10m
    const r = radius || 0.0002;
    return filteredWells.filter(w =>
        Math.abs(w.lng - lng) < r && Math.abs(w.lat - lat) < r
    );
}

/* ── Detail panel (shows all wells at a clicked point) ── */

function showDetailPanel(wells, lng, lat) {
    const panel = document.getElementById("detail-panel");
    const list = document.getElementById("detail-list");
    const countEl = document.getElementById("detail-count");

    countEl.textContent = wells.length === 1
        ? "1 well at this location"
        : `${wells.length} wells at this location`;

    list.innerHTML = wells.map(w => {
        const typeColor = TYPE_COLORS[w.wellType];
        const depthStr = w.depth ? `${w.depth} ft` : "—";
        const yearStr = w.permitYear || "—";
        const linkHtml = w.box_link
            ? `<a href="${w.box_link}" target="_blank" class="detail-report-link">View WCR Report</a>`
            : `<span class="detail-no-link">No report available</span>`;

        return `
            <div class="detail-well">
                <div class="detail-well-header">
                    <span class="detail-dot" style="background:${typeColor}"></span>
                    <strong>${w.WCRNumber}</strong>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Use</span>
                    <span class="detail-value">${w.PlannedUseFormerUse || "Unknown"}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Depth</span>
                    <span class="detail-value">${depthStr}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">MTRS</span>
                    <span class="detail-value">${w.MTRS || "—"}</span>
                </div>
                <div class="detail-row">
                    <span class="detail-label">Permit Year</span>
                    <span class="detail-value">${yearStr}</span>
                </div>
                ${linkHtml}
            </div>
        `;
    }).join("");

    panel.classList.remove("hidden");
}

function closeDetailPanel() {
    document.getElementById("detail-panel").classList.add("hidden");
}

/* ── Event listeners ──────────────────────────────────── */

// Layer visibility toggles
document.querySelectorAll("[data-layer]").forEach(cb => {
    cb.addEventListener("change", () => {
        const layerId = cb.dataset.layer;
        const vis = cb.checked ? "visible" : "none";

        if (layerId === "wells-points") {
            // Toggle both points and clusters together
            ["wells-points", "clusters", "cluster-count"].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
            });
        } else if (layerId === "corcoran-clay") {
            ["corcoran-clay", "corcoran-clay-labels"].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
            });
        } else if (layerId === "corcoran-depth") {
            ["corcoran-depth", "corcoran-depth-labels"].forEach(id => {
                if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
            });
        } else if (layerId === "gsa-boundary") {
            if (map.getLayer("gsa-boundary")) map.setLayoutProperty("gsa-boundary", "visibility", vis);
            if (map.getLayer("gsa-fill")) map.setLayoutProperty("gsa-fill", "visibility", vis);
        } else {
            if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis);
        }
    });
});

// Well type sub-toggles
document.querySelectorAll("[data-welltype]").forEach(cb => {
    cb.addEventListener("change", () => {
        if (cb.checked) activeTypes.add(cb.dataset.welltype);
        else activeTypes.delete(cb.dataset.welltype);
        applyFilters();
    });
});

// Filter controls
["filter-use", "filter-township", "filter-range", "filter-section"].forEach(id => {
    document.getElementById(id).addEventListener("change", applyFilters);
});

["filter-depth-min", "filter-depth-max", "filter-year-min", "filter-year-max"].forEach(id => {
    document.getElementById(id).addEventListener("input", debounce(applyFilters, 300));
});

// Clear filters
document.getElementById("clear-filters").addEventListener("click", () => {
    document.querySelectorAll(".filter-control").forEach(el => {
        if (el.tagName === "SELECT") el.selectedIndex = 0;
        else el.value = "";
    });
    document.querySelectorAll("[data-welltype]").forEach(cb => {
        cb.checked = true;
        activeTypes.add(cb.dataset.welltype);
    });
    applyFilters();
});

// Close detail panel
document.getElementById("detail-close").addEventListener("click", closeDetailPanel);

/* ── Single click handler for all map interactions ─────── */

map.on("click", async (e) => {
    // Check clusters first
    const clusterFeatures = map.queryRenderedFeatures(e.point, { layers: ["clusters"] });
    if (clusterFeatures.length > 0) {
        const cluster = clusterFeatures[0];
        const clusterId = cluster.properties.cluster_id;
        const source = map.getSource("wells");
        const coords = cluster.geometry.coordinates;
        const pointCount = cluster.properties.point_count;

        try {
            const zoom = await source.getClusterExpansionZoom(clusterId);

            if (zoom >= 16 || map.getZoom() >= 15) {
                // At max zoom — show all wells in detail panel
                const leaves = await source.getClusterLeaves(clusterId, pointCount, 0);
                const wcrNumbers = new Set(leaves.map(l => l.properties.WCRNumber));
                const wells = filteredWells.filter(w => wcrNumbers.has(w.WCRNumber));
                if (wells.length > 0) showDetailPanel(wells, coords[0], coords[1]);
            } else {
                map.easeTo({ center: coords, zoom: zoom });
            }
        } catch (err) {
            // Fallback: just zoom in toward the cluster
            map.easeTo({ center: coords, zoom: map.getZoom() + 2 });
        }
        return;
    }

    // Check individual well points
    const pointFeatures = map.queryRenderedFeatures(e.point, { layers: ["wells-points"] });
    if (pointFeatures.length > 0) {
        const coords = pointFeatures[0].geometry.coordinates;
        const wells = findWellsAtLocation(coords[0], coords[1]);
        if (wells.length > 0) showDetailPanel(wells, coords[0], coords[1]);
        return;
    }

    // Clicked on empty space — close panel
    closeDetailPanel();
});

/* ── Hover: cursor changes ────────────────────────────── */

map.on("mouseenter", "clusters", () => {
    map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "clusters", () => {
    map.getCanvas().style.cursor = "";
    popup.classList.add("hidden");
});
map.on("mousemove", "clusters", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const count = e.features[0].properties.point_count;
    popup.innerHTML = `<div class="popup-title">${count} wells in this area</div><div class="popup-hint">Click to expand</div>`;
    popup.classList.remove("hidden");
    popup.style.left = (e.originalEvent.clientX + 12) + "px";
    popup.style.top = (e.originalEvent.clientY - 12) + "px";
});

const popup = document.getElementById("popup");

map.on("mousemove", "wells-points", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const coords = e.features[0].geometry.coordinates;
    const wells = findWellsAtLocation(coords[0], coords[1]);
    const p = e.features[0].properties;

    let html = "";
    if (wells.length > 1) {
        html = `<div class="popup-title">${wells.length} wells at this location</div>`;
        html += `<div class="popup-hint">Click to view all reports</div>`;
        wells.slice(0, 4).forEach(w => {
            html += `<div class="popup-row"><span class="popup-label">${w.WCRNumber}</span><span class="popup-value">${w.PlannedUseFormerUse || "Unknown"}</span></div>`;
        });
        if (wells.length > 4) {
            html += `<div class="popup-hint">+ ${wells.length - 4} more...</div>`;
        }
    } else {
        html = `<div class="popup-title">${p.WCRNumber}</div>`;
        html += `<div class="popup-row"><span class="popup-label">Use</span><span class="popup-value">${p.use}</span></div>`;
        if (p.depth) html += `<div class="popup-row"><span class="popup-label">Depth</span><span class="popup-value">${p.depth} ft</span></div>`;
        html += `<div class="popup-row"><span class="popup-label">MTRS</span><span class="popup-value">${p.mtrs || "—"}</span></div>`;
        if (p.permitYear) html += `<div class="popup-row"><span class="popup-label">Permit Year</span><span class="popup-value">${p.permitYear}</span></div>`;
        html += `<div class="popup-hint">Click to view details</div>`;
    }

    popup.innerHTML = html;
    popup.classList.remove("hidden");
    popup.style.left = (e.originalEvent.clientX + 12) + "px";
    popup.style.top = (e.originalEvent.clientY - 12) + "px";
});

// Corcoran Clay Depth hover
map.on("mousemove", "corcoran-depth", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const depth = e.features[0].properties.COR_DEPTH;
    popup.innerHTML = `<div class="popup-title">Corcoran Clay Depth</div><div class="popup-row"><span class="popup-label">Depth to Top</span><span class="popup-value">${depth} ft</span></div>`;
    popup.classList.remove("hidden");
    popup.style.left = (e.originalEvent.clientX + 12) + "px";
    popup.style.top = (e.originalEvent.clientY - 12) + "px";
});
map.on("mouseleave", "corcoran-depth", () => {
    map.getCanvas().style.cursor = "";
    popup.classList.add("hidden");
});

// Corcoran Clay Thickness hover
map.on("mousemove", "corcoran-clay", (e) => {
    map.getCanvas().style.cursor = "pointer";
    const thickness = e.features[0].properties.THICKNESS;
    popup.innerHTML = `<div class="popup-title">Corcoran Clay Thickness</div><div class="popup-row"><span class="popup-label">Thickness</span><span class="popup-value">${thickness} ft</span></div>`;
    popup.classList.remove("hidden");
    popup.style.left = (e.originalEvent.clientX + 12) + "px";
    popup.style.top = (e.originalEvent.clientY - 12) + "px";
});
map.on("mouseleave", "corcoran-clay", () => {
    map.getCanvas().style.cursor = "";
    popup.classList.add("hidden");
});

map.on("mouseleave", "wells-points", () => {
    map.getCanvas().style.cursor = "";
    popup.classList.add("hidden");
});

/* ── Fullscreen toggle ───────────────────────────────── */

const fsBtn = document.getElementById("fullscreen-btn");
const fsExpand = document.getElementById("fs-expand");
const fsCollapse = document.getElementById("fs-collapse");

fsBtn.addEventListener("click", () => {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(() => {});
    } else {
        document.exitFullscreen();
    }
});

document.addEventListener("fullscreenchange", () => {
    const isFs = !!document.fullscreenElement;
    fsExpand.style.display = isFs ? "none" : "block";
    fsCollapse.style.display = isFs ? "block" : "none";
    setTimeout(() => map.resize(), 100);
});

/* ── Basemap selector ────────────────────────────────── */

const BASEMAPS = {
    satellite: {
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        labels: false,
        attribution: "Esri, Maxar, Earthstar Geographics",
    },
    hybrid: {
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        labels: true,
        attribution: "Esri, Maxar, Earthstar Geographics",
    },
    usgs: {
        tiles: ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}"],
        labels: false,
        attribution: "USGS",
    },
    streets: {
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        labels: false,
        attribution: "&copy; OpenStreetMap contributors",
    },
};

let currentBasemap = "hybrid";

document.getElementById("basemap-btn").addEventListener("click", () => {
    document.getElementById("basemap-menu").classList.toggle("hidden");
});

// Close menu when clicking elsewhere
document.addEventListener("click", (e) => {
    if (!e.target.closest(".basemap-selector")) {
        document.getElementById("basemap-menu").classList.add("hidden");
    }
});

document.querySelectorAll(".basemap-option").forEach(opt => {
    opt.addEventListener("click", () => {
        const id = opt.dataset.basemap;
        if (id === currentBasemap) return;

        currentBasemap = id;
        const bm = BASEMAPS[id];

        // Update satellite/base tiles
        const src = map.getSource("satellite");
        if (src) {
            src.setTiles(bm.tiles);
            if (bm.attribution) src.setAttribution(bm.attribution);
        }

        // Toggle reference labels and roads
        if (map.getLayer("labels")) {
            map.setLayoutProperty("labels", "visibility", bm.labels ? "visible" : "none");
        }
        if (map.getLayer("roads")) {
            map.setLayoutProperty("roads", "visibility", bm.labels ? "visible" : "none");
        }

        // Update active state
        document.querySelectorAll(".basemap-option").forEach(o => o.classList.remove("active"));
        opt.classList.add("active");

        document.getElementById("basemap-menu").classList.add("hidden");
    });
});

/* ── Utility ──────────────────────────────────────────── */

function debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

/* ── Sidebar toggle ───────────────────────────────────── */

const sidebarToggle = document.getElementById("sidebar-toggle");
const sidebar = document.getElementById("sidebar");

sidebarToggle.addEventListener("click", () => {
    sidebar.classList.toggle("sidebar-closed");
    sidebar.classList.toggle("sidebar-open");
    // Let map resize to fill space
    setTimeout(() => map.resize(), 300);
});

// Auto-collapse sidebar in small viewports (embedded iframe)
function checkSidebarFit() {
    if (window.innerWidth < 900) {
        sidebarToggle.classList.add("visible");
        if (sidebar.classList.contains("sidebar-open")) {
            sidebar.classList.remove("sidebar-open");
            sidebar.classList.add("sidebar-closed");
            setTimeout(() => map.resize(), 300);
        }
    } else {
        sidebarToggle.classList.remove("visible");
        sidebar.classList.remove("sidebar-closed");
        sidebar.classList.add("sidebar-open");
        setTimeout(() => map.resize(), 300);
    }
}

checkSidebarFit();
window.addEventListener("resize", debounce(checkSidebarFit, 200));
