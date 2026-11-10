import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "@maplibre/maplibre-gl-leaflet";
import { setWorkerUrl } from "maplibre-gl";
// MapLibre's tile worker must be bundled explicitly with Vite, otherwise tiles never render (black map)
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";

setWorkerUrl(maplibreWorkerUrl);

// The plugin schedules animation frames / throttled updates that may run after the Leaflet map was removed
// (page or mode change) and then read `this._map.getZoom()` on null. Guard every such entry point once.
type GLProto = Record<string, ((...a: unknown[]) => unknown) | boolean> & { __guarded?: boolean };
const glProto = (L as unknown as { MaplibreGL?: { prototype: GLProto } }).MaplibreGL?.prototype;
if (glProto && !glProto.__guarded) {
  glProto.__guarded = true;
  for (const name of ["_update", "_transformGL", "_pinchZoom", "_animateZoom", "_zoomEnd", "_resize"]) {
    const orig = glProto[name] as (...a: unknown[]) => unknown;
    if (typeof orig !== "function") continue;
    glProto[name] = function (this: { _map: unknown; _glMap: unknown }, ...a: unknown[]) {
      if (!this._map || !this._glMap) return;
      return orig.apply(this, a);
    };
  }
  glProto._transitionEnd = function (this: { _map: unknown; _glMap: unknown; _zoomEnd: () => void; _resizeContainer: () => void }) {
    L.Util.requestAnimFrame(() => {
      const map = this._map as L.Map | null;
      const gl = this._glMap as { _actualCanvas: HTMLElement; once: (e: string, f: () => void) => void; jumpTo: (o: object) => void } | null;
      if (!map || !gl) return;
      const zoom = map.getZoom();
      const center = map.getCenter();
      const offset = map.latLngToContainerPoint(map.getBounds().getNorthWest());
      this._resizeContainer();
      L.DomUtil.setTransform(gl._actualCanvas, offset, 1);
      gl.once("moveend", () => this._zoomEnd());
      gl.jumpTo({ center, zoom: zoom - 1 });
    });
  };
}
import { PHASE_COLORS, PHASE_LABELS } from "@/lib/phases";
import { MAP_STYLE } from "@/lib/mapStyle";
import type { AirspaceFeature, AtcPosition, FlightSummary, Ground, GroundLine, Holding, Waypoint } from "@/lib/types";

import { tr } from "@/lib/i18n";
export interface MapTaxi {
  path: number[][];
  status: "valide" | "brouillon";
}

export interface MapView {
  bbox: [number, number, number, number]; // s, w, n, e
  zoom: number;
}

interface Props {
  flights?: FlightSummary[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  route?: Waypoint[];
  flownIndex?: number;
  /** current aircraft position: the flown (solid) part of the route ends ON the aircraft, the rest starts from it */
  aircraftPos?: [number, number];
  /** holding pattern racetrack and line-up track of the selected flight */
  holdPath?: number[][];
  lineupPath?: number[][];
  taxis?: MapTaxi[];
  grounds?: Ground[];
  highlightGates?: string[];
  draftPoints?: number[][];
  onGateClick?: (icao: string, ref: string) => void;
  onTaxiwayClick?: (icao: string, lat: number, lon: number, name?: string | null) => void;
  /** When set, named holding points become clickable (pilot picks his holding point on the map). */
  onHoldingClick?: (icao: string, h: Holding) => void;
  /** points to pick on the map (e.g. runway exits after an interrupted take-off) */
  pickPoints?: { id: string; lat: number; lon: number; label: string; selected?: boolean }[];
  onPickPoint?: (id: string) => void;
  /** Holding point recorded in the flight (drawn highlighted). */
  selectedHolding?: { ref: string | null; lat: number; lon: number } | null;
  onMapClick?: (lat: number, lon: number) => void;
  center?: [number, number];
  zoom?: number;
  focusKey?: string;
  crosshair?: boolean;
  /** Flèche temporaire de sens (repoussage). */
  pushHint?: { lat: number; lon: number; hdg: number; label?: string } | null;
  /** keep the map centred on this point (follow mode) without changing the zoom */
  followPos?: [number, number];
  /** the user dragged the map by hand (used to stop following the aircraft) */
  onUserPan?: () => void;
  firs?: AirspaceFeature[];
  tracons?: AirspaceFeature[];
  atc?: AtcPosition[];
  showGround?: boolean;
  onViewChange?: (v: MapView) => void;
  testId?: string;
}

/** Every dynamic string inserted into Leaflet HTML (divIcon / tooltips use innerHTML) goes through this. */
const cleanTwyName = (n: string | null | undefined) =>
  (n || "").replace(/\s*\(\d+\)\s*$/g, "").trim();

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const PLANE =
  "M12 1.5c.7 0 1.2.9 1.2 2v5.2l8 4.6v2l-8-2.4v5l2.2 1.7V21L12 20l-3.4 1v-1.4l2.2-1.7v-5l-8 2.4v-2l8-4.6V3.5c0-1.1.5-2 1.2-2z";
const ATC_COLORS: Record<string, string> = { DEL: "#94A3B8", GND: "#22C55E", TWR: "#EF4444", APP: "#4AA8F0", DEP: "#4AA8F0", CTR: "#F59E0B", FSS: "#F59E0B" };
const RWY_DESIG = /^\d{2}[LRC]?(\/\d{2}[LRC]?)?$/;

function acIcon(f: FlightSummary, selected: boolean): L.DivIcon {
  const color = PHASE_COLORS[f.phase] ?? "#94A3B8";
  const ground = f.position.on_ground;
  const shape = ground
    ? `<svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(${Number(f.position.heading) || 0}deg); margin:5px"><path d="M12 3 L20 20 L12 15 L4 20 Z" fill="${color}" stroke="#030712" stroke-width="1"/></svg>`
    : `<svg width="26" height="26" viewBox="0 0 24 24" style="transform: rotate(${Number(f.position.heading) || 0}deg)"><path d="${PLANE}" fill="${color}" stroke="#030712" stroke-width="0.6"/></svg>`;
  const ring =
    (f.phase === "suspendu"
      ? `<div style="position:absolute;inset:-4px;border:1.5px dashed #EAB308;border-radius:50%"></div>`
      : "") +
    // the selected aircraft stands out: white outline, larger symbol and a pulsing halo
    (selected ? `<div class="ac-halo"></div><div class="ac-halo ac-halo-2"></div>` : "");
  // Symbole seul (plus de rectangle callsign/statut — trop gênant sur le radar)
  const tip = `${esc(f.callsign)} · ${esc(PHASE_LABELS[f.phase] ?? f.phase)}`;
  return L.divIcon({
    className: `ac-marker ${selected ? "ac-selected" : ""}`,
    html: `<div class="ac-icon" title="${tip}" data-testid="aircraft-marker-${esc(f.callsign)}">${ring}${shape}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

const rad = (d: number) => (d * Math.PI) / 180;
function bearing(a: number[], b: number[]): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Runway ends from the real OSM centreline: each designator (e.g. 06L/24R) is placed at the threshold it
 * belongs to (06L = end you land on heading ~060°), rotated along the runway so it reads from the approach. */
export function runwayEnds(lines: GroundLine[]): { label: string; lat: number; lon: number; rot: number }[] {
  const by = new Map<string, number[][]>();
  for (const l of lines) {
    if (l.kind !== "runway" || !l.name || !RWY_DESIG.test(l.name.replace(/\s/g, ""))) continue;
    const k = l.name.replace(/\s/g, "");
    by.set(k, [...(by.get(k) ?? []), ...l.path]);
  }
  const out: { label: string; lat: number; lon: number; rot: number }[] = [];
  for (const [name, pts] of by) {
    if (pts.length < 2) continue;
    // extreme points along the main axis
    const axis = bearing(pts[0], pts[pts.length - 1]);
    const ux = Math.sin(rad(axis)), uy = Math.cos(rad(axis));
    const lat0 = pts[0][0], cosl = Math.cos(rad(lat0));
    const proj = (p: number[]) => (p[1] - pts[0][1]) * cosl * ux + (p[0] - lat0) * uy;
    let a = pts[0], b = pts[0];
    for (const p of pts) {
      if (proj(p) < proj(a)) a = p;
      if (proj(p) > proj(b)) b = p;
    }
    const hdgAB = bearing(a, b); // landing at end `a` means flying a -> b
    const ends = name.split("/");
    for (const d of ends) {
      const num = parseInt(d, 10) * 10;
      const atA = angDiff(num % 360, hdgAB) < 90;
      const [p, q] = atA ? [a, b] : [b, a];
      const hdg = atA ? hdgAB : (hdgAB + 180) % 360;
      // ~70 m inside the threshold
      const len = Math.hypot((q[1] - p[1]) * cosl, q[0] - p[0]) || 1;
      const k = Math.min(0.3, 0.00063 / len);
      out.push({ label: d, lat: p[0] + (q[0] - p[0]) * k, lon: p[1] + (q[1] - p[1]) * k, rot: hdg });
    }
  }
  return out;
}

/** Content signature of a prop: effects below redraw only when the DATA changes, not when the parent re-renders
 * (the radar polls every 2 s and every pan re-renders the page — redrawing the airports each time froze the map). */
const sig = (v: unknown) => JSON.stringify(v ?? null);
const groundSig = (gs?: Ground[]) => (gs ?? []).map((g) => `${g.icao}:${g.fetched_at ?? ""}:${g.lines.length}:${g.gates.length}`).join("|");

export default function RadarMap(p: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<Record<string, L.LayerGroup>>({});
  const markers = useRef<Map<string, L.Marker>>(new Map());
  const iconHtml = useRef<Map<string, string>>(new Map());
  const syncRef = useRef<() => void>(() => {});
  const runways = useRef<{ line: L.Polyline; lat: number }[]>([]);
  // ground labels (taxiway names, holding points, stand numbers): at each zoom, a label that would overlap one
  // already shown is hidden. Priority: selected / highlighted first, then holding points, taxiways, stands.
  const twyLabels = useRef<{ el: () => HTMLElement | undefined; ll: L.LatLng; w: number; prio: number; dot?: L.CircleMarker }[]>([]);
  const declutter = () => {
    const m = map.current;
    if (!m || !m.hasLayer(layers.current.graph)) return;
    // measured on the real text (not an estimate): only labels that truly overlap are hidden. A hidden stand
    // keeps its dot on the map, so nothing disappears completely.
    const items = [...twyLabels.current].sort((a, b) => a.prio - b.prio)
      .map((x) => ({ x, e: x.el() }))
      .filter((it): it is { x: (typeof twyLabels.current)[number]; e: HTMLElement } => !!it.e);
    for (const { e } of items) e.style.display = "";
    const boxes = items.map(({ x, e }) => {
      const r = (e.querySelector("span") ?? e).getBoundingClientRect();
      const pt = m.latLngToContainerPoint(x.ll);
      return { e, dot: x.dot, x: pt.x, y: pt.y, w: r.width || x.w, h: r.height || 13 };
    });
    const shown: { x: number; y: number; w: number; h: number }[] = [];
    for (const b of boxes) {
      const hit = shown.some((s) => Math.abs(s.x - b.x) < (s.w + b.w) / 2 + 1 && Math.abs(s.y - b.y) < (s.h + b.h) / 2);
      if (hit) b.e.style.display = "none";
      else shown.push(b);
      // stand whose number is hidden: its dot shows instead
      b.dot?.setStyle({ fillOpacity: hit ? 0.75 : 0.01 });
    }
  };
  const declutterRef = useRef(declutter);
  declutterRef.current = declutter;
  // Everything is drawn on ONE canvas, in the order it was added: an airport loaded (or shown again on zoom) after
  // the taxi route was painted OVER it, hiding the green. The route, hold, line-up and taxi are put back on top.
  const raiseOverlays = () => {
    for (const k of ["route", "taxi"]) {
      layers.current[k]?.eachLayer((l) => (l as L.Path).bringToFront?.());
    }
  };
  const cb = useRef(p);
  cb.current = p;
  const [baseError, setBaseError] = useState<string | null>(null);

  useEffect(() => {
    if (!el.current || map.current) return;
    // Canvas renderer: hundreds of taxiways / stands / sectors are drawn on one canvas instead of one SVG
    // element each — the main cause of slow panning and zooming.
    const m = L.map(el.current, {
      minZoom: 3, maxZoom: 19, maxBounds: [[-85, -400], [85, 400]], zoomControl: true, attributionControl: true, worldCopyJump: true,
      preferCanvas: true, renderer: L.canvas({ padding: 0.5, tolerance: 4 }), zoomSnap: 0.5, wheelPxPerZoomLevel: 90,
    }).setView(
      p.center ?? [47.6, 4.3],
      p.zoom ?? 6,
    );
    // Vector base (OpenFreeMap). If WebGL or the tile server fails we fall back to a raster base and
    // show an explicit message instead of a silent black screen.
    let fallback: L.TileLayer | null = null;
    let glLayer: L.Layer | null = null;
    const showFallback = (why: string) => {
      setBaseError(why);
      if (fallback) return;
      fallback = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Fond de secours &copy; Esri",
        maxNativeZoom: 16,
        maxZoom: 19,
      }).addTo(m);
      fallback.bringToBack();
    };
    try {
      const gl = L.maplibreGL({ style: MAP_STYLE, interactive: false }).addTo(m);
      glLayer = gl;
      let errors = 0;
      const glMap = gl.getMaplibreMap();
      glMap.on("error", (e: { error?: { message?: string; status?: number } }) => {
        errors += 1;
        if (errors >= 6) showFallback(tr("Fond de carte vectoriel indisponible ({0}). Fond de secours affiché.", [e.error?.status ?? e.error?.message ?? tr("réseau")]));
      });
      glMap.on("load", () => setBaseError(null));
    } catch {
      showFallback(tr("Votre navigateur ne peut pas afficher le fond vectoriel (WebGL désactivé). Fond de secours affiché."));
    }
    for (const k of ["airspace", "atc", "airports", "graph", "route", "taxi", "flights"]) layers.current[k] = L.layerGroup().addTo(m);
    const syncGraph = () => {
      const z = m.getZoom();
      if (z >= 15 && cb.current.showGround !== false) layers.current.graph.addTo(m);
      else layers.current.graph.remove();
      declutterRef.current();
      if (z >= 12 && cb.current.showGround !== false) layers.current.airports.addTo(m);
      else layers.current.airports.remove();
      // only runways currently on the map: restyling a hidden canvas layer makes Leaflet crash ("reading 'save'")
      if (m.hasLayer(layers.current.airports)) {
        for (const r of runways.current) {
          const mpp = (156543.03 * Math.cos((r.lat * Math.PI) / 180)) / 2 ** z;
          r.line.setStyle({ weight: Math.max(3, Math.min(80, 45 / mpp)) });
        }
      }
      raiseOverlays();
      el.current?.style.setProperty("--rwy-label-size", `${Math.max(10, Math.min(18, (z - 11) * 3))}px`);
    };
    syncRef.current = syncGraph;
    const emitView = () => {
      const b = m.getBounds();
      cb.current.onViewChange?.({ bbox: [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()], zoom: m.getZoom() });
    };
    m.on("zoomstart", () => el.current?.classList.add("map-zooming"));
    m.on("zoomend", () => {
      el.current?.classList.remove("map-zooming");
      syncGraph();
    });
    m.on("moveend", emitView);
    m.on("dragstart", () => cb.current.onUserPan?.());
    m.on("click", (e: L.LeafletMouseEvent) => cb.current.onMapClick?.(e.latlng.lat, e.latlng.lng));
    syncGraph();
    emitView();
    map.current = m;
    const mk = markers.current;
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      // detach the WebGL layer first: removing the map with it attached lets a pending frame read a null map
      try {
        m.stop();
        if (glLayer) m.removeLayer(glLayer);
      } catch {
        /* already detached */
      }
      m.remove();
      map.current = null;
      mk.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (map.current && p.center) map.current.setView(p.center, p.zoom ?? map.current.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusKey]);

  useEffect(() => {
    const fp = p.followPos;
    if (map.current && fp) map.current.panTo(fp, { animate: true, duration: 1 });
  }, [p.followPos?.[0], p.followPos?.[1]]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (el.current) el.current.style.cursor = p.crosshair ? "crosshair" : "";
    const m = map.current;
    if (m) {
      // Empêche le curseur « main » Leaflet pendant l'édition
      const c = (m.getContainer() as HTMLElement);
      if (p.crosshair) {
        c.classList.add("cursor-crosshair");
        c.style.cursor = "crosshair";
      } else {
        c.classList.remove("cursor-crosshair");
        c.style.cursor = "";
      }
    }
  }, [p.crosshair]);

  useEffect(() => syncRef.current(), [p.showGround]);

  // airports (real OpenStreetMap ground data) drawn like an aerodrome chart
  useEffect(() => {
    const a = layers.current.airports;
    const g = layers.current.graph;
    if (!a || !g) return;
    // Ne pas effacer si la liste grounds est momentanément vide (re-fetch) — évite disparitions intermittentes
    if (!(p.grounds?.length)) {
      return;
    }
    a.clearLayers();
    g.clearLayers();
    twyLabels.current = [];
    const hl = p.highlightGates ?? [];
    runways.current = [];
    for (const ap of p.grounds ?? []) {
      for (const ar of ap.areas ?? []) {
        L.polygon(ar.path as [number, number][], { stroke: false, fillColor: ar.kind === "terminal" ? "#2A3142" : "#222838", fillOpacity: 1, interactive: false }).addTo(a);
      }
      const rwys = ap.lines.filter((l) => l.kind === "runway");
      const taxis = ap.lines.filter((l) => l.kind !== "runway");
      for (const ln of taxis) {
        const lane = ln.kind === "taxilane";
        const canClick = !!p.onTaxiwayClick;
        const pl = L.polyline(ln.path as [number, number][], {
          color: lane ? "#9C8540" : "#D4AF4C", weight: lane ? 1.5 : 3, opacity: lane ? 0.8 : 1, lineJoin: "round", lineCap: "round",
          interactive: canClick, bubblingMouseEvents: false,
        }).addTo(a);
        if (canClick) {
          // Curseur « + » (crosshair) et non « main » pendant la saisie de roulage
          const pathEl = (pl as unknown as { getElement?: () => HTMLElement | undefined }).getElement?.();
          if (pathEl) pathEl.style.cursor = "crosshair";
          pl.on("mouseover", () => {
            const el = (pl as unknown as { getElement?: () => HTMLElement | undefined }).getElement?.();
            if (el) el.style.cursor = "crosshair";
            if (map.current) (map.current.getContainer() as HTMLElement).style.cursor = "crosshair";
          });
          pl.on("click", (e: L.LeafletMouseEvent) => {
            L.DomEvent.stopPropagation(e);
            cb.current.onTaxiwayClick?.(ap.icao, e.latlng.lat, e.latlng.lng, cleanTwyName(ln.name) || null);
            // Reposer le crosshair après le clic (Leaflet repasse sinon en grab/pointer)
            if (map.current) (map.current.getContainer() as HTMLElement).style.cursor = "crosshair";
          });
          if (ln.name) pl.bindTooltip(esc(cleanTwyName(ln.name)), { sticky: true, direction: "top" });
        }
      }
      for (const ln of rwys) {
        const line = L.polyline(ln.path as [number, number][], { color: "#D3D9E2", weight: 12, opacity: 1, lineCap: "butt", interactive: false }).addTo(a);
        runways.current.push({ line, lat: ap.lat });
        L.polyline(ln.path as [number, number][], { color: "#1B2130", weight: 1.5, dashArray: "14 12", opacity: 0.9, interactive: false }).addTo(a);
      }
      // runway designators at both thresholds, oriented along the runway
      for (const r of runwayEnds(ap.lines)) {
        L.marker([r.lat, r.lon], {
          interactive: false,
          icon: L.divIcon({
            className: "rwy-label",
            html: `<span style="transform: translate(-50%, -50%) rotate(${r.rot.toFixed(1)}deg)" data-testid="runway-label-${esc(ap.icao)}-${esc(r.label)}">${esc(r.label)}</span>`,
            iconSize: [0, 0],
          }),
        }).addTo(a);
      }
      // Taxiway names: OSM cuts one taxiway into many small pieces, so naively labelling each piece stacks the same
      // name dozens of times. Keep one label per stretch of taxiway (same name at least ~350 m apart), skip tiny
      // pieces, and never put two labels on top of each other.
      const mPerLat = 111_320, mPerLon = 111_320 * Math.cos((ap.lat * Math.PI) / 180);
      const dist = (a: number[], b: number[]) => Math.hypot((a[0] - b[0]) * mPerLat, (a[1] - b[1]) * mPerLon);
      const pathLen = (pts: number[][]) => pts.slice(1).reduce((s, q, i) => s + dist(pts[i], q), 0);
      const placed: { name: string; at: number[] }[] = [];
      const named = taxis
        .filter((ln) => ln.name && ln.kind !== "taxilane" && ln.path.length >= 2)
        .map((ln) => ({ ln, len: pathLen(ln.path) }))
        .filter((x) => x.len >= 60)
        .sort((a, b) => b.len - a.len); // longest pieces first: their labels are the most useful
      for (const { ln } of named) {
        const mid = ln.path[Math.floor(ln.path.length / 2)];
        if (placed.some((p) => (p.name === ln.name && dist(p.at, mid) < 350) || dist(p.at, mid) < 70)) continue;
        placed.push({ name: ln.name!, at: mid });
        const lm = L.marker([mid[0], mid[1]], { interactive: false, icon: L.divIcon({ className: "twy-label", html: `<span>${esc(cleanTwyName(ln.name!))}</span>`, iconSize: [0, 0] }) }).addTo(g);
        twyLabels.current.push({ el: () => lm.getElement(), ll: lm.getLatLng(), w: ln.name!.length * 8 + 6, prio: 2 });
      }
      for (const gt of ap.gates) {
        const on = hl.includes(gt.ref);
        const mk = L.circleMarker([gt.lat, gt.lon], {
          radius: on ? 6 : 3, color: on ? "#4AA8F0" : "#E5E7EB", weight: on ? 2 : 0,
          fillColor: on ? "#4AA8F0" : "#E5E7EB", fillOpacity: on ? 0.85 : 0.01, bubblingMouseEvents: false,
          interactive: !!p.onGateClick, // otherwise a stand would swallow the clicks meant for the map
        })
          .bindTooltip(esc(gt.ref), { permanent: true, direction: "center", className: on ? "stand-label stand-on" : "stand-label" })
          .addTo(g);
        mk.on("click", () => cb.current.onGateClick?.(ap.icao, gt.ref));
        twyLabels.current.push({ el: () => mk.getTooltip()?.getElement(), ll: L.latLng(gt.lat, gt.lon), w: gt.ref.length * 7 + 6, prio: on ? 0 : 3, dot: on ? undefined : mk });
      }
      for (const h of ap.holdings) {
        const sel = !!h.ref && !!p.selectedHolding && Math.abs(p.selectedHolding.lat - h.lat) < 1e-5 && Math.abs(p.selectedHolding.lon - h.lon) < 1e-5;
        // runway-named holding points ("24L/06R") stay small dots, except while the pilot is picking one
        const rwyNamed = !!h.ref && RWY_DESIG.test(h.ref.replace(/\s/g, ""));
        // names generated by the site (« B4 - 31R », no name in OpenStreetMap) are only written while picking
        if (!h.ref || ((rwyNamed || h.auto) && !p.onHoldingClick && !sel)) {
          L.circleMarker([h.lat, h.lon], { radius: 2, color: "#F97316", weight: 1, fillOpacity: 0.9, interactive: false }).addTo(g);
          continue;
        }
        if (p.onHoldingClick || sel) {
          const hm = L.circleMarker([h.lat, h.lon], {
            radius: sel ? 9 : 8, color: sel ? "#22C55E" : "#F97316", weight: 2, fillColor: sel ? "#22C55E" : "#F97316",
            fillOpacity: sel ? 0.55 : 0.25, bubblingMouseEvents: false, interactive: !!p.onHoldingClick,
          }).addTo(g);
          if (p.onHoldingClick) {
            hm.bindTooltip(`Point d'attente ${esc(h.ref)} — cliquer pour le choisir`, { direction: "top" });
            hm.on("click", () => cb.current.onHoldingClick?.(ap.icao, h));
          }
        }
        const holdLbl = L.marker([h.lat, h.lon], { interactive: false, icon: L.divIcon({ className: sel ? "twy-label twy-hold twy-hold-on" : "twy-label twy-hold", html: `<span>${esc(h.ref)}</span>`, iconSize: [0, 0] }) }).addTo(g);
        twyLabels.current.push({ el: () => holdLbl.getElement(), ll: holdLbl.getLatLng(), w: (h.ref?.length ?? 2) * 8 + 6, prio: sel ? 0 : 1 });
      }
    }
    (p.draftPoints ?? []).forEach((pt, i) => {
      L.circleMarker([pt[0], pt[1]], { radius: 6, color: "#4AA8F0", weight: 2, fillColor: "#0C1528", fillOpacity: 1, interactive: false })
        .bindTooltip(String(i + 1), { permanent: true, direction: "center", className: "node-label" })
        .addTo(a);
    });
    syncRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    declutterRef.current();
  }, [groundSig(p.grounds), sig(p.highlightGates), sig(p.draftPoints), !!p.onHoldingClick, !!p.onTaxiwayClick, !!p.onGateClick, p.selectedHolding?.lat, p.selectedHolding?.lon]);

  // airspaces (VATSIM community data) + open SkyCommunity ATC positions
  useEffect(() => {
    const as = layers.current.airspace;
    const at = layers.current.atc;
    if (!as || !at) return;
    as.clearLayers();
    at.clearLayers();
    const atc = p.atc ?? [];
    const ctrOn = new Map(atc.filter((x) => x.fir_id).map((x) => [x.fir_id!, x]));
    const appOn = new Map(atc.filter((x) => x.tracon_id).map((x) => [x.tracon_id!, x]));
    const draw = (f: AirspaceFeature, on: AtcPosition | undefined, color: string, dash: string) => {
      L.geoJSON(f as never, {
        interactive: false,
        style: { color: on ? color : "#3B4A63", weight: on ? 2 : 1, dashArray: on ? undefined : dash, fillColor: color, fillOpacity: on ? 0.1 : 0, opacity: on ? 0.9 : 0.55 },
      }).addTo(as);
    };
    for (const f of p.firs ?? []) draw(f, ctrOn.get(f.properties.id), ATC_COLORS.CTR, "6 6");
    for (const f of p.tracons ?? []) draw(f, appOn.get(f.properties.id), ATC_COLORS.APP, "3 5");
    // Une seule pastille par aéroport (couleurs empilées APP/TWR/GND…)
    const byAirport = new Map<string, typeof atc>();
    for (const x of atc) {
      if (x.lat == null || x.lon == null) continue;
      const color = ATC_COLORS[x.type] ?? "#94A3B8";
      if (x.radius_nm > 0 && !(x.tracon_id && appOn.has(x.tracon_id))) {
        L.circle([x.lat, x.lon], { radius: x.radius_nm * 1852, color, weight: 1.5, fillColor: color, fillOpacity: 0.07, interactive: false }).addTo(at);
      }
      const key = (x.airport || x.callsign || `${x.lat},${x.lon}`).toUpperCase();
      if (!byAirport.has(key)) byAirport.set(key, []);
      byAirport.get(key)!.push(x);
    }
    for (const [, list] of byAirport) {
      const x0 = list[0];
      if (x0.lat == null || x0.lon == null) continue;
      const chips = list
        .map((x) => {
          const color = ATC_COLORS[x.type] ?? "#94A3B8";
          return `<span style="border-color:${color};color:${color};margin:0 1px" title="${esc(x.callsign)} ${esc(x.frequency)}">${esc(x.type || "?")}</span>`;
        })
        .join("");
      const tip = list.map((x) => `${x.callsign} ${x.frequency}`).join(" · ");
      L.marker([x0.lat, x0.lon], {
        icon: L.divIcon({
          className: "atc-pos",
          html: `<div style="display:flex;gap:2px;background:#0B1220cc;border-radius:6px;padding:2px 4px;border:1px solid #334" title="${esc(tip)}" data-testid="atc-position-${esc(x0.airport || x0.callsign)}">${chips}</div>`,
          iconSize: [0, 0],
        }),
        interactive: false,
      }).addTo(at);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig(p.firs?.map((f) => f.properties.id)), sig(p.tracons?.map((f) => f.properties.id)), sig(p.atc?.map((x) => [x.callsign, x.frequency, x.lat, x.lon, x.fir_id, x.tracon_id]))]);

  // points to pick (runway exits…): big orange circles with their name, the chosen one in green
  useEffect(() => {
    const r = layers.current.route;
    if (!r || !map.current) return;
    const g = L.layerGroup().addTo(map.current);
    for (const pt of p.pickPoints ?? []) {
      const on = !!pt.selected;
      L.circleMarker([pt.lat, pt.lon], {
        radius: on ? 10 : 9, color: on ? "#22C55E" : "#F97316", weight: 2, fillColor: on ? "#22C55E" : "#F97316",
        fillOpacity: on ? 0.55 : 0.25, bubblingMouseEvents: false,
      })
        .bindTooltip(esc(pt.label), { permanent: true, direction: "right", className: on ? "twy-label twy-hold twy-hold-on" : "twy-label twy-hold" })
        .on("click", () => cb.current.onPickPoint?.(pt.id))
        .addTo(g);
    }
    return () => { g.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig(p.pickPoints?.map((x) => [x.id, x.selected]))]);

  // selected route (planned dashed + flown solid) and waypoints
  useEffect(() => {
    const r = layers.current.route;
    if (!r) return;
    r.clearLayers();
    const route = p.route;
    if (!route || route.length < 2) return;
    const ll = route.map((w) => [w.lat, w.lon] as [number, number]);
    const ac = p.aircraftPos;
    if (p.flownIndex != null && ac) {
      // flown: departure -> last fix passed -> the aircraft ; still to fly: aircraft -> next fixes
      L.polyline([...ll.slice(p.flownIndex + 1).length ? [ac] : [], ...ll.slice(p.flownIndex + 1)], { color: "#38BDF8", weight: 2, opacity: 0.8, dashArray: "6 6" }).addTo(r);
      L.polyline([...ll.slice(0, p.flownIndex + 1), ac], { color: "#4AA8F0", weight: 3, opacity: 0.9 }).addTo(r);
    } else {
      L.polyline(ll, { color: "#38BDF8", weight: 2, opacity: 0.8, dashArray: "6 6" }).addTo(r);
      if (p.flownIndex != null && p.flownIndex > 0) {
        L.polyline(ll.slice(0, p.flownIndex + 1), { color: "#4AA8F0", weight: 3, opacity: 0.9 }).addTo(r);
      }
    }
    if (p.holdPath && p.holdPath.length > 2) {
      L.polyline(p.holdPath as [number, number][], { color: "#F59E0B", weight: 2.5, opacity: 0.95 }).addTo(r);
    }
    if (p.lineupPath && p.lineupPath.length > 1) {
      L.polyline(p.lineupPath as [number, number][], { color: "#FBBF24", weight: 3, opacity: 0.9, dashArray: "4 4" }).addTo(r);
    }
    route.forEach((w, i) => {
      if (i === 0 || i === route.length - 1) return;
      L.circleMarker([w.lat, w.lon], { radius: 3, color: "#7DD3FC", weight: 1, fillOpacity: 0.6 })
        .bindTooltip(esc(w.ident), { permanent: true, direction: "right", className: "wp-label" })
        .addTo(r);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig(p.route?.map((w) => [w.ident, w.lat, w.lon])), p.flownIndex, p.aircraftPos?.[0].toFixed(3), p.aircraftPos?.[1].toFixed(3),
      sig(p.holdPath?.[0]), p.holdPath?.length, sig(p.lineupPath)]);

  useEffect(() => {
    const tx = layers.current.taxi;
    if (!tx) return;
    tx.clearLayers();
    for (const t of p.taxis ?? []) {
      if (t.path.length < 2) continue;
      const color = t.status === "valide" ? "#10B981" : "#4AA8F0";
      L.polyline(t.path as [number, number][], { color, weight: 5, opacity: 0.85, dashArray: t.status === "valide" ? undefined : "8 6" }).addTo(tx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig(p.taxis)]);

  // Flèche temporaire : sens vers lequel le nez va pointer, À CÔTÉ de l'avion (visible à tous les zooms)
  useEffect(() => {
    const g = layers.current.flights;
    if (!g || !map.current) return;
    const h = p.pushHint;
    if (!h) return;
    const mk = L.marker([h.lat, h.lon], {
      interactive: false,
      icon: L.divIcon({
        className: "push-arrow",
        html: `<div style="transform:rotate(${h.hdg}deg);font-size:28px;line-height:1;filter:drop-shadow(0 0 3px #000)" title="${esc(h.label || "Repoussage")}">⬆</div>`,
        iconSize: [28, 28],
        iconAnchor: [-24, 14], // 24 px à droite du symbole de l'avion, quel que soit le zoom
      }),
    }).addTo(g);
    return () => {
      try { g.removeLayer(mk); } catch { /* */ }
    };
  }, [p.pushHint?.lat, p.pushHint?.lon, p.pushHint?.hdg, p.pushHint?.label]);


  // aircraft markers (kept by id so they glide instead of teleporting; never touches the base map)
  useEffect(() => {
    const fl = layers.current.flights;
    if (!fl) return;
    const seen = new Set<string>();
    for (const f of p.flights ?? []) {
      seen.add(f.id);
      const icon = acIcon(f, f.id === p.selectedId);
      const html = String(icon.options.html);
      let mk = markers.current.get(f.id);
      if (!mk) {
        mk = L.marker([f.position.lat, f.position.lon], { icon, zIndexOffset: 1000 }).addTo(fl);
        const id = f.id;
        mk.on("click", () => cb.current.onSelect?.(id));
        markers.current.set(f.id, mk);
      } else {
        const ll = mk.getLatLng();
        if (ll.lat !== f.position.lat || ll.lng !== f.position.lon) mk.setLatLng([f.position.lat, f.position.lon]);
        if (iconHtml.current.get(f.id) !== html) mk.setIcon(icon); // rebuilding the DOM only when something changed
      }
      mk.setZIndexOffset(f.id === p.selectedId ? 5000 : 1000); // the selected aircraft is drawn above the others
      iconHtml.current.set(f.id, html);
    }
    for (const [id, mk] of markers.current) {
      if (!seen.has(id)) {
        mk.remove();
        markers.current.delete(id);
        iconHtml.current.delete(id);
      }
    }
  }, [p.flights, p.selectedId]);

  return (
    <div className="relative h-full w-full">
      <div ref={el} className="h-full w-full" data-testid={p.testId ?? "radar-map"} />
      {baseError && (
        <div className="absolute bottom-14 left-1/2 z-[650] -translate-x-1/2 rounded border border-amber-500/50 bg-background/95 px-3 py-1.5 text-[11px] text-amber-200" data-testid="map-base-error">
          {baseError}
        </div>
      )}
    </div>
  );
}
