"""
parquet_to_csv_to_geojson.py
----------------------------
Converts a Parquet file → CSV → GeoJSON FeatureCollection.

Each row represents the centre of a 100m x 100m square (given by 'latitude'
and 'longitude' columns), output as a GeoJSON Polygon feature with all
remaining columns attached as feature properties.

Usage:
    python parquet_to_csv_to_geojson.py input.parquet output.csv output.geojson

Dependencies:
    pip install pandas pyarrow
    (No other third-party libraries needed — math is from stdlib)
"""

import json
import math
import sys
import pandas as pd


# ---------------------------------------------------------------------------
# Parquet → CSV
# ---------------------------------------------------------------------------

def parquet_to_csv(parquet_path: str, csv_path: str) -> None:
    """
    Read a Parquet file and write it out as a CSV.

    Parameters
    ----------
    parquet_path : path to the input Parquet file
    csv_path     : path for the output CSV file
    """
    print(f"Reading  : {parquet_path}")
    df = pd.read_parquet(parquet_path)
    print(f"Rows     : {len(df):,}  |  Columns: {list(df.columns)}")
    print(f"Writing  : {csv_path}")
    df.to_csv(csv_path, index=False)
    print("Parquet → CSV done ✓")


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

def metres_to_degrees_lat(metres: float) -> float:
    """Convert a north-south distance in metres to decimal degrees of latitude."""
    return metres / 111_320.0


def metres_to_degrees_lon(metres: float, latitude: float) -> float:
    """
    Convert an east-west distance in metres to decimal degrees of longitude,
    accounting for latitude (longitude degrees shrink toward the poles).
    """
    return metres / (111_320.0 * math.cos(math.radians(latitude)))


def make_square_polygon(centre_lat: float, centre_lon: float, side_m: float = 100.0) -> dict:
    """
    Build a GeoJSON Polygon representing a square centred on (centre_lat, centre_lon).

    The square sides are `side_m` metres long. Because we're working in geographic
    coordinates (degrees), we convert half-side lengths separately for lat and lon
    so the square is metrically accurate near its centre.

    Returns a GeoJSON geometry dict.
    """
    half = side_m / 2.0
    dlat = metres_to_degrees_lat(half)
    dlon = metres_to_degrees_lon(half, centre_lat)

    # Four corners: SW → SE → NE → NW → SW (closed ring, CCW winding)
    sw = [centre_lon - dlon, centre_lat - dlat]
    se = [centre_lon + dlon, centre_lat - dlat]
    ne = [centre_lon + dlon, centre_lat + dlat]
    nw = [centre_lon - dlon, centre_lat + dlat]

    return {
        "type": "Polygon",
        "coordinates": [[sw, se, ne, nw, sw]],
    }


# ---------------------------------------------------------------------------
# CSV → GeoJSON
# ---------------------------------------------------------------------------
def csv_to_geojson(
    csv_path: str,
    geojson_path: str,
    lat_col: str = "latitude",
    lon_col: str = "longitude",
    side_m: float = 100.0,
    sa2_geojson_path: str | None = None,
) -> None:
    """
    Read `csv_path`, build one GeoJSON Feature per row, write to `geojson_path`.

    Parameters
    ----------
    csv_path         : path to the input CSV file
    geojson_path     : path for the output GeoJSON file
    lat_col          : name of the latitude column  (default: 'latitude')
    lon_col          : name of the longitude column (default: 'longitude')
    side_m           : side length of each square in metres (default: 100)
    sa2_geojson_path : optional path to SA2 GeoJSON for land filtering
    """
    print(f"Reading  : {csv_path}")
    df = pd.read_csv(csv_path)

    if lat_col not in df.columns or lon_col not in df.columns:
        raise ValueError(
            f"CSV must contain '{lat_col}' and '{lon_col}' columns. "
            f"Found: {list(df.columns)}"
        )

    # ── Build land union for water filtering ──────────────────────────────
    land_union = None
    if sa2_geojson_path:
        print(f"Loading SA2 boundaries for land filter: {sa2_geojson_path}")
        from shapely.geometry import shape, Point
        from shapely.ops import unary_union
        with open(sa2_geojson_path, "r") as f:
            sa2 = json.load(f)
        polys = [
            shape(f["geometry"])
            for f in sa2["features"]
            if f.get("geometry") is not None
        ]
        from shapely import prepared
        land_union = prepared.prep(unary_union(polys))
        print(f"  Built union of {len(polys):,} SA2 polygons.")

    # Columns to include as properties (everything except lat/lon)
    property_cols = [c for c in df.columns if c not in (lat_col, lon_col)]

    features = []
    skipped = 0
    for _, row in df.iterrows():
        lat = float(row[lat_col])
        lon = float(row[lon_col])

        # Skip water cells
        if land_union is not None:
            from shapely.geometry import Point
            if not land_union.contains(Point(lon, lat)):
                skipped += 1
                continue

        geometry = make_square_polygon(lat, lon, side_m=side_m)

        # Convert row values to plain Python types for JSON serialisation
        properties = {}
        for col in property_cols:
            val = row[col]
            if pd.isna(val):
                properties[col] = None
            elif isinstance(val, (int, float)):
                properties[col] = val
            else:
                properties[col] = str(val)

        features.append({
            "type": "Feature",
            "geometry": geometry,
            "properties": properties,
        })

    geojson = {
        "type": "FeatureCollection",
        "features": features,
    }

    print(f"Features : {len(features):,}  (skipped {skipped:,} water cells)")
    print(f"Writing  : {geojson_path}")
    with open(geojson_path, "w", encoding="utf-8") as f:
        json.dump(geojson, f, indent=2, ensure_ascii=False)

    print("Done ✓")


# ---------------------------------------------------------------------------
# Full pipeline: Parquet → CSV → GeoJSON
# ---------------------------------------------------------------------------

def parquet_to_geojson(
    parquet_path: str,
    csv_path: str,
    geojson_path: str,
    sa2_geojson_path: str | None = None,  # ← add this
) -> None:
    """Run the full Parquet → CSV → GeoJSON pipeline."""
    parquet_to_csv(parquet_path, csv_path)
    print()
    csv_to_geojson(
        csv_path,
        geojson_path,
        sa2_geojson_path=sa2_geojson_path,  # ← pass it through
    )


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parquet_to_geojson(
        parquet_path=r"rated_locations.parquet",
        csv_path=r"rated_locations.csv",
        geojson_path=r"rated_locations.geojson",
        sa2_geojson_path=r"../spatialData/sa2_enriched.geojson",
    )