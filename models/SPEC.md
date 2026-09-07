# Vehicle 3D models

Drop the `.glb` files in this folder using **exactly** these names. The app maps
the backend `VehicleType` enum straight onto the filename, so a typo means a
missing model rather than a build error.

| File            | VehicleType | Notes                                  |
|-----------------|-------------|----------------------------------------|
| `car.glb`       | `CAR`       | Sedan/hatchback                        |
| `truck.glb`     | `TRUCK`     | Rigid lorry or tractor+trailer         |
| `bus.glb`       | `BUS`       | City bus                               |
| `bike.glb`      | `BIKE`      | Motorcycle/scooter                     |

All four are needed. If one is missing the app falls back to the drawn silhouette
for that type, so partial delivery is fine — nothing breaks.

## Requirements

**Format** — `.glb` (binary glTF 2.0, single self-contained file). Not `.gltf`
with side files, not `.fbx`, not `.obj`.

**Orientation** — this is the part that matters most, because the model is
rotated to the vehicle's live GPS heading:

```
        -Z  (front of vehicle / direction of travel)
         |
         |
  -X ----+---- +X          +Y is up
         |
        +Z  (rear)
```

- **+Y up**, **front facing -Z** (the glTF forward convention)
- **Centred at the origin** on X and Z
- **Wheels resting on Y = 0**, not centred vertically

If the model faces the wrong way I can correct it with a fixed offset, but it is
cleaner to get it right in the export.

**Scale** — real-world metres. A car is ~4.5 m long, a city bus ~12 m. I
normalise per type in code, but consistent real scale makes the fleet look right
relative to each other.

**Budget** — these render on mid-range Android phones:

- ≤ 40k triangles per model
- Textures ≤ 1024×1024, baked PBR (base colour / metallic-roughness / normal)
- **≤ 2 MB per file** ideally, 5 MB hard ceiling
- Draco or meshopt compression welcome
- No animation tracks, no rigging, no cameras, no lights — just the mesh

Four models at 2 MB each adds ~8 MB to the APK, which is acceptable. At 5 MB
each it is 20 MB and I would move them to a download-on-first-run instead.

**Materials** — a neutral paint colour is best. The app tints by status
(moving / idle / offline) and a strongly branded livery fights that. Glass,
lights and tyres should be separate materials so they read correctly.

## Where these get used

- Vehicle detail page — 3D hero, rotating to the live heading
- Live view HUD — 3D inset turning as the vehicle turns
- Fleet list and vehicle-type pickers — thumbnails

**Not on the map itself.** The live map uses native MapLibre, which renders the
basemap and buildings natively and cannot host a GLB mesh in its scene. Map
markers stay the drawn silhouettes, laid flat on the ground plane. Putting real
meshes on the map would require the WebView + MapLibre GL JS + Three.js stack,
which costs native performance and battery.

## Free sources, if useful

Poly Haven, Sketchfab (filter to CC0 / CC-BY), Quaternius vehicle packs, and
Kenney's vehicle kits are all usable commercially. Check the licence on anything
from Sketchfab — plenty of it is *not* redistributable, and this ships in a Play
Store binary.
