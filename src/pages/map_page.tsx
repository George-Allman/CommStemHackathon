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
  ComboboxInput
} from "@/components/ui/combobox"

import Map from "@/components/map";

const options_base_layer = ["Population Density", "Socioeconomic Status"];

export default function MapPage() {
  return (
    <>
      <div className="w-[65vw] h-full rounded-lg overflow-hidden border-2 border-white/50">
        <Map />
      </div>
      <div className="w-[15vw] h-full rounded-lg overflow-hidden bg-white/10 text-white p-4 flex flex-col gap-6">
        {/* Base Data */}
        <div className="flex flex-col gap-2">
          <p className="text-sm text-left font-semibold text-white/60 uppercase tracking-wider">
            Base Data
          </p>
          <div className="flex flex-col gap-1">
            <Combobox items={options_base_layer}>
              <ComboboxInput placeholder="Select a data layer" showClear />
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
          </div>
        </div>

        {/* POIs */}
        <div className="flex flex-col gap-2"></div>
      </div>
    </>
  );
}
