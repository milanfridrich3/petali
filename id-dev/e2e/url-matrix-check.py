import sys, urllib.request, urllib.error
from playwright.sync_api import sync_playwright
BASE='http://localhost:8899'; res=[]
def ok(n,c,x=''): res.append(c); print(('PASS ' if c else 'FAIL ')+n+(f' | {x}' if not c else ''))
URLS=['/','/id','/id/','/id/computers','/id/plant','/id/health','/id/settings','/id/usage','/id/reports','/id/register','/id/login','/id/more','/id/computers/3f2b8c1e-5d4a-4e7b-9a10-1c2d3e4f5a6b']
# 1. raw HTTP, redirects NOT followed: every URL must answer 200 directly
class NoRedir(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k): return None
op=urllib.request.build_opener(NoRedir)
for u in URLS:
    try: r=op.open(BASE+u); code=r.status; loc=r.headers.get('Location')
    except urllib.error.HTTPError as e: code=e.code; loc=e.headers.get('Location')
    ok(f'raw HTTP {u}: 200, no redirect', code==200 and not loc, (code,loc))
with sync_playwright() as p:
    b=p.chromium.launch(args=['--no-sandbox']); ctx=b.new_context(viewport={'width':390,'height':844}, service_workers='allow'); page=ctx.new_page()
    errs=[]; page.on('pageerror', lambda e: errs.append(str(e)))
    # 2. browser, signed out: no HTTP redirect chain, app/landing renders
    for u in URLS:
        r=page.goto(BASE+u, wait_until='load')
        hops=0; q=r.request
        while q.redirected_from: hops+=1; q=q.redirected_from
        page.wait_for_timeout(400)
        if u=='/': ok('landing page at / renders (hero + Open Petali)', hops==0 and page.query_selector('a[href="/id/"]') is not None and 'Petali' in page.title(), page.title())
        else: ok(f'browser {u}: 0 HTTP redirects, app rendered', hops==0 and r.status==200 and page.query_selector('#app .topbar') is not None, (hops, r.status))
    page.goto(BASE+'/id'); page.wait_for_timeout(500); ok('/id: address bar ends on /id/login (client-side only)', page.url.startswith(BASE+'/id/login'), page.url)
    page.goto(BASE+'/id/plant'); page.wait_for_url('**/id/login**'); ok('/id/plant signed out -> /id/login?next=%2Fid%2Fplant', page.url==BASE+'/id/login?next=%2Fid%2Fplant', page.url)
    # 3. sign in, then direct load + refresh on every route
    page.fill('#email','demo@example.com'); page.fill('#password','Correct-horse-battery-9'); page.click('button[type=submit]'); page.wait_for_url(BASE+'/id/plant'); page.wait_for_selector('text=Total growth')
    ok('login returns to /id/plant', True)
    marks={'/id':('text=Needs attention','/id/'),'/id/':('text=Needs attention','/id/'),'/id/computers':('text=Desk PC','/id/computers'),'/id/plant':('text=Total growth','/id/plant'),'/id/health':('text=Detected problems','/id/health'),'/id/settings':('text=Signed-in sessions','/id/settings'),'/id/usage':('text=Hardware performance','/id/usage'),'/id/reports':('text=Compared with the previous period','/id/reports')}
    for u,(sel,final) in marks.items():
        r=page.goto(BASE+u); hops=0; q=r.request
        while q.redirected_from: hops+=1; q=q.redirected_from
        try: page.wait_for_selector(sel, timeout=10000); shown=True
        except Exception: shown=False
        ok(f'signed in, direct load {u}: no redirect, content shown, URL {final}', hops==0 and shown and page.url==BASE+final, (hops,shown,page.url))
        page.reload(); 
        try: page.wait_for_selector(sel, timeout=10000); shown=True
        except Exception: shown=False
        ok(f'signed in, refresh {u}', shown and page.url==BASE+final, page.url)
    # 4. service worker + manifest consistency + offline startup
    page.goto(BASE+'/id/'); page.wait_for_selector('text=Needs attention'); page.evaluate('navigator.serviceWorker.ready'); page.reload(); page.wait_for_selector('text=Needs attention')
    info=page.evaluate("(async()=>{const r=await navigator.serviceWorker.getRegistration('/id/');const m=await (await fetch('/id/manifest.webmanifest')).json();return {scope:r.scope,ctl:!!navigator.serviceWorker.controller,start:m.start_url,mscope:m.scope,id:m.id}})()")
    ok('SW scope == manifest scope == /id/, start_url inside scope, page controlled', info['scope']==BASE+'/id/' and info['mscope']=='/id/' and info['start']=='/id/' and info['ctl'], info)
    for u in ['/id/','/id/plant','/id/health','/id/settings']:
        ctx.set_offline(True); page.goto(BASE+u); page.wait_for_timeout(1800)
        t=page.inner_text('body'); ctx.set_offline(False)
        ok(f'offline startup at {u}: shell opens (not an error page), saved copies labelled', page.query_selector('#app .topbar') is not None and ('Saved copy' in t or 'offline' in t.lower()), t[:150])
    land=ctx.new_page(); land.goto(BASE+'/'); land.wait_for_timeout(1200)
    ok('landing page not controlled by the service worker', not land.evaluate('!!navigator.serviceWorker.controller')); land.close()
    ok('no page errors', not errs, errs[:3]); b.close()
print(f'\n{sum(res)}/{len(res)} passed'); sys.exit(0 if all(res) else 1)
