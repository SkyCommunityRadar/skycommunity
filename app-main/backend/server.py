import asyncio
from contextlib import asynccontextmanager
from urllib.parse import urlparse
from fastapi import FastAPI, APIRouter, Request
from fastapi.responses import JSONResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
import os
import logging
from pathlib import Path


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# A short / missing JWT secret would let anyone forge a session: refuse to start rather than run unsafely.
if len(os.environ.get("JWT_SECRET", "")) < 32:
    raise RuntimeError("JWT_SECRET manquant ou trop court (32 caractères minimum) : le serveur refuse de démarrer.")

# MongoDB connection
from lib.db import client, ensure_indexes  # noqa: E402
from lib.engine import utcnow  # noqa: E402
from lib.ticker import run_forever  # noqa: E402
from lib.security import MAX_BODY_BYTES, check_rate  # noqa: E402
from routers import admin, airports, auth, flights, leaderboard, simbrief, strips, atc, cron, discord, community, planning, activity, bot, absences, reports, site  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.index_task = asyncio.create_task(ensure_indexes())  # background: a big index build must not block boot
    app.state.engine_task = asyncio.create_task(run_forever())
    yield
    app.state.engine_task.cancel()
    client.close()


logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

app = FastAPI(lifespan=lifespan, title="SkyCommunity Radar API", docs_url=None, redoc_url=None, openapi_url=None)

api_router = APIRouter(prefix="/api")


@api_router.get("/")
async def root():
    return {"message": "SkyCommunity Radar API", "server_time": utcnow().isoformat()}


@api_router.get("/health")
async def health():
    return {"ok": True, "server_time": utcnow().isoformat()}


for module in (auth, flights, simbrief, airports, admin, leaderboard, strips, atc, cron, discord, community, planning, activity, bot, absences, reports, site):
    api_router.include_router(module.router)

# The frontend calls /api on its own origin, so CORS is only needed for explicitly listed extra origins.
# A wildcard is never combined with credentials (it would let any website act as the logged-in user).
_origins = [o.strip() for o in os.environ.get('CORS_ORIGINS', '').split(',') if o.strip() and o.strip() != '*']
app.add_middleware(
    CORSMiddleware,
    allow_credentials=bool(_origins),
    allow_origins=_origins,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)


_LOCAL = ("localhost", "127.0.0.1", "[::1]", "testserver")


@app.middleware("http")
async def security_guard(request: Request, call_next):
    host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
    # 1. size: no legitimate request is bigger than a few kB (protects memory against oversized uploads)
    try:
        size = int(request.headers.get("content-length") or 0)
    except ValueError:
        size = MAX_BODY_BYTES + 1
    if size > MAX_BODY_BYTES:
        return JSONResponse({"detail": "Requête trop volumineuse."}, status_code=413)
    if "chunked" in request.headers.get("transfer-encoding", "").lower():  # no announced size: the limit could not apply
        return JSONResponse({"detail": "Taille de la requête requise."}, status_code=411)
    # 2. flood / spam / brute force: per-IP request limits (lib/security.RULES)
    limited = check_rate(request)
    if limited:
        rule, wait = limited
        logger.warning("Limite de requêtes atteinte (%s) pour %s sur %s", rule, request.client.host if request.client else "?", request.url.path)
        return JSONResponse({"detail": f"Trop de requêtes : réessayez dans {wait} s."}, status_code=429,
                            headers={"Retry-After": str(wait)})
    # 3. CSRF defence: a state-changing request carrying a foreign Origin is refused (localhost origins are only
    #    accepted when the server itself is reached on localhost, i.e. in local development).
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin:
            netloc = urlparse(origin).netloc
            local_dev = netloc.rsplit(":", 1)[0] in _LOCAL and host.rsplit(":", 1)[0] in _LOCAL
            if netloc != host and origin not in _origins and not local_dev:
                return JSONResponse({"detail": "Origine de la requête refusée."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=(), payment=()"
    response.headers["X-Frame-Options"] = "DENY"  # no clickjacking: the site cannot be shown inside another site
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    if proto == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# Include the router in the main app (keep last)
app.include_router(api_router)
