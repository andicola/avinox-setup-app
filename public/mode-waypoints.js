/**
 * Mode-change waypoints — where to switch assist mode along a route, and the
 * battery to expect there. They ride along in the exported GPX: Wikiloc,
 * Komoot or any navigation app that alerts at waypoints tells the rider, on
 * the watch or the phone, when to change mode without watching the profile.
 *
 * Everything comes from what the Route tab already computed; nothing new is
 * modelled here:
 *   - the climbs detected by route-file.js (start, end, gain, grade);
 *   - the custom modes proposed for the route (ENDURANCE, CLIMB, TECH, RESERVE);
 *   - the energy the energy card quotes, with the model's own flat / climb
 *     split, spread along the track by distance and gain.
 *
 * Pure helpers, no DOM, testable under Node.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AvinoxWaypoints = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var WIKILOC_MAX_WAYPOINTS = 25;  // Wikiloc imports at most 25 waypoints per trail (the strictest of the apps)
    var DEFAULT_LEAD_M = 100;        // the alert fires before the climb starts, not on it
    var MERGE_GAP_M = 300;           // two climbs with less than this between them are ridden as one
    var TECH_MIN_AVG_GRADE = 12;     // a climb this steep on average takes the TECH mode

    function round1(x) { return Math.round(x * 10) / 10; }
    /* Distances read like the climbs table in the app: one decimal, always. */
    function km1(x) { return Number(x).toFixed(1); }

    /** Profile points come with a cumulative distance that is left at 0 on
     *  skipped points (a new segment, a missing elevation): read it as a
     *  running maximum so the track never goes backwards. */
    function distances(profile) {
        var out = new Array(profile.length);
        var run = 0;
        for (var i = 0; i < profile.length; i++) {
            var d = Number.isFinite(profile[i].distanceM) ? profile[i].distanceM : 0;
            if (d > run) run = d;
            out[i] = run;
        }
        return out;
    }

    /**
     * Battery along the track. The total is the energy the analysis quotes;
     * its flat and climb parts are spread by distance and by positive gain
     * (gain from the window grades, the same the analysis measured), and
     * the whole is scaled so the end of the track lands on the total: surface,
     * steepness and the personal factor are already in that number.
     *
     * energy: { totalWh, flatWh, climbWh }
     * Returns { cumWh: [], pct: [], finishPct }
     */
    function batteryAlong(profile, energy, batteryWh, startPercent) {
        var dist = distances(profile);
        var n = profile.length;
        var step = new Array(n), gain = new Array(n);
        var totalD = 0, totalG = 0;
        for (var i = 0; i < n; i++) {
            var d = i > 0 ? Math.max(0, dist[i] - dist[i - 1]) : 0;
            var g = Number.isFinite(profile[i].grade) && profile[i].grade > 0 ? d * profile[i].grade / 100 : 0;
            step[i] = d; gain[i] = g; totalD += d; totalG += g;
        }
        var flat = Math.max(0, energy.flatWh || 0), climb = Math.max(0, energy.climbWh || 0);
        var total = Math.max(0, energy.totalWh || 0);
        if (flat + climb <= 0) { flat = 1; climb = 0; }
        if (totalG <= 0) { flat += climb; climb = 0; }
        var scale = total / (flat + climb);
        var cum = new Array(n), pct = new Array(n), acc = 0;
        var start = Number.isFinite(startPercent) ? startPercent : 100;
        for (var k = 0; k < n; k++) {
            acc += ((totalD > 0 ? flat * step[k] / totalD : 0) + (totalG > 0 ? climb * gain[k] / totalG : 0)) * scale;
            cum[k] = acc;
            pct[k] = batteryWh > 0 ? start - (100 * acc) / batteryWh : NaN;
        }
        return { cumWh: cum, pct: pct, finishPct: n ? pct[n - 1] : NaN, distances: dist };
    }

    /** Index of the last profile point at or before `distanceM`. */
    function indexAt(dist, distanceM) {
        var lo = 0, hi = dist.length - 1;
        while (lo < hi) {
            var mid = (lo + hi + 1) >> 1;
            if (dist[mid] <= distanceM) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    /** Position (lat, lon, ele) interpolated along the track at `distanceM`. */
    function positionAt(profile, dist, distanceM) {
        var i = indexAt(dist, distanceM);
        var a = profile[i], b = profile[Math.min(i + 1, profile.length - 1)];
        var span = dist[Math.min(i + 1, profile.length - 1)] - dist[i];
        var t = span > 0 ? Math.max(0, Math.min(1, (distanceM - dist[i]) / span)) : 0;
        var ele = Number.isFinite(a.ele) && Number.isFinite(b.ele) ? a.ele + (b.ele - a.ele) * t : (Number.isFinite(a.ele) ? a.ele : null);
        return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, ele: ele, index: i };
    }

    function modeLine(m) {
        return m.label + ' (level ' + m.assistLevel + ' · ' + m.maxPower + ' W · ' + m.maxTorque + ' Nm)';
    }
    function pctText(p) { return Number.isFinite(p) ? '~' + Math.max(0, Math.round(p)) + '%' : '—'; }
    function climbText(c) {
        return 'climb of ' + km1(c.distanceKm) + ' km, +' + Math.round(c.gainM) + ' m, avg ' + round1(c.averageGrade) + '%' +
            (Number.isFinite(c.maxGrade) ? ' (max ' + Math.round(c.maxGrade) + '%)' : '');
    }

    /**
     * The plan.
     *
     * opts: {
     *   profile      points of AvinoxRoute.computeGradeProfile(points)
     *   climbs       routeGrades.climbs
     *   modes        the proposed route modes (key, label, assistLevel, maxPower, maxTorque)
     *   energy       { totalWh, flatWh, climbWh }
     *   batteryWh, reservePercent, startPercent (100)
     *   leadM (100), maxWaypoints (25)
     * }
     * Returns { ok, reason?, waypoints, notes, finishPct, droppedClimbs }
     */
    function planModeWaypoints(opts) {
        var profile = opts.profile || [];
        if (profile.length < 2) return { ok: false, reason: 'no-track', waypoints: [], notes: [] };
        var modes = opts.modes || [];
        var byKey = {};
        modes.forEach(function (m) { byKey[m.key] = m; });
        var base = byKey.endurance || modes[0];
        if (!base) return { ok: false, reason: 'no-modes', waypoints: [], notes: [] };
        var climbMode = byKey.climb || null, techMode = byKey.tech || null, reserveMode = byKey.reserve || null;

        var lead = Number.isFinite(opts.leadM) ? opts.leadM : DEFAULT_LEAD_M;
        var cap = opts.maxWaypoints > 1 ? opts.maxWaypoints : WIKILOC_MAX_WAYPOINTS;
        var reservePct = Number.isFinite(opts.reservePercent) ? opts.reservePercent : 0;
        var battery = batteryAlong(profile, opts.energy || {}, opts.batteryWh, opts.startPercent);
        var dist = battery.distances;
        var total = dist[dist.length - 1];
        var notes = [];

        var climbs = (opts.climbs || []).filter(function (c) {
            return Number.isFinite(c.startKm) && Number.isFinite(c.endKm) && c.endKm > c.startKm;
        }).map(function (c) {
            var avg = Number.isFinite(c.averageGrade) ? c.averageGrade : 0;
            var mode = (techMode && avg >= TECH_MIN_AVG_GRADE) ? techMode : climbMode;
            return { climb: c, mode: mode, upAt: Math.max(0, c.startKm * 1000 - lead), downAt: Math.min(total, c.endKm * 1000) };
        }).filter(function (x) { return !!x.mode; })
            .sort(function (a, b) { return a.upAt - b.upAt; });

        function build(list) {
            var wps = [];
            var at = function (distanceM) {
                var pos = positionAt(profile, dist, distanceM);
                pos.batteryPct = battery.pct[pos.index];
                pos.distanceM = distanceM;
                return pos;
            };
            /* The stretch an alert announces: climbs ridden as one (less than
               MERGE_GAP_M apart, same mode) are described together, from the
               first start to the last top, so the rider hears the whole effort. */
            var joined = function (i) {
                var j = i;
                while (list[j + 1] && list[j + 1].mode === list[i].mode &&
                    list[j + 1].climb.startKm * 1000 - list[j].downAt < MERGE_GAP_M) j++;
                if (j === i) return list[i].climb;
                var a = list[i].climb, z = list[j].climb, gain = 0, max = -Infinity;
                for (var k = i; k <= j; k++) {
                    gain += list[k].climb.gainM || 0;
                    if (Number.isFinite(list[k].climb.maxGrade)) max = Math.max(max, list[k].climb.maxGrade);
                }
                var km = z.endKm - a.startKm;
                return {
                    startKm: a.startKm, endKm: z.endKm, distanceKm: km, gainM: gain,
                    averageGrade: km > 0 ? gain / (km * 1000) * 100 : a.averageGrade,
                    maxGrade: Number.isFinite(max) ? max : undefined, joined: j - i + 1
                };
            };
            var start = at(0);
            var finish = 'Expected battery at the finish: ' + pctText(battery.finishPct) +
                (reservePct > 0 ? ' (reserve ' + reservePct + '%)' : '') + '.';
            /* A climb right at the start: one alert, not two at the same spot.
               The start waypoint is in the climb mode and says why. */
            var first = list[0];
            var fromStart = first && first.upAt < lead;
            var startMode = fromStart ? first.mode : base;
            var startClimb = fromStart ? joined(0) : undefined;
            wps.push({
                kind: 'start', mode: startMode, climb: startClimb, distanceM: 0,
                lat: start.lat, lon: start.lon, ele: start.ele, batteryPct: start.batteryPct,
                name: 'START · ' + startMode.label + ' · ' + pctText(start.batteryPct),
                desc: 'Start in ' + modeLine(startMode) + (fromStart ? ': ' + climbText(startClimb) + ' right from the start' : '') + '. ' + finish
            });
            var current = startMode;
            for (var i = 0; i < list.length; i++) {
                var x = list[i];
                var p = at(x.upAt);
                if (x.mode !== current) {
                    var c = joined(i);
                    wps.push({
                        kind: 'up', mode: x.mode, climb: c, distanceM: x.upAt, lat: p.lat, lon: p.lon, ele: p.ele, batteryPct: p.batteryPct,
                        name: x.mode.label + ' · ' + km1(c.distanceKm) + ' km +' + Math.round(c.gainM) + ' m · ' + pctText(p.batteryPct),
                        desc: 'Switch to ' + modeLine(x.mode) + ': ' + climbText(c) +
                            (lead > 0 && x.upAt < c.startKm * 1000 ? ', starting in ' + Math.round(c.startKm * 1000 - x.upAt) + ' m' : '') +
                            '. Expected battery here: ' + pctText(p.batteryPct) + '.'
                    });
                    current = x.mode;
                }
                /* Back to the base mode, unless the next climb starts right away. */
                var next = list[i + 1];
                if (next && next.climb.startKm * 1000 - x.downAt < MERGE_GAP_M) continue;
                var q = at(x.downAt);
                wps.push({
                    kind: 'down', mode: base, distanceM: x.downAt, lat: q.lat, lon: q.lon, ele: q.ele, batteryPct: q.batteryPct,
                    name: base.label + ' · ' + pctText(q.batteryPct),
                    desc: 'Back to ' + modeLine(base) + ': the climb is over. Expected battery here: ' + pctText(q.batteryPct) + '.'
                });
                current = base;
            }
            /* A tight route: from where the expected battery meets the reserve,
               RESERVE is the mode, and later changes would only spend more. */
            if (reserveMode && reservePct > 0) {
                var hit = -1;
                for (var k = 0; k < battery.pct.length; k++) { if (battery.pct[k] <= reservePct) { hit = k; break; } }
                if (hit > 0) {
                    var rd = dist[hit];
                    var before = wps.filter(function (w) { return w.distanceM < rd; });
                    var dropped = wps.length - before.length;
                    var r = at(rd);
                    before.push({
                        kind: 'reserve', mode: reserveMode, distanceM: rd, lat: r.lat, lon: r.lon, ele: r.ele, batteryPct: r.batteryPct,
                        name: reserveMode.label + ' · ' + pctText(r.batteryPct),
                        desc: 'The expected battery reaches the ' + reservePct + '% reserve here: switch to ' + modeLine(reserveMode) +
                            ' and stay in it to stretch the final part.'
                    });
                    wps = before;
                    if (dropped) notes.push('After the reserve point the plan stays in ' + reserveMode.label + ': ' + dropped + ' later change(s) were left out.');
                }
            }
            return wps;
        }

        var kept = climbs.slice();
        var wps = build(kept);
        var droppedClimbs = 0;
        /* Over the limit: let the smallest climbs go first, one at a time. */
        while (wps.length > cap && kept.length) {
            var minIdx = 0;
            for (var j = 1; j < kept.length; j++) if (kept[j].climb.gainM < kept[minIdx].climb.gainM) minIdx = j;
            kept.splice(minIdx, 1);
            droppedClimbs++;
            wps = build(kept);
        }
        if (droppedClimbs) {
            notes.push(droppedClimbs + ' smaller climb(s) left out to stay within ' + cap + ' waypoints (the Wikiloc limit).');
        }
        wps.forEach(function (w, i) { w.index = i + 1; });
        return { ok: true, waypoints: wps, notes: notes, finishPct: battery.finishPct, droppedClimbs: droppedClimbs };
    }

    return {
        planModeWaypoints: planModeWaypoints,
        batteryAlong: batteryAlong,
        positionAt: positionAt,
        constants: {
            WIKILOC_MAX_WAYPOINTS: WIKILOC_MAX_WAYPOINTS,
            DEFAULT_LEAD_M: DEFAULT_LEAD_M,
            MERGE_GAP_M: MERGE_GAP_M,
            TECH_MIN_AVG_GRADE: TECH_MIN_AVG_GRADE
        }
    };
});
