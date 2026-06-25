/**
 * WCR Well Editor
 *
 * Replace API_URL with your deployed Google Apps Script web app URL.
 */

const API_URL = 'YOUR_APPS_SCRIPT_URL_HERE';

/* ── State ────────────────────────────────────────────── */

let map, allWells = [], selectedWell = null, relocateMode = false;
let currentFilter = 'all';

const STATUS_COLORS = {
    unreviewed: '#6b7280',
    verified:   '#22c55e',
    relocated:  '#3b82f6',
    inactive:   '#ef4444',
    not_found:  '#f97316',
};

/* ── Map init ─────────────────────────────────────────── */

map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            satellite: {
                type: 'raster',
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                attribution: 'Esri, Maxar, Earthstar Geographics',
                maxzoom: 19,
            },
            roads: {
                type: 'raster',
                tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 19,
            },
            labels: {
                type: 'raster',
                tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}'],
                tileSize: 256,
                maxzoom: 19,
            },
        },
        layers: [
            { id: 'satellite', type: 'raster', source: 'satellite' },
            { id: 'roads', type: 'raster', source: 'roads', paint: { 'raster-opacity': 0.8 } },
            { id: 'labels', type: 'raster', source: 'labels', paint: { 'raster-opacity': 0.7 } },
        ],
    },
    center: [-119.81, 36.28],
    zoom: 11,
    maxZoom: 18,
});

map.addControl(new maplibregl.NavigationControl(), 'top-right');

map.on('load', () => {
    loadGSA();
    loadWells();
});

/* ── Load GSA boundary ────────────────────────────────── */

function loadGSA() {
    fetch('data/sfkgsa.geojson')
        .then(r => r.json())
        .then(data => {
            map.addSource('gsa', { type: 'geojson', data });
            map.addLayer({
                id: 'gsa-boundary',
                type: 'line',
                source: 'gsa',
                paint: { 'line-color': '#f59e0b', 'line-width': 3, 'line-opacity': 0.9 },
            });
            map.addLayer({
                id: 'gsa-fill',
                type: 'fill',
                source: 'gsa',
                paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.05 },
            }, 'gsa-boundary');
        });
}

/* ── Load wells from Google Sheets API ────────────────── */

function loadWells() {
    fetch(API_URL)
        .then(r => r.json())
        .then(result => {
            if (!result.success) throw new Error(result.error);

            allWells = result.data
                .filter(r => r.latitude && r.longitude)
                .map(r => ({
                    ...r,
                    lat: +r.latitude,
                    lng: +r.longitude,
                    reviewedLat: r.reviewed_latitude ? +r.reviewed_latitude : null,
                    reviewedLng: r.reviewed_longitude ? +r.reviewed_longitude : null,
                    depth: r.TotalCompletedDepth ? +r.TotalCompletedDepth : null,
                    status: r.review_status || 'unreviewed',
                    notes: r.review_notes || '',
                    reviewedBy: r.reviewed_by || '',
                    reviewedDate: r.reviewed_date || '',
                    screenIntervals: r.screen_intervals || '',
                    zoneClassification: r.zone_classification || '',
                }));

            updateStats();
            renderWellList();
            updateMapSource();
        })
        .catch(err => {
            console.error('Failed to load wells:', err);
            showToast('Failed to load well data: ' + err.message, 'error');
        });
}

/* ── Map source/layers ────────────────────────────────── */

function wellsToGeoJSON(wells) {
    return {
        type: 'FeatureCollection',
        features: wells.map(w => {
            const displayLat = w.reviewedLat || w.lat;
            const displayLng = w.reviewedLng || w.lng;
            return {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [displayLng, displayLat] },
                properties: {
                    WCRNumber: w.WCRNumber,
                    status: w.status,
                    color: STATUS_COLORS[w.status] || STATUS_COLORS.unreviewed,
                    use: w.PlannedUseFormerUse || 'Unknown',
                    origLat: w.lat,
                    origLng: w.lng,
                },
            };
        }),
    };
}

function updateMapSource() {
    const geojson = wellsToGeoJSON(getFilteredWells());

    if (map.getSource('wells')) {
        map.getSource('wells').setData(geojson);
    } else {
        map.addSource('wells', { type: 'geojson', data: geojson });

        map.addLayer({
            id: 'wells-points',
            type: 'circle',
            source: 'wells',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6, 17, 10],
                'circle-color': ['get', 'color'],
                'circle-stroke-width': 2,
                'circle-stroke-color': 'rgba(255,255,255,0.6)',
                'circle-opacity': 0.9,
            },
        });

        // Original location markers (small hollow circles, shown when well has been relocated)
        map.addLayer({
            id: 'wells-original',
            type: 'circle',
            source: 'wells',
            filter: ['==', ['get', 'status'], 'relocated'],
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 2, 14, 4, 17, 6],
                'circle-color': 'transparent',
                'circle-stroke-width': 1.5,
                'circle-stroke-color': '#ef4444',
                'circle-opacity': 0.6,
            },
        });

        // Selected well highlight
        map.addSource('selected-well', {
            type: 'geojson',
            data: { type: 'FeatureCollection', features: [] },
        });
        map.addLayer({
            id: 'selected-highlight',
            type: 'circle',
            source: 'selected-well',
            paint: {
                'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 8, 14, 12, 17, 16],
                'circle-color': 'transparent',
                'circle-stroke-width': 3,
                'circle-stroke-color': '#facc15',
            },
        });
    }
}

function highlightWell(well) {
    if (!well) {
        map.getSource('selected-well').setData({ type: 'FeatureCollection', features: [] });
        return;
    }
    const displayLat = well.reviewedLat || well.lat;
    const displayLng = well.reviewedLng || well.lng;
    map.getSource('selected-well').setData({
        type: 'FeatureCollection',
        features: [{
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [displayLng, displayLat] },
            properties: {},
        }],
    });
}

/* ── Stats ────────────────────────────────────────────── */

function updateStats() {
    const counts = { unreviewed: 0, verified: 0, relocated: 0, inactive: 0, not_found: 0 };
    allWells.forEach(w => {
        const s = w.status || 'unreviewed';
        if (counts[s] !== undefined) counts[s]++;
        else counts.unreviewed++;
    });

    document.getElementById('total-count').textContent = allWells.length + ' wells';

    const bar = document.getElementById('stats-bar');
    bar.innerHTML = Object.entries(counts).map(([key, val]) =>
        `<div class="stat">
            <span class="stat-dot" style="background:${STATUS_COLORS[key]}"></span>
            <span class="stat-count">${val}</span>
            <span>${key}</span>
        </div>`
    ).join('');
}

/* ── Well list ────────────────────────────────────────── */

function getFilteredWells() {
    if (currentFilter === 'all') return allWells;
    return allWells.filter(w => (w.status || 'unreviewed') === currentFilter);
}

function renderWellList() {
    const wells = getFilteredWells();
    const list = document.getElementById('well-list');

    list.innerHTML = wells.map(w => {
        const status = w.status || 'unreviewed';
        const isSelected = selectedWell && selectedWell.WCRNumber === w.WCRNumber;
        return `
            <div class="well-card ${isSelected ? 'selected' : ''}"
                 data-wcr="${w.WCRNumber}"
                 onclick="selectWell('${w.WCRNumber}')">
                <div class="well-card-header">
                    <span class="well-card-title">${w.WCRNumber}</span>
                    <span class="status-badge status-${status}">${status.replace('_', ' ')}</span>
                </div>
                <div class="well-card-meta">
                    ${w.PlannedUseFormerUse || 'Unknown'} &middot;
                    ${w.depth ? w.depth + ' ft' : 'No depth'} &middot;
                    ${w.MTRS || 'No MTRS'}
                    ${w.zoneClassification ? ' &middot; ' + w.zoneClassification : ''}
                </div>
            </div>`;
    }).join('');
}

/* ── Select a well ────────────────────────────────────── */

function selectWell(wcrNumber) {
    selectedWell = allWells.find(w => w.WCRNumber === wcrNumber) || null;

    const section = document.getElementById('detail-section');
    if (!selectedWell) {
        section.classList.add('hidden');
        highlightWell(null);
        renderWellList();
        return;
    }

    section.classList.remove('hidden');

    const w = selectedWell;
    const displayLat = w.reviewedLat || w.lat;
    const displayLng = w.reviewedLng || w.lng;

    document.getElementById('detail-title').textContent = w.WCRNumber;

    document.getElementById('detail-info').innerHTML = `
        <div class="detail-row">
            <span class="detail-label">Use</span>
            <span class="detail-value">${w.PlannedUseFormerUse || 'Unknown'}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Depth</span>
            <span class="detail-value">${w.depth ? w.depth + ' ft' : '—'}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">MTRS</span>
            <span class="detail-value">${w.MTRS || '—'}</span>
        </div>
        <div class="detail-row">
            <span class="detail-label">Original Coords</span>
            <span class="detail-value">${w.lat.toFixed(6)}, ${w.lng.toFixed(6)}</span>
        </div>
        ${w.reviewedLat ? `
        <div class="detail-row">
            <span class="detail-label">Reviewed Coords</span>
            <span class="detail-value">${w.reviewedLat.toFixed(6)}, ${w.reviewedLng.toFixed(6)}</span>
        </div>` : ''}
        ${w.reviewedBy ? `
        <div class="detail-row">
            <span class="detail-label">Reviewed By</span>
            <span class="detail-value">${w.reviewedBy}</span>
        </div>` : ''}

        <div style="margin-top:10px">
            ${w.box_link ? `<a href="${w.box_link}" target="_blank" class="view-wcr-link">View WCR Report</a>` : '<span style="font-size:11px;color:#64748b;font-style:italic">No report available</span>'}
        </div>

        <div style="margin-top:12px">
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Status</label>
            <select class="status-select" id="status-select" onchange="markStatus()">
                <option value="unreviewed" ${w.status === 'unreviewed' ? 'selected' : ''}>Unreviewed</option>
                <option value="verified" ${w.status === 'verified' ? 'selected' : ''}>Verified — Location Correct</option>
                <option value="relocated" ${w.status === 'relocated' ? 'selected' : ''}>Relocated — Moved to Correct Spot</option>
                <option value="inactive" ${w.status === 'inactive' ? 'selected' : ''}>Inactive — Well No Longer in Service</option>
                <option value="not_found" ${w.status === 'not_found' ? 'selected' : ''}>Not Found — Cannot Locate</option>
            </select>
        </div>

        <div style="margin-top:8px">
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Zone Classification</label>
            <select class="status-select" id="zone-select">
                <option value="" ${!w.zoneClassification ? 'selected' : ''}>— Select Zone —</option>
                <option value="A Zone (Upper)" ${w.zoneClassification === 'A Zone (Upper)' ? 'selected' : ''}>A Zone — Upper</option>
                <option value="B Zone (Mid)" ${w.zoneClassification === 'B Zone (Mid)' ? 'selected' : ''}>B Zone — Mid</option>
                <option value="C Zone (Lower Confined)" ${w.zoneClassification === 'C Zone (Lower Confined)' ? 'selected' : ''}>C Zone — Lower Confined</option>
                <option value="Composite" ${w.zoneClassification === 'Composite' ? 'selected' : ''}>Composite</option>
            </select>
        </div>

        <div style="margin-top:8px">
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Screen Intervals (ft)</label>
            <div id="screen-intervals-list"></div>
            <button class="btn" style="font-size:11px;padding:4px 10px;margin-top:4px" onclick="addScreenInterval()">+ Add Interval</button>
        </div>

        <div style="margin-top:8px">
            <label style="font-size:11px;color:#94a3b8;display:block;margin-bottom:4px">Notes</label>
            <textarea class="notes-input" id="notes-input" placeholder="Add review notes...">${w.notes || ''}</textarea>
        </div>
    `;

    document.getElementById('detail-actions').innerHTML = `
        <button class="btn btn-primary" onclick="startRelocate()">Relocate</button>
        <button class="btn btn-success" onclick="saveWell()">Save Changes</button>
    `;

    // Populate screen intervals
    renderScreenIntervals(w.screenIntervals);

    highlightWell(w);
    renderWellList();

    // Fly to the well
    map.flyTo({ center: [displayLng, displayLat], zoom: Math.max(map.getZoom(), 15) });
}

/* ── Screen intervals ────────────────────────────────── */

function parseIntervals(str) {
    if (!str) return [];
    return String(str).split(';').map(s => s.trim()).filter(Boolean).map(s => {
        const parts = s.split('-').map(p => p.trim());
        return { top: parts[0] || '', bottom: parts[1] || '' };
    });
}

function renderScreenIntervals(str) {
    const intervals = parseIntervals(str);
    if (intervals.length === 0) intervals.push({ top: '', bottom: '' });
    const container = document.getElementById('screen-intervals-list');
    container.innerHTML = intervals.map((iv, i) => `
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px" data-interval="${i}">
            <input type="number" class="si-top" placeholder="Top" value="${iv.top}"
                   style="width:80px;padding:4px 6px;font-size:12px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;outline:none">
            <span style="color:#64748b;font-size:12px">to</span>
            <input type="number" class="si-bottom" placeholder="Bottom" value="${iv.bottom}"
                   style="width:80px;padding:4px 6px;font-size:12px;background:#0f172a;border:1px solid #334155;border-radius:4px;color:#e2e8f0;outline:none">
            <span style="color:#64748b;font-size:11px">ft</span>
            ${intervals.length > 1 ? `<button onclick="removeScreenInterval(${i})" style="background:none;border:none;color:#ef4444;cursor:pointer;font-size:16px;padding:0 4px">&times;</button>` : ''}
        </div>
    `).join('');
}

function addScreenInterval() {
    const current = collectScreenIntervals();
    current.push({ top: '', bottom: '' });
    const str = current.filter(iv => iv.top || iv.bottom).map(iv => iv.top + '-' + iv.bottom).join('; ');
    renderScreenIntervals(str + '; -');
}

function removeScreenInterval(index) {
    const current = collectScreenIntervals();
    current.splice(index, 1);
    const str = current.map(iv => iv.top + '-' + iv.bottom).join('; ');
    renderScreenIntervals(str);
}

function collectScreenIntervals() {
    const container = document.getElementById('screen-intervals-list');
    const intervals = [];
    container.querySelectorAll('[data-interval]').forEach(row => {
        const top = row.querySelector('.si-top').value.trim();
        const bottom = row.querySelector('.si-bottom').value.trim();
        intervals.push({ top, bottom });
    });
    return intervals;
}

function serializeIntervals() {
    return collectScreenIntervals()
        .filter(iv => iv.top || iv.bottom)
        .map(iv => iv.top + '-' + iv.bottom)
        .join('; ');
}

/* ── Relocate mode ────────────────────────────────────── */

function startRelocate() {
    if (!selectedWell) return;
    relocateMode = true;
    document.getElementById('relocate-banner').classList.remove('hidden');
    document.getElementById('map').classList.add('map-relocate');
}

function cancelRelocate() {
    relocateMode = false;
    document.getElementById('relocate-banner').classList.add('hidden');
    document.getElementById('map').classList.remove('map-relocate');
}

map.on('click', (e) => {
    if (relocateMode && selectedWell) {
        // Set new location
        selectedWell.reviewedLat = e.lngLat.lat;
        selectedWell.reviewedLng = e.lngLat.lng;

        // Auto-set status to relocated
        selectedWell.status = 'relocated';

        cancelRelocate();
        updateMapSource();
        highlightWell(selectedWell);
        selectWell(selectedWell.WCRNumber); // refresh detail panel
        showToast('Location updated — click Save to commit', 'success');
        return;
    }

    // Click on a well point
    const features = map.queryRenderedFeatures(e.point, { layers: ['wells-points'] });
    if (features.length > 0) {
        selectWell(features[0].properties.WCRNumber);
    }
});

/* ── Mark status (from dropdown) ──────────────────────── */

function markStatus() {
    if (!selectedWell) return;
    selectedWell.status = document.getElementById('status-select').value;
}

/* ── Save well to Google Sheet ────────────────────────── */

async function saveWell() {
    if (!selectedWell) return;

    const reviewer = document.getElementById('reviewer-name').value.trim();
    if (!reviewer) {
        showToast('Please enter your name in the Reviewer field', 'error');
        return;
    }

    const notes = document.getElementById('notes-input').value.trim();
    const status = document.getElementById('status-select').value;
    const zone = document.getElementById('zone-select').value;
    const screens = serializeIntervals();

    selectedWell.status = status;
    selectedWell.notes = notes;
    selectedWell.reviewedBy = reviewer;
    selectedWell.zoneClassification = zone;
    selectedWell.screenIntervals = screens;

    const payload = {
        WCRNumber: selectedWell.WCRNumber,
        review_status: status,
        review_notes: notes,
        reviewed_latitude: selectedWell.reviewedLat || '',
        reviewed_longitude: selectedWell.reviewedLng || '',
        reviewed_by: reviewer,
        zone_classification: zone,
        screen_intervals: screens,
    };

    try {
        const resp = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            mode: 'no-cors',
        });

        // Apps Script with no-cors returns opaque response, so we assume success
        // if no network error was thrown
        showToast('Saved ' + selectedWell.WCRNumber, 'success');
        updateStats();
        updateMapSource();
        renderWellList();
    } catch (err) {
        showToast('Save failed: ' + err.message, 'error');
    }
}

/* ── Hover popup ──────────────────────────────────────── */

const popup = document.getElementById('popup');

map.on('mousemove', 'wells-points', (e) => {
    map.getCanvas().style.cursor = 'pointer';
    const p = e.features[0].properties;
    popup.innerHTML = `<strong>${p.WCRNumber}</strong> &middot; ${p.use}<br><span style="color:${STATUS_COLORS[p.status]}">${(p.status || 'unreviewed').replace('_', ' ')}</span>`;
    popup.classList.remove('hidden');
    popup.style.left = (e.originalEvent.clientX + 12) + 'px';
    popup.style.top = (e.originalEvent.clientY - 12) + 'px';
});

map.on('mouseleave', 'wells-points', () => {
    map.getCanvas().style.cursor = '';
    popup.classList.add('hidden');
});

/* ── Filter tabs ──────────────────────────────────────── */

document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        currentFilter = tab.dataset.filter;
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderWellList();
        updateMapSource();
    });
});

/* ── Toast notification ───────────────────────────────── */

function showToast(msg, type) {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className = 'toast ' + type + ' show';
    setTimeout(() => { toast.classList.remove('show'); }, 3000);
}

/* ── Persist reviewer name ────────────────────────────── */

const savedName = localStorage.getItem('wcr-reviewer-name');
if (savedName) document.getElementById('reviewer-name').value = savedName;

document.getElementById('reviewer-name').addEventListener('change', (e) => {
    localStorage.setItem('wcr-reviewer-name', e.target.value);
});
