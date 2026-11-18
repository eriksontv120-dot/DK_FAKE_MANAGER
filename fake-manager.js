/*
 * DK4 – Správca FAKE útokov (Divoké kmene, SK105)
 * Verzia: 1.1.0 (2026-11-18) – len ostrý režim, drž Enter
 *
 * Náhrada za "Mass Command Timer" (RedAlert, v3.2.2).
 * Z pôvodného scriptu sú prevzaté funkčné časti:
 *   - načítanie jednotiek z prehľadu "Kombinované" (desktop + mobil),
 *   - výpočet času pochodu z /interface.php?func=get_unit_info,
 *   - predvyplnenie nádvoria cez URL parametre (x, y, jednotky).
 *
 * Režim DRŽ ENTER: každý krok v hre vykoná skutočné stlačenie Enter hráčom na tlačidle hry v nádvorí
 * (tlačidlo "Útok" a potom "Potvrdiť"). Script iba otvorí predvyplnené nádvorie,
 * sleduje okno a po odoslaní overí príkaz v prehľade príkazov.
 *
 * Použité iba štandardné herné stránky a verejné súbory sveta:
 *   /interface.php?func=get_config, /interface.php?func=get_unit_info, /map/village.txt,
 *   overview_villages (prod, combined, commands), screen=place.
 */
(async function () {
    'use strict';

    const $ = window.jQuery;
    if (!$ || !window.game_data || !$('#content_value').length) {
        alert('Spusti script v hre Divoké kmene (na ľubovoľnej hernej stránke).');
        return;
    }

    /* ------------------------------------------------------------------ */
    /*  Konštanty                                                          */
    /* ------------------------------------------------------------------ */
    const VERSION = '1.1.0';
    const WORLD = game_data.world;
    const PID = String(game_data.player.id);
    const KEY = `dk4fm_${WORLD}_${PID}`;
    const CFG_KEY = `dk4fm_cfg_${WORLD}`;
    const SITTER = game_data.player.sitter > 0 ? `t=${PID}&` : '';
    const CUR_VID = game_data.village.id;
    const GROUP = game_data.group_id || 0;
    const DAY = 86400000;
    const GAME_UNITS = (game_data.units || []).slice();
    const IS_MOBILE = $('#mobileHeader').length > 0 || !!window.mobile;

    const UNIT_NAME = {
        spear: 'Kopijník', sword: 'Mečiar', axe: 'Sekerník', archer: 'Lukostrelec',
        spy: 'Špeh', light: 'Ľahká jazda', marcher: 'Lukostrelec na koni', heavy: 'Ťažká jazda',
        ram: 'Baranidlo', catapult: 'Katapult', knight: 'Paladin', snob: 'Šľachtic', militia: 'Domobrana',
    };
    // Jednotky, ktoré script smie VôBEC použiť (žiadna ťažká jazda, katapulty, šľachtici, paladin).
    const OFF_FILLERS = ['spy', 'light', 'axe'];
    const DEFF_FILLERS = ['spear', 'sword'];
    const ALLOWED_UNITS = new Set(['ram', ...OFF_FILLERS, ...DEFF_FILLERS]);
    // Na klasifikáciu dediny (OFF / DEFF) podľa populácie jednotiek.
    const OFF_CLASS = ['axe', 'light', 'marcher', 'ram', 'catapult'];
    const DEFF_CLASS = ['spear', 'sword', 'archer', 'heavy'];
    const SHOWN_UNITS = ['spear', 'sword', 'axe', 'spy', 'light', 'heavy', 'ram'].filter((u) => GAME_UNITS.includes(u));

    const STATUS = {
        pending: { t: 'Čaká na kontrolu', c: '#7a6a3a' },
        ready: { t: 'Pripravený', c: '#2e7d32' },
        progress: { t: 'Prebieha odoslanie', c: '#1565c0' },
        unverified: { t: 'Neoverené', c: '#b26a00' },
        error: { t: 'Chyba', c: '#c62828' },
        sent: { t: 'Odoslaný', c: '#1b5e20' },
        removed: { t: 'Odstránený', c: '#757575' },
    };
    const ACTIVE = new Set(['pending', 'ready', 'progress', 'unverified', 'error']);
    const RESERVING = new Set(['pending', 'ready', 'progress', 'unverified', 'error']);

    /* ------------------------------------------------------------------ */
    /*  Pomocné funkcie                                                    */
    /* ------------------------------------------------------------------ */
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = (s) => parseInt(String(s ?? '').replace(/[^\d]/g, ''), 10) || 0;
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const fmtNum = (n) => Math.round(n || 0).toLocaleString('sk-SK');
    const coordRe = (c) => {
        const [x, y] = c.split('|');
        return new RegExp(`(^|\\D)${x}\\|${y}(\\D|$)`);
    };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const unitList = (units) => Object.keys(units).filter((u) => units[u] > 0);
    const unitsText = (units) => unitList(units).map((u) => `${UNIT_NAME[u] || u} ${units[u]}`).join(', ');
    const variantName = (units) => {
        const order = ['spear', 'sword', 'spy', 'light', 'axe', 'ram'];
        return order.filter((u) => units[u] > 0).map((u) => (UNIT_NAME[u] || u).toLowerCase()).join(' + ').replace(/^./, (c) => c.toUpperCase());
    };
    const unitIcon = (u) =>
        window.image_base
            ? `<img src="${window.image_base}unit/unit_${u}.webp" title="${esc(UNIT_NAME[u] || u)}" style="width:16px;height:16px;vertical-align:middle">`
            : `<b title="${esc(UNIT_NAME[u] || u)}">${esc((UNIT_NAME[u] || u).slice(0, 3))}</b>`;
    const unitsHtml = (units) => unitList(units).map((u) => `<span class="dk-u">${unitIcon(u)}&nbsp;${units[u]}</span>`).join(' ');

    // Čas: všetky časy v scripte sú "nástenné hodiny sveta" uložené ako UTC milisekundy.
    // (Dátum/čas, ktorý ukazuje hra, sa interpretuje ako UTC => žiadne problémy s pásmom PC.)
    function readServerWall() {
        const d = $('#serverDate').text().trim().split('/');
        const t = $('#serverTime').text().trim().split(':');
        if (d.length !== 3 || t.length < 3) return null;
        return Date.UTC(+d[2], +d[1] - 1, +d[0], +t[0], +t[1], +t[2]);
    }
    const realNow = () => (window.Timing && typeof Timing.getCurrentServerTime === 'function' ? Timing.getCurrentServerTime() : Date.now());
    let TZ_MS = 0; // posun času sveta oproti UTC
    let CLOCK_FALLBACK = 0;
    (function initClock() {
        const wall = readServerWall();
        if (wall === null) {
            TZ_MS = -new Date().getTimezoneOffset() * 60000;
            return;
        }
        TZ_MS = Math.round((wall - realNow()) / 900000) * 900000; // zaokrúhlenie na 15 min
        CLOCK_FALLBACK = wall - (realNow() + TZ_MS);
        if (Math.abs(CLOCK_FALLBACK) > 5000) CLOCK_FALLBACK = 0;
    })();
    const now = () => realNow() + TZ_MS;
    const tzLabel = () => {
        const h = TZ_MS / 3600000;
        return 'UTC' + (h >= 0 ? '+' : '') + (Number.isInteger(h) ? h : h.toFixed(2));
    };
    const fmt = (ms) => {
        if (!isFinite(ms)) return '–';
        const d = new Date(ms);
        return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    };
    const fmtShort = (ms) => {
        const d = new Date(ms);
        return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}. ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    };
    const fmtDur = (sec) => {
        sec = Math.max(0, Math.round(sec));
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        return (d ? d + 'd ' : '') + `${h}:${pad(m)}:${pad(s)}`;
    };
    function parseDate(str) {
        str = String(str || '').trim();
        let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
        m = str.match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/);
        if (m) return { y: +m[3], mo: +m[2], d: +m[1] };
        return null;
    }
    function parseTime(str) {
        const m = String(str || '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!m || +m[1] > 23 || +m[2] > 59 || +(m[3] || 0) > 59) return null;
        return (+m[1] * 3600 + +m[2] * 60 + +(m[3] || 0)) * 1000;
    }
    function wallOf(dateStr, timeStr) {
        const d = parseDate(dateStr);
        const t = parseTime(timeStr);
        if (!d || t === null) return null;
        return Date.UTC(d.y, d.mo - 1, d.d) + t;
    }
    const isoDate = (ms) => {
        const d = new Date(ms);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    };

    // Sieť: GET s opakovaním a odstupom (hra povoľuje max. ~5 požiadaviek/s).
    let lastReq = 0;
    async function httpGet(url, dataType) {
        let lastErr;
        for (let i = 0; i < 3; i++) {
            const wait = lastReq + 300 - Date.now();
            if (wait > 0) await sleep(wait);
            lastReq = Date.now();
            try {
                return await $.ajax({ url, dataType: dataType || 'html', cache: false, timeout: 30000 });
            } catch (e) {
                lastErr = e;
                await sleep(800 * (i + 1));
            }
        }
        throw new Error(`Sieťová chyba pri načítaní ${url.split('?')[0]} (${lastErr && lastErr.status})`);
    }
    const gameUrl = (screen, extra = '') => `/game.php?${SITTER}village=${CUR_VID}&screen=${screen}${extra}`;

    /* ------------------------------------------------------------------ */
    /*  Stav (uložený v localStorage – prežije obnovenie stránky)          */
    /* ------------------------------------------------------------------ */
    const DEFAULT_SETTINGS = () => ({
        coords: '',
        date: isoDate(now() + DAY),
        from: '08:00:01',
        to: '23:59:59',
        forbidden: '',
        kind: 'mix', // mix | off | deff
        perTarget: 1,
        allowDup: true,
        offOrder: 'spy,light,axe',
        deffOrder: 'spear,sword',
        maxRams: 1,
        maxPerVillage: 0,
        bufferSec: 60,
        leadSec: 30,
        fakeLimitOverride: '',
        reserve: {},
        override: {}, // villageId -> auto | off | deff | skip
    });
    let state = { mode: 'live', settings: DEFAULT_SETTINGS(), queue: [], seq: 0 };
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (saved && Array.isArray(saved.queue)) {
            state = { ...state, ...saved, settings: { ...DEFAULT_SETTINGS(), ...(saved.settings || {}) } };
        }
    } catch (e) {
        console.warn('DK4: uložený stav sa nepodarilo načítať', e);
    }
    // Útoky, ktoré boli pri obnovení stránky "v procese", sa musia overiť.
    state.mode = 'live';
    state.queue.forEach((q) => {
        if (q.test && ACTIVE.has(q.status) && q.status !== 'progress') {
            q.status = 'removed';
            q.reason = 'Testovací režim bol zrušený';
        }
        if (q.status === 'progress') {
            q.status = 'unverified';
            q.reason = 'Stránka bola obnovená počas odosielania – over v prehľade príkazov.';
        }
    });
    function save() {
        try {
            localStorage.setItem(KEY, JSON.stringify(state));
        } catch (e) {
            console.error('DK4: uloženie zlyhalo', e);
        }
    }
    const S = () => state.settings;
    const log = (item, msg) => {
        item.log = item.log || [];
        item.log.push(`${fmtShort(now())} ${msg}`);
        if (item.log.length > 20) item.log.shift();
    };

    /* ------------------------------------------------------------------ */
    /*  Nastavenia sveta (skutočné hodnoty zo servera)                     */
    /* ------------------------------------------------------------------ */
    let cfg = null; // { fakeLimit, night:{active,start,end}, units:{u:{speed,pop}}, speed, unitSpeed }

    async function loadWorldConfig(force) {
        try {
            const c = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
            if (!force && c && Date.now() - c.at < 6 * 3600000 && c.units && Object.keys(c.units).length) {
                cfg = c;
                return;
            }
        } catch (e) { /* ignore */ }
        const [conf, units] = await Promise.all([
            httpGet('/interface.php?func=get_config', 'xml'),
            httpGet('/interface.php?func=get_unit_info', 'xml'),
        ]);
        const $c = $(conf);
        const txt = (sel) => $c.find(sel).first().text().trim();
        const u = {};
        $(units).find('config').children().each(function () {
            const name = this.tagName;
            const speed = parseFloat($(this).find('speed').text());
            const pop = parseFloat($(this).find('pop').text());
            if (isFinite(speed) && isFinite(pop)) u[name] = { speed, pop };
        });
        if (!Object.keys(u).length) throw new Error('Nepodarilo sa načítať jednotky sveta (get_unit_info).');
        const fl = txt('game > fake_limit');
        cfg = {
            at: Date.now(),
            fakeLimit: fl === '' ? null : parseFloat(fl),
            night: {
                active: num(txt('night > active')) > 0,
                start: num(txt('night > start_hour')),
                end: num(txt('night > end_hour')),
            },
            speed: parseFloat(txt('config > speed')) || null,
            unitSpeed: parseFloat(txt('config > unit_speed')) || null,
            units: u,
        };
        if (cfg.fakeLimit === null) throw new Error('V nastaveniach sveta chýba fake_limit – nastav ho ručne v "Pokročilé".');
        localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    }
    const fakeLimit = () => {
        const o = String(S().fakeLimitOverride || '').replace(',', '.').trim();
        return o !== '' && isFinite(+o) ? +o : cfg.fakeLimit;
    };
    const pop = (u) => cfg.units[u].pop;
    const speed = (u) => cfg.units[u].speed;
    // Body z mapy sveta môžu byť až 1 h staré → bezpečnostná rezerva +1 % (aspoň +1 obyv.).
    const MAP_SAFETY_PCT = 1;
    const fromMap = (v) => /mapa/.test(v.pointsSrc || '');
    const minPopFor = (v) => {
        const base = Math.max(1, Math.ceil((v.points * fakeLimit()) / 100));
        return fromMap(v) ? base + Math.max(1, Math.ceil((base * MAP_SAFETY_PCT) / 100)) : base;
    };

    /* ------------------------------------------------------------------ */
    /*  Načítanie vlastných dedín (body + jednotky doma)                   */
    /* ------------------------------------------------------------------ */
    let villages = []; // {id, name, coord, x, y, points, troops:{}}
    let snapshotAt = 0;

    async function loadVillages() {
        const prodHtml = await httpGet(gameUrl('overview_villages', `&mode=prod&group=${GROUP}&page=-1`));
        const doc = $($.parseHTML(prodHtml));
        const list = [];
        // index stĺpca "Body" podľa hlavičky (fallback = 3. stĺpec, ako vo funkčnom vyrovnávači skladov)
        let pIdx = -1;
        doc.find('#production_table tr').first().children('th').each(function (i) {
            if (pIdx < 0 && /bod|points/i.test($(this).text())) pIdx = i;
        });
        doc.find('.quickedit-vn').each(function () {
            const e = $(this);
            const id = String(e.data('id') || e.attr('data-id') || '');
            if (!id) return;
            const tds = e.closest('tr').children('td');
            const name = (e.find('.quickedit-label').text() || e.text()).trim();
            const m = name.match(/(\d{1,3})\|(\d{1,3})(?!.*\d{1,3}\|\d{1,3})/);
            if (!m) return;
            // V mobilnej verzii (appka) má prehľad inú štruktúru – stĺpcom sa tam neverí.
            let points = 0;
            if (!IS_MOBILE) {
                points = pIdx >= 0 ? num(tds.eq(pIdx).text()) : 0;
                if (!points) points = num(tds.eq(2).text());
            }
            list.push({ id, name, coord: `${m[1]}|${m[2]}`, x: +m[1], y: +m[2], points, pointsSrc: points ? 'prehľad produkcie' : '', troops: {} });
        });
        if (!list.length) throw new Error('Nenašli sa žiadne dediny v prehľade produkcie (skontroluj vybranú skupinu).');
        // Záloha 1: profil hráča (info_player) – aktuálne body, funguje aj v mobilnej appke.
        if (list.some((v) => !v.points)) {
            try {
                const prof = await fetchProfilePoints(list);
                list.forEach((v) => {
                    if (!v.points && prof[v.id]) {
                        v.points = prof[v.id];
                        v.pointsSrc = 'profil hráča';
                    }
                });
            } catch (e) {
                console.warn('DK4: body z profilu sa nepodarilo načítať', e);
            }
        }
        // Záloha 2: mapa sveta /map/village.txt (aktualizuje sa raz za hodinu).
        if (list.some((v) => !v.points)) {
            try {
                const map = await loadMap();
                list.forEach((v) => {
                    const r = map.get(v.coord);
                    if (!v.points && r && r.id === v.id && r.points) {
                        v.points = r.points;
                        v.pointsSrc = 'mapa sveta (môže byť až 1 h stará)';
                    }
                });
            } catch (e) {
                console.warn('DK4: body z mapy sa nepodarilo načítať', e);
            }
        }
        const troops = await fetchTroops();
        list.forEach((v) => {
            const t = troops.find((r) => String(r.villageId) === v.id);
            v.troops = t ? { ...t } : {};
            delete v.troops.villageId;
            v.hasTroopData = !!t;
        });
        villages = list;
        snapshotAt = now();
    }

    // Body vlastných dedín zo stránky profilu. Hľadá odkaz na každú dedinu (info_village&id=ID)
    // a z jej riadku/karty vezme číslo, ktoré nie je súčasťou názvu ani súradníc.
    async function fetchProfilePoints(list) {
        const html = await httpGet(gameUrl('info_player', `&id=${PID}`));
        const doc = $($.parseHTML(html));
        const out = {};
        list.forEach((v) => {
            const a = doc.find(`a[href*="screen=info_village"][href*="id=${v.id}"]`).filter(function () {
                return new RegExp(`[?&]id=${v.id}(&|$)`).test(this.getAttribute('href') || '');
            }).first();
            if (!a.length) return;
            const box = a.closest('tr').length ? a.closest('tr') : a.parent().parent();
            let text = box.text().replace(a.text(), ' ');
            text = text.replace(/\(?\d{1,3}\|\d{1,3}\)?/g, ' ').replace(/K\d{1,2}/g, ' ');
            const nums = (text.match(/\d{1,3}(?:[.\s ]\d{3})+|\d+/g) || []).map((n) => num(n)).filter((n) => n > 0);
            if (nums.length) out[v.id] = nums[nums.length - 1];
        });
        return out;
    }

    // Prevzaté z pôvodného scriptu (fetchTroopsForCurrentGroup) – funkčná časť.
    async function fetchTroops() {
        const html = await httpGet(gameUrl('overview_villages', `&mode=combined&group=${GROUP}&page=-1`));
        const htmlDoc = $.parseHTML(html);
        const out = [];
        const mobile = $('#mobileHeader').length > 0;
        if (mobile) {
            $(htmlDoc).find('.overview-container > div').each((i, el) => {
                const troops = {};
                $(el).find('.overview-units-row > div.unit-row-item').each((j, ue) => {
                    const img = $(ue).find('img');
                    const span = $(ue).find('span.unit-row-name');
                    if (img.length && span.length) {
                        const u = (img.attr('src').split('unit_')[1] || '').replace(/(@2x)?\.(webp|png)$/, '');
                        troops[u] = parseInt(span.text(), 10) || 0;
                    }
                });
                troops.villageId = $(el).find('.quickedit-vn').data('id');
                out.push(troops);
            });
        } else {
            const header = [];
            $(htmlDoc).find('#combined_table tr:eq(0) th').each(function () {
                const src = $(this).find('img').attr('src');
                header.push(src ? src.split('/').pop().replace(/(@2x)?\.(webp|png)$/, '') : null);
            });
            $(htmlDoc).find('#combined_table tr.nowrap').each(function () {
                const row = {};
                const vid = $(this).find('span.quickedit-vn').attr('data-id');
                if (!vid) return;
                row.villageId = parseInt(vid, 10);
                header.forEach((h, idx) => {
                    if (h && h.indexOf('unit_') === 0) row[h.replace('unit_', '')] = parseInt($(this).find(`td:eq(${idx})`).text(), 10) || 0;
                });
                out.push(row);
            });
        }
        if (!out.length) throw new Error('Nepodarilo sa načítať jednotky z prehľadu "Kombinované".');
        return out;
    }

    /* ------------------------------------------------------------------ */
    /*  Mapa sveta (overenie cieľov) – verejný súbor /map/village.txt      */
    /* ------------------------------------------------------------------ */
    let mapIndex = null;
    async function loadMap() {
        if (mapIndex) return mapIndex;
        const txt = await httpGet('/map/village.txt', 'text');
        const idx = new Map();
        txt.split('\n').forEach((line) => {
            const p = line.split(',');
            if (p.length < 6) return;
            let name = p[1];
            try { name = decodeURIComponent(name.replace(/\+/g, ' ')); } catch (e) { /* ignore */ }
            idx.set(`${p[2]}|${p[3]}`, { id: p[0], name, owner: p[4], points: +p[5] });
        });
        mapIndex = idx;
        return idx;
    }

    /* ------------------------------------------------------------------ */
    /*  Časové okno dopadu (okno – nočný bonus – zakázané intervaly)       */
    /* ------------------------------------------------------------------ */
    function parseForbidden(str) {
        const out = [];
        const bad = [];
        String(str || '').split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).forEach((part) => {
            const m = part.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?)$/);
            const a = m && parseTime(m[1]);
            const b = m && parseTime(m[2]);
            if (a === null || b === null || !m) bad.push(part);
            else out.push({ s: a, e: b, label: `zakázané ${m[1]}–${m[2]}` });
        });
        return { list: out, bad };
    }
    function subtract(intervals, s, e) {
        const res = [];
        intervals.forEach(([a, b]) => {
            if (e < a || s > b) return res.push([a, b]);
            if (s > a) res.push([a, s - 1000]);
            if (e < b) res.push([e + 1000, b]);
        });
        return res.filter(([a, b]) => b >= a);
    }
    // Vráti povolené intervaly dopadu [[od, do], ...] (uzavreté, presnosť na sekundy).
    function buildArrival() {
        const s = S();
        const a = wallOf(s.date, s.from);
        let b = wallOf(s.date, s.to);
        if (a === null || b === null) return { error: 'Neplatný dátum alebo čas dopadu.' };
        if (b < a) b += DAY;
        const blocks = [];
        if (cfg.night.active && cfg.night.start !== cfg.night.end) {
            blocks.push({ s: cfg.night.start * 3600000, e: cfg.night.end * 3600000, label: `nočný bonus ${pad(cfg.night.start)}:00–${pad(cfg.night.end)}:00` });
        }
        const fb = parseForbidden(s.forbidden);
        if (fb.bad.length) return { error: 'Neplatný zakázaný interval: ' + fb.bad.join(', ') + ' (formát 12:00-13:30)' };
        blocks.push(...fb.list);
        let list = [[a, b]];
        const removed = [];
        for (let day = Math.floor(a / DAY) * DAY - DAY; day <= b + DAY; day += DAY) {
            blocks.forEach((bl) => {
                const bs = day + bl.s;
                const be = bl.e > bl.s ? day + bl.e : day + DAY + bl.e; // cez polnoc
                if (be < a || bs > b) return;
                const before = JSON.stringify(list);
                list = subtract(list, bs, be);
                if (JSON.stringify(list) !== before) removed.push(`${bl.label} (${fmtShort(bs)} – ${fmtShort(be)})`);
            });
        }
        if (!list.length) return { error: 'Celé okno dopadu padá do nočného bonusu alebo zakázaných intervalov.', removed };
        return { list, removed };
    }
    // Okná odoslania pre daný čas pochodu (s rezervou na potvrdenie).
    function sendWindows(arrival, travelMs, buffer, from) {
        const out = [];
        arrival.forEach(([a, b]) => {
            const s = Math.max(a - travelMs, from);
            const e = b - travelMs - buffer;
            if (e >= s) out.push([s, e]);
        });
        return out;
    }
    const inArrival = (arrival, t, buffer = 0) => arrival.some(([a, b]) => t >= a && t + buffer <= b);

    /* ------------------------------------------------------------------ */
    /*  MODUL VÝPOČTU JEDNOTIEK                                            */
    /* ------------------------------------------------------------------ */
    // Dostupné jednotky = doma (snapshot) − rezerva − rezervované vo fronte − odoslané po snapshote.
    function reservedMap(excludeId) {
        const map = {};
        state.queue.forEach((q) => {
            if (q.id === excludeId) return;
            const counts = RESERVING.has(q.status) || (q.status === 'sent' && q.sentAt > snapshotAt);
            if (!counts) return;
            const m = (map[q.sourceId] = map[q.sourceId] || {});
            Object.entries(q.units).forEach(([u, n]) => (m[u] = (m[u] || 0) + n));
        });
        return map;
    }
    function available(v, reserved, ownItem) {
        const r = reserved[v.id] || {};
        const keep = S().reserve || {};
        const back = ownItem ? ownItem.units : {}; // vlastná rezervácia útoku sa vráti späť
        const out = {};
        GAME_UNITS.forEach((u) => (out[u] = Math.max(0, (v.troops[u] || 0) - (keep[u] || 0) - (r[u] || 0) + (back[u] || 0))));
        return out;
    }
    const popOf = (units) => unitList(units).reduce((s, u) => s + units[u] * pop(u), 0);
    const slowest = (units) => unitList(units).reduce((best, u) => (speed(u) > speed(best) ? u : best), unitList(units)[0]);

    function classify(v) {
        const ov = (S().override || {})[v.id] || 'auto';
        if (ov === 'skip') return { type: 'SKIP', why: 'vylúčená používateľom' };
        if (!v.hasTroopData) return { type: 'NONE', why: 'chýbajú údaje o jednotkách' };
        const t = v.troops;
        const offPop = OFF_CLASS.filter((u) => cfg.units[u]).reduce((s, u) => s + (t[u] || 0) * pop(u), 0);
        const defPop = DEFF_CLASS.filter((u) => cfg.units[u]).reduce((s, u) => s + (t[u] || 0) * pop(u), 0);
        if (ov === 'off') return { type: 'OFF', offPop, defPop, why: 'nastavené ručne' };
        if (ov === 'deff') return { type: 'DEFF', offPop, defPop, why: 'nastavené ručne' };
        if (!offPop && !defPop) return { type: 'NONE', offPop, defPop, why: 'bez útočných aj obranných jednotiek' };
        return offPop >= defPop
            ? { type: 'OFF', offPop, defPop, why: `útočná populácia ${fmtNum(offPop)} ≥ obranná ${fmtNum(defPop)}` }
            : { type: 'DEFF', offPop, defPop, why: `obranná populácia ${fmtNum(defPop)} > útočná ${fmtNum(offPop)}` };
    }

    const orderFrom = (str, allowed) => {
        const list = String(str || '').split(/[,\s]+/).map((s) => s.trim()).filter((u) => allowed.includes(u) && cfg.units[u] && GAME_UNITS.includes(u));
        allowed.forEach((u) => { if (!list.includes(u) && cfg.units[u] && GAME_UNITS.includes(u)) list.push(u); });
        return list;
    };

    // Vyskúša jednotlivé varianty a potom kombináciu; vráti najmenšiu vyhovujúcu zostavu.
    function fillPop(need, order, avail) {
        if (need <= 0) return { units: {} };
        for (const u of order) {
            const n = Math.ceil(need / pop(u));
            if ((avail[u] || 0) >= n) return { units: { [u]: n } };
        }
        let rest = need;
        const units = {};
        for (const u of order) {
            if (rest <= 0) break;
            const n = Math.min(avail[u] || 0, Math.ceil(rest / pop(u)));
            if (n > 0) {
                units[u] = n;
                rest -= n * pop(u);
            }
        }
        return rest <= 0 ? { units } : { missing: rest };
    }

    function composeFake(v, kind, avail) {
        const minPop = minPopFor(v);
        const ex = [`Body dediny ${fmtNum(v.points)}${v.pointsSrc ? ` (zdroj: ${v.pointsSrc})` : ''} × ${fakeLimit()} % = ${((v.points * fakeLimit()) / 100).toFixed(2)} → minimum ${minPop} obyv.${fromMap(v) ? ` (vrátane rezervy +${MAP_SAFETY_PCT} %, lebo body sú z mapy)` : ""}`];
        if (!v.points) return { ok: false, reason: 'neznáme body dediny', ex };
        let units = null;
        if (kind === 'OFF') {
            if (!cfg.units.ram || (avail.ram || 0) < 1) return { ok: false, reason: 'žiadne dostupné baranidlá', ex };
            const order = orderFrom(S().offOrder, OFF_FILLERS);
            const maxR = Math.max(1, Math.min(num(S().maxRams) || 1, avail.ram));
            let lastMissing = 0;
            for (let r = 1; r <= maxR && !units; r++) {
                const f = fillPop(minPop - r * pop('ram'), order, avail);
                if (f.units) {
                    units = { ...f.units, ram: r };
                    ex.push(`Baranidlá: ${r} × ${pop('ram')} obyv.; doplnenie v poradí ${order.map((u) => UNIT_NAME[u]).join(' → ')}.`);
                } else lastMissing = f.missing;
            }
            if (!units) return { ok: false, reason: `nedostatok jednotiek (chýba ${lastMissing} obyv.)`, ex };
        } else {
            const order = orderFrom(S().deffOrder, DEFF_FILLERS);
            const f = fillPop(minPop, order, avail);
            if (!f.units) return { ok: false, reason: `nedostatok kopijníkov/mečiarov (chýba ${f.missing} obyv.)`, ex };
            units = f.units;
            ex.push(`Obranné jednotky v poradí ${order.map((u) => UNIT_NAME[u]).join(' → ')} (bez ťažkej jazdy).`);
        }
        const p = popOf(units);
        const slow = slowest(units);
        ex.push(`Zostava ${unitsText(units)} = ${p} obyv. (≥ ${minPop} ✓). Najpomalšia jednotka: ${UNIT_NAME[slow]} (${speed(slow).toFixed(2)} min/pole).`);
        return { ok: true, units, pop: p, minPop, slow, ex };
    }

    // Kontrola zostavy podľa kategórie – volá sa pri plánovaní aj pred každým odoslaním.
    function validateComposition(item, v, avail) {
        const errs = [];
        const u = item.units;
        unitList(u).forEach((k) => { if (!ALLOWED_UNITS.has(k)) errs.push(`nepovolená jednotka ${UNIT_NAME[k] || k}`); });
        if (item.kind === 'OFF' && !(u.ram > 0)) errs.push('OFF fake bez baranidla');
        if (item.kind === 'DEFF' && unitList(u).some((k) => !DEFF_FILLERS.includes(k))) errs.push('DEFF fake smie obsahovať len kopijníkov a mečiarov');
        if (v) {
            const minPop = minPopFor(v);
            if (popOf(u) < minPop) errs.push(`populácia ${popOf(u)} < minimum ${minPop}`);
            if (avail) unitList(u).forEach((k) => { if ((avail[k] || 0) < u[k]) errs.push(`nedostatok: ${UNIT_NAME[k]} ${avail[k] || 0}/${u[k]}`); });
        }
        return errs;
    }

    /* ------------------------------------------------------------------ */
    /*  Overenie súradníc                                                  */
    /* ------------------------------------------------------------------ */
    async function validateTargets() {
        const s = S();
        const raw = String(s.coords || '');
        const tokens = raw.split(/[\s,;]+/).filter(Boolean);
        const valid = [];
        const invalid = [];
        tokens.forEach((tok) => {
            const m = tok.match(/^\(?(\d{1,4})\|(\d{1,4})\)?$/);
            if (!m) {
                const inner = tok.match(/(\d{1,3})\|(\d{1,3})/);
                if (inner && +inner[1] <= 999 && +inner[2] <= 999) valid.push(`${+inner[1]}|${+inner[2]}`);
                else invalid.push(tok);
                return;
            }
            if (+m[1] > 999 || +m[2] > 999) invalid.push(tok);
            else valid.push(`${+m[1]}|${+m[2]}`);
        });
        const seen = new Set();
        const dup = [];
        const unique = [];
        valid.forEach((c) => {
            if (seen.has(c)) dup.push(c);
            else { seen.add(c); unique.push(c); }
        });
        let map = null;
        let mapErr = '';
        try { map = await loadMap(); } catch (e) { mapErr = e.message; }
        const ownIds = new Set(villages.map((v) => v.id));
        const targets = [];
        const stats = { barb: 0, player: 0, own: 0, missing: 0, unknown: 0 };
        (s.allowDup ? valid : unique).forEach((c) => {
            let info = { kind: 'unknown' };
            if (map) {
                const r = map.get(c);
                if (!r) info = { kind: 'missing' };
                else info = { id: r.id, name: r.name, points: r.points, kind: r.owner === '0' ? 'barb' : r.owner === PID || ownIds.has(r.id) ? 'own' : 'player' };
            }
            stats[info.kind]++;
            targets.push({ coord: c, x: +c.split('|')[0], y: +c.split('|')[1], info });
        });
        return { targets, invalid, dup, stats, mapErr, total: tokens.length };
    }

    /* ------------------------------------------------------------------ */
    /*  PLÁNOVANIE                                                         */
    /* ------------------------------------------------------------------ */
    function planTargets(targets) {
        const s = S();
        const arr = buildArrival();
        if (arr.error) return { error: arr.error };
        const t0 = now() + (num(s.leadSec) || 0) * 1000;
        const buffer = (num(s.bufferSec) || 0) * 1000;
        const reserved = reservedMap();
        const usage = {};
        const pairs = new Set();
        state.queue.forEach((q) => {
            if (q.status === 'removed') return;
            usage[q.sourceId] = (usage[q.sourceId] || 0) + 1;
            pairs.add(q.sourceId + '|' + q.target);
        });
        const cls = {};
        villages.forEach((v) => (cls[v.id] = classify(v)));
        const created = [];
        const failed = [];
        const per = Math.max(1, Math.min(50, num(s.perTarget) || 1));

        targets.forEach((t) => {
            for (let k = 0; k < per; k++) {
                if ((t.info.kind === 'own' || t.info.kind === 'missing')) {
                    failed.push({ t, why: t.info.kind === 'own' ? 'vlastná dedina' : 'na súradniciach nie je dedina' });
                    break;
                }
                const rej = {};
                let best = null;
                let considered = 0;
                villages.forEach((v) => {
                    const c = cls[v.id];
                    if (c.type !== 'OFF' && c.type !== 'DEFF') return;
                    if (s.kind === 'off' && c.type !== 'OFF') return;
                    if (s.kind === 'deff' && c.type !== 'DEFF') return;
                    considered++;
                    const d = dist(v, t);
                    if (d === 0) return;
                    if (pairs.has(v.id + '|' + t.coord)) { rej['už útočí na tento cieľ'] = (rej['už útočí na tento cieľ'] || 0) + 1; return; }
                    if (num(s.maxPerVillage) && (usage[v.id] || 0) >= num(s.maxPerVillage)) { rej['limit útokov na dedinu'] = (rej['limit útokov na dedinu'] || 0) + 1; return; }
                    const av = available(v, reserved);
                    const comp = composeFake(v, c.type, av);
                    if (!comp.ok) { rej[comp.reason.replace(/\(.*\)/, '').trim()] = (rej[comp.reason.replace(/\(.*\)/, '').trim()] || 0) + 1; return; }
                    const travel = Math.round(d * speed(comp.slow) * 60) * 1000;
                    const sw = sendWindows(arr.list, travel, buffer, t0);
                    if (!sw.length) { rej['nestihne dopadnúť v okne'] = (rej['nestihne dopadnúť v okne'] || 0) + 1; return; }
                    const score = [usage[v.id] || 0, d];
                    if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
                        best = { v, c, comp, d, travel, sw, score, av };
                    }
                });
                if (!best) {
                    const why = Object.entries(rej).map(([r, n]) => `${r}: ${n}×`).join(', ') || (considered ? 'žiadna vhodná dedina' : 'žiadna použiteľná OFF/DEFF dedina');
                    failed.push({ t, why });
                    break;
                }
                const { v, c, comp, d, travel, sw } = best;
                const item = {
                    id: `${WORLD}-${++state.seq}-${uid()}`,
                    no: state.seq,
                    target: t.coord,
                    targetInfo: t.info,
                    sourceId: v.id,
                    sourceName: v.name,
                    sourceCoord: v.coord,
                    sourcePoints: v.points,
                    kind: c.type,
                    units: comp.units,
                    pop: comp.pop,
                    minPop: comp.minPop,
                    slow: comp.slow,
                    dist: d,
                    travel,
                    arrival: arr.list,
                    buffer,
                    status: 'pending',
                    reason: '',
                    createdAt: now(),
                    why: [
                        `Typ dediny: ${c.type} (${c.why}).`,
                        ...comp.ex,
                        `Vzdialenosť ${d.toFixed(2)} polí × ${speed(comp.slow).toFixed(2)} min = čas pochodu ${fmtDur(travel / 1000)}.`,
                        `Vybraná z ${considered} kandidátov: najmenej použitá (${usage[v.id] || 0}× vo fronte), pri zhode najbližšia.`,
                        `Prvé možné odoslanie ${fmt(sw[0][0])} → dopad ${fmt(sw[0][0] + travel)}.`,
                        Object.keys(rej).length ? `Vyradené dediny: ${Object.entries(rej).map(([r, n]) => `${r} ${n}×`).join(', ')}.` : '',
                    ].filter(Boolean),
                    log: [],
                };
                const errs = validateComposition(item, v, best.av);
                if (errs.length) {
                    failed.push({ t, why: 'kontrola zostavy zlyhala: ' + errs.join('; ') });
                    break;
                }
                log(item, `Naplánovaný z ${v.name}`);
                state.queue.push(item);
                created.push(item);
                usage[v.id] = (usage[v.id] || 0) + 1;
                pairs.add(v.id + '|' + t.coord);
                const r = (reserved[v.id] = reserved[v.id] || {});
                Object.entries(comp.units).forEach(([u, n]) => (r[u] = (r[u] || 0) + n));
            }
        });
        save();
        return { created, failed, removed: arr.removed };
    }

    // Preplánovanie chybného útoku – uvoľní jednotky a hľadá inú dedinu.
    function replan(item) {
        if (!['error', 'unverified', 'pending', 'ready'].includes(item.status)) return;
        const exclude = item.sourceId;
        const target = { coord: item.target, x: +item.target.split('|')[0], y: +item.target.split('|')[1], info: item.targetInfo };
        item.status = 'removed';
        item.reason = 'Preplánované';
        log(item, 'Odstránený kvôli preplánovaniu');
        const saveOv = { ...(S().override || {}) };
        S().override = { ...saveOv, [exclude]: 'skip' };
        const savedPer = S().perTarget;
        S().perTarget = 1;
        const res = planTargets([target]);
        S().override = saveOv;
        S().perTarget = savedPer;
        save();
        return res;
    }

    /* ------------------------------------------------------------------ */
    /*  Vyhodnotenie stavu útokov (každú sekundu)                          */
    /* ------------------------------------------------------------------ */
    function evaluate(item, t, reserved) {
        if (!['pending', 'ready'].includes(item.status)) return;
        const v = villages.find((x) => x.id === item.sourceId);
        if (!v) {
            item.status = 'error';
            item.reason = 'Vysielajúca dedina sa nenašla v aktuálnej skupine.';
            return;
        }
        const errs = validateComposition(item, v, available(v, reserved, item));
        if (errs.length) {
            item.status = 'error';
            item.reason = errs.join('; ');
            log(item, 'Chyba: ' + item.reason);
            return;
        }
        if (inArrival(item.arrival, t + item.travel, item.buffer)) {
            item.status = 'ready';
            item.reason = '';
            return;
        }
        const sw = sendWindows(item.arrival, item.travel, item.buffer, t);
        if (sw.length) {
            item.status = 'pending';
            item.reason = '';
        } else {
            item.status = 'error';
            item.reason = 'Okno odoslania uplynulo – útok by dopadol mimo povoleného času.';
            log(item, item.reason);
        }
    }
    function counts() {
        const c = { sent: 0, waiting: 0, errors: 0, rest: 0, total: 0, ready: 0 };
        state.queue.forEach((q) => {
            if (q.status === 'removed') return;
            c.total++;
            if (q.status === 'sent') c.sent++;
            else {
                c.rest++;
                if (q.status === 'pending' || q.status === 'ready' || q.status === 'progress') c.waiting++;
                if (q.status === 'ready') c.ready++;
                if (q.status === 'error' || q.status === 'unverified') c.errors++;
            }
        });
        return c;
    }

    /* ------------------------------------------------------------------ */
    /*  Odosielanie (vždy s potvrdením hráčom v nádvorí)                 */
    /* ------------------------------------------------------------------ */
    let monitor = null;
    let batch = { running: false, stop: false };

    const placeUrl = (item) => {
        const [x, y] = item.target.split('|');
        const units = unitList(item.units).map((u) => `&${u}=${item.units[u]}`).join('');
        return `/game.php?${SITTER}village=${item.sourceId}&screen=place&x=${x}&y=${y}${units}`;
    };

    async function fetchCommands() {
        const html = await httpGet(gameUrl('overview_villages', '&mode=commands&type=attack&group=0&page=-1'));
        const doc = $($.parseHTML(html));
        const out = [];
        doc.find('#commands_table tr').each(function () {
            const row = $(this);
            let cmdId = row.find('.quickedit[data-id]').attr('data-id') || '';
            const srcIds = new Set();
            row.find('a[href]').each(function () {
                const h = this.getAttribute('href') || '';
                let m;
                if (!cmdId && /screen=info_command/.test(h) && (m = h.match(/[?&]id=(\d+)/))) cmdId = m[1];
                if (/screen=info_village/.test(h) && (m = h.match(/[?&]id=(\d+)/))) srcIds.add(m[1]);
                if (/screen=overview(&|$)/.test(h) && (m = h.match(/[?&]village=(\d+)/))) srcIds.add(m[1]);
            });
            if (!cmdId) return;
            const label = row.find('.quickedit-label').text() || row.find('td').first().text();
            out.push({ cmdId: String(cmdId), srcIds, label: label.trim(), text: row.text() });
        });
        return out;
    }
    const claimedIds = () => new Set(state.queue.filter((q) => q.commandId).map((q) => q.commandId));
    function matchCommands(item, cmds) {
        const re = coordRe(item.target);
        return cmds.filter((c) => c.srcIds.has(String(item.sourceId)) && (re.test(c.label) || re.test(c.text)));
    }

    // Overenie odoslania v prehľade príkazov. Nový príkaz = nebol v "before" a nie je priradený inému útoku.
    async function verifySent(item, tries) {
        const claimed = claimedIds();
        for (let i = 0; i < tries; i++) {
            if (i) await sleep(1500 * i);
            let cmds;
            try {
                cmds = await fetchCommands();
            } catch (e) {
                log(item, 'Overenie: ' + e.message);
                continue;
            }
            const fresh = matchCommands(item, cmds).filter((c) => !claimed.has(c.cmdId) && !(item.before || []).includes(c.cmdId));
            if (fresh.length) return { found: true, cmd: fresh[0], extra: fresh.length - 1 };
        }
        return { found: false };
    }

    function markSent(item, r, how) {
        if (item.status === 'sent') return;
        item.status = 'sent';
        item.sentAt = now();
        item.commandId = r && r.cmd ? r.cmd.cmdId : item.commandId || null;
        item.reason = r && r.extra ? `Pozor: nájdených ${r.extra + 1} nových príkazov z tejto dediny na cieľ.` : '';
        log(item, `Odoslanie overené (${how})${item.commandId ? ', príkaz #' + item.commandId : ''}`);
        save();
        if (window.UI && UI.SuccessMessage) UI.SuccessMessage(`Útok #${item.no} na ${item.target} odoslaný ✓`);
    }

    function precheck(item) {
        const t = now();
        const reserved = reservedMap();
        evaluate(item, t, reserved);
        if (item.status !== 'ready') return item.reason || 'Útok nie je pripravený (mimo okna odoslania).';
        if (!inArrival(item.arrival, t + item.travel, item.buffer)) return 'Dopad by bol mimo povoleného okna.';
        return '';
    }

    /*
     * Režim "DRŽ ENTER":
     * Nádvorie sa načíta do rámu v paneli. Script ho predvyplní, skontroluje a presunie kurzor
     * na tlačidlo hry (Útok → Poslať útok). Každý krok vykoná až skutočné stlačenie Enter/kliknutie
     * hráča na tlačidlo hry – script sám formulár neodosiela. Ak kontrola zlyhá, tlačidlo hry sa zablokuje.
     */
    function sendWin() {
        const f = document.getElementById('dk4-frame');
        return f && f.contentWindow ? f.contentWindow : null;
    }
    function showFrame(on) {
        const box = $('#dk4-sendbox');
        if (on) {
            if (!document.getElementById('dk4-frame')) {
                box.find('.dk4-framehost').html('<iframe id="dk4-frame" src="about:blank" style="width:100%;height:620px;border:1px solid #b89a5d;border-radius:6px;background:#fff"></iframe>');
            }
            box.show();
        } else {
            box.find('.dk4-framehost').empty();
            box.hide();
        }
    }
    function sendInfo(html, level) {
        const col = level === 'ok' ? '#2e7d32' : level === 'warn' ? '#b26a00' : level === 'err' ? '#c62828' : '#3d2f1a';
        $('#dk4-sendinfo').html(html).css({ background: col });
    }
    function focusGameButton(win, btn) {
        try {
            const f = document.getElementById('dk4-frame');
            if (f) f.focus();
            win.focus();
            btn.disabled = false;
            btn.focus();
        } catch (e) { /* ignore */ }
    }
    function blockGameButton(btn) {
        if (!btn) return;
        btn.disabled = true;
        try { btn.blur(); } catch (e) { /* ignore */ }
    }
    // Ochrana pred dvojitým odoslaním pri držaní Enter: po prvom odoslaní formulára sa tlačidlo zablokuje.
    function guardDoubleSubmit(doc, btn) {
        const form = btn && btn.form;
        if (!form || form.__dk4guard) return;
        form.__dk4guard = true;
        form.addEventListener('submit', () => (form.__dk4submitted = true) && setTimeout(() => { btn.disabled = true; }, 0));
    }
    // Vlastné útoky danej dediny na cieľ – z tabuľky "Vlastné príkazy" na nádvorí (bez ďalšej požiadavky).
    function outgoingMatches(doc, item) {
        const table = doc.getElementById('commands_outgoings');
        if (!table) return { table: false, ids: [] };
        const re = coordRe(item.target);
        const ids = [];
        table.querySelectorAll('.quickedit-out[data-id]').forEach((el) => {
            const label = (el.querySelector('.quickedit-label') || el).textContent || '';
            const typ = el.querySelector('[data-command-type]');
            const isAttack = typ ? typ.getAttribute('data-command-type') === 'attack' : /útok/i.test(label);
            if (isAttack && re.test(label)) ids.push(String(el.getAttribute('data-id')));
        });
        return { table: true, ids };
    }

    async function openSend(item, inBatch) {
        if (monitor) {
            if (!inBatch) alert('Práve prebieha odosielanie iného útoku.');
            return false;
        }
        if (item.status === 'sent' || item.status === 'progress') return false;
        const err = precheck(item);
        if (err) {
            render();
            if (!inBatch) alert(`Útok #${item.no} nie je možné odoslať:\n${err}`);
            return false;
        }
        showFrame(true);
        const win = sendWin();
        if (!win) {
            alert('Nádvorie sa nepodarilo načítať do panelu.');
            return false;
        }
        item.status = 'progress';
        item.reason = '';
        item.before = item.before || null;
        log(item, 'Načítané nádvorie (drž Enter / klikni Útok → Poslať útok)');
        save();
        render();
        startMonitor(item, win);
        sendInfo(`Načítavam nádvorie: útok #${item.no} · ${esc(item.sourceName)} → <b>${esc(item.target)}</b>…`);
        try {
            win.location.href = placeUrl(item);
        } catch (e) {
            stopMonitor();
            item.status = 'pending';
            save();
            render();
            return false;
        }
        return true;
    }

    function startMonitor(item, win) {
        let initialDoc = null;
        try { initialDoc = win.document; } catch (e) { /* ignore */ }
        // initialDoc = stránka, ktorá bola v ráme pred načítaním (predchádzajúci útok) – ignoruje sa.
        monitor = { item, initialDoc, doc: null, confirmSeen: false, onConfirm: false, busy: false, prepared: false };
        monitor.timer = setInterval(() => tickMonitor(monitor), 300);
    }
    function stopMonitor() {
        if (monitor) clearInterval(monitor.timer);
        monitor = null;
    }
    function closeFrame() {
        // spracovanie ako "zatvorené okno" urobí monitor
        showFrame(false);
        if (!monitor && batch.running) endBatch('Nádvorie zatvorené – dávka zastavená.');
    }

    async function tickMonitor(m) {
        if (m.busy || monitor !== m) return;
        const item = m.item;
        const win = sendWin();
        if (!win) {
            m.busy = true;
            stopMonitor();
            if (m.confirmSeen) {
                item.reason = 'Overujem…';
                render();
                const r = await verifySent(item, 3);
                if (r.found) markSent(item, r, 'po zatvorení nádvoria');
                else {
                    item.status = 'unverified';
                    item.reason = 'Nádvorie bolo zatvorené po potvrdzovacej obrazovke, ale príkaz sa nenašiel. Over ručne.';
                    log(item, item.reason);
                }
            } else {
                item.status = 'pending';
                item.reason = '';
                log(item, 'Nádvorie zatvorené bez odoslania – vrátené do fronty');
            }
            if (batch.running) endBatch('Nádvorie zatvorené – dávka zastavená.');
            save();
            render();
            return;
        }
        let doc, href;
        try {
            doc = win.document;
            href = win.location.href;
        } catch (e) {
            return;
        }
        if (!doc || doc === m.initialDoc || doc.readyState !== 'complete' || !/screen=/.test(href)) return;
        const newDoc = doc !== m.doc;
        if (newDoc) {
            m.doc = doc;
            m.prepared = false;
            try {
                const cv = doc.getElementById('content_value');
                if (cv) win.scrollTo(0, Math.max(0, cv.getBoundingClientRect().top + win.scrollY - 8));
            } catch (e) { /* ignore */ }
        }
        const isForm = !!doc.querySelector('#target_attack');
        const isConfirm = !!doc.querySelector('#troop_confirm_submit, #troop_confirm_go') || (/try=confirm/.test(href) && !isForm);

        if (isConfirm) {
            m.confirmSeen = true;
            m.onConfirm = true;
            confirmStage(doc, win, m);
            return;
        }
        if (m.onConfirm) {
            // potvrdzovacia obrazovka zmizla → overiť, či vznikol príkaz
            m.onConfirm = false;
            m.busy = true;
            let r = { found: false };
            const local = outgoingMatches(doc, item);
            const claimed = claimedIds();
            const before = item.before || [];
            const fresh = local.ids.filter((id) => !claimed.has(id) && !before.includes(id));
            if (fresh.length) r = { found: true, cmd: { cmdId: fresh[0] }, extra: fresh.length - 1 };
            else if (!local.table || item.before === null) r = await verifySent(item, 3);
            m.busy = false;
            if (monitor !== m) return;
            if (r.found) {
                stopMonitor();
                markSent(item, r, local.ids.length ? 'nádvorie' : 'prehľad príkazov');
                render();
                if (batch.running && !batch.stop) nextInBatch();
                else {
                    if (batch.running) endBatch('Dávka zastavená používateľom.');
                    showFrame(false);
                }
                return;
            }
            const eb = doc.querySelector('.error_box');
            const msg = eb ? eb.textContent.replace(/\s+/g, ' ').trim() : 'Príkaz sa po potvrdení nenašiel.';
            stopMonitor();
            item.status = eb ? 'error' : 'unverified';
            item.reason = 'Hra: ' + msg;
            log(item, 'Po potvrdení: ' + msg);
            save();
            render();
            blockGameButton(doc.getElementById('target_attack'));
            sendInfo(`Útok #${item.no}: ${esc(msg)}`, 'err');
            if (batch.running && !batch.stop) setTimeout(nextInBatch, 800);
            else if (batch.running) endBatch('Dávka zastavená.');
            return;
        }
        if (isForm) {
            // formulár musí patriť vysielajúcej dedine tohto útoku
            if (!new RegExp(`[?&]village=${item.sourceId}(&|$)`).test(href)) return;
            formStage(doc, win, m);
        }
    }

    function setBanner(doc, item, html, level) {
        let b = doc.getElementById('dk4fm-banner');
        if (!b) {
            b = doc.createElement('div');
            b.id = 'dk4fm-banner';
            const host = doc.getElementById('content_value') || doc.body;
            host.insertBefore(b, host.firstChild);
        }
        const col = level === 'ok' ? '#2e7d32' : level === 'warn' ? '#b26a00' : '#c62828';
        b.setAttribute('style', `background:${col};color:#fff;padding:10px 14px;margin:6px 0 10px;border-radius:6px;font:13px/1.5 Verdana,sans-serif`);
        const inner = `<b>DK4 útok #${item.no}</b> · ${esc(item.kind)} FAKE · ${esc(item.sourceName)} → <b>${esc(item.target)}</b> · ${esc(unitsText(item.units))} (${item.pop}/${item.minPop} obyv.)<br>${html}`;
        if (b.innerHTML !== inner) b.innerHTML = inner;
        sendInfo(inner, level);
    }

    function formStage(doc, win, m) {
        const item = m.item;
        const btn = doc.getElementById('target_attack');
        if (!m.prepared) {
            m.prepared = true;
            // stav "pred odoslaním" – vlastné príkazy z tejto dediny na cieľ
            const local = outgoingMatches(doc, item);
            item.before = Array.from(new Set([...(item.before || []), ...local.ids]));
            save();
            // predvyplnenie (URL to už spravila; toto len opraví rozdiely)
            GAME_UNITS.forEach((u) => {
                const inp = doc.getElementById('unit_input_' + u);
                if (!inp) return;
                const want = item.units[u] ? String(item.units[u]) : '';
                if (inp.value !== want) {
                    inp.value = want;
                    inp.dispatchEvent(new Event('change', { bubbles: true }));
                }
            });
            const [x, y] = item.target.split('|');
            const ix = doc.getElementById('inputx');
            const iy = doc.getElementById('inputy');
            const targetOk = ix && iy && ix.value === x && iy.value === y;
            const lacking = [];
            unitList(item.units).forEach((u) => {
                const a = doc.getElementById('units_entry_all_' + u);
                const have = a ? num((a.textContent.match(/\d[\d.\s]*/) || ['0'])[0]) : 0;
                if (have < item.units[u]) lacking.push(`${UNIT_NAME[u]} ${have}/${item.units[u]}`);
            });
            if (lacking.length || !targetOk) {
                item.status = 'error';
                item.reason = lacking.length ? 'Na nádvorí nie je dosť jednotiek: ' + lacking.join(', ') : 'Cieľ sa nepredvyplnil správne.';
                log(item, item.reason);
                blockGameButton(btn);
                setBanner(doc, item, `ZABLOKOVANÉ – ${esc(item.reason)}`, 'err');
                stopMonitor();
                save();
                render();
                if (batch.running && !batch.stop) setTimeout(nextInBatch, 800);
                else if (batch.running) endBatch('Dávka zastavená.');
                return;
            }
            guardDoubleSubmit(doc, btn);
        }
        const arr = now() + item.travel;
        const ok = inArrival(item.arrival, arr, 0);
        if (ok) {
            if (btn && btn.disabled && !btn.form.__dk4submitted) btn.disabled = false;
            if (!m.focused || m.focusedDoc !== doc) {
                m.focused = true;
                m.focusedDoc = doc;
                focusGameButton(win, btn);
            }
            setBanner(doc, item, `Jednotky a cieľ skontrolované ✓ · Dopad pri odoslaní teraz: <b>${fmt(arr)}</b> ✓<br><b>ENTER</b> = Útok (alebo klikni na tlačidlo Útok)`, 'ok');
        } else {
            blockGameButton(btn);
            setBanner(doc, item, `ZABLOKOVANÉ: pri odoslaní teraz by útok dopadol <b>${fmt(arr)}</b> – mimo povoleného okna.`, 'err');
        }
    }

    function confirmStage(doc, win, m) {
        const item = m.item;
        const btn = doc.querySelector('#troop_confirm_submit, #troop_confirm_go');
        const form = (btn && btn.form) || doc.getElementById('command-data-form') || doc.body;
        const val = (name) => {
            const el = form.querySelector(`input[name="${name}"]`);
            return el ? String(el.value) : null;
        };
        const problems = [];
        // presná zhoda s plánom: dedina, cieľ, jednotky
        const [x, y] = item.target.split('|');
        if (val('source_village') !== null && val('source_village') !== String(item.sourceId)) problems.push('iná vysielajúca dedina');
        if (val('x') !== null && (val('x') !== x || val('y') !== y)) problems.push('iný cieľ');
        if (val('attack') !== null && val('attack') !== 'true') problems.push('nie je to útok');
        GAME_UNITS.forEach((u) => {
            const v = val(u);
            if (v === null) return;
            if ((+v || 0) !== (item.units[u] || 0)) problems.push(`${UNIT_NAME[u] || u}: ${v} namiesto ${item.units[u] || 0}`);
        });
        const arr = now() + item.travel;
        const ok = inArrival(item.arrival, arr, 0);
        if (!ok) problems.push(`dopad ${fmt(arr)} je mimo povoleného okna`);
        let gameDur = null;
        form.querySelectorAll('tr').forEach((tr) => {
            const cells = tr.querySelectorAll('td');
            if (gameDur !== null || cells.length < 2 || !/trvanie|duration/i.test(cells[0].textContent || '')) return;
            const mm = (cells[1].textContent || '').trim().match(/(\d+):(\d{2}):(\d{2})/);
            if (mm) gameDur = +mm[1] * 3600 + +mm[2] * 60 + +mm[3];
        });
        const ours = Math.round(item.travel / 1000);
        if (gameDur !== null && Math.abs(gameDur - ours) > 1) problems.push(`čas pochodu v hre ${fmtDur(gameDur)} ≠ ${fmtDur(ours)}`);
        if (problems.length) {
            blockGameButton(btn);
            setBanner(doc, item, `ZABLOKOVANÉ: ${esc(problems.join('; '))}. Útok sa neodošle – zavri nádvorie alebo zastav dávku.`, 'err');
            return;
        }
        guardDoubleSubmit(doc, btn);
        if (m.focusedDoc !== doc) {
            m.focusedDoc = doc;
            focusGameButton(win, btn);
        }
        setBanner(doc, item, `Všetko sedí ✓ · cieľ ${esc(item.target)} · pochod ${fmtDur(ours)} · dopad <b>${fmt(arr)}</b><br><b>ENTER</b> = Poslať útok (alebo klikni na tlačidlo)`, 'ok');
    }

    // ODOSLAŤ PRIPRAVENÉ – cieľ po cieli; každý krok = jedno stlačenie Enter hráčom.
    function startBatch() {
        if (batch.running || monitor) return;
        const c = counts();
        if (!c.ready) return alert('Žiadny útok nie je práve pripravený (sú mimo okna odoslania alebo v chybe).');
        if (!confirm(`Spustiť odosielanie ${c.ready} pripravených útokov?\n\nNádvorie sa otvorí v paneli. DRŽ ENTER – každé stlačenie urobí jeden krok v hre (Útok → Poslať útok), po overení sa načíta ďalší cieľ.\nZastaviť môžeš tlačidlom ZASTAVIŤ alebo pustením Enteru.`)) return;
        batch = { running: true, stop: false };
        render();
        nextInBatch();
    }
    function nextReady() {
        const t = now();
        const reserved = reservedMap();
        state.queue.forEach((q) => evaluate(q, t, reserved));
        return sortedQueue().find((q) => q.status === 'ready');
    }
    async function nextInBatch() {
        if (!batch.running) return;
        if (batch.stop) return endBatch('Dávka zastavená používateľom.');
        const item = nextReady();
        if (!item) return endBatch('Hotovo – žiadny ďalší pripravený útok.');
        const ok = await openSend(item, true);
        if (ok === false) setTimeout(nextInBatch, 300);
    }
    function endBatch(msg) {
        batch = { running: false, stop: false };
        if (!monitor) showFrame(false);
        if (msg && window.UI && UI.InfoMessage) UI.InfoMessage(msg);
        render();
    }

    /* ------------------------------------------------------------------ */
    /*  Používateľské rozhranie                                            */
    /* ------------------------------------------------------------------ */
    let view = 'queue';
    let lastReport = '';
    let villagesOpen = false;
    const openWhy = new Set();

    function sortedQueue() {
        const t = now();
        const key = (q) => {
            if (q.status === 'sent' || q.status === 'removed') return Infinity;
            const sw = sendWindows(q.arrival, q.travel, q.buffer, t);
            return sw.length ? sw[0][0] : Number.MAX_SAFE_INTEGER;
        };
        return state.queue.slice().sort((a, b) => key(a) - key(b) || a.no - b.no);
    }

    const CSS = `
#dk4fm{font:12px/1.45 Verdana,Arial,sans-serif;color:#2b2416;margin:8px 0 14px;border:1px solid #b89a5d;border-radius:8px;background:#f8f0dc;box-shadow:0 2px 8px rgba(0,0,0,.15);overflow:hidden}
#dk4fm *{box-sizing:border-box}
#dk4fm .dk-top{display:flex;align-items:center;gap:10px;padding:10px 14px;background:#3d2f1a;color:#f5e6c4}
#dk4fm .dk-top h3{margin:0;font-size:15px;color:#fff;flex:1}
#dk4fm .dk-mode{padding:4px 10px;border-radius:12px;font-weight:bold;cursor:pointer;border:0}
#dk4fm .dk-body{padding:12px 14px}
#dk4fm .dk-grid{display:grid;grid-template-columns:minmax(220px,1.4fr) minmax(260px,1fr) minmax(260px,1fr);gap:12px}
@media (max-width:900px){#dk4fm .dk-grid{grid-template-columns:1fr}}
#dk4fm .dk-card{background:#fffaf0;border:1px solid #dcc797;border-radius:6px;padding:10px}
#dk4fm .dk-card h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#6b5428}
#dk4fm label{display:block;margin:4px 0 2px;color:#5a4a2a}
#dk4fm input[type=text],#dk4fm input[type=number],#dk4fm input[type=date],#dk4fm input[type=time],#dk4fm select,#dk4fm textarea{width:100%;padding:5px 6px;border:1px solid #c9b07a;border-radius:4px;background:#fff;font:12px Verdana,sans-serif}
#dk4fm textarea{min-height:120px;resize:vertical;font-family:monospace}
#dk4fm .dk-row{display:flex;gap:8px}#dk4fm .dk-row>div{flex:1}
#dk4fm .dk-btn{display:inline-block;padding:6px 12px;border-radius:5px;border:1px solid #7a5c25;background:#e9d5a6;color:#2b2416;font-weight:bold;cursor:pointer;font-size:12px}
#dk4fm .dk-btn:hover{filter:brightness(1.05)}#dk4fm .dk-btn:disabled{opacity:.45;cursor:not-allowed}
#dk4fm .dk-btn.pri{background:#2e7d32;border-color:#1b5e20;color:#fff}
#dk4fm .dk-btn.big{padding:12px 22px;font-size:15px}
#dk4fm .dk-btn.stop{background:#c62828;border-color:#8e1b1b;color:#fff}
#dk4fm .dk-btn.sm{padding:2px 7px;font-size:11px;font-weight:normal}
#dk4fm .dk-btn.send{background:#1565c0;border-color:#0d47a1;color:#fff}
#dk4fm .dk-btn.x{background:#fff;border-color:#c62828;color:#c62828}
#dk4fm .dk-prog{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:12px 0;padding:10px;background:#fffaf0;border:1px solid #dcc797;border-radius:6px}
#dk4fm .dk-bar{flex:1;min-width:220px;height:18px;background:#e7dcc2;border-radius:9px;overflow:hidden;position:relative}
#dk4fm .dk-bar>i{display:block;height:100%;background:linear-gradient(90deg,#43a047,#2e7d32);transition:width .3s}
#dk4fm .dk-bar>span{position:absolute;inset:0;text-align:center;font-weight:bold;line-height:18px;font-size:11px}
#dk4fm .dk-stat{font-size:12px}#dk4fm .dk-stat b{font-size:14px}
#dk4fm .dk-tabs{display:flex;gap:4px;margin:8px 0 0;flex-wrap:wrap}
#dk4fm .dk-tab{padding:5px 12px;border:1px solid #c9b07a;border-bottom:0;border-radius:5px 5px 0 0;background:#eadbb6;cursor:pointer}
#dk4fm .dk-tab.on{background:#fffaf0;font-weight:bold}
#dk4fm .dk-tw{overflow-x:auto;border:1px solid #c9b07a;background:#fffaf0}
#dk4fm table.dk-t{width:100%;border-collapse:collapse;min-width:980px}
#dk4fm table.dk-t th{background:#e4d1a4;text-align:left;padding:5px 6px;font-size:11px;position:sticky;top:0}
#dk4fm table.dk-t td{padding:5px 6px;border-top:1px solid #eadfc4;vertical-align:top}
#dk4fm table.dk-t tr.st-sent td,#dk4fm table.dk-t tr.st-removed td{opacity:.6}
#dk4fm .dk-st{display:inline-block;padding:2px 8px;border-radius:10px;color:#fff;font-size:11px;font-weight:bold;white-space:nowrap}
#dk4fm .dk-k{display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:bold;color:#fff}
#dk4fm .dk-k.OFF{background:#8d2a1a}#dk4fm .dk-k.DEFF{background:#1f5f99}
#dk4fm .dk-u{white-space:nowrap;margin-right:4px}
#dk4fm .dk-mut{color:#7c6a45;font-size:11px}
#dk4fm .dk-why{background:#fff6dd;border-left:3px solid #c9a24f;padding:6px 10px;font-size:11px}
#dk4fm .dk-why ul{margin:0;padding-left:16px}
#dk4fm .dk-rep{margin-top:8px;padding:8px;border-radius:5px;background:#fff;border:1px dashed #c9b07a;font-size:11px;max-height:200px;overflow:auto}
#dk4fm .dk-err{color:#c62828}#dk4fm .dk-ok{color:#2e7d32}
#dk4fm details summary{cursor:pointer;font-weight:bold;margin:6px 0}
`;

    // Statická časť (formulár) sa kreslí len raz / pri zmene režimu – aby sa neprepisovalo rozpísané pole.
    function renderStatic() {
        const s = S();
        const html = `
<div class="dk-top">
  <h3>⚔ DK4 – Správca FAKE útokov <span style="font-weight:normal;font-size:11px">v${VERSION} · ${esc(WORLD)}</span></h3>
  <span class="dk-mut" style="color:#f5e6c4">Čas sveta: <b id="dk4-clock">${fmt(now())}</b> (${tzLabel()})</span>
  <button class="dk-btn sm" id="dk4-close" title="Zavrieť panel (fronta zostane uložená)">✕</button>
</div>
<div class="dk-body">
  <div class="dk-grid">
    <div class="dk-card">
      <h4>1 · Cieľové súradnice</h4>
      <textarea id="dk4-coords" placeholder="500|500 501|499 ...">${esc(s.coords)}</textarea>
      <div class="dk-row">
        <div><label>Fejkov na cieľ</label><input type="number" id="dk4-per" min="1" max="50" value="${esc(s.perTarget)}"></div>
        <div><label>&nbsp;</label><label style="margin-top:6px"><input type="checkbox" id="dk4-dup" ${s.allowDup ? 'checked' : ''}> povoliť opakované súradnice</label></div>
      </div>
    </div>
    <div class="dk-card">
      <h4>2 · Čas dopadu</h4>
      <label>Dátum dopadu</label><input type="date" id="dk4-date" value="${esc(s.date)}">
      <div class="dk-row">
        <div><label>Najskôr</label><input type="time" step="1" id="dk4-from" value="${esc(s.from)}"></div>
        <div><label>Najneskôr</label><input type="time" step="1" id="dk4-to" value="${esc(s.to)}"></div>
      </div>
      <label>Zakázané intervaly (denne, napr. 12:00-13:00, 18:00-18:30)</label>
      <input type="text" id="dk4-forb" value="${esc(s.forbidden)}">
      <div class="dk-mut" style="margin-top:6px">
        Nočný bonus sveta: ${cfg.night.active ? `<b>${pad(cfg.night.start)}:00 – ${pad(cfg.night.end)}:00</b> (vylúčený automaticky)` : '<b>vypnutý</b>'}<br>
        <span id="dk4-arrinfo"></span>
      </div>
    </div>
    <div class="dk-card">
      <h4>3 · Typ fejkov</h4>
      <label>Vysielajúce dediny</label>
      <select id="dk4-kind">
        <option value="mix" ${s.kind === 'mix' ? 'selected' : ''}>OFF aj DEFF (automatický mix)</option>
        <option value="off" ${s.kind === 'off' ? 'selected' : ''}>Iba OFF fejky (s baranidlom)</option>
        <option value="deff" ${s.kind === 'deff' ? 'selected' : ''}>Iba DEFF fejky (kopije/mečiari)</option>
      </select>
      <div class="dk-mut" style="margin-top:6px"><span id="dk4-flinfo"></span> · Skupina: <b>${GROUP || 'všetky'}</b></div>
      <details><summary>Pokročilé</summary>
        <div class="dk-row">
          <div><label>Poradie OFF doplnenia</label><input type="text" id="dk4-offo" value="${esc(s.offOrder)}"></div>
          <div><label>Poradie DEFF</label><input type="text" id="dk4-defo" value="${esc(s.deffOrder)}"></div>
        </div>
        <div class="dk-row">
          <div><label>Max. baranidiel / fake</label><input type="number" id="dk4-maxr" min="1" value="${esc(s.maxRams)}"></div>
          <div><label>Max. útokov / dedina (0 = bez limitu)</label><input type="number" id="dk4-maxv" min="0" value="${esc(s.maxPerVillage)}"></div>
        </div>
        <div class="dk-row">
          <div><label>Rezerva na potvrdenie (s)</label><input type="number" id="dk4-buf" min="0" value="${esc(s.bufferSec)}"></div>
          <div><label>Fake limit % (prázdne = zo servera)</label><input type="text" id="dk4-fl" value="${esc(s.fakeLimitOverride)}"></div>
        </div>
        <label>Rezerva jednotiek doma (nepoužije sa)</label>
        <div class="dk-row" style="flex-wrap:wrap">${SHOWN_UNITS.filter((u) => ALLOWED_UNITS.has(u)).map((u) => `<div style="min-width:70px">${unitIcon(u)}<input type="number" min="0" class="dk4-res" data-u="${u}" value="${esc((s.reserve || {})[u] || 0)}"></div>`).join('')}</div>
      </details>
    </div>
  </div>
  <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
    <button class="dk-btn dk4-busy" id="dk4-validate">Overiť súradnice</button>
    <button class="dk-btn pri dk4-busy" id="dk4-plan">Overiť a naplánovať</button>
    <button class="dk-btn dk4-busy" id="dk4-reload">↻ Aktualizovať jednotky</button>
    <button class="dk-btn dk4-busy" id="dk4-replanall">Preplánovať chybné</button>
    <button class="dk-btn dk4-busy" id="dk4-clear">Vymazať neodoslané</button>
    <button class="dk-btn dk4-busy" id="dk4-clearhist">Vymazať históriu</button>
    <span class="dk-mut" id="dk4-snap"></span>
  </div>
  <div id="dk4-sendbox" style="display:none;margin-top:12px">
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <div id="dk4-sendinfo" style="flex:1;color:#fff;background:#3d2f1a;padding:8px 12px;border-radius:6px;font-size:12px">Nádvorie</div>
      <button class="dk-btn x" id="dk4-closeframe">Zavrieť nádvorie</button>
    </div>
    <div class="dk-mut" style="margin-bottom:4px">Drž <b>ENTER</b>: každé stlačenie stlačí jedno tlačidlo hry (Útok → Poslať útok). Script len predvyplní, skontroluje a presunie kurzor; pri chybe tlačidlo zablokuje.</div>
    <div class="dk4-framehost"></div>
  </div>
  <div id="dk4-dyn"></div>
</div>`;
        let box = $('#dk4fm');
        if (!box.length) {
            $('#dk4fm-style').remove();
            $('head').append(`<style id="dk4fm-style">${CSS}</style>`);
            box = $('<div id="dk4fm"></div>');
            $('#content_value').prepend(box);
            bind(box);
        }
        box.html(html);
    }

    function render() {
        let box = $('#dk4fm');
        if (!box.length || !box.find('#dk4-dyn').length) {
            renderStatic();
            box = $('#dk4fm');
        }
        const s = S();
        const c = counts();
        const pct = c.total ? Math.round((c.sent / c.total) * 100) : 0;
        const busy = batch.running || !!monitor;
        const arr = buildArrival();
        const tb = (k, l) => `<div class="dk-tab ${view === k ? 'on' : ''}" data-view="${k}">${l}</div>`;
        const n = (st) => state.queue.filter((q) => (Array.isArray(st) ? st.includes(q.status) : q.status === st)).length;

        box.find('#dk4-arrinfo').html(arr.error ? `<span class="dk-err">${esc(arr.error)}</span>` : `Povolené okná dopadu: ${arr.list.map(([a, b]) => `${fmtShort(a)} – ${fmtShort(b)}`).join('; ')}`);
        box.find('#dk4-flinfo').html(`Fake limit sveta: <b>${fakeLimit()} %</b> bodov vysielajúcej dediny ${s.fakeLimitOverride !== '' ? '(ručne zmenené)' : '(zo servera)'}`);
        box.find('#dk4-snap').text(`Jednotky načítané ${snapshotAt ? fmtShort(snapshotAt) : '–'} · ${villages.length} dedín`);
        box.find('.dk4-busy').prop('disabled', busy);
        const vd = box.find('#dk4-vill');
        if (vd.length) villagesOpen = vd.prop('open');

        const html = `
  ${lastReport ? `<div class="dk-rep">${lastReport}</div>` : ''}

  <div class="dk-prog">
    <b style="white-space:nowrap">ODOSIELANIE ÚTOKOV</b>
    <div class="dk-bar"><i style="width:${pct}%"></i><span>${c.sent} / ${c.total}</span></div>
    <span class="dk-stat dk-ok">Odoslané <b>${c.sent}</b></span>
    <span class="dk-stat">Čakajúce <b>${c.waiting}</b> (pripravené ${c.ready})</span>
    <span class="dk-stat dk-err">Chybné <b>${c.errors}</b></span>
    <span class="dk-stat">Zostáva <b>${c.rest}</b></span>
    ${batch.running
        ? `<button class="dk-btn big stop" id="dk4-stop">■ ZASTAVIŤ</button>`
        : `<button class="dk-btn big pri" id="dk4-batch" ${monitor || !c.ready ? 'disabled' : ''}>ODOSLAŤ PRIPRAVENÉ (${c.ready})</button>`}
  </div>

  <div class="dk-tabs">
    ${tb('queue', `Fronta (${n(['pending', 'ready', 'progress', 'unverified', 'error'])})`)}
    ${tb('sent', `Odoslané (${n('sent')})`)}
    ${tb('removed', `Odstránené (${n('removed')})`)}
    ${tb('all', `Všetko (${state.queue.length})`)}
  </div>
  <div class="dk-tw">${renderTable()}</div>

  <details id="dk4-vill" ${villagesOpen ? 'open' : ''}><summary>Vlastné dediny a ich klasifikácia (${villages.length})</summary>${villagesOpen ? renderVillages() : ''}</details>`;
        box.find('#dk4-dyn').html(html);
    }

    function renderTable() {
        const t = now();
        const rows = sortedQueue().filter((q) => (view === 'queue' ? ACTIVE.has(q.status) : view === 'all' ? true : q.status === view));
        if (!rows.length) return `<div style="padding:16px" class="dk-mut">Žiadne útoky v tomto zozname.</div>`;
        const busy = batch.running || !!monitor;
        return `<table class="dk-t"><thead><tr>
<th>#</th><th>Cieľ</th><th>Vysielajúca dedina</th><th>Typ</th><th>Zostava</th><th>Čas odoslania</th><th>Čas dopadu</th><th>Stav</th><th>Akcie</th>
</tr></thead><tbody>${rows.map((q) => {
            const st = STATUS[q.status];
            const sw = sendWindows(q.arrival, q.travel, q.buffer, t);
            let sendCell = '';
            let landCell = '';
            if (q.status === 'sent') {
                sendCell = `${fmt(q.sentAt)}`;
                landCell = fmt(q.sentAt + q.travel);
            } else if (q.status === 'removed') {
                sendCell = '–';
                landCell = '–';
            } else if (sw.length) {
                const open = t >= sw[0][0];
                sendCell = `${open ? '<b class="dk-ok">teraz</b>' : fmt(sw[0][0])}<br><span class="dk-mut">najneskôr ${fmtShort(sw[sw.length - 1][1])}${open ? '' : ` · o <span class="dk4-cd" data-t="${sw[0][0]}">${fmtDur((sw[0][0] - t) / 1000)}</span>`}</span>`;
                landCell = `${fmt(Math.max(t, sw[0][0]) + q.travel)}<br><span class="dk-mut">pochod ${fmtDur(q.travel / 1000)} · ${q.dist.toFixed(1)} polí</span>`;
            } else {
                sendCell = '<span class="dk-err">okno uplynulo</span>';
                landCell = '–';
            }
            const tk = q.targetInfo && q.targetInfo.kind;
            const tkTxt = { barb: 'barbarská', player: 'hráč', own: 'vlastná', unknown: 'neoverené', missing: 'neexistuje' }[tk] || '';
            const canSend = ['ready'].includes(q.status) && !busy;
            let actions = '';
            if (q.status === 'ready' || q.status === 'pending') {
                actions += `<button class="dk-btn sm send" data-act="send" data-id="${q.id}" ${canSend ? '' : 'disabled'}>MANUÁLNE ODOSLAŤ</button> `;
            }
            if (q.status === 'unverified') {
                actions += `<button class="dk-btn sm" data-act="verify" data-id="${q.id}" ${busy ? 'disabled' : ''}>Overiť znova</button> <button class="dk-btn sm" data-act="marksent" data-id="${q.id}" ${busy ? 'disabled' : ''}>Bol odoslaný</button> <button class="dk-btn sm" data-act="back" data-id="${q.id}" ${busy ? 'disabled' : ''}>Nebol odoslaný</button> `;
            }
            if (q.status === 'error') actions += `<button class="dk-btn sm" data-act="replan" data-id="${q.id}" ${busy ? 'disabled' : ''}>Preplánovať</button> <button class="dk-btn sm" data-act="recheck" data-id="${q.id}" ${busy ? 'disabled' : ''}>Skontrolovať</button> `;
            if (['pending', 'ready', 'error'].includes(q.status)) actions += `<button class="dk-btn sm x" data-act="cancel" data-id="${q.id}" ${monitor && monitor.item.id === q.id ? 'disabled' : ''}>ZRUŠIŤ</button>`;
            if (q.status === 'progress') actions += '<span class="dk-mut">drž Enter v nádvorí nižšie</span>';
            const why = openWhy.has(q.id)
                ? `<tr class="st-${q.status}"><td></td><td colspan="8"><div class="dk-why"><b>Prečo tento plán:</b><ul>${q.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>${q.log && q.log.length ? `<b>História:</b><ul>${q.log.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}<span class="dk-mut">ID: ${esc(q.id)}${q.commandId ? ' · príkaz #' + esc(q.commandId) : ''}</span></div></td></tr>`
                : '';
            return `<tr class="st-${q.status}" data-row="${q.id}">
<td>${q.no}</td>
<td><b>${esc(q.target)}</b><br><span class="dk-mut">${esc(tkTxt)}</span></td>
<td><a href="/game.php?${SITTER}village=${q.sourceId}&screen=overview" target="_blank">${esc(q.sourceName)}</a><br><span class="dk-mut">${fmtNum(q.sourcePoints)} b.</span></td>
<td><span class="dk-k ${q.kind}">${q.kind} FAKE</span></td>
<td>${unitsHtml(q.units)}<br><span class="dk-mut">${esc(variantName(q.units))} · ${q.pop} obyv. (min ${q.minPop})</span></td>
<td>${sendCell}</td>
<td>${landCell}</td>
<td><span class="dk-st" style="background:${st.c}">${st.t}</span>${q.reason ? `<br><span class="dk-mut" style="color:${st.c}">${esc(q.reason)}</span>` : ''}</td>
<td>${actions} <button class="dk-btn sm" data-act="why" data-id="${q.id}" title="Prečo bola vybraná táto dedina">?</button></td>
</tr>${why}`;
        }).join('')}</tbody></table>`;
    }

    function renderVillages() {
        if (!villages.length) return '<p class="dk-mut">Dediny ešte nie sú načítané.</p>';
        const reserved = reservedMap();
        const ov = S().override || {};
        const rows = villages.map((v) => {
            const c = classify(v);
            const av = available(v, reserved);
            let use = '';
            if (c.type === 'OFF' || c.type === 'DEFF') {
                const comp = composeFake(v, c.type, av);
                use = comp.ok ? `<span class="dk-ok">použiteľná – ${esc(unitsText(comp.units))}</span>` : `<span class="dk-err">nepoužiteľná – ${esc(comp.reason)}</span>`;
            } else use = `<span class="dk-err">nepoužiteľná – ${esc(c.why)}</span>`;
            return `<tr><td>${esc(v.name)}</td><td>${fmtNum(v.points)}</td><td>${v.points ? minPopFor(v) : '–'}</td>
${SHOWN_UNITS.map((u) => `<td title="doma ${v.troops[u] || 0}">${av[u] || 0}</td>`).join('')}
<td>${c.type === 'OFF' || c.type === 'DEFF' ? `<span class="dk-k ${c.type}">${c.type}</span>` : c.type === 'SKIP' ? 'vylúčená' : '–'}<br><span class="dk-mut">${esc(c.why)}</span></td>
<td><select class="dk4-ov" data-id="${v.id}">${['auto', 'off', 'deff', 'skip'].map((o) => `<option value="${o}" ${(ov[v.id] || 'auto') === o ? 'selected' : ''}>${{ auto: 'Auto', off: 'OFF', deff: 'DEFF', skip: 'Vylúčiť' }[o]}</option>`).join('')}</select></td>
<td>${use}</td></tr>`;
        });
        return `<div class="dk-tw"><table class="dk-t"><thead><tr><th>Dedina</th><th>Body</th><th>Min. obyv.</th>${SHOWN_UNITS.map((u) => `<th>${unitIcon(u)}</th>`).join('')}<th>Typ</th><th>Nastavenie</th><th>Fake (voľné jednotky)</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
<p class="dk-mut">Čísla jednotiek = voľné (doma − rezerva − rezervované vo fronte). Ťažká jazda sa zobrazuje len na klasifikáciu, do fejkov sa nikdy nepoužije.</p>`;
    }

    function readSettings(box) {
        const s = S();
        s.coords = box.find('#dk4-coords').val();
        s.perTarget = num(box.find('#dk4-per').val()) || 1;
        s.allowDup = box.find('#dk4-dup').is(':checked');
        s.date = box.find('#dk4-date').val();
        s.from = box.find('#dk4-from').val();
        s.to = box.find('#dk4-to').val();
        if (/^\d{1,2}:\d{2}$/.test(s.from)) s.from += ':00';
        if (/^\d{1,2}:\d{2}$/.test(s.to)) s.to += ':00';
        s.forbidden = box.find('#dk4-forb').val();
        s.kind = box.find('#dk4-kind').val();
        if (box.find('#dk4-offo').length) {
            s.offOrder = box.find('#dk4-offo').val();
            s.deffOrder = box.find('#dk4-defo').val();
            s.maxRams = Math.max(1, num(box.find('#dk4-maxr').val()));
            s.maxPerVillage = num(box.find('#dk4-maxv').val());
            s.bufferSec = num(box.find('#dk4-buf').val());
            s.fakeLimitOverride = String(box.find('#dk4-fl').val() || '').trim();
            s.reserve = s.reserve || {};
            box.find('.dk4-res').each(function () { s.reserve[$(this).data('u')] = num($(this).val()); });
        }
        save();
    }

    function reportValidation(v) {
        const st = v.stats;
        return `<b>Overenie súradníc:</b> zadané ${v.total} · platné ${v.targets.length}${v.dup.length ? ` · opakované ${v.dup.length}${S().allowDup ? ' (ponechané)' : ' (odstránené)'}` : ''}
 · barbarské ${st.barb} · hráčske ${st.player} · vlastné ${st.own} · neexistujú ${st.missing}${st.unknown ? ` · neoverené ${st.unknown}` : ''}
${v.invalid.length ? `<br><span class="dk-err">Neplatné: ${esc(v.invalid.slice(0, 30).join(', '))}${v.invalid.length > 30 ? '…' : ''}</span>` : ''}
${v.mapErr ? `<br><span class="dk-err">Mapu sveta sa nepodarilo načítať (${esc(v.mapErr)}) – existencia cieľov nie je overená.</span>` : ''}
${st.own ? '<br><span class="dk-err">Vlastné dediny nie sú povolené ako cieľ.</span>' : ''}`;
    }

    function bind(box) {
        box.on('change', 'input,select,textarea', function () {
            if ($(this).hasClass('dk4-ov')) {
                const s = S();
                s.override = s.override || {};
                s.override[$(this).data('id')] = $(this).val();
                save();
                villagesOpen = true;
                render();
                return;
            }
            readSettings(box);
            if (/dk4-(date|from|to|forb|fl)/.test(this.id)) render();
        });
        box.on('input', '#dk4-coords', () => {
            S().coords = box.find('#dk4-coords').val();
            save();
        });
        box.on('click', '#dk4-vill > summary', (e) => {
            e.preventDefault();
            villagesOpen = !box.find('#dk4-vill').prop('open');
            box.find('#dk4-vill').prop('open', villagesOpen);
            render();
        });
        box.on('click', '[data-view]', function () {
            view = $(this).data('view');
            render();
        });
        box.on('click', '#dk4-close', () => {
            if (monitor || batch.running) return alert('Najprv dokonči alebo zastav odosielanie.');
            clearInterval(ticker);
            box.remove();
        });
        box.on('click', '#dk4-validate', async () => {
            readSettings(box);
            lastReport = 'Overujem súradnice…';
            render();
            const v = await validateTargets();
            lastReport = reportValidation(v);
            render();
        });
        box.on('click', '#dk4-plan', async () => {
            readSettings(box);
            if (!villages.length) return alert('Dediny nie sú načítané.');
            lastReport = 'Overujem súradnice a plánujem…';
            render();
            const v = await validateTargets();
            if (!v.targets.length) {
                lastReport = reportValidation(v) + '<br><span class="dk-err">Žiadne platné súradnice.</span>';
                return render();
            }
            const res = planTargets(v.targets);
            if (res.error) lastReport = reportValidation(v) + `<br><span class="dk-err">${esc(res.error)}</span>`;
            else {
                const offN = res.created.filter((q) => q.kind === 'OFF').length;
                lastReport = `${reportValidation(v)}<br><b class="dk-ok">Naplánované: ${res.created.length}</b> (OFF ${offN}, DEFF ${res.created.length - offN})
${res.removed && res.removed.length ? `<br><span class="dk-mut">Z okna vylúčené: ${esc(res.removed.join('; '))}</span>` : ''}
${res.failed.length ? `<br><span class="dk-err">Nenaplánované: ${res.failed.length}</span><ul style="margin:2px 0;padding-left:16px">${res.failed.slice(0, 50).map((f) => `<li>${esc(f.t.coord)} – ${esc(f.why)}</li>`).join('')}</ul>` : ''}`;
            }
            view = 'queue';
            tick(true);
        });
        box.on('click', '#dk4-reload', async () => {
            lastReport = 'Načítavam dediny a jednotky…';
            render();
            try {
                await loadVillages();
                lastReport = `Jednotky aktualizované (${villages.length} dedín).`;
            } catch (e) {
                lastReport = `<span class="dk-err">${esc(e.message)}</span>`;
            }
            tick(true);
        });
        box.on('click', '#dk4-replanall', () => {
            const errs = state.queue.filter((q) => q.status === 'error');
            if (!errs.length) return;
            let ok = 0;
            errs.forEach((q) => { const r = replan(q); if (r && r.created && r.created.length) ok++; });
            lastReport = `Preplánované: ${ok} z ${errs.length} chybných útokov.`;
            tick(true);
        });
        box.on('click', '#dk4-clear', () => {
            const act = state.queue.filter((q) => ['pending', 'ready', 'error'].includes(q.status));
            if (!act.length || !confirm(`Odstrániť ${act.length} neodoslaných útokov z fronty? Rezervované jednotky sa uvoľnia.`)) return;
            act.forEach((q) => { q.status = 'removed'; q.reason = 'Hromadne odstránené'; log(q, 'Odstránený'); });
            save();
            render();
        });
        box.on('click', '#dk4-clearhist', () => {
            const h = state.queue.filter((q) => q.status === 'sent' || q.status === 'removed');
            if (!h.length || !confirm(`Vymazať históriu (${h.length} odoslaných/odstránených)?`)) return;
            state.queue = state.queue.filter((q) => !(q.status === 'sent' || q.status === 'removed'));
            save();
            render();
        });
        box.on('click', '#dk4-batch', startBatch);
        box.on('click', '#dk4-closeframe', closeFrame);
        box.on('click', '#dk4-stop', () => {
            batch.stop = true;
            if (!monitor) endBatch('Dávka zastavená.');
            else if (window.UI && UI.InfoMessage) UI.InfoMessage('Dávka sa zastaví po aktuálnom útoku.');
        });
        box.on('click', '[data-act]', async function () {
            const id = $(this).data('id');
            const item = state.queue.find((q) => q.id === id);
            if (!item) return;
            const act = $(this).data('act');
            if (act === 'why') {
                openWhy.has(id) ? openWhy.delete(id) : openWhy.add(id);
                return render();
            }
            if (act === 'send') {
                return openSend(item, false);
            }
            if (act === 'cancel') {
                if (!['pending', 'ready', 'error'].includes(item.status)) return;
                item.status = 'removed';
                item.reason = 'Zrušený používateľom';
                log(item, 'Zrušený – jednotky uvoľnené');
                save();
                return tick(true);
            }
            if (act === 'replan') {
                const r = replan(item);
                lastReport = r && r.created && r.created.length ? `Útok na ${item.target} preplánovaný (nový #${r.created[0].no}).` : `<span class="dk-err">Pre ${esc(item.target)} sa nenašla iná vhodná dedina${r && r.failed && r.failed[0] ? ': ' + esc(r.failed[0].why) : ''}.</span>`;
                return tick(true);
            }
            if (act === 'recheck') {
                item.status = 'pending';
                item.reason = '';
                return tick(true);
            }
            if (act === 'verify') {
                item.reason = 'Overujem…';
                render();
                const r = await verifySent(item, 2);
                if (r.found) markSent(item, r, 'ručné overenie');
                else item.reason = 'Príkaz sa v prehľade stále nenašiel.';
                save();
                return render();
            }
            if (act === 'marksent') {
                if (!confirm('Naozaj bol útok odoslaný v hre? (Skontroluj v prehľade príkazov.)')) return;
                markSent(item, null, 'potvrdené používateľom');
                return render();
            }
            if (act === 'back') {
                if (!confirm('Útok NEBOL odoslaný – vrátiť ho do fronty?')) return;
                item.status = 'pending';
                item.reason = '';
                log(item, 'Vrátený do fronty používateľom');
                save();
                return tick(true);
            }
        });
    }

    // Tik každú sekundu: hodiny, odpočty, zmeny stavov.
    let lastSig = '';
    function tick(forceRender) {
        const t = now();
        const reserved = reservedMap();
        state.queue.forEach((q) => evaluate(q, t, reserved));
        const sig = state.queue.map((q) => q.status + (q.reason || '')).join('|') + '|' + Math.floor(t / 60000);
        if (forceRender || sig !== lastSig) {
            lastSig = sig;
            save();
            render();
        } else {
            $('#dk4-clock').text(fmt(t));
            $('#dk4fm .dk4-cd').each(function () { $(this).text(fmtDur((+$(this).data('t') - t) / 1000)); });
        }
    }

    /* ------------------------------------------------------------------ */
    /*  Štart                                                              */
    /* ------------------------------------------------------------------ */
    $('#dk4fm').remove();
    if (window.__dk4fmTicker) clearInterval(window.__dk4fmTicker);
    $('#content_value').prepend('<div id="dk4fm-loading" style="padding:10px;background:#f4e4bc;border:1px solid #c6a768;margin:8px 0">DK4: načítavam nastavenia sveta, dediny a jednotky…</div>');
    try {
        await loadWorldConfig(false);
        await loadVillages();
    } catch (e) {
        $('#dk4fm-loading').html(`<b style="color:#c62828">DK4 chyba:</b> ${esc(e.message)}`);
        console.error('DK4', e);
        return;
    }
    $('#dk4fm-loading').remove();
    render();
    const ticker = setInterval(() => tick(false), 1000);
    window.__dk4fmTicker = ticker;
    tick(true);
})();
