# Phase 7 real-browser check (Chromium via Playwright) against a REAL local backend + PostgreSQL and the dev server that mimics netlify.toml routing.
# Google is a LOCAL STAND-IN (cloud/test/google-mock-server.ts): the page navigates to https://accounts.google.com/... which this script intercepts, asks the
# stand-in for a code and "returns" the browser to the redirect URI. It proves the whole Petali side in a real browser; it is NOT real Google.
import json, sys, urllib.request, urllib.parse, re
from playwright.sync_api import sync_playwright

SITE = 'http://localhost:8899'; MOCK = 'http://127.0.0.1:8790'; OUT = '/tmp/shots'
results = []
def check(name, ok, detail=''):
    results.append((name, bool(ok), detail)); print(('PASS ' if ok else 'FAIL ') + name + (f'  [{detail}]' if detail and not ok else ''))
def issue(**kw):
    req = urllib.request.Request(MOCK + '/issue', data=json.dumps(kw).encode(), headers={'content-type': 'application/json'})
    return json.load(urllib.request.urlopen(req))['code']

IDENT = {'sub': 'google-sub-001', 'email': 'new.google.user@example.com', 'name': 'Gina Google'}
mode = {'v': 'ok', 'ident': IDENT}
def google_route(route):
    u = urllib.parse.urlparse(route.request.url); q = urllib.parse.parse_qs(u.query)
    ru = q['redirect_uri'][0]; state = q['state'][0]
    if mode['v'] == 'cancel': loc = f'{ru}?error=access_denied&state={state}'
    elif mode['v'] == 'badstate': loc = f'{ru}?code=whatever&state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    else:
        i = mode['ident']
        code = issue(redirectUri=ru, challenge=q['code_challenge'][0], nonce=q['nonce'][0], sub=i['sub'], email=i['email'], name=i['name'], clientId=q['client_id'][0])
        loc = f'{ru}?code={urllib.parse.quote(code)}&state={state}'
    route.fulfill(status=302, headers={'location': loc})

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1100, 'height': 900}); page = ctx.new_page()
    errors = []; IGNORED = ('ERR_NAME_NOT_RESOLVED', 'status of 401')   # no internet in the sandbox (Google Fonts), and the expected 401 of the session-restore call when signed out
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and not any(x in m.text for x in IGNORED) else None); page.on('pageerror', lambda e: errors.append(str(e)))
    page.route('https://accounts.google.com/**', google_route)

    # ---- 1. registration through Google ----
    page.goto(SITE + '/id/login'); page.wait_for_selector('#google-btn')
    check('login page shows Continue with Google', page.inner_text('#google-btn').strip() == 'Continue with Google')
    page.screenshot(path=f'{OUT}/p7-login-day.png')
    page.click('#google-btn'); page.wait_for_url(re.compile(r'/id/(?!login)'), timeout=15000); page.wait_for_selector('nav, .shell, main', timeout=15000)
    page.wait_for_timeout(800)
    check('Google registration lands inside the app (not on the login page)', '/login' not in page.url, page.url)
    page.goto(SITE + '/id/settings'); page.wait_for_selector('text=Recent activity', timeout=15000)
    body = page.inner_text('body')
    parts = {'email': 'new.google.user@example.com' in body, 'google': 'Google' in body, 'nopw-text': 'has no Petali password' in body, 'no-pw-form': page.locator('#pw0').count() == 0}
    check('settings: account created from Google (email, Google sign-in, no password form)', all(parts.values()), str(parts))
    pid1 = re.search(r'PTL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}', body).group(0)
    page.screenshot(path=f'{OUT}/p7-settings-google.png', full_page=True)
    # session persistence: reload keeps the session (cookie refresh), then sign out
    page.reload(); page.wait_for_selector('text=Recent activity', timeout=15000); check('session persists across a reload', '/login' not in page.url)
    cookies = {c['name']: c for c in ctx.cookies()}
    check('session cookie is HttpOnly + SameSite=Strict, one-time Google cookie is gone', cookies.get('petali_rt', {}).get('httpOnly') and cookies['petali_rt']['sameSite'] == 'Strict' and 'petali_gtx' not in cookies, str(list(cookies)))
    page.goto(SITE + '/id/more'); page.wait_for_selector('button:has-text("Sign out")', timeout=10000); page.click('button:has-text("Sign out")'); page.wait_for_url(re.compile('/login'), timeout=10000)
    check('sign out returns to login', True)
    # ---- 2. sign in again with the same Google account: same Petali ID ----
    page.click('#google-btn'); page.wait_for_url(re.compile(r'/id/(?!login)'), timeout=15000); page.goto(SITE + '/id/settings'); page.wait_for_selector('text=Recent activity', timeout=15000)
    pid2 = re.search(r'PTL-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}', page.inner_text('body')).group(0)
    check('second Google sign-in = same Petali ID (no duplicate)', pid1 == pid2, f'{pid1} vs {pid2}')
    page.goto(SITE + '/id/more'); page.click('button:has-text("Sign out")'); page.wait_for_url(re.compile('/login'))
    # ---- 3. cancelled / tampered ----
    mode['v'] = 'cancel'; page.click('#google-btn'); page.wait_for_selector('.g-error:not([hidden])', timeout=15000)
    check('cancelled at Google: message shown, still signed out, reason removed from URL', 'cancelled' in page.inner_text('.g-error').lower() and 'google=' not in page.url and page.locator('#email').count() == 1, page.url)
    page.screenshot(path=f'{OUT}/p7-login-cancelled.png')
    mode['v'] = 'badstate'; page.click('#google-btn'); page.wait_for_selector('.g-error:not([hidden])', timeout=15000)
    check('tampered state: refused, still signed out', 'could not be verified' in page.inner_text('.g-error') and page.locator('#email').count() == 1, page.inner_text('.g-error'))
    # ---- 4. existing account with a VERIFIED email gets linked; an UNVERIFIED one is refused ----
    mode['v'] = 'ok'
    for who, verified in (('linkme@example.com', True), ('pre.registered@example.com', False)):
        r = urllib.request.Request('http://127.0.0.1:8788/v1/web/session/register', data=json.dumps({'email': who, 'password': 'Correct-horse-battery-9', 'displayName': who.split('@')[0]}).encode(), headers={'content-type': 'application/json', 'origin': SITE, 'x-petali-web': '1'})
        urllib.request.urlopen(r)
    import subprocess
    subprocess.run(['su', 'postgres', '-c', "psql -d petali_e2e -c \"UPDATE users SET email_verified_at = now() WHERE email = 'linkme@example.com'\""], check=True, capture_output=True)
    mode['ident'] = {'sub': 'google-sub-002', 'email': 'LinkMe@Example.com', 'name': 'Link Me'}
    page.goto(SITE + '/id/login'); page.click('#google-btn'); page.wait_for_url(re.compile(r'/id/(?!login)'), timeout=15000); page.goto(SITE + '/id/settings'); page.wait_for_selector('text=Recent activity', timeout=15000)
    t = page.inner_text('body'); check('verified existing account is linked (same account, still has a password)', 'linkme@example.com' in t.lower() and 'Email and password' in t and page.locator('#pw0').count() == 1, t[:160])
    page.goto(SITE + '/id/more'); page.click('button:has-text("Sign out")'); page.wait_for_url(re.compile('/login'))
    mode['ident'] = {'sub': 'google-sub-003', 'email': 'pre.registered@example.com', 'name': 'Attacker'}
    page.click('#google-btn'); page.wait_for_selector('.g-error:not([hidden])', timeout=15000)
    check('unverified existing account is NOT taken over: refused with an explanation', 'not confirmed yet' in page.inner_text('.g-error') and page.locator('#email').count() == 1, page.inner_text('.g-error'))
    page.screenshot(path=f'{OUT}/p7-login-needs-verification.png')
    # ---- 5. password login still works (demo account seeded earlier) ----
    page.fill('#email', 'demo@example.com'); page.fill('#password', 'Correct-horse-battery-9'); page.click('form button[type=submit]'); page.wait_for_url(re.compile(r'/id/(?!login)'), timeout=15000)
    check('email/password sign-in still works', '/login' not in page.url)

    # ---- 6. chart highlighting in the real browser (usage page of the seeded demo account) ----
    page.goto(SITE + '/id/usage'); page.wait_for_selector('svg.chart', timeout=15000); page.wait_for_timeout(600)
    svg = page.locator('svg.chart').first; box = svg.bounding_box()
    def layout():
        return page.evaluate("() => { const s = document.querySelector('svg.chart'); const r = s.getBoundingClientRect(); const m = document.querySelector('main') || document.body; return [Math.round(r.width), Math.round(r.height), Math.round(r.top + scrollY), document.documentElement.scrollHeight, document.documentElement.scrollWidth, [...document.querySelectorAll('svg.chart .bar')].map(b => b.getBoundingClientRect().x.toFixed(1) + ',' + b.getBoundingClientRect().height.toFixed(1)).join('|')] }")
    before = layout()
    nbars = page.locator('svg.chart .chart-hit').count()
    page.mouse.move(box['x'] + box['width'] * 0.55, box['y'] + box['height'] * 0.5); page.wait_for_timeout(250)
    on = page.evaluate("() => ({band: document.querySelector('svg.chart .chart-band').classList.contains('on'), active: document.querySelectorAll('svg.chart .is-active').length, tip: !document.querySelector('.chart-tip').hidden, opacity: [...document.querySelectorAll('svg.chart .bar:not(.is-active)')].slice(0,1).map(e => getComputedStyle(e).opacity)[0], bandFill: getComputedStyle(document.querySelector('svg.chart .chart-band')).fill})")
    check('hover: band + one active column + readout, other columns dimmed', on['band'] and on['active'] == 1 and on['tip'] and float(on['opacity']) < 0.7, str(on))
    during = layout(); check('hover causes no layout shift (size, position, scroll size, every bar unchanged)', before == during, f'{before} vs {during}')
    page.screenshot(path=f'{OUT}/p7-chart-hover-day.png', clip={'x': max(0, box['x'] - 20), 'y': max(0, box['y'] - 60), 'width': min(1060, box['width'] + 40), 'height': box['height'] + 110})
    page.mouse.move(5, 5); page.wait_for_timeout(250)
    off = page.evaluate("() => ({band: document.querySelector('svg.chart .chart-band').classList.contains('on'), active: document.querySelectorAll('svg.chart .is-active').length, tip: !document.querySelector('.chart-tip').hidden})")
    check('pointer leaves: normal appearance restored', not off['band'] and off['active'] == 0 and not off['tip'], str(off)); check('after leaving, layout identical to the start', layout() == before)
    # night theme
    page.evaluate("() => document.documentElement.classList.add('night')"); page.wait_for_timeout(200)
    page.mouse.move(box['x'] + box['width'] * 0.3, box['y'] + box['height'] * 0.5); page.wait_for_timeout(250)
    nfill = page.evaluate("() => getComputedStyle(document.querySelector('svg.chart .chart-band')).fill + ' ' + getComputedStyle(document.querySelector('svg.chart .chart-band')).opacity")
    check('night theme: band is drawn with the night ink colour', 'rgb(229, 240, 234)' in nfill or 'color(srgb' in nfill or 'rgba' in nfill, nfill)
    page.screenshot(path=f'{OUT}/p7-chart-hover-night.png', clip={'x': max(0, box['x'] - 20), 'y': max(0, box['y'] - 60), 'width': min(1060, box['width'] + 40), 'height': box['height'] + 110})
    page.mouse.move(5, 5); page.evaluate("() => document.documentElement.classList.remove('night')")
    # keyboard
    svg.focus(); page.keyboard.press('Home'); page.keyboard.press('ArrowRight'); k = page.evaluate("() => document.querySelector('.chart-tip').textContent"); check('keyboard moves the highlight', len(k) > 0 and page.evaluate("() => document.activeElement.classList.contains('chart')"), k); page.keyboard.press('Escape')
    # other charts in the app: health, reports and the computer page
    for path, sel in (('/id/health', 'svg.chart'), ('/id/reports', 'svg.chart')):
        page.goto(SITE + path); page.wait_for_timeout(1200)
        n = page.locator(sel).count()
        if n:
            bx = page.locator(sel).first.bounding_box(); page.mouse.move(bx['x'] + bx['width'] * 0.5, bx['y'] + bx['height'] * 0.5); page.wait_for_timeout(200)
            ok = page.evaluate("() => !!document.querySelector('svg.chart .chart-band.on, svg.chart .chart-guide.on')"); check(f'{path}: highlight works ({n} chart(s))', ok)
        else: print('NOTE', path, 'has no chart for the demo data')
    # ---- 7. touch ----
    tctx = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True); tp = tctx.new_page(); tp.route('https://accounts.google.com/**', google_route)
    tp.goto(SITE + '/id/login'); tp.fill('#email', 'demo@example.com'); tp.fill('#password', 'Correct-horse-battery-9'); tp.click('form button[type=submit]'); tp.wait_for_url(re.compile(r'/id/(?!login)'), timeout=15000)
    tp.goto(SITE + '/id/usage'); tp.wait_for_selector('svg.chart', timeout=15000); tp.wait_for_timeout(600)
    tp.locator('svg.chart').first.scroll_into_view_if_needed(); tp.wait_for_timeout(300); tb = tp.locator('svg.chart').first.bounding_box(); tp.touchscreen.tap(tb['x'] + tb['width'] * 0.6, tb['y'] + tb['height'] * 0.5); tp.wait_for_timeout(250)
    ton = tp.evaluate("() => ({band: document.querySelector('svg.chart .chart-band').classList.contains('on'), tip: !document.querySelector('.chart-tip').hidden})")
    check('touch: tap highlights a column and shows its value', ton['band'] and ton['tip'], str(ton)); tp.screenshot(path=f'{OUT}/p7-chart-touch-mobile.png')
    tp.touchscreen.tap(20, 20); tp.wait_for_timeout(250)
    check('touch: tapping elsewhere clears it', not tp.evaluate("() => document.querySelector('svg.chart .chart-band').classList.contains('on')"))
    mctx = b.new_context(viewport={'width': 390, 'height': 800}, has_touch=True, is_mobile=True); mpg = mctx.new_page(); mpg.goto(SITE + '/id/login'); mpg.wait_for_selector('#google-btn'); check('mobile (PWA viewport): Google button visible and full-width', mpg.locator('#google-btn').bounding_box()['width'] > 250); mpg.screenshot(path=f'{OUT}/p7-login-mobile.png')

    # ---- 8. landing navigation ----
    lp = b.new_page(viewport={'width': 1200, 'height': 800}); lp.goto(SITE + '/'); lp.wait_for_selector('#betaModalOk'); lp.click('#betaModalOk'); lp.wait_for_timeout(300); lp.wait_for_selector('#navPetaliId')
    a = lp.locator('#navPetaliId'); check('nav: label is "Petali ID", href /id/', a.inner_text().strip() == 'Petali ID' and a.get_attribute('href') == '/id/')
    check('nav: no "Open Petali" left in the navigation', lp.locator('nav >> text=Open Petali').count() == 0)
    st = lambda: lp.evaluate("() => { const s = getComputedStyle(document.querySelector('#navPetaliId')); return [s.backgroundColor, s.color, s.borderTopColor, s.fontWeight] }")
    rest = st(); lp.screenshot(path=f'{OUT}/p7-nav-desktop.png', clip={'x': 0, 'y': 0, 'width': 1200, 'height': 90})
    a.hover(); lp.wait_for_timeout(350); hov = st(); lp.screenshot(path=f'{OUT}/p7-nav-desktop-hover.png', clip={'x': 0, 'y': 0, 'width': 1200, 'height': 90})
    check('nav: hover state changes the look', rest != hov, f'{rest} -> {hov}')
    lp.mouse.move(600, 400); lp.keyboard.press('Tab')
    for _ in range(12):
        if lp.evaluate("() => document.activeElement && document.activeElement.id") == 'navPetaliId': break
        lp.keyboard.press('Tab')
    foc = lp.evaluate("() => { const e = document.activeElement; const s = getComputedStyle(e); return [e.id, s.outlineStyle, s.outlineWidth] }")
    check('nav: keyboard focus shows a visible outline', foc[0] == 'navPetaliId' and foc[1] != 'none' and foc[2] != '0px', str(foc)); lp.screenshot(path=f'{OUT}/p7-nav-desktop-focus.png', clip={'x': 0, 'y': 0, 'width': 1200, 'height': 90})
    other = lp.evaluate("() => [...document.querySelectorAll('.nav-links a')].filter(x => x.id !== 'navPetaliId' && !x.classList.contains('btn')).map(x => getComputedStyle(x).backgroundColor)")
    check('nav: distinct from ordinary links (they are transparent, this one is filled)', rest[0] != 'rgba(0, 0, 0, 0)' and all(c == 'rgba(0, 0, 0, 0)' for c in other), f'{rest[0]} vs {other}')
    check('nav: no horizontal overflow at 1200px', lp.evaluate("() => document.documentElement.scrollWidth <= innerWidth"))
    for w in (1280, 1100, 1000, 965):
        lp.set_viewport_size({'width': w, 'height': 800}); lp.wait_for_timeout(200); check(f'nav: not crowded / no overflow at {w}px', lp.evaluate("() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('#navPetaliId').getBoundingClientRect().right <= innerWidth"))
    lp.set_viewport_size({'width': 965, 'height': 800}); lp.wait_for_timeout(200); lp.screenshot(path=f'{OUT}/p7-nav-965.png', clip={'x': 0, 'y': 0, 'width': 965, 'height': 90})
    lp.set_viewport_size({'width': 900, 'height': 800}); lp.wait_for_timeout(300); check('nav: at 900px the compact menu button is shown instead of a crowded row', lp.locator('#menuToggle').is_visible() and lp.evaluate("() => getComputedStyle(document.querySelector('#navLinks')).maxHeight === '0px'"))
    lp.set_viewport_size({'width': 1200, 'height': 800})
    mp = b.new_page(viewport={'width': 390, 'height': 800}); mp.goto(SITE + '/'); mp.wait_for_selector('#betaModalOk'); mp.click('#betaModalOk'); mp.wait_for_timeout(300); mp.wait_for_selector('#menuToggle'); mp.click('#menuToggle'); mp.wait_for_timeout(400)
    mb = mp.locator('#navPetaliId').bounding_box(); check('mobile menu: Petali ID entry visible, full width, tappable', mb is not None and mb['width'] > 250 and mb['height'] >= 40, str(mb)); mp.screenshot(path=f'{OUT}/p7-nav-mobile-menu.png')
    mp.click('#navPetaliId'); mp.wait_for_url(re.compile('/id/'), timeout=10000); check('mobile: opens the Petali ID destination', '/id/' in mp.url)
    check('no console errors / page errors in the whole run', not errors, '; '.join(errors[:4]))
    b.close()
bad = [r for r in results if not r[1]]; print(f'\nBROWSER CHECKS: {len(results) - len(bad)}/{len(results)} passed'); sys.exit(1 if bad else 0)
