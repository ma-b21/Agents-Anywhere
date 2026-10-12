"""Headless integration against an isolated fake service and the real browser auth modules."""
from playwright.sync_api import sync_playwright
from urllib.request import urlopen

BASE = "http://127.0.0.1:5389"

def stats(page):
    return page.evaluate("async()=>await (await fetch('/stats')).json()")

def ready(context):
    page = context.new_page()
    page.goto(BASE)
    page.wait_for_load_state("networkidle")
    assert page.locator("#ready").inner_text() == "Ready"
    return page

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    try:
        context = browser.new_context()
        pages = [ready(context) for _ in range(3)]
        a, b, c = pages
        assert a.evaluate("()=>login('A')") == "A"
        for page in pages[1:]:
            assert page.evaluate("async()=>(await restore()).userId") == "A"
        assert a.evaluate("()=>!document.cookie.includes('fixture_sid')")
        print("PASS HttpOnly Cookie login and three-tab restore")

        before = stats(a)
        future = a.evaluate("()=>fixtureNow+8*86400000")
        for page in pages:
            page.evaluate("value=>{fixtureNow=value;window.pending=Promise.all(Array.from({length:20},()=>work('A-0')))}", future)
        for page in pages:
            assert all(r["ok"] for r in page.evaluate("()=>pending"))
        after = stats(a)
        assert after["refreshes"] - before["refreshes"] == 1
        assert after["accepted"] - before["accepted"] == 60
        assert a.evaluate("()=>!Object.values(localStorage).some(s=>s.includes('refreshToken')||s.includes('csrfToken'))")
        print("PASS eight-day fake clock and 60 concurrent requests: one cross-tab refresh")

        # Force only the initial business response to 401; subsequent send reaches the service.
        for multipart in [False, True]:
            counter = [0]
            def reject_once(route):
                counter[0] += 1
                if counter[0] == 1:
                    route.fulfill(status=401, content_type="application/json", body='{"detail":"unauthorized"}')
                else:
                    route.continue_()
            a.route("**/api/v2/work?mode=ok", reject_once)
            result = a.evaluate("multipart=>work('A-0','ok',multipart)", multipart)
            assert result["ok"] and counter[0] == 2
            a.unroute("**/api/v2/work?mode=ok", reject_once)
        print("PASS JSON and FormData replay only once after definite 401")

        counter = [0]
        def lose_response(route):
            counter[0] += 1
            route.abort("connectionreset")
        a.route("**/api/v2/work?mode=ok", lose_response)
        assert a.evaluate("async()=>{try{await work('A-0');return false}catch{return !!auth.current()}}")
        assert counter[0] == 1
        a.unroute("**/api/v2/work?mode=ok", lose_response)
        print("PASS lost business response does not replay or clear login")

        for page in pages:
            page.evaluate("()=>fixtureNow+=61000")
        context.set_offline(True)
        assert a.evaluate("async()=>{try{await work('A-0');return false}catch{return !!auth.current()}}")
        context.set_offline(False)
        assert a.evaluate("()=>work('A-0')")["ok"]
        print("PASS offline expiry preserves identity and recovers online")

        # A sent business action is delayed; B signs in while it waits.
        a.evaluate("()=>{window.old=auth.current();window.sent=0;window.started=new Promise(r=>window.start=r);window.late=auth.execute(old.accessToken,async()=>{sent++;start();return new Promise(r=>window.reply=r)}).then(()=>false,e=>e.constructor.name)}")
        a.evaluate("()=>started")
        assert b.evaluate("()=>login('B')") == "B"
        a.evaluate("()=>reply(new Response(null,{status:401}))")
        assert a.evaluate("()=>late") == "WebLoginChanged"
        assert a.evaluate("()=>sent") == 1
        assert a.evaluate("()=>auth.signOut(old.loginGeneration)") is False
        assert c.evaluate("async()=>(await restore()).userId") == "B"
        print("PASS account switch fences old business bearer and stale logout")

        # Browser restart-like recovery: discard access cache but retain HttpOnly session.
        c.evaluate("()=>localStorage.clear()")
        recovered = ready(context)
        assert recovered.evaluate("async()=>(await restore()).userId") == "B"
        print("PASS Cookie-only recovery with empty access cache")

        before = stats(recovered)
        assert recovered.evaluate("async()=>{try{await work(auth.current().accessToken,'deny');return false}catch{return auth.current()===null}}")
        after = stats(recovered)
        assert after["rejected"] - before["rejected"] == 2
        print("PASS second 401 exits once with only two business attempts")

        # No Web Locks: existing Cookie may resume, identity-mutating login must stop.
        secure = browser.new_context()
        seed = ready(secure)
        assert seed.evaluate("()=>login('C')") == "C"
        secure.add_init_script("Object.defineProperty(navigator,'locks',{value:undefined,configurable:true})")
        nolock = ready(secure)
        assert nolock.evaluate("async()=>(await restore()).userId") == "C"
        assert nolock.evaluate("async()=>{try{await login('D');return false}catch{return auth.current().userId==='C'}}")
        assert nolock.evaluate("()=>auth.signOut(auth.current().loginGeneration)")
        assert stats(nolock)["logoutBodies"][-1]["clearCookie"] is False
        print("PASS no-lock Cookie resume, new login blocked, logout does not delete Cookie")
        secure.close()
        context.close()
        print("Browser auth checks: 9 passed")
    finally:
        browser.close()
        # with_server uses shell=True; on Windows killing the shell can leave Node alive.
        # Stop this localhost-only fake service explicitly even when a test fails.
        try:
            with urlopen(BASE + "/shutdown", timeout=3) as response:
                response.read()
        except OSError:
            pass
