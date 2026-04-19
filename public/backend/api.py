"""
api.py
------
Flask wrapper around run_pipeline() + parquet_to_geojson().
Saves output directly to Project/public/spatialData/rated_locations.geojson
so the map picks it up immediately on next layer load.

Install:
    pip install flask flask-cors pandas pyarrow scipy numpy

Run from Project/public/backend/:
    python api.py
"""

import os
import sys
import json
from flask import Flask, request, jsonify
from flask_cors import CORS

# ── Ensure backend dir is on the path ────────────────────────────────────────
BASE_DIR   = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(BASE_DIR, "..", "spatialData")
sys.path.insert(0, BASE_DIR)

from four import run_pipeline
from parquet_to_geojson import parquet_to_geojson

app = Flask(__name__)
CORS(app)

PARQUET_PATH = os.path.join(BASE_DIR, "rated_locations.parquet")
CSV_PATH     = os.path.join(BASE_DIR, "rated_locations.csv")
GEOJSON_PATH = os.path.join(OUTPUT_DIR, "rated_locations.geojson")
STATE_PATH = os.path.join(BASE_DIR, "..", "appState.json")

@app.route("/save-state", methods=["POST"])
def save_state():
    data = request.get_json(force=True)
    with open(STATE_PATH, "w") as f:
        json.dump({
            "selectedCity":     data.get("selectedCity"),
            "businessCategory": data.get("businessCategory"),
            "storeSpacing":     data.get("storeSpacing", 1000),
            "existingStores":   data.get("existingStores", []),
            "supplyPoints":     data.get("supplyPoints", []),
        }, f, indent=2)
    return jsonify({"status": "ok"})



@app.route("/run", methods=["POST"])
def run():
    data = request.get_json(force=True)

    city               = data.get("city")
    target_store_type  = data.get("target_store_type")
    existing_locations = data.get("existing_store_locations", [])
    hard_radius        = float(data.get("cannibalization_hard_radius_m", 200))
    fade_radius        = float(data.get("cannibalization_fade_radius_m", 1000))

    if not city or not target_store_type:
        return jsonify({"error": "city and target_store_type are required"}), 400

    try:
        # Step 1 & 2 — run the rating pipeline
        run_pipeline(
            city=city,
            target_store_type=target_store_type,
            existing_store_locations=[tuple(loc) for loc in existing_locations],
            cannibalization_hard_radius_m=hard_radius,
            cannibalization_fade_radius_m=fade_radius,
            output_path=PARQUET_PATH,
        )

        # Step 3 — convert parquet → csv → geojson into public/spatialData/
        parquet_to_geojson(
            parquet_path=PARQUET_PATH,
            csv_path=CSV_PATH,
            geojson_path=GEOJSON_PATH,
            sa2_geojson_path=os.path.join(BASE_DIR, "..", "spatialData", "sa2_enriched.geojson"),
        )

        return jsonify({"status": "ok", "geojson": GEOJSON_PATH})

    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    app.run(port=5001, debug=True)