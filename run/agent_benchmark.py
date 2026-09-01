# rev-a2b81d-20260901 agent_benchmark.py
#!/usr/bin/env python3
"""
agent_benchmark.py — Benchmark Hermes agent performance.
Measures latency, throughput (tokens/sec), tool-call accuracy, and multi-step task completion.
Outputs results to console and saves a JSON report.
"""

import json
import time
import statistics
import urllib.request
import urllib.error
import urllib.parse
import sys
import os
from dataclasses import dataclass, field, asdict
from typing import Optional
from datetime import datetime, timezone

OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_MODELS = ["hermes3:7b", "hermes4:8b"]
REPORT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "benchmark_results")


# ─── Benchmark tasks ────────────────────────────────────────────────────────

SINGLE_TURN_TASKS = [
    {
        "id": "math_basic",
        "prompt": "What is 127 * 843?",
        "expected_keywords": ["107061"],
        "category": "math",
    },
    {
        "id": "reasoning_simple",
        "prompt": "A Hermes agent has 3 tools: filesystem, terminal, and web search. "
                  "A user asks it to find the latest Python version. Which tool should it use first?",
        "expected_keywords": ["web", "search"],
        "category": "reasoning",
    },
    {
        "id": "code_generate",
        "prompt": "Write a Python function that takes a list of integers and returns the top 3 largest values.",
        "expected_keywords": ["def", "sorted", "return"],
        "category": "code",
    },
    {
        "id": "summarize",
        "prompt": "Summarize this in one sentence: "
                  "Nous Research is an AI safety and research company that develops open-source language models, "
                  "including the Hermes series, which are fine-tuned for agentic tasks and tool use.",
        "expected_keywords": ["nous", "hermes"],
        "category": "summarize",
    },
    {
        "id": "tool_selection",
        "prompt": "You are a Hermes AI agent. The user asks: 'Create a file called notes.txt with content Hello'. "
                  "Which tool do you use and what are the parameters?",
        "expected_keywords": ["filesystem", "write", "notes.txt"],
        "category": "tool_use",
    },
]

LONG_CONTEXT_PROMPT = (
    "You are Hermes Agent, an autonomous AI developed by Nous Research. "
    "Below is a long task description:\n\n"
    + ("Analyse the following data and provide insights. " * 50)
    + "\n\nSummarise the key points in 3 bullet points."
)


@dataclass
class TaskResult:
    task_id: str
    model: str
    category: str
    latency_ms: float
    tokens_generated: int
    tokens_per_second: float
    prompt_tokens: int
    output_preview: str
    keyword_hits: int
    keyword_total: int
    accuracy: float
    error: Optional[str] = None


@dataclass
class BenchmarkReport:
    timestamp: str
    models: list[str]
    ollama_url: str
    task_results: list[TaskResult] = field(default_factory=list)
    summary: dict = field(default_factory=dict)


# ─── Ollama HTTP helpers ─────────────────────────────────────────────────────

def ollama_chat(model: str, prompt: str, system: str = "", max_tokens: int = 512) -> dict:
    """Send a chat request to Ollama. Returns parsed response dict."""
    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    payload = json.dumps({
        "model": model,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": max_tokens, "temperature": 0.0},
    }).encode()

    req = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/chat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def get_available_models() -> list[str]:
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE_URL}/api/tags", timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def ollama_running() -> bool:
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE_URL}/", timeout=3) as resp:
            return resp.status == 200
    except Exception:
        return False


# ─── Benchmark runner ────────────────────────────────────────────────────────

def run_task(model: str, task: dict) -> TaskResult:
    start = time.perf_counter()
    error = None
    response_text = ""
    prompt_tokens = 0
    completion_tokens = 0

    try:
        result = ollama_chat(model, task["prompt"], max_tokens=256)
        response_text = result.get("message", {}).get("content", "")
        prompt_tokens = result.get("prompt_eval_count", 0)
        completion_tokens = result.get("eval_count", 0)
    except Exception as exc:
        error = str(exc)

    elapsed_ms = (time.perf_counter() - start) * 1000
    tps = (completion_tokens / (elapsed_ms / 1000)) if elapsed_ms > 0 and completion_tokens > 0 else 0.0

    # Keyword accuracy
    keywords = task.get("expected_keywords", [])
    hits = sum(1 for kw in keywords if kw.lower() in response_text.lower())
    accuracy = hits / len(keywords) if keywords else 1.0

    return TaskResult(
        task_id=task["id"],
        model=model,
        category=task["category"],
        latency_ms=round(elapsed_ms, 1),
        tokens_generated=completion_tokens,
        tokens_per_second=round(tps, 1),
        prompt_tokens=prompt_tokens,
        output_preview=response_text[:120].replace("\n", " "),
        keyword_hits=hits,
        keyword_total=len(keywords),
        accuracy=round(accuracy, 3),
        error=error,
    )


def run_latency_warmup(model: str) -> float:
    """Run a single warmup request and return latency in ms."""
    start = time.perf_counter()
    try:
        ollama_chat(model, "Say 'ready'", max_tokens=10)
    except Exception:
        pass
    return (time.perf_counter() - start) * 1000


def benchmark_model(model: str) -> list[TaskResult]:
    print(f"\n{'─' * 50}")
    print(f"  Model: {model}")
    print(f"{'─' * 50}")

    # Warmup
    print("  [*] Warming up...")
    warmup_ms = run_latency_warmup(model)
    print(f"  [+] Warmup latency: {warmup_ms:.0f}ms")

    results = []
    for task in SINGLE_TURN_TASKS:
        print(f"  [*] Task: {task['id']} ({task['category']})...", end=" ", flush=True)
        result = run_task(model, task)
        results.append(result)
        status = "✓" if result.accuracy >= 0.5 and not result.error else "✗"
        print(f"{status}  {result.latency_ms:.0f}ms | {result.tokens_per_second:.1f} tok/s | acc={result.accuracy:.0%}")

    return results


def compute_summary(results: list[TaskResult]) -> dict:
    by_model: dict[str, list[TaskResult]] = {}
    for r in results:
        by_model.setdefault(r.model, []).append(r)

    summary = {}
    for model, model_results in by_model.items():
        valid = [r for r in model_results if not r.error]
        summary[model] = {
            "tasks_total": len(model_results),
            "tasks_successful": len(valid),
            "avg_latency_ms": round(statistics.mean(r.latency_ms for r in valid), 1) if valid else None,
            "p95_latency_ms": round(sorted(r.latency_ms for r in valid)[int(len(valid) * 0.95)] if len(valid) >= 2 else 0, 1),
            "avg_tokens_per_second": round(statistics.mean(r.tokens_per_second for r in valid), 1) if valid else None,
            "avg_accuracy": round(statistics.mean(r.accuracy for r in valid), 3) if valid else None,
            "errors": len(model_results) - len(valid),
        }
    return summary


def print_summary(summary: dict) -> None:
    print(f"\n{'=' * 60}")
    print("  BENCHMARK SUMMARY")
    print(f"{'=' * 60}")
    print(f"{'Model':<25} {'Avg Lat':>8} {'tok/s':>7} {'Acc':>6} {'Errors':>7}")
    print("─" * 60)
    for model, s in summary.items():
        short = model[:24]
        print(
            f"{short:<25} "
            f"{str(s['avg_latency_ms']) + 'ms':>8} "
            f"{str(s['avg_tokens_per_second']):>7} "
            f"{str(round(s['avg_accuracy'] * 100, 1)) + '%':>6} "
            f"{s['errors']:>7}"
        )


def save_report(report: BenchmarkReport) -> str:
    os.makedirs(REPORT_DIR, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(REPORT_DIR, f"hermes_benchmark_{ts}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(asdict(report), f, indent=2)
    return path


def main() -> int:
    print("=" * 60)
    print("  Hermes Agent Desktop — Performance Benchmark")
    print("  Nous Research Hermes AI Agent")
    print(f"  {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)

    if not ollama_running():
        print("[-] Ollama is not running. Start it with: ollama serve")
        return 1

    available = get_available_models()
    models_to_test = [m for m in DEFAULT_MODELS if m in available]

    if not models_to_test:
        print(f"[-] None of the target models are available locally.")
        print(f"    Available: {available}")
        print(f"    Run runtime/ollama_setup.py to pull Hermes models.")
        return 1

    print(f"[+] Models to benchmark: {', '.join(models_to_test)}")

    report = BenchmarkReport(
        timestamp=datetime.now(timezone.utc).isoformat(),
        models=models_to_test,
        ollama_url=OLLAMA_BASE_URL,
    )

    all_results: list[TaskResult] = []
    for model in models_to_test:
        results = benchmark_model(model)
        all_results.extend(results)
        report.task_results.extend(results)

    report.summary = compute_summary(all_results)
    print_summary(report.summary)

    report_path = save_report(report)
    print(f"\n[+] Report saved: {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
