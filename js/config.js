// External data services, all in one place. Before a public launch with many players, consider
// your own (or paid) providers: the free community services below have fair-use limits.
// Every URL can be swapped here without touching the rest of the game.

// OpenStreetMap data (roads, buildings, landmarks). Tried in order; the first mirror is the main one.
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
// (overpass.private.coffee and overpass.kumi.systems were removed: they no longer allow browser requests — CORS)

// city search and reverse geocoding (usage policy: max 1 request/second, no autocomplete)
export const NOMINATIM = 'https://nominatim.openstreetmap.org';

// satellite imagery painted on the ground (256 px tiles, XYZ)
export const SATELLITE_URL = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
export const SATELLITE_TEMPLATE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const SATELLITE_ATTRIBUTION = 'Esri, Maxar, Earthstar Geographics';

// street map for the track picker and the in-race minimap (256 px tiles)
export const MAP_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const MAP_TILE = (z, x, y) => MAP_TEMPLATE.replace('{z}', z).replace('{x}', x).replace('{y}', y);
export const MAP_ATTRIBUTION = '© OpenStreetMap';

// elevation (Terrarium-encoded PNG tiles)
export const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
