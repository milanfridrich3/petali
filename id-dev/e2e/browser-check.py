import json, sys
from playwright.sync_api import sync_playwright
BASE='http://localhost:8899'; out=[]
def ok(name, cond, extra=''):
    out.append((name, bool(cond), extra)); print(('PASS ' if cond else 'FAIL ')+name+(' | '+str(extra) if extra and not cond else ''))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844}, device_scale_factor=2, is_mobile=True, has_touch=True, service_workers='allow')
    page=ctx.new_page(); errs=[]
    page.on('console', lambda m: errs.append(m.text) if m.type=='error' else None); page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE+'/id/computers'); page.wait_for_url('**/id/login**')
    ok('unauthenticated nested route redirects to login with next', page.url==BASE+'/id/login?next=%2Fid%2Fcomputers', page.url)
    page.screenshot(path='/tmp/shots/01-login.png')
    page.fill('#email','demo@example.com'); page.fill('#password','wrong-password-123'); page.click('button[type=submit]'); page.wait_for_selector('.form-error:not([hidden])')
    ok('wrong password message', 'incorrect' in page.inner_text('.form-error').lower())
    page.fill('#password','Correct-horse-battery-9'); page.click('button[type=submit]'); page.wait_for_url('**/id/computers'); page.wait_for_selector('text=Desk PC')
    ok('login returns to original route', page.url==BASE+'/id/computers')
    ck=[c for c in ctx.cookies() if 'petali_rt' in c['name']]
    ok('refresh cookie HttpOnly+Strict+scoped', ck and ck[0]['httpOnly'] and ck[0]['sameSite']=='Strict' and ck[0]['path']=='/id/api/v1/web/session', ck)
    ok('document.cookie cannot see it', 'petali_rt' not in page.evaluate('document.cookie'))
    ok('no tokens in web storage', page.evaluate("JSON.stringify([localStorage,sessionStorage])").count('ptr_')==0 and 'tok' not in page.evaluate("JSON.stringify(Object.entries(localStorage))"))
    page.screenshot(path='/tmp/shots/02-computers.png')
    for name,path,wait in [('dashboard','/id/','text=Needs attention'),('plant','/id/plant','text=Total growth'),('usage','/id/usage','text=Hardware performance'),('health','/id/health','text=Detected problems'),('reports','/id/reports','text=Compared with the previous period'),('settings','/id/settings','text=Signed-in sessions'),('more','/id/more','text=Petali website')]:
        page.click(f'a[href="{path}"]') if page.query_selector(f'a[href="{path}"]') else page.evaluate(f"history.pushState({{}}, '', '{path}'); dispatchEvent(new PopStateEvent('popstate'))")
        try: page.wait_for_selector(wait, timeout=8000); good=True
        except Exception: good=False
        ok(f'section {name} renders', good, page.inner_text('#view')[:200]); page.wait_for_timeout(300); page.screenshot(path=f'/tmp/shots/03-{name}.png', full_page=True)
    page.goto(BASE+'/id/computers'); page.wait_for_selector('text=Desk PC'); page.click('a.row >> nth=0'); page.wait_for_selector('text=Manage'); page.screenshot(path='/tmp/shots/04-computer.png', full_page=True)
    ok('computer detail', 'Intel Core i5' in page.inner_text('#view'))
    page.goto(BASE+'/id/plant'); page.wait_for_selector('text=Total growth')
    page.evaluate('navigator.serviceWorker.ready'); page.reload(); page.wait_for_selector('text=Total growth')
    sw=page.evaluate("(async()=>{const r=await navigator.serviceWorker.getRegistration('/id/');return {scope:r&&r.scope,controlled:!!navigator.serviceWorker.controller}})()")
    ok('service worker registered with scope /id/ and controls the app', sw['scope']==BASE+'/id/' and sw['controlled'], sw)
    mf=page.evaluate("fetch('/id/manifest.webmanifest').then(r=>r.json())"); ok('manifest start_url/scope', mf['start_url']=='/id/' and mf['scope']=='/id/' and mf['display']=='standalone')
    # landing page must not be controlled
    land=ctx.new_page(); land.goto(BASE+'/'); land.wait_for_timeout(1500)
    ok('landing page not controlled by the worker', not land.evaluate('!!navigator.serviceWorker.controller'))
    ok('landing page has Open Petali link', land.query_selector('a[href="/id/"]') is not None); land.screenshot(path='/tmp/shots/05-landing.png'); land.close()
    caches=page.evaluate("caches.keys().then(async ks=>{const o={};for(const k of ks){o[k]=(await (await caches.open(k)).keys()).map(r=>new URL(r.url).pathname)}return o})")
    allp=[x for v in caches.values() for x in v]; ok('SW cache holds shell only, no API', len(allp)>20 and not any(x.startswith('/id/api') for x in allp), {k:len(v) for k,v in caches.items()})
    # offline
    ctx.set_offline(True); page.goto(BASE+'/id/usage'); page.wait_for_timeout(2500)
    txt=page.inner_text('body'); ok('offline: app shell opens on a nested route', 'Usage' in txt and 'Petali' in page.title() or 'Usage' in txt, txt[:200])
    ok('offline: saved copy is labelled', 'Saved copy' in txt or 'offline' in txt.lower(), txt[:300]); page.screenshot(path='/tmp/shots/06-offline.png', full_page=True)
    ctx.set_offline(False)
    page.goto(BASE+'/id/plant'); page.wait_for_selector('text=Total growth'); page.wait_for_timeout(500)
    ok('reconnect: live again, not saved', 'Saved copy' not in page.inner_text('#view'))
    # logout
    page.goto(BASE+'/id/more'); page.click('text=Sign out >> nth=-1'); page.wait_for_url('**/id/login**'); page.wait_for_timeout(500)
    n=page.evaluate("new Promise(r=>{const q=indexedDB.open('petali-id',1);q.onsuccess=()=>{const t=q.result.transaction('entries').objectStore('entries').count();t.onsuccess=()=>r(t.result)}})")
    ok('logout wipes saved views', n==0, n)
    page.goto(BASE+'/id/plant'); page.wait_for_url('**/id/login**'); ok('after logout protected route needs login', 'login' in page.url)
    ok('cookie gone', not [c for c in ctx.cookies() if 'petali_rt' in c['name'] and c['value']])
    bad=[e for e in errs if 'Failed to load resource' not in e]; ok('no CSP violations / page errors (font/401 network noise excluded)', not bad, bad[:5])
    b.close()
f=[o for o in out if not o[1]]; print(f'\n{len(out)-len(f)}/{len(out)} passed'); sys.exit(1 if f else 0)
