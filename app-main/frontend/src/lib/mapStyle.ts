import type { StyleSpecification } from "maplibre-gl";

/** Aviation-oriented dark style on OpenFreeMap vector tiles (OpenMapTiles schema, © OpenStreetMap).
 * No streets, shops or POIs: water, country/state borders (dashed), cities in LATIN script,
 * and — close to airports — aprons, buildings/terminals, taxiways (gold) and runways (light grey).
 * Vector tiles stay sharp at every zoom (no blurry upscaled raster). */
const LATIN = ["coalesce", ["get", "name:latin"], ["get", "name_en"], ["get", "name"]];
const LABEL = "#9AA4B2";
const HALO = "#0B1018";

export const MAP_STYLE: StyleSpecification = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: {
    omt: {
      type: "vector",
      url: "https://tiles.openfreemap.org/planet",
      attribution:
        '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank">OpenMapTiles</a> Données © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0B1018" } },
    { id: "water", type: "fill", source: "omt", "source-layer": "water", paint: { "fill-color": "#17212F", "fill-antialias": false } },
    {
      id: "boundary-state", type: "line", source: "omt", "source-layer": "boundary", minzoom: 4,
      filter: ["all", ["==", ["get", "admin_level"], 4], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": "#2B3341", "line-width": 0.7, "line-dasharray": [3, 3] },
    },
    {
      id: "boundary-country", type: "line", source: "omt", "source-layer": "boundary",
      filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
      paint: { "line-color": "#4A5466", "line-width": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 10, 1.6], "line-dasharray": [4, 3] },
    },
    // roads & motorways: lines only, no names / numbers (no transportation_name layer). They fade in progressively
    // when zooming in and disappear when zooming out, so they never clutter the radar at large scale.
    {
      id: "road-minor", type: "line", source: "omt", "source-layer": "transportation", minzoom: 12,
      filter: ["all", ["match", ["get", "class"], ["minor", "service", "tertiary"], true, false], ["!=", ["get", "brunnel"], "tunnel"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#1A2130", "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.4, 16, 2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 12, 0, 13.5, 1],
      },
    },
    {
      id: "road-secondary", type: "line", source: "omt", "source-layer": "transportation", minzoom: 10,
      filter: ["all", ["match", ["get", "class"], ["primary", "secondary"], true, false], ["!=", ["get", "brunnel"], "tunnel"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#232C3D", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 10, 0, 11.5, 1],
      },
    },
    {
      id: "road-major", type: "line", source: "omt", "source-layer": "transportation", minzoom: 7,
      filter: ["all", ["match", ["get", "class"], ["motorway", "trunk"], true, false], ["!=", ["get", "brunnel"], "tunnel"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#2E3A50", "line-width": ["interpolate", ["linear"], ["zoom"], 7, 0.4, 10, 1.4, 16, 4.5],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0, 9, 0.55, 11, 1],
      },
    },
    {
      id: "aerodrome-area", type: "fill", source: "omt", "source-layer": "aeroway", minzoom: 10,
      filter: ["all", ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false], ["==", ["get", "class"], "aerodrome"]],
      paint: { "fill-color": "#111722" },
    },
    {
      id: "apron-area", type: "fill", source: "omt", "source-layer": "aeroway", minzoom: 11,
      filter: ["all", ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false], ["==", ["get", "class"], "apron"]],
      paint: { "fill-color": "#1E2533" },
    },
    {
      id: "building", type: "fill", source: "omt", "source-layer": "building", minzoom: 14,
      paint: { "fill-color": "#1F2635", "fill-outline-color": "#2C3547" },
    },
    {
      id: "aeroway-taxiway", type: "line", source: "omt", "source-layer": "aeroway", minzoom: 11,
      filter: ["all", ["==", ["get", "class"], "taxiway"], ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#C9A445", "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 11, 0.6, 14, 1.6, 18, 4] },
    },
    {
      id: "aeroway-runway", type: "line", source: "omt", "source-layer": "aeroway", minzoom: 8,
      filter: ["all", ["==", ["get", "class"], "runway"], ["match", ["geometry-type"], ["LineString", "MultiLineString"], true, false]],
      layout: { "line-cap": "butt" },
      paint: { "line-color": "#D3D9E2", "line-width": ["interpolate", ["exponential", 2], ["zoom"], 8, 1, 12, 3, 15, 22, 18, 170] },
    },
    {
      id: "aeroway-runway-area", type: "fill", source: "omt", "source-layer": "aeroway", minzoom: 11,
      filter: ["all", ["==", ["get", "class"], "runway"], ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false]],
      paint: { "fill-color": "#D3D9E2" },
    },
    {
      id: "water-name", type: "symbol", source: "omt", "source-layer": "water_name", maxzoom: 8,
      filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      layout: { "text-field": LATIN as never, "text-font": ["Noto Sans Italic"], "text-size": 11 },
      paint: { "text-color": "#4D5D74", "text-halo-color": HALO, "text-halo-width": 1 },
    },
    {
      id: "place-country", type: "symbol", source: "omt", "source-layer": "place", maxzoom: 6,
      filter: ["==", ["get", "class"], "country"],
      layout: { "text-field": LATIN as never, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 5, 13], "text-transform": "uppercase", "text-letter-spacing": 0.1 },
      paint: { "text-color": "#6B7587", "text-halo-color": HALO, "text-halo-width": 1.2 },
    },
    {
      id: "place-city", type: "symbol", source: "omt", "source-layer": "place", minzoom: 3, maxzoom: 13,
      filter: ["==", ["get", "class"], "city"],
      layout: { "text-field": LATIN as never, "text-font": ["Noto Sans Regular"], "text-size": ["interpolate", ["linear"], ["zoom"], 3, 11, 9, 14] },
      paint: { "text-color": LABEL, "text-halo-color": HALO, "text-halo-width": 1.2 },
    },
    {
      id: "place-town", type: "symbol", source: "omt", "source-layer": "place", minzoom: 8, maxzoom: 13,
      filter: ["==", ["get", "class"], "town"],
      layout: { "text-field": LATIN as never, "text-font": ["Noto Sans Regular"], "text-size": 11 },
      paint: { "text-color": "#7A8494", "text-halo-color": HALO, "text-halo-width": 1 },
    },
  ],
};
