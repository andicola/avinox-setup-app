/**
 * GPX export — writes the loaded track as a GPX 1.1 file for Wikiloc.
 *
 * Runs in the browser and builds the file in memory: nothing is sent
 * anywhere, the caller only hands the text to a local download.
 *
 * Pure helpers, testable under Node like route-file.js:
 *
 *     points ─> splitSegments ─> segments ─> buildGpx ─> GPX text
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AvinoxGpxExport = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var CREATOR = 'Avinox Setup Calculator';

    function escapeXml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    /** ISO 8601 UTC, or null: accepts a Date, epoch milliseconds or a
     *  date string. A time the file cannot state reliably is left out
     *  rather than guessed. */
    function isoTime(value) {
        if (value === null || value === undefined || value === '') return null;
        var d = value instanceof Date ? value : new Date(value);
        var t = d.getTime();
        return Number.isFinite(t) ? d.toISOString() : null;
    }

    /** Rounded to `decimals`, without trailing zeros (12.50 -> 12.5). */
    function fixed(n, decimals) {
        return String(parseFloat(n.toFixed(decimals)));
    }

    /**
     * Splits an ordered list of points into segments.
     *
     * A new segment starts where the source already had one (a different
     * `segmentId`, i.e. another <trkseg> or geometry) and, when `maxDtS` /
     * `maxDistM` are given, where two consecutive fixes are too far apart
     * in time or space: the path in between is unknown, and a single
     * segment would make a GPX viewer draw a straight line the bike never
     * rode. Segments with fewer than two points carry no line and are
     * dropped.
     *
     * opts: { maxDtS, maxDistM, distance(a, b) -> metres }
     * point: { lat, lon, ele?, time? (ms since epoch | ISO string | Date), segmentId? }
     */
    function splitSegments(points, opts) {
        var o = opts || {};
        var segments = [];
        var current = [];
        var prev = null;
        (points || []).forEach(function (p) {
            if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return;
            var breakHere = false;
            if (prev) {
                if (prev.segmentId !== p.segmentId) breakHere = true;
                if (!breakHere && o.maxDtS > 0) {
                    var ta = isoTime(prev.time), tb = isoTime(p.time);
                    if (ta && tb && Math.abs(Date.parse(tb) - Date.parse(ta)) / 1000 > o.maxDtS) breakHere = true;
                }
                if (!breakHere && o.maxDistM > 0 && typeof o.distance === 'function') {
                    if (o.distance(prev, p) > o.maxDistM) breakHere = true;
                }
            }
            if (breakHere) {
                if (current.length >= 2) segments.push(current);
                current = [];
            }
            current.push(p);
            prev = p;
        });
        if (current.length >= 2) segments.push(current);
        return segments;
    }

    /**
     * Builds the GPX 1.1 document: one <trk>, one <trkseg> per segment.
     * lat/lon with 6 decimals; <ele> and <time> only when known (an
     * unknown altitude written as 0 would put the track at sea level).
     *
     * opts: { name, time? (metadata time), creator? }
     */
    function buildGpx(segments, opts) {
        var o = opts || {};
        var name = o.name ? escapeXml(o.name) : '';
        var metaTime = isoTime(o.time);
        var out = [];
        out.push('<?xml version="1.0" encoding="UTF-8"?>');
        out.push('<gpx version="1.1" creator="' + escapeXml(o.creator || CREATOR) + '"' +
            ' xmlns="http://www.topografix.com/GPX/1/1"' +
            ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"' +
            ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">');
        out.push('  <metadata>');
        if (name) out.push('    <name>' + name + '</name>');
        if (metaTime) out.push('    <time>' + metaTime + '</time>');
        out.push('  </metadata>');
        out.push('  <trk>');
        if (name) out.push('    <name>' + name + '</name>');
        (segments || []).forEach(function (seg) {
            out.push('    <trkseg>');
            seg.forEach(function (p) {
                var line = '      <trkpt lat="' + p.lat.toFixed(6) + '" lon="' + p.lon.toFixed(6) + '">';
                var inner = '';
                if (Number.isFinite(p.ele)) inner += '<ele>' + fixed(p.ele, 2) + '</ele>';
                var t = isoTime(p.time);
                if (t) inner += '<time>' + t + '</time>';
                out.push(line + inner + '</trkpt>');
            });
            out.push('    </trkseg>');
        });
        out.push('  </trk>');
        out.push('</gpx>');
        return out.join('\n') + '\n';
    }

    /** A file name a human recognises, safe on every OS. */
    function fileNameFor(name) {
        var base = String(name || 'avinox-track')
            .replace(/\.(gpx|kml|proto)$/i, '')
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^A-Za-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return (base || 'avinox-track') + '.gpx';
    }

    return {
        splitSegments: splitSegments,
        buildGpx: buildGpx,
        fileNameFor: fileNameFor,
        isoTime: isoTime
    };
});
