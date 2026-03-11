"""
Local embedding server for code-graph-context.
Uses Qwen3-Embedding-0.6B for high-quality code embeddings without OpenAI dependency.
Runs as a sidecar process managed by the Node.js MCP server.
"""

import gc
import os
import sys
import signal
import logging
import threading
import time

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    stream=sys.stderr,
)
logger = logging.getLogger("embedding-sidecar")

logger.info(f"Sidecar process starting (pid={os.getpid()})")

app = FastAPI(title="code-graph-context embedding sidecar")

model = None
model_name = os.environ.get("EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")


class EmbedRequest(BaseModel):
    texts: list[str]
    batch_size: int = 8


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]
    dimensions: int
    model: str


@app.on_event("startup")
def load_model():
    global model
    try:
        import torch
        from sentence_transformers import SentenceTransformer

        device = "mps" if torch.backends.mps.is_available() else "cpu"
        logger.info(f"Loading {model_name} on {device}...")
        logger.info(f"PyTorch version: {torch.__version__}, MPS available: {torch.backends.mps.is_available()}")

        use_half = os.environ.get("EMBEDDING_HALF_PRECISION", "").lower() == "true"
        model = SentenceTransformer(model_name, device=device)
        if use_half:
            model.half()
            logger.info(f"Model loaded in float16 (half precision)")
        else:
            logger.info(f"Model loaded in float32 (full precision)")
        logger.info(f"Running warmup...")

        # Warm up with a test embedding
        with torch.no_grad():
            test = model.encode(["warmup"], show_progress_bar=False)
        dims = len(test[0])
        logger.info(f"Warmup complete: {dims} dimensions, device={device}")
        logger.info(f"Sidecar ready (pid={os.getpid()})")
    except Exception as e:
        logger.error(f"Failed to load model: {e}", exc_info=True)
        raise


@app.get("/health")
def health():
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")
    sample = model.encode(["dim_check"], show_progress_bar=False)
    return {
        "status": "ok",
        "model": model_name,
        "dimensions": len(sample[0]),
        "device": str(model.device),
    }


@app.post("/embed", response_model=EmbedResponse)
async def embed(req: EmbedRequest):
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not req.texts:
        return EmbedResponse(embeddings=[], dimensions=0, model=model_name)

    logger.info(f"Embed request: {len(req.texts)} texts, batch_size={req.batch_size}")
    start = time.time()

    try:
        embeddings = _encode_with_oom_fallback(req.texts, req.batch_size)
        dims = len(embeddings[0])
        elapsed = time.time() - start
        logger.info(f"Embed complete: {len(embeddings)} embeddings in {elapsed:.2f}s")
        return EmbedResponse(
            embeddings=embeddings,
            dimensions=dims,
            model=model_name,
        )
    except Exception as e:
        logger.error(f"Embedding error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


def _encode_with_oom_fallback(texts: list[str], batch_size: int) -> list[list[float]]:
    """
    Encode texts, falling back to CPU if MPS runs out of memory.
    Also retries with smaller batch sizes before giving up.
    """
    import torch

    try:
        with torch.no_grad():
            result = model.encode(
                texts,
                batch_size=batch_size,
                show_progress_bar=False,
                normalize_embeddings=True,
            )
        # Free intermediate tensors after each request
        if hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
        return result.tolist()
    except (torch.mps.OutOfMemoryError, RuntimeError) as e:
        if "out of memory" not in str(e).lower():
            raise

        logger.warning(f"MPS OOM with batch_size={batch_size}, len={len(texts)}. Falling back to CPU.")

        # Free MPS memory
        if hasattr(torch.mps, "empty_cache"):
            torch.mps.empty_cache()
        gc.collect()

        # Fall back to CPU for this request
        original_device = model.device
        model.to("cpu")
        logger.info("Model moved to CPU for fallback encoding")

        try:
            # Use smaller batches on CPU
            cpu_batch = min(batch_size, 4)
            with torch.no_grad():
                result = model.encode(
                    texts,
                    batch_size=cpu_batch,
                    show_progress_bar=False,
                    normalize_embeddings=True,
                )
            logger.info(f"CPU fallback encoding complete ({len(texts)} texts)")
            return result.tolist()
        finally:
            # Move back to MPS for future requests
            try:
                model.to(original_device)
                logger.info(f"Model moved back to {original_device}")
            except Exception:
                logger.warning("Could not move model back to MPS, staying on CPU")


def handle_signal(sig, _frame):
    logger.info(f"Received signal {sig}, shutting down (pid={os.getpid()})")
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_signal)


def _watch_stdin():
    """
    Watch stdin for EOF — when the parent Node.js process dies (any reason),
    the pipe breaks and stdin closes. This is our most reliable way to detect
    parent death and self-terminate instead of becoming an orphan.
    """

    def _watcher():
        logger.info("Stdin watcher thread started")
        try:
            # Blocks until stdin is closed (parent died)
            while True:
                data = sys.stdin.read(1)
                if not data:
                    # EOF — parent closed the pipe
                    break
        except Exception as e:
            logger.info(f"Stdin watcher exception: {e}")
        logger.info("Parent process died (stdin closed), shutting down")
        os._exit(0)

    t = threading.Thread(target=_watcher, daemon=True)
    t.start()


# Only watch stdin if it's a pipe (not a TTY) — avoids issues when run manually
if not sys.stdin.isatty():
    _watch_stdin()
else:
    logger.info("Running in terminal mode, stdin watcher disabled")
