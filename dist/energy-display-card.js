/*!
 * Energy Display Card for Home Assistant
 * HomeWizard Energy Display–style tiles: gauges, bars, values and hourly/daily charts
 * for electricity import/export, solar, gas, water and costs — with day/week/month navigation.
 *
 * Zero dependencies. Data comes from Home Assistant long-term statistics
 * (recorder/statistics_during_period), topped up with live sensor states for the running hour.
 * MIT License
 */
const VERSION = "1.1.0";
const TAG = "energy-display-card";

/* ------------------------------------------------------------------ *
 * i18n
 * ------------------------------------------------------------------ */
const STR = {
  en: {
    today: "Today", yesterday: "Yesterday", this_week: "This week", last_week: "Last week",
    this_month: "This month", last_month: "Last month", day: "Day", week: "Week", month: "Month",
    of: "of", live: "Live", no_stats: "No statistics", no_entity: "No entity configured",
    exporting: "Exporting", importing: "Importing", cost: "cost", revenue: "revenue",
    m: {
      import: "Import", export: "Export", net: "Net electricity", import_export: "Import & export",
      solar: "Solar production", self_consumption: "Solar self-use", usage_total: "Total electricity use",
      self_sufficiency: "Self-sufficiency", gas: "Gas", water: "Water",
      power: "Power now", solar_power: "Solar now", cost_total: "Total cost",
    },
  },
  nl: {
    today: "Vandaag", yesterday: "Gisteren", this_week: "Deze week", last_week: "Vorige week",
    this_month: "Deze maand", last_month: "Vorige maand", day: "Dag", week: "Week", month: "Maand",
    of: "van", live: "Live", no_stats: "Geen statistieken", no_entity: "Geen entiteit ingesteld",
    exporting: "Teruglevering", importing: "Afname", cost: "kosten", revenue: "opbrengst",
    m: {
      import: "Stroomafname", export: "Teruglevering", net: "Netto stroom", import_export: "Afname & teruglevering",
      solar: "Opwek zon", self_consumption: "Eigen gebruik zon", usage_total: "Totaal stroomverbruik",
      self_sufficiency: "Zelfvoorzienend", gas: "Gas", water: "Water",
      power: "Vermogen nu", solar_power: "Opwek nu", cost_total: "Totale kosten",
    },
  },
};
const lang = (hass) => (hass?.locale?.language || hass?.language || "en").slice(0, 2);
const t = (hass) => STR[lang(hass)] || STR.en;

/* ------------------------------------------------------------------ *
 * Metric definitions
 * ------------------------------------------------------------------ */
// base: unit after normalisation. kind: cumulative (statistics) | live (state) | derived
const METRICS = {
  import:           { kind: "cum", base: "kWh", color: "#8B6CFF", icon: "mdi:transmission-tower-import", goal: 10, cg: 4, price: "import" },
  export:           { kind: "cum", base: "kWh", color: "#22C58B", icon: "mdi:transmission-tower-export", goal: 10, cg: 2, price: "export" },
  net:              { kind: "cum", base: "kWh", color: "#8B6CFF", icon: "mdi:transmission-tower", goal: 10, cg: 4, signed: true },
  import_export:    { kind: "cum", base: "kWh", color: "#8B6CFF", color2: "#22C58B", icon: "mdi:swap-vertical", goal: 10, cg: 4, dual: true },
  solar:            { kind: "cum", base: "kWh", color: "#F5B231", icon: "mdi:solar-power-variant", goal: 15 },
  self_consumption: { kind: "cum", base: "kWh", color: "#F08C2E", icon: "mdi:home-lightning-bolt", goal: 10 },
  usage_total:      { kind: "cum", base: "kWh", color: "#6C8CFF", icon: "mdi:home-lightning-bolt-outline", goal: 15, cg: 5, price: "import" },
  self_sufficiency: { kind: "pct", base: "%", color: "#22C58B", icon: "mdi:leaf", goal: 100 },
  gas:              { kind: "cum", base: "m³", color: "#FF7A45", icon: "mdi:fire", goal: 5, cg: 4, price: "gas" },
  water:            { kind: "cum", base: "m³", color: "#2E9BFF", icon: "mdi:water", goal: 0.3, cg: 0.5, price: "water" },
  power:            { kind: "live", base: "W", color: "#8B6CFF", icon: "mdi:flash", goal: 5000 },
  solar_power:      { kind: "live", base: "W", color: "#F5B231", icon: "mdi:solar-power", goal: 5000 },
  cost_total:       { kind: "cost", base: "cur", color: "#14B8A6", icon: "mdi:cash-multiple", goal: 8 },
};
const DISPLAYS = ["gauge", "bar", "value", "chart"];

/* unit normalisation → base units (kWh, m³, W) */
const UNIT_FACTOR = {
  Wh: 0.001, kWh: 1, MWh: 1000, GWh: 1e6,
  "m³": 1, m3: 1, L: 0.001, l: 0.001, "ft³": 0.0283168, "CCF": 2.83168, gal: 0.00378541,
  W: 1, kW: 1000, MW: 1e6,
};
const unitFactor = (u) => (u in UNIT_FACTOR ? UNIT_FACTOR[u] : 1);

/* ------------------------------------------------------------------ *
 * Shared period state (cards with the same sync_group move together)
 * ------------------------------------------------------------------ */
const GROUPS = new Map();
function group(name) {
  let g = GROUPS.get(name);
  if (!g) { g = { period: null, offset: 0, subs: new Set() }; GROUPS.set(name, g); }
  return g;
}
function setGroup(name, patch) {
  const g = group(name);
  Object.assign(g, patch);
  g.subs.forEach((fn) => fn());
}

function computeRange(period, offset, now = new Date()) {
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  let start, end;
  if (period === "week") {
    const dow = (now.getDay() + 6) % 7; // Monday = 0
    start = new Date(y, m, d - dow + 7 * offset);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  } else if (period === "month") {
    start = new Date(y, m + offset, 1);
    end = new Date(y, m + offset + 1, 1);
  } else {
    start = new Date(y, m, d + offset);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  }
  const statPeriod = period === "day" ? "hour" : "day";
  const buckets = [];
  if (statPeriod === "hour") {
    for (let s = start.getTime(); s < end.getTime(); s += 3600e3) buckets.push([s, s + 3600e3]);
  } else {
    for (let s = new Date(start); s < end; ) {
      const n = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
      buckets.push([s.getTime(), n.getTime()]);
      s = n;
    }
  }
  const nowMs = now.getTime();
  const current = nowMs >= start.getTime() && nowMs < end.getTime();
  const days = Math.round((end - start) / 864e5);
  return { period, offset, start, end, statPeriod, buckets, current, nowMs, days };
}

/* ------------------------------------------------------------------ *
 * Statistics fetch with shared cache + in-flight de-duplication
 * ------------------------------------------------------------------ */
const CACHE = new Map(); // key -> { ts, promise }
const CACHE_MAX = 60;
const LIVE_TTL = 4 * 60e3; // current period: refetch at most every 4 min

function fetchStats(hass, ids, range) {
  if (!ids.length) return Promise.resolve({});
  const pad = range.statPeriod === "hour" ? 3 * 3600e3 : 864e5; // include a baseline bucket before start
  const key = `${range.statPeriod}|${range.start.getTime()}|${ids.slice().sort().join(",")}`;
  const hit = CACHE.get(key);
  const ttl = range.current ? LIVE_TTL : Infinity;
  if (hit && Date.now() - hit.ts < ttl) return hit.promise;
  const promise = hass
    .callWS({
      type: "recorder/statistics_during_period",
      start_time: new Date(range.start.getTime() - pad).toISOString(),
      end_time: range.end.toISOString(),
      statistic_ids: ids,
      period: range.statPeriod,
      types: ["change", "state", "mean"],
    })
    .catch((e) => { CACHE.delete(key); throw e; });
  CACHE.set(key, { ts: Date.now(), promise });
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return promise;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
const arr = (v) => (v == null || v === "" ? [] : Array.isArray(v) ? v.filter(Boolean) : [v]);
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
const zeros = (n) => new Array(n).fill(0);
const addArr = (a, b, sign = 1) => a.map((v, i) => v + sign * (b[i] || 0));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ *
 * The card
 * ------------------------------------------------------------------ */
class EnergyDisplayCard extends HTMLElement {
  static getConfigElement() { return document.createElement(`${TAG}-editor`); }
  static getStubConfig(hass) { return autoDetectConfig(hass); }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._data = null;       // processed statistics
    this._series = [];       // per tile, for chart interaction
    this._tileHtml = [];     // last rendered html per tile (diffing)
    this._raf = 0;
    this._onGroup = () => { this._data = null; this._load(); this._schedule(); };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const tiles = arr(config.tiles);
    tiles.forEach((tl, i) => {
      if (!METRICS[tl.metric]) throw new Error(`Tile ${i + 1}: unknown metric "${tl.metric}". Use one of: ${Object.keys(METRICS).join(", ")}`);
      if (tl.display && !DISPLAYS.includes(tl.display)) throw new Error(`Tile ${i + 1}: unknown display "${tl.display}"`);
    });
    const periods = arr(config.periods).filter((p) => ["day", "week", "month"].includes(p));
    this._config = {
      show_navigation: true, sync_group: "default", columns: 0, ...config,
      periods: periods.length ? periods : ["day"],
      sources: config.sources || {}, prices: config.prices || {}, tiles,
    };
    const g = group(this._config.sync_group);
    if (!g.period || !this._config.periods.includes(g.period)) g.period = this._config.periods[0];
    this._statIds = null;
    this._watch = null;
    this._data = null;
    this._tileHtml = [];
    this._built = false;
    if (this.isConnected) { this._load(); this._schedule(); }
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (!old) { this._load(); this._schedule(); return; }
    if (old.locale !== hass.locale || old.themes !== hass.themes) { this._tileHtml = []; this._built = false; this._schedule(); return; }
    for (const id of this._watchIds()) {
      if (old.states[id] !== hass.states[id]) { this._schedule(); return; }
    }
  }

  connectedCallback() {
    if (!this._config) return;
    group(this._config.sync_group).subs.add(this._onGroup);
    this._timer = setInterval(() => {
      const r = this._range();
      // roll over to the new day/week/month at midnight, refresh live data periodically
      if (r.current || r.start.getTime() !== this._data?.rangeStart) { this._load(); }
    }, 60e3);
    this._load();
    this._schedule();
  }

  disconnectedCallback() {
    if (this._config) group(this._config.sync_group).subs.delete(this._onGroup);
    clearInterval(this._timer);
    cancelAnimationFrame(this._raf);
  }

  getCardSize() { return 1 + Math.ceil((this._config?.tiles.length || 1) / 2) * 3; }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }

  /* ---------- config helpers ---------- */
  _src(key, tile) {
    if (tile?.entity && METRICS[tile.metric].kind !== "cost") {
      if (tile.metric === "import_export") return key === "export" ? arr(tile.entity_export || this._config.sources.export) : arr(tile.entity);
      return arr(tile.entity);
    }
    return arr(this._config.sources[key]);
  }
  _priceCfg(key) { return this._config.prices[key]; }

  _watchIds() {
    if (this._watch) return this._watch;
    const s = new Set();
    Object.values(this._config.sources).forEach((v) => arr(v).forEach((id) => s.add(id)));
    Object.values(this._config.prices).forEach((v) => typeof v === "string" && s.add(v));
    this._config.tiles.forEach((tl) => { arr(tl.entity).forEach((id) => s.add(id)); arr(tl.entity_export).forEach((id) => s.add(id)); });
    return (this._watch = [...s]);
  }

  /** statistic ids needed for the configured tiles */
  _neededStats() {
    if (this._statIds) return this._statIds;
    const s = new Set();
    const need = (keys, tile) => keys.forEach((k) => this._src(k, tile).forEach((id) => s.add(id)));
    const needPrice = (k) => { const p = this._priceCfg(k); if (typeof p === "string" && p.startsWith("sensor.")) s.add(p); };
    for (const tl of this._config.tiles) {
      switch (tl.metric) {
        case "import": case "export": case "solar": case "gas": case "water": need([tl.metric], tl); break;
        case "net": case "import_export": need(["import", "export"], tl); break;
        case "self_consumption": need(["solar", "export"], tl); break;
        case "usage_total": case "self_sufficiency": need(["import", "export", "solar"], tl); break;
        case "cost_total": need(["import", "export", "gas", "water"]); ["import", "export", "gas", "water"].forEach(needPrice); break;
      }
      const p = METRICS[tl.metric].price;
      if (p) needPrice(p);
      if (tl.metric === "net" || tl.metric === "import_export") { needPrice("import"); needPrice("export"); }
    }
    return (this._statIds = [...s]);
  }

  _range() {
    const g = group(this._config.sync_group);
    return computeRange(g.period, g.offset);
  }

  /* ---------- data ---------- */
  async _load() {
    if (!this._hass || !this._config) return;
    const range = this._range();
    const ids = this._neededStats();
    const token = (this._loadToken = {});
    try {
      const res = await fetchStats(this._hass, ids, range);
      if (token !== this._loadToken) return;
      this._data = { rangeStart: range.start.getTime(), period: range.period, offset: range.offset, raw: res, error: null };
    } catch (e) {
      if (token !== this._loadToken) return;
      this._data = { rangeStart: range.start.getTime(), period: range.period, offset: range.offset, raw: {}, error: e?.message || String(e) };
    }
    this._schedule();
  }

  /** usage per bucket (base units) for one statistic id, incl. live top-up for the running bucket */
  _bucketsFor(id, range) {
    const n = range.buckets.length;
    const out = zeros(n);
    const rows = this._data?.raw?.[id];
    const st = this._hass.states[id];
    const f = unitFactor(st?.attributes?.unit_of_measurement);
    if (!rows) return { values: out, missing: true };
    let lastState = null;
    let bi = 0;
    const startMs = range.start.getTime();
    for (const r of rows) {
      const s = typeof r.start === "number" ? r.start : Date.parse(r.start);
      if (r.state != null) lastState = r.state;
      if (s < startMs) continue;
      while (bi < n - 1 && s >= range.buckets[bi][1]) bi++;
      if (s >= range.buckets[bi][0] && s < range.buckets[bi][1] && r.change != null) out[bi] += r.change * f;
    }
    // live top-up: usage since the last compiled statistic
    if (range.current && st && lastState != null) {
      const cur = num(st.state);
      if (cur != null) {
        const delta = (cur - lastState) * f;
        if (delta > 0 && delta < 1e5) {
          const i = range.buckets.findIndex(([a, b]) => range.nowMs >= a && range.nowMs < b);
          if (i >= 0) out[i] += delta;
        }
      }
    }
    return { values: out, missing: false };
  }

  _usage(keys, tile, range) {
    let values = zeros(range.buckets.length);
    const missing = [];
    for (const id of keys.flatMap ? keys : [keys]) {
      const r = this._bucketsFor(id, range);
      if (r.missing) missing.push(id);
      values = addArr(values, r.values);
    }
    return { values, missing };
  }

  _sourceSeries(key, tile, range) { return this._usage(this._src(key, tile), tile, range); }

  /** price per bucket for price key (entity state, number, or dynamic price sensor with statistics) */
  _prices(key, range) {
    const cfg = this._priceCfg(key);
    const n = range.buckets.length;
    if (cfg == null || cfg === "") return null;
    if (typeof cfg === "number") return new Array(n).fill(cfg);
    const st = this._hass.states[cfg];
    const current = num(st?.state);
    const out = new Array(n).fill(current ?? 0);
    const rows = this._data?.raw?.[cfg];
    if (rows) {
      const startMs = range.start.getTime();
      let bi = 0;
      for (const r of rows) {
        const s = typeof r.start === "number" ? r.start : Date.parse(r.start);
        if (s < startMs || r.mean == null) continue;
        while (bi < n - 1 && s >= range.buckets[bi][1]) bi++;
        out[bi] = r.mean;
      }
    }
    return current == null && !rows ? null : out;
  }

  _fixedDaily() {
    const v = this._priceCfg("fixed_daily");
    if (v == null || v === "") return 0;
    return typeof v === "number" ? v : num(this._hass.states[v]?.state) || 0;
  }

  /** returns a series object for a tile: { values[], total, unit, values2?, total2?, cost?, missing[] } */
  _series_(tile, range) {
    const m = METRICS[tile.metric];
    const S = (k) => this._sourceSeries(k, tile, range);
    const missing = [];
    const take = (r) => { missing.push(...r.missing); return r.values; };
    const costOf = (values, priceKey) => {
      const p = this._prices(priceKey, range);
      return p ? values.map((v, i) => v * p[i]) : null;
    };
    let values, values2, cost;
    switch (tile.metric) {
      case "import": case "export": case "solar": case "gas": case "water":
        values = take(S(tile.metric));
        if (m.price) cost = costOf(values, m.price);
        break;
      case "net": {
        const imp = take(S("import")), exp = take(S("export"));
        values = addArr(imp, exp, -1);
        const ci = costOf(imp, "import"), ce = costOf(exp, "export");
        if (ci) cost = ce ? addArr(ci, ce, -1) : ci;
        break;
      }
      case "import_export": {
        values = take(S("import")); values2 = take(S("export"));
        const ci = costOf(values, "import"), ce = costOf(values2, "export");
        if (ci) cost = ce ? addArr(ci, ce, -1) : ci;
        break;
      }
      case "self_consumption": {
        const sol = take(S("solar")), exp = take(S("export"));
        values = sol.map((v, i) => Math.max(0, v - exp[i]));
        break;
      }
      case "usage_total": case "self_sufficiency": {
        const imp = take(S("import")), exp = take(S("export")), sol = take(S("solar"));
        const self = sol.map((v, i) => Math.max(0, v - exp[i]));
        const use = imp.map((v, i) => v + self[i]);
        if (tile.metric === "usage_total") { values = use; cost = costOf(imp, "import"); }
        else {
          values = use.map((u, i) => (u > 0 ? (self[i] / u) * 100 : 0));
          const tu = sum(use);
          return { values, total: tu > 0 ? (sum(self) / tu) * 100 : 0, unit: "%", missing, pct: true };
        }
        break;
      }
      case "cost_total": {
        values = zeros(range.buckets.length);
        for (const k of ["import", "gas", "water"]) {
          if (!this._src(k).length) continue;
          const c = costOf(take(S(k)), k);
          if (c) values = addArr(values, c);
        }
        if (this._src("export").length) {
          const c = costOf(take(S("export")), "export");
          if (c) values = addArr(values, c, -1);
        }
        const fixed = this._fixedDaily();
        if (fixed) {
          const perBucket = range.statPeriod === "hour" ? fixed / range.buckets.length : fixed;
          values = values.map((v, i) => (range.current && range.buckets[i][0] > range.nowMs ? v : v + perBucket));
        }
        return { values, total: sum(values), unit: "cur", missing, currency: true };
      }
    }
    return {
      values, total: sum(values),
      values2, total2: values2 ? sum(values2) : undefined,
      cost, costTotal: cost ? sum(cost) : null,
      unit: m.base, missing,
    };
  }

  /* ---------- formatting ---------- */
  _fmtNum(v, digits) {
    const l = this._hass?.locale?.language || "en";
    const key = l + digits;
    this._nf ||= {};
    this._nf[key] ||= new Intl.NumberFormat(l, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return this._nf[key].format(v);
  }
  _fmtCur(v) {
    const l = this._hass?.locale?.language || "en";
    const c = this._config.currency || this._hass?.config?.currency || "EUR";
    this._cf ||= {};
    this._cf[l + c] ||= new Intl.NumberFormat(l, { style: "currency", currency: c, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return this._cf[l + c].format(v);
  }
  /** returns [numberText, unitText] in display units */
  _fmt(v, unit, tile) {
    if (v == null || !Number.isFinite(v)) return ["—", ""];
    if (unit === "cur") return [this._fmtCur(v), ""];
    const d = tile?.decimals;
    if (unit === "%") return [this._fmtNum(v, d ?? 0), "%"];
    if (unit === "W") {
      const a = Math.abs(v);
      if (tile?.unit === "kW" || (a >= 10000 && !tile?.unit)) return [this._fmtNum(v / 1000, d ?? 1), "kW"];
      return [this._fmtNum(v, d ?? 0), "W"];
    }
    if (unit === "m³") {
      const water = tile?.metric === "water";
      const du = tile?.unit || (water ? "L" : "m³");
      if (du === "L") return [this._fmtNum(v * 1000, d ?? 0), "L"];
      return [this._fmtNum(v, d ?? (Math.abs(v) < 10 ? 2 : 1)), "m³"];
    }
    if (unit === "kWh") {
      if (tile?.unit === "Wh") return [this._fmtNum(v * 1000, d ?? 0), "Wh"];
      return [this._fmtNum(v, d ?? (Math.abs(v) < 10 ? 2 : 1)), "kWh"];
    }
    return [this._fmtNum(v, d ?? 1), unit];
  }

  /** factor from base unit to the unit shown on screen (goals are entered in display units) */
  _displayFactor(tile) {
    const m = METRICS[tile.metric];
    if (m.base === "m³" && (tile.unit || (tile.metric === "water" ? "L" : "m³")) === "L") return 1000;
    if (m.base === "kWh" && tile.unit === "Wh") return 1000;
    if (m.base === "W" && tile.unit === "kW") return 0.001;
    return 1;
  }

  _rangeLabel(r) {
    const s = t(this._hass);
    const l = this._hass?.locale?.language || "en";
    if (r.period === "day") {
      if (r.offset === 0) return s.today;
      if (r.offset === -1) return s.yesterday;
      return new Intl.DateTimeFormat(l, { weekday: "short", day: "numeric", month: "short" }).format(r.start);
    }
    if (r.period === "week") {
      if (r.offset === 0) return s.this_week;
      if (r.offset === -1) return s.last_week;
      const f = new Intl.DateTimeFormat(l, { day: "numeric", month: "short" });
      return `${f.format(r.start)} – ${f.format(new Date(r.end - 864e5))}`;
    }
    if (r.offset === 0) return s.this_month;
    return new Intl.DateTimeFormat(l, { month: "long", year: "numeric" }).format(r.start);
  }

  _bucketLabel(r, i) {
    const l = this._hass?.locale?.language || "en";
    const [a, b] = r.buckets[i];
    if (r.statPeriod === "hour") {
      const f = new Intl.DateTimeFormat(l, { hour: "2-digit", minute: "2-digit" });
      return `${f.format(a)}–${f.format(b)}`;
    }
    return new Intl.DateTimeFormat(l, { weekday: "short", day: "numeric", month: "short" }).format(a);
  }

  /* ---------- rendering ---------- */
  _schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); });
  }

  _build() {
    const c = this._config;
    const cols = c.columns ? `repeat(${c.columns}, minmax(0,1fr))` : "repeat(auto-fill, minmax(150px, 1fr))";
    this.shadowRoot.innerHTML = `
      <style>${CSS}</style>
      <ha-card class="${c.compact ? "compact" : ""}">
        ${c.title || c.show_navigation ? `<div class="head">
          ${c.title ? `<div class="title">${esc(c.title)}</div>` : ""}
          ${c.show_navigation ? `<div class="nav">
            ${c.periods.length > 1 ? `<div class="seg" role="tablist">${c.periods.map((p) => `<button data-period="${p}" role="tab">${esc(t(this._hass)[p])}</button>`).join("")}</div>` : ""}
            <div class="stepper">
              <button class="ib" data-step="-1" aria-label="previous"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
              <button class="range" data-step="0"></button>
              <button class="ib" data-step="1" aria-label="next"><ha-icon icon="mdi:chevron-right"></ha-icon></button>
            </div>
          </div>` : `<div class="range-static"></div>`}
        </div>` : ""}
        <div class="grid" style="grid-template-columns:${cols}">
          ${c.tiles.map((tl, i) => `<div class="tile d-${tl.display || "gauge"}" data-i="${i}" style="${tl.span ? `grid-column:span ${tl.span};` : ""}"></div>`).join("")}
        </div>
      </ha-card>`;
    const root = this.shadowRoot;
    root.addEventListener("click", (ev) => this._onClick(ev));
    root.addEventListener("pointermove", (ev) => this._onHover(ev));
    root.addEventListener("pointerleave", (ev) => { if (ev.target.matches?.(".chart svg")) this._clearHover(); }, true);
    this._tiles = [...root.querySelectorAll(".tile")];
    this._tileHtml = [];
    this._built = true;
  }

  _onClick(ev) {
    const g = group(this._config.sync_group);
    const step = ev.target.closest("[data-step]");
    if (step) {
      const s = +step.dataset.step;
      setGroup(this._config.sync_group, { offset: s === 0 ? 0 : Math.min(0, g.offset + s) });
      return;
    }
    const per = ev.target.closest("[data-period]");
    if (per) { setGroup(this._config.sync_group, { period: per.dataset.period, offset: 0 }); return; }
    const tileEl = ev.target.closest(".tile");
    if (tileEl && !ev.target.closest(".chart")) {
      const tile = this._config.tiles[+tileEl.dataset.i];
      if (tile.tap_action === "none") return;
      const m = tile.metric;
      const id = arr(tile.entity)[0] || arr(this._config.sources[m === "power" ? "power" : m === "solar_power" ? "solar_power" : m === "net" || m === "import_export" || m === "usage_total" ? "import" : m === "self_consumption" || m === "self_sufficiency" ? "solar" : m])[0];
      if (id) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: id }, bubbles: true, composed: true }));
    }
  }

  _onHover(ev) {
    const svg = ev.target.closest?.(".chart svg");
    if (!svg) return;
    const tileEl = svg.closest(".tile");
    const i = +tileEl.dataset.i;
    const ser = this._series[i];
    if (!ser) return;
    const rect = svg.getBoundingClientRect();
    const idx = clamp(Math.floor(((ev.clientX - rect.left) / rect.width) * ser.values.length), 0, ser.values.length - 1);
    const tile = this._config.tiles[i];
    const r = this._lastRange;
    const showCost = tile.show === "cost" && ser.cost;
    const v = showCost ? ser.cost[idx] : ser.values[idx];
    const [n, u] = this._fmt(v, showCost ? "cur" : ser.unit, tile);
    let txt = `${this._bucketLabel(r, idx)} · ${n}${u ? " " + u : ""}`;
    if (ser.values2 && !showCost) { const [n2, u2] = this._fmt(ser.values2[idx], ser.unit, tile); txt += ` / ↑ ${n2} ${u2}`; }
    const ro = tileEl.querySelector(".readout");
    if (ro) { ro.textContent = txt; ro.classList.add("on"); }
    tileEl.querySelectorAll(".chart rect.b").forEach((b) => b.classList.toggle("hl", +b.dataset.k === idx));
  }
  _clearHover() {
    this.shadowRoot.querySelectorAll(".readout.on").forEach((e) => e.classList.remove("on"));
    this.shadowRoot.querySelectorAll(".chart rect.hl").forEach((e) => e.classList.remove("hl"));
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const range = this._range();
    this._lastRange = range;
    const g = group(this._config.sync_group);
    const s = t(this._hass);

    // header
    const rl = this.shadowRoot.querySelector(".range, .range-static");
    if (rl) rl.textContent = this._rangeLabel(range);
    const next = this.shadowRoot.querySelector('[data-step="1"]');
    if (next) next.disabled = g.offset >= 0;
    this.shadowRoot.querySelectorAll("[data-period]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.period === g.period)));

    const loading = !this._data || this._data.rangeStart !== range.start.getTime() || this._data.period !== range.period;
    this._config.tiles.forEach((tile, i) => {
      let html;
      const m = METRICS[tile.metric];
      if (m.kind === "live") html = this._liveTile(tile, s);
      else if (loading && !this._series[i]) html = this._skeleton(tile, s);
      else if (loading) return; // keep previous content while the new range loads
      else {
        const ser = this._series_(tile, range);
        this._series[i] = ser;
        html = this._tile(tile, ser, range, s);
      }
      if (this._tileHtml[i] !== html) {
        const first = this._tileHtml[i] === undefined || this._tileHtml[i].startsWith("<!--sk-->");
        this._tiles[i].innerHTML = html;
        this._tiles[i].classList.toggle("anim", first);
        this._tileHtml[i] = html;
      }
    });
    if (this._data?.error) console.warn(`[${TAG}]`, this._data.error);
  }

  _skeleton(tile, s) {
    const m = METRICS[tile.metric];
    return `<!--sk-->${this._header(tile, m, s)}<div class="sk"></div>`;
  }

  _header(tile, m, s, extra = "") {
    const name = tile.name || s.m[tile.metric] + (tile.show === "cost" && m.price ? ` · ${s.cost}` : "");
    const icon = tile.icon || m.icon;
    const color = tile.color || m.color;
    return `<div class="th" style="--c:${color}">
      ${tile.hide_icon ? "" : `<ha-icon icon="${esc(icon)}"></ha-icon>`}
      <span class="tn">${esc(name)}</span>${extra}
    </div>`;
  }

  _goal(tile, m, range, ser) {
    if (tile.max != null && m.kind === "live") return +tile.max;
    const asCost = tile.show === "cost" && ser?.cost;
    let g = tile.goal ?? tile.max;
    if (g == null) g = asCost ? m.cg ?? m.goal : m.goal;
    else if (!asCost && !ser?.currency) g = +g / this._displayFactor(tile);
    g = +g;
    if (m.kind !== "pct" && range && range.period !== "day" && tile.goal_per_day !== false) g *= range.days;
    return g;
  }

  _liveTile(tile, s) {
    const m = METRICS[tile.metric];
    const id = arr(tile.entity)[0] || arr(this._config.sources[tile.metric])[0];
    if (!id) return `${this._header(tile, m, s)}<div class="msg">${s.no_entity}</div>`;
    const st = this._hass.states[id];
    let v = num(st?.state);
    if (v != null) v *= unitFactor(st.attributes.unit_of_measurement);
    const neg = v != null && v < 0;
    const color = neg ? tile.color_export || METRICS.export.color : tile.color || m.color;
    const max = this._goal(tile, m);
    const [n, u] = this._fmt(v == null ? null : Math.abs(v), "W", tile);
    const sub = tile.metric === "power" && v != null ? (neg ? s.exporting : s.importing) : "";
    const badge = `<span class="live"><i></i>${s.live}</span>`;
    return this._shape(tile, m, s, { value: Math.abs(v ?? 0), max, color, n, u, sub, badge, ratio: v == null ? 0 : Math.abs(v) / max });
  }

  _tile(tile, ser, range, s) {
    const m = METRICS[tile.metric];
    const need = this._missingTotal(tile);
    if (!need) return `${this._header(tile, m, s)}<div class="msg">${s.no_entity}</div>`;
    if (ser.missing.length && ser.missing.length === need) {
      return `${this._header(tile, m, s)}<div class="msg" title="${esc(ser.missing.join(", "))}">${s.no_stats}<small>${esc(ser.missing[0])}</small></div>`;
    }
    const showCost = tile.show === "cost" && ser.cost;
    const total = showCost ? ser.costTotal : ser.total;
    const unit = showCost ? "cur" : ser.unit;
    const [n, u] = this._fmt(total, unit, tile);
    const max = this._goal(tile, m, range, ser);
    const color = (m.signed && total < 0) ? (tile.color_export || METRICS.export.color) : (tile.color || m.color);

    // secondary line
    let sub = "";
    const sec = tile.secondary ?? "auto";
    if (sec !== "none") {
      if (showCost) { const [a, b] = this._fmt(ser.total, ser.unit, tile); sub = `${a} ${b}`; }
      else if (ser.cost && (sec === "auto" || sec === "cost")) {
        const c = ser.costTotal;
        sub = (tile.metric === "export" ? `${s.revenue} ` : "") + this._fmtCur(c);
      } else if (sec === "goal" || (sec === "auto" && tile.display === "gauge" && !ser.pct)) {
        const [gn, gu] = this._fmt(max, unit, tile);
        sub = `${s.of} ${gn}${gu ? " " + gu : ""}`;
      }
    }

    if (m.dual && !showCost) {
      const [n2, u2] = this._fmt(ser.total2, ser.unit, tile);
      return this._shape(tile, m, s, {
        dual: true, n, u, n2, u2, sub,
        ratio: ser.total / max, ratio2: ser.total2 / max,
        color: tile.color || m.color, color2: tile.color_export || m.color2,
        values: ser.values, values2: ser.values2, range,
      });
    }
    return this._shape(tile, m, s, {
      n, u, sub, color, ratio: Math.abs(total) / max,
      values: showCost ? ser.cost : ser.values, range, signed: m.signed || ser.currency,
    });
  }

  _missingTotal(tile) {
    // number of source ids the tile depends on (to decide whether *all* are missing)
    const keys = {
      import: ["import"], export: ["export"], solar: ["solar"], gas: ["gas"], water: ["water"],
      net: ["import", "export"], import_export: ["import", "export"], self_consumption: ["solar", "export"],
      usage_total: ["import", "export", "solar"], self_sufficiency: ["import", "export", "solar"],
      cost_total: ["import", "export", "gas", "water"],
    }[tile.metric] || [];
    return keys.reduce((a, k) => a + this._src(k, tile.metric === "cost_total" ? undefined : tile).length, 0);
  }

  /** renders the visual shape for any tile */
  _shape(tile, m, s, o) {
    const display = tile.display || "gauge";
    const unitHtml = (u) => (u ? `<span class="u">${esc(u)}</span>` : "");
    const head = this._header(tile, m, s, o.badge || "");
    const style = `--c:${o.color};--c2:${o.color2 || o.color}`;

    if (display === "value") {
      return `${head}<div class="val" style="${style}">
          <div class="big">${esc(o.n)}${unitHtml(o.u)}</div>
          ${o.dual ? `<div class="big b2"><ha-icon icon="mdi:arrow-up"></ha-icon>${esc(o.n2)}${unitHtml(o.u2)}</div>` : ""}
          ${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ""}
        </div>`;
    }

    if (display === "bar") {
      const bar = (r, cls = "") => `<div class="track ${cls}"><div class="fill" style="width:${clamp(r, 0, 1) * 100}%"></div>${r > 1 ? `<div class="gl" style="left:${(100 / r).toFixed(1)}%"></div>` : ""}</div>`;
      return `${head}<div class="barwrap" style="${style}">
          <div class="row"><div class="big">${esc(o.n)}${unitHtml(o.u)}</div>${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ""}</div>
          ${bar(o.ratio)}
          ${o.dual ? `<div class="row r2"><div class="mid"><ha-icon icon="mdi:arrow-up"></ha-icon>${esc(o.n2)}${unitHtml(o.u2)}</div></div>${bar(o.ratio2, "t2")}` : ""}
        </div>`;
    }

    if (display === "chart" && o.values) {
      return `${head}<div class="chartwrap" style="${style}">
          <div class="row"><div class="big">${esc(o.n)}${unitHtml(o.u)}</div>${o.dual ? `<div class="mid c2"><ha-icon icon="mdi:arrow-up"></ha-icon>${esc(o.n2)}${unitHtml(o.u2)}</div>` : ""}</div>
          <div class="readout"></div>
          ${this._chart(o)}
          ${o.sub ? `<div class="sub">${esc(o.sub)}</div>` : ""}
        </div>`;
    }

    // gauge (default)
    const P1 = "M 24.64 95.36 A 50 50 0 1 1 95.36 95.36";
    const P2 = "M 34.54 85.46 A 36 36 0 1 1 85.46 85.46";
    const arc = (p, r, cls, rad) => {
      const v = clamp(r, 0, 1) * 100;
      let mark = "";
      if (r > 1) { // over goal: full arc + a notch where the goal was reached
        const a = ((135 + 270 * (1 / r)) * Math.PI) / 180;
        mark = `<circle class="gm" cx="${(60 + rad * Math.cos(a)).toFixed(2)}" cy="${(60 + rad * Math.sin(a)).toFixed(2)}" r="2.2"/>`;
      }
      return `<path class="tr ${cls}" d="${p}" pathLength="100"/>
        <path class="ar ${cls}" d="${p}" pathLength="100" style="stroke-dasharray:${v} 200;${v < 0.5 ? "opacity:0" : ""}"/>${mark}`;
    };
    return `${head}<div class="gauge" style="${style}">
        <svg viewBox="0 0 120 112" aria-hidden="true">
          ${arc(P1, o.ratio || 0, "a1", 50)}
          ${o.dual ? arc(P2, o.ratio2 || 0, "a2", 36) : ""}
        </svg>
        <div class="gc ${o.dual ? "dual" : ""}">
          <div class="big">${esc(o.n)}${unitHtml(o.u)}</div>
          ${o.dual ? `<div class="mid c2"><ha-icon icon="mdi:arrow-up"></ha-icon>${esc(o.n2)}${unitHtml(o.u2)}</div>` : ""}
          ${o.sub && !o.dual ? `<div class="sub">${esc(o.sub)}</div>` : ""}
        </div>
        ${o.sub && o.dual ? `<div class="sub below">${esc(o.sub)}</div>` : ""}
      </div>`;
  }

  _chart(o) {
    const v = o.values, v2 = o.values2;
    const r = o.range;
    const n = v.length;
    const W = n * 10, H = 60;
    const anyNeg = o.signed && v.some((x) => x < 0);
    const hasDown = !!v2 || anyNeg;
    const maxUp = Math.max(1e-9, ...v.map((x) => Math.max(0, x)));
    const maxDn = hasDown ? Math.max(1e-9, ...(v2 || v.map((x) => -x)).map((x) => Math.max(0, x))) : 0;
    const total = maxUp + maxDn;
    const base = hasDown ? (H * maxUp) / total : H;
    const scaleUp = base / maxUp, scaleDn = hasDown ? (H - base) / maxDn : 0;
    const nowIdx = r.current ? r.buckets.findIndex(([a, b]) => r.nowMs >= a && r.nowMs < b) : -1;
    let bars = "";
    for (let i = 0; i < n; i++) {
      const fut = r.current && i > nowIdx;
      if (fut) { bars += `<rect class="fut" x="${i * 10 + 1.5}" y="${base - 1}" width="7" height="2" rx="1"/>`; continue; }
      const up = Math.max(0, v[i]);
      const dn = v2 ? Math.max(0, v2[i]) : Math.max(0, -v[i]);
      const cur = i === nowIdx ? " cur" : "";
      if (up > 0) { const h = Math.max(1, up * scaleUp); bars += `<rect class="b up${cur}" data-k="${i}" x="${i * 10 + 1.5}" y="${base - h}" width="7" height="${h}" rx="1.5"/>`; }
      if (dn > 0) { const h = Math.max(1, dn * scaleDn); bars += `<rect class="b dn${cur}" data-k="${i}" x="${i * 10 + 1.5}" y="${base}" width="7" height="${h}" rx="1.5"/>`; }
      if (up <= 0 && dn <= 0) bars += `<rect class="b zero" data-k="${i}" x="${i * 10 + 1.5}" y="${base - 1}" width="7" height="2" rx="1"/>`;
    }
    // axis labels
    const l = this._hass?.locale?.language || "en";
    let ticks = [];
    if (r.statPeriod === "hour") ticks = [0, 6, 12, 18].map((h) => [h, String(h).padStart(2, "0")]).concat([[n, "24"]]);
    else if (r.period === "week") { const f = new Intl.DateTimeFormat(l, { weekday: "narrow" }); ticks = r.buckets.map(([a], i) => [i + 0.5, f.format(a)]); }
    else ticks = [0, 7, 14, 21, 28].filter((d) => d < n).map((d) => [d + 0.5, String(d + 1)]);
    return `<div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${hasDown ? `<line x1="0" x2="${W}" y1="${base}" y2="${base}" class="base"/>` : ""}${bars}<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/></svg>
        <div class="ax">${ticks.map(([x, txt]) => `<span style="left:${(x / n) * 100}%">${esc(txt)}</span>`).join("")}</div>
      </div>`;
  }
}

/* ------------------------------------------------------------------ *
 * Styles
 * ------------------------------------------------------------------ */
const CSS = `
:host { display:block; }
ha-card { padding:14px; overflow:hidden; container-type:inline-size; }
@container (max-width: 480px) {
  .nav { width:100%; }
  .seg { flex:1; } .seg button { flex:1; text-align:center; }
  .stepper { flex:1; justify-content:space-between; }
}
.head { display:flex; align-items:center; justify-content:space-between; gap:8px 12px; flex-wrap:wrap; margin:0 2px 12px; }
.title { font-size:1.15rem; font-weight:600; color:var(--primary-text-color); letter-spacing:-.01em; }
.nav { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-left:auto; }
.seg { display:flex; background:var(--edc-chip, rgba(127,127,127,.12)); border-radius:999px; padding:3px; }
.seg button { all:unset; box-sizing:border-box; cursor:pointer; padding:5px 12px; border-radius:999px; font-size:.82rem; font-weight:500; color:var(--secondary-text-color); transition:background .15s,color .15s; }
.seg button[aria-selected="true"] { background:var(--card-background-color, var(--ha-card-background, #fff)); color:var(--primary-text-color); box-shadow:0 1px 3px rgba(0,0,0,.15); }
.stepper { display:flex; align-items:center; background:var(--edc-chip, rgba(127,127,127,.12)); border-radius:999px; padding:2px; }
.stepper button { all:unset; cursor:pointer; display:flex; align-items:center; justify-content:center; color:var(--primary-text-color); border-radius:999px; }
.stepper .ib { width:32px; height:32px; --mdc-icon-size:20px; }
.stepper .ib:hover, .seg button:hover { background:rgba(127,127,127,.15); }
.stepper .ib:disabled { opacity:.3; cursor:default; background:none; }
.stepper .range { min-width:96px; padding:0 6px; text-align:center; font-weight:600; font-size:.9rem; height:32px; white-space:nowrap; }
.range-static { font-weight:600; color:var(--secondary-text-color); font-size:.9rem; }
button:focus-visible { outline:2px solid var(--primary-color); outline-offset:1px; }

.grid { display:grid; gap:10px; }
.tile { position:relative; background:var(--edc-tile, rgba(127,127,127,.07)); border-radius:var(--edc-radius, 16px); padding:12px 14px 14px; min-height:96px; cursor:pointer; display:flex; flex-direction:column; transition:background .15s; min-width:0; }
.tile:hover { background:var(--edc-tile-hover, rgba(127,127,127,.11)); }
.th { display:flex; align-items:center; gap:7px; color:var(--secondary-text-color); font-size:.82rem; font-weight:500; min-height:22px; }
.th ha-icon { --mdc-icon-size:18px; color:var(--c); flex:none; }
.tn { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.live { margin-left:auto; display:flex; align-items:center; gap:4px; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; }
.live i { width:6px; height:6px; border-radius:50%; background:#22C58B; animation:pulse 2s infinite; }
@keyframes pulse { 50% { opacity:.3; } }

.big { font-size:1.9rem; font-weight:650; line-height:1.05; color:var(--primary-text-color); letter-spacing:-.02em; font-variant-numeric:tabular-nums; white-space:nowrap; }
.u { font-size:.8rem; font-weight:500; color:var(--secondary-text-color); margin-left:3px; letter-spacing:0; }
.mid { font-size:1.05rem; font-weight:600; color:var(--primary-text-color); display:flex; align-items:center; gap:2px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.mid ha-icon, .b2 ha-icon { --mdc-icon-size:16px; color:var(--c2); }
.sub { font-size:.8rem; color:var(--secondary-text-color); margin-top:4px; font-variant-numeric:tabular-nums; }
.msg { margin:auto 0; font-size:.85rem; color:var(--secondary-text-color); display:flex; flex-direction:column; gap:2px; padding-top:8px; }
.msg small { font-size:.72rem; opacity:.7; word-break:break-all; }

/* value */
.val { margin-top:auto; padding-top:10px; }
.val .b2 { font-size:1.25rem; margin-top:4px; display:flex; align-items:center; }

/* bar */
.barwrap { margin-top:auto; padding-top:10px; }
.row { display:flex; align-items:baseline; justify-content:space-between; gap:8px; flex-wrap:wrap; }
.row .sub { margin:0; }
.r2 { margin-top:8px; }
.track { position:relative; height:10px; border-radius:6px; background:color-mix(in srgb, var(--c) 16%, transparent); margin-top:8px; overflow:hidden; }
.track.t2 { background:color-mix(in srgb, var(--c2) 16%, transparent); }
.fill { position:absolute; inset:0 auto 0 0; border-radius:6px; background:var(--c); transition:width .6s cubic-bezier(.2,.8,.2,1); }
.t2 .fill { background:var(--c2); }
.gl { position:absolute; top:2px; bottom:2px; width:2px; margin-left:-1px; border-radius:1px; background:var(--card-background-color, var(--ha-card-background, #fff)); opacity:.9; }

/* gauge */
.gauge { position:relative; width:100%; max-width:180px; margin:6px auto 0; flex:1; display:flex; flex-direction:column; justify-content:center; }
.gauge svg { width:100%; display:block; overflow:visible; }
.gauge path { fill:none; stroke-linecap:round; }
.gauge .tr { stroke:color-mix(in srgb, var(--c) 16%, transparent); stroke-width:10; }
.gauge .ar { stroke:var(--c); stroke-width:10; transition:stroke-dasharray .7s cubic-bezier(.2,.8,.2,1); }
.gauge .gm { fill:var(--card-background-color, var(--ha-card-background, #fff)); }
.gauge .a2.tr { stroke:color-mix(in srgb, var(--c2) 16%, transparent); stroke-width:8; }
.gauge .a2.ar { stroke:var(--c2); stroke-width:8; }
.gc { position:absolute; left:0; right:0; top:0; height:calc(100% * 0.86); display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0 18%; }
.gc .big { font-size:clamp(1.2rem, 7cqi, 1.75rem); }
.gc.dual { padding:0 27%; }
.gc.dual .big { font-size:clamp(.95rem, 5.6cqi, 1.3rem); }
.gc.dual .mid { font-size:clamp(.75rem, 4.4cqi, .95rem); }
.gc.dual .u { font-size:.68rem; margin-left:2px; }
.gc .sub { margin-top:2px; font-size:.74rem; }
.gauge { container-type:inline-size; }
.sub.below { text-align:center; margin-top:-6px; }
.anim .gauge .ar { animation:sweep .9s cubic-bezier(.2,.8,.2,1); }
@keyframes sweep { from { stroke-dasharray:0 200; } }
.anim .fill { animation:grow .9s cubic-bezier(.2,.8,.2,1); }
@keyframes grow { from { width:0; } }

/* chart */
.chartwrap { margin-top:auto; padding-top:8px; position:relative; }
.readout { position:absolute; top:8px; right:0; font-size:.75rem; color:var(--primary-text-color); background:var(--card-background-color, var(--ha-card-background)); padding:2px 8px; border-radius:6px; box-shadow:0 1px 4px rgba(0,0,0,.18); opacity:0; pointer-events:none; transition:opacity .12s; white-space:nowrap; font-variant-numeric:tabular-nums; }
.readout.on { opacity:1; }
.chart { margin-top:10px; touch-action:pan-y; }
.chart svg { width:100%; height:64px; display:block; cursor:crosshair; }
.chart .b.up { fill:var(--c); }
.chart .b.dn { fill:var(--c2); }
.chart .b.zero, .chart .fut { fill:color-mix(in srgb, var(--secondary-text-color) 25%, transparent); }
.chart .b { opacity:.85; transition:opacity .1s; }
.chart .b.cur { opacity:1; }
.chart .b.hl { opacity:1; filter:brightness(1.15); }
.chart:hover .b:not(.hl) { opacity:.45; }
.chart .base { stroke:color-mix(in srgb, var(--secondary-text-color) 40%, transparent); stroke-width:.6; vector-effect:non-scaling-stroke; }
.ax { position:relative; height:14px; margin-top:4px; font-size:.68rem; color:var(--secondary-text-color); font-variant-numeric:tabular-nums; }
.ax span { position:absolute; transform:translateX(-50%); }
.ax span:first-child { transform:none; }
.ax span:last-child:not(:first-child) { transform:translateX(-100%); }
.d-chart .ax span { transform:translateX(-50%); }
.mid.c2 { color:var(--secondary-text-color); font-size:.95rem; }

/* skeleton */
.sk { flex:1; min-height:60px; margin-top:12px; border-radius:12px; background:linear-gradient(90deg, rgba(127,127,127,.08) 0%, rgba(127,127,127,.16) 50%, rgba(127,127,127,.08) 100%); background-size:200% 100%; animation:sh 1.2s infinite linear; }
@keyframes sh { to { background-position:-200% 0; } }

.compact .tile { padding:10px 12px; min-height:80px; }
.compact .big { font-size:1.5rem; }
@media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
`;

/* ------------------------------------------------------------------ *
 * Auto-detection (HomeWizard P1 / watermeter, SolarEdge, price helpers)
 * ------------------------------------------------------------------ */
function autoDetectConfig(hass) {
  const st = hass?.states || {};
  const ids = Object.keys(st).filter((id) => id.startsWith("sensor."));
  const a = (id) => st[id]?.attributes || {};
  const isTotal = (id) => ["total", "total_increasing"].includes(a(id).state_class);
  const find = (re, extra = () => true) => ids.filter((id) => re.test(id) && extra(id));

  const energy = (id) => a(id).device_class === "energy" && isTotal(id);
  let imp = find(/energy_import$/, energy);
  if (!imp.length) imp = find(/energy_import_tariff_\d$/, energy);
  let exp = find(/energy_export$/, energy);
  if (!exp.length) exp = find(/energy_export_tariff_\d$/, energy);
  const gas = find(/(total_gas|gas_m3|gas_consumption|_gas$)/, (id) => a(id).device_class === "gas" && isTotal(id)).slice(0, 1);
  const water = ids.filter((id) => a(id).device_class === "water" && isTotal(id)).slice(0, 1);
  const solar = find(/solaredge.*(lifetime_energy|energy_total)/, energy).slice(0, 1)
    .concat(find(/solar.*(lifetime|total).*energy/, energy)).slice(0, 1);
  const power = find(/p1.*_power$/, (id) => a(id).device_class === "power").slice(0, 1);
  const solarPower = find(/solaredge.*(current_power|ac_power)$/, (id) => a(id).device_class === "power").slice(0, 1);

  const helpers = Object.keys(st).filter((id) => /^(input_number|number)\./.test(id) ||
    (id.startsWith("sensor.") && /\//.test(a(id).unit_of_measurement || "") && !["energy", "gas", "water", "power"].includes(a(id).device_class)));
  const price = (re) => helpers.find((id) => /(prijs|price|tarief|tariff|kosten)/.test(id) && re.test(id));
  const prices = {};
  const pImp = price(/(stroom|elek|electric|energy|kwh|import|afname)/);
  const pExp = price(/(teruglever|export|feed)/);
  const pGas = price(/gas/);
  const pWat = price(/water/);
  if (pImp && pImp !== pExp) prices.import = pImp;
  if (pExp) prices.export = pExp;
  if (pGas) prices.gas = pGas;
  if (pWat) prices.water = pWat;

  const sources = {};
  if (imp.length) sources.import = imp.length === 1 ? imp[0] : imp;
  if (exp.length) sources.export = exp.length === 1 ? exp[0] : exp;
  if (gas.length) sources.gas = gas[0];
  if (water.length) sources.water = water[0];
  if (solar.length) sources.solar = solar[0];
  if (power.length) sources.power = power[0];
  if (solarPower.length) sources.solar_power = solarPower[0];

  const tiles = [];
  if (sources.import) tiles.push({ metric: "import", display: "gauge" });
  if (sources.export) tiles.push({ metric: "export", display: "gauge" });
  if (sources.solar) tiles.push({ metric: "solar", display: "gauge" });
  if (sources.gas) tiles.push({ metric: "gas", display: "gauge" });
  if (sources.water) tiles.push({ metric: "water", display: "gauge" });
  if (sources.import && sources.export) tiles.push({ metric: "import_export", display: "chart", span: 2 });
  if (sources.power) tiles.push({ metric: "power", display: "bar" });
  if (Object.keys(prices).length) tiles.push({ metric: "cost_total", display: "value" });
  if (!tiles.length) tiles.push({ metric: "import", display: "gauge" });
  return { periods: ["day", "week", "month"], sources, prices, tiles };
}

/* ------------------------------------------------------------------ *
 * Visual editor (uses Home Assistant's built-in ha-form)
 * ------------------------------------------------------------------ */
const ED = {
  en: {
    title: "Title", show_navigation: "Show date navigation", sync_group: "Sync group (cards with the same group share the date)",
    periods: "Periods", columns: "Columns (0 = automatic)", compact: "Compact", currency: "Currency (e.g. EUR)",
    sources: "Sources (sensors)", prices: "Prices (helpers or price sensors)", tiles: "Tiles", add: "Add tile",
    import: "Electricity import (kWh, one or more tariffs)", export: "Electricity export (kWh)", solar: "Solar production (kWh)",
    gas: "Gas (m³)", water: "Water (m³ or L)", power: "Live power (W)", solar_power: "Live solar power (W)",
    p_import: "Price import per kWh", p_export: "Price export per kWh", p_gas: "Price gas per m³", p_water: "Price water per m³",
    fixed_daily: "Fixed costs per day (number or entity)",
    metric: "Show", display: "Display as", show: "Value", name: "Name (optional)", icon: "Icon (optional)", color: "Color (hex, optional)",
    goal: "Goal / maximum per day", span: "Tile width (columns)", secondary: "Second line", unit: "Unit", decimals: "Decimals",
    entity: "Entity override (optional)", usage: "Usage", cost: "Cost", auto: "Automatic", none: "None",
    day: "Day", week: "Week", month: "Month",
    gaugeL: "Circle gauge", barL: "Bar", valueL: "Value", chartL: "Chart (per hour/day)",
  },
  nl: {
    title: "Titel", show_navigation: "Datumnavigatie tonen", sync_group: "Sync-groep (kaarten met dezelfde groep delen de datum)",
    periods: "Periodes", columns: "Kolommen (0 = automatisch)", compact: "Compact", currency: "Valuta (bijv. EUR)",
    sources: "Bronnen (sensoren)", prices: "Prijzen (helpers of prijssensoren)", tiles: "Tegels", add: "Tegel toevoegen",
    import: "Stroomafname (kWh, één of meer tarieven)", export: "Teruglevering (kWh)", solar: "Opwek zonnepanelen (kWh)",
    gas: "Gas (m³)", water: "Water (m³ of L)", power: "Actueel vermogen (W)", solar_power: "Actuele opwek (W)",
    p_import: "Prijs afname per kWh", p_export: "Vergoeding teruglevering per kWh", p_gas: "Prijs gas per m³", p_water: "Prijs water per m³",
    fixed_daily: "Vaste kosten per dag (getal of entiteit)",
    metric: "Toon", display: "Weergave", show: "Waarde", name: "Naam (optioneel)", icon: "Icoon (optioneel)", color: "Kleur (hex, optioneel)",
    goal: "Doel / maximum per dag", span: "Tegelbreedte (kolommen)", secondary: "Tweede regel", unit: "Eenheid", decimals: "Decimalen",
    entity: "Andere entiteit (optioneel)", usage: "Verbruik", cost: "Kosten", auto: "Automatisch", none: "Geen",
    day: "Dag", week: "Week", month: "Maand",
    gaugeL: "Cirkelmeter", barL: "Balk", valueL: "Waarde", chartL: "Grafiek (per uur/dag)",
  },
};

class EnergyDisplayCardEditor extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }); this._open = 0; }

  setConfig(config) {
    const same = this._emitted && JSON.stringify(config) === this._emitted;
    this._config = { ...config, tiles: arr(config.tiles) };
    if (!same) this._render(); // ignore the echo of our own change (keeps focus while typing)
  }
  set hass(hass) {
    this._hass = hass;
    this.shadowRoot.querySelectorAll("ha-form").forEach((f) => (f.hass = hass));
    if (!this._rendered) this._render();
  }

  connectedCallback() { this._ensureComponents(); }

  async _ensureComponents() {
    // ha-form / entity pickers are lazy loaded; loading an entities card editor pulls them in
    if (customElements.get("ha-form") && customElements.get("ha-entity-picker")) return;
    try {
      const h = await window.loadCardHelpers?.();
      const c = await h?.createCardElement({ type: "entities", entities: [] });
      await c?.constructor?.getConfigElement?.();
    } catch { /* ignore */ }
    this._rendered = false;
    this._render();
  }

  _L() { return ED[lang(this._hass)] || ED.en; }

  _rootSchema() {
    const L = this._L();
    const ent = (multiple = false, dc) => ({ entity: { multiple, filter: { domain: "sensor", ...(dc ? { device_class: dc } : {}) } } });
    const priceSel = { entity: { filter: [{ domain: "input_number" }, { domain: "sensor" }, { domain: "number" }] } };
    return [
      { name: "title", selector: { text: {} } },
      { type: "grid", name: "", schema: [
        { name: "show_navigation", selector: { boolean: {} } },
        { name: "compact", selector: { boolean: {} } },
      ] },
      { name: "periods", selector: { select: { multiple: true, mode: "list", options: ["day", "week", "month"].map((v) => ({ value: v, label: L[v] })) } } },
      { type: "grid", name: "", schema: [
        { name: "sync_group", selector: { text: {} } },
        { name: "columns", selector: { number: { min: 0, max: 6, mode: "box" } } },
      ] },
      { type: "expandable", name: "sources", title: L.sources, icon: "mdi:meter-electric-outline", schema: [
        { name: "import", selector: ent(true, "energy") },
        { name: "export", selector: ent(true, "energy") },
        { name: "solar", selector: ent(true, "energy") },
        { name: "gas", selector: ent(false) },
        { name: "water", selector: ent(false) },
        { name: "power", selector: ent(false, "power") },
        { name: "solar_power", selector: ent(false, "power") },
      ] },
      { type: "expandable", name: "prices", title: L.prices, icon: "mdi:currency-eur", schema: [
        { name: "import", selector: priceSel },
        { name: "export", selector: priceSel },
        { name: "gas", selector: priceSel },
        { name: "water", selector: priceSel },
        { name: "fixed_daily", selector: { text: {} } },
        { name: "currency", selector: { text: {} } },
      ] },
    ];
  }

  _tileSchema(tile) {
    const L = this._L();
    const s = t(this._hass);
    const m = METRICS[tile.metric] || METRICS.import;
    const schema = [
      { type: "grid", name: "", schema: [
        { name: "metric", required: true, selector: { select: { mode: "dropdown", options: Object.keys(METRICS).map((k) => ({ value: k, label: s.m[k] })) } } },
        { name: "display", selector: { select: { mode: "dropdown", options: DISPLAYS.map((d) => ({ value: d, label: L[d + "L"] })) } } },
      ] },
    ];
    if (m.price || tile.metric === "net" || tile.metric === "import_export") {
      schema.push({ name: "show", selector: { select: { mode: "box", options: [{ value: "usage", label: L.usage }, { value: "cost", label: L.cost }] } } });
    }
    schema.push(
      { type: "grid", name: "", schema: [
        { name: "goal", selector: { number: { min: 0, step: "any", mode: "box" } } },
        { name: "span", selector: { number: { min: 1, max: 6, mode: "box" } } },
      ] },
      { type: "grid", name: "", schema: [
        { name: "name", selector: { text: {} } },
        { name: "icon", selector: { icon: {} } },
      ] },
      { type: "grid", name: "", schema: [
        { name: "color", selector: { text: {} } },
        { name: "secondary", selector: { select: { mode: "dropdown", options: [{ value: "auto", label: L.auto }, { value: "cost", label: L.cost }, { value: "goal", label: L.goal }, { value: "none", label: L.none }] } } },
      ] },
      { name: "entity", selector: { entity: { multiple: m.kind === "cum" && m.base === "kWh" } } },
    );
    if (tile.metric === "water") schema.push({ name: "unit", selector: { select: { mode: "box", options: ["L", "m³"] } } });
    return schema;
  }

  _label = (s) => {
    const L = this._L();
    if (s.name === "goal") return L.goal;
    return L[s.name] || s.name;
  };
  _priceLabel = (s) => { const L = this._L(); return L["p_" + s.name] || L[s.name] || s.name; };

  _emit() {
    const cfg = { ...this._config };
    if (cfg.show_navigation === true) delete cfg.show_navigation;
    if (cfg.sync_group === "default") delete cfg.sync_group;
    if (!cfg.columns) delete cfg.columns;
    if (cfg.compact === false) delete cfg.compact;
    this._emitted = JSON.stringify(cfg);
    this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: cfg }, bubbles: true, composed: true }));
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!customElements.get("ha-form")) { this.shadowRoot.innerHTML = `<div style="padding:8px">Loading…</div>`; return; }
    this._rendered = true;
    const L = this._L();
    const s = t(this._hass);
    const c = this._config;
    this.shadowRoot.innerHTML = `<style>${EDITOR_CSS}</style>
      <div class="root"></div>
      <div class="tiles-h">${L.tiles}</div>
      <div class="tiles">${c.tiles.map((tile, i) => `
        <div class="tile ${this._open === i ? "open" : ""}" data-i="${i}">
          <div class="bar">
            <button class="hd" data-act="toggle"><ha-icon icon="${esc(tile.icon || METRICS[tile.metric]?.icon || "mdi:help")}" style="color:${esc(tile.color || METRICS[tile.metric]?.color || "inherit")}"></ha-icon>
              <span>${esc(tile.name || s.m[tile.metric] || tile.metric)}</span><small>${esc(L[(tile.display || "gauge") + "L"])}</small></button>
            <button class="ib" data-act="up" title="up" ${i === 0 ? "disabled" : ""}><ha-icon icon="mdi:arrow-up"></ha-icon></button>
            <button class="ib" data-act="down" title="down" ${i === c.tiles.length - 1 ? "disabled" : ""}><ha-icon icon="mdi:arrow-down"></ha-icon></button>
            <button class="ib" data-act="copy" title="duplicate"><ha-icon icon="mdi:content-copy"></ha-icon></button>
            <button class="ib del" data-act="del" title="delete"><ha-icon icon="mdi:delete-outline"></ha-icon></button>
          </div>
          <div class="body"></div>
        </div>`).join("")}
      </div>
      <button class="add" data-act="add"><ha-icon icon="mdi:plus"></ha-icon>${L.add}</button>`;

    // root form
    const rf = document.createElement("ha-form");
    rf.hass = this._hass;
    const src = { ...(c.sources || {}) };
    ["import", "export", "solar"].forEach((k) => { if (src[k] != null) src[k] = arr(src[k]); });
    rf.data = { show_navigation: true, sync_group: "default", periods: ["day"], columns: 0, ...c, sources: src, prices: { ...(c.prices || {}), currency: c.currency } };
    if (this._rsLang !== lang(this._hass)) { this._rs = this._rootSchema(); this._rsLang = lang(this._hass); }
    rf.schema = this._rs;
    rf.computeLabel = (sch) => (["import", "export", "gas", "water", "fixed_daily", "currency"].includes(sch.name) && this._inPrices(sch) ? this._priceLabel(sch) : this._label(sch));
    rf.addEventListener("value-changed", (ev) => {
      const v = { ...ev.detail.value };
      const prices = { ...(v.prices || {}) };
      const currency = prices.currency; delete prices.currency;
      if (prices.fixed_daily != null && prices.fixed_daily !== "" && !isNaN(+prices.fixed_daily)) prices.fixed_daily = +prices.fixed_daily;
      this._config = { ...this._config, ...v, prices, tiles: this._config.tiles };
      if (currency) this._config.currency = currency; else delete this._config.currency;
      this._clean(this._config);
      this._emit();
    });
    this.shadowRoot.querySelector(".root").appendChild(rf);

    // open tile form
    const openEl = this.shadowRoot.querySelector(`.tile.open .body`);
    if (openEl) {
      const i = this._open;
      const tf = document.createElement("ha-form");
      tf.hass = this._hass;
      const td = { display: "gauge", show: "usage", secondary: "auto", ...c.tiles[i] };
      const mm = METRICS[td.metric];
      if (td.entity != null && mm?.kind === "cum" && mm.base === "kWh") td.entity = arr(td.entity);
      tf.data = td;
      tf.schema = this._tileSchema(c.tiles[i]);
      tf.computeLabel = this._label;
      tf.addEventListener("value-changed", (ev) => {
        const nv = { ...ev.detail.value };
        const prevMetric = this._config.tiles[i].metric;
        this._clean(nv);
        if (nv.secondary === "auto") delete nv.secondary;
        if (nv.show === "usage") delete nv.show;
        const tiles = this._config.tiles.slice();
        tiles[i] = nv;
        this._config = { ...this._config, tiles };
        this._emit();
        if (nv.metric !== prevMetric) this._render();
        else this._refreshHeader(i);
      });
      openEl.appendChild(tf);
    }

    this.shadowRoot.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", (ev) => this._act(ev)));
  }

  _inPrices(sch) {
    // ha-form gives nested schema items; price-specific labels only for the prices block
    return this._rs.find((x) => x.name === "prices").schema.includes(sch);
  }

  _refreshHeader(i) {
    const el = this.shadowRoot.querySelector(`.tile[data-i="${i}"] .hd`);
    if (!el) return;
    const tile = this._config.tiles[i];
    const L = this._L();
    el.querySelector("span").textContent = tile.name || t(this._hass).m[tile.metric] || tile.metric;
    el.querySelector("small").textContent = L[(tile.display || "gauge") + "L"];
  }

  _clean(o) {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v === "" || v == null || (Array.isArray(v) && !v.length)) delete o[k];
      else if (Array.isArray(v) && v.length === 1 && ["import", "export", "solar", "entity"].includes(k)) o[k] = v[0];
      else if (v && typeof v === "object" && !Array.isArray(v)) this._clean(v);
    }
    return o;
  }

  _act(ev) {
    const b = ev.currentTarget;
    const act = b.dataset.act;
    const tiles = this._config.tiles.slice();
    const i = +b.closest(".tile")?.dataset.i;
    if (act === "add") { tiles.push({ metric: "import", display: "gauge" }); this._open = tiles.length - 1; }
    else if (act === "toggle") { this._open = this._open === i ? -1 : i; this._render(); return; }
    else if (act === "del") { tiles.splice(i, 1); this._open = -1; }
    else if (act === "copy") { tiles.splice(i + 1, 0, { ...tiles[i] }); this._open = i + 1; }
    else if (act === "up" && i > 0) { [tiles[i - 1], tiles[i]] = [tiles[i], tiles[i - 1]]; this._open = i - 1; }
    else if (act === "down" && i < tiles.length - 1) { [tiles[i + 1], tiles[i]] = [tiles[i], tiles[i + 1]]; this._open = i + 1; }
    this._config = { ...this._config, tiles };
    this._emit();
    this._render();
  }
}

const EDITOR_CSS = `
.tiles-h { font-weight:600; margin:20px 0 8px; font-size:1rem; }
.tiles { display:flex; flex-direction:column; gap:8px; }
.tile { border:1px solid var(--divider-color); border-radius:12px; overflow:hidden; }
.tile.open { border-color:var(--primary-color); }
.bar { display:flex; align-items:center; gap:2px; padding:4px 4px 4px 0; }
button { all:unset; cursor:pointer; color:var(--primary-text-color); }
.hd { flex:1; display:flex; align-items:center; gap:10px; padding:8px 12px; min-width:0; }
.hd span { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.hd small { color:var(--secondary-text-color); margin-left:auto; white-space:nowrap; }
.ib { width:34px; height:34px; display:flex; align-items:center; justify-content:center; border-radius:50%; --mdc-icon-size:20px; color:var(--secondary-text-color); }
.ib:hover { background:rgba(127,127,127,.15); }
.ib:disabled { opacity:.3; cursor:default; }
.ib.del:hover { color:var(--error-color); }
.body { padding:0 12px; }
.tile.open .body { padding:4px 12px 12px; }
.add { display:flex; align-items:center; gap:8px; margin-top:10px; padding:10px 14px; border-radius:10px; color:var(--primary-color); font-weight:500; }
.add:hover { background:rgba(127,127,127,.1); }
`;

/* ================================================================== *
 * ENERGY HOUSE CARD
 * Illustrated house (sky follows the sun) + Home Assistant–style
 * energy-distribution nodes with animated flows.
 * Re-uses the data layer of EnergyDisplayCard (statistics, prices, sync).
 * ================================================================== */
const HOUSE_TAG = "energy-house-card";

const HOUSE_STR = {
  en: {
    home: "Home", grid: "Grid", solar: "Solar", gas: "Gas", water: "Water",
    f: { import: "Grid import", export: "Export", net: "Net", cost_total: "Cost", solar: "Solar", usage_total: "Usage",
      self_consumption: "Solar use", self_sufficiency: "Self-sufficient", gas: "Gas", water: "Water" },
  },
  nl: {
    home: "Huis", grid: "Net", solar: "Zon", gas: "Gas", water: "Water",
    f: { import: "Afname", export: "Teruglevering", net: "Netto", cost_total: "Kosten", solar: "Opwek", usage_total: "Verbruik",
      self_consumption: "Zonverbruik", self_sufficiency: "Zelfvoorzienend", gas: "Gas", water: "Water" },
  },
};
const hs = (hass) => HOUSE_STR[lang(hass)] || HOUSE_STR.en;

/* flow colours: slightly brighter than the tile colours so they read on a dark/blue sky */
const HC = { import: "#A48CFF", export: "#2FD69A", solar: "#FFC23D", gas: "#FF8A57", water: "#46AEFF" };

/* scene geometry (viewBox 400 × 300) */
const HG = {
  W: 400, H: 324, DY: 22, // DY: the landscape/house is drawn at y+DY to leave room for the header
  n: {
    solar: { x: 144, y: 118, r: 32, lab: "top", icon: "mdi:solar-power" },
    gas:   { x: 350, y: 140, r: 29, lab: "top", icon: "mdi:fire" },
    grid:  { x: 56, y: 214, r: 38, lab: "top", icon: "mdi:transmission-tower" },
    water: { x: 350, y: 228, r: 29, lab: "top", icon: "mdi:water" },
    home:  { x: 203, y: 248, r: 28, icon: "mdi:home" },
  },
};

/* sky palettes keyed by sun elevation (degrees) — interpolated in between */
const SKY = [
  [-10, { sky1: "#1d2470", sky2: "#3b3c9e", hill1: "#3d3a8f", hill2: "#2c2870", grnd: "#251d55", under: "#1e1744", foot: "#171034", foot2: "#120c29",
    cloud: "#4b52ad", cloudA: 0.55, tree1: "#3f8f5f", tree2: "#2e6f50", room: "#efe0a8", stars: 1, light: 1, moon: 1, sun: 0, sunc: "#ffb36b" }],
  [-4, { sky1: "#6b4a9e", sky2: "#e39a86", hill1: "#7b5596", hill2: "#5d4285", grnd: "#4a3474", under: "#3a2862", foot: "#2b1d4c", foot2: "#22163d",
    cloud: "#f0a98e", cloudA: 0.75, tree1: "#4c9a64", tree2: "#3a7b56", room: "#f0dfab", stars: 0.35, light: 0.9, moon: 0.25, sun: 0, sunc: "#ff9a5c" }],
  [3, { sky1: "#6d86cf", sky2: "#f4c08c", hill1: "#7ea86c", hill2: "#4e8a55", grnd: "#35633f", under: "#28462f", foot: "#1e3425", foot2: "#172a1e",
    cloud: "#fde2cc", cloudA: 0.85, tree1: "#53a464", tree2: "#3e8852", room: "#efe4c4", stars: 0, light: 0.35, moon: 0, sun: 1, sunc: "#ffc27a" }],
  [12, { sky1: "#5c93e0", sky2: "#bcd8f3", hill1: "#6fae6d", hill2: "#43904f", grnd: "#2f6740", under: "#24472f", foot: "#1b3323", foot2: "#15281b",
    cloud: "#ffffff", cloudA: 0.9, tree1: "#56aa66", tree2: "#3f8d53", room: "#ece7dc", stars: 0, light: 0, moon: 0, sun: 1, sunc: "#fff0b0" }],
];
const FORCED_ELEVATION = { day: 35, golden: 4, dusk: -4, night: -20 };

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
function skyAt(e) {
  if (e <= SKY[0][0]) return SKY[0][1];
  if (e >= SKY[SKY.length - 1][0]) return SKY[SKY.length - 1][1];
  let i = 0;
  while (e > SKY[i + 1][0]) i++;
  const [e0, a] = SKY[i], [e1, b] = SKY[i + 1];
  const k = (e - e0) / (e1 - e0);
  const out = {};
  for (const key in a) {
    out[key] = typeof a[key] === "number" ? a[key] + (b[key] - a[key]) * k
      : rgb2hex(hex2rgb(a[key]).map((v, j) => v + (hex2rgb(b[key])[j] - v) * k));
  }
  return out;
}

/** approximate solar position (good to ~1°) when sun.sun is not available */
function sunPosition(date, lat, lon) {
  const rad = Math.PI / 180;
  const d = date.getTime() / 864e5 - 10957.5;
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const ob = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(ob) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(ob) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const H = (gmst * 15 + lon) * rad - ra;
  const la = lat * rad;
  const alt = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(H));
  return { elevation: alt / rad, azimuth: ((az / rad) + 360) % 360 };
}

function roundPath(pts, rad = 9) {
  let d = `M${pts[0][0]},${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
    const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
    const r = Math.min(rad, d1 / 2, d2 / 2);
    const ax = x1 - ((x1 - x0) / d1) * r, ay = y1 - ((y1 - y0) / d1) * r;
    const bx = x1 + ((x2 - x1) / d2) * r, by = y1 + ((y2 - y1) / d2) * r;
    d += ` L${ax.toFixed(1)},${ay.toFixed(1)} Q${x1},${y1} ${bx.toFixed(1)},${by.toFixed(1)}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l[0]},${l[1].toFixed(1)}`;
}
/** y on a node's circle at x (side 1 = bottom, -1 = top) */
const onCircle = (n, x, side) => n.y + side * Math.sqrt(Math.max(0, n.r * n.r - (x - n.x) ** 2));

class EnergyHouseCard extends EnergyDisplayCard {
  static getConfigElement() { return document.createElement(`${HOUSE_TAG}-editor`); }
  static getStubConfig(hass) {
    const c = autoDetectConfig(hass);
    const hasPrice = Object.keys(c.prices).length > 0;
    return { sources: c.sources, prices: c.prices, footer: ["import", hasPrice ? "cost_total" : "usage_total", "export"] };
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const footer = arr(config.footer ?? ["import", "cost_total", "export"]).slice(0, 4);
    footer.forEach((m) => {
      if (!METRICS[m] || METRICS[m].kind === "live") throw new Error(`footer: unsupported item "${m}"`);
    });
    const src = config.sources || {};
    const on = (k, srcKey = k) => config[`show_${k}`] !== false && arr(src[srcKey]).length > 0;
    this._nodes = {
      solar: on("solar"),
      grid: config.show_grid !== false && (arr(src.import).length > 0 || arr(src.export).length > 0),
      gas: on("gas"),
      water: on("water"),
      home: config.show_home !== false,
    };
    // statistics needed = node metrics + footer metrics (synthetic, hidden tiles for the shared data layer)
    const need = new Set(footer);
    if (this._nodes.solar) need.add("solar");
    if (this._nodes.grid) { if (arr(src.import).length) need.add("import"); if (arr(src.export).length) need.add("export"); }
    if (this._nodes.gas) need.add("gas");
    if (this._nodes.water) need.add("water");
    if (this._nodes.home) { ["import", "export", "solar"].forEach((k) => arr(src[k]).length && need.add(k)); }
    this._footer = footer;
    super.setConfig({ periods: ["day"], ...config, tiles: [...need].map((metric) => ({ metric })) });
    this._sceneKey = null;
  }

  getCardSize() { return 8; }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }

  _watchIds() {
    if (this._watch) return this._watch;
    super._watchIds();
    this._watch.push("sun.sun");
    return this._watch;
  }

  connectedCallback() {
    super.connectedCallback();
    if (!this._io && "IntersectionObserver" in window) {
      // pause the SMIL flow animations while the card is scrolled out of view
      this._io = new IntersectionObserver((es) => {
        const svg = this.shadowRoot.querySelector("svg.sc");
        if (!svg) return;
        es[0].isIntersecting ? svg.unpauseAnimations?.() : svg.pauseAnimations?.();
      });
      this._io.observe(this);
    }
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this._io?.disconnect();
    this._io = null;
  }

  /* ---------------- build (once per config) ---------------- */
  _build() {
    const c = this._config;
    const N = this._nodes;
    const s = hs(this._hass);
    const uid = "h" + Math.random().toString(36).slice(2, 8);
    this._uid = uid;
    const n = HG.n, H = n.home;

    // flows (direction = direction of the dots)
    const flows = [];
    const src = c.sources;
    const DY = HG.DY;
    if (N.solar) flows.push({ id: "solar", c: HC.solar, d: `M${n.solar.x},${n.solar.y + n.solar.r} C${n.solar.x},${n.solar.y + n.solar.r + 34} ${H.x},${158 + DY} ${H.x},${178 + DY} L${H.x},${H.y - H.r}` });
    if (N.grid && arr(src.import).length) flows.push({ id: "import", c: HC.import, d: roundPath([[62, onCircle(n.grid, 62, 1)], [62, 272 + DY], [190, 272 + DY], [190, onCircle(H, 190, 1)]]) });
    if (N.grid && arr(src.export).length) flows.push({ id: "export", c: HC.export, d: roundPath([[198, onCircle(H, 198, 1)], [198, 282 + DY], [46, 282 + DY], [46, onCircle(n.grid, 46, 1)]]) });
    if (N.gas) flows.push({ id: "gas", c: HC.gas, d: roundPath([[n.gas.x - n.gas.r, n.gas.y], [309, n.gas.y], [309, 276 + DY], [216, 276 + DY], [216, onCircle(H, 216, 1)]]) });
    if (N.water) flows.push({ id: "water", c: HC.water, d: roundPath([[n.water.x, n.water.y + n.water.r], [n.water.x, 286 + DY], [208, 286 + DY], [208, onCircle(H, 208, 1)]]) });
    this._flowIds = flows.map((f) => f.id);

    const dot = (id, second) => `<g class="dot"><circle class="dg" r="5.5"/><circle class="dd" r="2.7"/>
      <animateMotion dur="4s" repeatCount="indefinite" calcMode="linear" ${second ? 'keyPoints="0.5;1;0;0.5" keyTimes="0;0.5;0.5;1"' : ""}><mpath href="#${uid}-${id}"/></animateMotion></g>`;

    const stars = [[22, 62], [64, 40], [98, 78], [188, 58], [214, 30], [242, 98], [286, 44], [318, 70], [372, 52], [390, 98], [30, 118], [270, 120], [118, 30], [348, 26]]
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 3 ? 0.9 : 1.4}" style="animation-delay:${(i * 0.37) % 3}s"/>`).join("");

    const svg = `
<svg class="sc" viewBox="0 0 ${HG.W} ${HG.H}" aria-hidden="true">
  <defs>
    <linearGradient id="${uid}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--sky1)"/><stop offset="0.85" style="stop-color:var(--sky2)"/></linearGradient>
    <linearGradient id="${uid}-soil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--under)"/><stop offset="1" style="stop-color:var(--foot)"/></linearGradient>
    <radialGradient id="${uid}-sun"><stop offset="0" style="stop-color:var(--sunc);stop-opacity:.75"/><stop offset="1" style="stop-color:var(--sunc);stop-opacity:0"/></radialGradient>
    <radialGradient id="${uid}-lamp"><stop offset="0" stop-color="#fff3c4" stop-opacity=".9"/><stop offset="1" stop-color="#fff3c4" stop-opacity="0"/></radialGradient>
    <linearGradient id="${uid}-spill" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffe7a6" stop-opacity=".32"/><stop offset="1" stop-color="#ffe7a6" stop-opacity="0"/></linearGradient>
    <linearGradient id="${uid}-pv" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2b2f55"/><stop offset="1" stop-color="#171a33"/></linearGradient>
  </defs>
  <rect width="${HG.W}" height="${HG.H}" fill="url(#${uid}-sky)"/>
  <g class="stars">${stars}</g>
  <g class="moon" transform="translate(258 92)"><circle r="20" fill="#f6f1cf" opacity=".12"/><path d="M0,-10 A10,10 0 1,0 0,10 A7.5,10 0 1,1 0,-10Z" fill="#f6f1cf"/></g>
  <g class="sun"><circle r="34" fill="url(#${uid}-sun)"/><circle r="11" style="fill:var(--sunc)"/></g>
  <g class="land" transform="translate(0 ${HG.DY})">
  <g class="clouds">
    <path d="M-12,200 Q-14,170 16,172 Q22,146 52,150 Q72,130 98,148 Q124,146 126,172 Q146,176 142,200 Z"/>
    <path d="M276,192 Q274,166 300,168 Q308,138 340,144 Q362,124 386,144 Q414,144 414,192 Z"/>
  </g>
  <path class="hill1" d="M0,212 C70,190 140,196 210,208 C280,220 330,196 400,200 V258 H0Z"/>
  <path class="hill2" d="M0,238 C70,224 150,236 230,242 C300,246 350,228 400,232 V258 H0Z"/>
  <path class="spill" d="M294,198 L400,236 L400,258 L294,258 Z" fill="url(#${uid}-spill)"/>
  <!-- trees behind -->
  <path class="t2" d="M96,258 C90,244 90,222 99,208 C108,222 110,244 104,258Z"/>
  <!-- house -->
  <g class="house">
    <rect x="110" y="193" width="62" height="65" fill="#34343f"/>
    <path d="M170,195 L233,131 L235,131 L235,258 L170,258Z" fill="#44444f"/>
    <path d="M106,195 L170,131 L233,131 L170,195Z" fill="#2c2c38"/>
    ${N.solar ? `<g class="pv">
      <path d="M118,189 L173,136 L222,136 L167,189Z" fill="url(#${uid}-pv)"/>
      <path d="M145.5,162.5 L194.5,162.5 M142.5,189 L197.5,136 M131,176 L180,176 M132,149 L208,149" stroke="#7782c8" stroke-opacity=".35" stroke-width=".8" fill="none"/>
      <path d="M150,184 L185,150 L192,150 L157,184Z" fill="#fff" opacity=".06"/>
    </g>` : ""}
    <path d="M106,195 L170,131 L233,131" fill="none" stroke="#57506b" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
    <path class="room" d="M237,140 L291,194 L291,258 L237,258Z"/>
    <path d="M243,152 L259,168 L243,168Z" fill="#9db0d6" opacity=".85"/>
    <circle class="lampglow" cx="281" cy="216" r="30" fill="url(#${uid}-lamp)"/>
    <path d="M281,212 V256" stroke="#cfc6b2" stroke-width="1.6"/>
    <path d="M275,213 L287,213 L285,205 L277,205Z" fill="#fff8e2"/>
    <rect x="243" y="242" width="29" height="12" rx="3" fill="#bcae92"/>
    <rect x="243" y="233" width="8" height="21" rx="2.5" fill="#a99a7d"/>
    <path d="M235,200 H293" stroke="#3a3a46" stroke-width="4"/>
    <path d="M235,131 V258" stroke="#3a3a46" stroke-width="4"/>
    <path d="M293,196 V258" stroke="#3a3a46" stroke-width="5"/>
    ${N.gas ? `<rect x="255" y="140" width="10" height="18" fill="#3a3a46"/><rect x="253" y="137" width="14" height="4" rx="1" fill="#4a4558"/>
      <g class="smoke"><circle cx="260" cy="132" r="3.5"/><circle cx="260" cy="132" r="3.5" style="animation-delay:-1.3s"/><circle cx="260" cy="132" r="3.5" style="animation-delay:-2.6s"/></g>` : ""}
    <path d="M233,128 L298,194" stroke="#57506b" stroke-width="7" stroke-linecap="round"/>
  </g>
  <!-- trees in front -->
  <path class="t1" d="M115,258 C106,240 106,206 117,184 C128,206 130,240 123,258Z"/>
  <circle class="t2" cx="132" cy="252" r="7"/>
  <circle class="t1" cx="301" cy="252" r="7"/><circle class="t2" cx="311" cy="254" r="5.5"/>
  <rect class="grnd" x="0" y="255" width="${HG.W}" height="4"/>
  <rect x="0" y="258.5" width="${HG.W}" height="${HG.H - 258 - HG.DY}" fill="url(#${uid}-soil)"/>
  </g>
  <!-- flows -->
  ${flows.map((f) => `<path class="fl-u" d="${f.d}"/>`).join("")}
  ${flows.map((f) => `<path id="${uid}-${f.id}" class="fl" data-f="${f.id}" d="${f.d}" style="--c:${f.c}"/>`).join("")}
  ${flows.map((f) => `<g class="dots" data-f="${f.id}" style="--c:${f.c}">${dot(f.id)}${dot(f.id, true)}</g>`).join("")}
  ${N.home ? `<g class="ring" transform="rotate(-90 ${H.x} ${H.y})">
    <circle cx="${H.x}" cy="${H.y}" r="${H.r}" class="rb"/>
    <circle cx="${H.x}" cy="${H.y}" r="${H.r}" class="rs" pathLength="100" style="stroke:${HC.solar}"/>
    <circle cx="${H.x}" cy="${H.y}" r="${H.r}" class="ri" pathLength="100" style="stroke:${HC.import}"/>
  </g>` : ""}
</svg>`;

    const pos = (k) => { const p = n[k]; return `left:${(p.x / HG.W) * 100}%;top:${(p.y / HG.H) * 100}%;width:${((2 * p.r) / HG.W) * 100}%`; };
    const node = (k, color, inner) => N[k] ? `<button class="node n-${k}" data-n="${k}" style="${pos(k)};--c:${color}" aria-label="${esc(s[k])}">
        ${n[k].lab ? `<span class="lab ${n[k].lab}">${esc(s[k])}<em></em></span>` : ""}
        <ha-icon icon="${n[k].icon}"></ha-icon>${inner}</button>` : "";
    const val = `<span class="v"><b></b><i></i></span>`;

    const per = c.periods;
    this.shadowRoot.innerHTML = `<style>${HOUSE_CSS}</style>
<ha-card>
  <div class="wrap" style="--imp:${HC.import};--exp:${HC.export}">
    <div class="scene">
      ${svg}
      <div class="head">
        <div class="ttl">${c.title ? `<div class="sub">${esc(c.title)}</div>` : ""}<div class="date"></div></div>
        ${c.show_navigation ? `<div class="nav">
          ${per.length > 1 ? `<div class="glass seg"><button data-cycle aria-label="period"><span></span><ha-icon icon="mdi:chevron-down"></ha-icon></button></div>` : ""}
          <div class="glass"><button class="ib" data-step="-1" aria-label="previous"><ha-icon icon="mdi:chevron-left"></ha-icon></button>
          <button class="ib" data-step="1" aria-label="next"><ha-icon icon="mdi:chevron-right"></ha-icon></button></div>
        </div>` : ""}
      </div>
      ${node("solar", HC.solar, val)}
      ${node("gas", HC.gas, val)}
      ${node("water", HC.water, val)}
      ${node("grid", HC.import, `<span class="g2 imp"></span><span class="g2 exp"></span>`)}
      ${node("home", "transparent", val)}
    </div>
    ${this._footer.length ? `<div class="foot">${this._footer.map((m, i) => `<button class="fi" data-i="${i}"><div class="fl"></div><div class="fv"><b></b><i></i></div></button>`).join("")}</div>` : ""}
  </div>
</ha-card>`;

    const root = this.shadowRoot;
    this.$ = {
      wrap: root.querySelector(".wrap"),
      date: root.querySelector(".date"),
      sun: root.querySelector(".sun"),
      smoke: root.querySelector(".smoke"),
      next: root.querySelector('[data-step="1"]'),
      nodes: Object.fromEntries([...root.querySelectorAll(".node")].map((el) => [el.dataset.n, el])),
      fl: Object.fromEntries([...root.querySelectorAll(".fl")].map((el) => [el.dataset.f, el])),
      dots: Object.fromEntries([...root.querySelectorAll(".dots")].map((el) => [el.dataset.f, el])),
      foot: [...root.querySelectorAll(".fi")],
      rs: root.querySelector(".rs"), ri: root.querySelector(".ri"),
    };
    this._len = {};
    for (const id of this._flowIds) this._len[id] = this.$.fl[id].getTotalLength?.() || 200;
    this._txt = new Map();
    this._flowState = {};
    this._sceneKey = null;

    root.addEventListener("click", (ev) => this._onClick(ev));
    const sc = root.querySelector(".scene");
    sc.addEventListener("pointerdown", (ev) => { this._px = [ev.clientX, ev.clientY]; });
    sc.addEventListener("pointerup", (ev) => {
      if (!this._px || !c.show_navigation) return;
      const dx = ev.clientX - this._px[0], dy = ev.clientY - this._px[1];
      this._px = null;
      if (Math.abs(dx) > 50 && Math.abs(dy) < 40) {
        this._swiped = true;
        setTimeout(() => (this._swiped = false), 400);
        const g = group(c.sync_group);
        setGroup(c.sync_group, { offset: Math.min(0, g.offset + (dx > 0 ? -1 : 1)) });
      }
    });
    this._built = true;
  }

  _onClick(ev) {
    if (this._swiped) { this._swiped = false; return; }
    if (ev.target.closest("[data-cycle]")) {
      const c = this._config, g = group(c.sync_group);
      const i = c.periods.indexOf(g.period);
      setGroup(c.sync_group, { period: c.periods[(i + 1) % c.periods.length], offset: 0 });
      return;
    }
    const step = ev.target.closest("[data-step]");
    const per = ev.target.closest("[data-period]");
    if (step || per) return super._onClick(ev);
    const src = this._config.sources;
    const nodeEl = ev.target.closest(".node");
    const fi = ev.target.closest(".fi");
    let id;
    if (nodeEl) {
      const k = nodeEl.dataset.n;
      id = arr(k === "grid" ? src.power || src.import : k === "home" ? src.power || src.import : src[k])[0];
    } else if (fi) {
      const m = this._footer[+fi.dataset.i];
      const key = { cost_total: "import", net: "import", usage_total: "import", self_consumption: "solar", self_sufficiency: "solar" }[m] || m;
      id = arr(src[key])[0];
    }
    if (id) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId: id }, bubbles: true, composed: true }));
  }

  /* ---------------- render (cheap, diff-based) ---------------- */
  _set(el, txt) {
    if (!el) return;
    if (this._txt.get(el) !== txt) { el.textContent = txt; this._txt.set(el, txt); }
  }

  _title(r) {
    if (r.period !== "day" || r.offset > -2) return this._rangeLabel(r);
    const l = this._hass?.locale?.language || "en";
    return new Intl.DateTimeFormat(l, { weekday: "short", day: "numeric", month: "long" }).format(r.start);
  }

  _kw(w) {
    const a = Math.abs(w);
    return a >= 1000 ? `${this._fmtNum(a / 1000, a >= 10000 ? 1 : 2)} kW` : `${this._fmtNum(a, 0)} W`;
  }

  _liveW(key) {
    const id = arr(this._config.sources[key])[0];
    const st = id && this._hass.states[id];
    const v = num(st?.state);
    return v == null ? null : v * unitFactor(st.attributes.unit_of_measurement) * (key === "power" && this._config.invert_power ? -1 : 1);
  }

  _scene() {
    let el, az;
    const forced = FORCED_ELEVATION[this._config.scene];
    if (forced != null) { el = forced; az = forced < 0 ? 270 : 200; }
    else {
      const sun = this._hass.states["sun.sun"]?.attributes;
      if (sun && sun.elevation != null) { el = +sun.elevation; az = +sun.azimuth; }
      else {
        const p = sunPosition(new Date(), this._hass.config?.latitude ?? 52.1, this._hass.config?.longitude ?? 5.1);
        el = p.elevation; az = p.azimuth;
      }
    }
    const key = `${Math.round(el * 2)}|${Math.round(az)}`;
    if (key === this._sceneKey) return;
    this._sceneKey = key;
    const p = skyAt(el);
    const st = this.$.wrap.style;
    for (const k in p) st.setProperty("--" + k, p[k]);
    // sun: east (90°) on the left, west (270°) on the right; higher = higher
    const sx = clamp(30 + ((az - 90) / 180) * 340, 18, 382);
    const sy = clamp(250 - el * 4.4, 84, 270);
    this.$.sun.setAttribute("transform", `translate(${sx.toFixed(1)} ${sy.toFixed(1)})`);
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._built) this._build();
    const range = this._range();
    this._lastRange = range;
    const g = group(this._config.sync_group);
    this._set(this.$.date, this._title(range));
    if (this.$.next) this.$.next.disabled = g.offset >= 0;
    this._set(this.shadowRoot.querySelector("[data-cycle] span"), t(this._hass)[g.period] || g.period);
    this._scene();

    const loading = !this._data || this._data.rangeStart !== range.start.getTime() || this._data.period !== range.period;
    this.$.wrap.classList.toggle("loading", loading);
    if (loading) return;

    const memo = {};
    const S = (m) => (memo[m] ||= this._series_({ metric: m }, range));
    const has = (k) => arr(this._config.sources[k]).length > 0;
    const tot = (k) => (has(k) ? S(k).total : 0);
    const fmt = (v, unit, metric) => this._fmt(v, unit, { metric });
    const setVal = (el, v, unit, metric) => {
      const [a, b] = fmt(v, unit, metric);
      this._set(el.querySelector(".v b"), a);
      this._set(el.querySelector(".v i"), b);
    };

    const imp = tot("import"), exp = tot("export"), sol = tot("solar");
    const selfUse = Math.max(0, sol - exp);
    const home = imp + selfUse;
    const live = range.current && this._config.show_live !== false;
    const gridW = live ? this._liveW("power") : null;
    const solW = live ? this._liveW("solar_power") : null;

    // nodes
    const $n = this.$.nodes;
    if ($n.solar) {
      setVal($n.solar, sol, "kWh", "solar");
      this._set($n.solar.querySelector("em"), solW != null && solW > 5 ? ` · ${this._kw(solW)}` : "");
    }
    if ($n.gas) setVal($n.gas, tot("gas"), "m³", "gas");
    if ($n.water) setVal($n.water, tot("water"), "m³", "water");
    if ($n.grid) {
      const [a, b] = fmt(imp, "kWh", "import"), [c2, d] = fmt(exp, "kWh", "export");
      this._set($n.grid.querySelector(".imp"), has("import") ? `→ ${a} ${b}` : "");
      this._set($n.grid.querySelector(".exp"), has("export") ? `← ${c2} ${d}` : "");
      this._set($n.grid.querySelector("em"), gridW != null ? ` · ${gridW < 0 ? "←" : "→"} ${this._kw(gridW)}` : "");
    }
    if ($n.home) {
      setVal($n.home, home, "kWh", "usage_total");
      const sp = home > 0 ? (selfUse / home) * 100 : 0;
      const ip = home > 0 ? 100 - sp : 0;
      this.$.rs.style.strokeDasharray = `${sp.toFixed(2)} 100`;
      this.$.ri.style.strokeDasharray = `0 ${sp.toFixed(2)} ${ip.toFixed(2)} 100`;
    }

    // footer
    const fs = hs(this._hass).f;
    this._footer.forEach((m, i) => {
      const el = this.$.foot[i];
      const ser = S(m);
      const unit = ser.currency ? "cur" : ser.unit;
      const [a, b] = fmt(ser.total, unit, m);
      this._set(el.querySelector(".fl"), fs[m] || t(this._hass).m[m]);
      this._set(el.querySelector(".fv b"), a);
      this._set(el.querySelector(".fv i"), b);
    });

    // flows: rate 0..1 → dot speed
    const r = this._rates(range, { imp, exp, sol, gridW, solW, S, has });
    for (const id of this._flowIds) this._flow(id, r[id] || 0);
    if (this.$.smoke) this.$.smoke.classList.toggle("on", (r.gas || 0) > 0);
  }

  /** how busy each flow is right now (current period) or was (past period), 0..1 */
  _rates(range, { imp, exp, sol, gridW, solW, S, has }) {
    const out = {};
    const maxW = this._config.max_power || 5000;
    const curIdx = range.current ? range.buckets.findIndex(([a, b]) => range.nowMs >= a && range.nowMs < b) : -1;
    const bucket = (k) => (has(k) && curIdx >= 0 ? S(k).values[curIdx] : 0);
    const hourly = range.statPeriod === "hour";
    if (range.current) {
      // electricity: live sensor when available, else usage in the running hour/day
      const perW = hourly ? 1000 : 1000 / 24; // kWh in bucket → average W
      const iW = gridW != null ? Math.max(0, gridW) : bucket("import") * perW;
      const eW = gridW != null ? Math.max(0, -gridW) : bucket("export") * perW;
      const sW = solW != null ? Math.max(0, solW) : bucket("solar") * perW;
      out.import = iW > 15 ? iW / maxW : 0;
      out.export = eW > 15 ? eW / maxW : 0;
      out.solar = sW > 10 ? sW / maxW : 0;
      const gTyp = hourly ? 0.25 : 3, wTyp = hourly ? 0.05 : 0.3;
      const gB = bucket("gas"), wB = bucket("water");
      out.gas = gB > 0.0005 ? gB / gTyp : 0;
      out.water = wB > 0.0002 ? wB / wTyp : 0;
    } else {
      const d = range.days;
      out.import = imp > 0.01 ? imp / (12 * d) : 0;
      out.export = exp > 0.01 ? exp / (12 * d) : 0;
      out.solar = sol > 0.01 ? sol / (15 * d) : 0;
      const gt = has("gas") ? S("gas").total : 0, wt = has("water") ? S("water").total : 0;
      out.gas = gt > 0.001 ? gt / (4 * d) : 0;
      out.water = wt > 0.001 ? wt / (0.4 * d) : 0;
    }
    return out;
  }

  _flow(id, rate) {
    const on = rate > 0;
    // speed in viewBox units / s, quantised so animations are not restarted on every update
    const lvl = on ? Math.round(Math.sqrt(clamp(rate, 0, 1)) * 8) : -1;
    const prev = this._flowState[id];
    if (prev === lvl) return;
    this._flowState[id] = lvl;
    this.$.fl[id].classList.toggle("on", on);
    const g = this.$.dots[id];
    g.classList.toggle("on", on);
    if (!on) return;
    const speed = 22 + lvl * 11;
    const dur = (this._len[id] / speed).toFixed(2) + "s";
    g.querySelectorAll("animateMotion").forEach((a) => a.setAttribute("dur", dur));
  }
}

const HOUSE_CSS = `
:host { display:block; }
ha-card { overflow:hidden; padding:0; background:var(--foot2, #120c29); }
.wrap { container-type:inline-size; position:relative; color:#fff; -webkit-tap-highlight-color:transparent; }
.scene { position:relative; touch-action:pan-y; user-select:none; }
.scene svg { display:block; width:100%; height:auto; }
button { font:inherit; }

.head { position:absolute; inset:0 0 auto 0; display:flex; justify-content:space-between; align-items:flex-start; gap:8px; padding:3.4cqw 3.8cqw 0 4.4cqw; pointer-events:none; }
.head > * { pointer-events:auto; }
.ttl { min-width:0; }
.sub { font-size:clamp(11px, 3.1cqw, 15px); font-weight:500; opacity:.78; margin-bottom:.15em; }
.date { font-size:clamp(22px, 8.6cqw, 46px); font-weight:700; letter-spacing:-.03em; line-height:1.02; white-space:nowrap; text-shadow:0 1px 14px rgba(0,0,0,.18); }
.nav { display:flex; gap:6px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
.glass { display:flex; padding:2px; border-radius:999px; background:rgba(255,255,255,.16); backdrop-filter:blur(10px); -webkit-backdrop-filter:blur(10px); }
.glass button { all:unset; cursor:pointer; color:#fff; border-radius:999px; display:flex; align-items:center; justify-content:center; }
.glass .ib { width:clamp(30px, 8cqw, 38px); height:clamp(30px, 8cqw, 38px); --mdc-icon-size:clamp(20px, 5.4cqw, 24px); }
.glass .ib:disabled { opacity:.35; cursor:default; }
.seg button { gap:2px; padding:0 clamp(6px, 2cqw, 10px) 0 clamp(10px, 3cqw, 14px); height:clamp(30px, 8cqw, 38px); font-size:clamp(12px, 3.3cqw, 15px); font-weight:600; --mdc-icon-size:clamp(16px, 4.4cqw, 20px); }
.glass button:hover:not(:disabled):not([aria-selected="true"]) { background:rgba(255,255,255,.14); }
button:focus-visible { outline:2px solid #fff; outline-offset:1px; }

.node { all:unset; box-sizing:border-box; position:absolute; transform:translate(-50%,-50%); aspect-ratio:1; border-radius:50%;
  background:rgba(14,14,36,.46); border:max(2px, .62cqw) solid var(--c); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px);
  display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.1cqw; cursor:pointer; color:#fff;
  box-shadow:0 2px 12px rgba(0,0,0,.18); transition:transform .15s; }
.node:hover { transform:translate(-50%,-50%) scale(1.05); }
.node ha-icon { --mdc-icon-size:clamp(15px, 5cqw, 28px); opacity:.95; }
.node .v { font-size:clamp(10px, 3.5cqw, 19px); font-weight:600; white-space:nowrap; line-height:1.1; font-variant-numeric:tabular-nums; letter-spacing:-.01em; }
.node .v i { font-style:normal; font-size:.74em; font-weight:500; opacity:.8; margin-left:.18em; }
.node .lab { position:absolute; left:50%; transform:translateX(-50%); white-space:nowrap; font-size:clamp(10px, 3cqw, 15px); font-weight:500; line-height:1.5; padding:0 .6em; border-radius:999px; background:rgba(12,12,34,.32); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); pointer-events:none; }
.node .lab.top { bottom:calc(100% + .8cqw); }
.node .lab em { font-style:normal; opacity:.78; font-variant-numeric:tabular-nums; }
.n-home { background:rgba(14,14,36,.62); border-color:transparent; }
.n-home ha-icon { --mdc-icon-size:clamp(13px, 4.4cqw, 24px); }
.n-grid ha-icon { --mdc-icon-size:clamp(14px, 4.6cqw, 25px); }
.g2 { font-size:clamp(9px, 2.85cqw, 15px); font-weight:600; white-space:nowrap; line-height:1.15; font-variant-numeric:tabular-nums; }
.g2:empty { display:none; }
.g2.imp { color:color-mix(in srgb, var(--imp) 70%, #fff); }
.g2.exp { color:color-mix(in srgb, var(--exp) 70%, #fff); }

.foot { display:grid; grid-auto-flow:column; grid-auto-columns:1fr; gap:8px; padding:1.6cqw 4.4cqw 4.4cqw; background:linear-gradient(var(--foot), var(--foot2)); }
.fi { all:unset; cursor:pointer; min-width:0; text-align:center; }
.fi:first-child { text-align:left; } .fi:last-child:not(:first-child) { text-align:right; }
.fl { font-size:clamp(11px, 3.2cqw, 16px); color:rgba(255,255,255,.62); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fv { font-size:clamp(17px, 6.4cqw, 34px); font-weight:600; letter-spacing:-.015em; white-space:nowrap; font-variant-numeric:tabular-nums; margin-top:.1em; }
.fv i { font-style:normal; font-size:.62em; font-weight:500; margin-left:.22em; opacity:.88; }
.loading .node .v, .loading .g2, .loading .fv { opacity:.45; transition:opacity .2s; }

svg .clouds path { fill:var(--cloud); opacity:var(--cloudA); }
svg .hill1 { fill:var(--hill1); } svg .hill2 { fill:var(--hill2); } svg .grnd { fill:var(--grnd); }
svg .t1 { fill:var(--tree1); } svg .t2 { fill:var(--tree2); }
svg .room { fill:var(--room); }
svg .spill, svg .lampglow { opacity:var(--light); }
svg .stars { opacity:var(--stars); }
svg .stars circle { fill:#fff; animation:tw 3.2s ease-in-out infinite; }
svg .moon { opacity:var(--moon); }
svg .sun { opacity:var(--sun); }
@keyframes tw { 50% { opacity:.25; } }
svg .fl-u { fill:none; stroke:rgba(0,0,0,.2); stroke-width:4.5; stroke-linecap:round; stroke-linejoin:round; }
svg .fl { fill:none; stroke:var(--c); stroke-width:2; stroke-linecap:round; stroke-linejoin:round; opacity:.32; transition:opacity .5s; }
svg .fl.on { opacity:.95; }
svg .dots { display:none; } svg .dots.on { display:inline; }
svg .dot .dg { fill:var(--c); opacity:.3; } svg .dot .dd { fill:var(--c); }
svg .ring .rb { fill:none; stroke:rgba(255,255,255,.22); stroke-width:3.2; }
svg .ring .rs, svg .ring .ri { fill:none; stroke-width:3.2; transition:stroke-dasharray .8s ease; }
svg .smoke { display:none; } svg .smoke.on { display:inline; }
svg .smoke circle { fill:#fff; opacity:0; transform-box:fill-box; transform-origin:center; animation:smoke 3.9s linear infinite; }
@keyframes smoke { 0% { transform:translate(0,0) scale(.5); opacity:0; } 20% { opacity:.45; } 100% { transform:translate(9px,-28px) scale(1.8); opacity:0; } }
@media (prefers-reduced-motion: reduce) { svg .dots, svg .smoke { display:none !important; } svg .stars circle { animation:none; } .node { transition:none; } }
`;

/* ---------------- House card editor ---------------- */
const HED = {
  en: {
    title: "Subtitle (e.g. Home)", show_navigation: "Show date navigation", periods: "Periods", sync_group: "Sync group",
    parts: "Show on the house", show_solar: "Solar", show_grid: "Grid (import/export)", show_gas: "Gas", show_water: "Water",
    show_home: "Home usage ring", show_live: "Live power next to labels", scene: "Sky", footer: "Bottom row (max 4)",
    sources: "Sources (sensors)", prices: "Prices", max_power: "Max power for animation speed (W)", invert_power: "Invert live grid power sign",
    auto: "Follow the sun", day: "Day", golden: "Golden hour", dusk: "Dusk", night: "Night",
  },
  nl: {
    title: "Subtitel (bijv. Thuis)", show_navigation: "Datumnavigatie tonen", periods: "Periodes", sync_group: "Sync-groep",
    parts: "Tonen op het huis", show_solar: "Zonnepanelen", show_grid: "Net (afname/teruglevering)", show_gas: "Gas", show_water: "Water",
    show_home: "Ring huisverbruik", show_live: "Live vermogen bij labels", scene: "Lucht", footer: "Onderste rij (max 4)",
    sources: "Bronnen (sensoren)", prices: "Prijzen", max_power: "Max. vermogen voor animatiesnelheid (W)", invert_power: "Teken live netvermogen omdraaien",
    auto: "Volg de zon", day: "Dag", golden: "Gouden uur", dusk: "Schemering", night: "Nacht",
  },
};

class EnergyHouseCardEditor extends EnergyDisplayCardEditor {
  _HL() { return HED[lang(this._hass)] || HED.en; }

  _schema() {
    const L = this._HL(), E = this._L(), s = t(this._hass), f = hs(this._hass).f;
    const root = this._rs; // re-use the sources/prices blocks of the tile card editor
    const sources = root.find((x) => x.name === "sources");
    const prices = root.find((x) => x.name === "prices");
    const footerOpts = ["import", "export", "net", "cost_total", "solar", "self_consumption", "usage_total", "self_sufficiency", "gas", "water"]
      .map((v) => ({ value: v, label: f[v] || s.m[v] }));
    return [
      { name: "title", selector: { text: {} } },
      { type: "grid", name: "", schema: [
        { name: "show_navigation", selector: { boolean: {} } },
        { name: "sync_group", selector: { text: {} } },
      ] },
      { name: "periods", selector: { select: { multiple: true, mode: "list", options: ["day", "week", "month"].map((v) => ({ value: v, label: E[v] })) } } },
      { type: "expandable", name: "", title: L.parts, icon: "mdi:home-lightning-bolt-outline", schema: [
        { type: "grid", name: "", schema: [
          { name: "show_solar", selector: { boolean: {} } },
          { name: "show_grid", selector: { boolean: {} } },
          { name: "show_gas", selector: { boolean: {} } },
          { name: "show_water", selector: { boolean: {} } },
          { name: "show_home", selector: { boolean: {} } },
          { name: "show_live", selector: { boolean: {} } },
        ] },
        { name: "scene", selector: { select: { mode: "dropdown", options: ["auto", "day", "golden", "dusk", "night"].map((v) => ({ value: v, label: L[v] })) } } },
        { name: "footer", selector: { select: { multiple: true, mode: "list", options: footerOpts } } },
        { type: "grid", name: "", schema: [
          { name: "max_power", selector: { number: { min: 500, max: 50000, step: 100, mode: "box" } } },
          { name: "invert_power", selector: { boolean: {} } },
        ] },
      ] },
      sources,
      prices,
    ];
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!customElements.get("ha-form")) { this.shadowRoot.innerHTML = `<div style="padding:8px">Loading…</div>`; return; }
    this._rendered = true;
    const c = this._config;
    const L = this._HL();
    if (this._rsLang !== lang(this._hass)) { this._rs = this._rootSchema(); this._hs = this._schema(); this._rsLang = lang(this._hass); }
    const src = { ...(c.sources || {}) };
    ["import", "export", "solar"].forEach((k) => { if (src[k] != null) src[k] = arr(src[k]); });
    let form = this.shadowRoot.querySelector("ha-form");
    if (!form) {
      this.shadowRoot.innerHTML = "";
      form = document.createElement("ha-form");
      form.computeLabel = (sch) => {
        if (this._inPrices(sch)) return this._priceLabel(sch);
        return L[sch.name] || this._L()[sch.name] || sch.name;
      };
      form.addEventListener("value-changed", (ev) => {
        const v = { ...ev.detail.value };
        const prices = { ...(v.prices || {}) };
        const currency = prices.currency; delete prices.currency;
        if (prices.fixed_daily != null && prices.fixed_daily !== "" && !isNaN(+prices.fixed_daily)) prices.fixed_daily = +prices.fixed_daily;
        const out = { ...v, prices };
        if (currency) out.currency = currency; else delete out.currency;
        // keep only non-default switches
        ["show_solar", "show_grid", "show_gas", "show_water", "show_home", "show_live", "show_navigation"].forEach((k) => { if (out[k] === true) delete out[k]; });
        if (out.scene === "auto") delete out.scene;
        if (out.invert_power === false) delete out.invert_power;
        if (out.sync_group === "default") delete out.sync_group;
        delete out.tiles;
        this._clean(out);
        if (!out.footer) out.footer = [];
        this._config = out;
        this._emitted = JSON.stringify(out);
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config: out }, bubbles: true, composed: true }));
      });
      this.shadowRoot.appendChild(form);
    }
    form.hass = this._hass;
    form.schema = this._hs;
    form.data = {
      show_navigation: true, sync_group: "default", periods: ["day"], scene: "auto",
      show_solar: true, show_grid: true, show_gas: true, show_water: true, show_home: true, show_live: true,
      footer: ["import", "cost_total", "export"],
      ...c, sources: src, prices: { ...(c.prices || {}), currency: c.currency },
    };
  }
}

customElements.get(TAG) || customElements.define(TAG, EnergyDisplayCard);
customElements.get(`${TAG}-editor`) || customElements.define(`${TAG}-editor`, EnergyDisplayCardEditor);
customElements.get(HOUSE_TAG) || customElements.define(HOUSE_TAG, EnergyHouseCard);
customElements.get(`${HOUSE_TAG}-editor`) || customElements.define(`${HOUSE_TAG}-editor`, EnergyHouseCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === TAG)) {
  window.customCards.push({
    type: TAG,
    name: "Energy Display",
    description: "HomeWizard Energy Display–style tiles for electricity, solar, gas, water and costs, with day/week/month navigation.",
    preview: true,
    documentationURL: "https://github.com/riaan/energy-display-card",
  });
}
if (!window.customCards.some((c) => c.type === HOUSE_TAG)) {
  window.customCards.push({
    type: HOUSE_TAG,
    name: "Energy House",
    description: "Illustrated house with a sky that follows the sun and animated energy flows for grid, solar, gas and water.",
    preview: true,
    documentationURL: "https://github.com/riaan/energy-display-card",
  });
}
console.info(`%c ENERGY-DISPLAY-CARD %c v${VERSION} `, "color:#fff;background:#8B6CFF;font-weight:700;border-radius:3px 0 0 3px", "color:#8B6CFF;background:#eee;border-radius:0 3px 3px 0");
