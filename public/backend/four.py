"""
Location Rating Pipeline
========================
Step 1 — Grid Initialisation:
    Builds a ~100 m resolution grid over a single Australian city, then
    performs nearest-neighbour lookups to attach rent, income, population,
    and store-count features to every cell.

Step 2 — Location Rating Algorithm:
    Produces a score from 1–100 for each (lat, lng) cell by combining:
      1. A weighted linear combination of normalised stats (rent, income, pop)
      2. A synergy score: how well the existing stores at each location
         complement the TARGET store you want to build
      3. A cannibalization penalty: cells that are too close to stores you
         already own are penalised (hard no-go zone that fades with distance)

Entry Point (callable from TypeScript / external code):
    run_pipeline(
        city                          : str,
        target_store_type             : str,
        existing_store_locations      : list[tuple[float, float]],
        cannibalization_hard_radius_m : float = 200,
        cannibalization_fade_radius_m : float = 1_000,
        output_path                   : str | None = "rated_locations.parquet",
    ) -> pd.DataFrame

Outputs:
    rated_locations.parquet  — grid cells for the chosen city with a
                               `rating` column (1–100) and a
                               `cannibalization_factor` column (0–1)
"""

import os

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree
from typing import Optional


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 CONFIG
# ─────────────────────────────────────────────────────────────────────────────

METRES_PER_DEG_LAT = 111_000
CELL_SIZE_M        = 100          # grid resolution in metres

BOXES = [
    {"name": "Greater Sydney",    "lat_min": -34.1, "lat_max": -33.7, "long_min": 150.65, "long_max": 151.4},
    {"name": "Greater Melbourne", "lat_min": -38.2, "lat_max": -37.5, "long_min": 144.5, "long_max": 145.5},
    {"name": "Greater Brisbane",  "lat_min": -27.8, "lat_max": -27.2, "long_min": 152.7, "long_max": 153.2},
    {"name": "Greater Perth",     "lat_min": -32.2, "lat_max": -31.6, "long_min": 115.6, "long_max": 116.1},
    {"name": "Greater Adelaide",  "lat_min": -35.2, "lat_max": -34.6, "long_min": 138.4, "long_max": 139.0},
    {"name": "Gold Coast",        "lat_min": -28.2, "lat_max": -27.8, "long_min": 153.2, "long_max": 153.6},
    {"name": "Newcastle",         "lat_min": -33.1, "lat_max": -32.8, "long_min": 151.5, "long_max": 151.8},
    {"name": "Canberra",          "lat_min": -35.5, "lat_max": -35.1, "long_min": 148.9, "long_max": 149.3},
    {"name": "Sunshine Coast",    "lat_min": -26.8, "lat_max": -26.4, "long_min": 152.9, "long_max": 153.2},
    {"name": "Wollongong",        "lat_min": -34.6, "lat_max": -34.3, "long_min": 150.7, "long_max": 151.0},
]

# Lookup: canonical city name → box (case-insensitive)
CITY_NAMES = {b["name"].lower(): b for b in BOXES}

RENT_CSV       = "rent_filtered.csv"
INCOME_CSV     = "income_filtered.csv"
POP_CSV        = "population.csv"
GROWTH_CSV     = "growth.csv"
STORES_PARQUET = "places_filtered.parquet"

STORE_TYPES = [
    "Arts and Entertainment",
    "Business and Professional Services",
    "Community and Government",
    "Dining and Drinking",
    "Event",
    "Health and Medicine",
    "Landmarks and Outdoors",
    "Retail",
    "Sports and Recreation",
    "Travel and Transportation",
]


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 CONFIG
# ─────────────────────────────────────────────────────────────────────────────

OUTPUT_PATH      = "rated_locations.parquet"
SYNERGY_CSV_PATH = "synergy_matrix.csv"

STATS_WEIGHTS = {
    "rent":   0.5,
    "income": 0.5,
    "Pop":    0.6,
    "growth" : 0.4
}

# Relative weights of each scoring component
COMPONENT_WEIGHTS = {
    "stats":   0.6,
    "synergy": 0.4,
    # Note: cannibalization is a *multiplier* on the combined score,
    # not an additive term — see combine_and_scale().
}

# Maps parquet column name → synergy matrix row/col label
STORE_COLUMN_MAP = {
    "stores_arts_and_entertainment":             "Arts and Entertainment",
    "stores_business_and_professional_services": "Business and Professional Services",
    "stores_community_and_government":           "Community and Government",
    "stores_dining_and_drinking":                "Dining and Drinking",
    "stores_event":                              "Event",
    "stores_health_and_medicine":                "Health and Medicine",
    "stores_landmarks_and_outdoors":             "Landmarks and Outdoors",
    "stores_retail":                             "Retail",
    "stores_sports_and_recreation":              "Sports and Recreation",
    "stores_travel_and_transportation":          "Travel and Transportation",
}
STORE_COLUMNS = list(STORE_COLUMN_MAP.keys())

# "minmax" or "percentile" (robust to outliers)
SYNERGY_NORMALISATION = "percentile"


# ─────────────────────────────────────────────────────────────────────────────
# SHARED UTILITY
# ─────────────────────────────────────────────────────────────────────────────

EARTH_R_KM = 6_371.0


def to_xyz(lat_deg, lon_deg) -> np.ndarray:
    """Convert lat/lon (degrees) to 3-D unit-sphere coords scaled by Earth radius."""
    lat = np.radians(lat_deg)
    lon = np.radians(lon_deg)
    x = EARTH_R_KM * np.cos(lat) * np.cos(lon)
    y = EARTH_R_KM * np.cos(lat) * np.sin(lon)
    z = EARTH_R_KM * np.sin(lat)
    return np.column_stack([x, y, z])


def col_name(store_type: str) -> str:
    """Sanitise a store-type label into a valid DataFrame column name."""
    return "stores_" + store_type.lower().replace(" ", "_").replace("&", "and")


def resolve_city(city: str) -> dict:
    """
    Return the bounding-box dict for the requested city.
    Accepts the full canonical name or any case-insensitive substring.
    Raises ValueError with available options if nothing matches.
    """
    needle = city.strip().lower()
    if needle in CITY_NAMES:
        return CITY_NAMES[needle]
    matches = [v for k, v in CITY_NAMES.items() if needle in k]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        raise ValueError(
            f"Ambiguous city '{city}' matches: {[m['name'] for m in matches]}. "
            "Please be more specific."
        )
    available = [b["name"] for b in BOXES]
    raise ValueError(
        f"City '{city}' not found.\nAvailable cities:\n  " + "\n  ".join(available)
    )


# ─────────────────────────────────────────────────────────────────────────────
# STEP 1 — GRID INITIALISATION
# ─────────────────────────────────────────────────────────────────────────────

def generate_grid(box: dict, cell_size_m: float = CELL_SIZE_M) -> pd.DataFrame:
    """Grid of cell centres spaced `cell_size_m` metres apart inside `box`."""
    lat_step = cell_size_m / METRES_PER_DEG_LAT
    mid_lat  = (box["lat_min"] + box["lat_max"]) / 2
    lon_step = cell_size_m / (METRES_PER_DEG_LAT * np.cos(np.radians(mid_lat)))

    lats  = np.arange(box["lat_min"]  + lat_step / 2, box["lat_max"],  lat_step)
    longs = np.arange(box["long_min"] + lon_step / 2, box["long_max"], lon_step)

    grid_lats, grid_longs = np.meshgrid(lats, longs)
    return pd.DataFrame({
        "region":    box["name"],
        "latitude":  grid_lats.ravel(),
        "longitude": grid_longs.ravel(),
    })
import json

def filter_to_land(grid_df: pd.DataFrame, sa2_geojson_path: str) -> pd.DataFrame:
    """Remove grid cells whose centre doesn't fall inside any SA2 polygon."""
    print("\nFiltering water cells...")
    
    with open(sa2_geojson_path, "r") as f:
        sa2 = json.load(f)

    def point_in_polygon(lng, lat, ring):
        inside = False
        n = len(ring)
        j = n - 1
        for i in range(n):
            xi, yi = ring[i]
            xj, yj = ring[j]
            if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi):
                inside = not inside
            j = i
        return inside

    def point_in_feature(lng, lat, feature):
        geom = feature.get("geometry")
        if not geom:
            return False
        coords = geom.get("coordinates", [])
        if geom["type"] == "Polygon":
            return point_in_polygon(lng, lat, coords[0])
        if geom["type"] == "MultiPolygon":
            return any(point_in_polygon(lng, lat, poly[0]) for poly in coords)
        return False

    features = sa2.get("features", [])
    mask = [
        any(point_in_feature(row.longitude, row.latitude, f) for f in features)
        for _, row in grid_df.iterrows()
    ]
    
    filtered = grid_df[mask].reset_index(drop=True)
    print(f"  Kept {len(filtered):,} land cells (removed {len(grid_df) - len(filtered):,} water cells)")
    return filtered

def build_grid(city: str) -> tuple[pd.DataFrame, np.ndarray]:
    """
    Build a feature grid for a *single* city.

    Returns
    -------
    grid_df  : DataFrame with rent, income, Pop, and store-count columns
    grid_xyz : (N, 3) XYZ array reused by subsequent spatial queries
    """
    print("=" * 54)
    print("  STEP 1 — Grid Initialisation")
    print("=" * 54)

    box = resolve_city(city)
    print(f"\nCity        : {box['name']}")

    grid_df = generate_grid(box)
    grid_df["latitude"]  = grid_df["latitude"].round(7)
    grid_df["longitude"] = grid_df["longitude"].round(7)
    print(f"Total cells : {len(grid_df):,}")

    grid_xyz = to_xyz(grid_df["latitude"].values, grid_df["longitude"].values)

    # ── Rent ──────────────────────────────────────────────────
    print(f"\nLoading rent: {RENT_CSV}")
    rent_df = pd.read_csv(RENT_CSV).rename(columns={
        "lat": "latitude", "lng": "longitude", "rent_per_sqm_weekly": "rent"
    })
    rent_tree = cKDTree(to_xyz(rent_df["latitude"].values, rent_df["longitude"].values))
    dist_km, idx = rent_tree.query(grid_xyz, k=1, workers=-1)
    grid_df["rent"]                = rent_df["rent"].values[idx]
    grid_df["rent_source_dist_km"] = dist_km.round(4)
    print(f"  Attached rent to {len(grid_df):,} cells.")

    # ── Income ────────────────────────────────────────────────
    print(f"\nLoading income: {INCOME_CSV}")
    income_df = pd.read_csv(INCOME_CSV).rename(columns={
        "lat": "latitude", "lng": "longitude",
        "Median_tot_prsnl_inc_weekly": "income"
    })
    income_tree = cKDTree(to_xyz(income_df["latitude"].values, income_df["longitude"].values))
    dist_km, idx = income_tree.query(grid_xyz, k=1, workers=-1)
    grid_df["income"]                = income_df["income"].values[idx]
    grid_df["income_source_dist_km"] = dist_km.round(4)
    print(f"  Attached income to {len(grid_df):,} cells.")

    # ── Population ────────────────────────────────────────────
    print(f"\nLoading population: {POP_CSV}")
    pop_df = (
        pd.read_csv(POP_CSV)
        .rename(columns={"lat": "latitude", "lng": "longitude", "Tot_P_P": "Pop"})
        .dropna(subset=["latitude", "longitude", "Pop"])
    )
    pop_tree = cKDTree(to_xyz(pop_df["latitude"].values, pop_df["longitude"].values))
    dist_km, idx = pop_tree.query(grid_xyz, k=1, workers=-1)
    grid_df["Pop"]                = pop_df["Pop"].values[idx]
    grid_df["POP_source_dist_km"] = dist_km.round(4)
    print(f"  Attached population to {len(grid_df):,} cells.")

    # ── Growth ────────────────────────────────────────────────
    print(f"\nLoading growth: {GROWTH_CSV}")
    growth_df = pd.read_csv(GROWTH_CSV).rename(columns={
        "lat": "latitude", "lng": "longitude", "growth": "growth"  # adjust column name if different
    })
    growth_tree = cKDTree(to_xyz(growth_df["latitude"].values, growth_df["longitude"].values))
    dist_km, idx = growth_tree.query(grid_xyz, k=1, workers=-1)
    grid_df["growth"]                = growth_df["growth"].values[idx]
    grid_df["growth_source_dist_km"] = dist_km.round(4)
    print(f"  Attached growth to {len(grid_df):,} cells.")

    # ── Store counts ──────────────────────────────────────────
    RADIUS_KM = 0.1
    print(f"\nLoading stores: {STORES_PARQUET}")
    stores_df = pd.read_parquet(
        STORES_PARQUET,
        columns=["latitude", "longitude", "fsq_category_labels"],
        engine="pyarrow",
    )
    print(f"  Loaded {len(stores_df):,} store records.")
    stores_xyz = to_xyz(stores_df["latitude"].values, stores_df["longitude"].values)

    print(f"\nCounting stores within {RADIUS_KM * 1_000:.0f} m for each category...")
    for store_type in STORE_TYPES:
        col  = col_name(store_type)
        mask = stores_df["fsq_category_labels"].values == store_type
        print(f"  → {store_type} ({mask.sum():,} records)")
        if not mask.any():
            grid_df[col] = 0
            continue
        type_tree = cKDTree(stores_xyz[mask])
        counts = type_tree.query_ball_point(
            grid_xyz, r=RADIUS_KM, return_length=True, workers=-1
        )
        grid_df[col] = counts.astype(np.int32)

    print("\nStep 1 complete.")
    return grid_df, grid_xyz


# ─────────────────────────────────────────────────────────────────────────────
# STEP 2 — LOCATION RATING
# ─────────────────────────────────────────────────────────────────────────────

def minmax_normalise(df: pd.DataFrame, columns: list[str]) -> pd.DataFrame:
    for col in columns:
        lo, hi = df[col].min(), df[col].max()
        span = hi - lo
        df[col] = (df[col] - lo) / span if span != 0 else 0.0
    return df


def compute_stats_score(df: pd.DataFrame) -> np.ndarray:
    """Weighted linear combination of normalised stats columns → [0, 1]."""
    missing = [c for c in STATS_WEIGHTS if c not in df.columns]
    if missing:
        raise ValueError(f"Stats columns not found: {missing}")

    cols    = list(STATS_WEIGHTS.keys())
    weights = np.array([STATS_WEIGHTS[c] for c in cols], dtype=np.float32)
    weights /= weights.sum()
    values  = df[cols].to_numpy(dtype=np.float32)

    # Lower rent is better — invert after normalisation
    values[:, cols.index("rent")] = 1.0 - values[:, cols.index("rent")]

    return values @ weights


def compute_synergy_score(
    df: pd.DataFrame,
    synergy_df: pd.DataFrame,
    target_store: str,
) -> np.ndarray:
    """
    synergy[row] = Σ_j  store_count[j] × M[target, j]
    Result is normalised to [0, 1].
    """
    if target_store not in synergy_df.index:
        raise ValueError(
            f"target_store_type '{target_store}' not found in synergy matrix.\n"
            f"Available: {list(synergy_df.index)}"
        )

    parquet_cols, matrix_labels, skipped = [], [], []
    for col, label in STORE_COLUMN_MAP.items():
        (parquet_cols if label in synergy_df.index else skipped).append(col)
        if label in synergy_df.index:
            matrix_labels.append(label)

    if skipped:
        print(f"  ⚠ {len(skipped)} store column(s) not in synergy matrix — skipped.")
    if not parquet_cols:
        raise ValueError("No store columns match the synergy matrix index.")

    target_weights = synergy_df.loc[target_store, matrix_labels].to_numpy(dtype=np.float32)
    raw = df[parquet_cols].to_numpy(dtype=np.float32) @ target_weights

    print(f"  Scored {len(parquet_cols)} store types vs. '{target_store}' across {len(raw):,} rows.")

    if SYNERGY_NORMALISATION == "percentile":
        lo, hi = np.percentile(raw, [1, 99])
        raw = np.clip(raw, lo, hi)
    else:
        lo, hi = raw.min(), raw.max()

    span = hi - lo
    if span == 0:
        print("  ⚠ All synergy scores identical — defaulting to 0.5")
        return np.full(len(raw), 0.5, dtype=np.float32)

    return ((raw - lo) / span).astype(np.float32)


def compute_cannibalization_factor(
    grid_xyz: np.ndarray,
    existing_store_locations: list[tuple[float, float]],
    hard_radius_km: float,
    fade_radius_km: float,
) -> np.ndarray:
    """
    Compute a per-cell cannibalization factor in [0, 1].

    Represents how much of a cell's score is *kept* after accounting for
    proximity to stores you already own:

      d < hard_radius_km              →  factor = 0.0  (hard exclusion zone)
      hard_radius_km ≤ d < fade_radius_km  →  factor rises linearly 0 → 1
      d ≥ fade_radius_km              →  factor = 1.0  (no penalty)

    Parameters
    ----------
    grid_xyz                 : (N, 3) XYZ array for every grid cell
    existing_store_locations : list of (lat, lng) tuples for stores already owned
    hard_radius_km           : inner radius — complete suppression
    fade_radius_km           : outer radius — penalty fully fades here
    """
    if not existing_store_locations:
        return np.ones(len(grid_xyz), dtype=np.float32)

    if hard_radius_km >= fade_radius_km:
        raise ValueError(
            f"hard_radius_km ({hard_radius_km}) must be < fade_radius_km ({fade_radius_km})."
        )

    lats = np.array([loc[0] for loc in existing_store_locations], dtype=np.float64)
    lngs = np.array([loc[1] for loc in existing_store_locations], dtype=np.float64)
    tree = cKDTree(to_xyz(lats, lngs))

    dist_km, _ = tree.query(grid_xyz, k=1, workers=-1)

    factor = np.ones(len(grid_xyz), dtype=np.float32)

    hard_mask = dist_km <= hard_radius_km
    factor[hard_mask] = 0.0

    fade_mask = (dist_km > hard_radius_km) & (dist_km < fade_radius_km)
    factor[fade_mask] = (
        (dist_km[fade_mask] - hard_radius_km) / (fade_radius_km - hard_radius_km)
    ).astype(np.float32)

    print(
        f"  Cannibalization: {int(hard_mask.sum()):,} cells in hard zone, "
        f"{int(fade_mask.sum()):,} cells in fade zone."
    )
    return factor


def combine_and_scale(
    stats_score: np.ndarray,
    synergy_score: np.ndarray,
    cannibalization_factor: np.ndarray,
) -> np.ndarray:
    """
    Combine component scores and scale to [1, 100].

    The cannibalization factor acts as a *multiplier* on the base combined
    score so that cells inside the exclusion zone always collapse to 1
    regardless of their underlying quality.
    """
    w_s, w_y = COMPONENT_WEIGHTS["stats"], COMPONENT_WEIGHTS["synergy"]
    base      = (w_s * stats_score + w_y * synergy_score) / (w_s + w_y)
    penalised = base * cannibalization_factor
    return np.round(1.0 + penalised * 99.0).astype(np.int16)


def rate_locations(
    grid_df: pd.DataFrame,
    grid_xyz: np.ndarray,
    target_store_type: str,
    existing_store_locations: list[tuple[float, float]],
    cannibalization_hard_radius_km: float,
    cannibalization_fade_radius_km: float,
) -> pd.DataFrame:
    print("\n" + "=" * 54)
    print("  STEP 2 — Location Rating")
    print("=" * 54)
    print(f"\nTarget store             : {target_store_type}")
    print(f"Existing owned stores    : {len(existing_store_locations)}")
    print(f"Cannibalization hard zone: {cannibalization_hard_radius_km * 1_000:.0f} m")
    print(f"Cannibalization fade zone: {cannibalization_fade_radius_km * 1_000:.0f} m")

    df = grid_df.copy()
    df = minmax_normalise(df, list(STATS_WEIGHTS.keys()))

    print(f"\nLoading synergy matrix: {SYNERGY_CSV_PATH}")
    synergy_df = pd.read_csv(SYNERGY_CSV_PATH, index_col=0)
    print(f"  {synergy_df.shape[0]} × {synergy_df.shape[1]} store types")

    print("\n[1/3] Computing stats score…")
    stats_score = compute_stats_score(df)
    print(f"  Range: [{stats_score.min():.3f}, {stats_score.max():.3f}]")

    print("\n[2/3] Computing synergy score…")
    synergy_score = compute_synergy_score(df, synergy_df, target_store_type)
    print(f"  Range: [{synergy_score.min():.3f}, {synergy_score.max():.3f}]")

    print("\n[3/3] Computing cannibalization factor…")
    cannibalization_factor = compute_cannibalization_factor(
        grid_xyz,
        existing_store_locations,
        hard_radius_km=cannibalization_hard_radius_km,
        fade_radius_km=cannibalization_fade_radius_km,
    )
    print(
        f"  Factor range: [{cannibalization_factor.min():.3f}, "
        f"{cannibalization_factor.max():.3f}]"
    )

    print("\nCombining scores…")
    grid_df["cannibalization_factor"] = cannibalization_factor.round(4)
    grid_df["rating"] = combine_and_scale(stats_score, synergy_score, cannibalization_factor)

    print("\nRating distribution:")
    print(grid_df["rating"].describe().to_string())

    # ── Top 3 / Bottom 3 summary ──────────────────────────────
    df_sorted = grid_df.sort_values("rating", ascending=False).reset_index(drop=True)

    def print_location_summary(row: pd.Series, rank_label: str) -> None:
        nearby = [STORE_COLUMN_MAP[c] for c in STORE_COLUMNS if row[c] > 0]
        print(f"\n  {'─' * 50}")
        print(f"  {rank_label}")
        print(f"  {'─' * 50}")
        print(f"  Rating                 : {row['rating']}")
        print(f"  Latitude               : {row['latitude']}")
        print(f"  Longitude              : {row['longitude']}")
        print(f"  Region                 : {row['region']}")
        print(f"  Rent                   : {row['rent']:.3f}")
        print(f"  Income                 : {row['income']:.3f}")
        print(f"  Population             : {row['Pop']:.3f}")
        print(f"  Growth                 : {row['growth']:.3f}")
        print(f"  Cannibalization factor : {row['cannibalization_factor']:.3f}")
        print(f"  Nearby stores          : {', '.join(nearby) if nearby else 'none'}")

    print(f"\n\n{'═' * 54}")
    print(f"  📍 Top 3 locations for '{target_store_type}'")
    print(f"{'═' * 54}")
    for i in range(min(3, len(df_sorted))):
        print_location_summary(df_sorted.iloc[i], f"#{i + 1}")

    print(f"\n\n{'═' * 54}")
    print(f"  📍 Bottom 3 locations for '{target_store_type}'")
    print(f"{'═' * 54}")
    for i, row in df_sorted.tail(3).iloc[::-1].iterrows():
        print_location_summary(row, f"#{i + 1}")

    return grid_df


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def run_pipeline(
    city: str,
    target_store_type: str,
    existing_store_locations: list[tuple[float, float]],
    cannibalization_hard_radius_m: float = 200.0,
    cannibalization_fade_radius_m: float = 1_000.0,
    output_path: Optional[str] = OUTPUT_PATH,
) -> pd.DataFrame:
    """
    Run the full location-rating pipeline for a single city.

    Parameters
    ----------
    city : str
        Name of the city to analyse, e.g. "Greater Sydney".
        Case-insensitive; unambiguous substrings are accepted.
        Available cities: Greater Sydney, Greater Melbourne, Greater Brisbane,
        Greater Perth, Greater Adelaide, Gold Coast, Newcastle,
        Canberra, Sunshine Coast, Wollongong.

    target_store_type : str
        The store category you want to build.  Must match a row/column in
        the synergy matrix exactly.
        Options: "Arts and Entertainment", "Business and Professional Services",
                 "Community and Government", "Dining and Drinking", "Event",
                 "Health and Medicine", "Landmarks and Outdoors", "Retail",
                 "Sports and Recreation", "Travel and Transportation".

    existing_store_locations : list[tuple[float, float]]
        (latitude, longitude) pairs for stores you *already own* of this type.
        Cells near these locations are penalised to avoid self-cannibalization.
        Pass an empty list [] if you have no existing stores.
        Example: [(-33.8688, 151.2093), (-33.9461, 151.1772)]

    cannibalization_hard_radius_m : float, default 200
        Radius in metres inside which a cell is completely suppressed
        (cannibalization_factor = 0, rating collapses to 1).

    cannibalization_fade_radius_m : float, default 1000
        Radius in metres at which the cannibalization penalty fully fades.
        Between hard and fade radii the factor rises linearly from 0 → 1.
        Must be strictly greater than cannibalization_hard_radius_m.

    output_path : str | None, default "rated_locations.parquet"
        Save the rated DataFrame here as Snappy-compressed Parquet.
        Pass None to skip saving.

    Returns
    -------
    pd.DataFrame
        Full grid with columns: latitude, longitude, region, rent, income,
        Pop, all stores_* count columns, cannibalization_factor (float, 0–1),
        and rating (int16, 1–100).
    """
    hard_km = cannibalization_hard_radius_m / 1_000.0
    fade_km = cannibalization_fade_radius_m / 1_000.0

    grid_df, grid_xyz = build_grid(city)

    rated_df = rate_locations(
        grid_df,
        grid_xyz,
        target_store_type=target_store_type,
        existing_store_locations=existing_store_locations,
        cannibalization_hard_radius_km=hard_km,
        cannibalization_fade_radius_km=fade_km,
    )

    if output_path:
        print(f"\nSaving output to {output_path}…")
        rated_df.to_parquet(output_path, index=False, compression="snappy")
        print("Done ✓")

    return rated_df


# ─────────────────────────────────────────────────────────────────────────────
# CLI / QUICK-TEST ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    rated = run_pipeline(
        city                          = "Greater Sydney",
        target_store_type             = "Retail",
        existing_store_locations      = [
            (-33.8688, 151.2093),   # example: Sydney CBD store
            (-33.9461, 151.1772),   # example: Mascot store
        ],
        cannibalization_hard_radius_m = 200,    # 200 m hard no-go
        cannibalization_fade_radius_m = 1_000,  # penalty fully fades at 1 km
    )