const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planModeWaypoints, batteryAlong, constants } = require('../public/mode-waypoints.js');
const { computeGradeProfile, computeGradeStats } = require('../public/route-file.js');
const { buildGpx } = require('../public/gpx-export.js');

const METRES_PER_DEGREE = 111194.93;

/* A track along a meridian; legs = [{ lengthM, grade (%) }], one fix every 10 m. */
function track(legs) {
    const points = [{ lat: 45, lon: 10, ele: 300, segmentId: 0 }];
    let distance = 0, elevation = 300;
    legs.forEach((leg) => {
        for (let d = 10; d <= leg.lengthM + 1e-9; d += 10) {
            distance += 10;
            elevation += 10 * leg.grade / 100;
            points.push({ lat: 45 + distance / METRES_PER_DEGREE, lon: 10, ele: elevation, segmentId: 0 });
        }
    });
    return points;
}

const MODES = [
    { key: 'endurance', label: 'ROUTE ENDURANCE', assistLevel: 4, maxPower: 150, maxTorque: 25 },
    { key: 'climb', label: 'ROUTE CLIMB', assistLevel: 9, maxPower: 450, maxTorque: 85 },
    { key: 'tech', label: 'ROUTE TECH', assistLevel: 11, maxPower: 500, maxTorque: 95 }
];

/* flat 2 km · climb 2 km at 8% · flat 1 km · steep 1 km at 14% · descent 2 km · flat 1 km */
const ROUTE = [
    { lengthM: 2000, grade: 0 }, { lengthM: 2000, grade: 8 }, { lengthM: 1000, grade: 0 },
    { lengthM: 1000, grade: 14 }, { lengthM: 2000, grade: -8 }, { lengthM: 1000, grade: 0 }
];

function analysed(legs) {
    const points = track(legs);
    const grades = computeGradeStats(points);
    const profile = computeGradeProfile(points);
    assert.ok(grades.ok && profile.ok);
    return { points, grades, profile };
}

test('battery along the track lands on the total and spends more on the climbs', () => {
    const { profile } = analysed(ROUTE);
    const energy = { totalWh: 400, flatWh: 100, climbWh: 150 };   // surface and personal factor already in the total
    const b = batteryAlong(profile.points, energy, 800, 100);
    const last = b.cumWh[b.cumWh.length - 1];
    assert.ok(Math.abs(last - 400) < 1e-6);
    assert.ok(Math.abs(b.finishPct - 50) < 1e-6);
    /* 2 km of flat cost less than 2 km of 8% climb */
    const at = (m) => b.cumWh[b.distances.findIndex((d) => d >= m)];
    const flat2km = at(2000) - at(0), climb2km = at(4000) - at(2000);
    assert.ok(climb2km > 3 * flat2km, `${climb2km} vs ${flat2km}`);
    /* the descent costs only its distance (windows kept clear of the
       smoothed transitions at the summit and at the bottom) */
    const descent = at(7800) - at(6200), flatSame = at(1800) - at(200);
    assert.ok(Math.abs(descent - flatSame) < 1e-6, `${descent} vs ${flatSame}`);
    /* monotonic */
    for (let i = 1; i < b.pct.length; i++) assert.ok(b.pct[i] <= b.pct[i - 1] + 1e-9);
});

test('waypoints: start, a climb in and out, a steep climb in TECH, battery falling', () => {
    const { grades, profile } = analysed(ROUTE);
    assert.equal(grades.climbs.length, 2);
    const plan = planModeWaypoints({
        profile: profile.points, climbs: grades.climbs, modes: MODES,
        energy: { totalWh: 400, flatWh: 100, climbWh: 150 }, batteryWh: 800, reservePercent: 15
    });
    assert.ok(plan.ok);
    const kinds = plan.waypoints.map((w) => w.kind);
    assert.deepEqual(kinds, ['start', 'up', 'down', 'up', 'down']);
    const [start, up1, down1, up2, down2] = plan.waypoints;
    assert.equal(start.mode.key, 'endurance');
    assert.equal(up1.mode.key, 'climb');
    assert.equal(up2.mode.key, 'tech');          // 14% average takes the TECH mode
    assert.equal(down1.mode.key, 'endurance');
    /* the alert comes DEFAULT_LEAD_M before the climb starts */
    assert.ok(Math.abs(up1.distanceM - (grades.climbs[0].startKm * 1000 - constants.DEFAULT_LEAD_M)) < 1);
    assert.ok(Math.abs(down1.distanceM - grades.climbs[0].endKm * 1000) < 1);
    /* battery: 100 at the start, falling, finish at 50 */
    assert.equal(Math.round(start.batteryPct), 100);
    assert.ok(up1.batteryPct > down1.batteryPct && down1.batteryPct > up2.batteryPct && up2.batteryPct > down2.batteryPct);
    assert.equal(Math.round(plan.finishPct), 50);
    /* the alert text carries the mode, the climb and the battery */
    assert.match(up1.name, /^ROUTE CLIMB · 2\.\d km \+1\d\d m · ~\d+%$/);
    assert.match(up1.desc, /Switch to ROUTE CLIMB \(level 9 · 450 W · 85 Nm\): climb of 2\.\d km/);
    assert.match(up1.desc, /starting in 100 m\. Expected battery here: ~\d+%\./);
    assert.match(start.desc, /Expected battery at the finish: ~50% \(reserve 15%\)/);
    assert.match(down1.desc, /Back to ROUTE ENDURANCE/);
    /* positions sit on the track */
    plan.waypoints.forEach((w) => { assert.ok(w.lat >= 45 && w.lat <= 45.1); assert.equal(w.lon, 10); assert.ok(Number.isFinite(w.ele)); });
});

test('two climbs close together are ridden as one', () => {
    const { grades, profile } = analysed([
        { lengthM: 1000, grade: 0 }, { lengthM: 1000, grade: 8 }, { lengthM: 150, grade: 0 }, { lengthM: 1000, grade: 8 }, { lengthM: 1000, grade: 0 }
    ]);
    assert.equal(grades.climbs.length, 2);
    const plan = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes: MODES, energy: { totalWh: 200, flatWh: 50, climbWh: 50 }, batteryWh: 800, reservePercent: 15 });
    assert.deepEqual(plan.waypoints.map((w) => w.kind), ['start', 'up', 'down']);
});

test('a climb right at the start: the START waypoint is already in the climb mode', () => {
    const { grades, profile } = analysed([{ lengthM: 50, grade: 0 }, { lengthM: 1500, grade: 9 }, { lengthM: 2000, grade: 0 }]);
    assert.equal(grades.climbs.length, 1);
    const plan = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes: MODES, energy: { totalWh: 200, flatWh: 50, climbWh: 100 }, batteryWh: 800, reservePercent: 15 });
    assert.deepEqual(plan.waypoints.map((w) => w.kind), ['start', 'down']);
    const [start, down] = plan.waypoints;
    assert.equal(start.mode.key, 'climb');
    assert.equal(start.distanceM, 0);
    assert.match(start.name, /^START · ROUTE CLIMB · ~100%$/);
    assert.match(start.desc, /^Start in ROUTE CLIMB \(level 9 · 450 W · 85 Nm\): climb of 1\.\d km, \+1\d\d m, avg \d\.\d% \(max \d+%\) right from the start\. Expected battery at the finish: ~75% \(reserve 15%\)\.$/);
    assert.equal(down.mode.key, 'endurance');
    assert.ok(Math.abs(down.distanceM - grades.climbs[0].endKm * 1000) < 1);
});

test('a tight route: RESERVE from where the battery meets the reserve, later changes dropped', () => {
    const { grades, profile } = analysed(ROUTE);
    const modes = MODES.concat([{ key: 'reserve', label: 'ROUTE RESERVE', assistLevel: 3, maxPower: 100, maxTorque: 15 }]);
    const energy = { totalWh: 760, flatWh: 100, climbWh: 150 };
    /* 760 of 800 Wh: the battery meets a 30% reserve on the steep climb,
       before its "back to ENDURANCE" change, which is therefore dropped */
    const plan = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes, energy, batteryWh: 800, reservePercent: 30 });
    const kinds = plan.waypoints.map((w) => w.kind);
    assert.deepEqual(kinds, ['start', 'up', 'down', 'up', 'reserve']);
    const reserve = plan.waypoints[plan.waypoints.length - 1];
    assert.ok(reserve.batteryPct <= 30 && reserve.batteryPct > 28, String(reserve.batteryPct));
    assert.ok(reserve.distanceM > grades.climbs[1].startKm * 1000 && reserve.distanceM < grades.climbs[1].endKm * 1000);
    assert.ok(plan.waypoints.every((w) => w.distanceM <= reserve.distanceM));
    assert.ok(plan.notes.some((n) => /later change/.test(n)));
    assert.match(reserve.desc, /switch to ROUTE RESERVE/);
    assert.match(reserve.name, /^ROUTE RESERVE · ~(29|30)%$/);
    /* with a 15% reserve the crossing falls on the descent, after the last change: nothing dropped, the alert is just the last one */
    const late = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes, energy, batteryWh: 800, reservePercent: 15 });
    assert.deepEqual(late.waypoints.map((w) => w.kind), ['start', 'up', 'down', 'up', 'down', 'reserve']);
    assert.equal(late.notes.length, 0);
});

test('stays within the Wikiloc limit by dropping the smallest climbs', () => {
    const legs = [];
    for (let i = 0; i < 16; i++) legs.push({ lengthM: 400, grade: 0 }, { lengthM: 500 + (i % 3) * 200, grade: 8 });
    legs.push({ lengthM: 500, grade: 0 });
    const { grades, profile } = analysed(legs);
    assert.equal(grades.climbs.length, 16);
    const plan = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes: MODES, energy: { totalWh: 500, flatWh: 100, climbWh: 300 }, batteryWh: 800, reservePercent: 15 });
    assert.ok(plan.waypoints.length <= constants.WIKILOC_MAX_WAYPOINTS, String(plan.waypoints.length));
    assert.ok(plan.droppedClimbs > 0);
    assert.ok(plan.notes.some((n) => /Wikiloc limit/.test(n)));
    /* 1 start + 16 × (up, down) = 33: four climbs go, the four smallest */
    assert.equal(plan.droppedClimbs, 4);
    assert.equal(plan.waypoints.length, 25);
    const keptGains = plan.waypoints.filter((w) => w.kind === 'up').map((w) => w.climb.gainM);
    const minKept = Math.min(...keptGains);
    const biggerThanMin = (gains) => gains.filter((g) => g > minKept + 1e-9).length;
    assert.equal(biggerThanMin(keptGains), biggerThanMin(grades.climbs.map((c) => c.gainM)));
    /* the kept climbs stay in track order, each with its own "down" */
    const ups = plan.waypoints.filter((w) => w.kind === 'up');
    for (let i = 1; i < ups.length; i++) assert.ok(ups[i].distanceM > ups[i - 1].distanceM);
    assert.equal(plan.waypoints.filter((w) => w.kind === 'down').length, ups.length);
});

test('no modes or no climbs: start only, or no plan at all', () => {
    const { grades, profile } = analysed(ROUTE);
    const none = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes: [], energy: { totalWh: 400, flatWh: 100, climbWh: 150 }, batteryWh: 800 });
    assert.equal(none.ok, false);
    const flat = analysed([{ lengthM: 3000, grade: 0 }]);
    const onlyStart = planModeWaypoints({ profile: flat.profile.points, climbs: flat.grades.climbs, modes: MODES.slice(0, 1), energy: { totalWh: 50, flatWh: 50, climbWh: 0 }, batteryWh: 800, reservePercent: 15 });
    assert.deepEqual(onlyStart.waypoints.map((w) => w.kind), ['start']);
});

test('the waypoints go into the GPX before the track', () => {
    const { grades, profile } = analysed(ROUTE);
    const plan = planModeWaypoints({ profile: profile.points, climbs: grades.climbs, modes: MODES, energy: { totalWh: 400, flatWh: 100, climbWh: 150 }, batteryWh: 800, reservePercent: 15 });
    const gpx = buildGpx([profile.points.map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele }))], { name: 'Test & co', waypoints: plan.waypoints });
    assert.equal((gpx.match(/<wpt /g) || []).length, 5);
    assert.ok(gpx.indexOf('<wpt ') < gpx.indexOf('<trk>'));
    assert.match(gpx, /<wpt lat="45\.0\d{5}" lon="10\.000000">\s*<ele>\d+(\.\d+)?<\/ele>\s*<name>ROUTE CLIMB · 2\.\d km \+1\d\d m · ~\d+%<\/name>\s*<desc>Switch to ROUTE CLIMB/);
    assert.match(gpx, /<name>START · ROUTE ENDURANCE · ~100%<\/name>/);
});
