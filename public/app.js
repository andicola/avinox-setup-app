let rangeChartInstance = null;
let runtimeChartInstance = null;

/* ---- Personal calibration (Phase 2A) ----------------------------------- */
/* A real ride (.proto) is parsed locally and compared against the model:   */
/* actual motor energy vs the energy the community table would predict for  */
/* the same rider input. The ratio becomes a personal factor applied to the */
/* runtime/range estimates (factor > 1 → the user's bike draws more than    */
/* the table predicts → estimates shrink).                                  */

const CALIBRATION_KEY = 'avinox-calibration';
let lastCalcRes = null;   // last /api/calculate response (before/after comparison)
const FORM_KEY = 'avinox-form';

/* The tour invitation greets first visits only. Someone who already used the
   app has a saved form; it must be read here, before the first calculation
   saves the form of a first visit too. */
const WELCOME_KEY = 'avinox-welcome';
const RETURNING_VISITOR = (() => {
    try { return localStorage.getItem(FORM_KEY) !== null || localStorage.getItem(CALIBRATION_KEY) !== null; }
    catch (e) { return true; }
})();

function dismissWelcome() {
    try { localStorage.setItem(WELCOME_KEY, 'dismissed'); } catch (e) { /* shown again next time */ }
    const card = document.getElementById('welcomeCard');
    if (card) card.classList.add('hidden');
}

function initWelcomeCard() {
    const card = document.getElementById('welcomeCard');
    if (!card) return;
    let state;
    try { state = localStorage.getItem(WELCOME_KEY); } catch (e) { return; }
    if (state === 'dismissed') return;
    if (RETURNING_VISITOR) { dismissWelcome(); return; }
    /* On a phone the results column comes after the whole form: the card
       moves to the top of the form there, and back above the results on a
       wider screen. */
    const narrow = window.matchMedia('(max-width: 767px)');
    const place = () => {
        const host = document.querySelector(narrow.matches ? '#tabCalc .sidebar-body' : '#tabCalc .workspace-body');
        if (host && card.parentElement !== host) host.prepend(card);
    };
    place();
    narrow.addEventListener('change', place);
    card.classList.remove('hidden');
    document.getElementById('welcomeDismiss').addEventListener('click', dismissWelcome);
    document.getElementById('welcomeTour').addEventListener('click', dismissWelcome);
}

function initSidebarLinks() {
    document.querySelectorAll('[data-open-kb]').forEach((el) => {
        el.addEventListener('click', () => {
            document.getElementById('kbOpenBtn').click();
            /* An optional target takes the reader straight to the answer they
               came for, instead of leaving them at the top of the guide. */
            const target = el.getAttribute('data-kb-target');
            if (!target) return;
            const hit = document.querySelector(target);
            if (!hit) return;
            const details = hit.closest('details');
            if (details && !details.open) details.open = true;
            requestAnimationFrame(() => hit.scrollIntoView({ block: 'start', behavior: 'smooth' }));
        });
    });
}

function getCalibration() {
    try {
        const raw = localStorage.getItem(CALIBRATION_KEY);
        const c = raw ? JSON.parse(raw) : null;
        /* The gate is the physical measurement itself (motor Wh/km). The factor
           is only informative: it is measured against this app's own model, so
           it must not decide whether a calibration is usable. */
        return (c && c.whPerKm > 0 && c.whPerKm < PLAUSIBLE_WH_PER_KM_MAX) ? c : null;
    } catch (e) { return null; }
}

/* The stored calibration as the API reads it. Surface, steep share and
   efficiency are absent on a calibration stored before they existed: the
   server then uses its defaults. */
function calibrationPayload() {
    const cal = getCalibration();
    if (!cal || !(cal.whPerKm > 0) || !((cal.realKm || 0) > 1)) return null;
    const payload = {
        realWhPerKm: cal.whPerKm,
        realKm: Math.round(cal.realKm * 10) / 10,
        realHm: Math.round(cal.realHm || 0)
    };
    if (cal.efficiency) payload.realEfficiency = cal.efficiency;
    if (cal.surface) payload.realSurface = cal.surface;
    if (cal.surfaceMix) payload.realSurfaceMix = cal.surfaceMix;
    if (Number.isFinite(cal.steepSharePct)) payload.realSteepShare = cal.steepSharePct;
    if (cal.motorShare) payload.realMotorShare = cal.motorShare;
    return payload;
}

function setCalibration(cal) {
    try {
        if (cal) localStorage.setItem(CALIBRATION_KEY, JSON.stringify(cal));
        else localStorage.removeItem(CALIBRATION_KEY);
    } catch (e) { /* ignore */ }
    renderCalibrationState();
}

/* The client guards on the PHYSICAL measurement only (Wh/km). The factor it
   computes (actualWh / modelWh, this app's model at the rider's own targets) is
   a ratio near 1 and is shown, but the guard that matters is the one the server
   applies to the quantity it actually uses - see PLAUSIBLE_* in
   src/energy-model.ts. */
const { PLAUSIBLE_WH_PER_KM_MIN, PLAUSIBLE_WH_PER_KM_MAX } = AvinoxRideEnergy.constants;

function calibrationIsImplausible(cal) {
    if (!cal) return false;
    return Number.isFinite(cal.whPerKm) && cal.whPerKm < PLAUSIBLE_WH_PER_KM_MIN;
}

/* Which rides were left out of the calibration, and why (survives a refresh). */
const CAL_NOTES_KEY = 'avinox-calibration-notes';

function storeCalibrationNotes(notes) {
    try { localStorage.setItem(CAL_NOTES_KEY, JSON.stringify(notes)); } catch (e) { /* ignore */ }
}

function getCalibrationNotes() {
    try {
        const n = JSON.parse(localStorage.getItem(CAL_NOTES_KEY) || 'null');
        return (n && n.total) ? n : null;
    } catch (e) { return null; }
}

/**
 * Physical measurement of a single ride: ALL the motor energy over the whole
 * distance ridden, states the app does not model included — that energy came
 * out of the battery, so it belongs to the number that decides whether a ride
 * can feed the calibration. A ride where the motor really did nothing measures
 * almost nothing, and averaging it in would inflate every range.
 */
function rideMotorWhPerKm(ride) {
    const e = AvinoxRideEnergy.rideEnergy(ride.samples);
    if (e.samples < 10 || !(e.km > 0.5)) return null;
    return { whPerKm: e.motorWh / e.km, motorWh: e.motorWh, km: e.km };
}

/* The pack the rides were measured on is the one selected in the Tuner: the
   battery drop of the rides only converts to Wh through its capacity. */
function selectedBatteryWh() {
    const select = document.getElementById('battery');
    const option = select && select.selectedOptions[0];
    return option ? parseFloat(option.dataset.wh) || 0 : 0;
}

function selectedBatteryId() {
    return (document.getElementById('battery') || {}).value || '';
}

function ridesPackEfficiency(rides) {
    return AvinoxRideEnergy.packEfficiency(
        rides.map((r) => AvinoxRideEnergy.rideEnergy(r.samples)),
        selectedBatteryWh()
    );
}

/* GPS track of a ride, in the point format route-file.js uses. */
function rideTrackPoints(ride) {
    const points = [];
    ride.samples.forEach((s) => {
        if (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) {
            points.push({
                lat: s.latitude,
                lon: s.longitude,
                ele: Number.isFinite(s.altitude) ? s.altitude : null
            });
        }
    });
    return points;
}

/* Share of a ride in the steep and extreme bands (%), measured the same way
   as for a route: the personal factor compares like with like. */
function rideSteepSharePct(ride) {
    const points = rideTrackPoints(ride);
    if (points.length < 3 || typeof AvinoxRoute === 'undefined') return 0;
    const grades = AvinoxRoute.computeGradeStats(points);
    return grades.ok ? grades.climbSummary.steepShare : 0;
}

function selectedSurface() {
    return (document.getElementById('surface') || {}).value || 'mixed';
}

const SURFACE_VOICES = [
    { id: 'tarmac', label: 'Tarmac' },
    { id: 'compacted', label: 'Compacted gravel' },
    { id: 'hardpack', label: 'Packed dirt' },
    { id: 'mixed', label: 'Mixed stones and roots' },
    { id: 'rock', label: 'Rock and roots' },
    { id: 'mud', label: 'Mud or sand' }
];

const SURFACE_PRESETS = {
    road: { tarmac: 100 },
    gravel: { compacted: 100 },
    mixed: { compacted: 20, hardpack: 40, mixed: 40 },
    technical: { rock: 100 }
};

function surfaceMixZero() {
    const mix = {};
    SURFACE_VOICES.forEach((v) => { mix[v.id] = 0; });
    return mix;
}

function surfaceMixFromPreset(presetId) {
    const mix = surfaceMixZero();
    const preset = SURFACE_PRESETS[presetId];
    if (preset) Object.keys(preset).forEach((id) => { mix[id] = preset[id]; });
    return mix;
}

/* The mix in the form, as percentages. Without the inputs (markup from an
   older version) it falls back to the preset of the selected surface. */
function getSurfaceMix() {
    const mix = surfaceMixZero();
    let hasInputs = false;
    SURFACE_VOICES.forEach((v) => {
        const el = document.getElementById('mix-' + v.id);
        if (!el) return;
        hasInputs = true;
        const n = Number(el.value);
        mix[v.id] = Number.isFinite(n) && n > 0 ? Math.round(n * 10) / 10 : 0;
    });
    return hasInputs ? mix : surfaceMixFromPreset(selectedSurface());
}

function surfaceMixTotal(mix) {
    return SURFACE_VOICES.reduce((sum, v) => sum + (Number(mix[v.id]) || 0), 0);
}

function surfaceMixParts(mix) {
    return SURFACE_VOICES
        .map((v) => ({ id: v.id, label: v.label, pct: Number(mix[v.id]) || 0 }))
        .filter((v) => v.pct > 0)
        .sort((a, b) => b.pct - a.pct);
}

/* "40% packed dirt · 30% mixed stones and roots", only the voices above 0. */
function surfaceMixText(mix) {
    return surfaceMixParts(mix)
        .map((v) => Math.round(v.pct * 10) / 10 + '% ' + v.label.toLowerCase())
        .join(' · ');
}

function surfaceMixMatchesPreset(mix, preset) {
    return SURFACE_VOICES.every((v) => (Number(mix[v.id]) || 0) === (Number(preset[v.id]) || 0));
}

/* The line the collapsed route header shows. A preset still reads by name;
   a custom mix is named by its dominant voice, kept short. */
function surfaceMixHeadline() {
    const select = document.getElementById('surface');
    if (!select || select.selectedIndex < 0) return '';
    if (select.value === 'custom') {
        const top = surfaceMixParts(getSurfaceMix())[0];
        if (top) return 'Custom mix — ' + Math.round(top.pct) + '% ' + top.label.toLowerCase();
    }
    return select.options[select.selectedIndex].text;
}

function renderSurfaceMix() {
    const mix = getSurfaceMix();
    const total = surfaceMixTotal(mix);
    const summary = document.getElementById('surfaceMixSummary');
    if (summary) {
        const text = surfaceMixText(mix);
        summary.innerText = text
            ? text + (Math.abs(total - 100) > 0.5 ? ' — totals ' + Math.round(total * 10) / 10 + '%' : '')
            : '—';
    }
    const hint = document.getElementById('surfaceMixHint');
    if (hint) {
        if (total <= 0) {
            hint.classList.remove('hidden');
            hint.classList.add('energy-warn');
            hint.innerText = 'Every percentage is zero: the default mixed ground is used instead.';
        } else if (Math.abs(total - 100) > 0.5) {
            hint.classList.remove('hidden');
            hint.classList.add('energy-warn');
            hint.innerText = 'The percentages total ' + Math.round(total * 10) / 10
                + '%: the server normalises them to 100% before using them.';
        } else {
            hint.classList.add('hidden');
            hint.innerText = '';
        }
    }
}

function applySurfacePreset(presetId) {
    const select = document.getElementById('surface');
    if (select && SURFACE_PRESETS[presetId]) select.value = presetId;
    const mix = surfaceMixFromPreset(presetId);
    SURFACE_VOICES.forEach((v) => {
        const el = document.getElementById('mix-' + v.id);
        if (el) el.value = String(mix[v.id]);
    });
    renderSurfaceMix();
    if (typeof saveForm === 'function') saveForm();
    updateRouteLoadState();
}

/* Any edit to a percentage takes the selector out of its preset: unless the
   numbers still match it, the surface shown is Custom. */
function onSurfaceMixEdited() {
    const select = document.getElementById('surface');
    if (select && SURFACE_PRESETS[select.value]
        && !surfaceMixMatchesPreset(getSurfaceMix(), SURFACE_PRESETS[select.value])) {
        select.value = 'custom';
    }
    renderSurfaceMix();
    if (typeof saveForm === 'function') saveForm();
    updateRouteLoadState();
}

function initSurfaceMix() {
    const body = document.getElementById('surfaceMixBody');
    if (!body) return;
    body.innerHTML = SURFACE_VOICES.map((v) =>
        '<div class="kv-row" style="align-items:center">'
        + '<label class="kv-label" for="mix-' + v.id + '">' + v.label + '</label>'
        + '<span style="display:flex;align-items:center;gap:.4rem">'
        + '<input type="number" id="mix-' + v.id + '" class="input" min="0" max="100" step="1" inputmode="numeric" value="0"'
        + ' style="width:76px;min-height:30px;padding:.25rem .45rem;text-align:right" aria-label="' + v.label + ' percentage">'
        + '<span class="hint">%</span></span></div>').join('');
    body.addEventListener('input', onSurfaceMixEdited);
    body.addEventListener('change', onSurfaceMixEdited);

    const select = document.getElementById('surface');
    if (select) {
        select.addEventListener('change', () => {
            if (SURFACE_PRESETS[select.value]) applySurfacePreset(select.value);
            else { renderSurfaceMix(); updateRouteLoadState(); }
        });
    }

    const osmBtn = document.getElementById('surfaceOsmBtn');
    if (osmBtn) osmBtn.addEventListener('click', onSurfaceOsmClick);

    /* Where the mix comes from, in order of authority: what the user last
       chose (the saved form), then the ground a calibration was measured on,
       then the default preset. */
    let restored = null;
    try {
        const savedForm = JSON.parse(localStorage.getItem(FORM_KEY) || '{}');
        if (savedForm.surfaceMix && surfaceMixTotal(savedForm.surfaceMix) > 0) {
            restored = { mix: savedForm.surfaceMix, surfaceId: savedForm.surfaceId || null };
        }
    } catch (e) { /* ignore */ }
    if (!restored) {
        const saved = (typeof getCalibration === 'function') ? getCalibration() : null;
        if (saved && saved.surfaceMix && surfaceMixTotal(saved.surfaceMix) > 0) {
            restored = { mix: saved.surfaceMix, surfaceId: null };
        }
    }
    if (restored) {
        SURFACE_VOICES.forEach((v) => {
            const el = document.getElementById('mix-' + v.id);
            if (el) el.value = String(Number(restored.mix[v.id]) || 0);
        });
        const asPreset = Object.keys(SURFACE_PRESETS)
            .find((id) => surfaceMixMatchesPreset(getSurfaceMix(), SURFACE_PRESETS[id]));
        if (select) select.value = asPreset || (SURFACE_PRESETS[restored.surfaceId] ? restored.surfaceId : 'custom');
        renderSurfaceMix();
        updateRouteLoadState();
        return;
    }
    applySurfacePreset(select && SURFACE_PRESETS[select.value] ? select.value : 'mixed');
}

/* The OpenStreetMap reader, on an explicit click: it samples the loaded
   route and fills the six percentages from the ways along it. Only the
   sampled coordinates leave the device, for this one request — so it is a
   button, never an automatic step. */
let surfaceOsmBusy = false;

function setSurfaceOsmStatus(text, warn) {
    const el = document.getElementById('surfaceOsmStatus');
    if (!el) return;
    el.classList.toggle('energy-warn', !!warn);
    el.innerText = text || '';
}

/* The track the reader works on: the planned route if one is loaded,
   otherwise the selected ride's own GPS track. */
function surfaceOsmPoints() {
    if (Array.isArray(routePoints) && routePoints.length > 1) return routePoints;
    const ride = (typeof loadedRides !== 'undefined' && loadedRides[selectedRideIndex]) || null;
    if (ride) {
        const points = rideTrackPoints(ride);
        if (points.length > 1) return points;
    }
    return [];
}

function surfaceOsmButtonState() {
    const btn = document.getElementById('surfaceOsmBtn');
    if (!btn) return;
    btn.disabled = surfaceOsmBusy || surfaceOsmPoints().length < 2;
}

function onSurfaceOsmClick() {
    if (surfaceOsmBusy) return;
    if (typeof AvinoxOsm === 'undefined' || typeof AvinoxOsm.fetchSurfaceMix !== 'function') {
        setSurfaceOsmStatus('The OpenStreetMap reader is not available.', true);
        return;
    }
    const points = surfaceOsmPoints();
    if (points.length < 2) {
        setSurfaceOsmStatus('Load a route or a ride first.', true);
        return;
    }
    surfaceOsmBusy = true;
    surfaceOsmButtonState();
    setSurfaceOsmStatus('Reading OpenStreetMap…', false);
    AvinoxOsm.fetchSurfaceMix(points, { sampleM: 500 }).then((res) => {
        if (!res || !res.ok || !(res.tagged > 0)) {
            const reason = res && res.reason;
            setSurfaceOsmStatus(
                reason === 'timeout' ? 'OpenStreetMap did not answer in time — try again.'
                    : reason === 'empty' ? 'OpenStreetMap has no ways along this route.'
                        : reason ? 'OpenStreetMap could not be reached — try again later.'
                            : 'OpenStreetMap found no surface tags along this route — set the mix by hand.',
                true);
            return;
        }
        /* Whole numbers only — the inputs step by 1, and a decimal trips the
           browser's own validation and blocks Analyze. Nudge the largest
           voice so the fill lands exactly on the 100% the server uses. */
        const values = {};
        SURFACE_VOICES.forEach((v) => { values[v.id] = Math.round(Number(res.mix[v.id]) || 0); });
        const mixSum = SURFACE_VOICES.reduce((acc, v) => acc + values[v.id], 0);
        if (mixSum !== 100) {
            const top = SURFACE_VOICES.slice().sort((a, b) => values[b.id] - values[a.id])[0];
            values[top.id] = Math.max(0, Math.min(100, values[top.id] + (100 - mixSum)));
        }
        SURFACE_VOICES.forEach((v) => {
            const el = document.getElementById('mix-' + v.id);
            if (el) el.value = String(values[v.id]);
        });
        const select = document.getElementById('surface');
        const asPreset = Object.keys(SURFACE_PRESETS)
            .find((id) => surfaceMixMatchesPreset(getSurfaceMix(), SURFACE_PRESETS[id]));
        if (select) select.value = asPreset || 'custom';
        renderSurfaceMix();
        if (typeof saveForm === 'function') saveForm();
        updateRouteLoadState();
        /* Two honest numbers: how much of the route sits on a mapped way, and
           how much the map actually describes (has a surface tag). The mix
           covers the tagged part alone. */
        const matchedPct = Math.round(res.coverage * 1000) / 10;
        const taggedPct = Math.round((res.tagged / res.sampled) * 1000) / 10;
        setSurfaceOsmStatus('OpenStreetMap: ' + taggedPct + '% of the sampled points carry a surface tag'
            + ' (' + matchedPct + '% sit on a mapped way). The mix below covers the tagged ones'
            + (taggedPct >= 99.9 ? '.' : ' — the rest is not guessed.'), false);
    }).catch(() => {
        setSurfaceOsmStatus('OpenStreetMap could not be reached — try again later.', true);
    }).then(() => {
        surfaceOsmBusy = false;
        surfaceOsmButtonState();
    });
}

function efficiencyText(eff) {
    if (!eff) return '—';
    const pct = Math.round(eff.efficiency * 100) + '%';
    if (eff.measured) return pct + ' (measured on a ' + Math.round(eff.dropPct) + '% battery drop)';
    const why = {
        'battery-drop-too-small': 'battery drop too small to read',
        'out-of-range': 'measured ' + (eff.value != null ? Math.round(eff.value * 100) + '%' : '?')
            + ', not plausible: range extender or another pack?',
        'no-battery-capacity': 'no battery selected'
    }[eff.reason] || 'not measurable';
    return pct + ' (default: ' + why + ')';
}

/** Why a ride cannot feed the calibration, or null when it can. */
function rideMeasurementProblem(ride) {
    const m = rideMotorWhPerKm(ride);
    if (!m) return { reason: 'no usable distance', whPerKm: null };
    if (m.whPerKm < PLAUSIBLE_WH_PER_KM_MIN) {
        return { reason: 'the motor barely ran', whPerKm: Math.round(m.whPerKm * 10) / 10 };
    }
    if (m.whPerKm > PLAUSIBLE_WH_PER_KM_MAX) {
        return { reason: 'reading out of range', whPerKm: Math.round(m.whPerKm * 10) / 10 };
    }
    return null;
}

/** The line the calibration card adds when rides were left out. */
function calibrationExclusionHtml() {
    const notes = getCalibrationNotes();
    if (!notes || !notes.excluded || !notes.excluded.length) return '';
    const list = notes.excluded.map((x) =>
        (x.whPerKm != null ? x.whPerKm + ' Wh/km' : 'no distance') + ' — ' + x.reason).join('; ');
    return notes.used
        ? '<strong>' + notes.excluded.length + ' of ' + notes.total + ' rides</strong> stay out of this calibration ('
            + list + '): a ride the motor barely ran on measures almost nothing, and letting it in would inflate every '
            + 'range. The other ' + notes.used + ' set it.'
        : '<strong>No loaded ride carries a usable measurement</strong> (' + list
            + '), so the estimates come from the generic model.';
}

/* ---- Loaded files on this device (IndexedDB) ---------------------------- */
/* The calibration is a measurement and survives a refresh; the files it was
   measured FROM used to vanish with it, which made the two look
   inconsistent. The raw bytes of the loaded recordings and of the loaded
   route file are now kept locally (IndexedDB, never uploaded) and re-parsed
   on the next visit, so a refresh no longer throws away what the user just
   loaded. Clear all data removes them too. */

const IDB_NAME = 'avinox';
const IDB_STORE = 'files';
const IDB_VERSION = 1;

function idbAvailable() {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
}

function idbOpen() {
    return new Promise((resolve, reject) => {
        if (!idbAvailable()) { reject(new Error('no-indexeddb')); return; }
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbWrite(records) {
    /* One transaction for the whole batch: a restore must not be half-applied. */
    return idbOpen().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        records.forEach((r) => store.put(r));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    })).catch(() => { /* storage unavailable: the session still works */ });
}

function idbReadAll() {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).getAll();
        req.onsuccess = () => { db.close(); resolve(req.result || []); };
        req.onerror = () => { db.close(); reject(req.error); };
    })).catch(() => []);
}

function idbRemove(ids) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        ids.forEach((id) => store.delete(id));
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    })).catch(() => { /* ignore */ });
}

function idbClearAll() {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
    })).catch(() => { /* ignore */ });
}

/* A stored file: the raw bytes, so the parser stays the single source of
   truth and an import from another device cannot smuggle in stale numbers. */
function storeFile(kind, name, bytes, type) {
    const id = kind === 'route' ? 'route' : 'ride:' + name;
    return idbWrite([{ id: id, kind: kind, name: name, type: type || '', bytes: bytes, savedAt: Date.now() }]);
}

function storeSelectedRide(index) {
    return idbWrite([{ id: 'state', kind: 'state', selectedIndex: index, savedAt: Date.now() }]);
}

async function storedRides() {
    const all = await idbReadAll();
    return all.filter((r) => r.kind === 'ride').sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
}

/* Bring back what the user had loaded, through the same load path (so there
   is one parser, one analysis, one renderer) but quietly: no notice, no
   "rides analyzed" dialog - the page should simply be as they left it. */
async function restoreStoredFiles() {
    if (!idbAvailable()) return;
    let all = [];
    try { all = await idbReadAll(); } catch (e) { return; }
    if (!all.length) return;
    const route = all.find((r) => r.kind === 'route');
    const rides = all.filter((r) => r.kind === 'ride').sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
    const state = all.find((r) => r.kind === 'state');

    try {
        if (route && route.bytes) {
            setFileStatus('Restoring the route you had loaded…', 'info');
            await handleRouteFile(new File([route.bytes], route.name, { type: route.type || '' }), { restore: true });
            setFileStatus('Restored ' + route.name + ' from this device.', 'ok');
            return;
        }
        if (rides.length) {
            setFileStatus('Restoring your rides…', 'info');
            const files = rides.map((r) => new File([r.bytes], r.name, { type: r.type || '' }));
            await handleProtoFiles(files, {
                restore: true,
                selectedIndex: state && typeof state.selectedIndex === 'number' ? state.selectedIndex : undefined
            });
            setFileStatus('Restored ' + loadedRides.length + ' ride(s) from this device.', 'ok');
        }
    } catch (e) { /* a corrupt record must not break the page */ }
}

/* ---- Export / import the stored data ------------------------------------ */
/* The export is a single JSON file: the raw bytes of everything stored on
   this device (base64) plus the calibration. It is the backup / move-to-
   another-browser path, and it is local: nothing leaves the machine. */

function bytesToBase64(bytes) {
    const arr = new Uint8Array(bytes);
    let out = '';
    const chunk = 0x8000;   // avoid blowing the argument limit on big files
    for (let i = 0; i < arr.length; i += chunk) {
        out += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
    }
    return btoa(out);
}

function base64ToBytes(b64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
}

function showToast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.innerText = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5200);
}

async function exportData() {
    const all = await idbReadAll();
    const files = all.filter((r) => r.kind === 'ride' || r.kind === 'route');
    const cal = getCalibration();
    if (!files.length && !cal) {
        showToast('Nothing stored yet: load a route or a ride first.');
        return;
    }
    const state = all.find((r) => r.kind === 'state');
    const payload = {
        app: 'avinox-calc',
        version: 1,
        exportedAt: new Date().toISOString(),
        calibration: cal || null,
        state: state && typeof state.selectedIndex === 'number' ? state.selectedIndex : 0,
        files: files.map((r) => ({
            kind: r.kind,
            name: r.name,
            type: r.type || '',
            savedAt: r.savedAt || 0,
            base64: bytesToBase64(r.bytes)
        }))
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'avinox-data-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Exported ' + files.length + ' file(s)' + (cal ? ' and the calibration' : '') + '.');
}

async function importData(file) {
    let payload;
    try {
        payload = JSON.parse(await file.text());
    } catch (e) {
        showToast('That file is not readable JSON.');
        return;
    }
    if (!payload || payload.app !== 'avinox-calc' || !Array.isArray(payload.files)) {
        showToast('That is not an Avinox Calc export.');
        return;
    }
    const count = payload.files.length;
    if (!window.confirm('Import ' + count + ' file(s) from this export? It replaces what is stored on this device and reloads the app.')) return;
    try {
        await idbClearAll();
        const records = payload.files.map((f) => ({
            id: f.kind === 'route' ? 'route' : 'ride:' + f.name,
            kind: f.kind,
            name: f.name,
            type: f.type || '',
            bytes: base64ToBytes(f.base64).buffer,
            savedAt: f.savedAt || Date.now()
        }));
        if (typeof payload.state === 'number') {
            records.push({ id: 'state', kind: 'state', selectedIndex: payload.state, savedAt: Date.now() });
        }
        if (payload.calibration && payload.calibration.whPerKm > 0) {
            try { localStorage.setItem(CALIBRATION_KEY, JSON.stringify(payload.calibration)); } catch (e) { /* ignore */ }
        }
        await idbWrite(records);
        showToast('Imported ' + count + ' file(s): reloading…');
        setTimeout(() => location.reload(), 800);
    } catch (e) {
        showToast('Import failed.');
    }
}

function initDataTransfer() {
    const exp = document.getElementById('exportDataBtn');
    if (exp) exp.addEventListener('click', exportData);
    const imp = document.getElementById('importDataBtn');
    const input = document.getElementById('importDataInput');
    if (imp && input) {
        imp.addEventListener('click', () => input.click());
        input.addEventListener('change', () => {
            const f = input.files && input.files[0];
            if (f) importData(f);
            input.value = '';
        });
    }
}

function renderCalibrationState() {
    const badge = document.getElementById('calibrationBadge');
    if (!badge) return;
    const cal = getCalibration();
    const note = document.getElementById('calibrationNote');
    const tunerState = document.getElementById('tunerCalibrationState');
    const summary = document.getElementById('calibrationSummary');
    const emptyMsg = document.getElementById('calibrationEmpty');
    const insights = document.getElementById('rideInsights');
    const ridesCal = document.getElementById('ridesCalibration');

    const hasRides = loadedRides.length > 0;
    if (insights) insights.classList.toggle('hidden', !hasRides);
    if (ridesCal) ridesCal.classList.toggle('hidden', !(hasRides || !!cal));
    /* A calibration can outlive the rides it was measured on (it is stored
       on the device). When it does, the card stays on screen, without the
       step number, and says where the factor comes from. */
    if (ridesCal) {
        const standalone = !hasRides && !!cal;
        ridesCal.classList.toggle('standalone', standalone);
        const titleText = document.getElementById('calibrationTitleText');
        if (titleText) titleText.innerText = standalone ? 'Saved calibration' : 'Calibration';
        const standaloneNote = document.getElementById('calibrationStandaloneNote');
        if (standaloneNote) standaloneNote.classList.toggle('hidden', !standalone);
    }

    if (cal) {
        const implausible = calibrationIsImplausible(cal);
        badge.classList.remove('hidden');
        badge.innerText = cal.whPerKm ? cal.whPerKm + ' Wh/km' : 'calibrated';
        if (implausible) {
            badge.className = 'badge badge-warn';
        } else {
            badge.className = 'badge badge-ok';
        }
        /* The Tuner's own invitation disappears as soon as there is a factor. */
        const cta = document.getElementById('tunerCalibrationCta');
        if (cta) cta.classList.add('hidden');
        const calState = document.getElementById('calibrationState');
        if (calState) {
            const count = loadedRides.length;
            calState.innerText = implausible
                ? 'measurement not applied'
                : (cal.whPerKm ? cal.whPerKm + ' Wh/km · ' : '')
                    + (count === 0 ? 'saved' : (count === 1 ? 'this ride' : 'average of ' + count + ' rides'));
        }
        /* Out of the sane window: say it, in the card and in the Tuner. */
        const anomaly = document.getElementById('calibrationAnomaly');
        if (anomaly) {
            if (implausible) {
                anomaly.classList.remove('hidden');
                anomaly.innerHTML = 'This measurement looks anomalous (<strong>' + (cal.whPerKm ?? '?')
                    + ' Wh/km</strong>): the model and the bike disagree by a large multiple, which is a data problem '
                    + 'rather than a riding style. It is <strong>not applied</strong> — the route estimate comes from '
                    + 'the generic model. Removing it or loading a normal ride fixes it.';
            } else {
                anomaly.classList.add('hidden');
                anomaly.innerHTML = '';
            }
            /* Rides left out of the calibration are named too: the number must
               never be silently built on a subset of what is loaded. */
            const extra = calibrationExclusionHtml();
            if (extra) {
                anomaly.classList.remove('hidden');
                anomaly.innerHTML = (anomaly.innerHTML ? anomaly.innerHTML + ' ' : '') + extra;
            }
        }

        if (tunerState) {
            /* Say what the factor covers: the Tuner's number is the average
               over the loaded rides (or the stored one), while a single
               recording has its own - they legitimately differ. When the
               measurement is out of the sane window it is not applied, and
               the Tuner has to say that instead of claiming to be calibrated. */
            if (implausible) {
                tunerState.innerText = 'measurement not applied · ' + (cal.whPerKm ?? '?') + ' Wh/km';
                tunerState.className = 'kv-value status-warn';
            } else {
                const km = cal.rideLabel ? String(cal.rideLabel).replace(/^\d+ ride\(s\) · /, '') : '';
                const count = loadedRides.length;
                let scope;
                if (count === 0) scope = 'saved · ' + (cal.rideLabel || '');
                else if (count === 1) scope = 'this ride · ' + km;
                else scope = 'average of ' + count + ' rides · ' + km;
                tunerState.innerText = (cal.whPerKm ? cal.whPerKm + ' Wh/km · ' : '') + scope;
                tunerState.className = 'kv-value status-ok';
            }
        }
        if (summary) summary.classList.remove('hidden');
        if (emptyMsg) emptyMsg.classList.add('hidden');
        const factorEl = document.getElementById('calibrationFactor');
        const sourceEl = document.getElementById('calibrationSource');
        if (factorEl) factorEl.innerText = cal.whPerKm ? cal.whPerKm + ' Wh/km' : '—';
        if (sourceEl) sourceEl.innerText = cal.rideLabel;
        if (note) {
            note.classList.remove('hidden');
            note.innerText = implausible
                ? 'The measurement on these rides is out of the plausible range, so it is NOT applied.'
                : 'Your measured consumption: ' + (cal.whPerKm ?? '?') + ' Wh/km of motor energy over the whole ride, '
                    + 'taken from the battery at ' + Math.round((cal.efficiency || 0.8) * 100) + '% efficiency'
                    + (cal.efficiencyMeasured ? ' (measured on the battery drop). ' : ' (default). ')
                    + 'The Route plan and the Tuner\'s range charts both scale their estimates with it.';
        }
        const resetBtn = document.getElementById('calibrationReset');
        if (resetBtn && !resetBtn.dataset.wired) {
            resetBtn.dataset.wired = '1';
            resetBtn.addEventListener('click', () => {
                setCalibration(null);
                updateSetup(); // back to the model-based estimates
                /* The visible analysis was scaled by that factor: recompute
                   it, or the energy card would keep quoting a calibration
                   that no longer exists. */
                if (routeStats || loadedRides.length) {
                    document.getElementById('missionForm')
                        .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
                }
            });
        }
    } else {
        badge.classList.add('hidden');
        if (tunerState) {
            tunerState.innerText = 'not calibrated';
            tunerState.className = 'kv-value';
        }
        /* No factor at all: invite the user to the Route loader. */
        const cta = document.getElementById('tunerCalibrationCta');
        if (cta) cta.classList.remove('hidden');
        const calState = document.getElementById('calibrationState');
        if (calState) calState.innerText = '';
        if (summary) summary.classList.add('hidden');
        if (emptyMsg) emptyMsg.classList.remove('hidden');
        if (note) note.classList.add('hidden');
        /* No calibration, but rides may have been left out: say it here too,
           or the only feedback would be the missing numbers. */
        const anomalyEmpty = document.getElementById('calibrationAnomaly');
        const extraEmpty = calibrationExclusionHtml();
        if (anomalyEmpty) {
            anomalyEmpty.classList.toggle('hidden', !extraEmpty);
            anomalyEmpty.innerHTML = extraEmpty;
        }
    }
}

/* ---- Route map (MapLibre): coloured track + cursor-synced marker ---- */

let rideMap = null;
let rideMapPoints = [];       // downsampled route points (with lat/lon)

const MAP_CHANNELS = {
    speed: { label: 'km/h', get: (s) => s.speed, ramp: ['#276bc1', '#e06432'], step: 0 },
    /* Categorical, not a ramp: a recording carries an assist value per
       sample, a number that is not the mode's name (see describeAssistValues). */
    assist: { label: '', get: (s) => s.assist, categorical: true },
    altitude: { label: 'm', get: (s) => s.altitude, ramp: ['#665d50', '#c9b18a'], step: 0 },
    gradient: { label: '%', get: (s) => s.gradient, ramp: ['#2b6cb0', '#c0392b'], step: 0, symmetric: true },
    riderPower: { label: 'W', get: (s) => s.riderPower, ramp: ['#f0c060', '#c0392b'], step: 0 },
    motorPower: { label: 'W', get: (s) => s.motorPower, ramp: ['#c9b6e8', '#5c4290'], step: 0 },
    cadence: { label: 'rpm', get: (s) => s.cadence, ramp: ['#9fd8c8', '#16a078'], step: 0 },
    gear: { label: '', get: (s) => s.gear, ramp: ['#cfd8d3', '#2d6655'], step: 0 },
    battery: { label: '%', get: (s) => s.battery, ramp: ['#e4462d', '#68a52f'], step: 0 },
    heartRate: { label: 'bpm', get: (s) => s.heartRate, ramp: ['#f2b3bd', '#ce3a4e'], step: 0 }
};

/* How many points the ride map draws. The planned-route map draws every point
   of the file, and the two must feel the same: with a low cap a 20 km ride was
   drawn from ~600 points, so the track looked faceted and the cursor jumped
   between them. 3000 points is roughly one per screen pixel for a whole-route
   view, and rebuilding the data (every channel change) still takes ~15 ms. */
const RIDE_MAP_MAX_POINTS = 3000;

/* A segment is only drawn when the position data supports it: two fixes
   further apart than this (in time, or farther than GAP_M whatever the clock
   says) leave the path in between unknown. Drawing a straight line across it
   invents a route the bike never took - one real recording lost GPS for 14
   minutes and came back 2.6 km away. */
const RIDE_GAP_DT_S = 20;
const RIDE_GAP_M = 400;
let rideMapGaps = [];       // [{ km, m, dt }]

/* The ride map, same lesson as the planned-route one: a feature per segment
   means thousands of sub-pixel dashes and a dotted track. The channel is
   continuous, so consecutive segments are grouped by their colour step (24
   steps across the ramp - invisible to the eye) and each run becomes one long
   polyline. Gaps keep their own features and their own layer. */
const RIDE_MAP_COLOUR_STEPS = 24;

function buildRouteGeoJSON(samples, channelId) {
    const ch = MAP_CHANNELS[channelId] || MAP_CHANNELS.speed;
    const step = Math.max(1, Math.floor(samples.length / RIDE_MAP_MAX_POINTS));
    const pts = [];
    for (let i = 0; i < samples.length; i += step) {
        const s = samples[i];
        if (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) pts.push(s);
    }
    rideMapPoints = pts;

    const values = pts.map((s) => ch.get(s)).filter((v) => Number.isFinite(v));
    let lo = values.length ? Math.min(...values) : 0;
    let hi = values.length ? Math.max(...values) : 1;
    if (ch.symmetric) {
        const m = Math.max(Math.abs(lo), Math.abs(hi), 1);
        lo = -m; hi = m;
    }
    if (hi - lo < 1e-6) hi = lo + 1;

    const bucketOf = (v) => Math.max(0, Math.min(RIDE_MAP_COLOUR_STEPS,
        Math.round(((v - lo) / (hi - lo)) * RIDE_MAP_COLOUR_STEPS)));

    /* Smoothed series, and a tolerance of one colour step: on a map the colour
       should read the level, not every sample's noise, and long runs are what
       keeps the line continuous at any zoom (a feature shorter than a pixel is
       drawn as a dash). */
    const raw = pts.map((s) => ch.get(s));
    /* A category must not be smoothed: averaging ECO next to TURBO would invent
       an AUTO stretch that was never ridden. Exact values group exactly. */
    const smooth = ch.categorical ? raw.slice() : raw.map((_, i) => {
        let sum = 0, n = 0;
        for (let j = Math.max(0, i - 2); j <= Math.min(raw.length - 1, i + 2); j++) {
            if (Number.isFinite(raw[j])) { sum += raw[j]; n++; }
        }
        return n ? sum / n : null;
    });
    const tolerance = ch.categorical ? 0 : (hi - lo) / RIDE_MAP_COLOUR_STEPS;

    const features = [];
    rideMapGaps = [];
    let run = null;
    const flush = () => {
        if (run && run.coords.length > 1) {
            features.push({
                type: 'Feature',
                /* gap marks an unknown stretch (drawn dashed, own layer). */
                properties: { v: run.v, gap: run.gap ? 1 : 0 },
                geometry: { type: 'LineString', coordinates: run.coords }
            });
        }
        run = null;
    };

    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const vb = Number.isFinite(smooth[i]) ? smooth[i] : raw[i];
        const va = Number.isFinite(smooth[i - 1]) ? smooth[i - 1] : raw[i - 1];
        const v = Number.isFinite(vb) ? vb : va;
        if (!Number.isFinite(v)) { flush(); continue; }
        /* Break the track where the position data cannot support a segment. */
        const dt = (b.timestamp && a.timestamp) ? Math.abs(b.timestamp - a.timestamp) : 0;
        const segM = AvinoxRoute.haversine({ lat: a.latitude, lon: a.longitude }, { lat: b.latitude, lon: b.longitude });
        const isGap = dt > RIDE_GAP_DT_S || segM > RIDE_GAP_M;
        if (isGap) rideMapGaps.push({ km: Number.isFinite(b.distanceKm) ? b.distanceKm : 0, m: segM, dt: dt });
        /* Extend the run while the level stays within one colour step. */
        const sameRun = run && !isGap && !run.gap && Math.abs(v - run.v) <= tolerance;
        if (!sameRun) {
            flush();
            run = { bucket: isGap ? 'gap' : bucketOf(v), v: v, gap: isGap, coords: [[a.longitude, a.latitude]] };
        }
        run.coords.push([b.longitude, b.latitude]);
    }
    flush();

    return { geojson: { type: 'FeatureCollection', features }, lo, hi, ch };
}

function buildRideMap(ride) {
    const el = document.getElementById('rideMap');
    if (!el || typeof maplibregl === 'undefined' || !ride) return;
    const channelId = document.getElementById('mapChannel').value;
    const { geojson, lo, hi, ch } = buildRouteGeoJSON(ride.samples, channelId);
    if (!rideMapPoints.length) return;

    /* Gradient uses the same six bands as the planned-route map; the assist
       mode is a category with its own named colours; the other channels keep a
       continuous ramp, which is the right tool for a smooth quantity. */
    const isGradient = channelId === 'gradient';
    const colorExpr = ch.categorical
        ? rideModeColorExpression()
        : (isGradient
            ? gradeColorExpression()
            : ['interpolate', ['linear'], ['get', 'v'], lo, ch.ramp[0], hi, ch.ramp[1]]);

    /* Legend: the band swatches for the gradient, the assist values the ride
       carries for that channel, the min/max ramp otherwise. */
    const legend = document.getElementById('mapLegend');
    if (legend) {
        legend.innerHTML = isGradient
            ? gradeLegendHtml()
            : (ch.categorical
                ? rideModeLegendHtml(rideMapPoints)
                : '<span class="legend-swatch" style="background:linear-gradient(90deg,' + ch.ramp[0] + ',' + ch.ramp[1] + ')"></span>'
                    + '<span>' + Math.round(lo) + ' – ' + Math.round(hi) + ' ' + (ch.label || '') + '</span>');
    }

    /* Say out loud why part of the track is dashed. */
    const gapsEl = document.getElementById('rideMapGaps');
    if (gapsEl) {
        if (rideMapGaps.length) {
            const totalKm = rideMapGaps.reduce((a, g) => a + g.m, 0) / 1000;
            gapsEl.classList.remove('hidden');
            gapsEl.innerText = rideMapGaps.length + (rideMapGaps.length === 1 ? ' gap' : ' gaps')
                + ' in the GPS fixes (' + totalKm.toFixed(1) + ' km) — drawn dashed: the recording has no position there,'
                + ' so the bike\'s real path in between is unknown.';
        } else {
            gapsEl.classList.add('hidden');
            gapsEl.innerText = '';
        }
    }

    if (!rideMap) {
        rideMap = new maplibregl.Map({
            container: el,
            style: osmRasterStyle(),
            center: [rideMapPoints[0].longitude, rideMapPoints[0].latitude],
            zoom: 12,
            attributionControl: { compact: true }
        });
        rideMap.on('load', () => {
            rideMap.addSource('route', { type: 'geojson', data: geojson });
            /* Stretches with no position data: dashed and muted, so the ride
               keeps its shape without claiming a path it never recorded. */
            rideMap.addLayer({
                id: 'route-gaps',
                type: 'line',
                source: 'route',
                filter: ['==', ['get', 'gap'], 1],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: {
                    'line-width': 2,
                    'line-color': cssVar('--muted'),
                    'line-dasharray': [1.5, 2]
                }
            });
            rideMap.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                filter: ['!=', ['get', 'gap'], 1],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-width': 4, 'line-color': colorExpr }
            });
            rideMap.addSource('cursor', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
            rideMap.addLayer({
                id: 'cursor-dot',
                type: 'circle',
                source: 'cursor',
                paint: {
                    'circle-radius': 7,
                    'circle-color': '#5AF822',
                    'circle-stroke-color': '#1E252D',
                    'circle-stroke-width': 2
                }
            });
            rideMap.addSource('start', { type: 'geojson', data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [rideMapPoints[0].longitude, rideMapPoints[0].latitude] } }] } });
            rideMap.addLayer({ id: 'start-dot', type: 'circle', source: 'start', paint: { 'circle-radius': 5, 'circle-color': '#2F7D0E', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
            /* Reverse sync: hovering the route moves the cursor on the graphs. */
            rideMap.on('mousemove', (e) => {
                const hits = rideMap.queryRenderedFeatures(e.point, { layers: ['route-line'] });
                if (!hits.length) { setRideCursor(null, 0); return; }
                if (cursorRaf) return;
                const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
                cursorRaf = requestAnimationFrame(() => {
                    cursorRaf = null;
                    cursorFromMapPosition(lngLat);
                });
            });
            rideMap.on('mouseout', () => setRideCursor(null, 0));
            fitRouteBounds();
        });
    } else {
        rideMap.getSource('route').setData(geojson);
        rideMap.setPaintProperty('route-line', 'line-color', colorExpr);
        rideMap.setPaintProperty('route-gaps', 'line-color', cssVar('--muted'));
        rideMap.getSource('start').setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [rideMapPoints[0].longitude, rideMapPoints[0].latitude] } }] });
        fitRouteBounds();
    }
}

function fitRouteBounds() {
    if (!rideMap || !rideMapPoints.length) return;
    const el = document.getElementById('rideMap');
    if (!el || el.offsetHeight === 0) { rideMapNeedsFit = true; return; }
    const bounds = new maplibregl.LngLatBounds();
    rideMapPoints.forEach((p) => bounds.extend([p.longitude, p.latitude]));
    rideMap.fitBounds(bounds, { padding: 30, duration: 0 });
    rideMapNeedsFit = false;
}

/* Marker follows the hovered time position on the graphs. */
function updateMapCursor(idx, total) {
    if (!rideMap || !rideMapPoints.length || typeof maplibregl === 'undefined') return;
    const src = rideMap.getSource('cursor');
    if (!src) return;
    if (idx == null || !total) {
        src.setData({ type: 'FeatureCollection', features: [] });
        return;
    }
    const p = rideMapPoints[Math.min(rideMapPoints.length - 1, Math.round((idx / Math.max(1, total - 1)) * (rideMapPoints.length - 1)))];
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] } }] });
}

/* ---- Route Map (planned track, coloured by gradient) ------------------ */
/* A recording has sensors, so its map can be coloured by any channel; a
   planned GPX/KML has only position and elevation, so the informative
   colouring is the gradient - measured with the SAME 25 m window as the
   grade bars, so the map and the bars can never disagree. */

let routeMap = null;
let routePoints = [];      // merged points of the loaded route file
/* The map was built (or fitted) while its body was collapsed: it needs a
   real fit once the container has a height. Same for the ride map. */
let routeMapNeedsFit = false;
let rideMapNeedsFit = false;
let routeHoverRaf = null;
/* Own numbers of the recording being analysed ({whPerKm, km, hm}), or null
   when the analysis is a planned route or a hand-typed one. */
let selectedRideMetrics = null;
/* What the last analysis was scaled by: 'ride' or 'calibration'. */
let lastFactorSource = null;

const GRADE_COLOR_VAR = {
    descent: '--mode-auto', flat: '--mode-eco', rolling: '--accent-hover',
    climb: '--mode-trail', steep: '--mode-turbo', extreme: '--mode-custom'
};

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
}

function gradeBandColor(key) {
    return cssVar(GRADE_COLOR_VAR[key] || '--muted');
}

/* ---- The six grade bands, shared by BOTH maps -------------------------- */
/* The planned-route map and the ride map (when it is coloured by gradient)
   must show climbs and descents the same way: same bands, same colours, same
   legend. Otherwise the same hill looks different depending on which file the
   user loaded. */
function gradeColorExpression() {
    return ['step', ['get', 'v'],
        gradeBandColor('descent'),
        -2, gradeBandColor('flat'),
        3, gradeBandColor('rolling'),
        7, gradeBandColor('climb'),
        12, gradeBandColor('steep'),
        18, gradeBandColor('extreme')];
}

function gradeLegendHtml() {
    return AvinoxRoute.gradeBands.map((b) => '<span><span class="band-swatch" style="background:'
        + gradeBandColor(b.key) + '"></span>' + b.label + '</span>').join('');
}

/* The assist mode is a category: its colours are the ones the charts already use
   for the modes, and anything the app does not model gets the neutral grey. */
function cssVarOr(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

/* The assist value is a category the file numbers, not a mode name: each value
   gets its own colour and the legend names the number, never a mode. */
const ASSIST_COLORS = {
    1: '#1F7A8C', 2: '#C98A00', 3: '#B03A2E', 4: '#6C5B9E', 5: '#3C7A3F',
    20: '#8A6D3B', 21: '#5B7C99', 23: '#8C4A6B'
};

function rideModeColor(v) {
    return ASSIST_COLORS[v] || cssVarOr('--mode-other', '#4A4440');
}

function rideModeColorExpression() {
    const expr = ['match', ['get', 'v']];
    Object.keys(ASSIST_COLORS).forEach((k) => { expr.push(Number(k), ASSIST_COLORS[k]); });
    expr.push(rideModeColor(0));
    return expr;
}

function rideModeLegendHtml(points) {
    const present = [...new Set((points || []).map((s) => s.assist).filter((v) => v != null))]
        .sort((a, b) => a - b);
    return present.map((v) => {
        const name = AvinoxRideEnergy.assistName(v);
        const label = name === 'custom' ? 'custom ' + v : (name ? name + ' (' + v + ')' : 'assist ' + v);
        return '<span><span class="band-swatch" style="background:' + rideModeColor(v) + '"></span>' + label + '</span>';
    }).join('');
}

/* The OSM raster style, shared by both maps. */
function osmRasterStyle() {
    return {
        version: 8,
        sources: {
            osm: {
                type: 'raster',
                tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                tileSize: 256,
                attribution: '© OpenStreetMap contributors'
            }
        },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
    };
}

function pointsFeature(p) {
    return {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }]
    };
}

function emptyFeature() {
    return { type: 'FeatureCollection', features: [] };
}

/* One feature per run of consecutive segments in the SAME grade band. With one
   feature per segment a real Komoot route produced 9457 features of ~3 m each:
   at 12.8 m per pixel that is a quarter of a pixel, MapLibre draws every one of
   them as a tiny dash with a round cap, and the track looks dotted - reported
   as "the track is practically invisible on the map". Grouping keeps the colour
   identical (a run is one band by construction), makes the line continuous and
   cuts the feature count by ~50x. */
function buildGradeSegments(profile) {
    const features = [];
    const pts = profile.points;
    let run = null;
    const flush = () => {
        if (run && run.coords.length > 1) {
            features.push({
                type: 'Feature',
                properties: { v: run.v },
                geometry: { type: 'LineString', coordinates: run.coords }
            });
        }
        run = null;
    };
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (a.segmentId !== b.segmentId) { flush(); continue; }
        const grade = Number.isFinite(b.grade) ? b.grade : (Number.isFinite(a.grade) ? a.grade : 0);
        const band = AvinoxRoute.bandForGrade(grade);
        if (!run || run.band !== band) {
            flush();
            run = { band: band, v: grade, coords: [[a.lon, a.lat]] };
        }
        run.coords.push([b.lon, b.lat]);
    }
    flush();
    return { type: 'FeatureCollection', features };
}

/* The pointer's position -> the nearest point on the route (km), used by the
   hover readout and the cursor: with grouped features there is no per-segment
   index to read any more, and this is more accurate anyway (it answers for the
   place the pointer is, not for the segment it happened to hit). */
function nearestRouteCursorKm(lngLat) {
    if (!routeCursorPoints.length) return null;
    const cosLat = Math.cos(lngLat.lat * Math.PI / 180);
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < routeCursorPoints.length; i++) {
        const p = routeCursorPoints[i];
        const dx = (p.lon - lngLat.lng) * cosLat;
        const dy = p.lat - lngLat.lat;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = p; }
    }
    return best ? best.km : null;
}

function clearRouteHover() {
    setRouteCursor(null);
}

function routeMapHover(e) {
    if (!routeMap) return;
    /* A 4 px line is hard to hit: the cursor reads an invisible wide line
       drawn over it, so hovering is forgiving (and works on touch). */
    const layers = routeMap.getLayer('route-hit') ? ['route-hit', 'route-line'] : ['route-line'];
    const hits = routeMap.queryRenderedFeatures(e.point, { layers: layers });
    if (!hits.length) { clearRouteHover(); return; }
    if (routeHoverRaf) return;
    const lngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
    routeHoverRaf = requestAnimationFrame(() => {
        routeHoverRaf = null;
        const km = nearestRouteCursorKm(lngLat);
        if (km == null) { clearRouteHover(); return; }
        setRouteCursor(km);
    });
}

function fitRouteMapBounds() {
    if (!routeMap || routePoints.length < 2) return;
    /* Fitting a container with no height gives a nonsense zoom (the body can
       still be collapsed at this point): remember to fit when it opens. */
    const el = document.getElementById('routeMap');
    if (!el || el.offsetHeight === 0) { routeMapNeedsFit = true; return; }
    const bounds = new maplibregl.LngLatBounds();
    routePoints.forEach((p) => bounds.extend([p.lon, p.lat]));
    routeMap.fitBounds(bounds, { padding: 30, duration: 0 });
    routeMapNeedsFit = false;
}

/* Draw (or redraw) the planned route on its map. Only called for route
   files: a recording has its own map with the channel selector.
   `refit` re-frames the view: only when the ROUTE changed, not when the same
   route is re-analysed (a Tuner tweak must not throw away a pan/zoom). */
function renderRouteMap(points, opts) {
    const refit = !!(opts && opts.refit);
    const panel = document.getElementById('routeMapPanel');
    const el = document.getElementById('routeMap');
    if (!panel || !el || typeof maplibregl === 'undefined' || typeof AvinoxRoute === 'undefined') return;
    if (!points || points.length < 3 || !AvinoxRoute.computeGradeProfile) {
        panel.classList.add('hidden');
        return;
    }

    const profile = AvinoxRoute.computeGradeProfile(points);
    if (!profile.ok) {
        /* No usable elevation: no honest colouring, so no map card. */
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');

    routeCursorPoints = buildRouteCursorIndex(profile);

    const mapState = document.getElementById('routeMapState');
    if (mapState) {
        mapState.innerText = (profile.distanceM / 1000).toFixed(1) + ' km · coloured by gradient';
    }

    const bands = AvinoxRoute.gradeBands;
    const colorExpr = gradeColorExpression();

    const data = buildGradeSegments(profile);
    const first = profile.points[0];
    const last = profile.points[profile.points.length - 1];
    const ends = {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: { c: gradeBandColor('flat') }, geometry: { type: 'Point', coordinates: [first.lon, first.lat] } },
            { type: 'Feature', properties: { c: cssVar('--mode-turbo') }, geometry: { type: 'Point', coordinates: [last.lon, last.lat] } }
        ]
    };

    const legend = document.getElementById('routeMapLegend');
    if (legend) legend.innerHTML = gradeLegendHtml();
    const winEl = document.getElementById('routeMapWindow');
    if (winEl) winEl.innerText = String(profile.windowM);

    if (!routeMap) {
        routeMap = new maplibregl.Map({
            container: el,
            style: osmRasterStyle(),
            center: [first.lon, first.lat],
            zoom: 12,
            attributionControl: { compact: true }
        });
        routeMap.on('load', () => {
            routeMap.addSource('route', { type: 'geojson', data: data });
            routeMap.addLayer({
                id: 'route-line',
                type: 'line',
                source: 'route',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-width': 4, 'line-color': colorExpr }
            });
            /* Invisible, wider twin: only for a forgiving hover target. */
            routeMap.addLayer({
                id: 'route-hit',
                type: 'line',
                source: 'route',
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-width': 18, 'line-color': '#000000', 'line-opacity': 0 }
            });
            routeMap.addSource('ends', { type: 'geojson', data: ends });
            routeMap.addLayer({
                id: 'route-ends',
                type: 'circle',
                source: 'ends',
                paint: {
                    'circle-radius': 5,
                    'circle-color': ['get', 'c'],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2
                }
            });
            routeMap.addSource('route-cursor', { type: 'geojson', data: emptyFeature() });
            routeMap.addLayer({
                id: 'route-cursor',
                type: 'circle',
                source: 'route-cursor',
                paint: {
                    'circle-radius': 7,
                    'circle-color': '#5AF822',
                    'circle-stroke-color': '#1E252D',
                    'circle-stroke-width': 2
                }
            });
            routeMap.on('mousemove', routeMapHover);
            routeMap.on('mouseout', clearRouteHover);
            fitRouteMapBounds();
        });
    } else {
        const src = routeMap.getSource('route');
        if (src) src.setData(data);
        if (routeMap.getLayer('route-line')) routeMap.setPaintProperty('route-line', 'line-color', colorExpr);
        const endsSrc = routeMap.getSource('ends');
        if (endsSrc) endsSrc.setData(ends);
        const cursorSrc = routeMap.getSource('route-cursor');
        if (cursorSrc) cursorSrc.setData(emptyFeature());
        if (refit) fitRouteMapBounds();
    }

    /* A new track means the old cursor position is meaningless. */
    setRouteCursor(null);
}

function destroyRouteMap() {
    if (routeMap) { routeMap.remove(); routeMap = null; }
    routeCursorPoints = [];
    setRouteCursor(null);
    const panel = document.getElementById('routeMapPanel');
    if (panel) panel.classList.add('hidden');
    const legend = document.getElementById('routeMapLegend');
    if (legend) legend.innerHTML = '';
    const readout = document.getElementById('routeMapReadout');
    if (readout) readout.innerText = '';
}

/* ---- Route cursor: elevation profile <-> map -------------------------- */
/* The two directions share ONE cursor, keyed by distance along the route:
   the chart plots one point per elevation sample while the map is drawn
   from the merged track, so an index would not mean the same thing on both
   sides. Distance always does. */

let routeCursorKm = null;
let routeCursorPoints = [];   // [{km, lat, lon, ele, grade}] sorted by km

function buildRouteCursorIndex(profile) {
    const out = [];
    profile.points.forEach((p, i) => {
        /* Points without a cumulative distance (no usable elevation there)
           are not on the track as far as the cursor is concerned. */
        if (i > 0 && !(p.distanceM > 0)) return;
        out.push({ km: p.distanceM / 1000, lat: p.lat, lon: p.lon, ele: p.ele, grade: p.grade });
    });
    return out;
}

function nearestRouteCursorPoint(km) {
    if (!routeCursorPoints.length) return null;
    let lo = 0;
    let hi = routeCursorPoints.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (routeCursorPoints[mid].km < km) lo = mid + 1; else hi = mid;
    }
    const a = routeCursorPoints[Math.max(0, lo - 1)];
    const b = routeCursorPoints[lo];
    if (!a) return b;
    if (!b) return a;
    return Math.abs(b.km - km) < Math.abs(a.km - km) ? b : a;
}

/* Dashed vertical line on the elevation chart, at a distance (km). The ride
   graphs use a category axis; this chart has a linear km axis, so the pixel
   has to come from the scale. */
function drawElevationCursor(km) {
    const chart = elevationChartInstance;
    if (!chart || !chart.scales || !chart.scales.x) return;
    const ov = ensureCursorOverlay(chart);
    if (!ov) return;
    const ctx = ov.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (km == null) return;
    const area = chart.chartArea;
    if (!area) return;
    const px = chart.scales.x.getPixelForValue(km);
    if (!Number.isFinite(px) || px < area.left - 1 || px > area.right + 1) return;
    const x = (px - area.left) * dpr;
    ctx.beginPath();
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.lineWidth = dpr;
    ctx.strokeStyle = cssVar('--muted');
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ov.height);
    ctx.stroke();
}

/* The single cursor: chart line, map dot and readout always agree. */
function setRouteCursor(km) {
    routeCursorKm = (typeof km === 'number' && Number.isFinite(km)) ? km : null;
    const p = routeCursorKm == null ? null : nearestRouteCursorPoint(routeCursorKm);
    drawElevationCursor(routeCursorKm);

    const src = routeMap && routeMap.getSource ? routeMap.getSource('route-cursor') : null;
    if (src) {
        src.setData(p
            ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }] }
            : emptyFeature());
    }
    const readout = document.getElementById('routeMapReadout');
    if (readout) {
        readout.innerText = p
            ? (Number.isFinite(p.km) ? 'km ' + p.km.toFixed(1) + ' · ' : '')
              + (Number.isFinite(p.ele) ? Math.round(p.ele) + ' m · ' : '')
              + (Number.isFinite(p.grade) ? (p.grade >= 0 ? '+' : '') + p.grade.toFixed(1) + '%' : '')
            : '';
    }
}

/* Chart -> map. The handler reads the live chart instance (the chart is
   recreated on every file load, the canvas is not) and wires once. */
/* A recording has no elevation profile of its own: the data lives in the
   "Elevation & Gradient" graph. Hide the panel and drop the chart, so nothing
   stale is left behind when switching between a route file and a ride. */
function hideElevationProfile() {
    if (elevationChartInstance) { elevationChartInstance.destroy(); elevationChartInstance = null; }
    const panel = document.getElementById('elevationPanel');
    if (panel) panel.classList.add('hidden');
    const state = document.getElementById('elevationState');
    if (state) state.innerText = '';
}

/* ---- Elevation profile cursor (planned routes only) ------------------- */
/* For a route file the profile is the only elevation view, so hovering it
   moves the cursor on the route map (and the other way round). A recording
   has the graphs instead - see hideElevationProfile(). */

function wireElevationCursor(chart) {
    const canvas = chart && chart.canvas;
    if (!canvas || canvas.dataset.cursorWired === '1') return;
    canvas.dataset.cursorWired = '1';
    canvas.addEventListener('mousemove', (e) => {
        const c = elevationChartInstance;
        if (!c || !c.scales || !c.scales.x || !routeCursorPoints.length) return;
        const area = c.chartArea;
        if (!area || e.offsetX < area.left || e.offsetX > area.right) return;
        const km = c.scales.x.getValueForPixel(e.offsetX);
        if (!Number.isFinite(km)) return;
        setRouteCursor(km);
    });
    canvas.addEventListener('mouseleave', () => setRouteCursor(null));
}

/* ---- Ride Insights (Phase 2A): ARE-style graph groups ----------------- */
/* The 8 graph groups replicate the Avinox Ride Explorer layout 1:1
   (series, dual axes, colours) using the channels extracted by our
   parser. Stacked, cursor-synchronized, drag-to-zoom (double-click
   resets), drag titles to reorder, click legend values to toggle. */

let loadedRides = [];          // [{ metadata, samples, label }]
let rideCharts = [];           // active Chart instances (stacked)
let modalChart = null;
let selectedRideIndex = 0;
let graphOrder = null;         // persisted group order

/* Fast cursor: a dashed vertical line drawn on a dedicated overlay
   canvas per graph (no chart re-render) + the map marker. Hovering the
   map drives the same cursor on the graphs. */
let cursorRaf = null;

function ensureCursorOverlay(chart) {
    const areaEl = chart.canvas.parentElement; // .chart-area
    if (!areaEl) return null;
    let ov = areaEl.querySelector(".cursor-overlay");
    if (!ov) {
        ov = document.createElement("canvas");
        ov.className = "cursor-overlay";
        areaEl.appendChild(ov);
    }
    const area = chart.chartArea;
    if (!area) return ov;
    ov.style.left = area.left + "px";
    ov.style.top = area.top + "px";
    ov.style.width = (area.right - area.left) + "px";
    ov.style.height = (area.bottom - area.top) + "px";
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round((area.right - area.left) * dpr));
    const h = Math.max(1, Math.round((area.bottom - area.top) * dpr));
    if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
    return ov;
}

function drawCursorOverlay(chart, idx) {
    const ov = ensureCursorOverlay(chart);
    if (!ov) return;
    const ctx = ov.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (idx == null) return;
    const area = chart.chartArea;
    if (!area) return;
    const labels = chart.data.labels.length;
    if (labels < 2) return;
    const x = ((idx / (labels - 1)) * (area.right - area.left)) * dpr;
    ctx.beginPath();
    ctx.setLineDash([4 * dpr, 3 * dpr]);
    ctx.lineWidth = dpr;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, ov.height);
    ctx.stroke();
}

/* Central cursor: draws the line on every graph and moves the map marker. */
function setRideCursor(idx, totalLabels) {
    rideCursorIndex = idx;
    rideCharts.forEach((c) => {
        c.canvas.dataset.cursorIndex = idx == null ? "" : String(idx);
        drawCursorOverlay(c, idx);
    });
    updateMapCursor(idx, totalLabels);
}

/* Reverse direction: a point on the route maps back to the graph index. */
/* Reverse direction: a point on the map maps back to the graph index. With
   grouped features there is no per-segment index to read, so the nearest map
   point to the pointer is used - which is also the honest answer. */
function cursorFromMapPosition(lngLat) {
    if (!rideMapPoints.length) return;
    const cosLat = Math.cos(lngLat.lat * Math.PI / 180);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < rideMapPoints.length; i++) {
        const p = rideMapPoints[i];
        const dx = (p.longitude - lngLat.lng) * cosLat;
        const dy = p.latitude - lngLat.lat;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
    }
    cursorFromMapPoint(best);
}

function cursorFromMapPoint(mapIdx) {
    const charts = rideCharts.filter((c) => c.data.labels && c.data.labels.length > 1);
    if (!charts.length || !rideMapPoints.length) return;
    const total = charts[0].data.labels.length;
    const graphIdx = Math.round((mapIdx / Math.max(1, rideMapPoints.length - 1)) * (total - 1));
    setRideCursor(graphIdx, total);
}

function wireCursorSync(chart) {
    const canvas = chart.canvas;
    canvas.addEventListener("mousemove", (e) => {
        const area = chart.chartArea;
        if (!area) return;
        const x = e.offsetX;
        if (x < area.left || x > area.right) return;
        const idx = Math.round(((x - area.left) / (area.right - area.left)) * (chart.data.labels.length - 1));
        if (cursorRaf) return;
        cursorRaf = requestAnimationFrame(() => {
            cursorRaf = null;
            setRideCursor(idx, chart.data.labels.length);
        });
    });
    canvas.addEventListener("mouseleave", () => {
        setRideCursor(null, 0);
    });
}

function rideTheme() {
    const s = getComputedStyle(document.documentElement);
    const t = (n) => s.getPropertyValue(n).trim();
    return {
        grid: t("--surface-3"), tick: t("--muted"), faint: t("--faint"),
        surface: t("--surface"), accent: t("--accent"),
        eco: t("--mode-eco"), auto: t("--mode-auto"), trail: t("--mode-trail"),
        turbo: t("--mode-turbo"), custom: t("--mode-custom"),
        accentFill: "rgba(39, 106, 11, 0.14)"
    };
}

function downsampleRide(samples, buckets) {
    const size = Math.max(1, Math.ceil(samples.length / buckets));
    const out = [];
    for (let i = 0; i < samples.length; i += size) {
        const chunk = samples.slice(i, i + size);
        /* Only the samples that carry the channel: a missing altitude or
           temperature is null, and averaging it as 0 would drag the line down. */
        const mean = (fn) => {
            const values = chunk.map(fn).filter(Number.isFinite);
            return values.length ? values.reduce((a, v) => a + v, 0) / values.length : null;
        };
        const max = (fn) => Math.max(...chunk.map((s) => fn(s) || 0));
        out.push({
            minute: Math.round((chunk[0].timestamp - samples[0].timestamp) / 60),
            speed: mean((s) => s.speed),
            cadence: mean((s) => s.cadence),
            battery: mean((s) => s.battery),
            assist: chunk.at(-1).assist,
            riderMean: mean((s) => s.riderPower),
            motorMean: mean((s) => s.motorPower),
            motorMax: max((s) => s.motorPower),
            totalPowerMean: mean((s) => s.totalPower),
            motorTorqueMean: mean((s) => s.motorTorque),
            riderTorqueMean: mean((s) => s.riderTorque),
            totalTorqueMean: mean((s) => s.totalTorque),
            altitude: mean((s) => s.altitude),
            gradientMean: mean((s) => s.gradient),
            gearMean: mean((s) => s.gear),
            heartMean: mean((s) => s.heartRate),
            temperature: mean((s) => s.temperature),
            pressure: mean((s) => s.pressure),
            distanceKm: chunk.at(-1).distanceKm,
            /* riderEnergyKj is a CUMULATIVE counter computed by the bike
               firmware (monotonic, ends at the total ARE displays). The
               graph shows the counter itself; the ride total is the last
               value - NOT the sum of all samples. */
            riderEnergyKj: chunk.at(-1).riderEnergyKj,
            imuX: mean((s) => s.imuX),
            imuY: mean((s) => s.imuY),
            imuZ: mean((s) => s.imuZ)
        });
    }
    return out;
}

function areaDataset(label, data, color, extra) {
    /* Translucent fill (15%): full-opacity areas hide the other series
       stacked in the same graph. */
    return Object.assign({
        label, data,
        borderColor: color,
        backgroundColor: color + "26",
        fill: true,
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: true
    }, extra || {});
}

function lineDataset(label, data, color, extra) {
    return Object.assign({
        label, data,
        borderColor: color,
        backgroundColor: "transparent",
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.2,
        spanGaps: true,
        fill: false
    }, extra || {});
}

/* The 8 ARE graph groups (series, axes and colours replicated 1:1)
   plus our own energy-by-level bar chart at the end. */
function rideGraphSpecs(b) {
    const g = (fn) => b.map((x) => {
        const v = fn(x);
        return v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10;
    });
    return [
        {
            id: "elevation", title: "Elevation & Gradient (m / %)", right: true, height: 150,
            datasets: [
                areaDataset("Altitude", g((x) => x.altitude), "#665d50"),
                lineDataset("Gradient", g((x) => x.gradientMean), "#e26435", { yAxisID: "y1" })
            ]
        },
        {
            id: "speed", title: "Speed & Cadence (km/h / rpm)", right: true, height: 150,
            datasets: [
                areaDataset("Speed", g((x) => x.speed), "#276bc1"),
                lineDataset("Cadence", g((x) => x.cadence), "#16a078", { yAxisID: "y1" })
            ]
        },
        {
            id: "power", title: "Power (W)", height: 170,
            datasets: [
                areaDataset("Rider", g((x) => x.riderMean), "#e06432"),
                areaDataset("Motor", g((x) => x.motorMean), "#7353b6"),
                lineDataset("Total", g((x) => x.totalPowerMean), "#192f27")
            ]
        },
        {
            id: "torque", title: "Torque (Nm)", height: 150,
            datasets: [
                areaDataset("Rider", g((x) => x.riderTorqueMean), "#d99a26"),
                areaDataset("Motor", g((x) => x.motorTorqueMean), "#3d83bd"),
                lineDataset("Total", g((x) => x.totalTorqueMean), "#313e38")
            ]
        },
        {
            id: "gear", title: "Gear, Heart & Assist", right: true, height: 150,
            datasets: [
                lineDataset("Gear", g((x) => x.gearMean), "#2d6655"),
                lineDataset("Assist", g((x) => x.assist), "#8f6ab8"),
                lineDataset("Heart rate", g((x) => x.heartMean), "#ce3a4e", { yAxisID: "y1" })
            ]
        },
        {
            id: "environment", title: "Battery & Environment (% / °C / kPa)", right: true, height: 150,
            datasets: [
                areaDataset("Battery", g((x) => x.battery), "#68a52f"),
                lineDataset("Temperature", g((x) => x.temperature), "#e57632"),
                lineDataset("Pressure", g((x) => x.pressure), "#697a96", { yAxisID: "y1" })
            ]
        },
        {
            id: "distance", title: "Distance & Energy (km / kJ)", right: true, height: 150,
            datasets: [
                areaDataset("Distance", g((x) => x.distanceKm), "#316c96"),
                lineDataset("Rider energy", g((x) => x.riderEnergyKj), "#dc8231", { yAxisID: "y1" })
            ]
        },
        {
            id: "imu", title: "Raw IMU channels", height: 130,
            datasets: [
                lineDataset("IMU X", g((x) => x.imuX), "#d45151"),
                lineDataset("IMU Y", g((x) => x.imuY), "#3d8a6c"),
                lineDataset("IMU Z", g((x) => x.imuZ), "#476bb1")
            ]
        },
        {
            id: "energy", title: "Energy by Assist Level (Wh)", bar: true, height: 180,
            analysis: true,
            datasets: []
        }
    ];
}

function rideChartOptions(height, group) {
    const T = rideTheme();
    const scales = {
        x: { grid: { display: false }, ticks: { color: T.tick, maxTicksLimit: 10, callback: (v) => v + "m", font: { size: 9 } } },
        y: { position: "left", grid: { color: T.grid }, ticks: { color: T.tick, font: { size: 9 } } }
    };
    if (group && group.right) {
        scales.y1 = { position: "right", grid: { display: false }, ticks: { color: T.tick, font: { size: 9 } } };
    }
    return {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        normalized: true,
        interaction: { mode: "index", intersect: false },
        plugins: {
            legend: { display: true, position: "top", labels: { color: T.tick, boxWidth: 12, font: { size: 10 } } },
            tooltip: { callbacks: { title: (items) => "min " + items[0].label } },
            zoom: {
                syncGroups: ["avinox-ride"],
                pan: { enabled: true, mode: "x", modifierKey: "shift" },
                zoom: { drag: { enabled: true }, mode: "x" },
                limits: { x: { min: "original", max: "original" } }
            }
        },
        scales
    };
}

function buildRideGraphs(ride, analysis) {
    const container = document.getElementById("rideGraphs");
    if (!container) return;
    container.innerHTML = "";
    rideCharts = [];

    const buckets = downsampleRide(ride.samples, 200);
    const labels = buckets.map((b) => b.minute);
    const order = getGraphOrder();
    const specs = rideGraphSpecs(buckets);
    specs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    const T = rideTheme();

    for (const spec of specs) {
        const card = document.createElement("div");
        card.className = "chart-card ride-graph";
        card.draggable = true;
        card.dataset.graphId = spec.id;

        const head = document.createElement("div");
        head.className = "ride-graph-head";
        const title = document.createElement("h3");
        title.className = "chart-title";
        title.style.textAlign = "left";
        title.textContent = spec.title;
        head.appendChild(title);
        const actions = document.createElement("div");
        actions.className = "ride-graph-actions";
        /* Pin: the pinned graph sticks to the top while scrolling. */
        const pin = document.createElement("button");
        pin.type = "button";
        pin.className = "mini-btn pin-btn";
        pin.setAttribute("aria-label", "Pin " + spec.title);
        pin.title = "Pin to top";
        pin.textContent = "📌";
        pin.addEventListener("click", () => togglePin(spec.id, card));
        actions.appendChild(pin);
        if (!spec.bar) {
            const expand = document.createElement("button");
            expand.type = "button";
            expand.className = "mini-btn";
            expand.setAttribute("aria-label", "Enlarge " + spec.title);
            expand.title = "Enlarge";
            expand.textContent = "⤢";
            expand.addEventListener("click", () => openChartModal(spec.title, spec, labels, buckets));
            actions.appendChild(expand);
        }
        head.appendChild(actions);
        if (getPinned().includes(spec.id)) card.classList.add("pinned");
        card.appendChild(head);
        const areaEl = document.createElement("div");
        areaEl.className = "chart-area ride-graph-area";
        areaEl.style.height = spec.height + "px";
        const canvas = document.createElement("canvas");
        canvas.id = "graph-" + spec.id;
        areaEl.appendChild(canvas);
        card.appendChild(areaEl);
        container.appendChild(card);

        let cfg;
        if (spec.bar) {
            /* Our own energy-by-level chart (needs the analysis). */
            const levels = analysis ? analysis.levels : [];
            cfg = {
                type: "bar",
                data: {
                    labels: levels.map((l) => "L" + l.level),
                    datasets: [{ label: "Motor energy (Wh)", data: levels.map((l) => Math.round(l.motorWh)), backgroundColor: [T.eco, T.auto, T.trail, T.turbo, T.custom], borderRadius: 4 }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { grid: { display: false }, ticks: { color: T.tick, font: { size: 10, weight: "bold" } } },
                        y: { grid: { color: T.grid }, ticks: { color: T.tick, font: { size: 9 } } }
                    }
                }
            };
        } else {
            cfg = {
                type: "line",
                data: { labels, datasets: spec.datasets },
                options: rideChartOptions(spec.height, spec),
                plugins: []
            };
        }
        const chart = new Chart(canvas.getContext("2d"), cfg);
        if (!spec.bar) {
            chart.canvas.addEventListener("dblclick", () => chart.resetZoom());
        }
        chart.update("none");
        wireCursorSync(chart);
        applyPinOffsets();
        rideCharts.push(chart);
    }

    /* Drag titles to reorder (persisted). */
    let dragId = null;
    container.querySelectorAll(".ride-graph").forEach((card) => {
        card.addEventListener("dragstart", () => { dragId = card.dataset.graphId; });
        card.addEventListener("dragover", (e) => e.preventDefault());
        card.addEventListener("drop", (e) => {
            e.preventDefault();
            const targetId = card.dataset.graphId;
            if (!dragId || dragId === targetId) return;
            const order = getGraphOrder();
            const from = order.indexOf(dragId), to = order.indexOf(targetId);
            order.splice(to, 0, order.splice(from, 1)[0]);
            setGraphOrder(order);
            rebuildRideGraphs();
        });
    });
}

/* Pinned graphs: stick to the top of the viewport while scrolling.
   Multiple pins stack: each gets an offset based on how many pinned
   graphs precede it in the DOM. */
function getPinned() {
    try {
        const saved = JSON.parse(localStorage.getItem("avinox-pinned-graphs") || "[]");
        return Array.isArray(saved) ? saved : [];
    } catch (e) { return []; }
}

function applyPinOffsets() {
    const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 62;
    let stack = headerH;
    document.querySelectorAll("#rideGraphs .ride-graph.pinned").forEach((card) => {
        /* Fixed layer: keep a placeholder so the flow does not collapse. */
        if (!card.dataset.placeholderH) card.dataset.placeholderH = String(card.offsetHeight);
        card.style.top = stack + "px";
        stack += card.offsetHeight + 8;
    });
}

/* Near the page bottom the sticky pins would be pushed up by the footer
   and overlap each other. The stack is clamped: when the remaining page
   below the viewport is shorter than the stack, the whole stack shifts
   up so the last pin never crosses the container bottom. */
function updatePinStack() {
    const pinned = Array.from(document.querySelectorAll("#rideGraphs .ride-graph.pinned"));
    if (!pinned.length) return;
    const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h")) || 62;
    const container = document.getElementById("rideGraphs");
    if (!container) return;
    const cRect = container.getBoundingClientRect();
    /* Space available in the viewport for the stack: from the header to
       the container's bottom edge (the pins must stay inside their
       container while it is on screen). */
    const avail = Math.max(0, Math.min(window.innerHeight, cRect.bottom) - headerH);
    const totalNeeded = pinned.reduce((a, c) => a + c.offsetHeight + 8, -8);
    let stack = headerH;
    if (totalNeeded > avail) {
        /* Compress: shift the stack up so the last pin ends at the
           container bottom. */
        stack = headerH - (totalNeeded - avail);
    }
    pinned.forEach((card) => {
        card.style.top = Math.max(0, stack) + "px";
        stack += card.offsetHeight + 8;
    });
}

function togglePin(graphId, card) {
    const pinned = getPinned();
    const i = pinned.indexOf(graphId);
    if (i >= 0) {
        pinned.splice(i, 1);
    } else {
        /* One pinned graph only: a single chart is what stays readable while
           scrolling, and past that the pins start to overlap each other. */
        if (pinned.length >= 1) {
            const card2 = document.querySelector('#rideGraphs .ride-graph.pinned');
            if (card2) {
                card2.classList.remove('pinned');
                card2.style.top = '';
            }
            pinned.shift();
        }
        pinned.push(graphId);
    }
    try { localStorage.setItem("avinox-pinned-graphs", JSON.stringify(pinned)); } catch (e) { /* ignore */ }
    card.classList.toggle("pinned", pinned.includes(graphId));
    applyPinOffsets();
}

function getGraphOrder() {
    if (graphOrder) return graphOrder;
    try {
        const saved = JSON.parse(localStorage.getItem("avinox-graph-order") || "null");
        if (Array.isArray(saved)) { graphOrder = saved; return graphOrder; }
    } catch (e) { /* ignore */ }
    graphOrder = ["elevation", "speed", "power", "torque", "gear", "environment", "distance", "imu", "energy"];
    return graphOrder;
}

function setGraphOrder(order) {
    graphOrder = order;
    try { localStorage.setItem("avinox-graph-order", JSON.stringify(order)); } catch (e) { /* ignore */ }
}

function rebuildRideGraphs() {
    if (!loadedRides.length) return;
    buildRideGraphs(loadedRides[Math.min(selectedRideIndex, loadedRides.length - 1)], lastRideAnalysis);
}

function renderRideInsights() {
    const wrap = document.getElementById("rideInsights");
    if (!wrap) return;
    const ridesCal = document.getElementById("ridesCalibration");
    const selector = document.getElementById("rideSelector");
    const pickerRow = document.getElementById("ridePickerRow");
    if (!ridesCal || !selector) return;

    const hasRides = loadedRides.length > 0;
    const hasCal = !!getCalibration();
    wrap.classList.toggle("hidden", !hasRides);
    ridesCal.classList.toggle("hidden", !(hasRides || hasCal));
    const standalone = !hasRides && hasCal;
    ridesCal.classList.toggle("standalone", standalone);
    const titleText = document.getElementById("calibrationTitleText");
    if (titleText) titleText.innerText = standalone ? "Saved calibration" : "Calibration";
    const standaloneNote = document.getElementById("calibrationStandaloneNote");
    if (standaloneNote) standaloneNote.classList.toggle("hidden", !standalone);
    if (pickerRow) pickerRow.classList.toggle("hidden", !hasRides);


    selector.innerHTML = "";
    loadedRides.forEach((r, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        const km = r.samples.length ? (r.samples.at(-1).distanceKm || 0).toFixed(1) : "?";
        const d = r.metadata.start ? new Date(r.metadata.start * 1000).toLocaleDateString() : "";
        opt.textContent = (d ? d + " - " : "") + km + " km - " + r.metadata.samples + " samples";
        selector.appendChild(opt);
    });
    if (selectedRideIndex >= loadedRides.length) selectedRideIndex = loadedRides.length - 1;
    if (selectedRideIndex < 0) selectedRideIndex = 0;
    selector.value = String(selectedRideIndex);

    if (hasRides) buildRideGraphs(loadedRides[selectedRideIndex], lastRideAnalysis);
    if (hasRides) buildRideMap(loadedRides[selectedRideIndex]);

    /* The collapsed header has to say what is behind it. */
    const graphsWrap = document.getElementById("rideGraphsWrap");
    const graphCount = graphsWrap ? graphsWrap.querySelectorAll("#rideGraphs .ride-graph").length : 0;
    const label = document.getElementById("graphsToggleLabel");
    if (label) label.innerText = graphCount ? "Sensor graphs (" + graphCount + ")" : "Sensor graphs";
    const state = document.getElementById("rideDataState");
    if (state) {
        const r = loadedRides[selectedRideIndex];
        state.innerText = (hasRides && r)
            ? [graphCount ? graphCount + " graphs" : "", r.label].filter(Boolean).join(" · ")
            : "";
    }
    updateRouteLoadState();
}

function openChartModal(title, spec, labels, buckets) {
    const dlg = document.getElementById("chartModal");
    const canvas = document.getElementById("chartModalCanvas");
    const titleEl = document.getElementById("chartModalTitle");
    if (!dlg || !canvas) return;
    titleEl.textContent = title;
    if (modalChart) modalChart.destroy();
    const T = rideTheme();
    const datasets = spec.datasets.map((d) => Object.assign({}, d));
    modalChart = new Chart(canvas.getContext("2d"), {
        type: "line",
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { position: "top", labels: { color: T.tick, boxWidth: 14 } },
                tooltip: { callbacks: { title: (items) => "min " + items[0].label } }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: T.tick, maxTicksLimit: 12, callback: (v) => v + "m" } },
                y: { grid: { color: T.grid }, ticks: { color: T.tick } }
            }
        }
    });
    if (typeof dlg.showModal === "function") dlg.showModal();
}

function initCalibration() {
    /* Ride selector: switching re-renders the graphs and re-runs the route
       analysis for that ride. */
    const selector = document.getElementById('rideSelector');
    if (selector) {
        selector.addEventListener('change', () => {
            selectedRideIndex = parseInt(selector.value, 10) || 0;
            /* Remember which ride the user was on: a refresh restores it. */
            storeSelectedRide(selectedRideIndex);
            if (loadedRides[selectedRideIndex]) {
                buildRideGraphs(loadedRides[selectedRideIndex], lastRideAnalysis);
                buildRideMap(loadedRides[selectedRideIndex]);
                analyzeSelectedRide(selectedRideIndex);
            }
        });
    }

    /* Colour-by selector on the map: also focuses the matching graph. */
    const CHANNEL_GRAPH = {
        speed: "speed", altitude: "elevation", gradient: "elevation",
        riderPower: "power", motorPower: "power", cadence: "speed",
        gear: "gear", battery: "environment", heartRate: "gear"
    };
    const mapChannel = document.getElementById('mapChannel');
    if (mapChannel) {
        mapChannel.addEventListener('change', () => {
            if (loadedRides[selectedRideIndex]) buildRideMap(loadedRides[selectedRideIndex]);
            /* Recolouring the map must not take the map away. The graph that
               belongs to this channel is only brought into view when the
               graphs are actually open - and even then the map stays pinned
               above it, so the user sees the change he just made. */
            if (!graphsOpen()) return;
            const graphId = CHANNEL_GRAPH[mapChannel.value];
            const card = graphId && document.querySelector('#rideGraphs .ride-graph[data-graph-id="' + graphId + '"]');
            if (!card) return;
            card.classList.add('graph-focus');
            /* Scroll so the graph lands just below the sticky map, not
               underneath it. */
            const mapCard = document.querySelector('.ride-map-card');
            const headerH = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-h')) || 62;
            const offset = headerH + (mapCard ? mapCard.offsetHeight : 0) + 16;
            const y = card.getBoundingClientRect().top + window.scrollY - offset;
            window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
            setTimeout(() => card.classList.remove('graph-focus'), 3000);
        });
    }

    /* Copy the adb command from the file guide. */
    const copyAdb = document.getElementById('copyAdb');
    if (copyAdb) {
        copyAdb.addEventListener('click', () => {
            copyText('adb pull "/sdcard/Android/data/com.avinox.ride/files/ebike/data/" /sdcard/Download/', copyAdb);
        });
    }

    renderCalibrationState();
}

/* Parse a batch of .proto recordings into the ride library: one ride per
   file, duplicates skipped (the ride id in the header is stable across
   re-imports and renames), the calibration factor recomputed over all
   rides merged - more rides, better factor. */
async function handleProtoFiles(files, opts) {
    const restore = !!(opts && opts.restore);
    if (!files.length) return;
    try {
        if (!restore) setFileStatus('Reading ' + files.length + ' ride file(s)…', 'info');

        /* Each file becomes a separate ride in the library: charts show
           one ride at a time (selected in the dropdown). The calibration
           factor still uses ALL rides merged. Duplicates are skipped. */
        const added = [];
        const skipped = [];
        for (const file of files) {
            const buf = await file.arrayBuffer();
            const parsed = AvinoxProtoParser.parse(buf, file.name);
            const key = parsed.metadata.rideId || parsed.metadata.fileName || file.name;
            const duplicate = loadedRides.some((r) =>
                (r.metadata.rideId || r.metadata.fileName || r.label) === key);
            if (duplicate) { skipped.push(file.name); continue; }
            const km = parsed.samples.length ? (parsed.samples.at(-1).distanceKm || 0).toFixed(1) : '?';
            const d = parsed.metadata.start ? new Date(parsed.metadata.start * 1000).toLocaleDateString() : '';
            loadedRides.push({
                metadata: parsed.metadata,
                samples: parsed.samples,
                label: (d ? d + ' - ' : '') + km + ' km'
            });
            added.push(file.name);
            /* Keep the bytes on this device: a refresh must not throw away
               what the user just loaded. */
            storeFile('ride', file.name, buf, file.type);
            /* Someone who loads their own files has found their way. */
            dismissWelcome();
        }

        if (!added.length) {
            if (!restore) {
                setFileStatus(skipped.length === 1
                    ? 'That ride is already loaded.'
                    : 'These rides are already loaded.', 'info');
            }
            return;
        }

        const allSamples = loadedRides.flatMap((r) => r.samples);

        /* Only rides carrying a usable measurement feed the calibration: a ride
           where the motor barely ran would drag the average down and inflate
           every range. Those rides stay loaded and visible — they are named in
           the card instead of being quietly averaged in. */
        const usedRides = [], excluded = [];
        loadedRides.forEach((r) => {
            const problem = rideMeasurementProblem(r);
            if (problem) excluded.push(Object.assign({ label: r.label }, problem));
            else usedRides.push(r);
        });
        storeCalibrationNotes({ used: usedRides.length, total: loadedRides.length, excluded });

        /* The ride view still needs an analysis even when nothing is usable. */
        const analysisSamples = usedRides.length ? usedRides.flatMap((r) => r.samples) : allSamples;
        const earliest = loadedRides.reduce((m, r) => Math.min(m, r.metadata.start), Infinity);
        const merged = {
            metadata: {
                fileName: loadedRides.length + ' ride file(s)',
                start: earliest,
                duration: loadedRides.reduce((m, r) => m + r.metadata.duration, 0),
                samples: analysisSamples.length
            },
            samples: analysisSamples,
            rides: usedRides.length ? usedRides : loadedRides
        };

            const analysis = analyzeRideForCalibration(merged);
            lastRideAnalysis = analysis;
            /* Totals behind the factor: kept with it so a route analysis can
               still be personalised after the ride library is cleared. The
               distance is the one the energy was integrated over, so the two
               describe the same rides. */
            const calKm = parseFloat(analysis.summary.distanceKm) || 0;
            const calHm = usedRides.reduce((a, r) => a + (r.metadata.ascent || 0), 0);
            const efficiency = ridesPackEfficiency(usedRides);
            analysis.summary.efficiency = efficiency;
            if (usedRides.length) {
                const energies = usedRides.map((r) => AvinoxRideEnergy.rideEnergy(r.samples));
                const rideKm = energies.map((e) => e.km);
                const totalRideKm = rideKm.reduce((a, k) => a + k, 0);
                const motorWh = energies.reduce((a, e) => a + e.motorWh, 0);
                const riderWh = energies.reduce((a, e) => a + e.riderWh, 0);
                const steepSharePct = totalRideKm > 0
                    ? usedRides.reduce((a, r, i) => a + rideSteepSharePct(r) * rideKm[i], 0) / totalRideKm
                    : 0;
                const cal = {
                    /* The ride conditions the factor is measured against: the
                       route model applies the same surface and steepness, so
                       they must be on both sides of the comparison. */
                    efficiency: efficiency.efficiency,
                    efficiencyMeasured: efficiency.measured,
                    surface: selectedSurface(),
                    surfaceMix: getSurfaceMix(),
                    steepSharePct: Math.round(steepSharePct * 10) / 10,
                    /* How much of the work the motor did on these rides: the
                       Tuner splits the measured consumption between the modes
                       by their motor share against this one. */
                    motorShare: motorWh + riderWh > 0 ? Math.round(motorWh / (motorWh + riderWh) * 1000) / 1000 : null,
                    totalWh: analysis.summary.totalWh,
                    /* The drain per km over the whole ride - what the route plan
                       and the estimates use. Nothing per mode: see the note on
                       the assist values above. */
                    whPerKm: analysis.summary.whPerKm,
                    /* The distance the energy above was integrated over. */
                    distanceKm: parseFloat(analysis.summary.distanceKm) || 0,
                    realKm: Math.round(calKm * 10) / 10,
                    realHm: Math.round(calHm),
                    rideLabel: (excluded.length
                        ? usedRides.length + ' of ' + loadedRides.length + ' rides'
                        : usedRides.length + ' ride(s)') + ' · ' + analysis.summary.distanceKm + ' km'
                };
                setCalibration(cal);
            } else {
                setCalibration(null);
            }
            /* A route file and recordings are two different things: loading
               rides drops the loaded GPX/KML and its track. */
            clearRouteFile();
            if (!restore) {
                setFileStatus('Loaded ' + loadedRides.length + ' ride(s), ' + allSamples.length + ' samples.'
                    + (excluded.length ? ' (' + excluded.length + ' left out of the calibration: no usable measurement)' : '')
                    + (skipped.length ? ' (' + skipped.length + ' already loaded, skipped)' : ''), 'ok');
            }
            renderCalibrationReport(analysis);
            const wantedIndex = opts && typeof opts.selectedIndex === 'number' ? opts.selectedIndex : null;
            selectedRideIndex = (wantedIndex != null && loadedRides[wantedIndex])
                ? wantedIndex
                : loadedRides.length - 1;
            renderRideInsights();
            /* The ride becomes the analyzed route: distance, elevation and
               grade breakdown come from this recording. */
            analyzeSelectedRide(selectedRideIndex);
            /* Recalculate the Tuner and explain what changed: the estimates
               now come from the real ride consumption. */
            const before = lastCalcRes;
            await updateSetup();
            if (!restore) showRideSummary(before, lastCalcRes, analysis);
            /* Loaded: shorten the page, with the graphs one click away. A
               restore does the same silently - the page simply looks the way
               the user left it. */
            updateRouteLoadState();
            collapseAfterLoad('ride', { quiet: restore });
        } catch (err) {
            if (!restore) setFileStatus(err.message, 'error');
        }
}

let lastRideAnalysis = null;

function analyzeRideForCalibration(parsed) {
    /* Every assist value is kept: values above 4 are not only boost/walk/off
       states, 20 and 21 were two custom modes on a real ride. */
    const samples = parsed.samples.filter((s) => s && s.timestamp && s.assist != null);
    if (samples.length < 10) throw Error('Not enough samples in this ride file.');

    /* Distance and motor energy are totalled ride by ride, over EVERY sample,
       including the states the app does not model (boost, walk, off): that is
       what emptied the battery. Each file restarts its distance counter, so
       the totals add up the rides instead of reading one counter. */
    const perRide = (parsed.rides || [parsed]).map((r) => AvinoxRideEnergy.rideEnergy(r.samples));
    const totalWh = perRide.reduce((a, r) => a + r.motorWh, 0);
    const distanceKm = perRide.reduce((a, r) => a + r.km, 0);

    /* Per-mode aggregation with sample-interval weighting. */
    const byLevel = {};
    let batteryStart = null, batteryEnd = null;
    let prevKm = null;

    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const dt = AvinoxRideEnergy.sampleIntervalS(s, i > 0 ? samples[i - 1] : null);
        if (s.battery != null) {
            if (batteryStart === null) batteryStart = s.battery;
            batteryEnd = s.battery;
        }
        /* Distance ridden since the previous sample, kept per assist value for
           the report: it is what the file states, nothing more. A counter
           restarting at the next ride reads as a step back and counts zero. */
        const rideKm = s.distanceKm || 0;
        const stepKm = prevKm === null ? 0 : Math.max(0, Math.min(0.5, rideKm - prevKm));
        prevKm = rideKm;

        const lvl = s.assist;
        if (!byLevel[lvl]) byLevel[lvl] = { level: lvl, seconds: 0, km: 0, riderWh: 0, motorWh: 0, samples: 0, activeSeconds: 0, activeRiderWh: 0, activeMotorWh: 0 };
        const b = byLevel[lvl];
        b.seconds += dt;
        b.km += stepKm;
        b.samples++;

        const riderW = s.riderPower || 0, motorW = s.motorPower || 0;
        b.riderWh += riderW * dt / 3600;
        b.motorWh += motorW * dt / 3600;

        /* Active averages: only samples where the rider is actually
           pedaling - otherwise coasting/stops dilute the averages. */
        if (riderW > 20) {
            b.activeSeconds += dt;
            b.activeRiderWh += riderW * dt / 3600;
            b.activeMotorWh += motorW * dt / 3600;
        }
    }

    const levels = Object.values(byLevel)
        .filter((b) => b.seconds > 5)
        .sort((a, b) => a.level - b.level);
    if (!levels.length) throw Error('No meaningful assist samples in this ride.');

    /* Real rider profile: averages over active (pedaling) samples only. */
    const active = samples.filter((s) => (s.riderPower || 0) > 20);
    const avgRiderPower = active.length ? Math.round(active.reduce((a, s) => a + (s.riderPower || 0), 0) / active.length) : null;
    const avgCadence = active.length ? Math.round(active.reduce((a, s) => a + (s.cadence || 0), 0) / active.length) : null;

    const fmtDuration = (sec) => {
        const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
        return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    };

    /* The battery drain per km over the whole ride, every sample in it: this is
       what the range/runtime estimates and the route plan use. Nothing per mode
       is computed, because the file does not say which mode a sample is. */
    const whPerKm = distanceKm > 0.5 ? totalWh / distanceKm : null;

    return {
        summary: {
            fileName: parsed.metadata.fileName,
            date: parsed.metadata.start ? new Date(parsed.metadata.start * 1000).toLocaleString() : '-',
            durationH: fmtDuration(parsed.metadata.duration),
            distanceKm: distanceKm.toFixed(1),
            batteryStart, batteryEnd,
            totalWh: Math.round(totalWh),
            avgRiderPower,
            avgCadence,
            whPerKm: whPerKm ? Math.round(whPerKm * 10) / 10 : null
        },
        levels,
        assist: AvinoxRideEnergy.describeAssistValues(samples)
    };
}

/* A recording carries the assist value the bike recorded (field 8), a number
   that is not the mode's name. The table describes each value by what the
   motor did and names it only where that is confirmed (see ride-energy.js). */

function renderCalibrationReport(analysis) {
    const report = document.getElementById('calibrationReport');
    if (!report) return;
    lastRideAnalysis = analysis;
    const s = analysis.summary;
    const describe = {};
    (analysis.assist || []).forEach((d) => { describe[d.value] = d.label; });
    const rows = analysis.levels.map((b) => {
        const riding = b.activeSeconds > 0 ? b.activeSeconds / 3600 : 0;
        return '<tr><td>' + escapeHtml(describe[b.level] || 'assist ' + b.level) + '</td>' +
            '<td>' + Math.round(b.seconds / 60) + ' min</td>' +
            '<td>' + Math.round(riding > 0 ? b.activeRiderWh / riding : 0) + ' W</td>' +
            '<td>' + Math.round(riding > 0 ? b.activeMotorWh / riding : 0) + ' W</td>' +
            '<td>' + Math.round(b.seconds > 0 ? b.riderWh / (b.seconds / 3600) : 0) + ' W</td>' +
            '<td>' + b.motorWh.toFixed(0) + ' Wh</td></tr>';
    }).join('');
    report.classList.remove('hidden');
    report.innerHTML =
        '<div class="card"><div class="card-body kv-compact">' +
        kvRow('Ride date:', s.date) +
        kvRow('Duration / distance:', s.durationH + ' / ' + s.distanceKm + ' km') +
        kvRow('Battery start / finish:', (s.batteryStart ?? '—') + ' / ' + (s.batteryEnd ?? '—') + ' %') +
        kvRow('Your real averages:', (s.avgCadence ?? '—') + ' RPM · ' + (s.avgRiderPower ?? '—') + ' W (while pedaling)') +
        kvRow('Motor energy (whole ride):', s.totalWh + ' Wh') +
        (s.efficiency ? kvRow('Motor → battery efficiency:', efficiencyText(s.efficiency)) : '') +
        '</div></div>' +
        '<div class="kb-table-wrap"><table class="kb-table"><thead><tr>' +
        '<th>Assist</th><th>Time</th><th>Rider W (riding)</th><th>Motor W (riding)</th><th>Rider W (total)</th><th>Energy</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<p class="hint">The recording stores a number for the assist, not the mode\'s name. Each value is described ' +
        'by what the motor did while you pedalled: a <strong>fixed</strong> ratio of motor to rider power, or a ' +
        '<strong>dynamic</strong> one that grows with the gradient. Names are given only where they are confirmed ' +
        '(1 = ECO, 2 = TRAIL, 3 = TURBO, 4 = AUTO, 20 and up = custom modes). ' +
        'Route estimates use the whole-ride consumption, which counts every watt-hour in the file.</p>' +
        '<button type="button" id="useRideAverages" class="btn btn-primary btn-block"' +
        ((s.avgCadence && s.avgRiderPower) ? '' : ' disabled') + '>Use ride averages' +
        ((s.avgCadence && s.avgRiderPower) ? ' — ' + s.avgCadence + ' RPM · ' + s.avgRiderPower + ' W' : '') +
        '</button>' +
        '<p class="hint">Reading the values above and telling the Tuner which one is which mode is up to you: ' +
        'the app does not map them, so it does not write targets by itself.</p>';
    const useBtn = document.getElementById('useRideAverages');
    if (useBtn && s.avgCadence && s.avgRiderPower) {
        useBtn.addEventListener('click', () => {
            const cadenceEl = document.getElementById('cadence');
            const powerEl = document.getElementById('riderPower');
            cadenceEl.value = s.avgCadence;
            powerEl.value = s.avgRiderPower;
            saveForm();
            /* Same path as a manual change: the Tuner recalculates and the
               Route analysis follows. */
            scheduleFromTuner();
            /* The values went into the Tuner: take the user there and show
               which fields they landed in, or the click looks like nothing
               happened (the Tuner is another tab). */
            switchTab('calc');
            window.scrollTo({ top: 0, behavior: 'smooth' });
            [cadenceEl, powerEl].forEach((el) => {
                const field = el.closest('.field') || el;
                field.classList.remove('field-flash');
                void field.offsetWidth;   // restart the animation
                field.classList.add('field-flash');
                setTimeout(() => field.classList.remove('field-flash'), 2600);
            });
        });
    }

}

/* ---- Form persistence (Phase 1) ---------------------------------------- */

const FORM_FIELDS = ['bike', 'battery', 'boostDuration', 'riderWeight', 'bikeWeight', 'cadence', 'riderPower', 'ecoWkg', 'autoWkg', 'trailWkg', 'turboWkg'];

/* Forms saved before the pack was identified stored only its capacity: 600
   and 800 map to the integrated packs, the only 700 Wh pack is the FP700. */
const LEGACY_BATTERY_BY_WH = { 600: 'FS600', 700: 'FP700', 800: 'FS800' };

function restoreForm() {
    try {
        const saved = JSON.parse(localStorage.getItem(FORM_KEY) || '{}');
        if (!saved.battery && saved.batteryWh) saved.battery = LEGACY_BATTERY_BY_WH[saved.batteryWh];
        FORM_FIELDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el && saved[id] != null && saved[id] !== '') el.value = saved[id];
        });
    } catch (e) { /* ignore */ }
}

function saveForm() {
    try {
        const data = {};
        FORM_FIELDS.forEach((id) => {
            const el = document.getElementById(id);
            if (el) data[id] = el.value;
        });
        /* The surface and its composition are part of the setup the user
           chose: they survive a reload too, not only a calibration. */
        const surf = document.getElementById('surface');
        if (surf) data.surfaceId = surf.value;
        if (typeof getSurfaceMix === 'function' && document.getElementById('mix-tarmac')) {
            data.surfaceMix = getSurfaceMix();
        }
        localStorage.setItem(FORM_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
}

/* ---- Template helpers (G4): shared markup for the result cards --------- */

function kvRow(label, value, hint) {
    return `<div class="kv-row"><span class="kv-label">${label}</span>` +
        `<span class="kv-value">${value}${hint || ''}</span></div>`;
}

function modeCard({ mode, title, badges, rows, footer }) {
    return `<div class="mode-card" data-mode="${mode}">
        <div>
            <div class="mode-head">
                <span class="mode-title">${title}</span>
                <div class="mode-badges">${(badges || []).join('')}</div>
            </div>
            <div class="kv">${(rows || []).join('')}</div>
        </div>
        ${footer ? `<p class="card-footer">${footer}</p>` : ''}
    </div>`;
}

function callout(kind, html) {
    return `<div class="callout callout-${kind}">${html}</div>`;
}

function toggleAdvancedSliders() {
    const panel = document.getElementById('advancedSlidersPanel');
    const txt = document.getElementById('advancedToggleText');
    const icon = document.getElementById('advancedToggleIcon');
    
            if(panel.classList.contains('hidden')) {
                panel.classList.remove('hidden');
                txt.innerText = "Hide Advanced Sliders";
                icon.innerText = "▾";
            } else {
                panel.classList.add('hidden');
                txt.innerText = "Show Advanced W/kg Sliders";
                icon.innerText = "▸";
            }
        }

        /* Theme colours for Chart.js, read live from the CSS custom
           properties so the charts always match the stylesheet tokens. */
        function chartTheme() {
            const s = getComputedStyle(document.documentElement);
            const t = (name) => s.getPropertyValue(name).trim();
            return {
                grid: t('--surface-3'),
                tick: t('--muted'),
                faint: t('--faint'),
                surface: t('--surface'),
                accent: t('--accent'),
                modeColors: [t('--mode-eco'), t('--mode-auto'), t('--mode-trail'), t('--mode-turbo')],
                accentFill: 'rgba(39, 106, 11, 0.14)'
            };
        }

function initCharts(rangeData, runtimeData, stock) {
            const ctxRange = document.getElementById('rangeChart').getContext('2d');
            const ctxRuntime = document.getElementById('runtimeChart').getContext('2d');
            const theme = chartTheme();

            /* The DJI stock values ride along in BOTH charts, so the comparison
               exists for distance and for duration alike, instead of living in
               a separate chart that repeated the durations. */
            const order = ['eco', 'auto', 'trail', 'turbo'];
            const byKey = {};
            (stock || []).forEach((s) => { byKey[s.key] = s; });
            const hasStock = !!(stock && stock.length);
            const stockDataset = (pick) => ({
                label: 'DJI stock',
                data: order.map((k) => (byKey[k] ? byKey[k][pick] : 0)),
                backgroundColor: theme.faint,
                borderRadius: 4
            });

            const chartOptions = {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { grid: { color: theme.grid }, ticks: { color: theme.tick, font: { size: 11 } } },
                    x: { ticks: { color: theme.tick, font: { size: 11, weight: 'bold' } } }
                }
            };

    if (rangeChartInstance) rangeChartInstance.destroy();
    if (runtimeChartInstance) runtimeChartInstance.destroy();

    const datasetsFor = (own, pick) => {
        const sets = [{
            label: 'This calculator',
            data: own,
            backgroundColor: theme.modeColors,
            borderRadius: 4
        }];
        if (hasStock) sets.push(stockDataset(pick));
        return sets;
    };

    rangeChartInstance = new Chart(ctxRange, {
        type: 'bar',
        data: {
            labels: ['ECO', 'AUTO', 'TRAIL', 'TURBO'],
            datasets: datasetsFor(rangeData, 'range')
        },
        options: chartOptions
    });

    runtimeChartInstance = new Chart(ctxRuntime, {
        type: 'bar',
        data: {
            labels: ['ECO', 'AUTO', 'TRAIL', 'TURBO'],
            datasets: datasetsFor(runtimeData, 'runtime')
        },
        options: chartOptions
    });
}

function bindSliderAndText(textId, sliderId) {
    const txt = document.getElementById(textId);
    const sld = document.getElementById(sliderId);
    txt.addEventListener('input', () => {
        let val = parseFloat(txt.value);
        if (!isNaN(val)) {
            if (val < parseFloat(sld.min)) val = parseFloat(sld.min);
            if (val > parseFloat(sld.max)) val = parseFloat(sld.max);
            sld.value = val;
            updateSetup();
        }
    });
    sld.addEventListener('input', () => {
        txt.value = sld.value;
        updateSetup();
    });
}

bindSliderAndText('ecoWkg', 'ecoWkgSlider');
bindSliderAndText('autoWkg', 'autoWkgSlider');
bindSliderAndText('trailWkg', 'trailWkgSlider');
bindSliderAndText('turboWkg', 'turboWkgSlider');

// Preset mapping loaders
/* The highlighted preset is DERIVED from the four W/kg values, never set as
   a flag: if the user moves a slider by hand, no preset matches and none is
   highlighted. A sticky "selected" flag would keep claiming a profile the
   numbers no longer are. */
function markActivePreset() {
    const inputs = ['ecoWkg', 'autoWkg', 'trailWkg', 'turboWkg'].map((id) => document.getElementById(id));
    if (inputs.some((el) => !el)) return;
    const current = inputs.map((el) => parseFloat(el.value));
    document.querySelectorAll('.preset').forEach((btn) => {
        const wkg = String(btn.getAttribute('data-wkg') || '').split(',').map((v) => parseFloat(v));
        const match = wkg.length === 4 && current.every((v, i) => Number.isFinite(v) && Math.abs(v - wkg[i]) < 0.005);
        btn.classList.toggle('is-active', match);
        btn.setAttribute('aria-pressed', match ? 'true' : 'false');
    });
}

function loadPreset(eco, auto, trail, turbo) {
    document.getElementById('ecoWkg').value = eco;
    document.getElementById('ecoWkgSlider').value = eco;
    document.getElementById('autoWkg').value = auto;
    document.getElementById('autoWkgSlider').value = auto;
    document.getElementById('trailWkg').value = trail;
    document.getElementById('trailWkgSlider').value = trail;
    document.getElementById('turboWkg').value = turbo;
    document.getElementById('turboWkgSlider').value = turbo;
    /* A preset is a form change like any other: it persists. */
    saveForm();
    markActivePreset();
    updateSetup();
}

function initPresetState() {
    ['ecoWkg', 'autoWkg', 'trailWkg', 'turboWkg'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.addEventListener('input', markActivePreset); el.addEventListener('change', markActivePreset); }
    });
    markActivePreset();
}

async function updateSetup() {
    const selectedBattery = selectedBatteryWh();
    document.getElementById('rangeChartTitle').innerText = 'Range & Duration • ' + selectedBatteryId() + ' ' + selectedBattery + ' Wh';

    const data = {
        bike: document.getElementById('bike').value,
        battery: selectedBatteryId(),
        batteryWh: selectedBattery,
        boostDuration: document.getElementById('boostDuration').value,
        riderWeight: document.getElementById('riderWeight').value,
        bikeWeight: document.getElementById('bikeWeight').value,
        cadence: document.getElementById('cadence').value,
        riderPower: document.getElementById('riderPower').value,
        ecoWkg: document.getElementById('ecoWkg').value,
        autoWkg: document.getElementById('autoWkg').value,
        trailWkg: document.getElementById('trailWkg').value,
        turboWkg: document.getElementById('turboWkg').value
    };
    /* The measured consumption sets the overall level of the Tuner's ranges
       the same way it scales a route; the modes then split it by their motor
       share, so no recorded assist value has to be named as a mode. */
    Object.assign(data, calibrationPayload() || {});


    try {
        const response = await axios.post('/api/calculate', data);
        const res = response.data;
        saveForm();
        document.getElementById('sysWeight').innerText = 'Total Weight: ' + res.totalWeight + ' kg';
        
        const modes = [
            { name: 'ECO', key: 'eco', val: parseFloat(data.ecoWkg), data: res.eco, desc: 'Maximum range baseline profile.' },
            { name: 'AUTO', key: 'auto', val: parseFloat(data.autoWkg), data: res.auto, desc: 'Dynamic torque adjustments matching slopes.' },
            { name: 'TRAIL', key: 'trail', val: parseFloat(data.trailWkg), data: res.trail, desc: 'Optimized technical climbing engagement map.' },
            { name: 'TURBO', key: 'turbo', val: parseFloat(data.turboWkg), data: res.turbo, desc: 'Peak emergency boost map.' }
        ];

        const groundText = res.rangeModel.basis === 'rides'
            ? `your rides' ground (${res.rangeModel.climbMPerKm} m/km)`
            : `${res.rangeModel.climbMPerKm} m/km mixed ground`;
        const grid = document.getElementById('resultsGrid');
        grid.innerHTML = '';
        modes.forEach(m => {
            const isHighDrain = m.val >= 6.0;
            const wkgBadge = isHighDrain
                ? `<span class="badge badge-danger">${m.data.wkg} W/kg</span>`
                : `<span class="badge badge-mode-${m.key}">${m.data.wkg} W/kg</span>`;
            const typeBadge = `<span class="badge badge-soft">${m.data.type === 'range' ? 'Range' : 'Fixed'}</span>`;
            const accelRow = m.data.maxAccel !== null && m.data.maxAccel !== undefined
                ? kvRow('Max Acceleration:', m.data.maxAccel)
                : '';
            const warnBlock = (m.data.warnings && m.data.warnings.length)
                ? callout('danger', m.data.warnings.join(' '))
                : '';
            const powerHint = (m.data.idealPower !== m.data.maxPower)
                ? ` <span class="kv-hint">(computed ${m.data.idealPower} W)</span>` : '';
            const drawHint = (m.data.typicalPower < m.data.maxPower)
                ? ` <span class="kv-hint">(expected draw ~${m.data.typicalPower} W at your input)</span>` : '';
            const calHint = res.basedOnRealRides
                ? ` <span class="kv-hint">· scaled by your rides (×${res.personalFactor})</span>` : '';
            const torqueHint = (m.data.idealTorque !== m.data.maxTorque)
                ? ` <span class="kv-hint">(computed ${m.data.idealTorque} Nm)</span>` : '';

            grid.innerHTML += modeCard({
                mode: m.key,
                title: m.name,
                badges: [typeBadge, wkgBadge],
                rows: [
                    kvRow('Assist Bound:', `${m.data.level}${m.data.levelPct ? ` <span class="kv-hint">· ${m.data.levelPct} of rider input</span>` : ''}`),
                    kvRow('Power Limit:', m.data.watts, powerHint + drawHint + calHint),
                    kvRow('Max Torque:', m.data.torque, torqueHint),
                    kvRow('Consumption:', `~${m.data.whPerKm} Wh/km`,
                        ` <span class="kv-hint">· ${m.data.range} km · ${m.data.runtime} h at ~${m.data.speedKmH} km/h on ${groundText}</span>`),
                    kvRow('Max Overrun:', m.data.maxOverrun),
                    kvRow('Assist Start:', m.data.assistStart),
                    kvRow('Continued Assist:', m.data.continuedAssist),
                    accelRow
                ],
                footer: m.desc
            }) + warnBlock;
        });

        const batteryHint = document.getElementById('batteryHint');
        if (batteryHint && res.boost && res.boost.note) batteryHint.innerText = res.boost.note;

        const warnBox = document.getElementById('calcWarnings');
        warnBox.innerHTML = (res.warnings && res.warnings.length)
            ? res.warnings.map(w => callout('warn', w)).join('')
            : '';

        initCharts(
            [res.eco.range, res.auto.range, res.trail.range, res.turbo.range],
            [res.eco.runtime, res.auto.runtime, res.trail.runtime, res.turbo.runtime],
            res.stock || []
        );
        lastCalcRes = res;
        return res;
    } catch (err) {
        console.error(err);
        return null;
    }
}

/* ==================================================================
 * Route file import (GPX / KML)
 * Parsing happens entirely in the browser: coordinates never leave
 * the device. Only distance and elevation gain are sent to the API.
 * ================================================================== */

let parsedRoute = null;       // { source, geometries, warnings }
let selectedGeometries = [];  // indices into parsedRoute.geometries
let routeStats = null;
let routeGrades = null;       // grade distribution + climbs
let elevationChartInstance = null;
/* What the analysis panel currently describes: the route file name, a ride
   label, or null for a hand-typed route. Shown next to the verdict so the
   panel is never ambiguous once a file and some rides are both loaded. */
let analysisSourceLabel = null;
let routeFileName = null;

function setFileStatus(msg, kind) {
    const el = document.getElementById('fileStatus');
    const colors = { error: 'status-error', ok: 'status-ok', info: 'status-info' };
    el.className = 'file-status ' + (colors[kind] || colors.info);
    el.innerText = msg || '';
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function geometryDistance(geom) {
    let d = 0;
    for (let i = 1; i < geom.points.length; i++) {
        d += AvinoxRoute.haversine(geom.points[i - 1], geom.points[i]);
    }
    return d;
}

async function handleRouteFile(file, opts) {
    const restore = !!(opts && opts.restore);
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
        if (!restore) setFileStatus('File is larger than 10 MB.', 'error');
        return;
    }
    routeFileName = file.name;
    /* The "Rides analyzed" dialog described the previous input: the route
       file now owns the analysis, so it must not sit on screen. */
    const summaryDlg = document.getElementById('rideSummaryDialog');
    if (summaryDlg && summaryDlg.open) summaryDlg.close();
    if (!restore) setFileStatus('Reading ' + file.name + '…', 'info');

    let text;
    try {
        text = await file.text();
    } catch (e) {
        setFileStatus('Could not read the file.', 'error');
        return;
    }

            try {
                parsedRoute = AvinoxRoute.parseRouteFile(text, file.name);
            } catch (err) {
                parsedRoute = null;
                routeStats = null;
                document.getElementById('geometryPanel').classList.add('hidden');
                document.getElementById('geometryPicker').classList.add('hidden');
                document.getElementById('fileSummary').classList.add('hidden');
                document.getElementById('elevationPanel').classList.add('hidden');
                setFileStatus(err.message, 'error');
                return;
            }

    if (!parsedRoute.geometries.length) {
        setFileStatus(parsedRoute.warnings.join(' ') || 'No route found in this file.', 'error');
        return;
    }

    /* A planned route and recorded rides are two different things: the tab
       holds one at a time, so the route file drops the ride library (the
       calibration - a measurement stored on the device - survives it). */
    const hadRides = loadedRides.length;
    if (hadRides) clearRides();

    /* Keep the bytes on this device, so a refresh does not lose the route. */
    storeFile('route', file.name, await file.arrayBuffer(), file.type);
    dismissWelcome();

    if (!restore) {
        setFileStatus(parsedRoute.source.toUpperCase() + ' parsed — ' +
            parsedRoute.geometries.length + ' geometry(ies) found.'
            + (hadRides ? ' The loaded ride(s) were cleared.' : ''), 'ok');
    }
    /* Loaded: shorten the page (the header now carries the state). The
       header summary itself is refreshed by applyRouteSelection(), once the
       file name is the one being analysed. */
    collapseAfterLoad('route', { quiet: restore });

    // Select everything by default. GPX track segments and KML
    // MultiGeometry parts are normally one ride split by pauses or by
    // the exporter, so the expected behaviour is "load the whole file".
    // This is safe because segments are never bridged when measuring:
    // selecting them all cannot invent distance between them.
    selectedGeometries = parsedRoute.geometries.map((g, i) => i);

    renderGeometryPicker();
    applyRouteSelection();
}

        function renderGeometryPicker() {
            const panel = document.getElementById('geometryPanel');
            const box = document.getElementById('geometryPicker');
            if (!parsedRoute || parsedRoute.geometries.length < 2) {
                panel.classList.add('hidden');
                box.classList.add('hidden');
                box.innerHTML = '';
                return;
            }
            panel.classList.remove('hidden');
            box.classList.remove('hidden');

            const total = parsedRoute.geometries.length;
            box.innerHTML = `
                <div class="picker-actions">
                    <button type="button" id="geomAll" class="mini-btn">All</button>
                    <button type="button" id="geomNone" class="mini-btn">First only</button>
                </div>` +
                parsedRoute.geometries.map((g, i) => `
                    <label class="track-item">
                        <input type="checkbox" data-geom="${i}" ${selectedGeometries.indexOf(i) >= 0 ? 'checked' : ''} class="check">
                        <span>${escapeHtml(g.name)}</span>
                        <span class="track-km">${(geometryDistance(g) / 1000).toFixed(1)} km</span>
                    </label>`).join('');

            const updateCounter = () => {
                const el = document.getElementById('geomCounter');
                if (el) el.innerText = selectedGeometries.length + ' of ' + total + ' segments selected';
            };
            updateCounter();

    const syncCheckboxes = () => {
        box.querySelectorAll('input[data-geom]').forEach((c) => {
            c.checked = selectedGeometries.indexOf(parseInt(c.getAttribute('data-geom'), 10)) >= 0;
        });
    };

    box.querySelectorAll('input[data-geom]').forEach((cb) => {
        cb.addEventListener('change', () => {
            const picked = [];
            box.querySelectorAll('input[data-geom]').forEach((c) => {
                if (c.checked) picked.push(parseInt(c.getAttribute('data-geom'), 10));
            });
            // An empty selection cannot be analysed.
            if (picked.length === 0) {
                cb.checked = true;
                picked.push(parseInt(cb.getAttribute('data-geom'), 10));
            }
            selectedGeometries = picked;
            updateCounter();
            applyRouteSelection();
        });
    });

    document.getElementById('geomAll').addEventListener('click', () => {
        selectedGeometries = parsedRoute.geometries.map((g, i) => i);
        syncCheckboxes();
        updateCounter();
        applyRouteSelection();
    });

    document.getElementById('geomNone').addEventListener('click', () => {
        // Empty selections cannot be analysed: keep only the first segment.
        selectedGeometries = [0];
        syncCheckboxes();
        updateCounter();
        applyRouteSelection();
    });
}

function applyRouteSelection() {
    if (!parsedRoute) return;
    const chosen = selectedGeometries
        .map((i) => parsedRoute.geometries[i])
        .filter(Boolean);
    if (!chosen.length) return;

    const route = AvinoxRoute.buildRoute(chosen);
    routeStats = AvinoxRoute.computeStats(route.points);
    routeGrades = AvinoxRoute.computeGradeStats(route.points);
    routePoints = route.points;
    analysisSourceLabel = routeFileName;
    /* A planned route has no measurement of its own: the calibration (if
       any) is what scales it. */
    selectedRideMetrics = null;

    renderFileSummary();
    renderElevationChart(chosen);
    renderRouteAnalysis();
    renderRouteMap(routePoints, { refit: true });
    /* Last: the summary reads the parameters, which renderFileSummary fills
       from the file. */
    updateRouteLoadState();

    /* The analysis follows the route: loading a file (or changing the
       segments) re-runs it, so the energy card can never describe a
       different track than the grades and the profile next to it. */
    document.getElementById('missionForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

function copyText(text, btn) {
    const done = () => {
        if (btn) {
            const original = btn.innerText;
            btn.innerText = 'Copied';
            setTimeout(() => { btn.innerText = original; }, 1200);
        }
    };
    const fallback = () => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else {
        fallback();
    }
}

function renderRouteAnalysis() {
    const block = document.getElementById('routeAnalysis');
    const bars = document.getElementById('gradeBars');
    const climbs = document.getElementById('climbList');
    const descents = document.getElementById('descentList');

    if (!routeGrades || !routeGrades.ok) {
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');

            const colors = {
                descent: 'var(--mode-auto)', flat: 'var(--mode-eco)', rolling: 'var(--accent-hover)',
                climb: 'var(--mode-trail)', steep: 'var(--mode-turbo)', extreme: 'var(--mode-custom)'
            };
            const d = routeGrades.distribution;

            bars.innerHTML = AvinoxRoute.gradeBands.map((b) => {
                const pct = d[b.key] || 0;
                return `
                    <div class="bar">
                        <span class="bar-label">${b.label}</span>
                        <div class="bar-track"><div style="width:${pct.toFixed(1)}%;background:${colors[b.key]}" class="bar-fill"></div></div>
                        <span class="bar-value">${pct.toFixed(0)}%</span>
                    </div>`;
            }).join('');

            /* Climbs and descents share one compact table shape. The row
               number carries the band colour of that row's average grade:
               the same bands and colours as the bars above, so nothing here
               invents a palette. */
            const cs = routeGrades.climbSummary || {};
            const climbEntries = Array.isArray(routeGrades.climbs) ? routeGrades.climbs : [];
            const descentEntries = Array.isArray(routeGrades.descents) ? routeGrades.descents : [];
            const descentSummary = routeGrades.descentSummary || null;
            /* A route-file.js without descents shows nothing about them,
               rather than an empty table that claims there were none. */
            const hasDescents = Array.isArray(routeGrades.descents) && !!routeGrades.descentSummary;
            const climbCount = Number.isFinite(cs.count) ? cs.count : climbEntries.length;
            const descentCount = hasDescents
                ? (Number.isFinite(descentSummary.count) ? descentSummary.count : descentEntries.length)
                : 0;
            const peakText = Number.isFinite(routeGrades.maxGrade)
                ? routeGrades.maxGrade.toFixed(1) + '%' : '—';

            const bandColor = (grade) => {
                const key = (typeof AvinoxRoute !== 'undefined' && typeof AvinoxRoute.bandForGrade === 'function')
                    ? AvinoxRoute.bandForGrade(grade)
                    : 'flat';
                return colors[key] || colors.flat;
            };
            const numberCell = (n, grade) => {
                const c = bandColor(grade);
                return '<td style="color:' + c + ';font-weight:700;border-left:3px solid ' + c + '">'
                    + escapeHtml(n) + '</td>';
            };
            const fixed = (v, digits) => (Number.isFinite(v) ? v : 0).toFixed(digits);

            const climbRows = climbEntries.map((c) => {
                const grade = Number.isFinite(c.averageGrade) ? c.averageGrade : 0;
                return '<tr>'
                    + numberCell(c.index, grade)
                    + '<td>' + fixed(grade, 1) + '%</td>'
                    + '<td>+' + Math.round(Number.isFinite(c.gainM) ? c.gainM : 0) + ' m</td>'
                    + '<td>' + fixed(c.distanceKm, 1) + ' km</td>'
                    + '</tr>';
            }).join('');
            const descentRows = descentEntries.map((r) => {
                const grade = Number.isFinite(r.averageGrade) ? r.averageGrade : 0;
                return '<tr>'
                    + numberCell(r.index, grade)
                    + '<td>−' + Math.abs(grade).toFixed(1) + '%</td>'
                    + '<td>−' + Math.round(Number.isFinite(r.lossM) ? r.lossM : 0) + ' m</td>'
                    + '<td>' + fixed(r.distanceKm, 1) + ' km</td>'
                    + '</tr>';
            }).join('');

            const summary = climbCount + (climbCount === 1 ? ' climb' : ' climbs')
                + (hasDescents ? ' · ' + descentCount + (descentCount === 1 ? ' descent' : ' descents') : '')
                + ' · peak ' + peakText;

            climbs.innerHTML = '<p class="hint">' + summary + '</p>'
                + (climbRows
                    ? '<div class="kb-table-wrap"><table class="kb-table"><thead><tr>'
                        + '<th>Climb</th><th>Avg</th><th>Gain</th><th>Length</th>'
                        + '</tr></thead><tbody>' + climbRows + '</tbody></table></div>'
                    : '<p class="hint">No sustained climbs detected.</p>');

            if (descents) {
                descents.innerHTML = !hasDescents ? ''
                    : (descentRows
                        ? '<div class="kb-table-wrap"><table class="kb-table"><thead><tr>'
                            + '<th>Descent</th><th>Avg</th><th>Loss</th><th>Length</th>'
                            + '</tr></thead><tbody>' + descentRows + '</tbody></table></div>'
                        : '<p class="hint">No sustained descents detected.</p>');
            }

            const analysisState = document.getElementById('routeAnalysisState');
            if (analysisState) {
                analysisState.innerText = summary;
            }
}

function renderRouteModes(res) {
    const block = document.getElementById('routeModes');
    const grid = document.getElementById('routeModesGrid');
    const notes = document.getElementById('routeModeNotes');

    if (!res.modes || !res.modes.length) {
        block.classList.add('hidden');
        return;
    }
    block.classList.remove('hidden');

            // Match the column count to the number of proposals, so three
            // modes sit on one row instead of leaving a lonely third card.
            const count = res.modes.length;
            grid.className = 'result-grid ' + (
                count >= 4 ? 'cols-4' :
                count === 3 ? 'cols-3' :
                count === 2 ? 'cols-2' :
                'cols-1'
            );

            grid.innerHTML = res.modes.map((m) => `
                <div class="mode-card" data-mode="custom">
                    <div>
                        <div class="mode-head">
                            <span class="mode-title">${m.label}</span>
                            <span class="badge badge-soft">Fixed</span>
                        </div>
                        <div class="kv">
                            ${kvRow('Assist Level:', `${m.assistLevel}${m.assistLevelPct ? ` <span class="kv-hint">· ${m.assistLevelPct} of rider input</span>` : ''}`)}
                            ${kvRow('Max Power:', m.maxPower + ' W')}
                            ${kvRow('Max Torque:', m.maxTorque + ' Nm')}
                            ${kvRow('Max Overrun:', m.maxOverrun)}
                            ${kvRow('Assist Start:', m.assistStart)}
                            ${kvRow('Continued Assist:', m.continuedAssist)}
                        </div>
                    </div>
                    <p class="card-footer">${escapeHtml(m.rationale)}</p>
                    <button type="button" data-copy-mode="${m.key}"
                        class="mini-btn copy-btn">Copy</button>
                </div>`).join('');

            notes.innerHTML = (res.notes || []).map((n) => '<p>· ' + escapeHtml(n) + '</p>').join('');

            const modesState = document.getElementById('routeModesState');
            if (modesState) {
                modesState.innerText = res.modes.length + (res.modes.length === 1 ? ' mode · ' : ' modes · ')
                    + res.modes.map((m) => m.label).join(', ');
            }

    grid.querySelectorAll('button[data-copy-mode]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const key = btn.getAttribute('data-copy-mode');
            const m = res.modes.filter((x) => x.key === key)[0];
            if (!m) return;
            copyText([
                m.label + ' — ' + res.bike.name,
                'Assist Level: ' + m.assistLevel,
                'Max Torque: ' + m.maxTorque + ' Nm',
                'Max Power: ' + m.maxPower + ' W',
                'Max Overrun: ' + m.maxOverrun,
                'Assist Start: ' + m.assistStart,
                'Continued Assist: ' + m.continuedAssist
            ].join('\n'), btn);
        });
    });
}

/* What "Export GPX for Wikiloc" writes: the planned route as loaded (its own
   segments and times), or the recording being analysed. A recording loses
   GPS now and then; those stretches become separate <trkseg>, with the same
   rule the ride map uses to draw them dashed (RIDE_GAP_DT_S / RIDE_GAP_M),
   so a viewer never draws a straight line over a gap the bike did not ride.
   Points are cleaned like the stats are, so the file matches the summary. */
function exportableTrack() {
    if (typeof AvinoxGpxExport === 'undefined' || typeof AvinoxRoute === 'undefined') return null;
    if (routePoints.length > 1) {
        const points = AvinoxRoute.cleanPoints(routePoints).points;
        const name = (routeFileName || 'Route').replace(/\.(gpx|kml)$/i, '');
        return {
            name: name,
            time: null,
            segments: AvinoxGpxExport.splitSegments(points),
            fileName: AvinoxGpxExport.fileNameFor(name)
        };
    }
    const ride = loadedRides[selectedRideIndex];
    if (!ride) return null;
    const fixes = ride.samples
        .filter((s) => AvinoxRoute.isValidCoord(s.latitude, s.longitude))
        .map((s) => ({
            lat: s.latitude,
            lon: s.longitude,
            ele: Number.isFinite(s.altitude) ? s.altitude : null,
            time: s.timestamp ? s.timestamp * 1000 : null,
            segmentId: 0
        }));
    /* Gaps first, on the raw fixes: a stop is a run of identical positions
       one second apart, not a gap, and only becomes one once the duplicates
       are gone. */
    const segments = AvinoxGpxExport.splitSegments(fixes, {
        maxDtS: RIDE_GAP_DT_S,
        maxDistM: RIDE_GAP_M,
        distance: AvinoxRoute.haversine
    })
        .map((seg, i) => AvinoxRoute.cleanPoints(seg.map((p) => Object.assign({}, p, { segmentId: i }))).points)
        .filter((seg) => seg.length >= 2);
    const start = ride.metadata.start ? new Date(ride.metadata.start * 1000) : null;
    const name = 'Avinox ' + (start ? start.toISOString().slice(0, 10) : 'ride');
    return {
        name: name,
        time: start,
        segments: segments,
        fileName: AvinoxGpxExport.fileNameFor(name)
    };
}

/* Local download only: the GPX is built in memory and saved by the browser. */
function exportTrackGpx() {
    const btn = document.getElementById('exportGpxBtn');
    const track = exportableTrack();
    if (!track || !track.segments.length) {
        flashButton(btn, 'No GPS track to export');
        return;
    }
    const text = AvinoxGpxExport.buildGpx(track.segments, { name: track.name, time: track.time });
    const blob = new Blob([text], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = track.fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    flashButton(btn, 'Saved ' + track.fileName);
}

/* The load step folds away once a file is in, so the feedback goes on the
   button itself, like "Copy" does. */
function flashButton(btn, text) {
    if (!btn) return;
    const original = btn.innerText;
    btn.innerText = text;
    btn.disabled = true;
    setTimeout(() => { btn.innerText = original; btn.disabled = false; }, 1800);
}

/* Cheap check for the button state: a route, or the selected recording with
   at least two GPS fixes. */
function hasExportableTrack() {
    if (routePoints.length > 1) return true;
    const ride = loadedRides[selectedRideIndex];
    if (!ride || typeof AvinoxRoute === 'undefined') return false;
    let fixes = 0;
    for (const s of ride.samples) {
        if (AvinoxRoute.isValidCoord(s.latitude, s.longitude) && ++fixes > 1) return true;
    }
    return false;
}

function renderFileSummary() {
    const box = document.getElementById('fileSummary');
    box.classList.remove('hidden');

            if (!routeStats || !routeStats.ok) {
                box.innerHTML = callout('danger',
                    escapeHtml(routeStats ? routeStats.error : 'Could not analyse the route.'));
                return;
            }

            const s = routeStats;
            const eleOk = s.elevationStatus === 'available';
            const qualityClass = { good: 'status-ok', noisy: 'status-info', unavailable: 'status-error' }[s.quality];
            const qualityLabel = { good: 'Good', noisy: 'Noisy (smoothed)', unavailable: 'Unavailable' }[s.quality];

            const rows = [
                ['Distance', s.distanceKm.toFixed(1) + ' km'
                    + (Number.isFinite(s.gpsDistanceKm)
                        ? ' <span class="kv-hint">bike odometer · GPS track ' + s.gpsDistanceKm.toFixed(1) + ' km</span>'
                        : '')],
                ['Elevation gain', eleOk ? Math.round(s.elevationGainM) + ' m'
                    + (Number.isFinite(s.gpsElevationGainM)
                        ? ' <span class="kv-hint">bike sensor · GPS track ' + Math.round(s.gpsElevationGainM) + ' m</span>'
                        : '') : '—'],
                ['Elevation loss', eleOk ? Math.round(s.elevationLossM) + ' m' : '—'],
                ['Min / max altitude', eleOk ? Math.round(s.minElevationM) + ' / ' + Math.round(s.maxElevationM) + ' m' : '—'],
                ['Points / segments', s.pointCount + ' / ' + s.segmentCount]
            ];

            // Parser warnings (ignored points/polygons, several geometries found)
            // must be surfaced too: they were dropped whenever a route parsed.
            const allWarnings = ((parsedRoute && parsedRoute.warnings) || []).concat(s.warnings);

            box.innerHTML = `
                <div class="card">
                    <div class="card-body kv-compact">
                        ${rows.map((r) => kvRow(r[0], r[1])).join('')}
                        ${kvRow('Elevation quality', `<span class="${qualityClass}">${qualityLabel}</span>`)}
                    </div>
                </div>
                ${allWarnings.length ? callout('warn', allWarnings.map((w) => escapeHtml(w)).join('<br>')) : ''}
            `;

    // Feed the existing mission endpoint. Never write a value the field
    // itself would reject: native validation would then block submission
    // silently, with no analysis and no visible explanation.
    document.getElementById('targetKm').value = Math.max(0.1, s.distanceKm).toFixed(1);
    if (eleOk) {
        document.getElementById('targetH_m').value = Math.round(s.elevationGainM);
    } else {
        // Do not silently reuse the previous route's elevation gain (or
        // the 1500 m default) when the imported file has no altitude.
        document.getElementById('targetH_m').value = '';
    }
}

function renderElevationChart(chosen) {
    const panel = document.getElementById('elevationPanel');
    const note = document.getElementById('elevationNote');

    if (!routeStats || !routeStats.ok || routeStats.elevationStatus !== 'available') {
        panel.classList.add('hidden');
        return;
    }

    const points = [];
    let cumulative = 0;

    chosen.forEach((geom) => {
        geom.points.forEach((p, i) => {
            if (i > 0) cumulative += AvinoxRoute.haversine(geom.points[i - 1], p);
            if (Number.isFinite(p.ele)) {
                points.push({ x: Math.round(cumulative) / 1000, y: p.ele });
            }
        });
    });

    if (points.length < 2) {
        panel.classList.add('hidden');
        return;
    }
    panel.classList.remove('hidden');

            const ctx = document.getElementById('elevationChart').getContext('2d');
            if (elevationChartInstance) elevationChartInstance.destroy();
            const theme = chartTheme();

            /* Gradient at each plotted point, for the tooltip. It comes from
               the same 25 m-window profile that colours the map; the lookup
               is built once here, never inside the tooltip callback. */
            let gradeLookup = [];
            if (typeof AvinoxRoute !== 'undefined' && typeof AvinoxRoute.computeGradeProfile === 'function'
                && Array.isArray(routePoints) && routePoints.length) {
                const profile = AvinoxRoute.computeGradeProfile(routePoints);
                if (profile && profile.ok && Array.isArray(profile.points)) {
                    gradeLookup = profile.points
                        .filter((p) => Number.isFinite(p.grade) && p.distanceM > 0)
                        .map((p) => ({ km: p.distanceM / 1000, grade: p.grade }))
                        .sort((a, b) => a.km - b.km);
                }
            }
            const nearestGrade = (km) => {
                if (!gradeLookup.length) return null;
                let lo = 0;
                let hi = gradeLookup.length - 1;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (gradeLookup[mid].km < km) lo = mid + 1; else hi = mid;
                }
                const a = gradeLookup[Math.max(0, lo - 1)];
                const b = gradeLookup[lo];
                if (!a) return b.grade;
                if (!b) return a.grade;
                return Math.abs(b.km - km) < Math.abs(a.km - km) ? b.grade : a.grade;
            };
            const pointGrades = points.map((p) => nearestGrade(p.x));

            /* Climb/descent start-end markers. An inline plugin: it is passed
               to THIS chart only (a global registration would draw the same
               markers on every other chart). It reads the live x scale, so
               it stays correct if the chart is ever zoomed or panned. */
            const markers = [];
            const markerBand = (grade) => (typeof AvinoxRoute !== 'undefined' && typeof AvinoxRoute.bandForGrade === 'function')
                ? AvinoxRoute.bandForGrade(grade)
                : 'flat';
            const addMarkers = (list, kind) => {
                if (!Array.isArray(list)) return;
                list.forEach((entry) => {
                    const grade = Number.isFinite(entry.averageGrade) ? entry.averageGrade : 0;
                    const label = (kind === 'climb' ? 'C' : 'D') + entry.index;
                    const color = gradeBandColor(markerBand(grade));
                    [entry.startKm, entry.endKm].forEach((km) => {
                        if (Number.isFinite(km)) markers.push({ km: km, label: label, color: color });
                    });
                });
            };
            if (routeGrades && routeGrades.ok) {
                addMarkers(routeGrades.climbs, 'climb');
                addMarkers(routeGrades.descents, 'descent');
            }
            const markerPlugin = {
                id: 'routeMarkers',
                afterDatasetsDraw: (chart) => {
                    const area = chart.chartArea;
                    const xs = chart.scales && chart.scales.x;
                    if (!area || !xs || !markers.length) return;
                    const pctx = chart.ctx;
                    const fontFamily = getComputedStyle(document.body).fontFamily || 'sans-serif';
                    pctx.save();
                    let lastPx = -Infinity;
                    let row = 0;
                    markers.forEach((m) => {
                        const px = xs.getPixelForValue(m.km);
                        if (!Number.isFinite(px) || px < area.left || px > area.right) return;
                        pctx.globalAlpha = 0.8;
                        pctx.strokeStyle = m.color;
                        pctx.lineWidth = 1;
                        pctx.beginPath();
                        pctx.moveTo(px, area.top);
                        pctx.lineTo(px, area.bottom);
                        pctx.stroke();
                        pctx.globalAlpha = 1;
                        /* Near-coincident markers (a climb end and the next
                           descent start) stagger downward instead of
                           overprinting each other. */
                        row = px - lastPx < 26 ? (row + 1) % 3 : 0;
                        lastPx = px;
                        const flip = px > area.right - 22;
                        pctx.font = '600 9px ' + fontFamily;
                        pctx.textAlign = flip ? 'right' : 'left';
                        pctx.textBaseline = 'top';
                        pctx.fillStyle = m.color;
                        pctx.fillText(m.label, px + (flip ? -3 : 3), area.top + 2 + row * 10);
                    });
                    pctx.restore();
                }
            };

            elevationChartInstance = new Chart(ctx, {
                type: 'line',
                plugins: [markerPlugin],
                data: {
                    datasets: [{
                        data: points,
                        borderColor: theme.accent,
                        backgroundColor: theme.accentFill,
                borderWidth: 1.5,
                pointRadius: 0,
                fill: true,
                tension: 0.15
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            parsing: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => items[0].parsed.x.toFixed(2) + ' km',
                        label: (item) => {
                            const g = pointGrades[item.dataIndex];
                            if (!Number.isFinite(g)) return Math.round(item.parsed.y) + ' m';
                            const sign = g < -0.05 ? '−' : '';
                            return Math.round(item.parsed.y) + ' m · ~' + sign + Math.abs(g).toFixed(1) + '%';
                        }
                    }
                }
            },
            scales: {
                x: {
                    // A linear distance axis. A category axis with a tick
                    // callback mislabelled the ticks, because the callback
                    // index is the tick position, not the data index.
                    type: 'linear',
                    // bounds 'ticks' (the default) stretches the axis to
                    // the next whole tick, leaving a blank strip after the
                    // route ends. 'data' stops it exactly at the last point.
                    bounds: 'data',
                    grid: { color: theme.grid },
                    ticks: {
                        color: theme.tick, font: { size: 10 }, maxTicksLimit: 8,
                        callback: (value) => (Math.round(value * 10) / 10) + ' km'
                    }
                },
                y: {
                    grid: { color: theme.grid },
                    ticks: { color: theme.tick, font: { size: 10 } }
                }
            }
        }
    });

    note.innerText = 'Elevation smoothed over ' + routeStats.smoothingWindow +
        ' point(s), gain threshold ' + AvinoxRoute.constants.ELEVATION_THRESHOLD_M + ' m.';

    const elevState = document.getElementById('elevationState');
    if (elevState && routeStats.ok) {
        elevState.innerText = '+' + Math.round(routeStats.elevationGainM) + ' m / −'
            + Math.round(routeStats.elevationLossM) + ' m';
    }

    /* Hovering the profile drives the cursor (on the map and on the graphs)
       for a recording as well as for a planned route. */
    wireElevationCursor(elevationChartInstance);
}

/* One drop zone for both kinds of input: a planned route (.gpx/.kml) and
   recorded rides (.proto). The extension decides the pipeline; dropped
   files of both kinds in the same batch are all handled. */
(function initRouteInput() {
    const drop = document.getElementById('routeDropZone');
    const input = document.getElementById('routeFileInput');
    if (!drop || !input) return;

    const isProto = (f) => /\.proto$/i.test(f.name);

    const handleFiles = async (list) => {
        const files = Array.from(list || []);
        if (!files.length) return;
        const protos = files.filter(isProto);
        const route = files.find((f) => !isProto(f));
        if (!protos.length && !route) {
            setFileStatus('Unsupported file: use .gpx, .kml or .proto.', 'error');
            return;
        }
        /* A route file and recordings are two different things: the tab
           holds one at a time, so a mixed drop keeps only the route file
           (recordings are reloaded on their own to switch back). */
        if (protos.length && route) {
            await handleRouteFile(route);
            setFileStatus('Loaded ' + route.name + '. A route file and recordings cannot be loaded together: reload the .proto file(s) on their own to analyze a ride instead.', 'info');
            return;
        }
        if (route) await handleRouteFile(route);
        else await handleProtoFiles(protos);
    };

    drop.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
        handleFiles(input.files);
        input.value = '';
    });

    ['dragenter', 'dragover'].forEach((ev) => {
        drop.addEventListener(ev, (e) => {
            e.preventDefault();
            drop.classList.add('border-green-500');
        });
    });
    ['dragleave', 'drop'].forEach((ev) => {
        drop.addEventListener(ev, (e) => {
            e.preventDefault();
            drop.classList.remove('border-green-500');
        });
    });
    drop.addEventListener('drop', (e) => {
        if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
    });
})();

document.getElementById('missionForm').addEventListener('submit', async (e) => {
    e.preventDefault();

    const selectedBattery = selectedBatteryWh();
    const data = {
        bike: document.getElementById('bike').value,
        battery: selectedBatteryId(),
        batteryWh: selectedBattery,
        riderWeight: document.getElementById('riderWeight').value,
        bikeWeight: document.getElementById('bikeWeight').value,
        cadence: document.getElementById('cadence').value,
        riderPower: document.getElementById('riderPower').value,
        targetKm: document.getElementById('targetKm').value,
        targetH_m: document.getElementById('targetH_m').value,
        surface: document.getElementById('surface').value,
        surfaceMix: getSurfaceMix(),
        reservePercent: document.getElementById('reservePercent').value,
        gradeDistribution: (routeGrades && routeGrades.ok) ? routeGrades.distribution : null,
        climbSummary: (routeGrades && routeGrades.ok) ? routeGrades.climbSummary : null,
        elevationQuality: (routeStats && routeStats.ok) ? routeStats.quality : null
    };

    /* Which consumption the estimate is scaled by - and every estimate says
       which, because they legitimately differ:
       - a recording is scaled by ITS OWN measurement (the file's numbers);
       - a planned route has none, so the calibration (what all the rides
         loaded so far averaged) scales it. */
    lastFactorSource = null;
    if (selectedRideMetrics && selectedRideMetrics.whPerKm > 0 && selectedRideMetrics.km > 1) {
        data.realWhPerKm = selectedRideMetrics.whPerKm;
        data.realKm = Math.round(selectedRideMetrics.km * 10) / 10;
        data.realHm = Math.round(selectedRideMetrics.hm);
        data.realEfficiency = selectedRideMetrics.efficiency.efficiency;
        /* The recording IS the route: same surface, same grades. */
        data.realSurface = data.surface;
        data.realSurfaceMix = data.surfaceMix;
        data.realSteepShare = data.climbSummary ? data.climbSummary.steepShare : 0;
        lastFactorSource = 'ride';
    } else {
        const calibration = calibrationPayload();
        if (calibration) {
            Object.assign(data, calibration);
            lastFactorSource = 'calibration';
        }
    }

    try {
        const response = await axios.post('/api/calculate-mission', data);
        const res = response.data;

        /* Results exist now: show them and hide the empty state. */
        document.getElementById('missionResults').classList.remove('hidden');
        document.getElementById('missionEmpty').classList.add('hidden');

        /* When a recording is analysed, show its own measured consumption next
           to the calibration average: the two numbers differ on purpose. */
        const selRow = document.getElementById('calibrationSelectedRow');
        const selVal = document.getElementById('calibrationSelectedRide');
        if (selRow && selVal) {
            if (selectedRideMetrics) {
                selRow.classList.remove('hidden');
                selVal.innerText = selectedRideMetrics.whPerKm + ' Wh/km · ' + selectedRideMetrics.km + ' km';
            } else {
                selRow.classList.add('hidden');
                selVal.innerText = '—';
            }
        }

        /* The map needs a visible container to size itself: on the first
           analysis it is built here, after the results are shown. */
        if (routePoints.length) renderRouteMap(routePoints);

        /* Say which input these numbers describe: a loaded file, a
           recording, or the values typed by hand. */
        const srcEl = document.getElementById('analysisSource');
        if (srcEl) {
            srcEl.innerText = analysisSourceLabel
                ? 'Analysis source: ' + analysisSourceLabel
                : 'Analysis source: manual entry';
        }

        renderEnergyCard(res, selectedBattery);

        // Phase 3: propose custom modes tailored to this route.
        try {
            const modesResponse = await axios.post('/api/route-modes', data);
            renderRouteModes(modesResponse.data);
        } catch (e) {
            document.getElementById('routeModes').classList.add('hidden');
        }
    } catch(err) {
        alert('Mission analysis failed.');
    }
});

window.addEventListener('DOMContentLoaded', () => {
    restoreForm();
    initSurfaceMix();
    updateSetup();
    initCalibration();
    initKbDialog();
    initResetDefaults();
    initChartModal();
    initRideSummaryDialog();
    initAppReset();
    initInstallButton();
    initRouteSections();
    initTunerCalibrationCta();
    initDataTransfer();
    initPresetState();
    initTunerLiveInputs();
    initWelcomeCard();
    initSidebarLinks();
    /* Bring back what was loaded last time (IndexedDB), quietly: same load
       path, no notice, no "rides analyzed" dialog. */
    restoreStoredFiles().then(() => updateRouteLoadState());
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').catch(() => { /* offline support unavailable */ });
    }
});

/* Analyse one recorded ride as the route: build the same track data a
   GPX/KML import would produce (stats, grade distribution, elevation
   profile) from that ride's GPS, then run the analysis. Merging several
   rides into one track would concatenate unrelated recordings (huge fake
   gaps) and break the grade analysis, so it is one at a time. */
function measureRide(ride) {
    /* This ride's own numbers, measured the same way the calibration is:
       reusing analyzeRideForCalibration on a single ride keeps one definition
       of "real consumption" in the app. `wh` is the measured motor energy,
       which becomes the headline for a replay. */
    try {
        const own = analyzeRideForCalibration({ metadata: ride.metadata, samples: ride.samples });
        const km = parseFloat(own.summary.distanceKm);
        if (!(own.summary.whPerKm > 0) || !(km > 1)) return null;
        const efficiency = ridesPackEfficiency([ride]);
        return {
            whPerKm: own.summary.whPerKm,
            km: km,
            hm: ride.metadata.ascent || 0,
            wh: own.summary.totalWh,
            efficiency: efficiency,
            packWh: own.summary.totalWh / efficiency.efficiency
        };
    } catch (e) {
        return null;
    }
}

function analyzeSelectedRide(index) {
    if (!loadedRides.length) return;
    const i = (typeof index === 'number' && loadedRides[index]) ? index : Math.min(selectedRideIndex, loadedRides.length - 1);
    const ride = loadedRides[i];
    if (!ride) return;
    selectedRideIndex = i;

    /* A recording brings its own map (with the channel selector): the planned-
       route map would only duplicate it. */
    routePoints = [];
    destroyRouteMap();

    const points = rideTrackPoints(ride);

    if (points.length > 1 && typeof AvinoxRoute !== 'undefined') {
        routeStats = AvinoxRoute.computeStats(points);
        routeGrades = AvinoxRoute.computeGradeStats(points);
        analysisSourceLabel = ride.label || 'recorded ride';
        /* Distance: the bike's odometer is what was actually ridden (and it is
           the denominator of the measured Wh/km, and what the DJI app shows);
           the GPS sum under-reads it by a few percent. GPS stays in charge of
           grades, elevation and the profile. */
        const odoKm = (ride.samples.at(-1) || {}).distanceKm || 0;
        if (odoKm > 0.1 && routeStats.ok) {
            routeStats.gpsDistanceKm = routeStats.distanceKm;
            routeStats.distanceKm = odoKm;
        }
        /* Same for the gain: the ride's own ascent is what its measured
           consumption was spent on, so a replay compares the recording with
           itself instead of with a GPS re-derivation of it. */
        const ascent = ride.metadata.ascent || 0;
        if (ascent > 0 && routeStats.ok && routeStats.elevationStatus === 'available') {
            routeStats.gpsElevationGainM = routeStats.elevationGainM;
            routeStats.elevationGainM = ascent;
        }
        /* This ride's own measured consumption: the analysis of a recording
           uses the recording's own numbers, not the average over the library
           (that average is what the Tuner projects from). */
        selectedRideMetrics = measureRide(ride);
        renderFileSummary();
        /* No elevation profile for a recording: the graph stack already has
           "Elevation & Gradient" with the same data, and showing the same
           chart twice only makes the page longer. */
        hideElevationProfile();
        renderRouteAnalysis();
    } else {
        const realKm = (ride.samples.at(-1) || {}).distanceKm || 0;
        const realHm = ride.metadata.ascent || 0;
        if (realKm > 0.1) document.getElementById('targetKm').value = (Math.round(realKm * 10) / 10).toFixed(1);
        if (realHm > 0) document.getElementById('targetH_m').value = Math.round(realHm);
        analysisSourceLabel = ride.label || 'recorded ride';
        selectedRideMetrics = measureRide(ride);
    }

    document.getElementById('missionForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

/* Popup shown right after rides are parsed: explains what changed, shows
   the before/after of the estimates and offers the riding-style action. */
function showRideSummary(before, after, analysis) {
    const dlg = document.getElementById('rideSummaryDialog');
    const body = document.getElementById('rideSummaryBody');
    if (!dlg || !body || !after) return;
    const s = analysis.summary;
    const modes = [['eco', 'ECO'], ['auto', 'AUTO'], ['trail', 'TRAIL'], ['turbo', 'TURBO']];
    const rows = before ? modes.map(([k, label]) =>
        '<tr><td>' + label + '</td><td>' + before[k].range + ' km</td>' +
        '<td><strong>' + after[k].range + ' km</strong></td></tr>').join('') : '';

    body.innerHTML =
        '<p class="ride-summary-lead">Your rides are now the basis for the range and runtime estimates.</p>' +
        '<div class="kv"><div class="kv-row"><span class="kv-label">Measured consumption</span>' +
        '<span class="kv-value">' + (s.whPerKm ?? '?') + ' Wh/km</span></div>' +
        '<div class="kv-row"><span class="kv-label">Distance analyzed</span>' +
        '<span class="kv-value">' + s.distanceKm + ' km · ' + loadedRides.length + ' ride(s)</span></div>' +
        '<div class="kv-row"><span class="kv-label">Your riding style</span>' +
        '<span class="kv-value">' + (s.avgCadence ?? '?') + ' RPM · ' + (s.avgRiderPower ?? '?') + ' W</span></div></div>' +
        (rows ? '<table class="kb-table ride-summary-table"><thead><tr><th>Mode</th><th>Standard</th><th>Your rides</th></tr></thead><tbody>' + rows + '</tbody></table>' : '') +
        '<p class="hint">"Use my riding style" also copies your real cadence and power into the Tuner, so the suggested levels match how you actually ride.</p>';

    if (typeof dlg.showModal === 'function') dlg.showModal();
}

function initRideSummaryDialog() {
    const dlg = document.getElementById('rideSummaryDialog');
    if (!dlg) return;
    const close = () => dlg.close();
    document.getElementById('rideSummaryClose').addEventListener('click', close);
    document.getElementById('rideSummaryView').addEventListener('click', () => {
        close();
        document.getElementById('rideInsights').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.getElementById('rideSummaryApply').addEventListener('click', () => {
        const s = lastRideAnalysis && lastRideAnalysis.summary;
        if (s && s.avgCadence && s.avgRiderPower) {
            document.getElementById('cadence').value = s.avgCadence;
            document.getElementById('riderPower').value = s.avgRiderPower;
            saveForm();
            updateSetup();
        }
        close();
        switchTab('calc');
        window.scrollTo({ top: 0, behavior: 'smooth' });
    });
}

/* PWA install button: mobile only. Chrome/Android fires
   beforeinstallprompt and we trigger it; iOS Safari cannot be prompted,
   so the button shows the Add-to-Home-Screen instructions instead. */
function initInstallButton() {
    const btn = document.getElementById('installApp');
    if (!btn) return;
    const ua = navigator.userAgent;
    const isMobile = (navigator.userAgentData && navigator.userAgentData.mobile)
        || /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const standalone = window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
    if (!isMobile || standalone) return; // desktop or already installed

    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferred = e;
        btn.classList.remove('hidden');
    });
    window.addEventListener('appinstalled', () => btn.classList.add('hidden'));

    const isIos = /iPhone|iPad|iPod/i.test(ua);
    if (isIos) btn.classList.remove('hidden'); // instructions path

    btn.addEventListener('click', async () => {
        if (deferred) {
            deferred.prompt();
            try { await deferred.userChoice; } catch (e) { /* ignore */ }
            deferred = null;
            btn.classList.add('hidden');
            return;
        }
        showInstallHint();
    });
}

function showInstallHint() {
    const existing = document.getElementById('installHint');
    if (existing) { existing.remove(); return; }
    const el = document.createElement('div');
    el.id = 'installHint';
    el.className = 'install-hint';
    el.innerHTML = 'To install: tap <strong>Share</strong> in the browser, then <strong>Add to Home Screen</strong>.';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
}

/* Reset the rider form to the project defaults (useful after applying
   ride averages from the calibration). */
const FORM_DEFAULTS = {
    bike: 'M2S', battery: 'FS800', boostDuration: '30',
    riderWeight: '82', bikeWeight: '23', cadence: '75', riderPower: '200',
    ecoWkg: '1.36', autoWkg: '2.73', trailWkg: '5.45', turboWkg: '7.72'
};

function applyFormDefaults() {
    Object.entries(FORM_DEFAULTS).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value;
    });
    markActivePreset();   // the defaults are the Balanced profile
}

function initResetDefaults() {
    const btn = document.getElementById('resetDefaults');
    if (!btn) return;
    btn.addEventListener('click', () => {
        applyFormDefaults();
        saveForm();
        scheduleFromTuner();
    });
}

/* Drop the loaded ride library: charts, map, selector and the ride-derived
   analysis. The calibration is NOT touched - it is a measurement stored on
   the device, not part of the loaded files (see resetApp for a full wipe). */
/* Remove stored records of the given kinds (ids are read back, so no key
   has to be reconstructed). */
function purgeStored(kinds) {
    idbReadAll().then((all) => {
        const ids = all.filter((r) => kinds.indexOf(r.kind) >= 0).map((r) => r.id);
        if (ids.length) idbRemove(ids);
    });
}

function clearRides() {
    loadedRides = [];
    selectedRideIndex = 0;
    graphOrder = null;
    rideCharts.forEach((c) => c.destroy());
    rideCharts = [];
    if (modalChart) { modalChart.destroy(); modalChart = null; }
    if (rideMap) { rideMap.remove(); rideMap = null; }
    rideMapPoints = [];
    lastRideAnalysis = null;
    const graphs = document.getElementById('rideGraphs');
    if (graphs) graphs.innerHTML = '';
    const picker = document.getElementById('rideSelector');
    if (picker) picker.innerHTML = '';
    const mapLegend = document.getElementById('mapLegend');
    if (mapLegend) mapLegend.innerHTML = '';
    const ridePicker = document.getElementById('ridePickerRow');
    if (ridePicker) ridePicker.classList.add('hidden');
    const calReport = document.getElementById('calibrationReport');
    if (calReport) calReport.innerHTML = '';
    const rideMapBox = document.getElementById('rideMap');
    if (rideMapBox) rideMapBox.innerHTML = '';
    /* The stored copies go with them: the library is what the calibration was
       measured from, and the two must not disagree after a refresh. */
    purgeStored(['ride', 'state']);
    renderCalibrationState();
    renderRideInsights();
}

/* Drop the loaded route file: geometry picker, file summary and the track
   it contributed. The analysis panel is refilled by whoever loads next. */
function clearRouteFile() {
    parsedRoute = null;
    selectedGeometries = [];
    routeFileName = null;
    routePoints = [];
    selectedRideMetrics = null;
    destroyRouteMap();
    purgeStored(['route']);
    const summary = document.getElementById('fileSummary');
    if (summary) summary.innerHTML = '';
    ['geometryPanel', 'geometryPicker', 'fileSummary']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
}

/* Clear all: drop the loaded rides, the calibration and reset the form. */
/* Total reset: rides, calibration, route analysis, forms and saved
   settings. Reachable from the header ("Clear all data"). */
function resetApp() {
    if (!window.confirm('Clear all data? This removes the loaded routes and rides, the calibration, the route analysis and any saved settings.')) return;

    try {
        ['avinox-form', 'avinox-calibration', 'avinox-calibration-notes', 'avinox-graph-order', 'avinox-pinned-graphs']
            .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
    idbClearAll();

    /* Rides (the calibration is in localStorage and is removed above). */
    clearRides();
    lastCalcRes = null;

    /* Route / analysis */
    clearRouteFile();
    routeStats = null;
    routeGrades = null;
    analysisSourceLabel = null;
    const srcLabel = document.getElementById('analysisSource');
    if (srcLabel) srcLabel.innerText = '';
    const missionResults = document.getElementById('missionResults');
    if (missionResults) missionResults.classList.add('hidden');
    const missionEmpty = document.getElementById('missionEmpty');
    if (missionEmpty) missionEmpty.classList.remove('hidden');
    ['routeAnalysis', 'routeModes', 'elevationPanel', 'fileSummary', 'geometryPanel', 'geometryPicker']
        .forEach((id) => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    const verdict = document.getElementById('energyVerdict');
    if (verdict) { verdict.innerText = '--'; verdict.className = 'badge badge-soft'; }
    resetEnergyCard();
    ['gradeBars', 'climbList', 'descentList', 'routeModesGrid', 'routeModeNotes'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
    const routeFile = document.getElementById('routeFileInput');
    if (routeFile) routeFile.value = '';
    const fileStatus = document.getElementById('fileStatus');
    if (fileStatus) { fileStatus.className = 'file-status'; fileStatus.innerText = ''; }
    const targetKm = document.getElementById('targetKm');
    if (targetKm) targetKm.value = '70';
    const targetH = document.getElementById('targetH_m');
    if (targetH) targetH.value = '1500';
    applySurfacePreset('mixed');
    const reserve = document.getElementById('reservePercent');
    if (reserve) reserve.value = '15';

    /* Tuner */
    applyFormDefaults();
    if (typeof updateSetup === 'function') updateSetup();

    renderCalibrationState();
    renderRideInsights();
    resetRouteSections();
}

/* Full reset: one global action, in the header (the Route tab and the
   Knowledge Base no longer carry their own copy). */
function initAppReset() {
    const btn = document.getElementById('resetAppBtn');
    if (btn) btn.addEventListener('click', resetApp);
}

/* Enlarged chart modal. */
function initChartModal() {
    const dlg = document.getElementById('chartModal');
    const closeBtn = document.getElementById('chartModalClose');
    if (!dlg || !closeBtn) return;
    closeBtn.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => {
        if (modalChart) { modalChart.destroy(); modalChart = null; }
    });
}

/* Knowledge Base as a modal dialog (like the ARE "?" button). */
function initKbDialog() {
    const dlg = document.getElementById('tabGuide');
    const openBtn = document.getElementById('kbOpenBtn');
    const closeBtn = document.getElementById('kbCloseBtn');
    if (!dlg || !document.getElementById('kbOpenBtn')) return;
    document.getElementById('kbOpenBtn').addEventListener('click', () => {
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
    });
    const close = document.getElementById('kbCloseBtn');
    if (close) close.addEventListener('click', () => dlg.close());
    dlg.querySelectorAll('.kb-nav a').forEach((a) => {
        a.addEventListener('click', () => { if (dlg.open) dlg.close(); });
    });
}

/* Theme toggle (dark variant): persists the choice and re-renders the
   charts, which read their colours from the CSS custom properties. */
(function initThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const root = document.documentElement;
    const apply = (theme) => {
        root.setAttribute('data-theme', theme);
        btn.querySelector('.tt-icon').textContent = theme === 'dark' ? '☼' : '☾';
        btn.querySelector('.tt-label').textContent = theme === 'dark' ? 'Light' : 'Dark';
        btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', theme === 'dark' ? '#1A1E23' : '#F2F0E8');
    };
    const stored = localStorage.getItem('avinox-theme');
    apply(stored === 'dark' || stored === 'light' ? stored : root.getAttribute('data-theme') || 'light');
    btn.addEventListener('click', () => {
        const next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('avinox-theme', next); } catch (e) { /* ignore */ }
        apply(next);
        if (typeof updateSetup === 'function') updateSetup();
        /* The map colours come from the theme tokens: redraw after a switch. */
        if (routeMap && routePoints.length) renderRouteMap(routePoints);
    });
})();

/* Route Simulator chip (E1): shows which motor/battery the mission analysis
   inherits from the Engine Tuner form. Read-only — no effect on the math. */
(function initSetupChip() {
    const chip = document.getElementById('missionSetupChip');
    if (!chip) return;
    const update = () => {
        const bike = document.getElementById('bike');
        if (!bike) return;
        chip.innerText = 'Using ' + bike.value + ' · ' + selectedBatteryId() + ' ' + selectedBatteryWh() +
            ' Wh — set in Engine Tuner';
    };
    document.getElementById('bike').addEventListener('change', update);
    document.getElementById('battery').addEventListener('change', update);
    update();
})();

/* ---- Collapsible Route sections --------------------------------------- */
/* The three step cards keep a state summary in their always-visible header:
   collapsing is only useful if the header still says what is inside. The
   actions (loader, ride picker, Analyze) live in the header too, outside the
   toggle, so they never disappear with the body. */

let routeSectionsAuto = true;   // per session; "Show all" turns it off

const ROUTE_SECTIONS = {
    load: { card: 'routeLoadCard', toggle: 'routeLoadToggle', body: 'routeLoadBody' },
    rideData: { card: 'rideInsights', toggle: 'rideDataToggle', body: 'rideDataBody' },
    calibration: { card: 'ridesCalibration', toggle: 'calibrationToggle', body: 'calibrationBody' },
    /* The analysis blocks follow the same rule: the verdict and the energy
       card stay visible, the details are one click away and their header
       carries the figure that matters. */
    routeAnalysis: { card: 'routeAnalysis', toggle: 'routeAnalysisToggle', body: 'routeAnalysisBody' },
    routeMap: { card: 'routeMapPanel', toggle: 'routeMapToggle', body: 'routeMapBody' },
    routeModes: { card: 'routeModes', toggle: 'routeModesToggle', body: 'routeModesBody' },
    elevation: { card: 'elevationPanel', toggle: 'elevationToggle', body: 'elevationBody' }
};

/* Mirrors the order they appear in on the page: analysis, the modes it
   proposes, then the map and the profile. */
const ANALYSIS_SECTIONS = ['routeAnalysis', 'routeModes', 'routeMap', 'elevation'];

function routeSectionOpen(key) {
    const def = ROUTE_SECTIONS[key];
    const body = def && document.getElementById(def.body);
    return !!body && !body.classList.contains('hidden');
}

function graphsOpen() {
    const wrap = document.getElementById('rideGraphsWrap');
    return !!wrap && !wrap.classList.contains('hidden');
}

/* A container that was display:none has no measured size: charts and maps
   must be told to re-measure or they come back blank (or 0x0). Only the ones
   whose own body is open. */
function refreshSizedWidgets() {
    if (rideMap && routeSectionOpen('rideData')) {
        try { rideMap.resize(); } catch (e) { /* ignore */ }
        /* A map fitted while hidden has the wrong zoom: re-fit now that it has
           a size. Only when it still needs it, so opening another section does
           not throw away a pan/zoom the user made. */
        if (rideMapNeedsFit) fitRouteBounds();
    }
    if (routeMap && routeSectionOpen('routeMap')) {
        try { routeMap.resize(); } catch (e) { /* ignore */ }
        if (routeMapNeedsFit) fitRouteMapBounds();
    }
    if (elevationChartInstance && routeSectionOpen('elevation')) {
        try { elevationChartInstance.resize(); } catch (e) { /* ignore */ }
    }
    if (routeSectionOpen('rideData') && graphsOpen()) {
        rideCharts.forEach((c) => { try { c.resize(); } catch (e) { /* ignore */ } });
    }
}

function setRouteSection(key, open) {
    const def = ROUTE_SECTIONS[key];
    if (!def) return;
    const body = document.getElementById(def.body);
    const toggle = document.getElementById(def.toggle);
    if (!body || !toggle) return;
    body.classList.toggle('hidden', !open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const head = toggle.closest('.step-head');
    if (head) head.classList.toggle('is-collapsed', !open);
    if (open) requestAnimationFrame(refreshSizedWidgets);
}

function setGraphsOpen(open) {
    const wrap = document.getElementById('rideGraphsWrap');
    const btn = document.getElementById('graphsToggle');
    if (!wrap || !btn) return;
    wrap.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chev = btn.querySelector('.graph-toggle-chevron');
    if (chev) chev.style.transform = open ? 'rotate(90deg)' : '';
    if (open) requestAnimationFrame(refreshSizedWidgets);
}

function showRouteNotice(text) {
    const el = document.getElementById('routeNotice');
    const txt = document.getElementById('routeNoticeText');
    if (!el || !txt) return;
    txt.innerText = text;
    el.classList.remove('hidden');
    if (routeNoticeTimer) clearTimeout(routeNoticeTimer);
    routeNoticeTimer = setTimeout(hideRouteNotice, 9000);
}

let routeNoticeTimer = null;

function hideRouteNotice() {
    const el = document.getElementById('routeNotice');
    if (el) el.classList.add('hidden');
    if (routeNoticeTimer) { clearTimeout(routeNoticeTimer); routeNoticeTimer = null; }
}

/* After something is loaded, shorten the page - and say so, with a way back
   to the full view (which also stops the automatic collapsing for the rest
   of the session: the user asked for it once). `quiet` is for a restore on
   page load: same layout, no announcement. */
function collapseAfterLoad(kind, opts) {
    if (!routeSectionsAuto) return;
    const quiet = !!(opts && opts.quiet);
    setRouteSection('load', false);
    setRouteSection('calibration', false);
    if (kind === 'ride') setGraphsOpen(false);
    /* A new input means new figures: the details of the previous one must not
       stay expanded under the new result. */
    ANALYSIS_SECTIONS.forEach((key) => setRouteSection(key, false));
    if (quiet) return;
    showRouteNotice(kind === 'ride'
        ? 'Rides loaded: the loader and the calibration are collapsed, and the graphs are one click away.'
        : 'Route loaded: the loader is collapsed to keep the page short. Open it again to change the file.');
}

/* Header summary of card 1: what is loaded and with which parameters. The
   parameters matter because they can be edited by hand - if they are not
   visible while the card is collapsed, Analyze would run blind. */
function updateRouteLoadState() {
    const el = document.getElementById('routeLoadState');
    if (!el) return;
    const km = (document.getElementById('targetKm') || {}).value || '';
    const hm = (document.getElementById('targetH_m') || {}).value;
    const surfaceTxt = surfaceMixHeadline();
    const ride = loadedRides[selectedRideIndex];

    let what = analysisSourceLabel || (ride ? ride.label : null) || 'Nothing loaded yet';
    const params = [
        km ? km + ' km' : '',
        (hm === '' || hm == null) ? '' : '+' + hm + ' m',
        surfaceTxt,
        (document.getElementById('reservePercent') || {}).value ? 'reserve ' + document.getElementById('reservePercent').value + '%' : ''
    ].filter(Boolean).join(' · ');
    el.innerText = params ? what + ' — ' + params : what;

    const changeBtn = document.getElementById('changeFileBtn');
    if (changeBtn) changeBtn.classList.toggle('hidden', !(analysisSourceLabel || loadedRides.length));
    const exportBtn = document.getElementById('exportGpxBtn');
    if (exportBtn) exportBtn.classList.toggle('hidden', !hasExportableTrack());
    surfaceOsmButtonState();
}

function initRouteSections() {
    const exportGpx = document.getElementById('exportGpxBtn');
    if (exportGpx) exportGpx.addEventListener('click', exportTrackGpx);

    Object.keys(ROUTE_SECTIONS).forEach((key) => {
        const toggle = document.getElementById(ROUTE_SECTIONS[key].toggle);
        if (toggle) toggle.addEventListener('click', () => setRouteSection(key, !routeSectionOpen(key)));
    });

    const graphsToggle = document.getElementById('graphsToggle');
    if (graphsToggle) graphsToggle.addEventListener('click', () => setGraphsOpen(!graphsOpen()));

    const showAll = document.getElementById('routeNoticeShowAll');
    if (showAll) {
        showAll.addEventListener('click', () => {
            routeSectionsAuto = false;
            Object.keys(ROUTE_SECTIONS).forEach((key) => setRouteSection(key, true));
            setGraphsOpen(true);
            hideRouteNotice();
        });
    }
    const noticeClose = document.getElementById('routeNoticeClose');
    if (noticeClose) noticeClose.addEventListener('click', hideRouteNotice);

    const changeBtn = document.getElementById('changeFileBtn');
    if (changeBtn) {
        changeBtn.addEventListener('click', () => {
            const input = document.getElementById('routeFileInput');
            if (input) input.click();
        });
    }

    /* The parameters are part of the collapsed header: keep it in step. */
    ['targetKm', 'targetH_m', 'surface', 'reservePercent'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.addEventListener('input', updateRouteLoadState); el.addEventListener('change', updateRouteLoadState); }
    });
    updateRouteLoadState();
}

/* "Not calibrated" is the moment to suggest the way out of generic numbers:
   the Tuner sends the user to the Route loader and highlights it. */
function initTunerCalibrationCta() {
    const btn = document.getElementById('goToLoaderBtn');
    if (!btn) return;
    btn.addEventListener('click', () => {
        switchTab('route');
        /* Deliberate navigation: do not re-collapse the loader under them. */
        routeSectionsAuto = false;
        setRouteSection('load', true);
        const dz = document.getElementById('routeDropZone');
        if (dz) {
            dz.scrollIntoView({ behavior: 'smooth', block: 'center' });
            dz.classList.add('is-prompted');
            setTimeout(() => dz.classList.remove('is-prompted'), 3500);
        }
        setFileStatus('Drop your .proto ride recordings here to calibrate.', 'info');
    });
}

function resetRouteSections() {
    routeSectionsAuto = true;
    hideRouteNotice();
    setRouteSection('load', true);
    setGraphsOpen(false);
    ANALYSIS_SECTIONS.forEach((key) => setRouteSection(key, false));
}

/* The energy card: four blocks with a big number each, the factor and the
   reserve as badges, the physics as rows and the mode split as a stacked bar
   with one chip per mode (the pie said the same thing with less clarity). */
const MODE_KEYS = ['eco', 'auto', 'trail', 'turbo'];

function renderEnergyCard(res, selectedBattery) {
    const en = res.energy;
    const set = (id, txt) => { const el = document.getElementById(id); if (el) el.innerText = txt; };
    /* A recording carries its own measurement: that is the headline, and the
       model projection becomes the comparison. A planned route has no
       measurement, so there the projection IS the number. */
    const measured = (lastFactorSource === 'ride' && selectedRideMetrics
        && Number.isFinite(selectedRideMetrics.wh)) ? selectedRideMetrics : null;

    /* One number drives the headline, the verdict and the cushion: for a
       recording the battery energy it actually used, otherwise the estimate. */
    const used = measured ? Math.round(measured.packWh) : en.estimated;
    const feasible = measured ? used <= res.usableWh : res.feasible;
    const verdict = document.getElementById('energyVerdict');
    if (verdict) {
        verdict.innerText = feasible ? 'FEASIBLE' : 'CRITICAL MARATHON';
        verdict.className = 'badge ' + (feasible ? 'badge-ok' : 'badge-warn');
    }

    if (measured) {
        set('energyUseTitle', 'Measured use');
        set('energyEstimated', used);
        set('energyRange', 'from the battery · ' + Math.round(measured.wh) + ' Wh motor at '
            + Math.round(measured.efficiency.efficiency * 100) + '%'
            + (measured.efficiency.measured ? '' : ' (default)'));
        set('energyBaseline', 'Model projection: ' + en.estimated + ' Wh (' + en.low + '–' + en.high + ' Wh)');
    } else {
        set('energyUseTitle', 'Estimated use');
        set('energyEstimated', en.estimated);
        set('energyRange', en.low + '–' + en.high + ' Wh');
        set('energyBaseline', 'Baseline: ' + en.base + ' Wh (' + en.flat + ' flat + ' + en.climb + ' climb)');
    }
    set('energyUsable', res.usableWh);
    set('energyPack', 'of ' + selectedBattery + ' Wh pack');
    set('energyCushion', 'Safety cushion: ' + Math.max(0, res.usableWh - used) + ' Wh remaining at the finish');
    set('energyDistributionTotal', used + ' Wh');

    const reserveBadge = document.getElementById('energyReserveBadge');
    if (reserveBadge) {
        reserveBadge.classList.remove('hidden');
        reserveBadge.innerText = res.reserve.percent + '% Reserve';
    }

    /* Where the personal factor comes from, in the badge instead of a banner -
       and when the measurement was refused, it says that instead of applying
       it silently. */
    const calBadge = document.getElementById('energyCalBadge');
    const factorNote = document.getElementById('energyFactorNote');
    if (calBadge) {
        if (res.factorRejected) {
            calBadge.classList.remove('hidden');
            calBadge.className = 'badge badge-warn';
            calBadge.innerText = '×' + (res.factorRaw != null ? res.factorRaw : '?') + ' not applied';
            calBadge.title = 'The measurement on this input (' + (res.realWhPerKm ?? '?')
                + ' Wh/km) is outside the plausible range, so the personal factor was not applied.';
            if (factorNote) {
                factorNote.classList.remove('hidden');
                factorNote.innerText = 'Anomalous measurement (' + (res.realWhPerKm ?? '?') + ' Wh/km → ×'
                    + (res.factorRaw != null ? res.factorRaw : '?') + '): the personal factor is not applied, '
                    + 'these figures come from the generic model.';
            }
        } else if (res.basedOnRealRides) {
            const fromRide = lastFactorSource === 'ride' && !!selectedRideMetrics;
            calBadge.classList.remove('hidden');
            calBadge.className = 'badge badge-soft';
            calBadge.innerText = '×' + res.personalFactor.toFixed(2) + (fromRide ? ' this ride' : ' calibration');
            calBadge.title = fromRide
                ? 'Scaled by the consumption measured on this recording: ' + selectedRideMetrics.whPerKm
                    + ' Wh/km over ' + selectedRideMetrics.km + ' km'
                : 'Scaled by the calibration stored on this device';
            if (factorNote) { factorNote.classList.add('hidden'); factorNote.innerText = ''; }
        } else {
            calBadge.classList.add('hidden');
            calBadge.className = 'badge badge-soft';
            calBadge.innerText = '';
            calBadge.title = '';
            if (factorNote) { factorNote.classList.add('hidden'); factorNote.innerText = ''; }
        }
    }

    const confBadge = document.getElementById('energyConfidenceBadge');
    if (confBadge) {
        const level = String(res.confidence || '').toLowerCase();
        confBadge.classList.remove('hidden');
        confBadge.innerText = (res.confidence || '—') + ' conf.';
        confBadge.className = 'badge ' + (level === 'high' ? 'badge-ok' : (level === 'low' ? 'badge-warn' : 'badge-soft'));
    }

    const physics = document.getElementById('energyBreakdown');
    if (physics) {
        const throttle = Math.round(res.scalingFactor * 100);
        /* The mix response is new: fall back to the old single-surface factor
           when the server has not sent it (records before the change). */
        const surfaceFactor = res.surfaceMix && Number.isFinite(res.surfaceMix.factor)
            ? res.surfaceMix.factor
            : (res.surface && Number.isFinite(res.surface.factor) ? res.surface.factor : null);
        physics.innerHTML =
            (surfaceFactor != null ? kvRow('Surface resistance:', '×' + surfaceFactor.toFixed(2)) : '') +
            (res.surfaceMix ? kvRow('Surface mix:', surfaceMixText(res.surfaceMix) || '—') : '') +
            kvRow('Steepness factor:', '×' + res.steepnessFactor.toFixed(2)) +
            kvRow('Safety throttling:', '<span class="' + (throttle >= 100 ? 'energy-ok' : 'energy-warn') + '">'
                + throttle + '%</span> <span class="kv-hint">' + (throttle >= 100 ? '(no derate)' : '(derated)') + '</span>');
    }

    const dist = res.distribution || {};
    const bar = document.getElementById('modeBar');
    if (bar) {
        bar.innerHTML = MODE_KEYS.map((k) => {
            const pct = Math.max(0, Number(dist[k]) || 0);
            return '<span style="width:' + pct.toFixed(2) + '%;background:var(--mode-' + k + ')"></span>';
        }).join('');
    }
    const chips = document.getElementById('modeChips');
    if (chips) {
        chips.innerHTML = MODE_KEYS.map((k) => {
            const pct = Math.round(Number(dist[k]) || 0);
            return '<div class="mode-chip" data-mode="' + k + '"><strong>' + pct + '%</strong>' + k + '</div>';
        }).join('');
    }
}

/* Back to the empty card (a reset leaves #missionResults hidden anyway). */
function resetEnergyCard() {
    const title = document.getElementById('energyUseTitle');
    if (title) title.innerText = 'Estimated use';
    ['energyEstimated', 'energyUsable'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerText = '—';
    });
    ['energyRange', 'energyBaseline', 'energyPack', 'energyCushion', 'energyDistributionTotal', 'energyFactorNote']
        .forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.innerText = '';
        });
    const factorNote = document.getElementById('energyFactorNote');
    if (factorNote) factorNote.classList.add('hidden');
    ['energyCalBadge', 'energyReserveBadge', 'energyConfidenceBadge'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) { el.classList.add('hidden'); el.innerText = ''; }
    });
    ['energyBreakdown', 'modeBar', 'modeChips'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '';
    });
}

/* The Route analysis reads the Tuner's rider variables (bike, battery, weights,
   cadence, rider power - the per-mode W/kg sliders stay the Tuner's own thing),
   so a change there has to refresh it: leaving the Route page showing numbers
   computed with the previous rider is exactly the silent staleness this app
   keeps getting caught on. The W/kg sliders already recalculated the Tuner on
   every move; the rider fields did not recalculate anything, which is why the
   two pages could disagree.
   Debounced: the fields fire per keystroke. */
let tunerInputTimer = null;

function scheduleFromTuner() {
    if (tunerInputTimer) clearTimeout(tunerInputTimer);
    tunerInputTimer = setTimeout(() => {
        tunerInputTimer = null;
        if (typeof updateSetup === 'function') updateSetup();
        const results = document.getElementById('missionResults');
        if (!results || results.classList.contains('hidden')) return;
        document.getElementById('missionForm')
            .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    }, 400);
}

function initTunerLiveInputs() {
    ['bike', 'battery', 'riderWeight', 'bikeWeight', 'cadence', 'riderPower'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', scheduleFromTuner);
        el.addEventListener('change', scheduleFromTuner);
    });
}

function switchTab(tabName) {
    const workspaces = {
        calc: { tab: document.getElementById('tabCalc'), button: document.getElementById('tabCalcBtn') },
        route: { tab: document.getElementById('tabRoute'), button: document.getElementById('tabRouteBtn') }
    };

            Object.keys(workspaces).forEach((key) => {
                const active = key === tabName;
                workspaces[key].tab.classList.toggle('hidden', !active);
                workspaces[key].tab.classList.toggle('block', active);
                workspaces[key].button.classList.toggle('is-active', active);
                workspaces[key].button.setAttribute('aria-selected', active ? 'true' : 'false');
            });

            // The selected tab starts from its top: otherwise switching while
            // scrolled down lands mid-content (e.g. past the KB index).
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
