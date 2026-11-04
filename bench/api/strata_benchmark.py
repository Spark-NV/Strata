#!/usr/bin/env python3
"""Repeatable, API-level benchmarks for a local Strata server.

It measures the server that is actually running, so it can compare an existing
custom build with a candidate build without changing either one.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import datetime as dt
import hashlib
import json
import os
import platform
import socket
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
import struct
import zlib
from pathlib import Path
from typing import Any


FORMAT_VERSION = 1
DEFAULT_OUTPUT = Path("/home/spark/benchmark-results/strata-api")


def get_json(url: str, timeout: int = 30) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.load(response)


def post_json(url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def median(values: list[float | int | None]) -> float | None:
    cleaned = [float(value) for value in values if value is not None]
    return round(statistics.median(cleaned), 3) if cleaned else None


def git_revision(path: Path | None) -> str | None:
    if not path or not (path / ".git").exists():
        return None
    try:
        return subprocess.check_output(
            ["git", "-C", str(path), "rev-parse", "HEAD"], text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        return None


def file_sha256(path: Path | None) -> str | None:
    if not path or not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def corpus(words: int, salt: str) -> str:
    """Make deterministic, non-identical prose-like text without external data."""
    vocabulary = (
        "amber bridge cedar delta ember forest granite harbor island juniper kettle lantern "
        "meadow north orchard pebble quartz river summit thistle upland valley willow xylem yellow zenith"
    ).split()
    pieces: list[str] = []
    for index in range(words):
        pieces.append(f"{vocabulary[index % len(vocabulary)]}{salt}{index}")
    return " ".join(pieces)


def png_chunk(kind: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)


def red_rectangle_data_uri() -> str:
    """A deterministic 640x320 RGB PNG, made with the standard library only."""
    width, height = 640, 320
    rows = []
    for y in range(height):
        row = bytearray([255, 255, 255]) * width
        if 60 <= y < 260:
            for x in range(120, 520):
                offset = x * 3
                row[offset:offset + 3] = b"\xff\x00\x00"
        rows.append(b"\0" + bytes(row))
    png = b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + png_chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode()


def cases(quick: bool) -> list[dict[str, Any]]:
    result = [
        {
            "name": "decode_256",
            "kind": "decode",
            "max_tokens": 256,
            "prompt": (
                "Return a sequence of simple lowercase English words separated by single spaces. "
                "Keep writing until the output limit. Do not explain the task, use headings, or stop early."
            ),
        },
        {
            "name": "vision_red_rectangle",
            "kind": "vision",
            "max_tokens": 16,
            "content": [
                {"type": "text", "text": "What color is the large rectangle? Reply with only its color."},
                {"type": "image_url", "image_url": {"url": red_rectangle_data_uri()}},
            ],
            "expect_contains": "red",
        },
        {
            "name": "prefill_1k",
            "kind": "prefill",
            "max_tokens": 16,
            # The numbered words deliberately tokenize to roughly seven tokens
            # each on Qwen.  These source sizes therefore yield actual server
            # prompts close to the names below; actual counts are always saved.
            "prompt": "Read this reference text and reply with exactly BENCHMARK-ACK.\n\n" + corpus(215, "a"),
        },
        {
            "name": "prefill_8k",
            "kind": "prefill",
            "max_tokens": 16,
            "prompt": "Read this reference text and reply with exactly BENCHMARK-ACK.\n\n" + corpus(1500, "b"),
        },
    ]
    if not quick:
        result.append(
            {
                "name": "prefill_32k",
                "kind": "prefill",
                "max_tokens": 16,
                "prompt": "Read this reference text and reply with exactly BENCHMARK-ACK.\n\n" + corpus(5200, "c"),
            }
        )
    return result


def request_case(base_url: str, model: str, case: dict[str, Any], timeout: int) -> dict[str, Any]:
    content = case["content"] if "content" in case else case["prompt"]
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": content}],
        "max_tokens": case["max_tokens"],
        "temperature": 0,
        "reasoning_effort": "none",
    }
    started = time.monotonic()
    response = post_json(f"{base_url}/v1/chat/completions", payload, timeout)
    wall_seconds = time.monotonic() - started
    metrics = get_json(f"{base_url}/metrics")
    recent = metrics.get("requests", [])
    engine = recent[0] if recent else {}
    usage = response.get("usage", {})
    timings = response.get("timings", {})
    # Old and new Strata APIs expose timings in slightly different places.
    prompt_tokens = usage.get("prompt_tokens", engine.get("prompt_tokens"))
    output_tokens = usage.get("completion_tokens", engine.get("output_tokens"))
    prompt_ms = timings.get("prompt_ms", engine.get("prompt_ms"))
    decode_ms = timings.get("predicted_ms", timings.get("decode_ms", engine.get("decode_ms")))
    decode_tok_s = timings.get("predicted_per_second", engine.get("decode_tok_s"))
    prompt_tok_s = timings.get("prompt_per_second")
    if prompt_tok_s is None and prompt_tokens and prompt_ms:
        prompt_tok_s = (float(prompt_tokens) / float(prompt_ms)) * 1000
    answer = response.get("choices", [{}])[0].get("message", {}).get("content", "")
    return {
        "wall_seconds": round(wall_seconds, 4),
        "prompt_tokens": prompt_tokens,
        "output_tokens": output_tokens,
        "prompt_ms": prompt_ms,
        "decode_ms": decode_ms,
        "prompt_tok_s": round(float(prompt_tok_s), 3) if prompt_tok_s is not None else None,
        "decode_tok_s": round(float(decode_tok_s), 3) if decode_tok_s is not None else None,
        "reused_tokens": usage.get("prompt_tokens_details", {}).get("cached_tokens", engine.get("reused", 0)),
        "hit_rate": engine.get("hit_rate"),
        "pcie_share": engine.get("pcie_share"),
        "ram_blobs": engine.get("ram_blobs"),
        "file_blobs": engine.get("file_blobs"),
        "file_mb": engine.get("file_mb"),
        "drafts_offered": timings.get("draft_n", engine.get("drafts_offered")),
        "drafts_accepted": timings.get("draft_accepted", engine.get("drafts_accepted")),
        "finish": engine.get("finish", response.get("choices", [{}])[0].get("finish_reason")),
        "answer_preview": answer[:160],
        "expectation_passed": (
            case.get("expect_contains", "").lower() in answer.lower() if case.get("expect_contains") else None
        ),
    }


def summarize(results: list[dict[str, Any]]) -> dict[str, Any]:
    expected = [row["expectation_passed"] for row in results if row["expectation_passed"] is not None]
    return {
        "runs": len(results),
        "prompt_tokens": median([row["prompt_tokens"] for row in results]),
        "output_tokens": median([row["output_tokens"] for row in results]),
        "prompt_tok_s": median([row["prompt_tok_s"] for row in results]),
        "decode_tok_s": median([row["decode_tok_s"] for row in results]),
        "wall_seconds": median([row["wall_seconds"] for row in results]),
        "hit_rate": median([row["hit_rate"] for row in results]),
        "pcie_share": median([row["pcie_share"] for row in results]),
        "ram_blobs": median([row["ram_blobs"] for row in results]),
        "file_mb": median([row["file_mb"] for row in results]),
        "expectation_passed": all(expected) if expected else None,
        "draft_acceptance": (
            round(sum(row["drafts_accepted"] or 0 for row in results) /
                  sum(row["drafts_offered"] or 1 for row in results), 3)
            if any(row["drafts_offered"] for row in results) else None
        ),
    }


def render_markdown(report: dict[str, Any]) -> str:
    lines = [
        "# Strata API benchmark",
        "",
        f"- Label: `{report['label']}`",
        f"- UTC: {report['created_at']}",
        f"- Server model: `{report['health'].get('model', 'unknown')}`",
        f"- Engine: `{report['metrics_before'].get('engine', {}).get('version', 'unknown')}`",
        f"- GPU: {report['metrics_before'].get('hardware_static', {}).get('gpu_name', 'unknown')}",
        f"- Repetitions: {report['repetitions']} (warm-up excluded)",
        "",
        "| Test | Prompt tok/s | Decode tok/s | Prompt tokens | Output tokens | Cache hit | PCIe share | Draft acceptance | Check |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for name, values in report["summary"].items():
        def shown(key: str, suffix: str = "") -> str:
            value = values.get(key)
            return "—" if value is None else f"{value}{suffix}"
        lines.append(
            f"| {name} | {shown('prompt_tok_s')} | {shown('decode_tok_s')} | "
            f"{shown('prompt_tokens')} | {shown('output_tokens')} | {shown('hit_rate')} | "
            f"{shown('pcie_share')} | {shown('draft_acceptance')} | "
            f"{'pass' if values['expectation_passed'] is True else ('fail' if values['expectation_passed'] is False else '—')} |"
        )
    lines.extend([
        "",
        "Notes: prompt/decode rates come from Strata's own request timing records. "
        "Each prefill prompt is unique, so cache reuse should normally be zero. Compare only runs with the "
        "same script version, repetition count, prompt sizes, sampling settings, model, and an otherwise idle GPU.",
        "",
    ])
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:8082")
    parser.add_argument("--model", help="Defaults to the model returned by /health.")
    parser.add_argument("--label", required=True, help="Comparison label, e.g. current-iq4xs or candidate-0.2.10.")
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--quick", action="store_true", help="Run 1K/8K prefill and decode only; omit 32K prefill.")
    parser.add_argument("--timeout", type=int, default=900, help="Per-request timeout in seconds.")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--strata-dir", type=Path, help="Optional Strata source directory to record its Git revision.")
    parser.add_argument("--config", type=Path, help="Optional server config JSON to fingerprint in the report.")
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be at least 1")

    base_url = args.base_url.rstrip("/")
    try:
        health = get_json(f"{base_url}/health")
        metrics_before = get_json(f"{base_url}/metrics")
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        print(f"Cannot reach Strata at {base_url}: {error}", file=sys.stderr)
        return 2
    if not health.get("loaded"):
        print(f"Strata at {base_url} is reachable but not loaded: {health}", file=sys.stderr)
        return 2
    model = args.model or health.get("model")
    if not model:
        print("No model supplied and /health did not identify one.", file=sys.stderr)
        return 2

    # Warm the engine without using a benchmark prompt or recording its timing.
    warm_case = {"prompt": "Reply with BENCHMARK-WARM.", "max_tokens": 8}
    print("Warming the server…", flush=True)
    request_case(base_url, model, warm_case, args.timeout)

    all_results: dict[str, list[dict[str, Any]]] = {}
    for case in cases(args.quick):
        print(f"Benchmarking {case['name']} ({args.repetitions} runs)…", flush=True)
        rows = []
        for run_number in range(1, args.repetitions + 1):
            # This marker changes the prompt from its first user-content tokens.
            # Strata can therefore not reuse a previous run's long prompt KV.
            run_case = dict(case)
            marker = f"Independent benchmark sample {case['name']} number {run_number}.\n\n"
            if "content" in case:
                run_case["content"] = [dict(part) for part in case["content"]]
                run_case["content"][0]["text"] = marker + run_case["content"][0]["text"]
            else:
                run_case["prompt"] = marker + case["prompt"]
            rows.append(request_case(base_url, model, run_case, args.timeout))
        all_results[case["name"]] = rows

    report = {
        "format_version": FORMAT_VERSION,
        "created_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "label": args.label,
        "repetitions": args.repetitions,
        "quick": args.quick,
        "base_url": base_url,
        "health": health,
        "metrics_before": metrics_before,
        "metrics_after": get_json(f"{base_url}/metrics"),
        "host": {"hostname": socket.gethostname(), "platform": platform.platform()},
        "strata_git_revision": git_revision(args.strata_dir),
        "config_sha256": file_sha256(args.config),
        "settings": {"temperature": 0, "reasoning_effort": "none"},
        "results": all_results,
        "summary": {name: summarize(rows) for name, rows in all_results.items()},
    }
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    safe_label = "".join(char if char.isalnum() or char in "-_" else "-" for char in args.label)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    base = args.output_dir / f"{timestamp}-{safe_label}"
    json_path = base.with_suffix(".json")
    markdown_path = base.with_suffix(".md")
    json_path.write_text(json.dumps(report, indent=2) + "\n")
    markdown_path.write_text(render_markdown(report))
    print(f"Wrote {json_path}")
    print(f"Wrote {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
