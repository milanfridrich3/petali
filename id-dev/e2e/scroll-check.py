#!/usr/bin/env python3
"""Petali ID - real-browser scroll check (regression test for "only the scrollbar scrolls").

Drives Chromium (Playwright) through EVERY Petali ID route, on desktop and mobile viewports, and verifies that the page scrolls NATIVELY with:
  - the mouse wheel                       (Input.dispatchMouseEvent mouseWheel, a notched wheel step)
  - a touchpad                            (many small pixel-delta wheel events)
  - a finger swipe                        (Input.dispatchTouchEvent: touchStart / touchMove... / touchEnd -> the browser's own touch scrolling)
  - a swipe that STARTS on a chart        (the chart sets touch-action: pan-y; vertical swipes must still scroll the page)
and that the layout stays intact: the fixed navigation stays in place and clickable, no horizontal scrolling, and <body> is NOT a scroll container.

The API is mocked inside the browser (page.route), so no database/backend is needed. Needs: python3 playwright + Chromium, and the dev server:
    node id-dev/dev-server.mjs          # PORT=8899 by default (BASE=http://localhost:8899 to point elsewhere)
    python3 id-dev/e2e/scroll-check.py  # exit code 0 = every check passed
Pages shorter than the viewport cannot scroll by definition, so each page is first made longer than the screen (extra padding under <main>) - that is
exactly the situation of any long list / form - and its natural height is reported as well.
"""
import json, os, sys
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:8899')
SHOTS = os.environ.get('SHOTS')            # optional directory for screenshots
D1, D2 = '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'
NOW = '2026-11-14T10:00:00.000Z'
DAYS = [f'2026-11-{d:02d}' for d in range(1, 15)]

USER = {'petaliId': 'pid_demo', 'email': 'demo@example.com', 'displayName': 'Demo User', 'emailVerified': True}
def device(i, name):
    return {'id': i, 'name': name, 'status': 'online', 'removed': False, 'lastSyncAt': NOW, 'lastSeenAt': NOW, 'createdAt': NOW, 'appVersion': '1.5.0', 'platform': 'win32',
            'hardware': {'cpu': 'Intel Core i5-1235U', 'threads': 12, 'ramGb': 16, 'os': '10.0.22631', 'arch': 'x64'}}
DEVICES = [device(D1, 'Desk PC'), device(D2, 'Laptop')]
PLANT = {'stage': 'young', 'progress': 0.4, 'nextStage': {'id': 'mature', 'remainingMinutes': 600}, 'growthMinutes': 1800, 'dailyCapMinutes': 240, 'computers': 2,
         'stages': [{'id': s, 'reached': i < 3, 'atMinutes': i * 900} for i, s in enumerate(['seed', 'sprout', 'young', 'mature'])],
         'recentDays': [{'day': d, 'minutes': 60 + 9 * i} for i, d in enumerate(DAYS)],
         'perDevice': [{'name': 'Desk PC', 'removed': False, 'minutes': 1200, 'growthMinutes': 1200}, {'name': 'Laptop', 'removed': False, 'minutes': 600, 'growthMinutes': 600}]}
DAILY = [{'day': d, 'activeMs': (2 + i % 4) * 3600000, 'sessions': 3} for i, d in enumerate(DAYS)]
SUMMARY = {'summary': {'range': {'from': DAYS[0], 'to': DAYS[-1]}, 'coverage': {'firstDay': DAYS[0]}, 'health': {'episodes': 2, 'critical': 0},
    'usage': {'activeMs': sum(d['activeMs'] for d in DAILY), 'activeDays': 14, 'daily': DAILY},
    'apps': {'top': [{'app': a, 'ms': 3600000 * (12 - i)} for i, a in enumerate(['chrome.exe', 'Code.exe', 'Discord.exe', 'steam.exe', 'explorer.exe', 'slack.exe', 'notepad.exe', 'spotify.exe'])], 'otherMs': 1000000, 'unknownMs': 500000, 'attributedMs': 99000000}}}
PERF = {'available': True, 'minutes': 5000, 'daysWithHardware': 14, 'days': [{'dayKey': d, 'tempAvg': 55 + i, 'tempMax': 70 + i} for i, d in enumerate(DAYS)],
        'metrics': [{'id': m, 'unit': u, 'avg': 40.0, 'max': 90.0, 'decimals': 0} for m, u in [('cpuUsage', '%'), ('cpuTemp', '°C'), ('gpuUsage', '%'), ('gpuTemp', '°C'), ('ramUsage', '%'), ('fan', 'rpm')]]}
HEALTH = {'range': {'days': 30}, 'latest': {'status': 'warning', 'at': NOW, 'minutes': {'healthy': 40, 'warning': 20, 'critical': 0}},
          'health': {'recorded': True, 'episodeCount': 2, 'worst': 'warning', 'evaluatedMinutes': 4000, 'statusMinutes': {'warning': 90, 'critical': 0},
                     'problems': [{'id': 'cpuOverheat', 'severity': 'warning', 'count': 2, 'totalMs': 600000, 'lastAt': NOW}], 'episodes': [{'id': 'cpuOverheat', 'severity': 'warning', 'start': NOW, 'end': NOW, 'values': []}]}}
REPORT = {'period': {'kind': 'weekly', 'key': '2026-W46', 'from': DAYS[0], 'to': DAYS[6], 'days': 7, 'incomplete': False}, 'navigation': {'previous': '2026-W45', 'next': None},
          'device': {'name': 'Desk PC'}, 'generatedAt': NOW,
          'usage': {'available': True, 'totalMs': 90000000, 'activeDays': 7, 'knownDays': 7, 'avgPerKnownDayMs': 12000000, 'longestSessionMs': 9000000, 'bestDay': {'dayKey': DAYS[2], 'ms': 14000000},
                    'days': [{'dayKey': d, 'activeMs': (2 + i % 3) * 3600000} for i, d in enumerate(DAYS[:7])]},
          'apps': {'available': True, 'top': SUMMARY['summary']['apps']['top']}, 'hardware': {'minutes': 3000, 'daysWithHardware': 7, 'metrics': PERF['metrics']},
          'health': {'recorded': True, 'episodeCount': 1, 'worst': 'warning', 'problems': []}, 'comparison': {'available': False, 'reason': 'no-previous-data'}}
OVERVIEW = {'devices': {'total': 2, 'active': 2, 'removed': 0, 'stale': 0, 'list': DEVICES}, 'plant': PLANT, 'identity': {'species': 'fern', 'name': 'Fernando'},
            'usage': {'available': True, 'last7Days': {'activeMs': 70000000, 'days': 7}, 'daily': DAILY}, 'health': {'recorded': True, 'episodes30d': 2, 'critical30d': 0},
            'lastSyncAt': NOW, 'alerts': []}
SETTINGS = {'settings': {'language': 'en'}}

def make_mock(authed):
    def mock(route):
        u = route.request.url.split('/id/api', 1)[1].split('?')[0]
        def ok(body, status=200): return route.fulfill(status=status, content_type='application/json', body=json.dumps(body))
        if u == '/v1/web/session/refresh':
            return ok({'accessToken': 'tok', 'accessTokenExpiresAt': '2099-01-01T00:00:00.000Z', 'user': USER}) if authed else ok({'error': {'code': 'no_session', 'message': 'No session'}}, 401)
        table = {'/v1/web/appearance': {'autoNight': None}, '/v1/account/settings': SETTINGS, '/v1/web/overview': OVERVIEW, '/v1/devices': {'devices': DEVICES},
                 '/v1/web/plant': {'plant': PLANT, 'identity': OVERVIEW['identity']}, f'/v1/devices/{D1}': {'device': DEVICES[0]}, f'/v1/devices/{D1}/summary': SUMMARY,
                 f'/v1/devices/{D2}/summary': SUMMARY, f'/v1/web/devices/{D1}/performance': PERF, f'/v1/web/devices/{D1}/health': HEALTH, f'/v1/web/devices/{D1}/report': REPORT,
                 '/v1/account': {'user': USER}, '/v1/account/sessions': {'sessions': [{'id': 's1', 'current': True, 'createdAt': NOW, 'lastUsedAt': NOW, 'userAgent': 'Chrome'}]},
                 '/v1/account/security-events': {'events': [{'type': 'login', 'at': NOW} for _ in range(8)]}}
        return ok(table[u]) if u in table else ok({'error': {'code': 'not_found', 'message': 'not found'}}, 404)
    return mock

PUBLIC = ['/id/login', '/id/register', '/id/verify', '/id/does-not-exist']
PRIVATE = ['/id/', '/id/computers', f'/id/computers/{D1}', '/id/plant', '/id/usage', '/id/health', '/id/reports', '/id/settings', '/id/more']
VIEWPORTS = {  # name: (context kwargs, touch?)
    'desktop 1280x720': (dict(viewport={'width': 1280, 'height': 720}), False),
    'laptop 1024x640': (dict(viewport={'width': 1024, 'height': 640}), False),
    'mobile 390x844': (dict(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, device_scale_factor=3), True),
    'narrow 320x568': (dict(viewport={'width': 320, 'height': 568}, has_touch=True, is_mobile=True, device_scale_factor=2), True),
}

def sy(page): return page.evaluate('Math.round(window.scrollY)')
def to_top(page): page.evaluate('window.scrollTo(0,0)'); page.wait_for_timeout(60)

def swipe(cdp, page, x, y, dy, steps=14):   # finger moves UP by -dy... dy<0 scrolls the page down
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for k in range(1, steps + 1):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y + dy * k / steps}]}); page.wait_for_timeout(16)
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); page.wait_for_timeout(700)

def check_page(ctx, page, vp, touch, path, failures):
    page.goto(BASE + path); page.wait_for_selector('main#view > *', timeout=10000); page.wait_for_timeout(700)
    vw, vh = page.evaluate('[innerWidth, innerHeight]')
    natural = page.evaluate('document.documentElement.scrollHeight')
    page.evaluate("document.querySelector('main').style.paddingBottom = '2200px'")      # a long page / long form, whatever the content
    page.wait_for_timeout(100)
    res = {}; bad = []
    st = page.evaluate('''() => ({ bodyOY: getComputedStyle(document.body).overflowY, bodyOX: getComputedStyle(document.body).overflowX,
        sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, doc: document.documentElement.scrollHeight })''')
    if st['bodyOY'] not in ('visible', 'clip'): bad.append(f"body is a scroll container (overflow-y: {st['bodyOY']})")
    if st['sw'] > st['cw']: bad.append(f"horizontal overflow ({st['sw']} > {st['cw']})")
    if st['doc'] <= vh + 200: bad.append('page not taller than the viewport after padding (test setup)')
    nav = page.query_selector('nav.tabbar:not([hidden])')
    nav_before = nav.bounding_box() if nav and nav.is_visible() else None
    to_top(page)
    if touch:
        cdp = ctx.new_cdp_session(page)
        x = vw // 2
        swipe(cdp, page, x, int(vh * 0.62), -int(vh * 0.4)); res['swipe'] = sy(page)
        if res['swipe'] < 100: bad.append(f"touch swipe did not scroll the page (scrollY={res['swipe']})")
        # a second, longer swipe continues from where it is (and a swipe back up returns)
        before = sy(page); swipe(cdp, page, x, int(vh * 0.62), -int(vh * 0.4)); res['swipe2'] = sy(page)
        if res['swipe2'] <= before: bad.append('second swipe did not scroll further')
        swipe(cdp, page, x, int(vh * 0.30), int(vh * 0.4)); res['swipe_back'] = sy(page)
        if res['swipe_back'] >= res['swipe2']: bad.append('swipe in the other direction did not scroll back')
        chart = page.query_selector('svg.chart')            # a vertical swipe that starts ON a chart (touch-action: pan-y) must still scroll the page
        if chart:
            to_top(page); chart.scroll_into_view_if_needed(); page.wait_for_timeout(150); b = chart.bounding_box(); y0 = sy(page)
            if b and 0 < b['y'] < vh - 140:
                swipe(cdp, page, int(b['x'] + b['width'] / 2), int(b['y'] + b['height'] / 2), -int(vh * 0.25)); res['swipe_on_chart'] = sy(page) - y0
                if res['swipe_on_chart'] < 60: bad.append(f"swipe starting on a chart did not scroll ({res['swipe_on_chart']}px)")
    else:
        page.mouse.move(vw // 2, int(vh * 0.4))
        page.mouse.wheel(0, 400); page.wait_for_timeout(450); res['wheel'] = sy(page)
        if res['wheel'] < 100: bad.append(f"mouse wheel did not scroll the page (scrollY={res['wheel']})")
        page.mouse.wheel(0, -400); page.wait_for_timeout(450)
        if sy(page) > 5: bad.append(f'wheel up did not scroll back (scrollY={sy(page)})')
        to_top(page)
        for _ in range(30): page.mouse.wheel(0, 6); page.wait_for_timeout(6)       # touchpad: a stream of small pixel deltas
        page.wait_for_timeout(350); res['touchpad'] = sy(page)
        if res['touchpad'] < 60: bad.append(f"touchpad-style small deltas did not scroll (scrollY={res['touchpad']})")
        to_top(page); page.keyboard.press('PageDown'); page.wait_for_timeout(450); res['pagedown'] = sy(page)
        if res['pagedown'] < 100: bad.append(f"keyboard PageDown did not scroll (scrollY={res['pagedown']})")
        # wheel while the pointer is over the chart / a card / the header / the fixed nav, none of them may swallow it
        for sel in ['svg.chart', '.card', 'header.topbar', 'nav.tabbar:not([hidden])']:
            el = page.query_selector(sel)
            if not el or not el.is_visible(): continue
            to_top(page); el.scroll_into_view_if_needed(); page.wait_for_timeout(120); b = el.bounding_box(); y0 = sy(page)
            if not b or not (0 <= b['y'] + b['height'] / 2 <= vh): continue
            page.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2); page.mouse.wheel(0, 300); page.wait_for_timeout(450)
            res[f'wheel_over {sel.split(":")[0]}'] = sy(page) - y0
            if sy(page) - y0 < 60: bad.append(f'wheel over {sel} did not scroll the page')
    # fixed navigation: still where it was while the page is scrolled, and still clickable
    if nav_before:
        nb = nav.bounding_box()
        if abs(nb['y'] - nav_before['y']) > 1 or abs(nb['x'] - nav_before['x']) > 1: bad.append(f"fixed nav moved while scrolling ({nav_before} -> {nb})")
        tab = page.query_selector('nav.tabbar a.tab')
        if tab:
            tb = tab.bounding_box(); top = page.evaluate('([x,y]) => { const e = document.elementFromPoint(x, y); return !!(e && e.closest("a.tab")) }', [tb['x'] + tb['width'] / 2, tb['y'] + tb['height'] / 2])
            if not top: bad.append('a nav tab is covered / not clickable while scrolled')
    if SHOTS: os.makedirs(SHOTS, exist_ok=True); page.screenshot(path=os.path.join(SHOTS, f"{vp.split()[0]}-{path.strip('/').replace('/', '_') or 'dashboard'}.png"))
    ok = not bad
    print(f"  {'PASS' if ok else 'FAIL'}  {path[:30]:<30} natural={natural:>5}px  {json.dumps(res)}")
    for m in bad: print(f'        - {m}'); failures.append(f'{vp} {path}: {m}')

def main():
    failures = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        for vp, (kw, touch) in VIEWPORTS.items():
            print(f'== {vp} ({"touch swipe" if touch else "mouse wheel / touchpad / keyboard"}) ==')
            for authed, paths in ((False, PUBLIC), (True, PRIVATE)):
                ctx = b.new_context(**kw); page = ctx.new_page(); errors = []
                page.on('pageerror', lambda e: errors.append(str(e)))
                page.route('**/id/api/**', make_mock(authed)); page.route('**/fonts.g*apis.com/**', lambda r: r.abort())
                for path in paths: check_page(ctx, page, vp, touch, path, failures)
                for e in errors: print(f'  page error: {e}'); failures.append(f'{vp} page error: {e}')
                ctx.close()
        b.close()
    print(); print('ALL SCROLL CHECKS PASSED' if not failures else f'{len(failures)} FAILURE(S)')
    sys.exit(1 if failures else 0)

if __name__ == '__main__': main()
