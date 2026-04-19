import { useRef, useEffect, forwardRef, useImperativeHandle } from "react";
import type React from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { toast } from "sonner";
import type { InfraLocation, SupplyPoint } from "../App.tsx";

const LAYER_CONFIG: Record<
  string,
  { property: string; stops: [number, string][] }
> = {
  "Population Density": {
    property: "population_2021",
    stops: [
      [0, "#f7fbff"],
      [5000, "#9ecae1"],
      [20000, "#4292c6"],
      [50000, "#08519c"],
      [100000, "#08306b"],
    ],
  },
  "Socioeconomic Status": {
    property: "IRSD_score",
    stops: [
      [800, "#d73027"],
      [900, "#fc8d59"],
      [1000, "#fee090"],
      [1050, "#91bfdb"],
      [1100, "#4575b4"],
    ],
  },
};

const GRID_LAYERS: Record<string, mapboxgl.Expression> = {
  Rating: [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "rating"], 0],
    0,
    "#e31a1c",
    25,
    "#fd8d3c",
    50,
    "#ffff33",
    100,
    "#31a354",
  ],
  "Rent per sqm": [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", "rent"], 0],
    0,
    "#31a354",
    0.3,
    "#ffff33",
    0.5,
    "#fd8d3c",
    0.6,
    "#e31a1c",
    1,
    "#e31a1c",
  ],
};

const GRID_GEOJSON_PATH = "/spatialData/rated_locations.geojson";
let cachedFilteredGrid: GeoJSON.FeatureCollection | null = null;
const POI_MIN_ZOOM = 11;

// ── Infrastructure layer IDs ─────────────────────────────────────────────────
const STORES_SOURCE_ID = "infra-stores";
const STORES_LAYER_ID = "infra-stores-layer";
const SUPPLY_SOURCE_ID = "infra-supply";
const SUPPLY_LAYER_ID = "infra-supply-layer";
const SUPPLY_ZONE_SOURCE_ID = "infra-supply-zones";
const SUPPLY_ZONE_FILL_ID = "infra-supply-zones-fill";
const SUPPLY_ZONE_LINE_ID = "infra-supply-zones-line";

const STORE_COLOR = "#22c55e";
const SUPPLY_COLOR = "#f59e0b";

function categoryToFilename(category: string): string {
  return `fsq_${category
    .toLowerCase()
    .replace(/ /g, "_")
    .replace(/\//g, "_")
    .replace(/&/g, "and")
    .replace(/,/g, "")
    .replace(/\(/g, "")
    .replace(/\)/g, "")}.geojson`;
}

function layerId(category: string) {
  return `fsq-${category.toLowerCase().replace(/\s+/g, "-")}`;
}

function locationsToGeoJSON(
  locations: InfraLocation[],
): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: locations.map((loc) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [loc.lng, loc.lat] },
      properties: { id: loc.id, name: loc.name },
    })),
  };
}

function supplyZonesToGeoJSON(
  points: SupplyPoint[],
): GeoJSON.FeatureCollection {
  const STEPS = 64;
  return {
    type: "FeatureCollection",
    features: points.map((p) => {
      const coords: [number, number][] = [];
      for (let i = 0; i <= STEPS; i++) {
        const angle = (i / STEPS) * 2 * Math.PI;
        const dLat = (p.radiusKm / 111.32) * Math.cos(angle);
        const dLng =
          (p.radiusKm / (111.32 * Math.cos((p.lat * Math.PI) / 180))) *
          Math.sin(angle);
        coords.push([p.lng + dLng, p.lat + dLat]);
      }
      return {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [coords] },
        properties: { id: p.id, name: p.name, radiusKm: p.radiusKm },
      };
    }),
  };
}

export interface MapHandle {
  flyTo: (lat: number, lng: number, zoom?: number) => void;
}

interface MapProps {
  baseLayer: string | null;
  selectedPOIs: string[];
  opacity: number;
  existingStores: InfraLocation[];
  supplyPoints: SupplyPoint[];
  showInfrastructure: boolean;
  showSupplyZones: boolean;
}

const Map = forwardRef<MapHandle, MapProps>(function Map(
  {
    baseLayer,
    selectedPOIs,
    opacity,
    existingStores,
    supplyPoints,
    showInfrastructure,
    showSupplyZones,
  },
  ref,
) {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const baseLayerRef = useRef<string | null>(null);
  const selectedPOIsRef = useRef<string[]>([]);
  const opacityRef = useRef<number>(opacity);

  // ── Refs so style.load can read the latest prop values ──────────────────
  const existingStoresRef = useRef<InfraLocation[]>(existingStores);
  const supplyPointsRef = useRef<SupplyPoint[]>(supplyPoints);
  const showInfrastructureRef = useRef<boolean>(showInfrastructure);
  const showSupplyZonesRef = useRef<boolean>(showSupplyZones);

  // Keep refs in sync with props every render
  existingStoresRef.current = existingStores;
  supplyPointsRef.current = supplyPoints;
  showInfrastructureRef.current = showInfrastructure;
  showSupplyZonesRef.current = showSupplyZones;

  useImperativeHandle(ref, () => ({
    flyTo(lat: number, lng: number, zoom = 13) {
      mapRef.current?.flyTo({ center: [lng, lat], zoom, essential: true });
    },
  }));

  // ── Map init ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapContainerRef.current) return;

    mapboxgl.accessToken =
      "pk.eyJ1IjoiZ2VvcmdlYWxsbWFuIiwiYSI6ImNtaDR1YXdqZjAwczYyaXEyZTllZTNtMmQifQ.aalSB_Nk2Bq-dhI8Ox_McA";

    mapRef.current = new mapboxgl.Map({
      container: mapContainerRef.current,
      center: [151.1077, -33.87],
      zoom: 9,
      style: "mapbox://styles/mapbox/dark-v11",
      attributionControl: false,
    });

    mapRef.current.on("style.load", () => {
      const map = mapRef.current!;

      // ── SA2 ────────────────────────────────────────────────────────────
      map.addSource("sa2", {
        type: "geojson",
        data: "/spatialData/sa2_enriched.geojson",
      });
      map.addLayer({
        id: "sa2-fill",
        type: "fill",
        source: "sa2",
        layout: {},
        paint: { "fill-color": "#4b4bfd", "fill-opacity": 0 },
      });
      map.addLayer({
        id: "sa2-outline",
        type: "line",
        source: "sa2",
        layout: {},
        paint: {
          "line-color": "#ffffff",
          "line-opacity": 0.15,
          "line-width": 0,
        },
      });

      map.once("sourcedata", (e) => {
        if (e.sourceId === "sa2" && e.isSourceLoaded) {
          toast.success("Map ready", {
            description: "SA2 boundary data loaded successfully.",
          });
        }
      });

      // ── Supply zone polygons ────────────────────────────────────────────
      // Use ref values so restored data is captured immediately
      map.addSource(SUPPLY_ZONE_SOURCE_ID, {
        type: "geojson",
        data: supplyZonesToGeoJSON(supplyPointsRef.current),
      });
      map.addLayer({
        id: SUPPLY_ZONE_FILL_ID,
        type: "fill",
        source: SUPPLY_ZONE_SOURCE_ID,
        layout: { visibility: showSupplyZonesRef.current ? "visible" : "none" },
        paint: { "fill-color": SUPPLY_COLOR, "fill-opacity": 0.12 },
      });
      map.addLayer({
        id: SUPPLY_ZONE_LINE_ID,
        type: "line",
        source: SUPPLY_ZONE_SOURCE_ID,
        layout: { visibility: showSupplyZonesRef.current ? "visible" : "none" },
        paint: {
          "line-color": SUPPLY_COLOR,
          "line-opacity": 0.6,
          "line-width": 1.5,
          "line-dasharray": [3, 2],
        },
      });

      // ── Store circles ───────────────────────────────────────────────────
      // Use ref values so restored data is captured immediately
      map.addSource(STORES_SOURCE_ID, {
        type: "geojson",
        data: locationsToGeoJSON(existingStoresRef.current),
      });
      map.addLayer({
        id: STORES_LAYER_ID,
        type: "circle",
        source: STORES_SOURCE_ID,
        layout: { visibility: showInfrastructureRef.current ? "visible" : "none" },
        paint: {
          "circle-color": STORE_COLOR,
          "circle-opacity": 0.9,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            5,
            12,
            9,
            16,
            14,
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": 0.8,
        },
      });

      // ── Supply point circles ────────────────────────────────────────────
      // Use ref values so restored data is captured immediately
      map.addSource(SUPPLY_SOURCE_ID, {
        type: "geojson",
        data: locationsToGeoJSON(supplyPointsRef.current),
      });
      map.addLayer({
        id: SUPPLY_LAYER_ID,
        type: "circle",
        source: SUPPLY_SOURCE_ID,
        layout: { visibility: showInfrastructureRef.current ? "visible" : "none" },
        paint: {
          "circle-color": SUPPLY_COLOR,
          "circle-opacity": 0.9,
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            8,
            5,
            12,
            9,
            16,
            14,
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
          "circle-stroke-opacity": 0.8,
        },
      });

      // ── Infrastructure popups ───────────────────────────────────────────
      const infraPopup = new mapboxgl.Popup({
        closeButton: true,
        className: "sa2-popup",
        maxWidth: "220px",
      });

      map.on("click", STORES_LAYER_ID, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as Record<string, unknown>;
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [
          number,
          number,
        ];
        infraPopup
          .setLngLat(coords)
          .setHTML(
            `
          <div class="sa2-popup-inner">
            <div class="sa2-popup-title" style="color:${STORE_COLOR}">Store</div>
            <div class="sa2-popup-row">
              <span class="sa2-popup-label">Name</span>
              <span class="sa2-popup-value">${p.name ?? "—"}</span>
            </div>
          </div>
        `,
          )
          .addTo(map);
      });

      map.on("click", SUPPLY_LAYER_ID, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as Record<string, unknown>;
        const coords = (feature.geometry as GeoJSON.Point).coordinates as [
          number,
          number,
        ];
        infraPopup
          .setLngLat(coords)
          .setHTML(
            `
          <div class="sa2-popup-inner">
            <div class="sa2-popup-title" style="color:${SUPPLY_COLOR}">Supply Point</div>
            <div class="sa2-popup-row">
              <span class="sa2-popup-label">Name</span>
              <span class="sa2-popup-value">${p.name ?? "—"}</span>
            </div>
          </div>
        `,
          )
          .addTo(map);
      });

      map.on("click", SUPPLY_ZONE_FILL_ID, (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as Record<string, unknown>;
        infraPopup
          .setLngLat(e.lngLat)
          .setHTML(
            `
          <div class="sa2-popup-inner">
            <div class="sa2-popup-title" style="color:${SUPPLY_COLOR}">Supply Zone</div>
            <div class="sa2-popup-row">
              <span class="sa2-popup-label">Name</span>
              <span class="sa2-popup-value">${p.name ?? "—"}</span>
            </div>
            <div class="sa2-popup-row">
              <span class="sa2-popup-label">Radius</span>
              <span class="sa2-popup-value">${p.radiusKm ?? "—"} km</span>
            </div>
          </div>
        `,
          )
          .addTo(map);
      });

      [STORES_LAYER_ID, SUPPLY_LAYER_ID, SUPPLY_ZONE_FILL_ID].forEach((lid) => {
        map.on("mouseenter", lid, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", lid, () => {
          map.getCanvas().style.cursor = "";
        });
      });

      // ── Grid & POIs ─────────────────────────────────────────────────────
      applyLayer(map, baseLayerRef.current, opacityRef);
      applyPOILayers(map, [], selectedPOIsRef.current);

      // ── SA2 popup ───────────────────────────────────────────────────────
      const popup = new mapboxgl.Popup({
        closeButton: true,
        className: "sa2-popup",
        maxWidth: "280px",
      });
      const row = (label: string, value: unknown, prefix = "", suffix = "") =>
        `<div class="sa2-popup-row">
          <span class="sa2-popup-label">${label}</span>
          <span class="sa2-popup-value">${value != null && value !== "" ? prefix + value + suffix : "—"}</span>
        </div>`;

      map.on("click", "sa2-fill", (e) => {
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as Record<string, unknown>;
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `
          <div class="sa2-popup-inner">
            <div class="sa2-popup-title">${p.sa2_name_2021 ?? "Unknown Area"}</div>
            ${row("Population", p.population_2021 != null ? Number(p.population_2021).toLocaleString() : null)}
            ${row("Avg Weekly Rent", p.avg_weekly_rent, "$", "/wk")}
            ${row("IRSD Score", p.IRSD_score)}
            ${row("IRSD Decile", p.IRSD_decile)}
            ${row("IRSAD Score", p.IRSAD_score)}
            ${row("IEO Score", p.IEO_score)}
            ${row("IER Score", p.IER_score)}
          </div>
        `,
          )
          .addTo(map);
      });

      map.on("click", "grid-fill", (e) => {
        if (!baseLayerRef.current || !GRID_LAYERS[baseLayerRef.current]) return;
        const feature = e.features?.[0];
        if (!feature) return;
        const p = feature.properties as Record<string, unknown>;
        const storeRows = Object.entries(p)
          .filter(([k]) => k.startsWith("stores_"))
          .map(([k, v]) => {
            const label = k
              .replace("stores_", "")
              .replace(/_/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
            return row(label, v);
          })
          .join("");
        popup
          .setLngLat(e.lngLat)
          .setHTML(
            `
          <div class="sa2-popup-inner">
            <div class="sa2-popup-title">Grid Cell</div>
            ${row("Rating", p.rating != null ? Number(p.rating).toFixed(2) : null)}
            ${row("Rent", p.rent != null ? Number(p.rent).toFixed(3) : null)}
            ${row("Income", p.income != null ? Number(p.income).toFixed(3) : null)}
            ${row("Pop", p.Pop != null ? Number(p.Pop).toFixed(3) : null)}
            ${storeRows}
          </div>
        `,
          )
          .addTo(map);
      });

      map.on("click", (e) => {
        const activeLayers = [
          "sa2-fill",
          ...(map.getLayer("grid-fill") ? ["grid-fill"] : []),
          ...selectedPOIsRef.current
            .map(layerId)
            .filter((id) => map.getLayer(id)),
        ];
        const hits = map.queryRenderedFeatures(e.point, {
          layers: activeLayers,
        });
        if (!hits.length) popup.remove();
      });

      map.on("mouseenter", "sa2-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "sa2-fill", () => {
        map.getCanvas().style.cursor = "";
      });
    });

    return () => {
      mapRef.current?.remove();
    };
  }, []);

  // ── Sync baseLayer ──────────────────────────────────────────────────────
  useEffect(() => {
    baseLayerRef.current = baseLayer;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !map.getLayer("sa2-fill")) return;
    applyLayer(map, baseLayer, opacityRef);
  }, [baseLayer]);

  // ── Sync selectedPOIs ───────────────────────────────────────────────────
  useEffect(() => {
    const prev = selectedPOIsRef.current;
    selectedPOIsRef.current = selectedPOIs;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    applyPOILayers(map, prev, selectedPOIs);
  }, [selectedPOIs]);

  // ── Sync opacity ────────────────────────────────────────────────────────
  useEffect(() => {
    opacityRef.current = opacity;
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const normalized = opacity / 100;
    const layer = baseLayerRef.current;
    if (layer && GRID_LAYERS[layer]) {
      if (map.getLayer("grid-fill"))
        map.setPaintProperty("grid-fill", "fill-opacity", normalized);
    } else if (layer && map.getLayer("sa2-fill")) {
      map.setPaintProperty("sa2-fill", "fill-opacity", normalized);
    }
  }, [opacity]);

  // ── Sync existingStores data ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource(STORES_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined
    )?.setData(locationsToGeoJSON(existingStores));
  }, [existingStores]);

  // ── Sync supplyPoints data (circles + zones) ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource(SUPPLY_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined
    )?.setData(locationsToGeoJSON(supplyPoints));
    (
      map.getSource(SUPPLY_ZONE_SOURCE_ID) as mapboxgl.GeoJSONSource | undefined
    )?.setData(supplyZonesToGeoJSON(supplyPoints));
  }, [supplyPoints]);

  // ── Sync showInfrastructure visibility ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const v = showInfrastructure ? "visible" : "none";
    if (map.getLayer(STORES_LAYER_ID))
      map.setLayoutProperty(STORES_LAYER_ID, "visibility", v);
    if (map.getLayer(SUPPLY_LAYER_ID))
      map.setLayoutProperty(SUPPLY_LAYER_ID, "visibility", v);
  }, [showInfrastructure]);

  // ── Sync showSupplyZones visibility ──────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const v = showSupplyZones ? "visible" : "none";
    if (map.getLayer(SUPPLY_ZONE_FILL_ID))
      map.setLayoutProperty(SUPPLY_ZONE_FILL_ID, "visibility", v);
    if (map.getLayer(SUPPLY_ZONE_LINE_ID))
      map.setLayoutProperty(SUPPLY_ZONE_LINE_ID, "visibility", v);
  }, [showSupplyZones]);

  return (
    <>
      <style>{`
        .sa2-popup .mapboxgl-popup-content {
          background: rgba(12, 12, 18, 0.97);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 12px;
          padding: 0;
          color: white;
          font-family: inherit;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        }
        .sa2-popup .mapboxgl-popup-tip { border-top-color: rgba(12, 12, 18, 0.97); }
        .sa2-popup-inner { padding: 14px 16px; display: flex; flex-direction: column; gap: 5px; }
        .sa2-popup-title {
          font-weight: 700; font-size: 14px; margin-bottom: 8px;
          padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.1); line-height: 1.3;
        }
        .sa2-popup-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; font-size: 12px; }
        .sa2-popup-label { color: rgba(255,255,255,0.45); white-space: nowrap; }
        .sa2-popup-value { font-weight: 600; text-align: right; }
      `}</style>
      <div
        className="w-[70vw] h-full"
        id="map-container"
        ref={mapContainerRef}
      />
    </>
  );
});

export default Map;

// ── POI colours ──────────────────────────────────────────────────────────────
const CATEGORY_COLORS: Record<string, string> = {
  "Dining and Drinking": "#ff7f00",
  Retail: "#e31a1c",
  "Arts and Entertainment": "#6a3d9a",
  "Health and Medicine": "#33a02c",
  "Business and Professional Services": "#1f78b4",
  "Community and Government": "#b15928",
  Education: "#ffff99",
  "Landmarks and Outdoors": "#b2df8a",
  "Sports and Recreation": "#a6cee3",
  "Travel and Transportation": "#fb9a99",
};

function applyPOILayers(map: mapboxgl.Map, prev: string[], next: string[]) {
  const toRemove = prev.filter((c) => !next.includes(c));
  const toAdd = next.filter((c) => !prev.includes(c));

  toRemove.forEach((category) => {
    const id = layerId(category);
    if (map.getLayer(id)) map.removeLayer(id);
    if (map.getSource(id)) map.removeSource(id);
  });

  toAdd.forEach((category) => {
    const id = layerId(category);
    const file = categoryToFilename(category);

    map.addSource(id, {
      type: "geojson",
      data: `/spatialData/fsq_by_category/${file}`,
    });
    map.addLayer({
      id,
      type: "circle",
      source: id,
      minzoom: POI_MIN_ZOOM,
      paint: {
        "circle-color": CATEGORY_COLORS[category] ?? "#ff7f00",
        "circle-opacity": 0.85,
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          POI_MIN_ZOOM,
          2,
          14,
          4,
          17,
          7,
        ],
      },
    });

    const onSourceData = (e: mapboxgl.MapSourceDataEvent) => {
      if (e.sourceId === id && e.isSourceLoaded) {
        toast.success(`${category} loaded`, {
          description: "POI layer is now visible on the map.",
        });
        map.off("sourcedata", onSourceData);
      }
    };
    map.on("sourcedata", onSourceData);

    map.on("click", id, (e) => {
      const feature = e.features?.[0];
      if (!feature) return;
      const p = feature.properties as Record<string, unknown>;
      const coords = (feature.geometry as GeoJSON.Point).coordinates as [
        number,
        number,
      ];
      new mapboxgl.Popup({
        closeButton: true,
        className: "sa2-popup",
        maxWidth: "280px",
      })
        .setLngLat(coords)
        .setHTML(
          `
          <div class="sa2-popup-inner">
            <div class="sa2-popup-title">${p.name ?? "Unknown"}</div>
            <div class="sa2-popup-row"><span class="sa2-popup-label">Category</span><span class="sa2-popup-value">${p.category ?? "—"}</span></div>
            <div class="sa2-popup-row"><span class="sa2-popup-label">Locality</span><span class="sa2-popup-value">${p.locality ?? "—"}</span></div>
            <div class="sa2-popup-row"><span class="sa2-popup-label">Region</span><span class="sa2-popup-value">${p.region ?? "—"}</span></div>
          </div>
        `,
        )
        .addTo(map);
    });

    map.on("mouseenter", id, () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", id, () => {
      map.getCanvas().style.cursor = "";
    });
  });
}

function addGridToMap(
  map: mapboxgl.Map,
  data: GeoJSON.FeatureCollection,
  colorRamp: mapboxgl.Expression,
  opacity: number,
  baseLayer: string | null,
) {
  map.addSource("grid", { type: "geojson", data });
  map.addLayer({
    id: "grid-fill",
    type: "fill",
    source: "grid",
    layout: {},
    paint: { "fill-color": colorRamp, "fill-opacity": opacity },
  });
  map.addLayer({
    id: "grid-outline",
    type: "line",
    source: "grid",
    layout: {},
    paint: { "line-color": "#ffffff", "line-opacity": 0.15, "line-width": 0.3 },
  });

  const onGridSourceData = (e: mapboxgl.MapSourceDataEvent) => {
    if (e.sourceId === "grid" && e.isSourceLoaded) {
      toast.success(`${baseLayer} layer loaded`, {
        description: "Grid data is now visible on the map.",
      });
      map.off("sourcedata", onGridSourceData);
    }
  };
  map.on("sourcedata", onGridSourceData);
  map.on("mouseenter", "grid-fill", () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", "grid-fill", () => {
    map.getCanvas().style.cursor = "";
  });
}

function filterGridToLand(
  gridGeojson: GeoJSON.FeatureCollection,
  sa2Geojson: GeoJSON.FeatureCollection,
): GeoJSON.FeatureCollection {
  const sa2Features = sa2Geojson.features;

  function pointInPolygon(lng: number, lat: number, ring: number[][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0],
        yi = ring[i][1];
      const xj = ring[j][0],
        yj = ring[j][1];
      if (
        yi > lat !== yj > lat &&
        lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
      ) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointInSA2(lng: number, lat: number): boolean {
    for (const f of sa2Features) {
      const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon | null;
      if (!geom) continue;
      if (geom.type === "Polygon") {
        if (pointInPolygon(lng, lat, geom.coordinates[0] as number[][]))
          return true;
      } else if (geom.type === "MultiPolygon") {
        for (const poly of geom.coordinates) {
          if (pointInPolygon(lng, lat, poly[0] as number[][])) return true;
        }
      }
    }
    return false;
  }

  return {
    ...gridGeojson,
    features: gridGeojson.features.filter((f) => {
      const geom = f.geometry as GeoJSON.Polygon | null;
      if (!geom?.coordinates) return false;
      const ring = geom.coordinates[0] as number[][];
      const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
      const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
      return pointInSA2(lng, lat);
    }),
  };
}

// ── Apply layer ───────────────────────────────────────────────────────────────
function applyLayer(
  map: mapboxgl.Map,
  baseLayer: string | null,
  opacityRef: React.MutableRefObject<number>,
) {
  const opacity = opacityRef.current / 100;

  map.setPaintProperty("sa2-fill", "fill-color", "#4b4bfd");
  map.setPaintProperty("sa2-fill", "fill-opacity", 0);

  if (map.getLayer("grid-fill"))
    map.setPaintProperty("grid-fill", "fill-opacity", 0);
  if (map.getLayer("grid-outline"))
    map.setPaintProperty("grid-outline", "line-opacity", 0);

  if (baseLayer && GRID_LAYERS[baseLayer]) {
    const colorRamp = GRID_LAYERS[baseLayer];

    if (!map.getSource("grid")) {
      map.addSource("grid", { type: "geojson", data: GRID_GEOJSON_PATH });
      map.addLayer({
        id: "grid-fill",
        type: "fill",
        source: "grid",
        layout: {},
        paint: { "fill-color": colorRamp, "fill-opacity": opacity },
      });
      map.addLayer({
        id: "grid-outline",
        type: "line",
        source: "grid",
        layout: {},
        paint: {
          "line-color": "#ffffff",
          "line-opacity": 0.15,
          "line-width": 0.3,
        },
      });

      const onGridSourceData = (e: mapboxgl.MapSourceDataEvent) => {
        if (e.sourceId === "grid" && e.isSourceLoaded) {
          toast.success(`${baseLayer} layer loaded`, {
            description: "Grid data is now visible on the map.",
          });
          map.off("sourcedata", onGridSourceData);
        }
      };
      map.on("sourcedata", onGridSourceData);
      map.on("mouseenter", "grid-fill", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "grid-fill", () => {
        map.getCanvas().style.cursor = "";
      });
      return;
    } else {
      map.setPaintProperty("grid-fill", "fill-color", colorRamp);
      map.setPaintProperty("grid-fill", "fill-opacity", opacity);
      map.setPaintProperty("grid-outline", "line-opacity", 0.15);
      toast.success(`${baseLayer} layer applied`, {
        description: "Switched to new data layer.",
      });
      return;
    }
  }

  if (!baseLayer || !LAYER_CONFIG[baseLayer]) return;

  const { property, stops } = LAYER_CONFIG[baseLayer];
  const ramp: mapboxgl.Expression = [
    "interpolate",
    ["linear"],
    ["coalesce", ["get", property], 0],
    ...stops.reduce<(number | string)[]>(
      (acc, [stop, color]) => acc.concat(stop, color),
      [],
    ),
  ];

  map.setPaintProperty("sa2-fill", "fill-color", ramp);
  map.setPaintProperty("sa2-fill", "fill-opacity", opacity);
  toast.success(`${baseLayer} layer applied`, {
    description: "SA2 boundary data updated.",
  });
}