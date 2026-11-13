import asyncio
import unittest
import aiohttp
from aiohttp import web
from backend.python.balancer import BALANCER_KEY, LeastConnections, create_app

class BalancerTests(unittest.IsolatedAsyncioTestCase):
    async def test_least_connections_reserves_atomically_and_releases(self):
        balancer=LeastConnections(['http://127.0.0.1:1','http://127.0.0.1:2'])
        first=await balancer.acquire()
        second=await balancer.acquire()
        self.assertEqual((first[0],second[0]),(0,1))
        await balancer.release(second[0])
        third=await balancer.acquire()
        self.assertEqual(third[0],1)
        await balancer.release(first[0],failed=True)
        await balancer.release(third[0])
        selection=await balancer.acquire()
        self.assertEqual(selection[0],1)
        await balancer.release(selection[0])
        self.assertEqual([item.active for item in balancer.upstreams],[0,0])

    async def test_streaming_requests_keep_connections_busy_and_forward_body_auth(self):
        runners=[]
        release=asyncio.Event()
        started=asyncio.Event()
        async def run(app):
            runner=web.AppRunner(app,access_log=None,handler_cancellation=True)
            await runner.setup()
            site=web.TCPSite(runner,'127.0.0.1',0)
            await site.start()
            runners.append(runner)
            return f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        def upstream(name):
            app=web.Application()
            async def stream(request):
                response=web.StreamResponse(headers={'Content-Type':'text/event-stream','X-Served-By':name})
                await response.prepare(request)
                await response.write(b'data: started\n\n')
                started.set()
                await release.wait()
                await response.write(b'data: done\n\n')
                return response
            async def echo(request):
                return web.json_response({'api':name,'body':await request.text(),'auth':request.headers.get('Authorization'),'query':request.query.get('value')},headers={'X-Served-By':name})
            app.router.add_get('/events',stream)
            app.router.add_route('*','/echo',echo)
            return app
        try:
            first=await run(upstream('API_1'))
            second=await run(upstream('API_2'))
            proxy_app=create_app([first,second])
            proxy_url=await run(proxy_app)
            async with aiohttp.ClientSession() as client:
                stream=await client.get(proxy_url+'/events')
                await started.wait()
                self.assertIn(b'started',await stream.content.readline())
                for _ in range(3):
                    async with client.post(proxy_url+'/echo?value=test',data='payload',headers={'Authorization':'Bearer test'}) as response:
                        body=await response.json()
                        self.assertEqual(body,{'api':'API_2','body':'payload','auth':'Bearer test','query':'test'})
                        self.assertEqual(response.headers['X-Balancer'],'Python-least_conn')
                self.assertEqual(proxy_app[BALANCER_KEY].upstreams[0].active,1)
                self.assertEqual(proxy_app[BALANCER_KEY].upstreams[1].active,0)
                release.set()
                self.assertIn(b'done',await stream.read())
                await asyncio.sleep(.05)
                self.assertEqual([item.active for item in proxy_app[BALANCER_KEY].upstreams],[0,0])
        finally:
            release.set()
            for runner in reversed(runners):
                await runner.cleanup()

    async def test_unreachable_upstream_fails_over_without_hanging(self):
        runner=web.AppRunner(web.Application(),access_log=None)
        await runner.setup()
        site=web.TCPSite(runner,'127.0.0.1',0)
        await site.start()
        alive=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}'
        app=create_app(['http://127.0.0.1:1',alive])
        proxy_runner=web.AppRunner(app,access_log=None)
        await proxy_runner.setup()
        proxy_site=web.TCPSite(proxy_runner,'127.0.0.1',0)
        await proxy_site.start()
        try:
            async with aiohttp.ClientSession() as client:
                async with client.get(f'http://127.0.0.1:{proxy_site._server.sockets[0].getsockname()[1]}/missing') as response:
                    self.assertEqual(response.status,404)
                    self.assertEqual(response.headers['X-Handled-By'],alive.removeprefix('http://'))
            self.assertEqual([item.active for item in app[BALANCER_KEY].upstreams],[0,0])
        finally:
            await proxy_runner.cleanup()
            await runner.cleanup()

if __name__=='__main__':
    unittest.main()
