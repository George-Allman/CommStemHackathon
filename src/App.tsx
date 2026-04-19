import Map from "./components/map.tsx";
import type { MapHandle } from "./components/map.tsx";
import NavButton from "./components/nav-button.tsx";
import { FaHome, FaGlobeAsia, FaChartBar } from "react-icons/fa";
import { FaGear } from "react-icons/fa6";
import { IoIosNotifications } from "react-icons/io";
import { MdOutlineQuestionMark } from "react-icons/md";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
  ComboboxInput,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import * as React from "react";
import { Slider } from "@/components/ui/slider";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toaster, toast } from "sonner";
import { X } from "lucide-react";

import { TrendingUp } from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

const chartData = [
  { month: "January", desktop: 186 },
  { month: "February", desktop: 305 },
  { month: "March", desktop: 237 },
  { month: "April", desktop: 73 },
  { month: "May", desktop: 209 },
  { month: "June", desktop: 214 },
];
const chartConfig = {
  desktop: {
    label: "Desktop",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig;

// ── City definitions ─────────────────────────────────────────────────────────
const CITIES = [
  { name: "Sydney", lat: -33.8688, lng: 151.2093, zoom: 11 },
  { name: "Melbourne", lat: -37.8136, lng: 144.9631, zoom: 11 },
  { name: "Brisbane", lat: -27.4698, lng: 153.0251, zoom: 11 },
  { name: "Gold Coast", lat: -28.0167, lng: 153.4, zoom: 11 },
  { name: "Adelaide", lat: -34.9285, lng: 138.6007, zoom: 11 },
  { name: "Newcastle", lat: -32.9283, lng: 151.7817, zoom: 12 },
  { name: "Sunshine Coast", lat: -26.65, lng: 153.0667, zoom: 11 },
  { name: "Canberra", lat: -35.2809, lng: 149.13, zoom: 11 },
  { name: "Perth", lat: -31.9505, lng: 115.8605, zoom: 11 },
  { name: "Wollongong", lat: -34.4278, lng: 150.8931, zoom: 12 },
] as const;

const GRID_GEOJSON_PATH = "/spatialData/rated_locations.geojson";
const SA2_GEOJSON_PATH = "/spatialData/sa2_enriched.geojson";

const EXCLUSION_RADIUS_KM = 2;
const TOP_N = 15;

const options_base_layer = [
  "Population Density",
  "Socioeconomic Status",
  "Rating",
  "Rent per sqm",
];

const options_POIS = [
  "Arts and Entertainment",
  "Business and Professional Services",
  "Community and Government",
  "Dining and Drinking",
  "Education",
  "Health and Medicine",
  "Landmarks and Outdoors",
  "Retail",
  "Sports and Recreation",
  "Travel and Transportation",
] as const;

// ── Infrastructure types ─────────────────────────────────────────────────────
export interface InfraLocation {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface SupplyPoint extends InfraLocation {
  radiusKm: number;
}

export interface ApiParams {
  city: string | null;
  businessCategory: string | null;
  existingStores: InfraLocation[];
  storeSpacing: number;
}

interface TopLocation {
  rank: number;
  label: string;
  rating: number;
  lat: number;
  lng: number;
}

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

function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polygonCentroid(coords: number[][]): [number, number] {
  const lng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
  const lat = coords.reduce((s, c) => s + c[1], 0) / coords.length;
  return [lat, lng];
}

function App() {
  const anchor = useComboboxAnchor();
  const mapRef = React.useRef<MapHandle>(null);

  // ── Restoration flag (replaces hasLoaded ref) ────────────────────────────
  const [isRestored, setIsRestored] = React.useState(false);

  const [selectedCity, setSelectedCity] = React.useState<
    (typeof CITIES)[number] | null
  >(null);
  const [businessCategory, setBusinessCategory] = React.useState<string | null>(
    null,
  );
  const [baseLayer, setBaseLayer] = React.useState<string | null>(null);
  const [selectedPOIs, setSelectedPOIs] = React.useState<string[]>([]);
  const [opacity, setOpacity] = React.useState<number>(75);
  const [showInfrastructure, setShowInfrastructure] = React.useState(false);
  const [showSupplyZones, setShowSupplyZones] = React.useState(false);

  const [storeSpacing, setStoreSpacing] = React.useState(1000);
  const [isPipelineRunning, setIsPipelineRunning] = React.useState(false);

  // ── Go-to location inputs ────────────────────────────────────────────────
  const [goToLat, setGoToLat] = React.useState("");
  const [goToLng, setGoToLng] = React.useState("");

  // ── Stores form state ────────────────────────────────────────────────────
  const [storeNameInput, setStoreNameInput] = React.useState("");
  const [storeLatInput, setStoreLatInput] = React.useState("");
  const [storeLngInput, setStoreLngInput] = React.useState("");

  // ── Supply form state ────────────────────────────────────────────────────
  const [supplyNameInput, setSupplyNameInput] = React.useState("");
  const [supplyLatInput, setSupplyLatInput] = React.useState("");
  const [supplyLngInput, setSupplyLngInput] = React.useState("");
  const [supplyRadiusInput, setSupplyRadiusInput] = React.useState("");

  // ── Infrastructure dictionaries ──────────────────────────────────────────
  const [existingStores, setExistingStores] = React.useState<InfraLocation[]>(
    [],
  );
  const [supplyPoints, setSupplyPoints] = React.useState<SupplyPoint[]>([]);

  const [topLocations, setTopLocations] = React.useState<TopLocation[]>([]);

  // ── Derived API params ───────────────────────────────────────────────────
  const apiParams: ApiParams = React.useMemo(
    () => ({
      city: selectedCity?.name ?? null,
      businessCategory,
      existingStores,
      storeSpacing,
    }),
    [selectedCity, businessCategory, existingStores, storeSpacing],
  );

  React.useEffect(() => {
    console.log("API Params updated:", apiParams);
  }, [apiParams]);

  // ── Restore from localStorage on mount ──────────────────────────────────
  React.useEffect(() => {
    const raw = localStorage.getItem("appState");
    if (!raw) {
      setIsRestored(true);
      return;
    }
    try {
      const data = JSON.parse(raw);
      if (data.selectedCity) {
        const city = CITIES.find((c) => c.name === data.selectedCity) ?? null;
        setSelectedCity(city);
      }
      if (data.businessCategory) setBusinessCategory(data.businessCategory);
      if (typeof data.storeSpacing === "number")
        setStoreSpacing(data.storeSpacing);
      if (data.existingStores?.length) setExistingStores(data.existingStores);
      if (data.supplyPoints?.length) setSupplyPoints(data.supplyPoints);
      toast.info("Session restored", {
        description: "Your previous parameters have been loaded.",
      });
    } catch {}
    // Signal that hydration is complete — the save effect will now be allowed to run
    setIsRestored(true);
  }, []);

  // ── Persist to localStorage (only after restoration is complete) ─────────
  React.useEffect(() => {
    if (!isRestored) return;
    localStorage.setItem(
      "appState",
      JSON.stringify({
        selectedCity: selectedCity?.name ?? null,
        businessCategory,
        storeSpacing,
        existingStores,
        supplyPoints,
      }),
    );
  }, [
    isRestored,
    selectedCity,
    businessCategory,
    storeSpacing,
    existingStores,
    supplyPoints,
  ]);

  function handleGoTo() {
    const parsedLat = parseFloat(goToLat);
    const parsedLng = parseFloat(goToLng);
    if (isNaN(parsedLat) || isNaN(parsedLng)) return;
    mapRef.current?.flyTo(parsedLat, parsedLng);
  }

  function handleAddStore() {
    const lat = parseFloat(storeLatInput);
    const lng = parseFloat(storeLngInput);
    if (isNaN(lat) || isNaN(lng)) {
      toast.error("Invalid coordinates", {
        description: "Please enter valid lat/lng values.",
      });
      return;
    }
    const name = storeNameInput.trim() || `Store ${existingStores.length + 1}`;
    setExistingStores((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name, lat, lng },
    ]);
    setStoreNameInput("");
    setStoreLatInput("");
    setStoreLngInput("");
    toast.success("Store added", {
      description: `"${name}" added to existing stores.`,
    });
  }

  async function handleRunPipeline() {
    if (!selectedCity || !businessCategory) return;
    setIsPipelineRunning(true);
    toast.loading("Running pipeline…", { id: "pipeline" });
    try {
      const res = await fetch("http://localhost:5001/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: selectedCity.name,
          target_store_type: businessCategory,
          existing_store_locations: existingStores.map((s) => [s.lat, s.lng]),
          cannibalization_hard_radius_m: storeSpacing * 0.2,
          cannibalization_fade_radius_m: storeSpacing,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      toast.success("Pipeline complete", {
        id: "pipeline",
        description: "Rated locations updated.",
      });
      if (baseLayer) {
        setBaseLayer(null);
        setTimeout(() => setBaseLayer(baseLayer), 100);
      }
    } catch (err) {
      toast.error("Pipeline failed", {
        id: "pipeline",
        description: String(err),
      });
    } finally {
      setIsPipelineRunning(false);
    }
  }

  function handleRemoveStore(id: string) {
    setExistingStores((prev) => prev.filter((s) => s.id !== id));
  }

  function handleAddSupply() {
    const lat = parseFloat(supplyLatInput);
    const lng = parseFloat(supplyLngInput);
    if (isNaN(lat) || isNaN(lng)) {
      toast.error("Invalid coordinates", {
        description: "Please enter valid lat/lng values.",
      });
      return;
    }
    const radiusKm = parseFloat(supplyRadiusInput);
    const name =
      supplyNameInput.trim() || `Supply Point ${supplyPoints.length + 1}`;
    setSupplyPoints((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        name,
        lat,
        lng,
        radiusKm: isNaN(radiusKm) || radiusKm <= 0 ? 5 : radiusKm,
      },
    ]);
    setSupplyNameInput("");
    setSupplyLatInput("");
    setSupplyLngInput("");
    setSupplyRadiusInput("");
    toast.success("Supply point added", {
      description: `"${name}" added to supply infrastructure.`,
    });
  }

  function handleRemoveSupply(id: string) {
    setSupplyPoints((prev) => prev.filter((s) => s.id !== id));
  }

  // ── Load top locations on mount ──────────────────────────────────────────
  React.useEffect(() => {
    Promise.all([
      fetch(GRID_GEOJSON_PATH).then((r) => r.json()),
      fetch(SA2_GEOJSON_PATH).then((r) => r.json()),
    ])
      .then(([gridGeojson, sa2Geojson]) => {
        type GridFeature = {
          geometry: { coordinates: number[][][] };
          properties: Record<string, unknown>;
        };
        type SA2Feature = {
          geometry: { coordinates: number[][][] } | null;
          properties: { sa2_name_2021?: string };
        };

        const gridFeatures: GridFeature[] = gridGeojson.features ?? [];
        const sa2Features: SA2Feature[] = sa2Geojson.features ?? [];

        function sa2NameAt(lng: number, lat: number): string {
          for (const f of sa2Features) {
            if (!f.geometry?.coordinates) continue;
            if (pointInPolygon(lng, lat, f.geometry.coordinates[0]))
              return f.properties.sa2_name_2021 ?? "";
          }
          return "";
        }

        const candidates = gridFeatures
          .map((f) => {
            const rating = Number(f.properties?.rating ?? 0);
            const [lat, lng] = polygonCentroid(f.geometry.coordinates[0]);
            return { lat, lng, rating };
          })
          .filter((c) => c.rating > 0)
          .sort((a, b) => b.rating - a.rating);

        const picked: typeof candidates = [];
        for (const candidate of candidates) {
          if (picked.length >= TOP_N) break;
          const tooClose = picked.some(
            (p) =>
              haversineKm(p.lat, p.lng, candidate.lat, candidate.lng) <
              EXCLUSION_RADIUS_KM,
          );
          if (!tooClose) picked.push(candidate);
        }

        const locations = picked.map((p, i) => ({
          rank: i + 1,
          label:
            sa2NameAt(p.lng, p.lat) ||
            `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
          rating: Math.round(p.rating),
          lat: p.lat,
          lng: p.lng,
        }));

        setTopLocations(locations);
        toast.success("Top locations loaded", {
          description: `${locations.length} rated locations ranked and ready.`,
        });
      })
      .catch((err) => {
        console.error(err);
        toast.error("Failed to load location data", {
          description: "Check the console for details.",
        });
      });
  }, []);

  return (
    <div className="flex flex-row h-[100vh] bg-black/90 w-full p-3 overflow-hidden no-scrollbar">
      {/* ── Sidebar ── */}
      <div className="flex flex-col gap-2 pr-4 justify-between w-[25vw] h-full">
        <div className="flex flex-col p-4 gap-2">
          <div className="text-2xl pl-4 pt-2 pb-2 rounded-lg font-bold text-left mb-4 text-white bg-white/10">
            <div className="flex flex-row">
              <p>P</p>
              <p>in</p>
              <p>P</p>
              <p>oint</p>
            </div>
          </div>
          <NavButton name="Parameters" icon={<FaHome />} />
          <NavButton name="Map" icon={<FaGlobeAsia />} />
          <NavButton name="Data" icon={<FaChartBar />} />
        </div>
        <div className="flex flex-col p-4 gap-2 border-t-2 border-white/50">
          <NavButton name="Settings" icon={<FaGear />} />
          <NavButton name="Notifications" icon={<IoIosNotifications />} />
          <NavButton name="Help" icon={<MdOutlineQuestionMark />} />
        </div>
      </div>

      {/* ── Main content ── */}
      <div
        id="main-content"
        className="bg-black/95 rounded-3xl pl-[2vw] pr-[2vw] pb-[2vw] gap-[2vw] w-full h-full overflow-scroll no-scrollbar"
      >
        {/* ── Parameters section ── */}
        <div
          id="parameters-section"
          className="flex flex-row gap-[2vw] pt-8 w-full"
        >
          {/* Business Parameters */}
          <div className="w-[25vw] rounded-lg overflow-hidden bg-white/10 text-white p-4 flex flex-col gap-6">
            <div className="flex flex-col gap-5">
              <p className="text-xl text-left font-semibold text-white uppercase tracking-wider">
                Business Parameters:
              </p>
              <div className="flex flex-col gap-2">
                <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                  Selected City
                </p>
                {/* Controlled: value reflects restored localStorage state */}
                <Combobox
                  items={CITIES.map((c) => c.name)}
                  value={selectedCity?.name ?? ""}
                  onValueChange={(val) =>
                    setSelectedCity(CITIES.find((c) => c.name === val) ?? null)
                  }
                >
                  <ComboboxInput placeholder="Select a city" showClear />
                  <ComboboxContent>
                    <ComboboxEmpty>No cities found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem key={item} value={item}>
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                  Business Category
                </p>
                {/* Controlled: value reflects restored localStorage state */}
                <Combobox
                  items={options_POIS}
                  value={businessCategory ?? ""}
                  onValueChange={(val) =>
                    setBusinessCategory((val as string) ?? null)
                  }
                >
                  <ComboboxInput placeholder="Select a category" showClear />
                  <ComboboxContent>
                    <ComboboxEmpty>No categories found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem key={item} value={item}>
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                <Combobox items={options_POIS} onValueChange={() => {}}>
                  <ComboboxInput placeholder="Select a subcategory" showClear />
                  <ComboboxContent>
                    <ComboboxEmpty>No subcategories found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem key={item} value={item}>
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                  Budget
                </p>
                <Input placeholder="Space size (sqm)" />
                <Input placeholder="Monthly rent ($)" />
              </div>
              <div className="flex flex-col gap-2">
                <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                  Preferred Store Spacing: {storeSpacing} m
                </p>
                <Slider
                  value={[storeSpacing]}
                  onValueChange={([val]) => setStoreSpacing(val)}
                  max={10000}
                  step={100}
                  className="w-full"
                />
              </div>
            </div>
          </div>

          {/* Existing Infrastructure */}
          <div className="w-[25vw] rounded-lg overflow-hidden bg-white/10 text-white p-4 flex flex-col gap-6">
            <p className="text-xl text-left font-semibold text-white uppercase tracking-wider">
              Existing Infrastructure:
            </p>

            {/* Store Locations */}
            <div className="flex flex-col gap-2">
              <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                Store Locations
              </p>
              <Input
                placeholder="Location Name"
                value={storeNameInput}
                onChange={(e) => setStoreNameInput(e.target.value)}
              />
              <div className="flex flex-row gap-3">
                <Input
                  placeholder="Lat"
                  value={storeLatInput}
                  onChange={(e) => setStoreLatInput(e.target.value)}
                />
                <Input
                  placeholder="Lng"
                  value={storeLngInput}
                  onChange={(e) => setStoreLngInput(e.target.value)}
                />
              </div>
              <Button variant="secondary" onClick={handleAddStore}>
                Add Store
              </Button>
              {existingStores.length > 0 && (
                <div className="flex flex-col gap-1 mt-1 max-h-36 overflow-y-auto">
                  {existingStores.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between bg-white/5 rounded px-2 py-1 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#22c55e] shrink-0" />
                        <span className="truncate font-medium">{s.name}</span>
                        <span className="text-white/40 shrink-0">
                          {s.lat.toFixed(3)}, {s.lng.toFixed(3)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleRemoveStore(s.id)}
                        className="ml-2 text-white/40 hover:text-white/80 shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Supply Infrastructure */}
            <div className="flex flex-col gap-2">
              <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                Supply Infrastructure
              </p>
              <Input
                placeholder="Location Name"
                value={supplyNameInput}
                onChange={(e) => setSupplyNameInput(e.target.value)}
              />
              <div className="flex flex-row gap-3">
                <Input
                  placeholder="Lat"
                  value={supplyLatInput}
                  onChange={(e) => setSupplyLatInput(e.target.value)}
                />
                <Input
                  placeholder="Lng"
                  value={supplyLngInput}
                  onChange={(e) => setSupplyLngInput(e.target.value)}
                />
              </div>
              <Input
                placeholder="Supply radius (km)"
                value={supplyRadiusInput}
                onChange={(e) => setSupplyRadiusInput(e.target.value)}
              />
              <Button variant="secondary" onClick={handleAddSupply}>
                Add Supply Point
              </Button>
              {supplyPoints.length > 0 && (
                <div className="flex flex-col gap-1 mt-1 max-h-36 overflow-y-auto">
                  {supplyPoints.map((s) => (
                    <div
                      key={s.id}
                      className="flex items-center justify-between bg-white/5 rounded px-2 py-1 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-2.5 h-2.5 rounded-full bg-[#f59e0b] shrink-0" />
                        <span className="truncate font-medium">{s.name}</span>
                        <span className="text-white/40 shrink-0">
                          {s.lat.toFixed(3)}, {s.lng.toFixed(3)} · {s.radiusKm}
                          km
                        </span>
                      </div>
                      <button
                        onClick={() => handleRemoveSupply(s.id)}
                        className="ml-2 text-white/40 hover:text-white/80 shrink-0"
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col justify-center">
            <Button
              variant="secondary"
              className="w-[22vw] h-full"
              onClick={handleRunPipeline}
              disabled={!selectedCity || !businessCategory || isPipelineRunning}
            >
              Run Analysis
            </Button>
          </div>
        </div>

        {/* ── Map section ── */}
        <div id="map-section" className="flex flex-row w-full h-full pt-8">
          <div className="flex flex-row gap-[2vw] w-full h-full border-t-2 border-white/50 pt-[2vw]">
            <div className="w-[70vw] h-full rounded-lg overflow-hidden border-2 border-white/50">
              <Map
                baseLayer={baseLayer}
                selectedPOIs={selectedPOIs}
                opacity={opacity}
                existingStores={existingStores}
                supplyPoints={supplyPoints}
                showInfrastructure={showInfrastructure}
                showSupplyZones={showSupplyZones}
                ref={mapRef}
              />
            </div>

            <div className="w-[15vw] h-full rounded-lg overflow-hidden bg-white/10 text-white p-4 flex flex-col gap-6">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                    Selected City
                  </p>
                  <p className="text-left font-bold">
                    {selectedCity?.name ?? "—"}
                  </p>
                  <Button
                    variant="secondary"
                    disabled={!selectedCity}
                    onClick={() =>
                      selectedCity &&
                      mapRef.current?.flyTo(
                        selectedCity.lat,
                        selectedCity.lng,
                        selectedCity.zoom,
                      )
                    }
                  >
                    Fly To {selectedCity?.name ?? "City"}
                  </Button>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                    Go to Location
                  </p>
                  <div className="flex flex-row gap-3">
                    <Input
                      placeholder="Lat"
                      value={goToLat}
                      onChange={(e) => setGoToLat(e.target.value)}
                    />
                    <Input
                      placeholder="Lng"
                      value={goToLng}
                      onChange={(e) => setGoToLng(e.target.value)}
                    />
                  </div>
                  <Button variant="secondary" onClick={handleGoTo}>
                    Go To Location
                  </Button>
                </div>

                <div className="flex flex-col gap-2">
                  <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                    Base Data
                  </p>
                  <Combobox
                    items={options_base_layer}
                    onValueChange={(val) =>
                      setBaseLayer((val as string) ?? null)
                    }
                  >
                    <ComboboxInput
                      placeholder="Select a data layer"
                      showClear
                    />
                    <ComboboxContent>
                      <ComboboxEmpty>No items found.</ComboboxEmpty>
                      <ComboboxList>
                        {(item) => (
                          <ComboboxItem key={item} value={item}>
                            {item}
                          </ComboboxItem>
                        )}
                      </ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                  <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                    Opacity
                  </p>
                  <Slider
                    value={[opacity]}
                    onValueChange={([val]) => setOpacity(val)}
                    max={100}
                    step={1}
                    className="mx-auto w-full max-w-xs"
                  />
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
                  Points of Interest
                </p>
                <Combobox
                  multiple
                  autoHighlight
                  items={options_POIS}
                  onValueChange={(vals) => setSelectedPOIs(vals as string[])}
                >
                  <ComboboxChips ref={anchor} className="w-full max-w-xs">
                    <ComboboxValue>
                      {(values) => (
                        <React.Fragment>
                          {values.map((value: string) => (
                            <ComboboxChip key={value}>{value}</ComboboxChip>
                          ))}
                          <ComboboxChipsInput />
                        </React.Fragment>
                      )}
                    </ComboboxValue>
                  </ComboboxChips>
                  <ComboboxContent anchor={anchor}>
                    <ComboboxEmpty>No items found.</ComboboxEmpty>
                    <ComboboxList>
                      {(item) => (
                        <ComboboxItem key={item} value={item}>
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-row justify-between items-center space-x-2">
                  <Label
                    className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider cursor-pointer"
                    htmlFor="existing"
                  >
                    Display Existing Locations
                  </Label>
                  <Switch
                    id="existing"
                    checked={showInfrastructure}
                    onCheckedChange={setShowInfrastructure}
                  />
                </div>
                <div className="flex flex-row justify-between items-center space-x-2">
                  <Label
                    className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider cursor-pointer"
                    htmlFor="supply-zones"
                  >
                    Display Supply Zones
                  </Label>
                  <Switch
                    id="supply-zones"
                    checked={showSupplyZones}
                    onCheckedChange={setShowSupplyZones}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Data section ── */}
        <div
          id="data-section"
          className="flex flex-col gap-[4vw] mb-[9vw] w-full h-full border-t-2 mt-24 border-white/50 pt-[2vw]"
        >
          <div>
            <Table>
              <TableCaption>Top Rated Locations</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px] text-left">Rank</TableHead>
                  <TableHead className="text-center">Location</TableHead>
                  <TableHead className="text-center">Rating</TableHead>
                  <TableHead className="text-right">Go-To</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {topLocations.map((loc) => (
                  <TableRow key={loc.rank}>
                    <TableCell className="w-[100px] text-left">
                      {loc.rank}
                    </TableCell>
                    <TableCell className="font-medium text-center">
                      {loc.label}
                    </TableCell>
                    <TableCell className="text-center">{loc.rating}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        className="text-black w-[100px]"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          mapRef.current?.flyTo(loc.lat, loc.lng);
                          document
                            .getElementById("map-section")
                            ?.scrollIntoView({ behavior: "smooth" });
                        }}
                      >
                        Go To
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div>
            <Card className="w-full h-full">
              <CardHeader>
                <CardTitle>Area Chart</CardTitle>
                <CardDescription>
                  Showing total visitors for the last 6 months
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ChartContainer config={chartConfig}>
                  <AreaChart
                    accessibilityLayer
                    data={chartData}
                    margin={{
                      left: 12,
                      right: 12,
                    }}
                  >
                    <CartesianGrid vertical={false} />
                    <XAxis
                      dataKey="month"
                      tickLine={false}
                      axisLine={false}
                      tickMargin={8}
                      tickFormatter={(value) => value.slice(0, 3)}
                    />
                    <ChartTooltip
                      cursor={false}
                      content={<ChartTooltipContent indicator="line" />}
                    />
                    <Area
                      dataKey="desktop"
                      type="natural"
                      fill="oklch(0.424 0.199 265.638)"
                      fillOpacity={0.4}
                      stroke="oklch(0.424 0.199 265.638)"
                    />
                  </AreaChart>
                </ChartContainer>
              </CardContent>
              <CardFooter>
                <div className="flex w-full items-start gap-2 text-sm">
                  <div className="grid gap-2">
                    <div className="flex items-center gap-2 leading-none font-medium">
                      Trending up by 5.2% this month{" "}
                      <TrendingUp className="h-4 w-4" />
                    </div>
                    <div className="flex items-center gap-2 leading-none text-muted">
                      January - June 2024
                    </div>
                  </div>
                </div>
              </CardFooter>
            </Card>
          </div>
        </div>
      </div>

      <Toaster position="bottom-right" theme="dark" richColors />
    </div>
  );
}

export default App;