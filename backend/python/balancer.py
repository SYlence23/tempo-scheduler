import asyncio
import logging
import os
import signal
import ssl
import time
from dataclasses import dataclass
from urllib.parse import urlsplit
import aiohttp
import psutil
from aiohttp import web
from multidict import CIMultiDict
from .config import RUNTIME, STOP_FILE
from .database import connect

HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'}
LOGGER = logging.getLogger('tempo.balancer')

@dataclass
class Upstream:
    url: str
    active: int = 0
    unavailable_until: float = 0
    handled: int = 0

class LeastConnections:
    def __init__(self, urls):
        if not urls:
            raise ValueError('At least one upstream is required')
        self.upstreams = []
        for url in urls:
            parsed = urlsplit(url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
                raise ValueError('Upstream must be an HTTP origin')
            self.upstreams.append(Upstream(url.rstrip('/')))
        self.lock = asyncio.Lock()
        self.cursor = 0
    async def acquire(self, excluded=None):
        async with self.lock:
            available = [index for index, upstream in enumerate(self.upstreams) if index not in (excluded or set()) and upstream.unavailable_until <= time.monotonic()]
            if not available:
                return None
            least = min(self.upstreams[index].active for index in available)
            chosen = next(index for offset in range(len(self.upstreams)) if (index := (self.cursor+offset) % len(self.upstreams)) in available and self.upstreams[index].active == least)
            self.cursor = (chosen+1) % len(self.upstreams)
            self.upstreams[chosen].active += 1
            self.upstreams[chosen].handled += 1
            return chosen, self.upstreams[chosen]
    async def release(self, index, failed=False):
        async with self.lock:
            upstream = self.upstreams[index]
            upstream.active = max(0, upstream.active-1)
            if failed:
                upstream.unavailable_until = time.monotonic()+2
    def snapshot(self):
        return {'implementation': 'Python + aiohttp', 'algorithm': 'least_conn', 'upstreams': [{'url': upstream.url, 'activeConnections': upstream.active, 'handledRequests': upstream.handled, 'available': upstream.unavailable_until <= time.monotonic()} for upstream in self.upstreams]}

BALANCER_KEY = web.AppKey('balancer', LeastConnections)
SESSION_KEY = web.AppKey('session', aiohttp.ClientSession)

def forwarded_headers(headers):
    excluded = HOP_HEADERS | {item.strip().lower() for item in headers.get('Connection', '').split(',')}
    return CIMultiDict((key, value) for key, value in headers.items() if key.lower() not in excluded)

async def session_context(app):
    timeout = aiohttp.ClientTimeout(total=None, connect=5, sock_connect=3, sock_read=180)
    connector = aiohttp.TCPConnector(limit=200, limit_per_host=100)
    async with aiohttp.ClientSession(timeout=timeout, connector=connector, auto_decompress=False, cookie_jar=aiohttp.DummyCookieJar()) as session:
        app[SESSION_KEY] = session
        yield

async def proxy(request):
    started = time.monotonic()
    balancer = request.app[BALANCER_KEY]
    body = await request.read()
    headers = forwarded_headers(request.headers)
    headers.popall('Content-Length', None)
    headers['X-Forwarded-For'] = request.remote or ''
    headers['X-Real-IP'] = request.remote or ''
    headers['X-Forwarded-Proto'] = request.scheme
    tried = set()
    for _ in balancer.upstreams:
        selection = await balancer.acquire(tried)
        if selection is None:
            break
        index, upstream = selection
        tried.add(index)
        downstream = None
        failed = False
        try:
            url = upstream.url + request.raw_path
            async with request.app[SESSION_KEY].request(request.method, url, data=body or None, headers=headers, allow_redirects=False) as response:
                response_headers = forwarded_headers(response.headers)
                response_headers['X-Handled-By'] = urlsplit(upstream.url).netloc
                response_headers['X-Balancer'] = 'Python-least_conn'
                downstream = web.StreamResponse(status=response.status, reason=response.reason, headers=response_headers)
                await downstream.prepare(request)
                async for chunk in response.content.iter_any():
                    await downstream.write(chunk)
                await downstream.write_eof()
                LOGGER.info('%s %s -> %s %s %.0fms', request.method, request.path, upstream.url, response.status, (time.monotonic()-started)*1000)
                return downstream
        except aiohttp.ClientConnectorError:
            failed = True
            continue
        except (aiohttp.ClientError, asyncio.TimeoutError, ConnectionError):
            failed = True
            if downstream is not None and downstream.prepared:
                downstream.force_close()
                return downstream
            return web.json_response({'error': 'API тимчасово недоступний.'}, status=502, headers={'X-Balancer': 'Python-least_conn'})
        finally:
            await asyncio.shield(balancer.release(index, failed))
    return web.json_response({'error': 'Немає доступних API-серверів.'}, status=503, headers={'X-Balancer': 'Python-least_conn'})

def create_app(urls):
    app = web.Application(client_max_size=1024*1024)
    app[BALANCER_KEY] = LeastConnections(urls)
    app.cleanup_ctx.append(session_context)
    async def status(_):
        return web.json_response(app[BALANCER_KEY].snapshot())
    app.router.add_get('/balancer/status', status)
    app.router.add_route('*', '/{path:.*}', proxy)
    return app

async def main():
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    urls = [url.strip() for url in os.environ.get('UPSTREAM_URLS', 'http://127.0.0.1:3101,http://127.0.0.1:3102').split(',') if url.strip()]
    app = create_app(urls)
    runner = web.AppRunner(app, access_log=None, handler_cancellation=True)
    await runner.setup()
    host = os.environ.get('BALANCER_HOST', '127.0.0.1')
    port = int(os.environ.get('BALANCER_PORT', '8088'))
    await web.TCPSite(runner, host, port).start()
    certificate = RUNTIME / 'localhost.crt'
    key = RUNTIME / 'localhost.key'
    https_port = int(os.environ.get('BALANCER_HTTPS_PORT', '8443'))
    if https_port and certificate.exists() and key.exists():
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(certificate, key)
        await web.TCPSite(runner, host, https_port, ssl_context=context).start()
    print(f'Python balancer: http://{host}:{port}, least_conn, {len(urls)} API', flush=True)
    stopped = asyncio.Event()
    for event in (signal.SIGINT, signal.SIGTERM):
        signal.signal(event, lambda *_: stopped.set())
    metrics = psutil.Process()
    metrics.cpu_percent()
    connection = None
    def heartbeat():
        nonlocal connection
        try:
            if connection is None or connection.closed:
                connection = connect()
            connection.execute("""
                INSERT INTO nodes(id,kind,last_seen,cpu_percent,memory_mb)
                VALUES('BALANCER','balancer',now(),%s,%s)
                ON CONFLICT(id) DO UPDATE SET last_seen=now(),cpu_percent=EXCLUDED.cpu_percent,memory_mb=EXCLUDED.memory_mb
            """, (metrics.cpu_percent(), round(metrics.memory_info().rss/1048576)))
        except Exception:
            if connection:
                connection.close()
            connection = None
    try:
        while not stopped.is_set() and not STOP_FILE.exists():
            await asyncio.to_thread(heartbeat)
            try:
                await asyncio.wait_for(stopped.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
    finally:
        await runner.cleanup()
        if connection and not connection.closed:
            connection.execute("DELETE FROM nodes WHERE id='BALANCER'")
            connection.close()

if __name__ == '__main__':
    asyncio.run(main())
