# Browser rehearsal of the production wiring (rehearsal-server.mjs). Usage: python3 rehearsal-browser.py <site-port> [with-backend]
# Without "with-backend" the backend is expected to be DOWN: the standalone /support page must work anyway.
import json, sys
from playwright.sync_api import sync_playwright
B = 'http://localhost:' + sys.argv[1]
WITH_BACKEND = len(sys.argv) > 2 and sys.argv[2] == 'with-backend'
SHOTS = sys.argv[3] if len(sys.argv) > 3 else '/tmp'
out = []
def ok(name, cond, detail=''): out.append((name, bool(cond), detail)); print(('ok   ' if cond else 'FAIL ') + name, '' if cond else detail)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1100, 'height': 900})

    # ---- the standalone public page /support: no Petali ID, no backend
    pg2 = ctx.new_page(); errs2 = []; reqs = []; resp = {}
    pg2.on('console', lambda m: errs2.append(m.text) if m.type == 'error' else None); pg2.on('pageerror', lambda e: errs2.append(str(e))); pg2.on('request', lambda r: reqs.append(r.url))
    pg2.on('response', lambda r: resp.setdefault(r.url, r.status))
    r = pg2.goto(B + '/support'); pg2.wait_for_selector('.chips', timeout=8000)
    ok('/support: loads with status 200 at the clean URL', r.status == 200 and pg2.url == B + '/support', (r.status, pg2.url))
    ok('/support: shows amount choices from the generated (enabled) configuration', 'Support Petali' in pg2.inner_text('h1') and pg2.locator('.chips').count() == 1)
    pg2.click('#amt-500 + .opt'); pg2.wait_for_selector('.qr-code'); body2 = pg2.inner_text('body')
    ok('/support: QR, amount + currency, copyable details', '5.00 EUR' in body2 and all(k in body2 for k in ['Recipient', 'IBAN', 'BIC', 'Message']))
    pg2.click('#amt-custom + .opt'); pg2.fill('#support-custom', '1 250,5'); pg2.wait_for_timeout(100)
    ok('/support: custom amount with localized separators', '1250.50 EUR' in pg2.inner_text('body') or 'largest' in pg2.inner_text('#support-custom-error'))
    pg2.fill('#support-custom', '-4'); pg2.wait_for_timeout(100)
    ok('/support: invalid amount -> friendly message, no QR', 'positive' in pg2.inner_text('#support-custom-error') and pg2.locator('.qr-code').count() == 0)
    pg2.fill('#support-custom', '17,5'); pg2.wait_for_selector('.qr-code'); pg2.screenshot(path=SHOTS + '/petali-support-page.png')
    extra = [u for u in reqs if '/id/' in u or '/v1/' in u or '/api' in u]
    ok('/support: made no request to Petali ID (app, API or session) and none under /id/', not extra, extra)
    ok('/support: payment code is served from /support-assets/', all(resp.get(B + '/support-assets/' + f) == 200 for f in ['support-rules.js', 'support-epc.js', 'support-qr.js', 'qrcode-generator.js']), {k: v for k, v in resp.items() if 'support' in k})
    ok('/support: no cookies and no browser storage', pg2.evaluate("document.cookie") == '' and len(ctx.cookies()) == 0 and pg2.evaluate("localStorage.length + sessionStorage.length") == 0, ctx.cookies())
    bad2 = [e for e in errs2 if 'Failed to load resource' not in e]; ok('/support: no console errors', not bad2, bad2[:3])
    pg2.set_viewport_size({'width': 380, 'height': 800}); pg2.wait_for_timeout(150); ok('/support: no horizontal scrolling on a phone', pg2.evaluate("document.documentElement.scrollWidth <= innerWidth + 1")); pg2.screenshot(path=SHOTS + '/petali-support-page-mobile.png', full_page=True)
    r = pg2.goto(B + '/support/'); pg2.wait_for_selector('.chips', timeout=8000); ok('/support/ (trailing slash) also loads the page with all its assets', r.status == 200)

    # ---- /support-config.json is served from the site root
    cfg = ctx.request.get(B + '/support-config.json'); j = cfg.json()
    ok('/support-config.json is served from the website root as JSON', cfg.status == 200 and 'json' in cfg.headers.get('content-type', '') and j.get('enabled') is True and 'iban' in j, (cfg.status, cfg.headers.get('content-type')))

    # ---- the old Petali ID support page no longer exists
    for path in ['/id/support', '/id/support/', '/id/support/anything']:
        r = ctx.request.get(B + path); ok(path + ' returns 404 (not the app shell, not a redirect)', r.status == 404 and 'Petali ID' not in r.text(), r.status)
    pg4 = ctx.new_page(); r = pg4.goto(B + '/id/support'); ok('/id/support in a browser: 404 and no support UI', r.status == 404 and pg4.locator('.chips').count() == 0 and pg4.url == B + '/id/support', (r.status, pg4.url))
    r = ctx.request.get(B + '/id/js/views-support.js'); ok('the old Petali ID support view is not served', r.status in (404,) or 'Support Petali' not in r.text(), r.status)

    # ---- the website navigation links to /support
    pg3 = ctx.new_page(); pg3.goto(B + '/index.html'); pg3.wait_for_selector('.download')
    hrefs = pg3.evaluate("[...document.querySelectorAll('.download a.btn')].map(a => [a.textContent.trim(), a.getAttribute('href')])")
    ok('index.html: Download Petali / Download Petali Lite point to the exact release URLs', ['Download Petali', 'https://github.com/milanfridrich3/petali/releases/latest/download/Petali_Setup.exe'] in hrefs and ['Download Petali Lite', 'https://github.com/milanfridrich3/petali/releases/latest/download/Petali_Setup_Lite.exe'] in hrefs, hrefs)
    ok('index.html: the Support navigation item links to /support', pg3.evaluate("[...document.querySelectorAll('.nav-links a')].some(a => a.textContent.trim() === 'Support' && a.getAttribute('href') === '/support')"))
    pg3.evaluate("[...document.querySelectorAll('.nav-links a')].find(a => a.textContent.trim() === 'Support').click()"); pg3.wait_for_selector('.chips', timeout=8000); ok('clicking Support in the navigation opens /support', pg3.url == B + '/support', pg3.url)

    if WITH_BACKEND:
        h = pg2.evaluate("fetch('/id/api/v1/health').then(r=>r.json())"); ok('/id/api proxy reaches the backend: /v1/health', h.get('status') == 'ok' and h.get('serviceVersion') == '1.6.0', h)
    b.close()
sys.exit(0 if all(x[1] for x in out) else 1)
