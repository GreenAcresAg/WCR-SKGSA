#!/usr/bin/env python3
"""
Zonal ET analysis: compute mean monthly ET per crop field from LandIQ raster TIFs.
Outputs JSON for integration with the ET explorer.
"""

import json, math, os, sys, glob
import numpy as np
import tifffile

# ── Paths ──────────────────────────────────────────────────────────────
RASTER_DIR = "/Users/johngailey/Desktop/South Fork Kings GSA"
GEOJSON_2023 = "/Users/johngailey/Desktop/gis-map/data/kings_crops_2023.geojson"
OUTPUT_JSON = "/Users/johngailey/Desktop/gis-map/data/zonal_et_results.json"

MONTH_ORDER = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
MONTH_NUM = {m: i+1 for i, m in enumerate(MONTH_ORDER)}

# ── WGS84 → UTM Zone 11N (EPSG:32611) ─────────────────────────────────
def wgs84_to_utm11(lon, lat):
    """Manual Transverse Mercator projection for UTM Zone 11N."""
    a = 6378137.0
    f = 1 / 298.257223563
    e2 = 2*f - f*f
    e_prime2 = e2 / (1 - e2)
    k0 = 0.9996
    lon0 = -117.0  # UTM zone 11 central meridian

    lat_r = math.radians(lat)
    lon_r = math.radians(lon)
    lon0_r = math.radians(lon0)

    N = a / math.sqrt(1 - e2 * math.sin(lat_r)**2)
    T = math.tan(lat_r)**2
    C = e_prime2 * math.cos(lat_r)**2
    A = (lon_r - lon0_r) * math.cos(lat_r)

    # Meridional arc
    e4 = e2**2
    e6 = e2**3
    M = a * ((1 - e2/4 - 3*e4/64 - 5*e6/256) * lat_r
             - (3*e2/8 + 3*e4/32 + 45*e6/1024) * math.sin(2*lat_r)
             + (15*e4/256 + 45*e6/1024) * math.sin(4*lat_r)
             - (35*e6/3072) * math.sin(6*lat_r))

    x = k0 * N * (A + (1-T+C)*A**3/6 + (5-18*T+T**2+72*C-58*e_prime2)*A**5/120) + 500000
    y = k0 * (M + N * math.tan(lat_r) * (A**2/2 + (5-T+9*C+4*C**2)*A**4/24
              + (61-58*T+T**2+600*C-330*e_prime2)*A**6/720))
    return x, y

def wgs84_to_ca_albers(lon, lat):
    """WGS84 to NAD83(2011) California Albers (EPSG:6414)."""
    a = 6378137.0
    f_val = 1/298.257222101  # GRS80
    e2 = 2*f_val - f_val*f_val
    e = math.sqrt(e2)

    lat1 = math.radians(34.0)
    lat2 = math.radians(40.5)
    lat0 = math.radians(0.0)
    lon0 = math.radians(-120.0)
    x0 = 0.0
    y0 = -4000000.0

    phi = math.radians(lat)
    lam = math.radians(lon)

    def m_func(p):
        return math.cos(p) / math.sqrt(1 - e2 * math.sin(p)**2)

    def q_func(p):
        sp = math.sin(p)
        return (1 - e2) * (sp / (1 - e2*sp**2) - (1/(2*e)) * math.log((1 - e*sp)/(1 + e*sp)))

    m1 = m_func(lat1)
    m2 = m_func(lat2)
    q0 = q_func(lat0)
    q1 = q_func(lat1)
    q2 = q_func(lat2)

    n = (m1**2 - m2**2) / (q2 - q1)
    C = m1**2 + n * q1
    rho0 = a * math.sqrt(C - n * q0) / n

    q = q_func(phi)
    rho = a * math.sqrt(C - n * q) / n
    theta = n * (lam - lon0)

    x = x0 + rho * math.sin(theta)
    y = y0 + rho0 - rho * math.cos(theta)
    return x, y


def wgs84_to_projected_array(coords, crs='utm11'):
    """Convert array of [lon, lat] to projected coordinates."""
    func = wgs84_to_ca_albers if crs == 'albers' else wgs84_to_utm11
    return [func(c[0], c[1]) for c in coords]


# ── Point-in-polygon (ray casting) for rasterization ──────────────────
def points_in_polygon(px, py, poly_x, poly_y):
    """Vectorized ray-casting for all pixels at once."""
    n = len(poly_x)
    inside = np.zeros(len(px), dtype=bool)
    j = n - 1
    for i in range(n):
        yi, yj = poly_y[i], poly_y[j]
        xi, xj = poly_x[i], poly_x[j]
        cond1 = (yi > py) != (yj > py)
        slope = (xj - xi) / (yj - yi + 1e-30)
        x_intersect = xi + slope * (py - yi)
        cond2 = px < x_intersect
        inside ^= (cond1 & cond2)
        j = i
    return inside


# ── Load all 10m raster files ─────────────────────────────────────────
def load_rasters():
    """Load all 10m TIF files, return list of (year, month, data, geo_info)."""
    rasters = []
    for year_dir in sorted(glob.glob(os.path.join(RASTER_DIR, "20*"))):
        year = os.path.basename(year_dir)
        for tif_path in sorted(glob.glob(os.path.join(year_dir, "*10m.tif"))):
            fname = os.path.basename(tif_path)
            # Parse month from filename like 2021_Jan_SFKGSA_ETa_mm_10m.tif
            parts = fname.split("_")
            month_str = parts[1]
            if month_str not in MONTH_NUM:
                print(f"  Skipping {fname}: unrecognized month '{month_str}'")
                continue

            t = tifffile.TiffFile(tif_path)
            page = t.pages[0]
            data = page.asarray()
            tags = {tag.name: tag.value for tag in page.tags.values()}
            tp = tags['ModelTiepointTag']
            ps = tags['ModelPixelScaleTag']
            # Origin (top-left corner in UTM)
            ox, oy = tp[3], tp[4]
            dx, dy = ps[0], ps[1]  # dy is positive, y goes down

            # Detect CRS from GeoKeys
            gk = tags.get('GeoKeyDirectoryTag', ())
            epsg = None
            if gk:
                n_keys = gk[3] if len(gk) > 3 else 0
                for k in range(n_keys):
                    idx = 4 + k*4
                    if idx+3 < len(gk) and gk[idx] == 3072:
                        epsg = gk[idx+3]
            crs = 'albers' if epsg == 6414 else 'utm11'

            rasters.append({
                'year': int(year),
                'month': month_str,
                'month_num': MONTH_NUM[month_str],
                'data': data,
                'ox': ox, 'oy': oy,
                'dx': dx, 'dy': dy,
                'rows': data.shape[0],
                'cols': data.shape[1],
                'path': tif_path,
                'crs': crs
            })
            print(f"  Loaded {fname}: {data.shape}, origin=({ox:.0f},{oy:.0f}), crs={crs}")
    return rasters


# ── Compute zonal mean for one polygon on one raster ──────────────────
def zonal_mean(polygon_utm, raster):
    """Compute mean ET for a polygon (UTM coords) on a raster."""
    poly_x = np.array([p[0] for p in polygon_utm])
    poly_y = np.array([p[1] for p in polygon_utm])

    # Bounding box in UTM
    min_x, max_x = poly_x.min(), poly_x.max()
    min_y, max_y = poly_y.min(), poly_y.max()

    # Convert to pixel coordinates
    ox, oy, dx, dy = raster['ox'], raster['oy'], raster['dx'], raster['dy']
    col_min = max(0, int((min_x - ox) / dx))
    col_max = min(raster['cols'] - 1, int((max_x - ox) / dx))
    row_min = max(0, int((oy - max_y) / dy))
    row_max = min(raster['rows'] - 1, int((oy - min_y) / dy))

    if col_min > col_max or row_min > row_max:
        return None, 0  # polygon outside raster

    # Generate pixel center coordinates within bounding box
    cols = np.arange(col_min, col_max + 1)
    rows = np.arange(row_min, row_max + 1)
    cc, rr = np.meshgrid(cols, rows)
    px = ox + cc.ravel() * dx + dx/2  # pixel centers
    py = oy - rr.ravel() * dy - dy/2

    # Test which pixels are inside polygon
    inside = points_in_polygon(px, py, poly_x, poly_y)
    if not inside.any():
        return None, 0

    # Extract values
    row_idx = rr.ravel()[inside]
    col_idx = cc.ravel()[inside]
    values = raster['data'][row_idx, col_idx]

    # Filter nodata (typically very large/small or NaN)
    valid = np.isfinite(values) & (values >= 0) & (values < 1000)
    if valid.sum() == 0:
        return None, 0

    return float(np.mean(values[valid])), int(valid.sum())


# ── Main ──────────────────────────────────────────────────────────────
def main():
    print("Loading crop field polygons...")
    with open(GEOJSON_2023) as f:
        gj = json.load(f)
    features = gj['features']
    print(f"  {len(features)} fields loaded")

    print("\nLoading raster files...")
    rasters = load_rasters()
    print(f"  {len(rasters)} rasters loaded")

    # Store WGS84 coordinates per field, convert per-raster CRS
    print("\nParsing polygon coordinates...")
    field_polygons = []
    for i, feat in enumerate(features):
        geom = feat['geometry']
        props = feat['properties']
        field_id = i
        crop = props.get('CROP_NAME', props.get('MAIN_CROP', 'Unknown'))
        acres = props.get('ACRES', 0)

        if geom['type'] == 'Polygon':
            rings_wgs84 = geom['coordinates']
        elif geom['type'] == 'MultiPolygon':
            largest = max(geom['coordinates'], key=lambda p: len(p[0]))
            rings_wgs84 = largest
        else:
            continue

        field_polygons.append({
            'id': field_id,
            'crop': crop,
            'acres': acres,
            'main_crop': props.get('MAIN_CROP', ''),
            'rings_wgs84': rings_wgs84
        })

        if (i+1) % 1000 == 0:
            print(f"  Parsed {i+1}/{len(features)} fields")

    print(f"  {len(field_polygons)} valid polygons")

    # Pre-convert coordinates for each CRS we need
    crs_needed = set(r['crs'] for r in rasters)
    print(f"\nProjections needed: {crs_needed}")
    projected = {}  # crs -> list of projected outer rings (parallel to field_polygons)
    for crs in crs_needed:
        print(f"  Converting {len(field_polygons)} fields to {crs}...")
        rings = []
        for fp in field_polygons:
            rings.append(wgs84_to_projected_array(fp['rings_wgs84'][0], crs))
        projected[crs] = rings
        print(f"    Done")

    # Process each raster against all fields
    print("\nComputing zonal statistics...")
    results = {}

    for ri, raster in enumerate(rasters):
        label = f"{raster['year']}_{raster['month']}"
        crs = raster['crs']
        print(f"\n  [{ri+1}/{len(rasters)}] Processing {label} ({crs})...")
        count = 0
        proj_rings = projected[crs]
        for fi, fp in enumerate(field_polygons):
            outer_ring = proj_rings[fi]
            mean_et, n_pixels = zonal_mean(outer_ring, raster)

            if mean_et is not None:
                fid = fp['id']
                if fid not in results:
                    results[fid] = {
                        'crop': fp['crop'],
                        'acres': fp['acres'],
                        'main_crop': fp['main_crop'],
                        'monthly': []
                    }
                # Water year: Oct-Dec belong to next WY, Jan-Sep to current WY
                wy = raster['year'] + 1 if raster['month_num'] >= 10 else raster['year']
                results[fid]['monthly'].append({
                    'year': raster['year'],
                    'month': raster['month'],
                    'month_num': raster['month_num'],
                    'wy': wy,
                    'et_mm': round(mean_et, 2),
                    'et_in': round(mean_et / 25.4, 3),
                    'pixels': n_pixels
                })
                count += 1

        print(f"    {count} fields with data")

    # Compute water year totals (Oct–Sep, labeled by ending year)
    print("\nComputing water year totals...")
    for fid, fdata in results.items():
        acres = fdata['acres']
        monthly = fdata['monthly']

        # Group by water year
        wy_groups = {}
        for m in monthly:
            wy = m['wy']
            if wy not in wy_groups:
                wy_groups[wy] = []
            wy_groups[wy].append(m)

        annual = []
        for wy in sorted(wy_groups.keys()):
            months = wy_groups[wy]
            total_mm = sum(m['et_mm'] for m in months)
            total_in = total_mm / 25.4
            af = (total_in / 12) * acres
            annual.append({
                'wy': wy,
                'months_available': len(months),
                'total_mm': round(total_mm, 1),
                'total_in': round(total_in, 2),
                'acre_feet': round(af, 2)
            })

        fdata['annual'] = annual

    # Save results
    print(f"\nSaving results to {OUTPUT_JSON}...")
    with open(OUTPUT_JSON, 'w') as f:
        json.dump(results, f)

    # Print summary
    total_fields = len(results)
    total_records = sum(len(d['monthly']) for d in results.values())
    print(f"\nDone! {total_fields} fields with {total_records} monthly records")

    # Sample output
    print("\n── Sample output (first 3 fields with data) ──")
    for fid in list(results.keys())[:3]:
        d = results[fid]
        print(f"\nField {fid}: {d['crop']} ({d['acres']} acres)")
        for a in d['annual']:
            print(f"  WY {a['wy']}: {a['total_in']:.2f} in ({a['months_available']} months) = {a['acre_feet']:.2f} AF")


if __name__ == '__main__':
    main()
