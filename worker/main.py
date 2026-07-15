import os
import time
import uuid
import hashlib
import math
from typing import Optional, Dict, Any, Tuple, List, Set
import shutil
import httpx
from lifecycle import LifecycleTransitionError, request_order_job, transition_quote_ready, transition_status
from tenacity import retry, wait_fixed, stop_after_attempt
import subprocess
import shlex
from urllib.parse import quote
from dotenv import load_dotenv
from pathlib import Path
from io import BytesIO
import numpy as np
import json
from string import Template
import struct
import sys
import types
import tempfile

# Some environments omit the optional charset_normalizer dependency that
# requests/trimesh use. Provide a tiny stub so trimesh imports cleanly and we
# can still convert meshes to STL.
if 'charset_normalizer' not in sys.modules:
    try:  # pragma: no cover - best effort
        import charset_normalizer  # type: ignore
    except Exception:  # pragma: no cover - only hit in lean environments
        dummy = types.ModuleType('charset_normalizer')

        class _CNResult:
            def best(self):
                return None

            def first(self):
                return None

        def _cn_from_bytes(_data, *_args, **_kwargs):
            return _CNResult()

        dummy.from_bytes = _cn_from_bytes  # type: ignore[attr-defined]
        sys.modules['charset_normalizer'] = dummy

print("Starting worker module import...", flush=True)

# Load environment variables from worker/.env regardless of CWD, then overlay CWD .env
try:
    worker_env = Path(__file__).with_name('.env')
    if worker_env.exists():
        load_dotenv(worker_env)  # primary source
        print(f"Loaded env from {worker_env}", flush=True)
    else:
        print("worker/.env not found; relying on process env and CWD .env", flush=True)
except Exception as _:
    pass
# Also load any .env in current working directory (non-fatal)
try:
    load_dotenv()
except Exception:
    pass

SUPABASE_URL = os.getenv("SUPABASE_URL")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
STORAGE_BUCKET = os.getenv("SUPABASE_STORAGE_BUCKET", "artifacts")
BAMBU_CLI_ENV = os.getenv("BAMBU_STUDIO_CLI")
BAMBU_PROFILE = os.getenv("BAMBUSTUDIO_PROFILE_PATH")
BAMBU_SETTINGS = os.getenv("BAMBUSTUDIO_SETTINGS_PATH")  # semicolon- or comma-separated JSONs (machine;process)
BAMBU_FILAMENTS = os.getenv("BAMBUSTUDIO_FILAMENTS_PATH")  # single JSON
# Optional: flattened snapshot exported from a golden 3MF via --export-settings
BAMBU_UPTODATE_SETTINGS = (
    os.getenv("BAMBUSTUDIO_UPTODATE_SETTINGS_PATH")
    or os.getenv("BAMBU_UPTODATE_SETTINGS_PATH")
)
MESHY_API_KEY = os.getenv("MESHY_API_KEY")
FAL_KEY = os.getenv("FAL_KEY") or os.getenv("FAL_API_KEY")
TRIPO_API_KEY = os.getenv("TRIPO_API_KEY")
TRIPO_API_BASE = (os.getenv("TRIPO_API_BASE") or "https://api.tripo3d.ai").strip().rstrip("/")
TRIPO_DRAFT_MODEL_VERSION = os.getenv("TRIPO_DRAFT_MODEL_VERSION") or os.getenv("TRIPO_MODEL_VERSION_DRAFT")
TRIPO_DRAFT_TIMEOUT_S = os.getenv("TRIPO_DRAFT_TIMEOUT_S")
DEFAULT_TRIPO_DRAFT_MODEL_VERSION = "v2.5-20250123"

WORKER_ID = os.getenv("WORKER_ID") or str(uuid.uuid4())

_CLAIM_BACKOFF = {
    "failures": 0,
    "sleep_until": 0.0,
}
_CLAIM_BACKOFF_MAX_S = max(1.0, float(os.getenv("WORKER_CLAIM_BACKOFF_MAX_S", "45")))
_CLAIM_BACKOFF_BASE_S = max(0.5, float(os.getenv("WORKER_CLAIM_BACKOFF_BASE_S", "1")))


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    norm = raw.strip().lower()
    if norm in ("1", "true", "yes", "on"):  # truthy signals
        return True
    if norm in ("0", "false", "no", "off", ""):  # explicit falsy
        return False
    return default


def _env_bool_optional(name: str) -> Optional[bool]:
    raw = os.getenv(name)
    if raw is None:
        return None
    norm = raw.strip().lower()
    if norm in ("1", "true", "yes", "on"):
        return True
    if norm in ("0", "false", "no", "off", ""):
        return False
    return None


def _resolve_tool_path(preferred: Optional[str], fallback: Optional[str] = None) -> Optional[str]:
    candidates = [preferred, fallback]
    for cand in candidates:
        if not cand:
            continue
        if os.path.isabs(cand) and os.path.exists(cand):
            return cand
        resolved = shutil.which(cand)
        if resolved:
            return resolved
    return None


def _report_tool_readiness() -> None:
    checks = [
        ("meshfix", _resolve_tool_path(os.getenv("MESHFIX_PATH"), "meshfix")),
        ("admesh", _resolve_tool_path(os.getenv("ADMESH_PATH"), "admesh")),
        ("blender", _resolve_tool_path(os.getenv("BLENDER_CLI"), "blender")),
        ("bambu_cli", _resolve_tool_path(BAMBU_CLI, os.getenv("BAMBU_STUDIO_CLI"))),
    ]
    missing = []
    for name, path in checks:
        if path:
            log(f"[readiness] {name} → {path}")
        else:
            missing.append(name)
            log(f"[readiness] WARNING: {name} not found. Configure the path before fabrication workloads.")
    if missing:
        log(f"[readiness] Missing required tooling: {', '.join(missing)}")


assert SUPABASE_URL and SERVICE_KEY, "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"

REST_URL = f"{SUPABASE_URL}/rest/v1"
STORAGE_URL = f"{SUPABASE_URL}/storage/v1"

VIEW_ROLE_PRIORITY: List[str] = ["front", "back", "left", "right", "top", "bottom"]
MESHY_ALLOWED_MODELS: Tuple[str, ...] = ("meshy-4", "meshy-5", "latest")
SIGNED_URL_TTL_S = max(60, int(os.getenv("SIGNED_URL_TTL_S") or "900"))
SIGNED_URL_TTL_MS = SIGNED_URL_TTL_S * 1000

MAX_GENERATE_ATTEMPTS = max(1, int(os.getenv('WORKER_GENERATE_ATTEMPTS', '3')))
MAX_REPAIR_ATTEMPTS = max(1, int(os.getenv('WORKER_REPAIR_ATTEMPTS', '2')))
MAX_SLICE_ATTEMPTS = max(1, int(os.getenv('WORKER_SLICE_ATTEMPTS', '2')))
STAGE_RETRY_DELAY_S = max(1.0, float(os.getenv('WORKER_STAGE_RETRY_DELAY_S', '6')))
CLAIM_ALERT_THRESHOLD = max(3, int(os.getenv('WORKER_CLAIM_ALERT_THRESHOLD', '5')))
VERIFY_UPLOADS = _env_bool('WORKER_VERIFY_ASSET_UPLOADS', True)
DEFAULT_EXPORT_TARGET_TOLERANCE_MM = float(os.getenv('EXPORT_TARGET_TOLERANCE_MM', '0.5') or 0.5)


def _normalize_view_role(role: Optional[str]) -> Optional[str]:
    if not role:
        return None
    norm = str(role).strip().lower()
    if not norm:
        return None
    if norm in ("opposite", "rear"):
        return "back"
    if norm == "side":
        return "right"
    return norm if norm in VIEW_ROLE_PRIORITY else None


def _order_image_inputs(inputs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not inputs:
        return []
    normalized: List[Dict[str, Any]] = []
    seen_urls: Set[str] = set()
    for item in inputs:
        url = item.get("url") or item.get("assetUrl") or item.get("asset_url")
        if not isinstance(url, str) or not url:
            continue
        if url in seen_urls:
            continue
        seen_urls.add(url)
        view_role = item.get("view_role") or item.get("viewRole") or item.get("angle")
        normalized.append({
            "url": url,
            "view_role": _normalize_view_role(view_role),
            "image_id": item.get("image_id") or item.get("imageId"),
        })
    if len(normalized) <= 1:
        return normalized
    prioritized: List[Dict[str, Any]] = []
    used: Set[str] = set()
    for role in VIEW_ROLE_PRIORITY:
        for entry in normalized:
            if entry["url"] in used:
                continue
            if entry.get("view_role") == role:
                prioritized.append(entry)
                used.add(entry["url"])
                break
    for entry in normalized:
        if entry["url"] not in used:
            prioritized.append(entry)
            used.add(entry["url"])
    return prioritized

def headers() -> Dict[str, str]:
    return {
        "apikey": SERVICE_KEY,
        "Authorization": f"Bearer {SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

_LOG_JSON_ENABLED = _env_bool('WORKER_LOG_JSON', True)
_LOG_SINK_URL = os.getenv('WORKER_LOG_SINK_URL')


def _emit_log(payload: Dict[str, Any]) -> None:
    try:
        print(json.dumps(payload, default=str), flush=True)
    except Exception:
        try:
            print(str(payload), flush=True)
        except Exception:
            pass
    if _LOG_SINK_URL:
        try:
            with httpx.Client(timeout=5.0) as client:
                client.post(_LOG_SINK_URL, json=payload)
        except Exception:
            # Sink failures should never break the worker loop
            pass


def log(msg: str, *, level: str = 'info', order_id: Optional[str] = None, **fields: Any) -> None:
    if not isinstance(msg, str):
        msg = str(msg)
    if _LOG_JSON_ENABLED:
        payload: Dict[str, Any] = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%S.%fZ', time.gmtime()),
            'level': level,
            'message': msg,
        }
        if order_id:
            payload['order_id'] = order_id
        if fields:
            payload.update({k: v for k, v in fields.items() if v is not None})
        _emit_log(payload)
    else:
        prefix = f"[{level.upper()}]"
        if order_id:
            prefix += f" order={order_id}"
        if fields:
            extras = ' '.join(f"{k}={fields[k]}" for k in sorted(fields))
            prefix += f" {extras}"
        print(f"{prefix} {msg}", flush=True)


def dlog(msg: str, *, order_id: Optional[str] = None, **fields: Any) -> None:
    try:
        if (os.getenv('DEBUG_TRELLIS') or '0').lower() in ('1', 'true', 'yes', 'on'):
            log(msg, level='debug', order_id=order_id, **fields)
    except Exception as exc:
        _claim_backoff_register_failure(exc)


def now_iso() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _normalize_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(num) or math.isinf(num):
        return None
    return num


def _detect_bambu_cli(configured: Optional[str]) -> Tuple[str, str]:
    def _add(candidate: Optional[str], label: str, bucket: List[Tuple[str, str]]) -> None:
        if not candidate:
            return
        cand = candidate.strip()
        if not cand:
            return
        if any(existing == cand for existing, _ in bucket):
            return
        bucket.append((cand, label))

    candidates: List[Tuple[str, str]] = []
    _add(os.getenv("BAMBU_STUDIO_CLI_HEADLESS"), "env:BAMBU_STUDIO_CLI_HEADLESS", candidates)
    _add(os.getenv("BAMBU_STUDIO_CLI_LINUX"), "env:BAMBU_STUDIO_CLI_LINUX", candidates)
    _add(os.getenv("BAMBU_HEADLESS_CLI_PATH"), "env:BAMBU_HEADLESS_CLI_PATH", candidates)

    windows_configured: Optional[str] = None
    if configured and configured.strip():
        conf_norm = configured.strip()
        if conf_norm.lower().endswith('.exe'):
            windows_configured = conf_norm
        else:
            _add(conf_norm, "env:BAMBU_STUDIO_CLI", candidates)

    auto_cli_names = [
        "/usr/local/bin/bambu-studio-cli",
        "/usr/bin/bambu-studio-cli",
        "/opt/bambu-studio/bambu-studio-cli",
        "bambu-studio-cli",
        "BambuStudio-cli",
        "BambuStudio-CLI",
        "BambuStudio",
    ]
    for auto_name in auto_cli_names:
        _add(auto_name, f"auto:{auto_name}", candidates)

    if windows_configured:
        _add(windows_configured, "env:BAMBU_STUDIO_CLI", candidates)

    if not candidates:
        candidates.append(("BambuStudio", "fallback"))

    for cand, label in candidates:
        resolved = _resolve_tool_path(cand, None)
        if resolved:
            return resolved, label

    last_value, last_label = candidates[-1]
    return last_value, last_label

BAMBU_CLI, BAMBU_CLI_SOURCE = _detect_bambu_cli(BAMBU_CLI_ENV)
log(f"[config] Bambu CLI resolved to {BAMBU_CLI} ({BAMBU_CLI_SOURCE})")

def _sanitize_meshy_model(value: Optional[str], fallback: str) -> str:
    if value:
        candidate = value.strip()
        if candidate in MESHY_ALLOWED_MODELS:
            return candidate
        log(f"[Meshy] invalid ai_model '{value}' provided; using '{fallback}' instead")
    return fallback

@retry(wait=wait_fixed(2), stop=stop_after_attempt(3))
def supabase_get(path: str, params: Dict[str, Any]) -> Any:
    p = dict(params or {})
    if 'select' not in p:
        p['select'] = '*'
    with httpx.Client(timeout=30) as c:
        r = c.get(f"{REST_URL}/{path}", params=p, headers=headers())
        r.raise_for_status()
        return r.json()

@retry(wait=wait_fixed(2), stop=stop_after_attempt(3))
def supabase_patch(path: str, params: Dict[str, Any], json: Dict[str, Any]) -> Any:
    with httpx.Client(timeout=30) as c:
        r = c.patch(f"{REST_URL}/{path}", params=params, headers=headers(), json=json)
        r.raise_for_status()
        return r.json()

@retry(wait=wait_fixed(2), stop=stop_after_attempt(3))
def supabase_insert(path: str, json: Dict[str, Any]) -> Any:
    with httpx.Client(timeout=30) as c:
        r = c.post(f"{REST_URL}/{path}", headers=headers(), json=json)
        r.raise_for_status()
        return r.json()

@retry(wait=wait_fixed(2), stop=stop_after_attempt(3))
def supabase_rpc(func: str, json: Dict[str, Any]) -> Any:
    with httpx.Client(timeout=30) as c:
        r = c.post(f"{REST_URL}/rpc/{func}", headers=headers(), json=json)
        r.raise_for_status()
        if not r.content:
            return None
        # Many PostgREST RPC endpoints (especially VOID functions) return `null` or an
        # empty payload even on success. httpx.json() raises on empty bodies, so we
        # guard here and treat empty/`null` as a successful no-op response.
        raw = r.content.strip()
        if not raw or raw == b"null":
            return None
        try:
            return r.json()
        except ValueError:
            # Fall back to text for non-JSON payloads (should be rare).
            return r.text


def record_domain_event(
    *,
    org_id: Optional[str],
    event_type: str,
    order_id: Optional[str] = None,
    product_id: Optional[str] = None,
    job_id: Optional[str] = None,
    payload: Optional[Dict[str, Any]] = None,
):
    if not org_id:
        return
    body = {
        "org_id": org_id,
        "event_type": event_type,
        "order_id": order_id,
        "product_id": product_id,
        "job_id": job_id,
        "payload": payload or {},
    }
    try:
        supabase_insert("domain_events", body)
    except Exception as exc:
        log(f"[event] failed to record {event_type}: {exc}")

def _storage_ensure_bucket(bucket: str):
    try:
        with httpx.Client(timeout=30) as c:
            # Probe by name (Supabase treats bucket name as id)
            g = c.get(
                f"{STORAGE_URL}/bucket/{bucket}",
                headers={"Authorization": f"Bearer {SERVICE_KEY}", "apikey": SERVICE_KEY},
            )
            if g.status_code == 200:
                return True
            # Create if missing
            cr = c.post(
                f"{STORAGE_URL}/bucket",
                headers={
                    "Authorization": f"Bearer {SERVICE_KEY}",
                    "apikey": SERVICE_KEY,
                    "Content-Type": "application/json",
                },
                json={"name": bucket, "public": False},
            )
            if cr.status_code in (200, 201):
                return True
            # 409 conflict means it exists (race)
            if cr.status_code == 409:
                return True
            try:
                log(f"Bucket ensure error: {cr.status_code} {cr.text[:200]}")
            except Exception:
                pass
    except Exception as e:
        log(f"Bucket ensure exception: {e}")
    return False


def storage_upload_bytes(bucket: str, path: str, content: bytes, content_type: str = "application/octet-stream") -> str:
    # Normalize path: remove any accidental leading slashes and duplicated bucket segment
    norm = (path or "").lstrip("/")
    if norm.startswith(f"{bucket}/"):
        norm = norm[len(bucket) + 1 :]
    # Allow idempotent uploads: request upsert semantics via header and query param
    url = f"{STORAGE_URL}/object/{bucket}/{norm}?upsert=true"
    headers_up = {
        "Authorization": f"Bearer {SERVICE_KEY}",
        "apikey": SERVICE_KEY,
        "Content-Type": content_type,
        "x-upsert": "true",
    }
    with httpx.Client(timeout=60) as c:
        r = c.post(url, headers=headers_up, content=content)
        # Treat Duplicate as success (object already exists)
        if r.status_code in (409,):
            return f"supabase://{bucket}/{norm}"
        # Some deployments return 400 with a JSON body statusCode=409; treat as success
        try:
            if r.status_code == 400:
                jd = r.json()
                if str(jd.get("statusCode")) == "409" or (str(jd.get("error") or "").lower() == "duplicate"):
                    return f"supabase://{bucket}/{norm}"
        except Exception:
            pass
        if r.status_code in (400, 404):
            # Try to ensure bucket exists, then retry once
            try:
                txt = r.text
                log(f"Storage upload {r.status_code}: {txt[:180]}")
            except Exception:
                pass
            _storage_ensure_bucket(bucket)
            r = c.post(url, headers=headers_up, content=content)
            # After retry, also accept duplicate as success
            if r.status_code in (409,):
                return f"supabase://{bucket}/{norm}"
            try:
                if r.status_code == 400:
                    jd = r.json()
                    if str(jd.get("statusCode")) == "409" or (str(jd.get("error") or "").lower() == "duplicate"):
                        return f"supabase://{bucket}/{norm}"
            except Exception:
                pass
        r.raise_for_status()
        return f"supabase://{bucket}/{norm}"

def sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256(); h.update(b); return h.hexdigest()

def parse_supabase_url(u: str) -> Optional[Tuple[str, str]]:
    if not u:
        return None
    prefix = "supabase://"
    if u.startswith(prefix):
        rest = u[len(prefix):]
        if "/" in rest:
            bucket, path = rest.split("/", 1)
            return bucket, path
    return None

def storage_download_bytes(bucket: str, path: str) -> bytes:
    norm_path = (path or "").lstrip('/')
    with httpx.Client(timeout=60) as c:
        url_private = f"{STORAGE_URL}/object/{bucket}/{norm_path}"
        hdrs = {"Authorization": f"Bearer {SERVICE_KEY}", "apikey": SERVICE_KEY}
        r = c.get(url_private, headers=hdrs)
        if r.status_code == 404:
            url_public = f"{STORAGE_URL}/object/public/{bucket}/{norm_path}"
            r = c.get(url_public, headers=hdrs)
        r.raise_for_status()
        return r.content

def storage_create_signed_url(bucket: str, path: str, expires_in: int = SIGNED_URL_TTL_S) -> Optional[str]:
    try:
        with httpx.Client(timeout=30) as c:
            r = c.post(
                f"{STORAGE_URL}/object/sign/{bucket}/{path}",
                headers={
                    "Authorization": f"Bearer {SERVICE_KEY}",
                    "apikey": SERVICE_KEY,
                    "Content-Type": "application/json",
                },
                json={"expiresIn": expires_in},
            )
            r.raise_for_status()
            data = r.json()
            # Supabase returns { signedURL: "/object/sign/..." } or { signedUrl: "..." }
            signed = data.get("signedURL") or data.get("signedUrl") or data.get("signed_url")
            if not signed:
                return None
            # Prepend base URL if relative
            if isinstance(signed, str):
                if signed.startswith("http"):
                    return signed
                # Normalize into a full URL with the correct base
                s = signed.strip()
                if s.startswith("/storage/v1"):
                    return f"{SUPABASE_URL}{s}"
                if s.startswith("/object/sign"):
                    return f"{STORAGE_URL}{s}"
                if s.startswith("object/sign"):
                    return f"{STORAGE_URL}/{s}"
                # Fallback: assume it is a path under /object/sign
                return f"{STORAGE_URL}/object/sign/{s.lstrip('/')}"
            return None
    except Exception as e:
        log(f"Signed URL error: {e}")
        return None

def download_bytes(
    url: str,
    expected_sha: Optional[str] = None,
    order_id: Optional[str] = None,
    context: Optional[str] = None,
) -> bytes:
    parsed = parse_supabase_url(url)
    if parsed:
        data = storage_download_bytes(*parsed)
    else:
        with httpx.Client(timeout=60) as c:
            r = c.get(url)
            r.raise_for_status()
            data = r.content
    if expected_sha:
        actual = sha256_bytes(data)
        if actual != expected_sha:
            log(
                "Checksum mismatch on download",
                level='error',
                order_id=order_id,
                expected_sha=expected_sha,
                actual_sha=actual,
                context=context,
                url=url,
            )
            raise ValueError(f"checksum mismatch: expected {expected_sha}, got {actual}")
    return data


def sign_or_direct(asset_url: Optional[str], expires_in: int = 3600) -> Optional[str]:
    if not asset_url:
        return None
    if isinstance(asset_url, str):
        parsed = parse_supabase_url(asset_url)
        if parsed:
            return storage_create_signed_url(parsed[0], parsed[1], expires_in=expires_in)
    return asset_url


def build_bambu_connect_link(signed_url: str) -> str:
    return f"bambu-connect://import-file?file={quote(signed_url, safe='')}"

def _fal_trellis_multi(image_urls: List[str], timeout_s: int = 1800) -> Optional[Tuple[str, bytes]]:
    """Call FAL trellis/multi with 1..N image URLs. Returns (ext, bytes) or None.

    Robust to 202-accepted async responses: polls the provided response/status URL or
    /requests/{id} endpoint until a mesh URL appears (STL preferred, then OBJ/GLB).
    """
    if not image_urls:
        return None
    if not FAL_KEY:
        log("[trellis] FAL_KEY not set")
        return None
    base = (os.getenv("FAL_BASE_URL") or "https://fal.run").strip().rstrip("/")
    raw_model = (os.getenv("FAL_TRELLIS_MODEL") or "fal-ai/trellis/multi").strip()
    # Normalize common mistakes: extra notes, parentheses, leading slashes, or just "multi"
    # Take only the first whitespace-separated token and strip parentheses/quotes
    token = raw_model.split()[0].strip().strip('"\'()')
    lm = token.lower()
    if lm in ("multi", "/multi", "trellis/multi", "/trellis/multi"):
        token = "fal-ai/trellis/multi"
    # Ensure no leading slash
    model = token.lstrip("/")
    url = f"{base}/{model}"
    log(f"[trellis] endpoint: {url}")
    payload: Dict[str, Any] = {
        "image_urls": image_urls,
        # Be lenient with input field name expectations
        "urls": image_urls,
        "images": image_urls,
    }
    try:
        dlog(f"[trellis] POST {url} with {len(image_urls)} image(s)")
        with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
            r = c.post(url, headers={"Authorization": f"Key {FAL_KEY}", "Content-Type": "application/json"}, json=payload)
        if r.status_code not in (200, 201, 202):
            raise RuntimeError(f"trellis error {r.status_code}: {r.text[:200]}")
        jd = r.json()
        try:
            dlog(f"[trellis] initial response {r.status_code}: {str(jd)[:300]}")
        except Exception:
            pass
        # If this is an async response, extract a response/poll URL and wait
        # Common keys: request_id, id, response_url, status_url
        poll_url = None
        for k in ("response_url", "status_url"):
            v = jd.get(k)
            if isinstance(v, str) and v.startswith("http"):
                poll_url = v; break
        if not poll_url:
            rid = jd.get("request_id") or jd.get("id")
            if isinstance(rid, str):
                # Try model-scoped /requests/{id} first, then /requests/{id}/response
                poll_url = f"{url.rstrip('/')}/requests/{rid}"
                dlog(f"[trellis] constructed poll_url: {poll_url}")
        if poll_url:
            start = time.time()
            attempts = 0
            while time.time() - start < timeout_s:
                with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
                    pr = c.get(poll_url, headers={"Authorization": f"Key {FAL_KEY}"})
                if pr.status_code not in (200, 201):
                    attempts += 1
                    if attempts == 1:
                        dlog(f"[trellis] poll {poll_url} -> {pr.status_code}")
                    time.sleep(2); continue
                jd = pr.json()
                attempts += 1
                if attempts % 4 == 1:  # log every ~12s
                    try:
                        dlog(f"[trellis] poll ok: {str(jd.get('status') or jd.get('state') or jd)[:120]}")
                    except Exception:
                        pass
                # Try to extract mesh URL; if found, break
                pick = None
                candidates: List[str] = []
                def add_url(s: Any):
                    try:
                        if isinstance(s, str) and s.startswith("http"):
                            candidates.append(s)
                    except Exception:
                        pass
                # Nested response payload may be under 'response' or similar
                scan_roots = [jd] + ([jd.get("response")] if isinstance(jd.get("response"), (dict, list)) else [])
                for root in scan_roots:
                    if isinstance(root, dict):
                        for key in ("mesh_url", "stl", "obj", "glb", "model_url"):
                            add_url(root.get(key))
                        # Trellis variant: model_mesh dict
                        mm = root.get("model_mesh")
                        if isinstance(mm, dict):
                            add_url(mm.get("url"))
                        for key in ("assets", "output", "result", "data"):
                            v = root.get(key)
                            if isinstance(v, list):
                                for it in v:
                                    if isinstance(it, dict):
                                        for kk in ("url", "href", "signed_url"):
                                            add_url(it.get(kk))
                            elif isinstance(v, dict):
                                for kk in ("stl", "obj", "glb", "url", "href", "signed_url"):
                                    add_url(v.get(kk))
                    elif isinstance(root, list):
                        for it in root:
                            if isinstance(it, dict):
                                for kk in ("stl","obj","glb","url","href","signed_url"):
                                    add_url(it.get(kk))
                for ext in ("stl","obj","glb"):
                    for cu in candidates:
                        if cu.lower().endswith(f".{ext}"):
                            pick = (ext, cu); break
                    if pick: break
                if pick:
                    ext, mesh_url = pick
                    dlog(f"[trellis] got mesh URL ({ext}): {mesh_url[:120]}")
                    with httpx.Client(timeout=120) as c:
                        dl = c.get(mesh_url)
                        dl.raise_for_status(); b = dl.content
                    if ext == "stl":
                        return "stl", b
                    stl_try = _convert_mesh_bytes_to_stl(b, ext)
                    if stl_try:
                        return "stl", stl_try
                    return ext, b
                # No asset yet — small delay and continue polling
                time.sleep(3)
            # If polling endpoint didn't yield, try '/response' suffix once
            alt = None
            if not poll_url.endswith('/response'):
                alt = poll_url.rstrip('/') + '/response'
                try:
                    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
                        pr = c.get(alt, headers={"Authorization": f"Key {FAL_KEY}"})
                    if pr.status_code in (200, 201):
                        jd = pr.json()
                        dlog(f"[trellis] alt response endpoint ok: {str(jd)[:120]}")
                        # Re-run extraction quickly
                        candidates: List[str] = []
                        def add_url2(s: Any):
                            try:
                                if isinstance(s, str) and s.startswith("http"):
                                    candidates.append(s)
                            except Exception:
                                pass
                        for key in ("mesh_url","stl","obj","glb","model_url"):
                            add_url2(jd.get(key))
                        for key in ("assets","output","result","data"):
                            v = jd.get(key)
                            if isinstance(v, list):
                                for it in v:
                                    if isinstance(it, dict):
                                        for kk in ("url","href","signed_url"):
                                            add_url2(it.get(kk))
                            elif isinstance(v, dict):
                                for kk in ("stl","obj","glb","url","href","signed_url"):
                                    add_url2(v.get(kk))
                        for ext in ("stl","obj","glb"):
                            for cu in candidates:
                                if cu.lower().endswith(f".{ext}"):
                                    with httpx.Client(timeout=120) as c:
                                        dl = c.get(cu)
                                        dl.raise_for_status(); b = dl.content
                                    if ext == 'stl':
                                        return 'stl', b
                                    stl_try = _convert_mesh_bytes_to_stl(b, ext)
                                    if stl_try: return 'stl', stl_try
                                    return ext, b
                except Exception as _:
                    pass
            # Timed out
            log("[trellis] polling timed out without mesh")
            return None

        # Synchronous style: probe likely fields for a mesh URL
        candidates: List[str] = []
        def add_url(s: Any):
            try:
                if isinstance(s, str) and s.startswith("http"):
                    candidates.append(s)
            except Exception:
                pass
        # Common shapes
        for key in ("mesh_url", "stl", "obj", "glb", "model_url"):
            v = jd.get(key)
            add_url(v)
        # Trellis variant: top-level model_mesh: { url, file_name }
        try:
            mm = jd.get("model_mesh")
            if isinstance(mm, dict):
                add_url(mm.get("url"))
        except Exception:
            pass
        # Nested assets/output arrays
        for key in ("assets", "output", "result", "data"):
            v = jd.get(key)
            if isinstance(v, list):
                for it in v:
                    if isinstance(it, dict):
                        for kk in ("url", "href", "signed_url"):
                            add_url(it.get(kk))
            elif isinstance(v, dict):
                for kk in ("stl", "obj", "glb", "url", "href", "signed_url"):
                    add_url(v.get(kk))
        # Prefer stl → obj → glb
        pick = None
        for ext in ("stl", "obj", "glb"):
            for cu in candidates:
                if cu.lower().endswith(f".{ext}"):
                    pick = (ext, cu)
                    break
            if pick:
                break
        # Fallback to first candidate
        if not pick and candidates:
            cu = candidates[0]
            ext = "stl" if cu.lower().endswith(".stl") else ("obj" if cu.lower().endswith(".obj") else "glb")
            pick = (ext, cu)
        if not pick:
            return None
        ext, mesh_url = pick
        with httpx.Client(timeout=120) as c:
            dl = c.get(mesh_url)
            dl.raise_for_status()
            b = dl.content
        # If not STL, return original and let downstream convert; else return STL
        if ext == "stl":
            return "stl", b
        # Convert to STL (pure Python if possible)
        stl_try = _convert_mesh_bytes_to_stl(b, ext)
        if stl_try:
            return "stl", stl_try
        return ext, b
    except Exception as e:
        log(f"[trellis] exception: {e}")
        return None


def _env_int_optional(name: str) -> Optional[int]:
    raw = os.getenv(name)
    if raw in (None, ""):
        return None
    try:
        return int(float(str(raw).strip()))
    except Exception:
        return None


def _pick_tripo_mesh_candidate(payload: Any) -> Optional[Tuple[str, str]]:
    candidates: List[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            url = node.get("url")
            if isinstance(url, str) and url.startswith("http"):
                candidates.append(url)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload)
    if not candidates:
        return None
    for ext in ("stl", "obj", "glb", "gltf", "fbx"):
        for url in candidates:
            if url.lower().endswith(f".{ext}"):
                return ext, url
    return "glb", candidates[0]


def _prepare_tripo_payload(image_inputs: List[Dict[str, Any]]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {}
    ordered = _order_image_inputs(image_inputs)
    if not ordered:
        return payload
    if len(ordered) == 1:
        payload["image_url"] = ordered[0]["url"]
        return payload

    def assign(slot: str, remaining: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        direct = next((item for item in ordered if item.get("view_role") == slot), None)
        if direct and direct in remaining:
            payload[f"{slot}_image_url"] = direct["url"]
            remaining.remove(direct)
            return remaining
        if direct and direct not in remaining:
            payload[f"{slot}_image_url"] = direct["url"]
            return remaining
        if remaining:
            pick = remaining.pop(0)
            payload[f"{slot}_image_url"] = pick["url"]
        return remaining

    front = next((item for item in ordered if item.get("view_role") == "front"), ordered[0])
    payload["front_image_url"] = front["url"]
    remaining = [item for item in ordered if item is not front]
    for slot in ("back", "left", "right"):
        remaining = assign(slot, remaining)
    return payload


def _guess_image_type(url: str) -> str:
    try:
        lowered = url.split('?')[0].lower()
    except Exception:
        lowered = ""
    for ext in ("png", "webp", "jpeg", "jpg"):
        if lowered.endswith(f".{ext}"):
            return "jpg" if ext == "jpeg" else ext
    return "jpg"


def _tripo_file_entry(url: str) -> Dict[str, Any]:
    entry: Dict[str, Any] = {}
    if url:
        entry["url"] = url
        entry["type"] = _guess_image_type(url)
    return entry

def _build_tripo_draft_request(image_inputs: List[Dict[str, Any]], payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not image_inputs:
        return None
    use_multi = len(image_inputs) > 1
    request: Dict[str, Any] = {}
    model_version = None
    if isinstance(payload, dict):
        mv = payload.get("model_version")
        if isinstance(mv, str) and mv.strip():
            model_version = mv.strip()
    if not model_version:
        model_version = TRIPO_DRAFT_MODEL_VERSION or DEFAULT_TRIPO_DRAFT_MODEL_VERSION

    if use_multi:
        request["type"] = "multiview_to_model"
        slots = ["front", "left", "back", "right"]
        files: List[Dict[str, Any]] = [{} for _ in slots]
        used_urls: Set[str] = set()
        for idx, slot in enumerate(slots):
            entry = next((item for item in image_inputs if item.get("view_role") == slot), None)
            if entry and isinstance(entry.get("url"), str):
                files[idx] = _tripo_file_entry(entry["url"])
                used_urls.add(entry["url"])
        for item in image_inputs:
            url = item.get("url")
            if not isinstance(url, str) or url in used_urls:
                continue
            try:
                slot_idx = files.index({})
            except ValueError:
                slot_idx = None
            if slot_idx is not None:
                files[slot_idx] = _tripo_file_entry(url)
                used_urls.add(url)
        if not files[0]:
            files[0] = _tripo_file_entry(image_inputs[0].get("url", ""))
        request["files"] = files
        if model_version:
            request["model_version"] = model_version
    else:
        request["type"] = "image_to_model"
        primary_url = image_inputs[0].get("url")
        if not isinstance(primary_url, str) or not primary_url:
            return None
        file_entry = _tripo_file_entry(primary_url)
        if not file_entry:
            return None
        request["file"] = file_entry
        if model_version:
            request["model_version"] = model_version

    int_envs = (
        ("TRIPO_MODEL_SEED", "model_seed"),
        ("TRIPO_TEXTURE_SEED", "texture_seed"),
        ("TRIPO_FACE_LIMIT", "face_limit"),
    )
    for env_name, field in int_envs:
        val = _env_int_optional(env_name)
        if val is not None:
            request[field] = val

    bool_envs = (
        ("TRIPO_TEXTURE", "texture"),
        ("TRIPO_PBR", "pbr"),
        ("TRIPO_AUTO_SIZE", "auto_size"),
        ("TRIPO_QUAD", "quad"),
        ("TRIPO_SMART_LOW_POLY", "smart_low_poly"),
        ("TRIPO_GENERATE_PARTS", "generate_parts"),
    )
    for env_name, field in bool_envs:
        val = _env_bool_optional(env_name)
        if val is not None:
            request[field] = val

    str_envs = (
        ("TRIPO_TEXTURE_ALIGNMENT", "texture_alignment"),
        ("TRIPO_TEXTURE_QUALITY", "texture_quality"),
        ("TRIPO_ORIENTATION", "orientation"),
        ("TRIPO_STYLE", "style"),
        ("TRIPO_COMPRESS", "compress"),
    )
    for env_name, field in str_envs:
        raw = os.getenv(env_name)
        if raw:
            request[field] = raw

    return request


def _tripo_headers() -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {TRIPO_API_KEY}",
        "Content-Type": "application/json",
    }


def _tripo_create_task(body: Dict[str, Any]) -> Optional[Tuple[str, Dict[str, Any]]]:
    if not TRIPO_API_KEY:
        log("[tripo] TRIPO_API_KEY not set")
        return None
    url = f"{TRIPO_API_BASE}/v2/openapi/task"
    try:
        with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
            resp = client.post(url, json=body, headers=_tripo_headers())
        try:
            data = resp.json()
        except Exception:
            data = None
        if resp.status_code >= 400:
            log(f"[tripo] create_task error {resp.status_code}: {resp.text[:200]}")
            return None
        if not isinstance(data, dict):
            log("[tripo] create_task response missing body")
            return None
        code = data.get("code")
        task_id = None
        if isinstance(data.get("data"), dict):
            task_id = data["data"].get("task_id")
        if not task_id and isinstance(data.get("task_id"), str):
            task_id = data.get("task_id")
        if code not in (None, 0):
            log(f"[tripo] create_task non-zero code: {code}")
        if not task_id:
            log(f"[tripo] create_task missing task_id: {json.dumps(data)[:200]}")
            return None
        return task_id, data
    except Exception as exc:
        log(f"[tripo] create_task exception: {exc}")
        return None


def _tripo_get_task(task_id: str) -> Optional[Dict[str, Any]]:
    if not TRIPO_API_KEY:
        return None
    url = f"{TRIPO_API_BASE}/v2/openapi/task/{task_id}"
    try:
        with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
            resp = client.get(url, headers={"Authorization": f"Bearer {TRIPO_API_KEY}"})
        if resp.status_code >= 400:
            log(f"[tripo] get_task error {resp.status_code}: {resp.text[:200]}")
            return None
        return resp.json()
    except Exception as exc:
        log(f"[tripo] get_task exception: {exc}")
        return None


def _extract_tripo_status(payload: Any) -> Optional[str]:
    statuses: List[str] = []

    def push(val: Any) -> None:
        if isinstance(val, str) and val.strip():
            statuses.append(val.strip().lower())

    if isinstance(payload, dict):
        for key in ("status", "state", "task_status"):
            push(payload.get(key))
        data = payload.get("data")
        if isinstance(data, dict):
            for key in ("status", "state", "task_status"):
                push(data.get(key))
            task = data.get("task")
            if isinstance(task, dict):
                for key in ("status", "state"):
                    push(task.get(key))
        elif isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    push(item.get("status"))
    return statuses[0] if statuses else None


def _extract_tripo_error_message(payload: Any) -> Optional[str]:
    messages: List[str] = []

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            for key in ("message", "error", "detail", "reason", "suggestion", "status_message", "description"):
                val = node.get(key)
                if isinstance(val, str):
                    txt = val.strip()
                    if txt and txt.lower() not in ("ok", "success", "succeeded"):
                        messages.append(txt)
            for val in node.values():
                visit(val)
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(payload)
    for msg in messages:
        if msg:
            return msg
    return None


def _tripo_stage_timeout(stage: str, override: Optional[int] = None) -> int:
    if override is not None and override > 0:
        return override
    try:
        if TRIPO_DRAFT_TIMEOUT_S:
            parsed = int(float(TRIPO_DRAFT_TIMEOUT_S))
            if parsed > 0:
                return parsed
    except Exception:
        pass
    return 600


def _tripo_poll_task(task_id: str, stage: str, timeout_s: Optional[int] = None) -> Optional[Dict[str, Any]]:
    timeout = _tripo_stage_timeout(stage, timeout_s)
    start = time.time()
    last_status: Optional[str] = None
    while time.time() - start < timeout:
        payload = _tripo_get_task(task_id)
        if payload is None:
            time.sleep(4.0)
            continue
        status = _extract_tripo_status(payload) or ""
        norm = status.lower()
        if norm in ("success", "succeeded", "completed", "finished", "done"):
            return payload
        if norm in ("failed", "fail", "error", "cancelled", "canceled"):
            err = _extract_tripo_error_message(payload)
            if err:
                log(f"[tripo] task {task_id} failed with status {status}: {err}")
            else:
                log(f"[tripo] task {task_id} failed with status {status}")
            return payload
        if status and status != last_status:
            log(f"[tripo] task {task_id} status {status}")
            last_status = status
        time.sleep(4.0 if stage == "draft" else 6.0)
    log(f"[tripo] task {task_id} timeout after {timeout}s")
    return None


def _fal_tripo_generate(image_inputs: List[Dict[str, Any]], timeout_s: int = 1200) -> Optional[Tuple[str, bytes]]:
    if not image_inputs:
        return None
    if not FAL_KEY:
        log("[tripo] FAL_KEY not set")
        return None
    base = (os.getenv("FAL_BASE_URL") or "https://fal.run").strip().rstrip("/")
    single_endpoint = (os.getenv("TRIPO_ENDPOINT") or "tripo3d/tripo/v2.5/image-to-3d").strip().lstrip("/")
    multi_endpoint = (os.getenv("TRIPO_MULTI_ENDPOINT") or "tripo3d/tripo/v2.5/multiview-to-3d").strip().lstrip("/")
    ordered = _order_image_inputs(image_inputs)
    if not ordered:
        return None
    use_multi = len(ordered) > 1
    endpoint = multi_endpoint if use_multi else single_endpoint
    url = f"{base}/{endpoint}"
    payload = _prepare_tripo_payload(ordered)
    if not payload:
        payload = {"image_url": ordered[0]["url"]}

    def _set_int(env_name: str, field: str) -> None:
        raw = os.getenv(env_name)
        if raw is None or raw == "":
            return
        try:
            payload[field] = int(raw)
        except Exception:
            log(f"[tripo] invalid integer for {env_name}: {raw}")

    def _set_str(env_name: str, field: str) -> None:
        raw = os.getenv(env_name)
        if raw:
            payload[field] = raw

    def _set_bool(env_name: str, field: str) -> None:
        if env_name in os.environ:
            payload[field] = _env_bool(env_name)

    _set_int("TRIPO_SEED", "seed")
    _set_int("TRIPO_TEXTURE_SEED", "texture_seed")
    _set_int("TRIPO_FACE_LIMIT", "face_limit")
    _set_str("TRIPO_TEXTURE", "texture")
    _set_str("TRIPO_TEXTURE_ALIGNMENT", "texture_alignment")
    _set_str("TRIPO_ORIENTATION", "orientation")
    _set_str("TRIPO_STYLE", "style")
    _set_bool("TRIPO_PBR", "pbr")
    _set_bool("TRIPO_AUTO_SIZE", "auto_size")
    _set_bool("TRIPO_QUAD", "quad")

    headers = {"Authorization": f"Key {FAL_KEY}", "Content-Type": "application/json"}
    # Configurable POST timeouts + simple retries for transient gateway stalls
    try:
        post_read_s =  float(os.getenv("TRIPO_POST_TIMEOUT_S", "90"))
        post_conn_s =  float(os.getenv("TRIPO_CONNECT_TIMEOUT_S", "10"))
    except Exception:
        post_read_s, post_conn_s = 90.0, 10.0
    try:
        post_retries = int(os.getenv("TRIPO_POST_RETRIES", "2"))
    except Exception:
        post_retries = 2
    body: Any = {}
    last_err: Optional[Exception] = None
    for attempt in range(post_retries + 1):
        try:
            with httpx.Client(timeout=httpx.Timeout(post_read_s, connect=post_conn_s)) as c:
                resp = c.post(url, headers=headers, json=payload)
            if resp.status_code in (200, 201, 202):
                body = resp.json() if resp.content else {}
                last_err = None
                break
            else:
                log(f"[tripo] error {resp.status_code}: {resp.text[:200]}")
                last_err = RuntimeError(f"HTTP {resp.status_code}")
        except Exception as e:
            last_err = e
            log(f"[tripo] request attempt {attempt+1} failed: {e}")
        # brief backoff before retrying
        if attempt < post_retries:
            time.sleep(2.0 * (attempt + 1))
    if last_err is not None and not body:
        log("[tripo] request failed after retries")
        return None

    pick = _pick_tripo_mesh_candidate(body)
    if not pick:
        poll_url = None
        for key in ("response_url", "status_url"):
            v = body.get(key)
            if isinstance(v, str) and v.startswith("http"):
                poll_url = v
                break
        if not poll_url:
            rid = body.get("request_id") or body.get("id") or body.get("task_id")
            if isinstance(rid, str) and rid:
                poll_url = f"{url.rstrip('/')}/requests/{rid}"
        if poll_url:
            start = time.time()
            while time.time() - start < timeout_s:
                try:
                    with httpx.Client(timeout=httpx.Timeout(60.0, connect=10.0)) as c:
                        pr = c.get(poll_url, headers=headers)
                    if pr.status_code not in (200, 201):
                        time.sleep(2)
                        continue
                    payload_json = pr.json()
                except Exception as pe:
                    log(f"[tripo] poll error: {pe}")
                    time.sleep(3)
                    continue
                pick = _pick_tripo_mesh_candidate(payload_json)
                if pick:
                    break
                status = str(payload_json.get("status") or payload_json.get("state") or "")
                if status.lower() in ("failed", "canceled", "cancelled", "error"):
                    log(f"[tripo] poll terminated: {status}")
                    return None
                time.sleep(3)
        if not pick:
            return None

    ext, mesh_url = pick
    try:
        with httpx.Client(timeout=120) as c:
            dl = c.get(mesh_url)
            dl.raise_for_status()
            data = dl.content
    except Exception as e:
        log(f"[tripo] download failed: {e}")
        return None

    ext_norm = ext.lower()
    if ext_norm not in ("stl", "obj", "glb", "gltf"):
        ext_norm = "glb"
    if ext_norm == "stl":
        return "stl", data
    stl_try = _convert_mesh_bytes_to_stl(data, ext_norm)
    if stl_try:
        return "stl", stl_try
    return ext_norm, data

def _proxy_heightmap_stl_from_image_bytes(img_bytes: bytes, size_mm: float = 80.0, max_height_mm: float = 6.0, base_mm: float = 2.0, grid: int = 128) -> Optional[bytes]:
    """Create a quick bas-relief STL from a single image.

    - Converts to grayscale, resizes to grid x grid
    - Builds a heightfield plate with base thickness and side walls
    - Returns binary STL bytes
    """
    try:
        from PIL import Image  # type: ignore
        im = Image.open(BytesIO(img_bytes)).convert('L')
        im = im.resize((grid, grid))
        h = np.array(im, dtype=np.float32) / 255.0  # 0..1
        nx, ny = h.shape[0], h.shape[1]
        # Coordinates in mm, centered at origin
        dx = size_mm / (nx - 1)
        dy = size_mm / (ny - 1)
        xs = (np.arange(nx) * dx) - size_mm / 2.0
        ys = (np.arange(ny) * dy) - size_mm / 2.0
        # Build vertices for top surface
        top_z = base_mm + (h * max_height_mm)
        # Vertex indexing helper
        def vid(i: int, j: int) -> int:
            return i * ny + j
        # Vertices list: top surface + bottom surface
        verts: List[Tuple[float, float, float]] = []
        for i in range(nx):
            for j in range(ny):
                verts.append((float(xs[i]), float(top_z[i, j]), float(ys[j])))
        base_start = len(verts)
        for i in range(nx):
            for j in range(ny):
                verts.append((float(xs[i]), 0.0, float(ys[j])))
        faces: List[Tuple[int, int, int]] = []
        # Top surface faces
        for i in range(nx - 1):
            for j in range(ny - 1):
                a = vid(i, j)
                b = vid(i + 1, j)
                c = vid(i + 1, j + 1)
                d = vid(i, j + 1)
                faces.append((a, b, c))
                faces.append((a, c, d))
        # Bottom surface faces (flip winding)
        def bid(i: int, j: int) -> int:
            return base_start + i * ny + j
        for i in range(nx - 1):
            for j in range(ny - 1):
                a = bid(i, j)
                b = bid(i, j + 1)
                c = bid(i + 1, j + 1)
                d = bid(i + 1, j)
                faces.append((a, c, b))
                faces.append((a, d, c))
        # Side walls
        # i=0 edge
        for j in range(ny - 1):
            t1, t2 = vid(0, j), vid(0, j + 1)
            b1, b2 = bid(0, j), bid(0, j + 1)
            faces.append((t2, t1, b1))
            faces.append((t2, b1, b2))
        # i=nx-1 edge
        for j in range(ny - 1):
            t1, t2 = vid(nx - 1, j), vid(nx - 1, j + 1)
            b1, b2 = bid(nx - 1, j), bid(nx - 1, j + 1)
            faces.append((t1, t2, b1))
            faces.append((t2, b2, b1))
        # j=0 edge
        for i in range(nx - 1):
            t1, t2 = vid(i, 0), vid(i + 1, 0)
            b1, b2 = bid(i, 0), bid(i + 1, 0)
            faces.append((t1, b1, t2))
            faces.append((t2, b1, b2))
        # j=ny-1 edge
        for i in range(nx - 1):
            t1, t2 = vid(i, ny - 1), vid(i + 1, ny - 1)
            b1, b2 = bid(i, ny - 1), bid(i + 1, ny - 1)
            faces.append((t2, b1, t1))
            faces.append((t2, b2, b1))
        import trimesh  # type: ignore
        mesh = trimesh.Trimesh(vertices=np.array(verts), faces=np.array(faces), process=True)
        return mesh.export(file_type='stl')
    except Exception as e:
        log(f"proxy_heightmap error: {e}")
        return None

def _claim_backoff_wait():
    now = time.time()
    sleep_until = _CLAIM_BACKOFF.get("sleep_until", 0.0)
    if sleep_until <= now:
        return
    remaining = max(0.0, sleep_until - now)
    if remaining > 0.05:
        # Sleep in small slices to allow cancellation checks between loops.
        time.sleep(min(1.5, remaining))


def _claim_backoff_register_failure(exc: Exception):
    failures = int(_CLAIM_BACKOFF.get("failures", 0)) + 1
    _CLAIM_BACKOFF["failures"] = failures
    delay = min(
        _CLAIM_BACKOFF_MAX_S,
        _CLAIM_BACKOFF_BASE_S * (2 ** min(failures - 1, 6)),
    )
    _CLAIM_BACKOFF["sleep_until"] = time.time() + delay
    log(
        "[claim] claim_i23d_task RPC failed; backing off",
        level='warning',
        failure_count=failures,
        delay_s=round(delay, 3),
        error=str(exc),
    )
    if failures >= CLAIM_ALERT_THRESHOLD and not _CLAIM_BACKOFF.get('alerted'):
        _CLAIM_BACKOFF['alerted'] = True
        log(
            "Worker claim backoff threshold exceeded",
            level='error',
            failure_count=failures,
            delay_s=round(delay, 3),
        )


def _claim_backoff_reset():
    if _CLAIM_BACKOFF.get("failures"):
        _CLAIM_BACKOFF["failures"] = 0
        _CLAIM_BACKOFF["sleep_until"] = 0.0
        _CLAIM_BACKOFF.pop('alerted', None)


def claim_next_order() -> Optional[Dict[str, Any]]:
    """Claim the next actionable order.

    Priority:
    1) Orders with status='dispatching' through the atomic dispatch lease RPC
    2) Orders with a queued i23d generation_task (created by /api/materialize)
    3) Existing slicing, fabrication, export, and uploaded-asset paths
    4) (Last resort) Old behavior via RPC or first 'new' order
    """
    _claim_backoff_wait()

    # 0) Claim dispatch work atomically without changing its lifecycle status.
    # Web dispatch requests clear any prior worker lease; a stale lease is
    # reclaimed by the server-only RPC after its timeout.
    try:
        claimed = supabase_rpc("claim_dispatching_order", {"p_worker_id": WORKER_ID})
        if claimed and isinstance(claimed, dict) and claimed.get("id"):
            _claim_backoff_reset()
            return claimed
    except Exception as exc:
        log(f"[claim] claim_dispatching_order RPC failed: {exc}", level="error")

    # 0a) Prefer queued i23d tasks via atomic RPC
    try:
        claimed = supabase_rpc("claim_i23d_task", {"p_worker_id": WORKER_ID})
        if claimed and isinstance(claimed, list) and claimed:
            row = claimed[0]
            order_data = row.get("order_data") if isinstance(row, dict) else None
            if isinstance(order_data, dict) and order_data.get("id"):
                try:
                    set_status(order_data["id"], "generating")
                except Exception:
                    task_data = row.get("task_data") if isinstance(row, dict) else None
                    task_id = task_data.get("id") if isinstance(task_data, dict) else None
                    if task_id:
                        try:
                            supabase_patch(
                                "generation_tasks",
                                {"id": f"eq.{task_id}", "status": "eq.running"},
                                {"status": "queued", "worker_id": None, "claimed_at": None},
                            )
                        except Exception as requeue_exc:
                            log(f"[claim] failed to requeue task {task_id}: {requeue_exc}", level="error")
                    try:
                        supabase_patch(
                            "orders",
                            {"id": f"eq.{order_data['id']}"},
                            {"worker_id": None, "locked_at": None},
                        )
                    except Exception:
                        pass
                    raise
                order_data["status"] = "generating"
                _claim_backoff_reset()
                return order_data
    except Exception as exc:
        _claim_backoff_register_failure(exc)
        return None

    # 1) Prefer queued i23d tasks
    try:
        tasks = supabase_get("generation_tasks", {"status": "eq.queued", "kind": "eq.i23d", "order": "created_at.asc", "limit": 1})
        if tasks:
            t = tasks[0]
            oid = t.get("order_id")
            if oid:
                # Queue state remains on generation_tasks; lifecycle state uses the command RPC.
                set_status(oid, "generating")
                supabase_patch("orders", {"id": f"eq.{oid}"}, {"worker_id": WORKER_ID, "locked_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                try:
                    supabase_patch(
                        "generation_tasks",
                        {"id": f"eq.{t['id']}"},
                        {"status": "running", "worker_id": WORKER_ID, "claimed_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
                    )
                except Exception:
                    pass
                # Fetch fresh order row
                rows = supabase_get("orders", {"id": f"eq.{oid}", "limit": 1})
                if rows:
                    _claim_backoff_reset()
                    return rows[0]
    except Exception as exc:
        _claim_backoff_register_failure(exc)
        return None

    # 2) Orders explicitly marked for slicing (user requested quote)
    try:
        slicing = supabase_get("orders", {"status": "eq.slicing", "order": "created_at.asc", "limit": 1}) or []
        if slicing:
            o = slicing[0]
            oid = o.get("id")
            if oid:
                supabase_patch("orders", {"id": f"eq.{oid}"}, {"worker_id": WORKER_ID, "locked_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                _claim_backoff_reset()
                return o
    except Exception:
        pass

    # 2a) Fabrication requested (repair + slice pipeline)
    try:
        fab = supabase_get("orders", {"status": "eq.fabrication_requested", "order": "created_at.asc", "limit": 1}) or []
        if fab:
            o = fab[0]
            oid = o.get("id")
            if oid:
                supabase_patch("orders", {"id": f"eq.{oid}"}, {"worker_id": WORKER_ID, "locked_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                _claim_backoff_reset()
                return o
    except Exception:
        pass

    # 2b) Orders requesting print‑ready STL export (status='exporting')
    try:
        exporting = supabase_get("orders", {"status": "eq.exporting", "order": "created_at.asc", "limit": 1}) or []
        if exporting:
            o = exporting[0]
            oid = o.get("id")
            if oid:
                supabase_patch("orders", {"id": f"eq.{oid}"}, {"worker_id": WORKER_ID, "locked_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                _claim_backoff_reset()
                return o
    except Exception:
        pass

    # 3) Orders with user-uploaded assets present (image or 3D model)
    try:
        # Consider up to N recent 'new' orders to avoid scanning entire table
        candidates = supabase_get("orders", {"status": "eq.new", "order": "created_at.asc", "limit": 25}) or []
        for o in candidates:
            oid = o.get("id")
            try:
                ups = list_uploads(oid)
            except Exception:
                ups = []
            has_image = any((u.get("kind") == "upload_image") for u in ups)
            has_model = any((u.get("kind") in ("upload_stl","upload_obj","upload_glb")) for u in ups)
            if has_image or has_model:
                set_status(oid, "generating")
                supabase_patch("orders", {"id": f"eq.{oid}"}, {"worker_id": WORKER_ID, "locked_at": time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                _claim_backoff_reset()
                return o
    except Exception:
        pass

    # 4) Fallback: atomic RPC (if present) — only accept if order has assets we can use
    try:
        claimed = supabase_rpc("claim_next_order", {"p_worker_id": WORKER_ID})
        if claimed and isinstance(claimed, dict) and claimed.get("id"):
            oid = claimed.get("id")
            ups = []
            try:
                ups = list_uploads(oid)
            except Exception:
                ups = []
            has_model = any(u.get("kind") in ("upload_stl","upload_obj","upload_glb") for u in ups)
            has_image = any(u.get("kind") == "upload_image" for u in ups)
            if has_model or has_image:
                _claim_backoff_reset()
                return claimed
            # No useful assets — set back to new and skip
            try:
                supabase_patch("orders", {"id": f"eq.{oid}"}, {"status": "new", "worker_id": None, "locked_at": None})
            except Exception:
                pass
    except Exception:
        pass
    # No suitable orders
    return None

def set_status(order_id: str, status: str) -> Dict[str, Any]:
    target_status = str(status)
    fallback_enabled = os.environ.get("LIFECYCLE_DIRECT_STATUS_FALLBACK", "0").strip().lower() in ("1", "true", "yes", "on")

    def compatibility_fallback() -> Dict[str, Any]:
        params: Dict[str, Any] = {"id": f"eq.{order_id}"}
        if target_status.lower() != "cancelled":
            params["status"] = "neq.cancelled"
        supabase_patch("orders", params, {"status": target_status})
        log(f"[status] compatibility fallback set {target_status} for order {order_id}", level="warning")
        return {"ok": True, "new_status": target_status, "changed": True, "reused": False, "fallback": True}

    try:
        return transition_status(supabase_rpc, order_id, target_status)
    except LifecycleTransitionError as exc:
        if fallback_enabled:
            return compatibility_fallback()
        if exc.code == "cancelled" or exc.previous_status == "cancelled":
            log(f"[status] preserved cancelled order {order_id}; rejected {target_status}")
        else:
            log(f"[status] rejected {target_status} for order {order_id}: {exc}", level="error")
        raise
    except Exception as exc:
        if fallback_enabled:
            return compatibility_fallback()
        log(f"[status] lifecycle RPC failed for {target_status} on order {order_id}: {exc}", level="error")
        raise


def reload_order(order_id: str) -> Optional[Dict[str, Any]]:
    try:
        rows = supabase_get("orders", {"id": f"eq.{order_id}", "limit": 1}) or []
        if rows:
            return rows[0]
    except Exception as exc:
        log(f"[reload_order] failed: {exc}", level='warning', order_id=order_id)
    return None


def _fetch_order_state(order_id: Optional[str]) -> Tuple[Optional[str], bool]:
    """Return (status, cancel_requested_flag)."""
    if not order_id:
        return None, False
    try:
        rows = supabase_get(
            "orders",
            {"id": f"eq.{order_id}", "select": "status,meta_json", "limit": 1},
        ) or []
    except Exception as exc:
        log(f"[cancel] state fetch failed for {order_id}: {exc}")
        return None, False
    if not rows:
        return None, False
    row = rows[0]
    status_val = row.get("status") if isinstance(row.get("status"), str) else None
    meta = row.get("meta_json") if isinstance(row.get("meta_json"), dict) else {}
    flag = bool(meta.get("cancel_requested")) if isinstance(meta, dict) else False
    return status_val, flag


def _fetch_order_status(order_id: Optional[str]) -> Optional[str]:
    status, _ = _fetch_order_state(order_id)
    return status

def _has_active_i23d_task(order_id: Optional[str]) -> bool:
    if not order_id:
        return False
    try:
        # Try IN filter first; fall back to two queries if unsupported
        try:
            rows = supabase_get(
                "generation_tasks",
                {
                    "order_id": f"eq.{order_id}",
                    "kind": "eq.i23d",
                    "status": "in.(queued,running)",
                    "order": "created_at.desc",
                    "limit": 1,
                },
            ) or []
        except Exception:
            rows = []
            for st in ("queued", "running"):
                try:
                    part = supabase_get(
                        "generation_tasks",
                        {
                            "order_id": f"eq.{order_id}",
                            "kind": "eq.i23d",
                            "status": f"eq.{st}",
                            "order": "created_at.desc",
                            "limit": 1,
                        },
                    ) or []
                    if part:
                        rows = part
                        break
                except Exception:
                    continue
        return bool(rows)
    except Exception:
        return False

def _clear_cancel_flag(order_id: Optional[str]) -> None:
    if not order_id:
        return
    try:
        rows = supabase_get("orders", {"id": f"eq.{order_id}", "select": "meta_json", "limit": 1}) or []
        meta = {}
        if rows and isinstance(rows[0].get("meta_json"), dict):
            meta = dict(rows[0]["meta_json"])  # shallow copy
        if meta.get("cancel_requested"):
            meta["cancel_requested"] = False
            try:
                supabase_patch("orders", {"id": f"eq.{order_id}"}, {"meta_json": meta})
                log("[cancel] Cleared cancel_requested flag due to active i23D task", order_id=order_id)
            except Exception as exc:
                log(f"[cancel] Failed to clear cancel flag: {exc}", level='warning', order_id=order_id)
    except Exception as exc:
        log(f"[cancel] Read meta_json failed: {exc}", level='warning', order_id=order_id)


def _order_cancelled(order_id: Optional[str]) -> bool:
    status_val, flag = _fetch_order_state(order_id)
    if flag:
        return True
    return bool(status_val and status_val.lower() == "cancelled")


def _skip_if_cancelled(order_id: Optional[str], stage: str) -> bool:
    if _order_cancelled(order_id):
        # If user explicitly queued an Image→3D task, honor that over a stale soft‑cancel during generate.
        if stage in ("generate", "generating", "post_generate") and _has_active_i23d_task(order_id):
            log(
                f"[cancel] Soft-cancel ignored for {stage} due to active i23D task",
                level='warning',
                order_id=order_id,
            )
            # Clear the flag so downstream stages proceed
            _clear_cancel_flag(order_id)
            return False
        log(f"[cancel] Order {order_id} cancelled before {stage}; skipping")
        return True
    return False

def attach_asset(order_id: str, kind: str, url: str, sha256: Optional[str] = None, meta: Optional[Dict[str, Any]] = None):
    """Insert an asset row and return the inserted representation list.

    Existing callers can ignore the return value; new callers can use it to
    get the asset id for viewer.focus events.
    """
    if VERIFY_UPLOADS and sha256:
        try:
            parsed = parse_supabase_url(url)
            if parsed:
                data = storage_download_bytes(*parsed)
            else:
                data = download_bytes(url)
            actual_sha = sha256_bytes(data)
            if actual_sha != sha256:
                raise ValueError(f"asset checksum mismatch ({actual_sha} != {sha256})")
        except Exception as exc:
            log(
                '[asset] checksum verification failed',
                level='error',
                order_id=order_id,
                asset_kind=kind,
                error=str(exc),
            )
            record_order_event(
                order_id,
                'asset_checksum_failed',
                'Asset checksum verification failed',
                severity='error',
                meta={'asset_kind': kind, 'url': url},
            )
            raise
    payload = {
        "order_id": order_id,
        "kind": kind,
        "url": url,
        "sha256": sha256,
        "meta_json": meta or {},
    }
    try:
        rows = supabase_insert("assets", payload)
        return rows
    except httpx.HTTPStatusError as exc:
        if exc.response is not None and exc.response.status_code == 409 and sha256:
            existing = fetch_asset_by_sha(order_id, kind, sha256)
            if existing:
                if meta:
                    merged_meta = dict((existing.get("meta_json") or {}) or {})
                    for key, value in meta.items():
                        if value is None:
                            continue
                        merged_meta[key] = value
                    try:
                        patched = supabase_patch("assets", {"id": f"eq.{existing.get('id')}"}, {"meta_json": merged_meta})
                        if isinstance(patched, list) and patched:
                            existing = patched[0]
                        else:
                            existing["meta_json"] = merged_meta
                    except Exception:
                        existing["meta_json"] = merged_meta
                return [existing]
        raise
    except Exception:
        return None


def fetch_asset_by_sha(order_id: str, kind: str, sha256: str) -> Optional[Dict[str, Any]]:
    if not sha256:
        return None
    try:
        rows = supabase_get(
            "assets",
            {
                "order_id": f"eq.{order_id}",
                "kind": f"eq.{kind}",
                "sha256": f"eq.{sha256}",
                "limit": 1,
            },
        ) or []
    except Exception:
        return None
    return rows[0] if rows else None


def record_order_event(order_id: str, phase: str, message: str, *, severity: str = 'info', meta: Optional[Dict[str, Any]] = None) -> None:
    payload = {
        'order_id': order_id,
        'phase': phase,
        'message': message,
    }
    meta_payload = dict(meta) if isinstance(meta, dict) else {}
    if severity and severity != 'info':
        meta_payload.setdefault('severity', severity)
    if meta_payload:
        payload['meta_json'] = meta_payload
    try:
        supabase_insert('order_events', payload)
    except Exception as exc:
        log(f"[order_events] insert failed: {exc}", level='warning', order_id=order_id, phase=phase)


def _merge_dict(base: Optional[Dict[str, Any]], updates: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    merged: Dict[str, Any] = dict(base or {})
    if updates:
        for key, value in updates.items():
            if value is None:
                continue
            merged[key] = value
    return merged


def mark_export_job(job_id: str, patch: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    try:
        rows = supabase_patch("export_jobs", {"id": f"eq.{job_id}"}, patch)
        if isinstance(rows, list) and rows:
            return rows[0]
    except Exception as exc:
        log(f"[export] job update failed: {exc}", level='warning', job_id=job_id)
    return None


def _viewer_glb_from_stl_bytes(stl_bytes: bytes) -> Optional[bytes]:
    """Convert STL bytes to a viewer-optimized GLB (uncompressed) using trimesh.
    This is deterministic and avoids external deps; meshopt/Draco can be layered later.
    """
    try:
        import trimesh  # type: ignore
        # Load the STL; keep geometry in millimeters (viewer already assumes mm)
        mesh = trimesh.load(BytesIO(stl_bytes), file_type='stl', force='mesh')
        if isinstance(mesh, trimesh.Trimesh):
            # Ensure normals exist for better shading; trimesh will compute if missing
            try:
                if not mesh.has_face_normals:
                    mesh.rezero()  # center near origin before export
            except Exception:
                pass
            out = mesh.export(file_type='glb')
            if isinstance(out, (bytes, bytearray)):
                return bytes(out)
            # Some trimesh versions return a file-like; read into bytes
            try:
                data = out.read()
                return data if isinstance(data, (bytes, bytearray)) else None
            except Exception:
                return None
        # If a scene is returned, concatenate to a single mesh and export
        if isinstance(mesh, trimesh.Scene):
            try:
                combined = trimesh.util.concatenate(tuple(g for g in mesh.geometry.values()))
                out = combined.export(file_type='glb')
                return out if isinstance(out, (bytes, bytearray)) else None
            except Exception:
                return None
    except Exception as e:
        log(f"[viewer_glb] STL→GLB conversion failed: {e}", level='warning')
    return None


def _attach_viewer_glb(order_id: str, stl_bytes: bytes, source_asset_id: Optional[str], source_kind: str, extra_meta: Optional[Dict[str, Any]] = None) -> Optional[Dict[str, Any]]:
    """Create and attach a viewer GLB derived from the given STL bytes.
    Returns the attached asset row on success.
    """
    glb = _viewer_glb_from_stl_bytes(stl_bytes)
    if not glb:
        return None
    # Optional meshopt compression via gltfpack if available
    try:
        packed = _pack_glb_meshopt(glb)
        if packed and isinstance(packed, (bytes, bytearray)) and len(packed) > 0:
            # Keep packed only if it is not larger than original
            if len(packed) <= len(glb):
                glb = bytes(packed)
                packed_size = len(glb)
                original_size = len(stl_bytes)
            else:
                packed_size = len(packed)
                original_size = len(glb)
        else:
            packed_size = None
            original_size = None
    except Exception:
        packed_size = None
        original_size = None
    sha = sha256_bytes(glb)
    path = f"{order_id}/{sha}.glb"
    url = storage_upload_bytes(STORAGE_BUCKET, path, glb, content_type='model/gltf-binary')
    meta: Dict[str, Any] = { 'viewer': True, 'source_asset_kind': source_kind }
    if source_asset_id:
        meta['source_asset_id'] = source_asset_id
    if extra_meta:
        try:
            meta.update({ k: v for k, v in extra_meta.items() if v is not None })
        except Exception:
            pass
    if packed_size is not None:
        try:
            meta['viewer_meshopt'] = True
            meta['viewer_original_size_bytes'] = int(original_size)
            meta['viewer_packed_size_bytes'] = int(packed_size)
        except Exception:
            pass
    rows = attach_asset(order_id, 'transform', url, sha, meta)
    try:
        if rows and isinstance(rows, list):
            return rows[0]
    except Exception:
        pass
    return None

def _resolve_gltfpack() -> Optional[str]:
    cand = os.getenv('GLTFPACK_PATH') or 'gltfpack'
    if cand and (os.path.isabs(cand) and os.path.exists(cand)):
        return cand
    resolved = shutil.which(cand)
    return resolved

def _pack_glb_meshopt(glb_bytes: bytes) -> Optional[bytes]:
    """Run gltfpack to meshopt-compress a GLB. Returns packed bytes or None.
    Requires GLTFPACK_PATH or gltfpack in PATH.
    """
    exe = _resolve_gltfpack()
    if not exe:
        return None
    with tempfile.TemporaryDirectory() as td:
        in_path = os.path.join(td, 'in.glb')
        out_path = os.path.join(td, 'out.glb')
        with open(in_path, 'wb') as f:
            f.write(glb_bytes)
        # Common gltfpack flags: -cc (meshopt compress), -tc (texture compress if present)
        # Keep quantization defaults; disable unnecessary extras.
        cmd = f"{shlex.quote(exe)} -i {shlex.quote(in_path)} -o {shlex.quote(out_path)} -cc -tc"
        code, out, err = _run(cmd, timeout_sec=300)
        if code != 0:
            try:
                print(f"[gltfpack] failed ({code}): {(err or out)[:200]}", flush=True)
            except Exception:
                pass
            return None
        if not os.path.exists(out_path):
            return None
        with open(out_path, 'rb') as f:
            packed = f.read()
        return packed


def claim_next_export_job() -> Optional[Dict[str, Any]]:
    """Claim next export OR slice job (unified queue)."""
    try:
        # Diagnostic: count pending jobs by type
        all_pending = supabase_get("export_jobs", {"status": "eq.pending", "select": "id,job_type,order_id,created_at"}) or []
        if all_pending:
            export_count = sum(1 for j in all_pending if j.get('job_type') == 'export')
            slice_count = sum(1 for j in all_pending if j.get('job_type') == 'slice')
            log(f"[claim] Found {len(all_pending)} pending jobs: {export_count} export, {slice_count} slice")

        # Claim both 'export' and 'slice' jobs, prioritize by created_at
        rows = supabase_get("export_jobs", {"status": "eq.pending", "order": "created_at.asc", "limit": 1}) or []
    except Exception as exc:
        log(f"[export] fetch pending jobs failed: {exc}", level='warning')
        return None
    if not rows:
        return None
    job = rows[0]
    job_id = job.get('id')
    order_id = job.get('order_id')
    job_type = job.get('job_type', 'export')
    if not job_id or not order_id:
        return None
    claimed_at = now_iso()
    try:
        supabase_patch(
            "export_jobs",
            {"id": f"eq.{job_id}", "status": "eq.pending"},
            {"status": "processing", "worker_id": WORKER_ID, "started_at": claimed_at, "updated_at": claimed_at},
        )
    except Exception as exc:
        log(f"[export] failed to claim {job_type} job {job_id}: {exc}", level='warning', order_id=order_id)
        return None
    job['status'] = 'processing'
    job['worker_id'] = WORKER_ID
    job['started_at'] = claimed_at
    log(f"[export] claimed {job_type} job {job_id}", order_id=order_id, job_type=job_type)
    return job


def complete_export_job(job: Dict[str, Any], asset: Dict[str, Any], orient_summary: Optional[Dict[str, Any]], target_mm: Optional[float], sha: Optional[str], storage_url: str) -> None:
    job_id = job.get('id')
    order_id = job.get('order_id')
    if not job_id or not order_id:
        return
    completed_at = now_iso()
    job_meta = _merge_dict(job.get('meta_json'), {
        'target_max_dim_mm': target_mm,
        'sha256': sha,
        'orientation': orient_summary,
        'storage_url': storage_url,
    })
    mark_export_job(job_id, {
        'status': 'succeeded',
        'asset_id': asset.get('id'),
        'completed_at': completed_at,
        'worker_id': WORKER_ID,
        'meta_json': job_meta,
    })
    log(
        f"[export] job {job_id} succeeded",
        order_id=order_id,
        asset_id=asset.get('id'),
        target_mm=target_mm,
    )
    set_status(order_id, 'stl_ready')
    record_order_event(
        order_id,
        'export_done',
        'print-ready STL available',
        meta={
            'job_id': job_id,
            'asset_id': asset.get('id'),
            'target_max_dim_mm': target_mm,
        },
    )
    try:
        asset_id = asset.get('id')
        signed = sign_or_direct(storage_url)
        if signed:
            payload = {
                'kind': 'stl',
                'url': signed,
                'asset_kind': 'repaired_sized_stl',
                'storage_url': storage_url,
            }
            if asset_id:
                payload['asset_id'] = asset_id
            supabase_insert('chat_messages', {'order_id': order_id, 'role': 'assistant', 'type': 'viewer.focus', 'content_json': payload})
    except Exception as exc:
        log(f"[export] viewer focus emit failed: {exc}", level='warning', order_id=order_id)


def fail_export_job(job: Dict[str, Any], message: str, *, meta: Optional[Dict[str, Any]] = None) -> None:
    job_id = job.get('id')
    order_id = job.get('order_id')
    if not job_id or not order_id:
        return
    completed_at = now_iso()
    merged_meta = _merge_dict(job.get('meta_json'), meta)
    mark_export_job(job_id, {
        'status': 'failed',
        'error_message': message[:400],
        'completed_at': completed_at,
        'worker_id': WORKER_ID,
        'meta_json': merged_meta,
    })
    log(
        f"[export] job {job_id} failed",
        level='error',
        order_id=order_id,
        message=message,
    )
    set_status(order_id, 'needs_review')
    record_order_event(order_id, 'export_failed', message, severity='error', meta={'job_id': job_id})
    try:
        supabase_insert('chat_messages', {
            'order_id': order_id,
            'role': 'assistant',
            'type': 'warning',
            'content_json': {'text': f'Sized STL failed: {message}'},
        })
    except Exception:
        pass


def process_export_job(job: Dict[str, Any]) -> bool:
    """Dispatch to export or slice handler based on job_type."""
    job_type = job.get('job_type', 'export')

    if job_type == 'slice':
        return _process_slice_job(job)
    elif job_type == 'export':
        return _process_sized_export_job(job)
    else:
        log(
            f"[export] unknown job_type: {job_type}",
            level='error',
            order_id=job.get('order_id')
        )
        fail_export_job(job, f'Unknown job_type: {job_type}')
        return True


def _process_sized_export_job(job: Dict[str, Any]) -> bool:
    """Original process_export_job logic for 'export' type jobs."""
    order_id = job.get('order_id')
    job_id = job.get('id')
    if not order_id or not job_id:
        return False
    if _skip_if_cancelled(order_id, 'export_job'):
        mark_export_job(job_id, {'status': 'cancelled', 'completed_at': now_iso(), 'worker_id': WORKER_ID})
        return True
    target_mm = _normalize_float(job.get('target_max_dim_mm'))
    try:
        log(
            f"[export] job {job_id} starting",
            order_id=order_id,
            target_mm=target_mm,
        )
        set_status(order_id, 'exporting')
        rep = latest_asset(order_id, 'repaired_stl')
        if not rep:
            raise RuntimeError('No repaired STL found for export')
        stl_url = rep.get('url')
        if not stl_url:
            raise RuntimeError('Repaired STL URL missing')
        expected_sha = rep.get('sha256') if isinstance(rep, dict) else None
        base_bytes = download_bytes(stl_url, expected_sha=expected_sha, order_id=order_id, context='export_job')
        with tempfile.TemporaryDirectory() as td:
            base_path = os.path.join(td, 'in.stl')
            out_path = os.path.join(td, 'out.stl')
            with open(base_path, 'wb') as f:
                f.write(base_bytes)
            prev_env = os.environ.get('TARGET_MODEL_MAX_DIM_MM')
            try:
                if target_mm and target_mm > 0:
                    os.environ['TARGET_MODEL_MAX_DIM_MM'] = str(target_mm)
                ok, logtxt, orient_meta = _blender_orient_and_clamp(base_path, out_path)
            finally:
                if prev_env is None:
                    os.environ.pop('TARGET_MODEL_MAX_DIM_MM', None)
                else:
                    os.environ['TARGET_MODEL_MAX_DIM_MM'] = prev_env
            if not ok or not os.path.exists(out_path):
                snippet = (logtxt or '') if isinstance(logtxt, str) else ''
                raise RuntimeError(f'orient/scale failed: {snippet[:160]}')
            with open(out_path, 'rb') as f:
                sized_bytes = f.read()
        sha = sha256_bytes(sized_bytes)
        storage_path = f"{order_id}/{sha}.stl"
        storage_url = storage_upload_bytes(STORAGE_BUCKET, storage_path, sized_bytes, content_type='model/stl')
        orient_summary = _orient_summary(orient_meta)
        asset_meta: Dict[str, Any] = {}
        if orient_summary:
            asset_meta['orientation'] = orient_summary
        if target_mm:
            asset_meta['target_max_dim_mm'] = target_mm
        rep_id = rep.get('id') if isinstance(rep, dict) else None
        if rep_id:
            asset_meta['source_asset_id'] = rep_id
        asset_meta['source_asset_kind'] = 'repaired_stl'
        sized_rows = attach_asset(order_id, 'repaired_sized_stl', storage_url, sha, asset_meta or None) or []
        if sized_rows and isinstance(sized_rows, list):
            sized_asset = sized_rows[0]
        else:
            sized_asset = fetch_asset_by_sha(order_id, 'repaired_sized_stl', sha)
        if not sized_asset:
            raise RuntimeError('failed to register sized STL asset')
        # Double-check job status before marking success; skip if cancelled/superseded
        try:
            jr = supabase_get("export_jobs", {"id": f"eq.{job_id}", "select": "status", "limit": 1}) or []
            if jr and str((jr[0] or {}).get('status') or '').lower() != 'processing':
                log(f"[export] job {job_id} no longer processing at commit; skipping success", order_id=order_id)
                return True
        except Exception:
            pass
        complete_export_job(job, sized_asset, orient_summary, target_mm, sha, storage_url)
        return True
    except Exception as exc:
        fail_export_job(job, str(exc))
        return True


def _process_slice_job(job: Dict[str, Any]) -> bool:
    """Execute slicing job and store quote in export_jobs.quote_json."""
    order_id = job.get('order_id')
    job_id = job.get('id')

    if not order_id or not job_id:
        return False

    if _skip_if_cancelled(order_id, 'slice_job'):
        mark_export_job(job_id, {
            'status': 'cancelled',
            'completed_at': now_iso(),
            'worker_id': WORKER_ID
        })
        return True

    try:
        log(f"[slice] job {job_id} starting", order_id=order_id)

        # Set order status for backward compat
        set_status(order_id, 'slicing')

        # Build order dict for process_slicing
        order_dict = reload_order(order_id)
        if not order_dict:
            order_dict = {'id': order_id}

        # Run existing slicing logic
        success = process_slicing(order_dict)

        if not success:
            raise RuntimeError('process_slicing returned False')

        # Extract quote from order.quote_json (process_slicing writes it)
        order_rows = supabase_get("orders", {"id": f"eq.{order_id}", "limit": 1}) or []
        if not order_rows:
            raise RuntimeError('Order not found after slicing')

        order = order_rows[0]
        quote = order.get('quote_json')

        if not quote or not isinstance(quote, dict):
            raise RuntimeError('Quote missing after process_slicing')

        # Mark job succeeded with quote
        completed_at = now_iso()
        mark_export_job(job_id, {
            'status': 'succeeded',
            'quote_json': quote,
            'completed_at': completed_at,
            'worker_id': WORKER_ID,
            'meta_json': _merge_dict(job.get('meta_json'), {
                'minutes': quote.get('minutes'),
                'grams': quote.get('grams'),
                'price_cents': quote.get('price_cents')
            })
        })

        log(
            f"[slice] job {job_id} succeeded",
            order_id=order_id,
            price_cents=quote.get('price_cents')
        )

        record_order_event(
            order_id,
            'slice_done',
            'Print check complete',
            meta={'job_id': job_id, 'price_cents': quote.get('price_cents')}
        )

        return True

    except Exception as exc:
        error_msg = str(exc)
        log(f"[slice] job {job_id} failed: {error_msg}", level='error', order_id=order_id)

        completed_at = now_iso()
        mark_export_job(job_id, {
            'status': 'failed',
            'error_message': error_msg[:400],
            'completed_at': completed_at,
            'worker_id': WORKER_ID
        })

        # Set order status to slice_failed
        set_status(order_id, 'slice_failed')

        record_order_event(
            order_id,
            'slice_failed',
            error_msg[:200],
            severity='error',
            meta={'job_id': job_id}
        )

        try:
            supabase_insert('chat_messages', {
                'order_id': order_id,
                'role': 'assistant',
                'type': 'warning',
                'content_json': {'text': f'Print check failed: {error_msg[:100]}'}
            })
        except Exception:
            pass

        return True  # Job handled, even if failed


def _mark_latest_i23d_task(order_id: str, status: str):
    """Mark the latest running/queued i23d task for this order with a new status.
    Used for idempotency so new materialize requests aren't blocked by stale tasks.
    """
    try:
        # Prefer running task; else queued
        running = supabase_get("generation_tasks", {"order_id": f"eq.{order_id}", "kind": "eq.i23d", "status": "eq.running", "order": "created_at.desc", "limit": 1}) or []
        rows = running
        if not rows:
            rows = supabase_get("generation_tasks", {"order_id": f"eq.{order_id}", "kind": "eq.i23d", "status": "eq.queued", "order": "created_at.desc", "limit": 1}) or []
        if rows:
            supabase_patch("generation_tasks", {"id": f"eq.{rows[0]['id']}"}, {"status": status})
    except Exception:
        pass


def merge_order_facts(order_id: str, facts: Dict[str, Any]):
    try:
        payload = {"p_order_id": order_id, "p_facts": facts}
        supabase_rpc("merge_order_facts", payload)
    except Exception as exc:
        log(f"[merge_order_facts] failed for {order_id}: {exc}")

def list_uploads(order_id: str, limit: int = 20) -> List[Dict[str, Any]]:
    rows = supabase_get("assets", {"order_id": f"eq.{order_id}", "order": "created_at.desc", "limit": limit})
    return [r for r in rows if str(r.get("kind", "")).startswith("upload_")]

def latest_asset(order_id: str, kind: str) -> Optional[Dict[str, Any]]:
    try:
        rows = supabase_get("assets", {"order_id": f"eq.{order_id}", "kind": f"eq.{kind}", "order": "created_at.desc", "limit": 1})
        if rows:
            return rows[0]
    except Exception:
        pass
    return None

def latest_raw_mesh_asset(order_id: str) -> Optional[Dict[str, Any]]:
    priority = [
        "raw_glb",
        "raw_gltf",
        "raw_obj",
        "raw_stl",
        "upload_glb",
        "upload_gltf",
        "upload_obj",
        "upload_stl",
    ]
    try:
        rows = supabase_get("assets", {"order_id": f"eq.{order_id}", "order": "created_at.desc", "limit": 25}) or []
    except Exception:
        return None
    for kind in priority:
        for row in rows:
            if row.get("kind") == kind:
                return row
    for r in rows:
        k = str(r.get("kind") or "")
        if k.startswith("raw_") or k.startswith("upload_"):
            return r
    return None

def latest_transform(order_id: str) -> Optional[Dict[str, Any]]:
    try:
        rows = supabase_get(
            "assets",
            {
                "order_id": f"eq.{order_id}",
                "kind": "eq.transform",
                "order": "created_at.desc",
                "limit": 10,
            },
        ) or []
    except Exception:
        return None

    if not rows:
        return None

    out: Dict[str, Any] = {}
    for row in rows:
        try:
            meta = row.get("meta_json") or {}
        except Exception:
            meta = {}

        if "target_max_dim_mm" not in out:
            t_raw = meta.get("target_max_dim_mm", meta.get("target_max_dim", meta.get("target")))
            try:
                if isinstance(t_raw, (int, float)):
                    val = float(t_raw)
                elif isinstance(t_raw, str) and t_raw.strip():
                    val = float(t_raw.strip())
                else:
                    val = None
            except (TypeError, ValueError):
                val = None
            if val is not None and val > 0:
                out["target_max_dim_mm"] = val

        if "upright" not in out:
            upr = meta.get("upright")
            if isinstance(upr, bool):
                out["upright"] = upr

        if "rotation_euler_deg" not in out:
            rot = meta.get("rotation_euler_deg")
            if (
                isinstance(rot, list)
                and len(rot) == 3
                and all(isinstance(x, (int, float)) for x in rot)
            ):
                out["rotation_euler_deg"] = [float(rot[0]), float(rot[1]), float(rot[2])]

        if "target_max_dim_mm" in out and "upright" in out and "rotation_euler_deg" in out:
            break

    return out if out else None

def compute_price(minutes: float, grams: float) -> Dict[str, Any]:
    """
    Calculate itemized pricing breakdown.

    Returns dict with:
        - grams: float
        - minutes: float
        - product_cents: int (material cost × 1.6 markup)
        - labor_cents: int (flat $10 fee)
        - shipping_cents: int (flat $8 fee, can be made dynamic later)
        - total_cents: int
    """
    # Material cost: $0.02/gram
    material_cost_cents = int(grams * 2)

    # Product price: material cost × 1.6 markup (60% margin)
    product_cents = int(material_cost_cents * 1.6)

    # Labor: flat $10 fee
    labor_cents = 1000

    # Shipping: flat $8 base (TODO: make dynamic based on weight/destination)
    shipping_cents = 800

    total_cents = product_cents + labor_cents + shipping_cents

    log(
        f"[pricing] {grams:.1f}g, {minutes:.1f}min → "
        f"material=${material_cost_cents/100:.2f} × 1.6 = product=${product_cents/100:.2f} + "
        f"labor=${labor_cents/100:.2f} + shipping=${shipping_cents/100:.2f} = "
        f"total=${total_cents/100:.2f}"
    )

    return {
        "grams": round(grams, 2),
        "minutes": round(minutes, 2),
        "product_cents": product_cents,
        "labor_cents": labor_cents,
        "shipping_cents": shipping_cents,
        "total_cents": total_cents,
    }

def _looks_like_binary_stl(b: bytes) -> bool:
    """Detect binary STL payloads even when mislabeled as another format."""
    if not isinstance(b, (bytes, bytearray)) or len(b) < 84:
        return False
    try:
        face_count = struct.unpack_from('<I', b, 80)[0]
    except struct.error:
        return False
    if face_count <= 0:
        return False
    expected = 84 + face_count * 50
    # Many generators produce perfectly sized STL files; allow a small slack for trailing bytes.
    if expected == len(b):
        return True
    # Some exporters append a short footer (e.g., 2 or 4 bytes).
    if len(b) > expected and len(b) - expected <= 4:
        return True
    return False


def _should_targeted_solidify(order: Optional[Dict[str, Any]], meta: Dict[str, Any]) -> bool:
    """Heuristic to decide whether we should solidify after repair for figurine-like meshes."""
    orient_meta = meta.get('orient_clamp') or {}
    if not isinstance(orient_meta, dict):
        return False
    if not orient_meta.get('ok'):
        return False
    # Skip if solidify already ran (either automatically or via env flag)
    if orient_meta.get('auto_solidify'):
        return False
    if meta.get('figurine_solidify', {}).get('ok'):
        return False

    base_area = float(orient_meta.get('base_contact_area_mm2') or 0.0)
    contact_vertices = int(orient_meta.get('base_contact_vertices') or 0)
    slender_ratio = orient_meta.get('slender_ratio') or meta.get('slender_ratio')
    try:
        slender_ratio = float(slender_ratio)
    except Exception:
        slender_ratio = None

    figurine_hint = False
    if order:
        style = str(order.get('style') or '').lower()
        prompt = str(order.get('prompt_text') or '').lower()
        figurine_hint = 'figurine' in style or 'organic' in style
        keywords = ('statue', 'bust', 'character', 'miniature', 'figurine', 'sculpt', 'portrait', 'head')
        if any(k in prompt for k in keywords):
            figurine_hint = True

    # If Blender disabled trims due to slender override, treat as figurine-like.
    if orient_meta.get('slender_override'):
        figurine_hint = True

    # Core triggers for reinforcement
    if slender_ratio and slender_ratio >= float(os.getenv('FIGURINE_SLENDER_RATIO_THRESHOLD', '6.0')):
        if base_area < float(os.getenv('FIGURINE_MIN_BASE_AREA_MM2', '220')) or contact_vertices < 60:
            return True

    if figurine_hint:
        if base_area < float(os.getenv('FIGURINE_MIN_BASE_AREA_MM2', '220')):
            return True
        if contact_vertices < int(os.getenv('FIGURINE_MIN_BASE_VERTICES', '60')):
            return True

    return False

def _guess_ext_from_content(b: bytes, fallback: str = "bin") -> str:
    try:
        if _looks_like_binary_stl(b):
            return "stl"
        # very light sniffing
        if b[:5] == b"solid":
            return "stl"
        if b[:4] == b"\x00\x00\x00\x20":
            return fallback
        if b[:4] == b"glTF":
            return "gltf"
        if b[:4] == b"\x67\x6c\x54\x46":
            return "gltf"
    except Exception:
        pass
    return fallback

def _binary_stl_face_count(b: bytes) -> Optional[int]:
    if not isinstance(b, (bytes, bytearray)) or len(b) < 84:
        return None
    try:
        return struct.unpack_from('<I', b, 80)[0]
    except struct.error:
        return None

def _convert_mesh_bytes_to_stl(src_bytes: bytes, src_ext: str) -> Optional[bytes]:
    """Best-effort conversion of GLB/OBJ/GLTF → STL using pure Python (trimesh).

    Returns STL bytes or None on failure.
    """
    try:
        import io
        import trimesh  # type: ignore
        # Load as scene or mesh
        file_type = src_ext.lower().lstrip('.')
        scene_or_mesh = trimesh.load(io.BytesIO(src_bytes), file_type=file_type, force='scene')
        if scene_or_mesh is None:
            return None
        if isinstance(scene_or_mesh, trimesh.Trimesh):
            mesh = scene_or_mesh
        else:
            # Concatenate geometry into a single mesh
            geoms = [g for g in scene_or_mesh.geometry.values()]
            if not geoms:
                return None
            mesh = trimesh.util.concatenate(geoms)
        # Unit normalization: glTF is meters. Convert to millimeters.
        try:
            if file_type in ('gltf', 'glb'):
                scale = float(os.getenv('GLTF_TO_STL_SCALE', '1000'))
                if scale != 1.0:
                    mesh.apply_scale(scale)
            elif file_type == 'obj':
                # Heuristic: if extremely small, likely meters
                extents = (mesh.bounds[1] - mesh.bounds[0]) if mesh.bounds is not None else None
                if extents is not None:
                    max_dim = float(max(extents))
                    if max_dim > 0 and max_dim < 2.0:
                        mesh.apply_scale(1000.0)
        except Exception:
            pass
        # Ensure normals
        try:
            mesh.rezero()
            mesh.remove_duplicate_faces()
            mesh.remove_degenerate_faces()
            mesh.remove_unreferenced_vertices()
            mesh.fix_normals()
        except Exception:
            pass
        stl_bytes = mesh.export(file_type='stl')
        if isinstance(stl_bytes, bytes):
            return stl_bytes
        if hasattr(stl_bytes, 'read'):
            return stl_bytes.read()
        if isinstance(stl_bytes, str):
            return stl_bytes.encode('utf-8', errors='ignore')
        return None
    except Exception as e:
        log(f"[convert] trimesh conversion failed: {e}")
        return None


def _meshy_generate(prompt: str, image_url: Optional[str] = None, image_urls: Optional[List[str]] = None, timeout_s: int = 1800, seed: Optional[int] = None, art_style: Optional[str] = None) -> Optional[Tuple[str, bytes]]:
    """Call Meshy per docs. Returns (ext, bytes) or None on failure.

    - If image_url provided → use Image-to-3D (openapi v1) with should_texture=false
    - Else → use Text-to-3D Preview (openapi v2) with mode="preview"
    """
    if not MESHY_API_KEY:
        log("[Meshy] No API key configured")
        return None
    base = os.getenv("MESHY_API_BASE", "https://api.meshy.ai")
    headers_api = {"Authorization": f"Bearer {MESHY_API_KEY}", "Content-Type": "application/json"}
    single_model = _sanitize_meshy_model(os.getenv("MESHY_IMAGE_MODEL"), "latest")
    multi_fallback = single_model if single_model != "latest" else "meshy-5"
    multi_model = _sanitize_meshy_model(os.getenv("MESHY_MULTI_MODEL"), multi_fallback)
    model_text_to_3d = single_model
    allow_remesh = os.getenv("MESHY_AUTO_REMESH", "0").lower() in ("1", "true", "yes")
    want_texture = os.getenv("MESHY_SHOULD_TEXTURE", "0").lower() in ("1", "true", "yes")
    def _post_json(url: str, json_payload: Dict[str, Any]) -> Dict[str, Any]:
        # Minimal retry/backoff for 429; surface 402 clearly.
        backoff = 1.5
        for attempt in range(4):
            with httpx.Client(timeout=httpx.Timeout(30.0, connect=10.0)) as c:
                r = c.post(url, headers=headers_api, json=json_payload)
            if r.status_code == 429:
                time.sleep(backoff)
                backoff *= 1.8
                continue
            if r.status_code == 402:
                raise RuntimeError("Meshy: 402 Payment Required (no credits)")
            if r.status_code not in (200, 201, 202):
                raise RuntimeError(f"Meshy error {r.status_code}: {r.text[:200]}")
            return r.json()
        raise RuntimeError("Meshy: exceeded retry attempts (429)")

    def _poll_until(url: str, ok_key: str = "model_urls", preferred_exts: Tuple[str, ...] = ("glb","obj","gltf","stl")) -> Tuple[str, Optional[str]]:
        """Poll a Meshy task until done.

        Returns (status, picked_url_or_none). Picks first available format in preferred_exts order.
        """
        started = time.time()
        last_status = ""
        while time.time() - started < timeout_s:
            try:
                with httpx.Client(timeout=30) as c:
                    rr = c.get(url, headers=headers_api)
                rr.raise_for_status()
                jd = rr.json()
            except httpx.HTTPError as he:
                log(f"[Meshy] poll exception: {he}")
                time.sleep(3)
                continue
            except Exception as exc:
                log(f"[Meshy] poll exception: {exc}")
                time.sleep(3)
                continue
            status = jd.get("status") or jd.get("task_status") or ""
            last_status = status
            urls = (jd.get(ok_key) or {})
            model_url = None
            for ext in preferred_exts:
                if ext in urls and urls.get(ext):
                    model_url = urls.get(ext)
                    break
            log(f"[Meshy] poll {url.split('/')[-2:]}: {status}")
            if status == "SUCCEEDED" and model_url:
                return status, model_url
            if status in ("FAILED", "CANCELED"):
                return status, None
            time.sleep(3)
        return last_status or "TIMEOUT", None

    try:
        image_inputs: List[str] = []
        if image_urls:
            for u in image_urls:
                if isinstance(u, str) and u:
                    image_inputs.append(u)
        if image_url:
            if isinstance(image_url, str) and image_url:
                if image_url not in image_inputs:
                    image_inputs.append(image_url)

        if image_inputs:
            use_multi = len(image_inputs) > 1
            payload: Dict[str, Any] = {
                "ai_model": multi_model if use_multi else single_model,
                "topology": "triangle",
                "should_remesh": False,
                "should_texture": want_texture,
                "enable_pbr": False,
                "moderation": False,
                "symmetry_mode": os.getenv("MESHY_SYMMETRY_MODE", "auto"),
            }
            if seed is not None:
                payload["seed"] = seed
            target_poly = os.getenv("MESHY_TARGET_POLYCOUNT")
            if target_poly:
                try:
                    tp_val = int(target_poly)
                    if tp_val >= 100:
                        payload["target_polycount"] = tp_val
                except Exception:
                    pass
            should_texture_env = os.getenv("MESHY_SHOULD_TEXTURE")
            if should_texture_env and should_texture_env.lower() in ("1", "true", "yes", "on"):
                payload["should_texture"] = True
            if use_multi:
                payload["image_urls"] = image_inputs[:4]
                payload["ai_model"] = multi_model
                log(f"[Meshy] POST {base}/openapi/v1/multi-image-to-3d")
                task = _post_json(f"{base}/openapi/v1/multi-image-to-3d", payload)
                poll_url = f"{base}/openapi/v1/multi-image-to-3d/"
            else:
                payload["image_url"] = image_inputs[0]
                payload["ai_model"] = single_model
                log(f"[Meshy] POST {base}/openapi/v1/image-to-3d")
                task = _post_json(f"{base}/openapi/v1/image-to-3d", payload)
                poll_url = f"{base}/openapi/v1/image-to-3d/"
            task_id = task.get("result") or task.get("id")
            if not task_id:
                return None
            status, model_url = _poll_until(f"{poll_url}{task_id}")
            if status != "SUCCEEDED" or not model_url:
                return None
            if allow_remesh:
                try:
                    payload_remesh = {"model_url": model_url, "target_formats": ["stl"]}
                    log(f"[Meshy] POST {base}/openapi/v1/remesh (stl)")
                    t3 = _post_json(f"{base}/openapi/v1/remesh", payload_remesh)
                    rid = t3.get("result") or t3.get("id")
                    if rid:
                        status3, out_url = _poll_until(f"{base}/openapi/v1/remesh/{rid}", preferred_exts=("stl","obj","glb","gltf"))
                        if status3 == "SUCCEEDED" and out_url:
                            with httpx.Client(timeout=120) as c:
                                dl = c.get(out_url)
                                dl.raise_for_status()
                                out_bytes = dl.content
                            if _looks_like_binary_stl(out_bytes):
                                log("[Meshy] remesh payload looks like binary STL despite extension")
                                return "stl", out_bytes
                            if out_url.lower().endswith('.stl'):
                                return "stl", out_bytes
                            ext_guess = 'obj' if out_url.lower().endswith('.obj') else ('glb' if out_url.lower().endswith('.glb') else 'gltf')
                            stl_try = _convert_mesh_bytes_to_stl(out_bytes, ext_guess)
                            if stl_try:
                                return "stl", stl_try
                            return ("obj" if ext_guess=='obj' else 'glb'), out_bytes
                except Exception as ee:
                    log(f"[Meshy] remesh to STL skipped: {ee}")
            # Fallback: download original preview output
            with httpx.Client(timeout=120) as c:
                dl = c.get(model_url)
                dl.raise_for_status(); b = dl.content
            if _looks_like_binary_stl(b):
                log("[Meshy] preview payload looks like binary STL despite extension")
                return "stl", b
            return ("glb" if model_url.lower().endswith(".glb") else "obj"), b
        else:
            # Text → 3D preview (geometry only), then refine for higher quality
            payload: Dict[str, Any] = {
                "mode": "preview",
                "prompt": prompt,
                "art_style": art_style or "realistic",
                "ai_model": model_text_to_3d,
                "topology": "triangle",
                "should_remesh": False,
                "moderation": False,
            }
            if seed is not None:
                payload["seed"] = seed
            log(f"[Meshy] POST {base}/openapi/v2/text-to-3d (preview)")
            task = _post_json(f"{base}/openapi/v2/text-to-3d", payload)
            task_id = task.get("result") or task.get("id")
            if not task_id:
                return None
            status, model_url = _poll_until(f"{base}/openapi/v2/text-to-3d/{task_id}")
            if status != "SUCCEEDED":
                return None
            # Optional refine step (enable via MESHY_REFINE=1 for higher quality)
            if os.getenv("MESHY_REFINE", "0") in ("1", "true", "True"):
                try:
                    refine_payload = {
                        "mode": "refine",
                        "preview_task_id": task_id,
                        "ai_model": model_text_to_3d,
                        "topology": "triangle",
                        "should_remesh": False,
                        "moderation": False,
                    }
                    log(f"[Meshy] POST {base}/openapi/v2/text-to-3d (refine)")
                    t2 = _post_json(f"{base}/openapi/v2/text-to-3d", refine_payload)
                    refine_id = t2.get("result") or t2.get("id")
                    if refine_id:
                        status2, model_url2 = _poll_until(f"{base}/openapi/v2/text-to-3d/{refine_id}")
                        if status2 == "SUCCEEDED" and model_url2:
                            model_url = model_url2
                except Exception as ee:
                    log(f"[Meshy] refine failed/skipped: {ee}")

            if not model_url:
                return None
            if allow_remesh:
                try:
                    payload_remesh = {"model_url": model_url, "target_formats": ["stl"]}
                    log(f"[Meshy] POST {base}/openapi/v1/remesh (stl)")
                    t3 = _post_json(f"{base}/openapi/v1/remesh", payload_remesh)
                    rid = t3.get("result") or t3.get("id")
                    if rid:
                        status3, out_url = _poll_until(f"{base}/openapi/v1/remesh/{rid}", preferred_exts=("stl","obj","glb","gltf"))
                        if status3 == "SUCCEEDED" and out_url:
                            with httpx.Client(timeout=120) as c:
                                dl = c.get(out_url)
                                dl.raise_for_status()
                                out_bytes = dl.content
                            if _looks_like_binary_stl(out_bytes):
                                log("[Meshy] remesh payload looks like binary STL despite extension")
                                return "stl", out_bytes
                            if out_url.lower().endswith('.stl'):
                                return "stl", out_bytes
                            ext_guess = 'obj' if out_url.lower().endswith('.obj') else ('glb' if out_url.lower().endswith('.glb') else 'gltf')
                            stl_try = _convert_mesh_bytes_to_stl(out_bytes, ext_guess)
                            if stl_try:
                                return "stl", stl_try
                            return ("obj" if ext_guess=='obj' else 'glb'), out_bytes
                except Exception as ee:
                    log(f"[Meshy] remesh to STL skipped: {ee}")
            # Fallback: download original preview
            with httpx.Client(timeout=120) as c:
                dl = c.get(model_url)
                dl.raise_for_status(); b = dl.content
            if _looks_like_binary_stl(b):
                log("[Meshy] preview payload looks like binary STL despite extension")
                return "stl", b
            return ("glb" if model_url.lower().endswith(".glb") else "obj"), b
    except Exception as e:
        log(f"[Meshy] exception: {e}")
        return None


def _get_selected_image_ids(order_id: str) -> List[str]:
    try:
        rows = supabase_get("images", {"order_id": f"eq.{order_id}", "kind": "eq.chosen", "order": "created_at.asc", "limit": 20}) or []
        ids = [r.get("id") for r in rows if r.get("id")]
        if ids:
            return ids
    except Exception:
        pass
    # Fallback to latest generation_task payload
    try:
        tasks = supabase_get("generation_tasks", {"order_id": f"eq.{order_id}", "kind": "eq.i23d", "order": "created_at.desc", "limit": 1}) or []
        if tasks and isinstance(tasks[0].get("payload_json"), dict):
            p = tasks[0]["payload_json"]
            ids = p.get("imageIds") or []
            if isinstance(ids, list):
                return [i for i in ids if isinstance(i, str)]
    except Exception:
        pass
    return []

def _get_latest_i23d_task(order_id: str) -> Optional[Dict[str, Any]]:
    for status in ("running", "queued"):
        try:
            rows = supabase_get(
                "generation_tasks",
                {
                    "order_id": f"eq.{order_id}",
                    "kind": "eq.i23d",
                    "status": f"eq.{status}",
                    "order": "created_at.desc",
                    "limit": 1,
                },
            ) or []
            if rows:
                return rows[0]
        except Exception:
            pass
    try:
        rows = supabase_get(
            "generation_tasks",
            {"order_id": f"eq.{order_id}", "kind": "eq.i23d", "order": "created_at.desc", "limit": 1},
        ) or []
        if rows:
            return rows[0]
    except Exception:
        pass
    return None


def _tripo_stage_failure_notice(order_id: str, stage: str, status: Optional[str], message: Optional[str]) -> None:
    stage_label = "Draft" if stage == "draft" else ("Refine" if stage == "refine" else stage.capitalize())
    reason = message or f"Tripo returned status {status or 'failed'}."
    log(f"[tripo] {stage_label} failed for order {order_id}: {reason}", level='error', order_id=order_id, stage=stage, provider='tripo')
    try:
        record_order_event(
            order_id,
            'generate_warning',
            f'{stage_label} stage failed',
            severity='error',
            meta={
                'provider': 'tripo',
                'stage': stage,
                'status': status,
                'message': reason,
            },
        )
    except Exception:
        pass
    try:
        supabase_insert(
            "chat_messages",
            {
                "order_id": order_id,
                "role": "assistant",
                "type": "warning",
                "content_json": {
                    "text": f"{stage_label} failed — {reason}"
                },
            },
        )
    except Exception:
        pass


def _tripo_stage_generate(
    order: Dict[str, Any],
    stage: str,
    ordered_inputs: List[Dict[str, Any]],
    task_row: Optional[Dict[str, Any]],
    payload: Dict[str, Any],
) -> Optional[Tuple[str, bytes, Dict[str, Any]]]:
    if not TRIPO_API_KEY:
        log("[tripo] API key missing; cannot run stage")
        return None
    order_id = order.get("id")
    if not isinstance(order_id, str) or not order_id:
        return None

    payload_dict: Dict[str, Any] = dict(payload or {}) if isinstance(payload, dict) else {}
    provider_task_id = None
    if task_row and isinstance(task_row.get("provider_task_id"), str):
        provider_task_id = task_row.get("provider_task_id")
    if not provider_task_id:
        provider_task_id = payload_dict.get("provider_task_id")
    request_payload: Optional[Dict[str, Any]] = None

    if stage == "draft" or not stage:
        if not ordered_inputs:
            log("[tripo] draft stage missing image inputs")
            return None
        created_new = False
        if not provider_task_id:
            request_payload = _build_tripo_draft_request(ordered_inputs, payload_dict) or {}
        else:
            stored_req = payload_dict.get("request")
            if isinstance(stored_req, dict):
                request_payload = dict(stored_req)
            else:
                request_payload = _build_tripo_draft_request(ordered_inputs, payload_dict) or {}
        if not request_payload:
            log("[tripo] draft stage could not build request payload")
            return None
        if not request_payload.get("model_version"):
            request_payload["model_version"] = TRIPO_DRAFT_MODEL_VERSION or DEFAULT_TRIPO_DRAFT_MODEL_VERSION
        draft_model_version = request_payload.get("model_version")
        if not provider_task_id:
            created = _tripo_create_task(request_payload)
            if not created:
                return None
            provider_task_id, create_resp = created
            created_new = True
            payload_dict["tripo_created_at"] = time.time()
        payload_dict["stage"] = "draft"
        payload_dict["provider_task_id"] = provider_task_id
        if "imageIds" not in payload_dict:
            payload_dict["imageIds"] = [inp.get("image_id") for inp in ordered_inputs if inp.get("image_id")]
        payload_dict["request"] = {k: v for k, v in request_payload.items() if k not in ("files",)}
        payload_dict["draft_model_version"] = draft_model_version
        if task_row and task_row.get("id"):
            patch_body: Dict[str, Any] = {"payload_json": payload_dict}
            if created_new:
                patch_body["provider"] = "tripo"
                patch_body["provider_task_id"] = provider_task_id
            try:
                supabase_patch("generation_tasks", {"id": f"eq.{task_row['id']}"}, patch_body)
            except Exception as exc:
                log(f"[tripo] draft task patch failed: {exc}")
    else:
        return None

    poll_payload = _tripo_poll_task(provider_task_id, stage)
    if not poll_payload:
        return None
    pick = _pick_tripo_mesh_candidate(poll_payload)
    if not pick and isinstance(poll_payload, dict):
        data_node = poll_payload.get("data")
        if isinstance(data_node, dict):
            pick = _pick_tripo_mesh_candidate(data_node)
    if not pick:
        status_final = _extract_tripo_status(poll_payload)
        err_msg = _extract_tripo_error_message(poll_payload)
        payload_dict["stage"] = stage
        if status_final:
            payload_dict["tripo_status"] = status_final
        if err_msg:
            payload_dict["tripo_error"] = err_msg
        if task_row and task_row.get("id"):
            try:
                supabase_patch("generation_tasks", {"id": f"eq.{task_row['id']}"}, {"payload_json": payload_dict})
            except Exception as exc:
                log(f"[tripo] failure payload patch failed: {exc}")
        _tripo_stage_failure_notice(order_id, stage, status_final, err_msg)
        log("[tripo] task completed without mesh URL")
        return None
    ext, mesh_url = pick
    try:
        with httpx.Client(timeout=httpx.Timeout(120.0, connect=10.0)) as client:
            dl = client.get(mesh_url)
            dl.raise_for_status()
            mesh_bytes = dl.content
    except Exception as exc:
        log(f"[tripo] download failed: {exc}")
        return None

    status_final = _extract_tripo_status(poll_payload)
    stage_meta: Dict[str, Any] = {
        "materialize_stage": stage,
        "tripo_task_id": provider_task_id,
        "tripo_mesh_ext": ext,
        "tripo_mesh_url": mesh_url,
    }
    if status_final:
        stage_meta["tripo_status"] = status_final
    request_meta = payload_dict.get("request") if isinstance(payload_dict.get("request"), dict) else None
    if stage == "draft":
        stage_meta["tripo_model_version"] = (
            payload_dict.get("draft_model_version")
            or (request_meta.get("model_version") if isinstance(request_meta, dict) else None)
            or TRIPO_DRAFT_MODEL_VERSION
            or DEFAULT_TRIPO_DRAFT_MODEL_VERSION
        )

    if task_row and task_row.get("id"):
        payload_patch = dict(payload_dict)
        payload_patch["stage"] = stage
        payload_patch["tripo_status"] = status_final
        payload_patch["tripo_mesh_url"] = mesh_url
        payload_patch["tripo_mesh_ext"] = ext
        try:
            supabase_patch("generation_tasks", {"id": f"eq.{task_row['id']}"}, {"payload_json": payload_patch})
        except Exception as exc:
            log(f"[tripo] payload patch failed: {exc}")

    return ext, mesh_bytes, stage_meta

def generate(order: Dict[str, Any]) -> Optional[Tuple[str, str]]:
    """Return (kind, url) of the raw asset via configured Image→3D providers.

    Priority:
    1) If user uploaded a model (STL/OBJ/GLB), use it directly
    2) If concept image(s) present, call Tripo3D (FAL) first when available,
       fall back to Meshy or Trellis depending on configuration
    Otherwise: do nothing (return None) so the caller can mark generate_failed
    """
    order_id = order.get("id")
    if not order_id:
        return None
    uploads = list_uploads(order_id)  # newest first
    # Prefer a user model if provided
    for up in uploads:
        k = up.get("kind", "")
        if k in ("upload_stl", "upload_obj", "upload_glb"):
            url = up.get("url")
            if url:
                return k.replace("upload_", "raw_"), url

    task_row = None
    try:
        task_row = _get_latest_i23d_task(order_id)
    except Exception:
        task_row = None

    payload = {}
    if task_row and isinstance(task_row.get("payload_json"), dict):
        payload = task_row.get("payload_json") or {}

    payload_views = payload.get("imageViews") if isinstance(payload, dict) else None
    selected_image_ids: List[str] = []

    def _push_image_id(val: Any) -> None:
        if isinstance(val, str) and val and val not in selected_image_ids:
            selected_image_ids.append(val)

    if isinstance(payload_views, list):
        for view in payload_views:
            if isinstance(view, dict):
                _push_image_id(view.get("imageId") or view.get("image_id"))

    if isinstance(payload, dict):
        ids = payload.get("imageIds")
        if isinstance(ids, list):
            for val in ids:
                _push_image_id(val)

    for val in _get_selected_image_ids(order_id):
        _push_image_id(val)

    image_upload_assets = [up for up in uploads if up.get("kind") == "upload_image"]
    assets_by_image: Dict[str, List[Dict[str, Any]]] = {}
    for asset in image_upload_assets:
        meta = asset.get("meta_json") or {}
        image_id = meta.get("image_id")
        if image_id:
            assets_by_image.setdefault(image_id, []).append(asset)

    image_meta_map: Dict[str, Dict[str, Any]] = {}
    for image_id in selected_image_ids:
        if image_id in image_meta_map:
            continue
        try:
            rows = supabase_get("images", {"id": f"eq.{image_id}", "limit": 1}) or []
            if rows:
                image_meta_map[image_id] = rows[0].get("meta_json") or {}
        except Exception:
            pass

    image_inputs: List[Dict[str, Any]] = []

    def add_image_input(asset_url: Optional[str], view_role: Optional[str], image_id: Optional[str]) -> None:
        signed = sign_or_direct(asset_url)
        if not signed:
            return
        image_inputs.append({
            "url": signed,
            "view_role": _normalize_view_role(view_role),
            "image_id": image_id,
        })

    if isinstance(payload_views, list):
        for view in payload_views:
            if not isinstance(view, dict):
                continue
            image_id = view.get("imageId") or view.get("image_id")
            asset_url = view.get("assetUrl") or view.get("asset_url")
            if not asset_url and image_id and image_id in assets_by_image:
                asset_url = assets_by_image[image_id][0].get("url")
            view_role = view.get("viewRole") or view.get("view_role") or view.get("angle")
            add_image_input(asset_url, view_role, image_id)

    for image_id in selected_image_ids:
        if any(inp.get("image_id") == image_id for inp in image_inputs):
            continue
        asset_candidates = assets_by_image.get(image_id) or []
        asset_url = asset_candidates[0].get("url") if asset_candidates else None
        if not asset_url:
            for asset in image_upload_assets:
                meta = asset.get("meta_json") or {}
                if meta.get("image_id") == image_id:
                    asset_url = asset.get("url")
                    break
        meta_view_role = None
        if asset_candidates and isinstance(asset_candidates[0].get("meta_json"), dict):
            meta_view_role = asset_candidates[0]["meta_json"].get("view_role") or asset_candidates[0]["meta_json"].get("angle")
        if not meta_view_role and image_id in image_meta_map:
            meta_view_role = image_meta_map[image_id].get("view_role") or image_meta_map[image_id].get("angle")
        add_image_input(asset_url, meta_view_role, image_id)

    if not image_inputs:
        for asset in image_upload_assets:
            meta = asset.get("meta_json") or {}
            add_image_input(asset.get("url"), meta.get("view_role") or meta.get("angle"), meta.get("image_id"))
            if len(image_inputs) >= 4:
                break

    deduped_inputs: List[Dict[str, Any]] = []
    seen_urls: Set[str] = set()
    for item in image_inputs:
        url = item.get("url")
        if not url or url in seen_urls:
            continue
        seen_urls.add(url)
        deduped_inputs.append(item)
    image_inputs = deduped_inputs

    ordered_inputs = _order_image_inputs(image_inputs)
    if not ordered_inputs:
        log("[generate] No concept images available; skipping image-to-3D.")
        return None

    image_urls_for_models = [entry["url"] for entry in ordered_inputs]

    stage: Optional[str] = None
    if isinstance(payload, dict):
        stage_raw = payload.get("stage") or payload.get("materialize_stage")
        if isinstance(stage_raw, str):
            stage_norm = stage_raw.strip().lower()
            if stage_norm:
                stage = stage_norm

    result: Optional[Tuple[str, bytes]] = None
    stage_meta: Optional[Dict[str, Any]] = None
    if stage in (None, "", "draft"):
        stage_out = _tripo_stage_generate(order, "draft", ordered_inputs, task_row, payload)
        if not stage_out:
            return None
        result = (stage_out[0], stage_out[1])
        stage_meta = stage_out[2]
        if stage_meta:
            order["_last_generate_meta"] = stage_meta

    fallback_prompt = order.get("prompt_text") or "3D model"

    if result is None:
        proxy_flag = os.getenv("I23D_PROXY_HEIGHTMAP", "0").lower() in ("1", "true", "yes", "on")
        if proxy_flag and not any(up.get("kind") == "proxy_stl" for up in uploads):
            try:
                img0 = image_urls_for_models[0]
                img_bytes = download_bytes(img0, order_id=order_id, context='proxy_heightmap')
                stl_proxy = _proxy_heightmap_stl_from_image_bytes(img_bytes)
                if stl_proxy:
                    sha = sha256_bytes(stl_proxy)
                    path = f"{order_id}/{sha}.stl"
                    url = storage_upload_bytes(STORAGE_BUCKET, path, stl_proxy, content_type="model/stl")
                    attach_asset(order_id, "proxy_stl", url)
                    try:
                        supabase_insert("chat_messages", {"order_id": order_id, "role": "assistant", "type": "text", "content_json": {"text": "Draft preview ready — refining…"}})
                    except Exception:
                        pass
                else:
                    log("[proxy] failed to generate bas-relief proxy")
            except Exception as pe:
                log(f"[proxy] error: {pe}")

    provider_env = (os.getenv("I23D_PROVIDER") or "").strip().lower()
    trellis_flag = _env_bool("I23D_TRELLIS_FALLBACK", False)

    def add_provider(name: str, bucket: List[str]) -> None:
        if name not in bucket:
            bucket.append(name)

    providers_to_try: List[str] = []
    # Meshy-only routing (Tripo disabled)
    if provider_env in ("", "meshy", "tripo"):
        if MESHY_API_KEY:
            add_provider("meshy", providers_to_try)
    elif provider_env == "trellis":
        # Explicit trellis-only mode
        if trellis_flag and FAL_KEY:
            add_provider("trellis", providers_to_try)
    # Optional last-resort trellis fallback
    if trellis_flag and FAL_KEY and "meshy" in providers_to_try:
        add_provider("trellis", providers_to_try)

    timeout_default = 900
    try:
        timeout_default = int(os.getenv("I23D_TIMEOUT_S", os.getenv("FAST_MATERIALIZE_TIMEOUT_S", "900")))
    except Exception:
        timeout_default = 900

    for provider_name in providers_to_try:
        if provider_name == "meshy":
            if not MESHY_API_KEY:
                continue
            try:
                log(f"[generate] Meshy request on {len(image_urls_for_models)} image(s)", order_id=order_id, provider='meshy')
                meshy_timeout = timeout_default
                stage_skip = result is not None
                if stage_skip:
                    break
                result = _meshy_generate(fallback_prompt, image_urls=image_urls_for_models, timeout_s=max(120, meshy_timeout))
                if result:
                    log("[generate] Meshy job succeeded", order_id=order_id, provider='meshy')
                    break
                record_order_event(
                    order_id,
                    'generate_provider_retry',
                    'Meshy returned no mesh',
                    severity='warning',
                    meta={'provider': 'meshy'},
                )
            except Exception as e:
                log(f"[meshy] error: {e}", level='error', order_id=order_id, provider='meshy')
                record_order_event(
                    order_id,
                    'generate_provider_error',
                    'Meshy provider error',
                    severity='error',
                    meta={'provider': 'meshy', 'error': str(e)[:300]},
                )
        elif provider_name == "trellis":
            if not FAL_KEY:
                log("[generate] Trellis requested but FAL_KEY not set")
                continue
            try:
                log(f"[generate] Trellis fallback on {len(image_urls_for_models)} image(s)", order_id=order_id, provider='trellis')
                trellis_timeout = timeout_default
                if result is not None:
                    break
                result = _fal_trellis_multi(image_urls_for_models, timeout_s=max(120, trellis_timeout))
                if result:
                    log("[generate] Trellis fallback succeeded", order_id=order_id, provider='trellis')
                    break
                record_order_event(
                    order_id,
                    'generate_provider_retry',
                    'Trellis returned no mesh',
                    severity='warning',
                    meta={'provider': 'trellis'},
                )
            except Exception as e:
                log(f"[trellis] fallback error: {e}", level='error', order_id=order_id, provider='trellis')
                record_order_event(
                    order_id,
                    'generate_provider_error',
                    'Trellis provider error',
                    severity='error',
                    meta={'provider': 'trellis', 'error': str(e)[:300]},
                )

    if not result:
        log("[generate] No mesh produced for order", level='error', order_id=order_id)
        return None

    ext, content = result
    orig_ext = ext.lower()
    converted = False
    # Always prefer returning STL so the viewer has a guaranteed renderable format
    if orig_ext != "stl":
        try:
            stl_try = _convert_mesh_bytes_to_stl(content, ext)
        except Exception:
            stl_try = None
        if not stl_try:
            # Fallback to Blender CLI if available
            import tempfile
            with tempfile.TemporaryDirectory() as _td:
                src_path = os.path.join(_td, f"in.{ext}")
                dst_path = os.path.join(_td, "out.stl")
                try:
                    with open(src_path, "wb") as f:
                        f.write(content)
                    if _blender_convert_to_stl(src_path, dst_path) and os.path.exists(dst_path):
                        with open(dst_path, "rb") as f:
                            stl_try = f.read()
                except Exception:
                    stl_try = None
        if stl_try:
            ext = "stl"
            content = stl_try
            converted = True
        else:
            log(f"[generate] STL conversion unavailable; keeping original {orig_ext} output")
    sha = sha256_bytes(content)
    # Store under <orderId>/file in the bucket (no leading bucket segment)
    path = f"{order_id}/{sha}.{ext}"
    ctype = {
        "stl": "model/stl",
        "obj": "model/obj",
        "glb": "model/gltf-binary",
        "gltf": "model/gltf+json",
    }.get(ext, "application/octet-stream")
    url = storage_upload_bytes(STORAGE_BUCKET, path, content, content_type=ctype)
    if converted:
        log(f"[generate] converted {orig_ext} → stl for order {order_id}", order_id=order_id)
    log(f"[generate] stored raw_{ext} asset at {url}")
    return f"raw_{ext}", url

def _blender_convert_to_stl(src_path: str, dst_path: str) -> bool:
    blender = os.getenv("BLENDER_CLI", "blender")
    if not shutil.which(blender):
        log("[blender] CLI not found; cannot convert to STL")
        return False
    script = f"""
import bpy
import sys
src = r"{src_path}"
dst = r"{dst_path}"
# Clean scene
for obj in bpy.data.objects:
    bpy.data.objects.remove(obj, do_unlink=True)
# Import
ext = src.split('.')[-1].lower()
if ext in ('obj',):
    bpy.ops.import_scene.obj(filepath=src)
elif ext in ('stl',):
    bpy.ops.import_mesh.stl(filepath=src)
elif ext in ('glb','gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
else:
    raise RuntimeError('unsupported input ext: ' + ext)
# Ensure mm preview units (for consistent viewport behavior)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 0.001

# If source is glTF/GLB (meters), convert geometry to millimeters explicitly.
from mathutils import Vector
def _scene_bounds():
    try:
        import math
        bbmin = Vector((1e9,1e9,1e9)); bbmax = Vector((-1e9,-1e9,-1e9))
        for o in bpy.context.scene.objects:
            if not hasattr(o, 'bound_box'):
                continue
            for c in o.bound_box:
                wc = o.matrix_world @ Vector(c)
                bbmin.x=min(bbmin.x,wc.x); bbmin.y=min(bbmin.y,wc.y); bbmin.z=min(bbmin.z,wc.z)
                bbmax.x=max(bbmax.x,wc.x); bbmax.y=max(bbmax.y,wc.y); bbmax.z=max(bbmax.z,wc.z)
        return (bbmin, bbmax)
    except Exception:
        return None

if ext in ('glb','gltf'):
    # Scale up by 1000 (m -> mm) at geometry level
    for o in list(bpy.context.scene.objects):
        try:
            o.scale = (o.scale[0]*1000.0, o.scale[1]*1000.0, o.scale[2]*1000.0)
        except Exception:
            pass
    bpy.context.view_layer.update()
elif ext in ('obj',):
    # Heuristic: if tiny (<2 units), likely meters -> scale to mm
    b = _scene_bounds()
    try:
        if b is not None:
            bbmin, bbmax = b
            sx = bbmax.x - bbmin.x; sy = bbmax.y - bbmin.y; sz = bbmax.z - bbmin.z
            if max(sx, sy, sz) > 0 and max(sx, sy, sz) < 2.0:
                for o in list(bpy.context.scene.objects):
                    try:
                        o.scale = (o.scale[0]*1000.0, o.scale[1]*1000.0, o.scale[2]*1000.0)
                    except Exception:
                        pass
                bpy.context.view_layer.update()
    except Exception:
        pass

# Select all and export STL
for o in bpy.data.objects:
    o.select_set(True)
bpy.ops.export_mesh.stl(filepath=dst, use_selection=True)
"""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(script)
        script_path = f.name
    try:
        cmd = f"{blender} -b -P {shlex.quote(script_path)}"
        code, out, err = _run(cmd, timeout_sec=600)
        if code != 0:
            log(f"[blender] convert failed (code {code}): {(err or out)[:200]}")
            return False
        ok = os.path.exists(dst_path)
        if not ok:
            log(f"[blender] convert succeeded but {dst_path} missing")
        return ok
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass

def _run_meshfix(src: str, dst: str) -> Tuple[bool, str]:
    exe = shutil.which("meshfix")
    if not exe:
        return False, "meshfix not found"
    code, out, err = _run(f"{exe} {shlex.quote(src)} {shlex.quote(dst)}", timeout_sec=300)
    ok = code == 0 and os.path.exists(dst)
    return ok, (err or out)


def _run_admesh_repair(src: str, dst: str) -> Tuple[bool, str]:
    """Run ADMesh to repair an STL and write a new binary STL.

    ADMesh 0.98.x on Debian/Ubuntu repairs on write; there is no `--repair`
    flag. The correct invocation is:
        admesh <src> --write-binary-stl=<dst>
    """
    exe = shutil.which("admesh")
    if not exe:
        return False, "admesh not found"
    # Order: file first, then write option; both orders generally work, but
    # keep file first for widest compatibility.
    cmd = f"{exe} {shlex.quote(src)} --write-binary-stl={shlex.quote(dst)}"
    code, out, err = _run(cmd, timeout_sec=300)
    ok = code == 0 and os.path.exists(dst)
    return ok, (err or out)


def _blender_solidify(src_path: str, dst_path: str, thickness_mm: float = 1.6) -> Tuple[bool, str]:
    blender = os.getenv("BLENDER_CLI", "blender")
    if not shutil.which(blender):
        return False, "blender not found"
    script = f"""
import bpy
import sys
src = r"{src_path}"
dst = r"{dst_path}"
for obj in bpy.data.objects:
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.import_mesh.stl(filepath=src)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 0.001
objs = list(bpy.context.selectable_objects)
for o in objs:
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    mod = o.modifiers.new(name='Solidify', type='SOLIDIFY')
    mod.thickness = {thickness_mm} / 1000.0
    bpy.ops.object.modifier_apply(modifier=mod.name)
for o in objs:
    o.select_set(True)
bpy.ops.export_mesh.stl(filepath=dst, use_selection=True)
"""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(script)
        script_path = f.name
    try:
        code, out, err = _run(f"{blender} -b -P {shlex.quote(script_path)}", timeout_sec=900)
        ok = code == 0 and os.path.exists(dst_path)
        return ok, (err or out)
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass


def _blender_orient_and_clamp(src_path: str, dst_path: str, force_contact: bool = False, trim_override_mm: Optional[float] = None) -> Tuple[bool, str, Dict[str, Any]]:
    """Orient mesh to a flat base, ensure first-layer contact, and clamp to build volume.

    Returns (ok, log, meta) where meta includes contact metrics and any auto fixes.
    """
    blender = os.getenv("BLENDER_CLI", "blender")
    if not shutil.which(blender):
        return False, "blender not found", {}
    bx = float(os.getenv("BUILD_VOLUME_X_MM", "256"))
    by = float(os.getenv("BUILD_VOLUME_Y_MM", "256"))
    bz = float(os.getenv("BUILD_VOLUME_Z_MM", "256"))
    margin = float(os.getenv("BUILD_VOLUME_MARGIN_MM", "2"))
    script_template = Template("""
import bpy, math, json, bmesh
from mathutils import Vector
from mathutils import geometry as geom
import os as _os

SRC = r"$SRC"
DST = r"$DST"
BUILD_X, BUILD_Y, BUILD_Z = $BX, $BY, $BZ
MARGIN = $MARGIN
BUILD_X_M = BUILD_X / 1000.0
BUILD_Y_M = BUILD_Y / 1000.0
BUILD_Z_M = BUILD_Z / 1000.0
MARGIN_M = MARGIN / 1000.0
FORCE_CONTACT = $FORCE
TRIM_OVERRIDE = $TRIM

def _float_env(name, default):
    try:
        raw = (_os.getenv(name) or "").strip()
        return float(raw) if raw else float(default)
    except Exception:
        return float(default)

def _int_env(name, default):
    try:
        raw = (_os.getenv(name) or "").strip()
        return int(float(raw)) if raw else int(default)
    except Exception:
        return int(default)

tol_mm = _float_env('BASE_CONTACT_TOLERANCE_MM', 0.15)
min_area = _float_env('BASE_CONTACT_MIN_AREA_MM2', 30.0)
min_vertices = _int_env('BASE_CONTACT_MIN_VERTS', 12)
base_trim_mm = TRIM_OVERRIDE if TRIM_OVERRIDE is not None else _float_env('BASE_TRIM_MM', 0.35)
solidify_enable = (_os.getenv('BASE_SOLIDIFY_ENABLE') or '1').lower() in ('1','true','yes')
solidify_thickness = _float_env('BASE_SOLIDIFY_THICKNESS_MM', _float_env('REPAIR_SOLIDIFY_THICKNESS_MM', 1.6))

meta = {
    'base_contact_tolerance_mm': tol_mm,
    'base_contact_min_area_mm2': min_area,
    'base_contact_min_vertices': min_vertices,
    'auto_trim_mm': 0.0,
    'auto_solidify': False,
    'force_contact': bool(FORCE_CONTACT),
}

# Reset scene
for obj in bpy.data.objects:
    bpy.data.objects.remove(obj, do_unlink=True)

# Import STL
bpy.ops.import_mesh.stl(filepath=SRC)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 0.001

# Join all meshes into one
objs = [o for o in bpy.context.scene.objects if o.type == 'MESH']
bpy.ops.object.select_all(action='DESELECT')
for o in objs:
    o.select_set(True)
bpy.context.view_layer.objects.active = objs[0]
bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active

# Capture initial bounding box dimensions (in Blender units -> mm via scale_length)
bpy.context.view_layer.update()
bb_init = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
minx = min(v.x for v in bb_init); maxx = max(v.x for v in bb_init)
miny = min(v.y for v in bb_init); maxy = max(v.y for v in bb_init)
minz = min(v.z for v in bb_init); maxz = max(v.z for v in bb_init)
dimx = maxx - minx; dimy = maxy - miny; dimz = maxz - minz
meta['original_bbox_mm'] = {
    'x': dimx * 1000.0,
    'y': dimy * 1000.0,
    'z': dimz * 1000.0,
}

# If the raw mesh exceeds the build volume by a large margin, scale it down early
target_cap_mm = max(1.0, min(BUILD_X, BUILD_Y, BUILD_Z) - (MARGIN * 2.0))
target_cap = max(0.001, target_cap_mm / 1000.0)
max_dim = max(dimx, dimy, dimz)
if max_dim > target_cap and max_dim > 1e-9:
    scale_factor = target_cap / max_dim
    obj.scale = (obj.scale[0] * scale_factor, obj.scale[1] * scale_factor, obj.scale[2] * scale_factor)
    bpy.context.view_layer.update()
    bb_init = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minx = min(v.x for v in bb_init); maxx = max(v.x for v in bb_init)
    miny = min(v.y for v in bb_init); maxy = max(v.y for v in bb_init)
    minz = min(v.z for v in bb_init); maxz = max(v.z for v in bb_init)
    dimx = maxx - minx; dimy = maxy - miny; dimz = maxz - minz
    meta['scaled_down_factor'] = scale_factor
    meta['scaled_bbox_mm'] = {
        'x': dimx * 1000.0,
        'y': dimy * 1000.0,
        'z': dimz * 1000.0,
    }

dims_sorted = sorted([dimx, dimy, dimz])
slender_ratio = dims_sorted[-1] / max(dims_sorted[0], 1e-6)
meta['slender_ratio'] = slender_ratio
if slender_ratio >= _float_env('SLENDER_RATIO_THRESHOLD', 5.0):
    base_trim_mm = 0.0
    solidify_enable = False
    min_area = min(min_area, 8.0)
    meta['slender_override'] = True
    meta['base_contact_min_area_mm2'] = min_area
meta['base_trim_mm_effective'] = base_trim_mm
meta['solidify_enabled'] = bool(solidify_enable)

def _merge_close(o):
    try:
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.mesh.remove_doubles(threshold=0.0001)
        try:
            bpy.ops.mesh.merge_by_distance(distance=0.1/1000.0)
        except Exception:
            pass
    except Exception:
        pass
    finally:
        try:
            bpy.ops.object.mode_set(mode='OBJECT')
        except Exception:
            pass

def _center_xy(o):
    bb = [o.matrix_world @ Vector(corner) for corner in o.bound_box]
    minx = min(v.x for v in bb); maxx = max(v.x for v in bb)
    miny = min(v.y for v in bb); maxy = max(v.y for v in bb)
    cx = (minx + maxx) / 2.0
    cy = (miny + maxy) / 2.0
    o.location.x -= cx
    o.location.y -= cy
    bpy.context.view_layer.update()

def _seat_z(o):
    bb = [o.matrix_world @ Vector(corner) for corner in o.bound_box]
    minz = min(v.z for v in bb)
    o.location.z -= minz
    bpy.context.view_layer.update()

def _center_and_seat(o):
    _center_xy(o)
    _seat_z(o)

def _base_metrics(o):
    verts_world = [o.matrix_world @ v.co for v in o.data.vertices]
    if not verts_world:
        return {'area_mm2': 0.0, 'contact_vertices': 0, 'min_z_mm': 0.0}
    minz = min(v.z for v in verts_world)
    tol = tol_mm / 1000.0
    contact_idx = [i for i, vw in enumerate(verts_world) if (vw.z - minz) <= tol]
    area = 0.0
    for poly in o.data.polygons:
        pts = [verts_world[idx] for idx in poly.vertices]
        if not pts:
            continue
        if min(p.z for p in pts) - minz > tol:
            continue
        if len(pts) == 3:
            area += (pts[1] - pts[0]).cross(pts[2] - pts[0]).length / 2.0
        else:
            try:
                for tri in geom.tessellate_polygon([pts]):
                    p0, p1, p2 = (pts[i] for i in tri)
                    area += (p1 - p0).cross(p2 - p0).length / 2.0
            except Exception:
                pass
    return {
        'area_mm2': area * 1_000_000.0,
        'contact_vertices': len(contact_idx),
        'min_z_mm': minz * 1000.0,
    }

def _gather_components(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bm.verts.ensure_lookup_table()
    visited = set()
    comps = []
    for v in bm.verts:
        if v.index in visited:
            continue
        stack = [v]
        visited.add(v.index)
        idxs = []
        minz = 1e9
        maxz = -1e9
        while stack:
            cur = stack.pop()
            idxs.append(cur.index)
            co = o.matrix_world @ cur.co
            if co.z < minz:
                minz = co.z
            if co.z > maxz:
                maxz = co.z
            for e in cur.link_edges:
                other = e.other_vert(cur)
                if other and other.index not in visited:
                    visited.add(other.index)
                    stack.append(other)
        comps.append({'min_z': minz, 'max_z': maxz, 'count': len(idxs), 'indices': idxs})
    bm.free()
    return comps

def _apply_trim(o, trim_mm):
    if trim_mm <= 0:
        return False
    z_plane = trim_mm / 1000.0
    bpy.context.view_layer.objects.active = o
    # Delete everything that falls below the trim plane using a bisect cut.
    try:
        bpy.ops.object.mode_set(mode='OBJECT')
    except Exception:
        pass
    bm = bmesh.new()
    try:
        bm.from_mesh(o.data)
        geom = bm.faces[:] + bm.edges[:] + bm.verts[:]
        plane_co = Vector((0.0, 0.0, z_plane))
        # Clear the volume on the negative-Z side so the base becomes perfectly flat.
        bmesh.ops.bisect_plane(
            bm,
            geom=geom,
            plane_co=plane_co,
            plane_no=Vector((0.0, 0.0, -1.0)),
            clear_outer=True,
            clear_inner=False,
        )
        bm.to_mesh(o.data)
    finally:
        bm.free()
    bpy.context.view_layer.update()
    return True

def _apply_solidify(o, thickness_mm):
    mod = o.modifiers.new(name='AutoSolidify', type='SOLIDIFY')
    mod.thickness = thickness_mm / 1000.0
    try:
        mod.offset = 1.0
    except Exception:
        pass
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)

_merge_close(obj)

# Apply overrides or heuristics for rotation
override = _os.getenv('ORIENT_OVERRIDE_EULER_DEG')
cands = []
if override:
    try:
        parts = [float(p.strip()) for p in override.split(',') if p.strip()]
        if len(parts) == 3:
            obj.rotation_euler = tuple(math.radians(p) for p in parts)
            bpy.context.view_layer.update()
        else:
            cands = []
    except Exception:
        cands = []
if not override:
    force_upright = (_os.getenv('ORIENT_FORCE_UPRIGHT') or '0').lower() in ('1','true','yes')
    cands = [
        (0,0,0),
        (math.pi/2,0,0),(-math.pi/2,0,0),
        (0,math.pi/2,0),(0,-math.pi/2,0),
        (0,0,math.pi/2),(0,0,-math.pi/2),
    ]
    best = (0,0,0)
    best_score = -1e18
    for rx,ry,rz in cands:
        obj.rotation_euler = (rx,ry,rz)
        bpy.context.view_layer.update()
        bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        minx=min(v.x for v in bb); maxx=max(v.x for v in bb)
        miny=min(v.y for v in bb); maxy=max(v.y for v in bb)
        minz=min(v.z for v in bb); maxz=max(v.z for v in bb)
        dx=(maxx-minx); dy=(maxy-miny); dz=(maxz-minz)
        xy_area = dx * dy
        verts = [obj.matrix_world @ v.co for v in obj.data.vertices]
        vminz = min(v.z for v in verts) if verts else minz
        eps = 0.2
        contact = sum(1 for v in verts if (v.z - vminz) <= eps)
        dims = sorted([dx,dy,dz])
        slender = (dims[2] / max(1e-6, dims[0])) >= 1.35
        z_is_longest = (dz >= dx and dz >= dy)
        upright_bonus = 5000.0 if (slender and z_is_longest) or (force_upright and z_is_longest) else 0.0
        score = upright_bonus + (contact * 5.0) + (xy_area * 0.001)
        if score > best_score:
            best_score = score
            best = (rx,ry,rz)
    obj.rotation_euler = best
    bpy.context.view_layer.update()

_center_and_seat(obj)
metrics = _base_metrics(obj)
meta['base_contact_area_before_mm2'] = metrics['area_mm2']
meta['base_contact_vertices_before'] = metrics['contact_vertices']

def _needs_contact_fix(m):
    return bool(FORCE_CONTACT) or m['area_mm2'] < min_area or m['contact_vertices'] < min_vertices

if _needs_contact_fix(metrics) and base_trim_mm > 0:
    try:
        if _apply_trim(obj, base_trim_mm):
            meta['auto_trim_mm'] = base_trim_mm
            _center_and_seat(obj)
            metrics = _base_metrics(obj)
    except Exception:
        pass

if _needs_contact_fix(metrics) and solidify_enable:
    try:
        _apply_solidify(obj, solidify_thickness)
        meta['auto_solidify'] = True
        _center_and_seat(obj)
        metrics = _base_metrics(obj)
    except Exception:
        pass

_center_and_seat(obj)
metrics = _base_metrics(obj)
meta['base_contact_area_mm2'] = metrics['area_mm2']
meta['base_contact_vertices'] = metrics['contact_vertices']

components = _gather_components(obj)
floating = []
comp_entries = []
max_float_verts = _int_env('FLOAT_COMPONENT_MAX_VERTS', 1200)
tol_z = (tol_mm / 1000.0) + 1e-6
for comp in components:
    entry = {
        'min_z_mm': comp['min_z'] * 1000.0,
        'max_z_mm': comp['max_z'] * 1000.0,
        'vertex_count': comp['count'],
    }
    comp_entries.append(entry)
    if comp['min_z'] > tol_z:
        floating.append(entry)
meta['component_count'] = len(comp_entries)
meta['floating_component_count'] = len(floating)
meta['floating_component_vertices'] = sum((c['vertex_count'] for c in floating), 0)
meta['components'] = comp_entries[:16]
meta['floating_components'] = floating[:16]

if floating:
    idx_delete = set()
    for comp in components:
        if comp['min_z'] > tol_z and comp['count'] <= max_float_verts:
            idx_delete.update(comp['indices'])
    if idx_delete:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bm.verts.ensure_lookup_table()
        verts_to_delete = [bm.verts[i] for i in idx_delete if i < len(bm.verts)]
        if verts_to_delete:
            bmesh.ops.delete(bm, geom=verts_to_delete, context='VERTS')
            bm.to_mesh(obj.data)
            meta['floating_components_removed'] = len(idx_delete)
        bm.free()
        bpy.context.view_layer.update()
        _center_and_seat(obj)
        metrics = _base_metrics(obj)
        meta['base_contact_area_mm2'] = metrics['area_mm2']
        meta['base_contact_vertices'] = metrics['contact_vertices']
        components = _gather_components(obj)
        floating = []
        comp_entries = []
        for comp in components:
            entry = {
                'min_z_mm': comp['min_z'] * 1000.0,
                'max_z_mm': comp['max_z'] * 1000.0,
                'vertex_count': comp['count'],
            }
            comp_entries.append(entry)
            if comp['min_z'] > tol_z:
                floating.append(entry)
        meta['component_count'] = len(comp_entries)
        meta['floating_component_count'] = len(floating)
        meta['floating_component_vertices'] = sum((c['vertex_count'] for c in floating), 0)
        meta['components'] = comp_entries[:16]
        meta['floating_components'] = floating[:16]

# Clamp to build volume and optional size targets
bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
minx=min(v.x for v in bb); maxx=max(v.x for v in bb)
miny=min(v.y for v in bb); maxy=max(v.y for v in bb)
minz=min(v.z for v in bb); maxz=max(v.z for v in bb)

try:
    dimsx = (maxx - minx); dimsy = (maxy - miny); dimsz = (maxz - minz)
    cur_max = max(dimsx, dimsy, dimsz)
    t_env = _os.getenv('TARGET_MODEL_MAX_DIM_MM')
    if t_env:
        target = float(t_env) / 1000.0
        if cur_max > 0 and target > 0:
            s = target / cur_max
            obj.scale *= s
            bpy.context.view_layer.update()
            bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
            minx=min(v.x for v in bb); maxx=max(v.x for v in bb)
            miny=min(v.y for v in bb); maxy=max(v.y for v in bb)
            minz=min(v.z for v in bb); maxz=max(v.z for v in bb)
    else:
        target = float(_os.getenv('DEFAULT_MODEL_MAX_DIM_MM', '120')) / 1000.0
        if cur_max > 0 and cur_max < target:
            scale_up = target / cur_max
            obj.scale *= scale_up
            bpy.context.view_layer.update()
            bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
            minx=min(v.x for v in bb); maxx=max(v.x for v in bb)
            miny=min(v.y for v in bb); maxy=max(v.y for v in bb)
            minz=min(v.z for v in bb); maxz=max(v.z for v in bb)
except Exception:
    pass

sx = max(BUILD_X_M - MARGIN_M, 1e-6) / max(1e-9, (maxx - minx))
sy = max(BUILD_Y_M - MARGIN_M, 1e-6) / max(1e-9, (maxy - miny))
sz = max(BUILD_Z_M - MARGIN_M, 1e-6) / max(1e-9, (maxz - minz))
s = min(1.0, sx, sy, sz)
obj.scale *= s
bpy.context.view_layer.objects.active = obj
bpy.context.view_layer.update()
_center_and_seat(obj)

bb = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
minx=min(v.x for v in bb); maxx=max(v.x for v in bb)
miny=min(v.y for v in bb); maxy=max(v.y for v in bb)
minz=min(v.z for v in bb); maxz=max(v.z for v in bb)
meta['bbox_mm'] = {
    'x': (maxx - minx) * 1000.0,
    'y': (maxy - miny) * 1000.0,
    'z': (maxz - minz) * 1000.0,
}

bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
# Export in millimetres by temporarily scaling the mesh ×1000.
orig_scale = obj.scale.copy()
obj.scale = (orig_scale[0] * 1000.0, orig_scale[1] * 1000.0, orig_scale[2] * 1000.0)
bpy.context.view_layer.update()
bpy.ops.export_mesh.stl(filepath=DST, use_selection=True)
# Restore original scale for any downstream steps.
obj.scale = orig_scale
bpy.context.view_layer.update()

print("__ORIENT_META__" + json.dumps(meta))
""")
    script = script_template.substitute(
        SRC=src_path,
        DST=dst_path,
        BX=bx,
        BY=by,
        BZ=bz,
        MARGIN=margin,
        FORCE=(1 if force_contact else 0),
        TRIM=("None" if trim_override_mm is None else trim_override_mm),
    )
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(script)
        script_path = f.name
    try:
        code, out, err = _run(f"{blender} -b -P {shlex.quote(script_path)}", timeout_sec=900)
        meta = {}
        for chunk in (out, err):
            for line in (chunk or "").splitlines():
                if line.startswith("__ORIENT_META__"):
                    try:
                        meta = json.loads(line.split("__ORIENT_META__", 1)[1])
                    except Exception:
                        meta = {}
        ok = code == 0 and os.path.exists(dst_path)
        return ok, (err or out), meta
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass

def _blender_render_preview(src_path: str, dst_path: str, width: int = 768, height: int = 768) -> Tuple[bool, str]:
    """Render a simple neutral preview PNG of an STL using Blender CLI.
    Returns (ok, log). Safe no-op if blender is unavailable.
    """
    blender = os.getenv("BLENDER_CLI", "blender")
    if not shutil.which(blender):
        return False, "blender not found"
    script = f"""
import bpy
import math
src = r"{src_path}"
dst = r"{dst_path}"

# Reset scene
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)

# Camera
cam_data = bpy.data.cameras.new('Cam')
cam = bpy.data.objects.new('Cam', cam_data)
bpy.context.collection.objects.link(cam)
bpy.context.scene.camera = cam

# Light
light_data = bpy.data.lights.new(name="key", type='AREA')
light_data.energy = 1000
key = bpy.data.objects.new(name="key", object_data=light_data)
key.location = (300, 300, 400)
bpy.context.collection.objects.link(key)

# Import STL and set mm units
bpy.ops.import_mesh.stl(filepath=src)
bpy.context.scene.unit_settings.system = 'METRIC'
bpy.context.scene.unit_settings.scale_length = 0.001
obj = [o for o in bpy.context.scene.objects if o.type=='MESH'][0]

# Center and seat to bed (Z=Y in our viewer; keep Blender Z-up)
bb = obj.bound_box
import mathutils
world = obj.matrix_world
mins = mathutils.Vector((min([ (world@mathutils.Vector(c)).x for c in bb ]), min([ (world@mathutils.Vector(c)).y for c in bb ]), min([ (world@mathutils.Vector(c)).z for c in bb ])))
maxs = mathutils.Vector((max([ (world@mathutils.Vector(c)).x for c in bb ]), max([ (world@mathutils.Vector(c)).y for c in bb ]), max([ (world@mathutils.Vector(c)).z for c in bb ])))
cx = (mins.x+maxs.x)/2.0; cy = (mins.y+maxs.y)/2.0
obj.location.x -= cx
obj.location.y -= cy
obj.location.z -= mins.z
bpy.context.view_layer.update()

# Frame camera
bb2 = obj.bound_box
mins2 = mathutils.Vector((min([v[0] for v in bb2]), min([v[1] for v in bb2]), min([v[2] for v in bb2])))
maxs2 = mathutils.Vector((max([v[0] for v in bb2]), max([v[1] for v in bb2]), max([v[2] for v in bb2])))
dx = maxs2.x - mins2.x; dy = maxs2.y - mins2.y; dz = maxs2.z - mins2.z
maxdim = max(dx, dy, dz)
dist = maxdim * 2.2
cam.location = (dist, dist*0.9, dist)
cam.rotation_euler = (math.radians(60), 0, math.radians(45))

# World and render
bpy.context.scene.render.engine = 'BLENDER_EEVEE'
bpy.context.scene.render.image_settings.file_format = 'PNG'
bpy.context.scene.render.resolution_x = {width}
bpy.context.scene.render.resolution_y = {height}
bpy.context.scene.render.film_transparent = False
bpy.context.scene.world = bpy.data.worlds.new("World")
bpy.context.scene.world.color = (0.15,0.15,0.15,1)

bpy.ops.render.render(write_still=False)
bpy.data.images['Render Result'].save_render(filepath=dst)
"""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(script)
        script_path = f.name
    try:
        code, out, err = _run(f"{blender} -b -P {shlex.quote(script_path)}", timeout_sec=600)
        ok = code == 0 and os.path.exists(dst_path)
        return ok, (err or out)
    finally:
        try:
            os.unlink(script_path)
        except Exception:
            pass


def _ensure_stl_bytes_from_url(url: str) -> Optional[bytes]:
    log(f"[_ensure_stl] download {url}")
    try:
        b = download_bytes(url)
        log(f"[_ensure_stl] downloaded {len(b)} bytes")
    except Exception as e:
        log(f"Download failed: {e}")
        return None
    if url.lower().endswith('.stl') or _looks_like_binary_stl(b):
        if not url.lower().endswith('.stl'):
            log("[_ensure_stl] detected binary STL payload despite extension")
        return b
    import tempfile
    ext = 'obj'
    if url.lower().endswith('.obj'): ext = 'obj'
    elif url.lower().endswith('.glb'): ext = 'glb'
    elif url.lower().endswith('.gltf'): ext = 'gltf'
    else:
        ext = _guess_ext_from_content(b, fallback='obj')
    # Try pure-Python conversion first (no Blender dependency)
    try:
        stl = _convert_mesh_bytes_to_stl(b, ext)
        if stl:
            log(f"[_ensure_stl] pure-python conversion succeeded ({len(stl)} bytes)")
            return stl
    except Exception as e:
        log(f"[_ensure_stl] pure-python conversion error: {e}")
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, f"raw.{ext}")
        with open(src, 'wb') as f:
            f.write(b)
        dst = os.path.join(td, "converted.stl")
        ok = _blender_convert_to_stl(src, dst)
        if not ok:
            log("[_ensure_stl] Blender conversion failed")
            return None
        with open(dst, 'rb') as f:
            out = f.read()
            log(f"[_ensure_stl] Blender conversion produced {len(out)} bytes")
            return out


def _repair_stl_bytes(stl_bytes: bytes, order: Optional[Dict[str, Any]] = None) -> Tuple[bytes, Dict[str, Any]]:
    import tempfile
    meta: Dict[str, Any] = {"meshfix": None, "admesh": None, "solidify": None, "orient_clamp": None}
    with tempfile.TemporaryDirectory() as td:
        src = os.path.join(td, "in.stl")
        out1 = os.path.join(td, "out1.stl")
        out2 = os.path.join(td, "out2.stl")
        with open(src, 'wb') as f:
            f.write(stl_bytes)
        ok, logtxt = _run_meshfix(src, out1)
        meta["meshfix"] = {"ok": ok, "log": (logtxt or '')[:500]}
        cur = out1 if ok else src
        ok2, logtxt2 = _run_admesh_repair(cur, out2)
        meta["admesh"] = {"ok": ok2, "log": (logtxt2 or '')[:500]}
        cur = out2 if ok2 else cur
        if os.getenv("REPAIR_SOLIDIFY", "0") in ("1", "true", "True"):
            out3 = os.path.join(td, "out3.stl")
            ok3, logtxt3 = _blender_solidify(cur, out3, thickness_mm=float(os.getenv("REPAIR_SOLIDIFY_THICKNESS_MM", "1.6")))
            meta["solidify"] = {"ok": ok3, "log": (logtxt3 or '')[:500]}
            cur = out3 if ok3 else cur
        # Auto-orient/base and clamp to volume
        out4 = os.path.join(td, "out4.stl")
        ok4, logtxt4, orient_meta = _blender_orient_and_clamp(cur, out4)
        orient_entry = {"ok": ok4, "log": (logtxt4 or '')[:500]}
        if orient_meta:
            orient_entry.update(orient_meta)
        final_path = cur
        final_bytes: Optional[bytes] = None
        if ok4 and os.path.exists(out4):
            with open(out4, 'rb') as of:
                out_bytes = of.read()
            face_count = _binary_stl_face_count(out_bytes)
            if not face_count:
                orient_entry['ok'] = False
                orient_entry['empty_after_orient'] = True
                log("[repair] orient/clamp produced empty STL; reverting to pre-orient mesh")
            else:
                orient_entry['face_count'] = int(face_count)
                meta["orient_clamp"] = orient_entry
                meta["orient_clamp_final"] = orient_entry
                final_bytes = out_bytes
                final_path = out4
        if "orient_clamp" not in meta:
            meta["orient_clamp"] = orient_entry
        if "orient_clamp_final" not in meta:
            meta["orient_clamp_final"] = meta.get("orient_clamp")

        # Targeted solidify for slender/figurine meshes that still lack contact.
        need_reinforce = _should_targeted_solidify(order, meta)
        if need_reinforce:
            out5 = os.path.join(td, "out5.stl")
            thickness = float(os.getenv("FIGURINE_SOLIDIFY_THICKNESS_MM", os.getenv("REPAIR_SOLIDIFY_THICKNESS_MM", "1.8")))
            ok5, logtxt5 = _blender_solidify(final_path, out5, thickness_mm=thickness)
            meta["figurine_solidify"] = {"ok": ok5, "log": (logtxt5 or '')[:500], "thickness_mm": thickness}
            if ok5 and os.path.exists(out5):
                final_path = out5
                # Re-orient to ensure new shell is seated; force contact and disable trimming to avoid thinning.
                out6 = os.path.join(td, "out6.stl")
                ok6, logtxt6, orient_meta2 = _blender_orient_and_clamp(final_path, out6, force_contact=True, trim_override_mm=0.0)
                orient_entry2 = {"ok": ok6, "log": (logtxt6 or '')[:500]}
                if orient_meta2:
                    orient_entry2.update(orient_meta2)
                if ok6 and os.path.exists(out6):
                    with open(out6, 'rb') as f6:
                        final_bytes = f6.read()
                    face_count2 = _binary_stl_face_count(final_bytes)
                    if face_count2:
                        orient_entry2['face_count'] = int(face_count2)
                    meta["orient_clamp_after_solidify"] = orient_entry2
                    meta["orient_clamp_final"] = orient_entry2
                    final_path = out6
                else:
                    meta["orient_clamp_after_solidify"] = orient_entry2
        if final_bytes is None:
            with open(final_path, 'rb') as f:
                final_bytes = f.read()
        return final_bytes, meta


def repair(order: Dict[str, Any], raw_url: str) -> Optional[Tuple[str, Dict[str, Any], bytes]]:
    log(f"[repair] fetching mesh from {raw_url}")
    stl_bytes = _ensure_stl_bytes_from_url(raw_url)
    if not stl_bytes:
        log("[repair] failed to obtain STL bytes from mesh source")
        return None
    log(f"[repair] obtained {len(stl_bytes)} bytes prior to repair")
    repaired_bytes, meta = _repair_stl_bytes(stl_bytes, order)
    log(f"[repair] repair pipeline yielded {len(repaired_bytes)} bytes")
    sha = sha256_bytes(repaired_bytes)
    # Upload repaired STL under <orderId>/file within the bucket
    path = f"{order['id']}/{sha}.stl"
    log(f"[repair] uploading repaired STL to {STORAGE_BUCKET}/{path}")
    url = storage_upload_bytes(STORAGE_BUCKET, path, repaired_bytes, content_type="model/stl")
    log(f"[repair] uploaded repaired STL to {url}")
    try:
        supabase_insert("order_events", {"order_id": order['id'], "phase": "repairing", "message": "Repair details", "meta_json": meta})
    except Exception:
        pass
    return url, meta, repaired_bytes


def _orient_summary(meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    summary: Dict[str, Any] = {}
    if not isinstance(meta, dict):
        return summary
    keys = (
        'base_contact_area_mm2',
        'base_contact_vertices',
        'base_contact_area_before_mm2',
        'base_contact_vertices_before',
        'floating_component_count',
        'floating_component_vertices',
        'component_count',
        'slender_ratio',
        'auto_trim_mm',
        'auto_solidify',
    )
    for k in keys:
        if k in meta:
            summary[k] = meta[k]
    if meta.get('floating_components'):
        summary['floating_components_preview'] = meta['floating_components'][:4]
    if meta.get('bbox_mm'):
        summary['bbox_mm'] = meta['bbox_mm']
    return summary


def validate_slice_bytes(order_id: str, stl_bytes: bytes) -> Dict[str, Any]:
    if not _env_bool('AUTO_SLICE_VALIDATE', True):
        return {'status': 'skipped'}
    if not BAMBU_CLI:
        return {'status': 'skipped', 'reason': 'cli_missing'}
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        stl_path = os.path.join(td, 'validate.stl')
        with open(stl_path, 'wb') as f:
            f.write(stl_bytes)
        try:
            three_mf, preview_png, minutes, grams = bambu_slice(stl_path, td)
            if not three_mf:
                return {'status': 'failed', 'error': 'slice_missing_output'}
            result: Dict[str, Any] = {'status': 'ok'}
            if minutes is not None:
                result['minutes'] = float(minutes)
            if grams is not None:
                result['grams'] = float(grams)
            return result
        except Exception as exc:
            return {'status': 'failed', 'error': str(exc)[:200]}


def auto_stabilize_mesh(order: Dict[str, Any], raw_kind: str, raw_url: str, raw_asset_rows: Optional[List[Dict[str, Any]]] = None, stage_label: Optional[str] = None) -> None:
    oid = order.get('id')
    if not oid:
        return
    if _skip_if_cancelled(oid, 'stabilize_mesh'):
        return
    raw_asset_id = None
    if raw_asset_rows and isinstance(raw_asset_rows, list):
        try:
            raw_asset_id = raw_asset_rows[0].get('id')
        except Exception:
            raw_asset_id = None
    thin_wall_detected = False
    thin_wall_reason: Optional[str] = None
    # Lifecycle authority must accept repair before repair work or artifact writes
    # begin. Let rejection/outage propagate so the caller can retry/reconcile.
    set_status(oid, 'repairing')
    order['status'] = 'repairing'
    try:
        supabase_insert(
            'chat_messages',
            {
                'order_id': oid,
                'role': 'assistant',
                'type': 'text',
                'content_json': {'text': 'Stabilizing the mesh — running repair passes for printability.'},
            },
        )
    except Exception:
        pass
    try:
        supabase_insert("order_events", {"order_id": oid, "phase": "stabilizing", "message": "Auto-stabilizing mesh"})
    except Exception:
        pass
    if _skip_if_cancelled(oid, 'repair_start'):
        return
    repair_out = repair(order, raw_url)
    if not repair_out:
        # A failed repair is not durably handled until the authoritative lifecycle
        # records it. Propagate transition outages rather than masking divergence.
        set_status(oid, 'repair_failed')
        try:
            supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "warning", "content_json": {"text": "Mesh repair failed. Please adjust the concept or upload a clean model."}})
        except Exception:
            pass
        return
    if _skip_if_cancelled(oid, 'post_repair'):
        return
    repaired_url, repair_meta, repaired_bytes = repair_out
    sha_repaired = sha256_bytes(repaired_bytes)
    orient_meta = {}
    if isinstance(repair_meta, dict):
        orient_meta = repair_meta.get('orient_clamp_final') or repair_meta.get('orient_clamp') or {}
    orient_summary = _orient_summary(orient_meta)
    asset_meta = {
        'source_asset_kind': raw_kind,
        'source_asset_id': raw_asset_id,
        'orientation': orient_summary,
    }
    if stage_label:
        asset_meta['materialize_stage'] = stage_label
    slice_check = validate_slice_bytes(oid, repaired_bytes)
    if slice_check:
        asset_meta['slice_check'] = slice_check
        status_lower = str(slice_check.get('status') or '').lower()
        error_text = str(slice_check.get('error') or '')
        if status_lower == 'failed':
            lowered = error_text.lower()
            if any(token in lowered for token in ('thin', 'wall', 'unit', 'scale')):
                thin_wall_detected = True
                thin_wall_reason = error_text or 'Slice validation failed due to thin walls or unit issues.'
    try:
        asset_meta['size_bytes'] = len(repaired_bytes)
    except Exception:
        pass
    repaired_rows = attach_asset(oid, 'repaired_stl', repaired_url, sha_repaired, asset_meta) or []
    repaired_asset_id = None
    if repaired_rows and isinstance(repaired_rows, list):
        repaired_asset_id = repaired_rows[0].get('id')
    if repaired_asset_id:
        try:
            merge_order_facts(oid, {'print_ready_asset_id': repaired_asset_id, 'active_mesh_asset_id': repaired_asset_id})
        except Exception:
            pass
    floating_count = 0
    try:
        floating_count = int(orient_meta.get('floating_component_count') or 0)
    except Exception:
        floating_count = 0
    if slice_check:
        try:
            status = str(slice_check.get('status') or '')
            phase = 'slice_check'
            msg = 'Print validation completed'
            if status == 'failed':
                phase = 'slice_check_failed'
                msg = 'Print validation failed'
            elif status == 'skipped':
                msg = 'Print validation skipped'
            supabase_insert('order_events', {'order_id': oid, 'phase': phase, 'message': msg, 'meta_json': slice_check})
        except Exception:
            pass
    set_status(oid, 'stl_ready')
    order['status'] = 'stl_ready'
    try:
        supabase_insert("order_events", {"order_id": oid, "phase": "stabilized", "message": "Mesh stabilized", "meta_json": {'floating_component_count': floating_count, 'orientation': orient_summary}})
    except Exception:
        pass
    parsed_repaired = parse_supabase_url(repaired_url)
    signed = repaired_url if not parsed_repaired else None
    expires_at: Optional[int] = None
    if parsed_repaired:
        expires_at = int(time.time() * 1000 + SIGNED_URL_TTL_MS)
        try:
            maybe_signed = storage_create_signed_url(*parsed_repaired)
            if maybe_signed:
                signed = maybe_signed
            else:
                expires_at = None
        except Exception:
            signed = None
            expires_at = None
    if signed:
        focus_payload: Dict[str, Any] = {
            'kind': 'stl',
            'url': signed,
            'asset_kind': 'repaired_stl',
            'orientation': orient_summary,
            'storage_url': repaired_url,
        }
        # Provide content hash so the client can route via the artifact gateway for robust CORS/tokened fetches
        try:
            from hashlib import sha256 as _h
            _sha = _h(repaired_bytes).hexdigest()
            if _sha:
                focus_payload['sha256'] = _sha
        except Exception:
            pass
        if expires_at is not None:
            focus_payload['expires_at'] = expires_at
        if repaired_asset_id:
            focus_payload['asset_id'] = repaired_asset_id
        try:
            supabase_insert('chat_messages', {'order_id': oid, 'role': 'assistant', 'type': 'viewer.focus', 'content_json': focus_payload})
        except Exception:
            pass
    try:
        summary_parts: List[str] = []
        if orient_summary:
            bbox = orient_summary.get('bbox_mm') if isinstance(orient_summary, dict) else None
            if isinstance(bbox, dict):
                try:
                    sx = float(bbox.get('x') or 0)
                    sy = float(bbox.get('y') or 0)
                    sz = float(bbox.get('z') or 0)
                    if sx and sy and sz:
                        summary_parts.append(f"Size {round(sx)} × {round(sy)} × {round(sz)} mm")
                except Exception:
                    pass
        try:
            summary_parts.append(f"File {round(len(repaired_bytes) / (1024 * 1024), 1)} MB")
        except Exception:
            pass
        if slice_check and isinstance(slice_check, dict):
            minutes = slice_check.get('minutes')
            grams = slice_check.get('grams')
            status = slice_check.get('status')
            if status == 'ok' and minutes is not None and grams is not None:
                summary_parts.append(f"Validation passed · {round(minutes)} min · {round(grams)} g")
        if floating_count:
            summary_parts.append(f"Floating regions flagged: {floating_count}")
        if summary_parts:
            record_order_event(
                oid,
                'repair_summary',
                'Mesh stabilized summary',
                meta={'details': summary_parts},
            )
    except Exception:
        pass
    if floating_count > 0:
        try:
            msg = 'Mesh stabilized, but floating regions remain. Review orientation or request supports.'
            supabase_insert('chat_messages', {'order_id': oid, 'role': 'assistant', 'type': 'warning', 'content_json': {'text': msg}})
        except Exception:
            pass

def _run(cmd: str, timeout_sec: int = 300) -> Tuple[int, str, str]:
    # Echo the exact command for observability
    try:
        print(f"[run] {cmd}", flush=True)
    except Exception:
        pass
    p = subprocess.Popen(shlex.split(cmd), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    started_at = time.time()
    rc: int
    try:
        out, err = p.communicate(timeout=timeout_sec)
        rc = p.returncode
    except subprocess.TimeoutExpired:
        p.kill()
        out, err = p.communicate()
        rc = 124
    duration = time.time() - started_at
    try:
        print(f"[run] done ({rc}) after {duration:.1f}s", flush=True)
    except Exception:
        pass
    return rc, out, err

def _is_wsl() -> bool:
    try:
        import platform
        rel = platform.release().lower()
        if 'microsoft' in rel:
            return True
        if os.getenv('WSL_DISTRO_NAME'):
            return True
    except Exception:
        pass
    return False

def _wslpath_win(path_linux: str) -> Optional[str]:
    try:
        code, out, err = _run(f"wslpath -w {shlex.quote(path_linux)}", timeout_sec=10)
        if code == 0:
            return out.strip().splitlines()[0]
    except Exception:
        pass
    return None

def parse_minutes_grams_from_text(text: str) -> Tuple[Optional[float], Optional[float]]:
    import re
    minutes = None
    grams = None
    # h:m:s or m:s
    hms = re.search(r"(\d+):(\d+):(\d+)", text)
    if hms:
        h, m, s = map(int, hms.groups())
        minutes = h * 60 + m + s / 60.0
    else:
        ms = re.search(r"(\d+):(\d+)", text)
        if ms:
            m, s = map(int, ms.groups())
            minutes = m + s / 60.0
    # textual hours/minutes
    if minutes is None:
        h = re.search(r"(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b", text, re.I)
        m = re.search(r"(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b", text, re.I)
        total = 0.0
        if h:
            total += float(h.group(1)) * 60.0
        if m:
            total += float(m.group(1))
        if total > 0:
            minutes = total
    # grams
    g1 = re.search(r"(\d+(?:\.\d+)?)\s*(?:g|gram|grams)\b", text, re.I)
    if g1:
        grams = float(g1.group(1))
    else:
        g2 = re.search(r"filament[^\n]*?(\d+(?:\.\d+)?)\s*g", text, re.I)
        if g2:
            grams = float(g2.group(1))
    return minutes, grams

def _parse_metrics_from_gcode_text(text: str) -> Tuple[Optional[float], Optional[float]]:
    """Parse minutes and grams from G-code header text and compute grams from
    length+diameter when grams are missing. Density can be provided via env FILAMENT_DENSITY_G_CM3.
    """
    import re, math
    minutes: Optional[float] = None
    grams: Optional[float] = None

    # Bambu Studio format: "; model printing time: 7h 31m 38s"
    m = re.search(r"model\s+printing\s+time\s*:\s*([\dhms\s:]+)", text, re.I)
    if not m:
        # Fallback: generic format "estimated printing time = ..."
        m = re.search(r"estimated\s+printing\s+time\s*=\s*([\dhms\s:]+)", text, re.I)
    raw = m.group(1).strip() if m else None
    if raw:
        h = re.search(r"(\d+)\s*h", raw)
        m2 = re.search(r"(\d+)\s*m", raw)
        s = re.search(r"(\d+)\s*s", raw)
        total = 0.0
        if h: total += float(h.group(1)) * 60.0
        if m2: total += float(m2.group(1))
        if s: total += float(s.group(1)) / 60.0
        if total == 0.0:
            hms = re.search(r"(\d+):(\d+):(\d+)", raw)
            if hms:
                hh, mm, ss = map(int, hms.groups())
                total = hh * 60 + mm + ss / 60.0
            else:
                ms = re.search(r"(\d+):(\d+)", raw)
                if ms:
                    mm, ss = map(int, ms.groups())
                    total = mm + ss / 60.0
        minutes = total or None

    # Bambu Studio format: "; total filament weight [g] : 268.76"
    g = re.search(r"total\s+filament\s+weight\s*\[g\]\s*:\s*([0-9]+(?:\.[0-9]+)?)", text, re.I)
    if not g:
        # Fallback: generic format "filament used [g] = ..."
        g = re.search(r"filament\s+used\s*\[?g\]?\s*=\s*([0-9]+(?:\.[0-9]+)?)", text, re.I)
    if g:
        grams = float(g.group(1))
        return minutes, grams
    # Compute grams from length/diameter/density
    mml = re.search(r"filament\s+used\s*\[?mm\]?\s*=\s*([0-9]+(?:\.[0-9]+)?)", text, re.I)
    d = re.search(r"filament\s+diameter\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*mm", text, re.I)
    if mml:
        mm_len = float(mml.group(1))
        dia = float(d.group(1)) if d else 1.75
        dens = float(os.getenv("FILAMENT_DENSITY_G_CM3", "1.24"))
        area = math.pi * (dia / 2.0) ** 2  # mm^2
        vol_mm3 = mm_len * area
        grams = (vol_mm3 / 1000.0) * dens
    return minutes, grams


def parse_metrics_from_3mf(path: str) -> Tuple[Optional[float], Optional[float]]:
    """Extract minutes and grams from Bambu 3MF slicedata.json.

    Bambu Studio writes prediction data to Metadata/slicedata.json inside the 3MF zip:
    - prediction.print_time (seconds) → minutes
    - prediction.used_filament (mm³) → grams (using PLA density 1.24 g/cm³)

    Falls back to generic JSON scanning and gcode parsing if slicedata.json is missing.
    """
    import zipfile, json, re
    minutes = None
    grams = None

    try:
        with zipfile.ZipFile(path, 'r') as zf:
            file_list = zf.namelist()
            log(f"[parse_3mf] Found {len(file_list)} files in 3MF")
            log(f"[parse_3mf] All files: {', '.join(file_list)}")

            # 1. Try explicit Metadata/slicedata.json first (Bambu standard)
            if 'Metadata/slicedata.json' in file_list:
                try:
                    with zf.open('Metadata/slicedata.json') as f:
                        data = json.load(f)

                    # Extract print_time (seconds → minutes)
                    if 'prediction' in data:
                        pred = data['prediction']
                        if 'print_time' in pred:
                            seconds = float(pred['print_time'])
                            minutes = seconds / 60.0
                            log(f"[parse_3mf] Extracted print_time: {seconds:.1f}s → {minutes:.1f} min")

                        # Extract used_filament (mm³ → grams, PLA density 1.24 g/cm³ = 0.00124 g/mm³)
                        if 'used_filament' in pred:
                            mm3 = float(pred['used_filament'])
                            grams = mm3 * 0.00124
                            log(f"[parse_3mf] Extracted used_filament: {mm3:.1f} mm³ → {grams:.1f} g")

                    if minutes and grams:
                        log(f"[parse_3mf] Success from slicedata.json: {minutes:.1f} min, {grams:.1f} g")
                        return minutes, grams
                    else:
                        log("[parse_3mf] slicedata.json exists but missing prediction data", level='warning')
                except Exception as e:
                    log(f"[parse_3mf] Failed to parse slicedata.json: {e}", level='warning')
            else:
                log("[parse_3mf] Metadata/slicedata.json not found, trying fallback methods", level='warning')

            # 2. Try Metadata/plate_1.json (alternative Bambu format)
            if (minutes is None or grams is None) and 'Metadata/plate_1.json' in file_list:
                try:
                    with zf.open('Metadata/plate_1.json') as f:
                        data = json.load(f)

                    log(f"[parse_3mf] Parsing plate_1.json, top keys: {list(data.keys())[:10]}")

                    # Common structures in plate_1.json:
                    # - "prediction" or "time_cost" or "print_time"
                    # - "filament_used_g" or "weight" or similar

                    # Extract time (try multiple paths)
                    if minutes is None:
                        for key_path in [
                            ['prediction', 'print_time'],
                            ['time_cost'],
                            ['print_time'],
                            ['estimated_time']
                        ]:
                            val = data
                            for k in key_path:
                                if isinstance(val, dict) and k in val:
                                    val = val[k]
                                else:
                                    val = None
                                    break
                            if isinstance(val, (int, float)):
                                seconds = float(val)
                                minutes = seconds / 60.0
                                log(f"[parse_3mf] Found time at {'.'.join(key_path)}: {seconds:.1f}s → {minutes:.1f} min")
                                break

                    # Extract weight (try multiple paths)
                    if grams is None:
                        for key_path in [
                            ['filament_used_g'],
                            ['weight'],
                            ['prediction', 'weight'],
                            ['prediction', 'filament_used_g']
                        ]:
                            val = data
                            for k in key_path:
                                if isinstance(val, dict) and k in val:
                                    val = val[k]
                                else:
                                    val = None
                                    break
                            if isinstance(val, (int, float)):
                                grams = float(val)
                                log(f"[parse_3mf] Found weight at {'.'.join(key_path)}: {grams:.1f} g")
                                break

                        # If weight is in array (multi-filament), sum it
                        if grams is None:
                            for key_path in [
                                ['filament_used_g'],
                                ['weight']
                            ]:
                                val = data
                                for k in key_path:
                                    if isinstance(val, dict) and k in val:
                                        val = val[k]
                                    else:
                                        val = None
                                        break
                                if isinstance(val, list) and all(isinstance(x, (int, float)) for x in val):
                                    grams = sum(float(x) for x in val)
                                    log(f"[parse_3mf] Found weight array at {'.'.join(key_path)}: {grams:.1f} g (summed)")
                                    break

                    if minutes and grams:
                        log(f"[parse_3mf] Success from plate_1.json: {minutes:.1f} min, {grams:.1f} g")
                        return minutes, grams
                except Exception as e:
                    log(f"[parse_3mf] Failed to parse plate_1.json: {e}", level='warning')

            # 3. Fallback: scan all JSON files for time/weight keys
            if minutes is None or grams is None:
                for name in file_list:
                    if not name.lower().endswith('.json'):
                        continue
                    try:
                        data = zf.read(name)
                        txt = data.decode('utf-8', errors='ignore')
                        obj = json.loads(txt)
                    except Exception:
                        continue
                    # recursive scan
                    stack = [obj]
                    while stack:
                        cur = stack.pop()
                        if isinstance(cur, dict):
                            for k, v in cur.items():
                                lk = str(k).lower()
                                if isinstance(v, (int, float)):
                                    if any(s in lk for s in ['hour','hr']):
                                        minutes = minutes or (float(v) * 60.0)
                                    elif any(s in lk for s in ['minute','min']):
                                        minutes = minutes or float(v)
                                    elif any(s in lk for s in ['second','sec']):
                                        minutes = minutes or (float(v) / 60.0)
                                    elif 'gram' in lk or 'weight' in lk or 'filament' in lk:
                                        grams = grams or float(v)
                                elif isinstance(v, (dict, list)):
                                    stack.append(v)
                        elif isinstance(cur, list):
                            stack.extend(cur)

                if minutes or grams:
                    log(f"[parse_3mf] Fallback JSON scan found: minutes={minutes}, grams={grams}")

            # 4. Fallback: parse any .gcode file within 3MF if present
            if minutes is None or grams is None:
                try:
                    gcode_name = next((n for n in file_list if n.lower().endswith('.gcode')), None)
                    if gcode_name:
                        log(f"[parse_3mf] Found gcode file: {gcode_name}")
                        gtxt = zf.read(gcode_name).decode('utf-8', errors='ignore')
                        # Log first 2000 chars of gcode header for debugging
                        header_preview = gtxt[:2000]
                        log(f"[parse_3mf] Gcode header preview (first 2000 chars):\n{header_preview}")
                        m3, g3 = _parse_metrics_from_gcode_text(gtxt)
                        minutes = minutes or m3
                        grams = grams or g3
                        if m3 or g3:
                            log(f"[parse_3mf] Fallback gcode parse found: minutes={m3}, grams={g3}")
                        else:
                            log(f"[parse_3mf] Gcode parser returned no metrics", level='warning')
                except Exception as e:
                    log(f"[parse_3mf] Gcode fallback failed: {e}", level='warning')

    except Exception as e:
        log(f"[parse_3mf] Failed to open/parse {path}: {e}", level='error')

    if minutes is None or grams is None:
        log(f"[parse_3mf] Final result: minutes={minutes}, grams={grams} (INCOMPLETE)", level='warning')
    else:
        log(f"[parse_3mf] Final result: {minutes:.1f} min, {grams:.1f} g")

    return minutes, grams

def bambu_slice(stl_path_local: str, out_dir: str, _retry: bool = False) -> Tuple[Optional[str], Optional[str], Optional[float], Optional[float]]:
    if not BAMBU_CLI:
        raise RuntimeError("BAMBU_STUDIO_CLI not set")
    three_mf = os.path.join(out_dir, "output.3mf")
    preview_png = os.path.join(out_dir, "preview.png")
    use_uptodate = bool(BAMBU_UPTODATE_SETTINGS)
    use_json_presets = (not use_uptodate) and bool(BAMBU_SETTINGS and BAMBU_FILAMENTS)

    # WSL bridge: if CLI is a Windows .exe or we are under WSL with a /mnt path CLI,
    # copy inputs to a shared Windows path and call the Windows CLI with Windows paths.
    use_wsl_bridge = False
    try:
        cli_lower = (BAMBU_CLI or '').lower()
        if _is_wsl() and (cli_lower.endswith('.exe') or cli_lower.startswith('/mnt/')):
            use_wsl_bridge = True
    except Exception:
        pass

    def _is_variant_error(rc: int, out: str, err: str) -> bool:
        if rc == 5:
            return True
        text = f"{out}\n{err}".lower()
        needles = (
            "printer_extruder_variant",
            "print_extruder_variant",
            "extruder_variant",
            "printer_extruder_id",
            "print_extruder_id",
            "nozzle",
        )
        return any(n in text for n in needles)

    def _is_empty_initial_layer(rc: int, out: str, err: str) -> bool:
        text = f"{out or ''}\n{err or ''}".lower()
        return "empty initial layer" in text or "empty first layer" in text

    if use_wsl_bridge:
        win_out_dir = os.getenv('WIN_OUT_DIR', '/mnt/c/PrintJobs')
        try:
            os.makedirs(win_out_dir, exist_ok=True)
        except Exception:
            # last-ditch fallback
            win_out_dir = '/mnt/c/PrintJobs'
            os.makedirs(win_out_dir, exist_ok=True)
        # Place STL into shared folder
        stl_shared = os.path.join(win_out_dir, 'model.stl')
        try:
            shutil.copy2(stl_path_local, stl_shared)
        except Exception:
            with open(stl_path_local, 'rb') as fsrc, open(stl_shared, 'wb') as fdst:
                fdst.write(fsrc.read())
        out_shared = os.path.join(win_out_dir, 'output.3mf')
        win_cli = BAMBU_CLI
        win_stl = _wslpath_win(stl_shared) or stl_shared
        win_out = _wslpath_win(out_shared) or out_shared

        if use_uptodate:
            # Prepare uptodate settings for Windows path(s)
            def ensure_win_path(src_path: str, dst_name: str) -> str:
                p = src_path
                if not os.path.isabs(p):
                    p = os.path.abspath(p)
                if not os.path.exists(p):
                    raise RuntimeError(f"Settings not found: {src_path}")
                if p.startswith('/mnt/'):
                    return _wslpath_win(p) or p
                dst = os.path.join(win_out_dir, dst_name)
                shutil.copy2(p, dst)
                return _wslpath_win(dst) or dst
            # Support multiple settings files separated by ';' or ','
            parts = [s.strip() for s in (BAMBU_UPTODATE_SETTINGS or '').replace(',', ';').split(';') if s.strip()]
            if not parts:
                raise RuntimeError("BAMBUSTUDIO_UPTODATE_SETTINGS_PATH is empty")
            win_settings_paths: List[str] = []
            for idx, sp in enumerate(parts):
                win_settings_paths.append(ensure_win_path(sp, f'settings_uptodate_{idx+1}.json'))
            win_upto = ';'.join(win_settings_paths)
            cmd = (
                f'"{win_cli}" --uptodate --uptodate-settings "{win_upto}" '
                f'--arrange 1 --load-defaultfila --slice 1 --export-3mf "{win_out}" "{win_stl}"'
            )
            code, out, err = _run(cmd, timeout_sec=600)
            # Fallback: export settings from locked 3MF then slice if variant error
            if code != 0 and _is_variant_error(code, out, err):
                profile_linux = BAMBU_PROFILE or os.path.join(os.path.dirname(__file__), '..', 'profiles', 'x1c_pla_024.3mf')
                if not os.path.isabs(profile_linux):
                    profile_linux = os.path.abspath(profile_linux)
                if not os.path.exists(profile_linux):
                    raise RuntimeError(f"Bambu CLI failed ({code}) and no profile set for fallback: {err or out}")
                # Ensure profile is readable by Windows
                if profile_linux.startswith('/mnt/'):
                    profile_shared = profile_linux
                else:
                    profile_shared = os.path.join(win_out_dir, 'profile.3mf')
                    shutil.copy2(profile_linux, profile_shared)
                win_profile = _wslpath_win(profile_shared) or profile_shared
                settings_json_shared = os.path.join(win_out_dir, 'settings_cli_recover.json')
                win_settings_json = _wslpath_win(settings_json_shared) or settings_json_shared
                cmd1 = f'"{win_cli}" --uptodate --export-settings "{win_settings_json}" "{win_profile}"'
                c1, o1, e1 = _run(cmd1, timeout_sec=600)
                if c1 != 0:
                    raise RuntimeError(f"Bambu CLI failed and fallback export failed: {e1 or o1}")
                cmd2 = f'"{win_cli}" --load-settings "{win_settings_json}" --slice 1 --export-3mf "{win_out}" "{win_stl}"'
                code, out, err = _run(cmd2, timeout_sec=600)
        elif use_json_presets:
            # Prepare JSON presets for Windows
            def ensure_win_path(src_path: str, dst_name: str) -> str:
                p = src_path
                if not os.path.isabs(p):
                    p = os.path.abspath(p)
                if not os.path.exists(p):
                    raise RuntimeError(f"Preset not found: {src_path}")
                if p.startswith('/mnt/'):
                    return _wslpath_win(p) or p
                dst = os.path.join(win_out_dir, dst_name)
                shutil.copy2(p, dst)
                return _wslpath_win(dst) or dst
            parts = [s.strip() for s in (BAMBU_SETTINGS or '').replace(',', ';').split(';') if s.strip()]
            win_settings = []
            for idx, sp in enumerate(parts):
                win_settings.append(ensure_win_path(sp, f'settings_{idx+1}.json'))
            win_fil = ensure_win_path(BAMBU_FILAMENTS, 'filaments.json')
            joined_settings = ';'.join(win_settings)
            cmd = f'"{win_cli}" --load-settings "{joined_settings}" --load-filaments "{win_fil}" --slice 1 --export-3mf "{win_out}" "{win_stl}"'
            code, out, err = _run(cmd, timeout_sec=600)
            if code != 0 and _is_variant_error(code, out, err):
                profile_linux = BAMBU_PROFILE or os.path.join(os.path.dirname(__file__), '..', 'profiles', 'x1c_pla_024.3mf')
                if not os.path.isabs(profile_linux):
                    profile_linux = os.path.abspath(profile_linux)
                if not os.path.exists(profile_linux):
                    raise RuntimeError(f"Bambu CLI failed ({code}) and no profile set for fallback: {err or out}")
                if profile_linux.startswith('/mnt/'):
                    profile_shared = profile_linux
                else:
                    profile_shared = os.path.join(win_out_dir, 'profile.3mf')
                    shutil.copy2(profile_linux, profile_shared)
                win_profile = _wslpath_win(profile_shared) or profile_shared
                settings_json_shared = os.path.join(win_out_dir, 'settings_cli_recover.json')
                win_settings_json = _wslpath_win(settings_json_shared) or settings_json_shared
                cmd1 = f'"{win_cli}" --uptodate --export-settings "{win_settings_json}" "{win_profile}"'
                c1, o1, e1 = _run(cmd1, timeout_sec=600)
                if c1 != 0:
                    raise RuntimeError(f"Bambu CLI failed and fallback export failed: {e1 or o1}")
                cmd2 = f'"{win_cli}" --load-settings "{win_settings_json}" --slice 1 --export-3mf "{win_out}" "{win_stl}"'
                code, out, err = _run(cmd2, timeout_sec=600)
        else:
            # Direct profile slice: load Golden Project 3MF (printer/process/filament) and slice the provided STL
            profile_linux = BAMBU_PROFILE or os.path.join(os.path.dirname(__file__), '..', 'profiles', 'x1c_pla_024.3mf')
            if not os.path.isabs(profile_linux):
                profile_linux = os.path.abspath(profile_linux)
            if not os.path.exists(profile_linux):
                raise RuntimeError("Bambu profile not found; set BAMBUSTUDIO_PROFILE_PATH")
            # Ensure profile is readable by Windows
            if profile_linux.startswith('/mnt/'):
                profile_shared = profile_linux
            else:
                profile_shared = os.path.join(win_out_dir, 'profile.3mf')
                shutil.copy2(profile_linux, profile_shared)
            try:
                if os.path.getsize(profile_shared) == 0:
                    raise RuntimeError(f"Profile copy produced an empty file at {profile_shared}. Choose a different WIN_OUT_DIR.")
            except Exception:
                pass
            win_profile = _wslpath_win(profile_shared) or profile_shared
            # Always pass STL after profile to apply the project's settings to the given model
            cmd = f'"{win_cli}" --arrange 1 --load-defaultfila --slice 1 --export-3mf "{win_out}" "{win_profile}" "{win_stl}"'
            code, out, err = _run(cmd, timeout_sec=600)
        three_mf_local = out_shared if os.path.exists(out_shared) else None
    else:
        if use_uptodate:
            if not os.path.exists(BAMBU_UPTODATE_SETTINGS):
                raise RuntimeError(f"Uptodate settings not found: {BAMBU_UPTODATE_SETTINGS}")
            cmd = os.getenv(
                "BAMBU_SLICE_CMD",
                f"{BAMBU_CLI} --uptodate --uptodate-settings {shlex.quote(BAMBU_UPTODATE_SETTINGS)} --arrange 1 --load-defaultfila --slice 1 --export-3mf {shlex.quote(three_mf)} {shlex.quote(stl_path_local)}"
            )
            code, out, err = _run(cmd, timeout_sec=600)
            if code != 0 and _is_variant_error(code, out, err):
                if not BAMBU_PROFILE:
                    raise RuntimeError(f"Bambu CLI failed ({code}) and no profile set for fallback: {err or out}")
                settings_json = os.path.join(out_dir, 'settings_cli_recover.json')
                cmd1 = os.getenv(
                    "BAMBU_EXPORT_SETTINGS_CMD",
                    f"{BAMBU_CLI} --uptodate --export-settings {shlex.quote(settings_json)} {shlex.quote(BAMBU_PROFILE)}"
                )
                c1, o1, e1 = _run(cmd1, timeout_sec=600)
                if c1 != 0:
                    raise RuntimeError(f"Bambu CLI failed and fallback export failed: {e1 or o1}")
                cmd2 = os.getenv(
                    "BAMBU_SLICE_CMD",
                    f"{BAMBU_CLI} --load-settings {shlex.quote(settings_json)} --slice 1 --export-3mf {shlex.quote(three_mf)} {shlex.quote(stl_path_local)}"
                )
                code, out, err = _run(cmd2, timeout_sec=600)
        elif use_json_presets:
            # Linux/mac: use JSON preset flags directly
            parts = [s.strip() for s in (BAMBU_SETTINGS or '').replace(',', ';').split(';') if s.strip()]
            for p in parts + [BAMBU_FILAMENTS]:
                if not os.path.exists(p):
                    raise RuntimeError(f"Preset not found: {p}")
            joined = ';'.join(parts)
            cmd = os.getenv(
                "BAMBU_SLICE_CMD",
                f"{BAMBU_CLI} --load-settings {shlex.quote(joined)} --load-filaments {shlex.quote(BAMBU_FILAMENTS)} --slice 1 --export-3mf {shlex.quote(three_mf)} {shlex.quote(stl_path_local)}"
            )
            code, out, err = _run(cmd, timeout_sec=600)
            if code != 0 and _is_variant_error(code, out, err):
                if not BAMBU_PROFILE:
                    raise RuntimeError(f"Bambu CLI failed ({code}) and no profile set for fallback: {err or out}")
                settings_json = os.path.join(out_dir, 'settings_cli_recover.json')
                cmd1 = os.getenv(
                    "BAMBU_EXPORT_SETTINGS_CMD",
                    f"{BAMBU_CLI} --uptodate --export-settings {shlex.quote(settings_json)} {shlex.quote(BAMBU_PROFILE)}"
                )
                c1, o1, e1 = _run(cmd1, timeout_sec=600)
                if c1 != 0:
                    raise RuntimeError(f"Bambu CLI failed and fallback export failed: {e1 or o1}")
                cmd2 = os.getenv(
                    "BAMBU_SLICE_CMD",
                    f"{BAMBU_CLI} --load-settings {shlex.quote(settings_json)} --slice 1 --export-3mf {shlex.quote(three_mf)} {shlex.quote(stl_path_local)}"
                )
                code, out, err = _run(cmd2, timeout_sec=600)
        else:
            # Export settings from 3MF, then slice with exported JSON
            if not BAMBU_PROFILE:
                raise RuntimeError("BAMBUSTUDIO_PROFILE_PATH not set")
            settings_json = os.path.join(out_dir, 'settings_cli.json')
            cmd1 = os.getenv(
                "BAMBU_EXPORT_SETTINGS_CMD",
                f"{BAMBU_CLI} --export-settings {shlex.quote(settings_json)} {shlex.quote(BAMBU_PROFILE)}"
            )
            code1, out1, err1 = _run(cmd1, timeout_sec=600)
            if code1 != 0:
                raise RuntimeError(f"Bambu CLI settings export failed: {err1 or out1}")
            cmd2 = os.getenv(
                "BAMBU_SLICE_CMD",
                f"{BAMBU_CLI} --load-settings {shlex.quote(settings_json)} --slice 1 --export-3mf {shlex.quote(three_mf)} {shlex.quote(stl_path_local)}"
            )
            code, out, err = _run(cmd2, timeout_sec=600)
        three_mf_local = three_mf if os.path.exists(three_mf) else None
    if code != 0:
        if not _retry and _is_empty_initial_layer(code, out, err):
            log("[bambu] Empty initial layer detected; auto-fixing base contact and retrying slice")
            fixed_path = os.path.join(out_dir, "basefix_retry.stl")
            ok_fix, fix_log, orient_meta = _blender_orient_and_clamp(stl_path_local, fixed_path, force_contact=True)
            if ok_fix and os.path.exists(fixed_path):
                try:
                    if orient_meta:
                        area_val = orient_meta.get('base_contact_area_mm2')
                        area_str = f"{float(area_val):.1f}" if isinstance(area_val, (int, float)) else "n/a"
                        verts_val = orient_meta.get('base_contact_vertices')
                        log(f"[bambu] Base fix metrics: area={area_str} mm^2, vertices={verts_val}")
                except Exception:
                    pass
                return bambu_slice(fixed_path, out_dir, _retry=True)
            else:
                log(f"[bambu] Base fix failed: {fix_log[:200] if fix_log else 'unknown error'}")
        raise RuntimeError(f"Bambu CLI failed ({code}): {err or out}")
    minutes, grams = parse_minutes_grams_from_text(out + "\n" + err)
    if not three_mf_local:
        three_mf_local = None
    if not os.path.exists(preview_png):
        preview_png = None
    # If 3MF exists, try to parse metrics from it as a fallback
    if three_mf_local:
        m2, g2 = parse_metrics_from_3mf(three_mf_local)
        minutes = minutes or m2
        grams = grams or g2
    return three_mf_local, preview_png, minutes, grams

def slice_and_quote(order: Dict[str, Any], stl_url: str) -> Dict[str, Any]:
    import tempfile
    # Download STL via Supabase or HTTP
    try:
        stl_bytes = download_bytes(stl_url)
    except Exception as e:
        log(f"Download STL failed, using fallback: {e}")
        stl_bytes = b"solid cube\nendsolid\n"
    with tempfile.TemporaryDirectory() as td:
        stl_path = os.path.join(td, "model.stl")
        with open(stl_path, "wb") as f:
            f.write(stl_bytes)
        three_mf_local, preview_local, minutes, grams = bambu_slice(stl_path, td)

        three_mf_url = None
        preview_url = None
        if three_mf_local and os.path.exists(three_mf_local):
            with open(three_mf_local, "rb") as f:
                b = f.read()
            sha = sha256_bytes(b)
            path = f"{order['id']}/{sha}.3mf"
            three_mf_url = storage_upload_bytes(STORAGE_BUCKET, path, b, content_type="model/3mf")
        if preview_local and os.path.exists(preview_local):
            with open(preview_local, "rb") as f:
                b = f.read()
            sha = sha256_bytes(b)
            path = f"{order['id']}/{sha}.png"
            preview_url = storage_upload_bytes(STORAGE_BUCKET, path, b, content_type="image/png")

    if minutes is None or grams is None:
        raise RuntimeError("slice_metrics_missing")
    quote = compute_price(minutes, grams)
    quote["preview_url"] = preview_url
    quote["three_mf_url"] = three_mf_url
    return quote


def process_slicing(order: Dict[str, Any]) -> bool:
    oid = order.get("id")
    if not oid:
        return False
    if _skip_if_cancelled(oid, "slicing"):
        return False
    rep = latest_asset(oid, "repaired_stl")
    if not rep:
        set_status(oid, "slice_failed")
        supabase_insert("order_events", {"order_id": oid, "phase": "slice_failed", "message": "No repaired STL found"})
        return False
    stl_url = rep.get("url")
    expected_sha = rep.get("sha256") if isinstance(rep, dict) else None
    transform = latest_transform(oid) or {}
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        try:
            base_bytes = download_bytes(stl_url, expected_sha=expected_sha, order_id=oid, context='process_slicing')
        except Exception as e:
            set_status(oid, "slice_failed")
            supabase_insert("order_events", {"order_id": oid, "phase": "slice_failed", "message": f"download STL: {e}"})
            return False
        base_path = os.path.join(td, "in.stl")
        with open(base_path, "wb") as f:
            f.write(base_bytes)
        scaled_path = base_path
        target = transform.get("target_max_dim_mm") if isinstance(transform, dict) else None
        if target and target > 0:
            out_scaled = os.path.join(td, "scaled.stl")
            prev = os.environ.get("TARGET_MODEL_MAX_DIM_MM")
            os.environ["TARGET_MODEL_MAX_DIM_MM"] = str(float(target))
            ok_scale, _logtxt, _orient_meta = _blender_orient_and_clamp(base_path, out_scaled)
            if prev is None:
                os.environ.pop("TARGET_MODEL_MAX_DIM_MM", None)
            else:
                os.environ["TARGET_MODEL_MAX_DIM_MM"] = prev
            if ok_scale and os.path.exists(out_scaled):
                scaled_path = out_scaled
        prev_orient = os.environ.get("ORIENT_OVERRIDE_EULER_DEG")
        prev_force = os.environ.get("ORIENT_FORCE_UPRIGHT")
        try:
            if transform.get("rotation_euler_deg"):
                rx, ry, rz = transform["rotation_euler_deg"]
                os.environ["ORIENT_OVERRIDE_EULER_DEG"] = f"{rx},{ry},{rz}"
            elif transform.get("upright"):
                os.environ["ORIENT_FORCE_UPRIGHT"] = "1"
        except Exception:
            pass
        slice_error: Optional[Exception] = None
        three_mf_local: Optional[str] = None
        preview_local: Optional[str] = None
        minutes: Optional[float] = None
        grams: Optional[float] = None
        try:
            supabase_insert(
                'chat_messages',
                {
                    'order_id': oid,
                    'role': 'assistant',
                    'type': 'text',
                    'content_json': {'text': 'Slicing the mesh with the Bambu profile for an exact quote.'},
                },
            )
        except Exception:
            pass
        try:
            three_mf_local, preview_local, minutes, grams = bambu_slice(scaled_path, td)
        except Exception as exc:
            slice_error = exc
        finally:
            if prev_orient is None:
                os.environ.pop("ORIENT_OVERRIDE_EULER_DEG", None)
            else:
                os.environ["ORIENT_OVERRIDE_EULER_DEG"] = prev_orient
            if prev_force is None:
                os.environ.pop("ORIENT_FORCE_UPRIGHT", None)
            else:
                os.environ["ORIENT_FORCE_UPRIGHT"] = prev_force
        if slice_error:
            err_text = str(slice_error)
            log(f"[bambu] slice failed for order {oid}: {err_text}")
            set_status(oid, "slice_failed")
            supabase_insert("order_events", {
                "order_id": oid,
                "phase": "slice_failed",
                "message": "Bambu CLI failed during slicing",
                "meta_json": {"error": err_text[:400]},
            })
            return False
        three_mf_url = None
        three_mf_sha: Optional[str] = None
        preview_url = None
        preview_sha: Optional[str] = None
        if three_mf_local and os.path.exists(three_mf_local):
            with open(three_mf_local, "rb") as f:
                three_mf_bytes = f.read()
            three_mf_sha = sha256_bytes(three_mf_bytes)
            path = f"{oid}/{three_mf_sha}.3mf"
            three_mf_url = storage_upload_bytes(STORAGE_BUCKET, path, three_mf_bytes, content_type="model/3mf")
        if preview_local and os.path.exists(preview_local):
            with open(preview_local, "rb") as f:
                preview_bytes = f.read()
            preview_sha = sha256_bytes(preview_bytes)
            path = f"{oid}/{preview_sha}.png"
            preview_url = storage_upload_bytes(STORAGE_BUCKET, path, preview_bytes, content_type="image/png")
    if minutes is None or grams is None:
        set_status(oid, "slice_failed")
        supabase_insert("order_events", {"order_id": oid, "phase": "slice_failed", "message": "slice_metrics_missing"})
        return False
    quote = compute_price(minutes, grams)
    quote["preview_url"] = preview_url
    quote["three_mf_url"] = three_mf_url
    if preview_sha:
        quote['preview_sha256'] = preview_sha
    if three_mf_sha:
        quote['three_mf_sha256'] = three_mf_sha
    asset_meta_base = {
        'quote_minutes': minutes,
        'quote_grams': grams,
        'quote_total_cents': quote['total_cents'],
        'source_asset_id': rep.get('id') if isinstance(rep, dict) else None,
        'transform': transform,
    }
    if preview_url:
        preview_meta = dict(asset_meta_base)
        preview_meta['asset_role'] = 'preview'
        attach_asset(oid, "slicer_preview_png", preview_url, preview_sha, preview_meta)
    if three_mf_url:
        three_mf_meta = dict(asset_meta_base)
        three_mf_meta['asset_role'] = 'toolpath'
        attach_asset(oid, "three_mf", three_mf_url, three_mf_sha, three_mf_meta)
    transition_quote_ready(supabase_rpc, oid, quote)
    record_domain_event(
        org_id=order.get("org_id"),
        order_id=oid,
        event_type="slice_ready",
        payload={
            "minutes": minutes,
            "grams": grams,
            # Backward/forward compatible: prefer total_cents, fall back to price_cents if present
            "price_cents": quote.get("total_cents") or quote.get("price_cents"),
            "preview_url": quote.get("preview_url"),
            "three_mf_url": quote.get("three_mf_url"),
        },
    )
    # Only post quote to chat if it's different from the last one (deduplication)
    try:
        should_post = True
        # Check for existing quote with same total_cents
        existing = supabase_get(
            "chat_messages",
            {
                "order_id": f"eq.{oid}",
                "type": "eq.card.quote",
                "order": "created_at.desc",
                "limit": 1,
            },
        )
        if existing and len(existing) > 0:
            last_quote = existing[0].get("content_json") or {}
            last_total = last_quote.get("total_cents") or last_quote.get("price_cents")
            new_total = quote.get("total_cents") or quote.get("price_cents")
            if last_total == new_total:
                should_post = False
                log(f"[slicing] Skipping duplicate quote post (total={new_total}¢)", order_id=oid)

        if should_post:
            supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "card.quote", "content_json": quote})
            log(f"[slicing] Posted quote to chat (total={quote.get('total_cents')}¢)", order_id=oid)
    except Exception as e:
        log(f"[slicing] Failed to post/check quote message: {e}", order_id=oid, level='warn')
    return True


def execute_slicing_with_retries(order: Dict[str, Any]) -> bool:
    oid = order.get('id')
    if not oid:
        return False
    current_order = order
    for attempt in range(1, MAX_SLICE_ATTEMPTS + 1):
        if _skip_if_cancelled(oid, 'slicing'):
            return False
        if process_slicing(current_order):
            return True
        log(
            'Slice attempt failed',
            level='warning',
            order_id=oid,
            attempt=attempt,
            max_attempts=MAX_SLICE_ATTEMPTS,
        )
        record_order_event(
            oid,
            'slice_retry',
            'Slice attempt failed',
            severity='warning',
            meta={'attempt': attempt, 'max_attempts': MAX_SLICE_ATTEMPTS},
        )
        if attempt >= MAX_SLICE_ATTEMPTS:
            return False
        try:
            set_status(oid, 'slicing')
        except Exception:
            pass
        time.sleep(min(STAGE_RETRY_DELAY_S * attempt, STAGE_RETRY_DELAY_S * 3))
        refreshed = reload_order(oid)
        if refreshed:
            current_order = refreshed
    return False

def loop_once():
    log("[DEBUG] loop_once() called")
    job = claim_next_export_job()
    if job:
        log(f"Processing export job {job.get('id')} for order {job.get('order_id')}")
        try:
            process_export_job(job)
        except Exception as exc:
            log(f"Export job error: {exc}", level='error', order_id=job.get('order_id'))
        return True
    order = claim_next_order()
    if not order or not order.get("id"):
        log("[DEBUG] No orders to process")
        return False
    oid = order.get("id")
    log(f"Processing order {oid}")
    try:
        status = str(order.get("status") or "")
        if status == "slicing":
            execute_slicing_with_retries(order)
            return True

        if status == "fabrication_requested":
            if _skip_if_cancelled(oid, "fabrication_requested"):
                return True
            src_ids = _get_selected_image_ids(oid)
            rep_asset = latest_asset(oid, "repaired_stl")
            stl_url = rep_asset.get("url") if rep_asset else None
            ran_repair = False
            if not stl_url:
                raw_asset = latest_raw_mesh_asset(oid)
                raw_url = raw_asset.get("url") if raw_asset else None
                if not raw_url:
                    set_status(oid, "needs_review")
                    supabase_insert("order_events", {"order_id": oid, "phase": "fabrication_failed", "message": "No raw mesh available"})
                    return True
                if _skip_if_cancelled(oid, "repairing"):
                    return True
                set_status(oid, "repairing")
                supabase_insert("order_events", {"order_id": oid, "phase": "repairing", "message": "Fabrication requested"})
                try:
                    supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "text", "content_json": {"text": "Stabilizing your mesh for print…"}})
                except Exception:
                    pass
                if _skip_if_cancelled(oid, "repair_start"):
                    return True
                repair_out: Optional[Tuple[str, Dict[str, Any], bytes]] = None
                for attempt in range(1, MAX_REPAIR_ATTEMPTS + 1):
                    repair_out = repair(order, raw_url)
                    if repair_out:
                        break
                    log(
                        "Repair attempt failed",
                        level='warning',
                        order_id=oid,
                        attempt=attempt,
                        max_attempts=MAX_REPAIR_ATTEMPTS,
                    )
                    record_order_event(
                        oid,
                        'repair_retry',
                        'Repair attempt failed',
                        severity='warning',
                        meta={'attempt': attempt, 'max_attempts': MAX_REPAIR_ATTEMPTS},
                    )
                    if attempt >= MAX_REPAIR_ATTEMPTS:
                        break
                    time.sleep(min(STAGE_RETRY_DELAY_S * attempt, STAGE_RETRY_DELAY_S * 3))
                    refreshed = reload_order(oid)
                    if refreshed:
                        order = refreshed
                    if _skip_if_cancelled(oid, "repairing"):
                        return True
                if not repair_out:
                    log(f"[fabricate] repair() returned no STL for order {oid}", level='error', order_id=oid)
                    set_status(oid, "repair_failed")
                    record_order_event(oid, "repair_failed", "Repair pipeline exhausted", severity='error')
                    return True
                stl_url, repair_meta, repaired_bytes = repair_out
                sha_repaired = sha256_bytes(repaired_bytes)
                ran_repair = True
                if _skip_if_cancelled(oid, "post_repair"):
                    return True
                orient_summary = _orient_summary((repair_meta.get('orient_clamp_final') if isinstance(repair_meta, dict) else None))
                rep_meta_payload: Dict[str, Any] = {"source_image_ids": src_ids} if src_ids else {}
                if orient_summary:
                    rep_meta_payload['orientation'] = orient_summary
                try:
                    rep_meta_payload['size_bytes'] = len(repaired_bytes)
                except Exception:
                    pass
                slice_check = validate_slice_bytes(oid, repaired_bytes)
                if slice_check:
                    rep_meta_payload['slice_check'] = slice_check
                _rows_rep = attach_asset(oid, "repaired_stl", stl_url, sha_repaired, (rep_meta_payload or None)) or []
                try:
                    if _rows_rep and isinstance(_rows_rep, list):
                        aid = _rows_rep[0].get("id")
                        if aid:
                            merge_order_facts(oid, {"active_mesh_asset_id": aid})
                except Exception:
                    pass
                # Best‑effort: attach a viewer GLB derived from repaired STL for faster viewing
                try:
                    rep_asset_id = None
                    if _rows_rep and isinstance(_rows_rep, list):
                        rep_asset_id = _rows_rep[0].get('id')
                    _attach_viewer_glb(oid, repaired_bytes, rep_asset_id, 'repaired_stl', None)
                except Exception as e:
                    log(f"[viewer_glb] attach after repair failed: {e}", level='warning', order_id=oid)
                try:
                    asset_id = _rows_rep[0].get('id') if _rows_rep and isinstance(_rows_rep, list) else None
                    parsed = parse_supabase_url(stl_url)
                    signed = stl_url
                    expires_at = None
                    if parsed:
                        expires_at = int(time.time() * 1000 + SIGNED_URL_TTL_MS)
                        try:
                            maybe_signed = storage_create_signed_url(*parsed)
                            if maybe_signed:
                                signed = maybe_signed
                            else:
                                expires_at = None
                        except Exception:
                            signed = stl_url
                            expires_at = None
                    if signed:
                        payload = {
                            "kind": "stl",
                            "url": signed,
                            "asset_id": asset_id,
                            "asset_kind": "repaired_stl",
                            "storage_url": stl_url,
                        }
                        if expires_at is not None:
                            payload["expires_at"] = expires_at
                        supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "viewer.focus", "content_json": payload})
                except Exception:
                    pass
            summary_parts: List[str] = []
            if orient_summary:
                bbox = orient_summary.get('bbox_mm') if isinstance(orient_summary, dict) else None
                if isinstance(bbox, dict):
                    try:
                        sx = float(bbox.get('x') or 0)
                        sy = float(bbox.get('y') or 0)
                        sz = float(bbox.get('z') or 0)
                        if sx and sy and sz:
                            summary_parts.append(f"Size {round(sx)} × {round(sy)} × {round(sz)} mm")
                    except Exception:
                        pass
            try:
                summary_parts.append(f"File {round(len(repaired_bytes) / (1024 * 1024), 1)} MB")
            except Exception:
                pass
            if slice_check and isinstance(slice_check, dict):
                minutes = slice_check.get('minutes')
                grams = slice_check.get('grams')
                status = slice_check.get('status')
                if status == 'ok' and minutes is not None and grams is not None:
                    summary_parts.append(f"Validation passed · {round(minutes)} min · {round(grams)} g")
            floating_hint = 0
            try:
                floating_hint = int((orient_summary or {}).get('floating_component_count') or 0)
            except Exception:
                floating_hint = 0
            if floating_hint:
                summary_parts.append(f"Floating regions flagged: {floating_hint}")
            if src_ids:
                summary_parts.append('Linked to latest concept selection.')
            if summary_parts:
                record_order_event(
                    oid,
                    'repair_summary',
                    'Mesh stabilized summary',
                    meta={'details': summary_parts},
                )
            if thin_wall_detected:
                warning_text = thin_wall_reason or 'Mesh repair detected thin walls or unit issues. Resize or thicken the model before slicing.'
                record_order_event(
                    oid,
                    'repair_thin_wall',
                    warning_text,
                    severity='error',
                    meta={'slice_check': slice_check},
                )
                try:
                    supabase_insert(
                        'chat_messages',
                        {
                            'order_id': oid,
                            'role': 'assistant',
                            'type': 'warning',
                            'content_json': {'text': warning_text},
                        },
                    )
                except Exception:
                    pass
                set_status(oid, 'needs_review')
                return
            floating_count_hint = 0
            try:
                floating_count_hint = int((orient_summary or {}).get('floating_component_count') or 0)
            except Exception:
                floating_count_hint = 0
            if floating_count_hint > 0:
                try:
                    supabase_insert('chat_messages', {'order_id': oid, 'role': 'assistant', 'type': 'warning', 'content_json': {'text': 'Mesh stabilized, but floating regions remain. Review orientation or request supports.'}})
                except Exception:
                    pass
            slice_job = request_order_job(
                supabase_rpc,
                oid,
                "slice",
                source="fabrication_requested",
                event_message="Fabrication requested - queued for print check",
            )
            log(
                f"[fabricate] slice job {slice_job.get('job_id')} ready",
                order_id=oid,
                reused=bool(slice_job.get('reused')),
            )
            supabase_insert("order_events", {"order_id": oid, "phase": "slicing", "message": "Fabrication requested - queued for print check"})
            try:
                supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "text", "content_json": {"text": "Queueing print check with Bambu X1C profile…"}})
            except Exception:
                pass
            # Job will be claimed by loop_once() via claim_next_export_job()
            return True

        if status == "exporting":
            if _skip_if_cancelled(oid, "exporting"):
                return True
            # Export a print‑ready STL that reflects the latest transform (size/orientation)
            rep = latest_asset(oid, "repaired_stl")
            if not rep:
                set_status(oid, "needs_review")
                supabase_insert("order_events", {"order_id": oid, "phase": "export_failed", "message": "No repaired STL found"})
                return True
            stl_url = rep.get("url")
            expected_sha = rep.get('sha256') if isinstance(rep, dict) else None
            transform = latest_transform(oid) or {}
            target = transform.get("target_max_dim_mm")
            import tempfile
            with tempfile.TemporaryDirectory() as td:
                try:
                    base_bytes = download_bytes(stl_url, expected_sha=expected_sha, order_id=oid, context='exporting')
                except Exception as e:
                    set_status(oid, "needs_review")
                    supabase_insert("order_events", {"order_id": oid, "phase": "export_failed", "message": f"download STL: {e}"})
                    return True
                base_path = os.path.join(td, 'in.stl')
                with open(base_path, 'wb') as f:
                    f.write(base_bytes)
                out_path = os.path.join(td, 'out.stl')
                prev = os.environ.get('TARGET_MODEL_MAX_DIM_MM')
                if target and target > 0:
                    os.environ['TARGET_MODEL_MAX_DIM_MM'] = str(float(target))
                ok, logtxt, orient_meta = _blender_orient_and_clamp(base_path, out_path)
                if prev is None:
                    os.environ.pop('TARGET_MODEL_MAX_DIM_MM', None)
                else:
                    os.environ['TARGET_MODEL_MAX_DIM_MM'] = prev
                if not ok or not os.path.exists(out_path):
                    set_status(oid, 'needs_review')
                    supabase_insert('order_events', { 'order_id': oid, 'phase': 'export_failed', 'message': 'orient/scale failed', 'meta_json': { 'log': (logtxt or '')[:400] } })
                    return True
                with open(out_path, 'rb') as f:
                    sized_bytes = f.read()
                sha = sha256_bytes(sized_bytes)
                url = storage_upload_bytes(STORAGE_BUCKET, f"{oid}/{sha}.stl", sized_bytes, content_type='model/stl')
            orient_summary = _orient_summary(orient_meta)
            asset_meta: Dict[str, Any] = {}
            if orient_summary:
                asset_meta['orientation'] = orient_summary
            if target and isinstance(target, (int, float)):
                try:
                    asset_meta['target_max_dim_mm'] = float(target)
                except Exception:
                    pass
            rep_id = rep.get('id') if isinstance(rep, dict) else None
            if rep_id:
                asset_meta['source_asset_id'] = rep_id
            asset_meta['source_asset_kind'] = 'repaired_stl'
            sized_rows = attach_asset(oid, 'repaired_sized_stl', url, sha, asset_meta or None) or []
            sized_asset_id = None
            try:
                if sized_rows and isinstance(sized_rows, list):
                    sized_asset_id = sized_rows[0].get('id')
            except Exception:
                sized_asset_id = None
            # Best‑effort: attach viewer GLB for the sized STL so viewer prefers GLB path
            try:
                _attach_viewer_glb(oid, sized_bytes, sized_asset_id, 'repaired_sized_stl', { 'target_max_dim_mm': target if target else None })
            except Exception as e:
                log(f"[viewer_glb] attach for sized STL failed: {e}", level='warning', order_id=oid)
            # Mark STL as ready and notify chat/UI
            set_status(oid, 'stl_ready')
            order['status'] = 'stl_ready'
            supabase_insert('order_events', { 'order_id': oid, 'phase': 'export_done', 'message': 'print‑ready STL available', 'meta_json': { 'asset': 'repaired_sized_stl', 'url': url } })
            try:
                parsed = parse_supabase_url(url)
                signed = url if not parsed else None
                expires_at = None
                if parsed:
                    expires_at = int(time.time() * 1000 + SIGNED_URL_TTL_MS)
                    maybe_signed = storage_create_signed_url(*parsed)
                    if maybe_signed:
                        signed = maybe_signed
                    else:
                        expires_at = None
                if signed:
                    focus_payload = {
                        'kind': 'stl',
                        'url': signed,
                        'asset_kind': 'repaired_sized_stl',
                        'storage_url': url,
                    }
                    if expires_at is not None:
                        focus_payload['expires_at'] = expires_at
                    if sized_asset_id:
                        focus_payload['asset_id'] = sized_asset_id
                    supabase_insert('chat_messages', { 'order_id': oid, 'role': 'assistant', 'type': 'viewer.focus', 'content_json': focus_payload })
            except Exception:
                pass
            return True

        if status == "dispatching":
            if _skip_if_cancelled(oid, "dispatching"):
                return True
            three_mf = latest_asset(oid, "three_mf")
            if not three_mf or not three_mf.get("url"):
                set_status(oid, "dispatch_failed")
                supabase_insert("order_events", {"order_id": oid, "phase": "dispatch_failed", "message": "No 3MF available for dispatch"})
                return True
            asset_url = three_mf.get("url")
            parsed = parse_supabase_url(asset_url)
            expires_at = None
            signed = asset_url if not parsed else None
            if parsed:
                expires_at = int(time.time() * 1000 + SIGNED_URL_TTL_MS)
                signed_candidate = storage_create_signed_url(*parsed)
                if signed_candidate:
                    signed = signed_candidate
                else:
                    expires_at = None
            if not signed:
                set_status(oid, "dispatch_failed")
                supabase_insert("order_events", {"order_id": oid, "phase": "dispatch_failed", "message": "Failed to sign 3MF URL"})
                return True
            link = build_bambu_connect_link(signed)
            # Authoritative state must accept printing before the worker emits a
            # usable operator link or reports dispatch success.
            set_status(oid, "printing")
            try:
                supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "text", "content_json": {"text": f"Open to print: {link}"}})
            except Exception:
                pass
            supabase_insert("order_events", {"order_id": oid, "phase": "dispatching", "message": "Dispatch link issued", "meta_json": {"link": link}})
            supabase_insert("order_events", {"order_id": oid, "phase": "printing", "message": "Awaiting operator print"})
            return True

        # Default pipeline: generate concept mesh and pause for user feedback
        if _skip_if_cancelled(oid, "generate"):
            return True
        supabase_insert("order_events", {"order_id": oid, "phase": "generating", "message": "Start"})
        gen: Optional[Tuple[str, str]] = None
        for attempt in range(1, MAX_GENERATE_ATTEMPTS + 1):
            gen = generate(order)
            if gen:
                break
            log(
                "Image→3D generation attempt failed",
                level='warning',
                order_id=oid,
                attempt=attempt,
                max_attempts=MAX_GENERATE_ATTEMPTS,
            )
            record_order_event(
                oid,
                'generate_retry',
                'Image→3D generation attempt failed',
                severity='warning',
                meta={'attempt': attempt, 'max_attempts': MAX_GENERATE_ATTEMPTS},
            )
            if attempt >= MAX_GENERATE_ATTEMPTS:
                break
            time.sleep(min(STAGE_RETRY_DELAY_S * attempt, STAGE_RETRY_DELAY_S * 3))
            refreshed = reload_order(oid)
            if refreshed:
                order = refreshed
            if _skip_if_cancelled(oid, "generating"):
                return True
        if not gen:
            set_status(oid, "generate_failed")
            record_order_event(oid, "generate_failed", "All Image→3D attempts failed", severity='error', meta={'reason': 'no_raw_asset'})
            _mark_latest_i23d_task(oid, "failed")
            return True
        raw_kind, raw_url = gen
        if _skip_if_cancelled(oid, "post_generate"):
            return True
        try:
            src_ids = _get_selected_image_ids(oid)
        except Exception:
            src_ids = []
        extra_meta = order.pop('_last_generate_meta', None)
        meta_payload: Dict[str, Any] = {}
        if src_ids:
            meta_payload["source_image_ids"] = src_ids
        stage_label: Optional[str] = None
        if isinstance(extra_meta, dict):
            stage_candidate = extra_meta.get("materialize_stage") or extra_meta.get("stage")
            if isinstance(stage_candidate, str) and stage_candidate.strip():
                stage_label = stage_candidate.strip().lower()
            for key, value in extra_meta.items():
                if value is None:
                    continue
                meta_payload[key] = value
        meta_arg = meta_payload if meta_payload else None
        raw_rows = attach_asset(oid, raw_kind, raw_url, None, meta_arg) or []
        if _skip_if_cancelled(oid, "raw_asset_attached"):
            return True
        try:
            if raw_rows and isinstance(raw_rows, list):
                aid = raw_rows[0].get('id')
                if aid:
                    facts: Dict[str, Any] = {"active_concept_asset_id": aid}
                    if stage_label in ("draft", "refine"):
                        facts[f"{stage_label}_asset_id"] = aid
                        if isinstance(meta_payload.get("tripo_task_id"), str):
                            facts[f"{stage_label}_task_id"] = meta_payload.get("tripo_task_id")
                    merge_order_facts(oid, facts)
        except Exception:
            pass
        if _skip_if_cancelled(oid, "post_raw_asset"):
            return True
        _mark_latest_i23d_task(oid, "succeeded")
        event_meta = {"asset_kind": raw_kind}
        if stage_label:
            event_meta["materialize_stage"] = stage_label
        supabase_insert("order_events", {"order_id": oid, "phase": "concept_ready", "message": "Concept mesh ready", "meta_json": event_meta})
        try:
            parsed_raw = parse_supabase_url(raw_url)
            signed = raw_url
            expires_at = None
            if parsed_raw:
                expires_at = int(time.time() * 1000 + SIGNED_URL_TTL_MS)
                maybe_signed = storage_create_signed_url(*parsed_raw)
                if maybe_signed:
                    signed = maybe_signed
                else:
                    expires_at = None
            if signed:
                focus_kind = "glb" if raw_kind in ("raw_glb", "raw_gltf", "upload_glb", "upload_gltf") else ("obj" if raw_kind in ("raw_obj", "upload_obj") else "stl")
                asset_id = raw_rows[0].get('id') if raw_rows and isinstance(raw_rows, list) else None
                focus_payload: Dict[str, Any] = {
                    "kind": focus_kind,
                    "url": signed,
                    "asset_id": asset_id,
                    "asset_kind": raw_kind,
                    "storage_url": raw_url,
                }
                if expires_at is not None:
                    focus_payload['expires_at'] = expires_at
                if stage_label:
                    focus_payload["materialize_stage"] = stage_label
                supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "viewer.focus", "content_json": focus_payload})
        except Exception:
            pass
        try:
            if stage_label in ("draft", "refine"):
                text_msg = "Mesh ready. Preview loaded — stabilizing geometry for printability now."
            else:
                text_msg = "Concept mesh ready. Preview loaded — stabilizing automatically so the STL is printable."
            supabase_insert("chat_messages", {"order_id": oid, "role": "assistant", "type": "text", "content_json": {"text": text_msg}})
        except Exception:
            pass
        auto_stabilize_mesh(order, raw_kind, raw_url, raw_rows, stage_label)
        return True
    except Exception as e:
        log(f"Error processing order {oid}: {e}")
        set_status(oid, "needs_review")
        supabase_insert("order_events", {"order_id": oid, "phase": "needs_review", "message": str(e)[:300]})
    return True

def main():
    log(f"Worker starting… id={WORKER_ID}")
    _report_tool_readiness()
    log(f"[DEBUG] Entering main loop...")
    while True:
        log(f"[DEBUG] Starting loop iteration...")
        worked = False
        try:
            worked = loop_once()
        except Exception as e:
            log(f"Loop error: {e}")
            import traceback
            traceback.print_exc()
        time.sleep(2 if worked else 5)

if __name__ == "__main__":
    main()
