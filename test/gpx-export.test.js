const { test } = require('node:test');
const assert = require('node:assert/strict');
const { splitSegments, buildGpx, fileNameFor, isoTime } = require('../public/gpx-export.js');
const { haversine, parseGpx, buildRoute, cleanPoints, computeStats } = require('../public/route-file.js');

/* parseGpx reads XML with the browser's DOMParser. Under Node a tiny
   stand-in is enough for the files this writer produces (one element per
   line, attributes in double quotes): it lets the tests read the exported
   file back with the app's own parser. */
function installDomParser() {
    if (typeof global.DOMParser !== 'undefined') return;
    class El {
        constructor(name, attrs) { this.localName = name; this.attrs = attrs; this.children = []; this.text = ''; }
        getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
        get childNodes() { return this.children; }
        get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
        getElementsByTagName(n) {
            const out = [];
            const walk = (e) => e.children.forEach((c) => { if (n === '*' || c.localName === n) out.push(c); walk(c); });
            walk(this);
            return out;
        }
        getElementsByTagNameNS(ns, n) { return this.getElementsByTagName(n); }
    }
    global.DOMParser = class {
        parseFromString(text) {
            const doc = new El('#document', {});
            const stack = [doc];
            const re = /<(\/?)([A-Za-z_][\w:.-]*)([^>]*?)(\/?)>|([^<]+)/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                if (m[5] !== undefined) { stack[stack.length - 1].text += m[5].trim(); continue; }
                if (m[2].startsWith('?')) continue;
                if (m[1]) { stack.pop(); continue; }
                const attrs = {};
                m[3].replace(/([\w:.-]+)="([^"]*)"/g, (_, k, v) => { attrs[k] = v; return ''; });
                const el = new El(m[2].replace(/^.*:/, ''), attrs);
                el.nodeType = 1;
                stack[stack.length - 1].children.push(el);
                if (!m[4]) stack.push(el);
            }
            return doc;
        }
    };
}

const M_PER_DEG = 111194.93;
/* A straight line north from (45, 10), one fix every `stepM` metres. */
function line(n, stepM, opts = {}) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        pts.push({
            lat: 45 + (i * stepM) / M_PER_DEG,
            lon: 10,
            ele: opts.noEle ? null : 300 + i,
            time: opts.t0 ? opts.t0 + i * 1000 : null,
            segmentId: opts.segmentId || 0
        });
    }
    return pts;
}

test('GPX 1.1 with 6-decimal coordinates, ele and time only when known', () => {
    const pts = line(3, 10, { t0: Date.UTC(2026, 8, 27, 8, 0, 0) });
    pts[1].ele = null;
    const gpx = buildGpx([pts], { name: 'Avinox 2026-09-27', time: Date.UTC(2026, 8, 27, 8, 0, 0) });
    assert.match(gpx, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(gpx, /<gpx version="1.1" creator="[^"]+" xmlns="http:\/\/www.topografix.com\/GPX\/1\/1"/);
    assert.match(gpx, /<metadata>\s*<name>Avinox 2026-09-27<\/name>\s*<time>2026-09-27T08:00:00.000Z<\/time>/);
    assert.equal((gpx.match(/<trk>/g) || []).length, 1);
    assert.equal((gpx.match(/<trkseg>/g) || []).length, 1);
    assert.match(gpx, /<trkpt lat="45.000000" lon="10.000000"><ele>300<\/ele><time>2026-09-27T08:00:00.000Z<\/time><\/trkpt>/);
    /* unknown altitude: no <ele>, never 0 */
    const second = gpx.split('\n').filter((l) => l.includes('<trkpt'))[1];
    assert.doesNotMatch(second, /<ele>/);
    assert.doesNotMatch(gpx, /<ele>0<\/ele>/);
});

test('a planned route without times has no <time> at all', () => {
    const gpx = buildGpx([line(4, 50, { noEle: true })], { name: 'Komoot tour' });
    assert.doesNotMatch(gpx, /<time>/);
    assert.doesNotMatch(gpx, /<ele>/);
    assert.match(gpx, /<name>Komoot tour<\/name>/);
});

test('names are XML-escaped', () => {
    const gpx = buildGpx([line(2, 10)], { name: 'Giro <Majella> & "Morrone"' });
    assert.match(gpx, /<name>Giro &lt;Majella&gt; &amp; &quot;Morrone&quot;<\/name>/);
});

test('GPS gaps split the track into separate segments, never bridged', () => {
    const t0 = Date.UTC(2026, 8, 27, 8, 0, 0);
    const a = line(30, 5, { t0 });
    /* 14 minutes without a fix, back 2.6 km away (the real case in app.js) */
    const b = line(30, 5, { t0: t0 + 30000 + 14 * 60000 }).map((p) => Object.assign(p, { lat: p.lat + 2600 / M_PER_DEG }));
    /* then a jump in space with a normal clock */
    const c = line(30, 5, { t0: t0 + 30000 + 14 * 60000 + 31000 }).map((p) => Object.assign(p, { lat: p.lat + 3500 / M_PER_DEG }));
    const segs = splitSegments(a.concat(b, c), { maxDtS: 20, maxDistM: 400, distance: haversine });
    assert.equal(segs.length, 3);
    assert.deepEqual(segs.map((s) => s.length), [30, 30, 30]);
    const gpx = buildGpx(segs, { name: 'gaps' });
    assert.equal((gpx.match(/<trkseg>/g) || []).length, 3);
    /* no segment holds a step longer than the gap threshold */
    segs.forEach((s) => s.slice(1).forEach((p, i) => assert.ok(haversine(s[i], p) <= 400)));
});

test('a stop is not a gap: identical fixes one second apart stay in one segment', () => {
    const t0 = Date.UTC(2026, 8, 27, 8, 0, 0);
    const moving = line(10, 5, { t0 });
    const last = moving[moving.length - 1];
    const stop = Array.from({ length: 120 }, (_, i) => Object.assign({}, last, { time: last.time + (i + 1) * 1000 }));
    const segs = splitSegments(moving.concat(stop), { maxDtS: 20, maxDistM: 400, distance: haversine });
    assert.equal(segs.length, 1);
});

test('source segments are kept, single-point segments dropped', () => {
    const pts = line(5, 10, { segmentId: 0 })
        .concat(line(1, 10, { segmentId: 1 }))
        .concat(line(4, 10, { segmentId: 2 }));
    const segs = splitSegments(pts);
    assert.deepEqual(segs.map((s) => s.length), [5, 4]);
});

test('planned route round trip: same points and distance after export', () => {
    installDomParser();
    const original = line(200, 25, { t0: null }).concat(line(100, 25, { segmentId: 1 }).map((p) => Object.assign(p, { lon: 10.01 })));
    const before = computeStats(original);
    const segs = splitSegments(cleanPoints(original).points);
    const parsed = parseGpx(buildGpx(segs, { name: 'Komoot' }));
    assert.equal(parsed.geometries.length, 2);
    const after = computeStats(buildRoute(parsed.geometries).points);
    assert.equal(after.pointCount, before.pointCount);
    assert.equal(after.segmentCount, before.segmentCount);
    assert.ok(Math.abs(after.distanceKm - before.distanceKm) < 0.001);
    assert.ok(Math.abs(after.elevationGainM - before.elevationGainM) < 0.01);
});

test('file names and times', () => {
    assert.equal(fileNameFor('Avinox 2026-09-27'), 'Avinox-2026-09-27.gpx');
    assert.equal(fileNameFor('Giro della Majella.kml'), 'Giro-della-Majella.gpx');
    assert.equal(fileNameFor('Città/salita'), 'Citta-salita.gpx');
    assert.equal(fileNameFor(''), 'avinox-track.gpx');
    assert.equal(isoTime('2026-09-27T08:00:00Z'), '2026-09-27T08:00:00.000Z');
    assert.equal(isoTime('not a date'), null);
    assert.equal(isoTime(null), null);
});
