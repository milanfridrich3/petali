import sys, json
from playwright.sync_api import sync_playwright
BASE='http://localhost:8899'
ROUTES=[('dashboard','/id/'),('computers','/id/computers'),('plant','/id/plant'),('usage','/id/usage'),('health','/id/health'),('reports','/id/reports'),('settings','/id/settings'),('more','/id/more')]
res=[]
def ok(n,c,x=''):
    res.append(c); print(('PASS ' if c else 'FAIL ')+n+(f' | {x}' if not c else ''))
def login(page):
    page.goto(BASE+'/id/login'); page.fill('#email','demo@example.com'); page.fill('#password','Correct-horse-battery-9'); page.click('button[type=submit]'); page.wait_for_url(BASE+'/id/'); page.wait_for_selector('.hero')
MARK={'dashboard':'.stats','computers':'.list','plant':'.stages','usage':'text=Hardware performance','health':'text=Latest recorded status','reports':'text=Compared with the previous period','settings':'text=Signed-in sessions','more':'text=Petali website'}
with sync_playwright() as p:
    b=p.chromium.launch(args=['--no-sandbox'])
    for theme in ['day','night']:
        for vname,(w,h,dsf) in {'mobile':(390,844,2),'desktop':(1280,800,1)}.items():
            ctx=b.new_context(viewport={'width':w,'height':h}, device_scale_factor=dsf, is_mobile=(vname=='mobile'), has_touch=(vname=='mobile'))
            ctx.add_init_script(f"try{{localStorage.setItem('petali-id-theme','{theme}')}}catch(e){{}}")
            page=ctx.new_page(); errs=[]; page.on('pageerror', lambda e: errs.append(str(e))); page.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'Failed to load resource' not in m.text else None)
            page.goto(BASE+'/id/login'); page.wait_for_selector('.auth-card'); page.wait_for_timeout(300); page.screenshot(path=f'/tmp/shots2/web-{vname}-{theme}-login.png')
            ok(f'{vname}/{theme}: night class matches theme', page.evaluate("document.documentElement.classList.contains('night')")==(theme=='night'))
            page.click('.switch a'); page.wait_for_selector('#displayName'); page.screenshot(path=f'/tmp/shots2/web-{vname}-{theme}-register.png')
            login(page)
            for name,path in ROUTES:
                page.evaluate(f"history.pushState({{}}, '', '{path}'); dispatchEvent(new PopStateEvent('popstate'))")
                try: page.wait_for_selector(MARK[name], timeout=9000)
                except Exception: ok(f'{vname}/{theme}/{name} rendered', False, page.inner_text('#view')[:150])
                page.wait_for_timeout(700)
                ov=page.evaluate("Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth")
                ok(f'{vname}/{theme}/{name}: no horizontal overflow', ov<=0, ov)
                page.screenshot(path=f'/tmp/shots2/web-{vname}-{theme}-{name}.png', full_page=(vname=='mobile'))
            ok(f'{vname}/{theme}: no console/page errors', not errs, errs[:3]); ctx.close()
    # overflow at many widths (day), every route + login
    for w in [320,360,390,768,1024,1440]:
        ctx=b.new_context(viewport={'width':w,'height':800}); page=ctx.new_page(); page.goto(BASE+'/id/login'); page.wait_for_selector('.auth-card')
        bad=[]
        if page.evaluate("document.documentElement.scrollWidth-innerWidth")>0: bad.append('login')
        login(page)
        for name,path in ROUTES+[('computer','/id/computers/0feec182-7ac2-4677-8c9d-6f118e5712bd')]:
            page.evaluate(f"history.pushState({{}}, '', '{path}'); dispatchEvent(new PopStateEvent('popstate'))"); page.wait_for_timeout(900)
            if page.evaluate("document.documentElement.scrollWidth-innerWidth")>0: bad.append(name)
        ok(f'width {w}: no horizontal overflow on login + all routes', not bad, bad); ctx.close()
    # touch targets (mobile)
    ctx=b.new_context(viewport={'width':390,'height':844}, is_mobile=True, has_touch=True); page=ctx.new_page(); login(page)
    small=page.evaluate("[...document.querySelectorAll('a.tab,button,.btn,a.row,select,input')].filter(e=>e.offsetParent&&(e.getBoundingClientRect().height<40||e.getBoundingClientRect().width<40)).map(e=>e.tagName+'.'+e.className+':'+Math.round(e.getBoundingClientRect().width)+'x'+Math.round(e.getBoundingClientRect().height))")
    ok('touch targets >= 40px on the dashboard', not small, small[:5])
    b.close()
print(f'\n{sum(res)}/{len(res)} passed'); sys.exit(0 if all(res) else 1)
