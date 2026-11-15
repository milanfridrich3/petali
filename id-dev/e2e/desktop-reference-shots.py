import sys
from playwright.sync_api import sync_playwright
STUB = """
(() => {
  const H = n => Array.from({length:n},(_, i)=>30+Math.round(20*Math.sin(i/3)+i%5));
  const data = { time:{activeMinutes:215}, cpu:{load:34,history:H(40),model:'Intel Core i5-1235U',threads:12,perCore:[30,40,22,35]}, temp:{value:62,history:H(40)}, ram:{used:9.2,total:16,pct:57,available:6.8,swapUsed:1,swapTotal:4},
    ssd:{used:310,total:512}, gpu:{value:55,history:H(40)}, fan:{rpm:1400}, sensors:null, health:null, computer:{name:'Desk PC'},
    plant:{state:'happy',since:0,streakMin:12,stage:'young',stageIndex:2,progress:0.4,growthMinutes:840,dayCapReached:false,settings:{species:'fern',name:'Fernando',effects:true}}, extras:{}, long:{cpu:H(60),temp:H(60)} };
  const noop = () => Promise.resolve(null);
  const api = new Proxy({}, { get: (_, k) => k === 'onMetrics' ? (cb => { setTimeout(() => cb(data), 300); setInterval(() => cb(data), 4000); }) : (() => noop()) });
  Object.defineProperty(window, 'petaliAPI', { value: api, configurable: true });
  try { localStorage.setItem('petali.onboarded', '1'); } catch (e) {}
})();
"""
with sync_playwright() as p:
    b=p.chromium.launch(args=['--no-sandbox','--allow-file-access-from-files'])
    for name,(w,h),night in [('desktop-day',(1280,800),False),('desktop-night',(1280,800),True),('mobile-day',(390,844),False)]:
        ctx=b.new_context(viewport={'width':w,'height':h}, device_scale_factor=1 if w>600 else 2); page=ctx.new_page(); errs=[]
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.add_init_script(STUB)
        page.goto('file:///home/claude/work/app-and-cloud/renderer/index.html'); page.wait_for_timeout(1500)
        if name=='desktop-day': page.screenshot(path='/tmp/shots2/onboarding-DESKTOP-APP.png')
        try:
            page.click('#onboardLanguages button[data-lang=en], #onboardLanguages button >> nth=1'); page.wait_for_timeout(300)
            for _ in range(4):
                if not page.is_visible('#onboarding'): break
                btns=page.query_selector_all('#onboarding .primary')
                for bt in btns:
                    if bt.is_visible(): bt.click(); page.wait_for_timeout(500); break
        except Exception as e: print('onboard', str(e)[:100])
        page.wait_for_timeout(1200)
        try: page.click("text=Got it", timeout=2000)
        except Exception: pass
        page.wait_for_timeout(1200)
        if night: page.evaluate("document.documentElement.classList.add('night');document.querySelector('.app')&&document.querySelector('.app').classList.add('night')")
        page.wait_for_timeout(500); page.screenshot(path=f'/tmp/shots2/{name}-DESKTOP-APP.png')
        print(name, errs[:2]); ctx.close()
    b.close()
