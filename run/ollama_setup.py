# rev-a2b81d-20260901 ollama_setup.py
#!/usr/bin/env python3
"""
ollama_setup.py — Ollama setup script for Hermes Agent Desktop.
Checks if Ollama is installed, starts the service, and pulls Hermes model weights.
"""

import subprocess
import sys
import os
import json
import time
import urllib.request
import urllib.error
import shutil
from typing import Optional

OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_MODELS = ["hermes3:7b", "hermes4:8b"]
OLLAMA_INSTALL_URL = "https://ollama.com/install.sh"


def check_ollama_installed() -> bool:
    return shutil.which("ollama") is not None


def check_ollama_running() -> bool:
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE_URL}/api/tags", timeout=3) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError):
        return False


def start_ollama() -> Optional[subprocess.Popen]:
    """Start Ollama server in background. Returns the process handle."""
    print("[*] Starting Ollama server...")
    try:
        proc = subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        # Wait up to 10s for the server to become ready
        for _ in range(20):
            time.sleep(0.5)
            if check_ollama_running():
                print("[+] Ollama server started successfully.")
                return proc
        print("[-] Ollama server did not respond in time.")
        return None
    except FileNotFoundError:
        print("[-] ollama binary not found. Please install Ollama first.")
        return None


def list_local_models() -> list[str]:
    """Return names of models already pulled locally."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE_URL}/api/tags", timeout=5) as resp:
            data = json.loads(resp.read().decode())
            return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def pull_model(model_name: str) -> bool:
    """Pull a model from the Ollama registry with progress output."""
    print(f"\n[*] Pulling model: {model_name}")
    try:
        result = subprocess.run(
            ["ollama", "pull", model_name],
            check=False,
            timeout=1800,  # 30 min max for large models
        )
        if result.returncode == 0:
            print(f"[+] Successfully pulled: {model_name}")
            return True
        else:
            print(f"[-] Failed to pull {model_name} (exit code {result.returncode})")
            return False
    except subprocess.TimeoutExpired:
        print(f"[-] Timeout while pulling {model_name}")
        return False
    except FileNotFoundError:
        print("[-] ollama binary not found.")
        return False


def show_model_info(model_name: str) -> None:
    """Print model info from Ollama."""
    try:
        result = subprocess.run(
            ["ollama", "show", model_name, "--modelfile"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            print(f"\n--- Model info: {model_name} ---")
            print(result.stdout[:500])
    except Exception:
        pass


def install_ollama_linux() -> bool:
    """Attempt to install Ollama on Linux via the official install script."""
    print("[*] Attempting to install Ollama via official installer...")
    try:
        result = subprocess.run(
            ["bash", "-c", f"curl -fsSL {OLLAMA_INSTALL_URL} | sh"],
            check=False,
            timeout=120,
        )
        return result.returncode == 0
    except Exception as exc:
        print(f"[-] Installation failed: {exc}")
        return False


def write_config(base_url: str, models: list[str]) -> None:
    """Write Ollama configuration to agent-config.json."""
    config_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        "config", "agent-config.json",
    )
    if not os.path.exists(config_path):
        print(f"[!] Config file not found at {config_path}, skipping update.")
        return

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    config.setdefault("ollama", {})["baseUrl"] = base_url
    if models:
        config["model"]["model"] = models[0]
        config["ollama"]["modelFallbackChain"] = models

    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    print(f"[+] Updated {config_path}")


def main() -> int:
    print("=" * 60)
    print("  Hermes Agent Desktop — Ollama Setup")
    print("  Nous Research Hermes AI Agent")
    print("=" * 60)

    # ── 1. Check Ollama installation ──────────────────────────────
    if not check_ollama_installed():
        print("[-] Ollama is not installed.")
        if sys.platform.startswith("linux"):
            answer = input("  Install now? [y/N] ").strip().lower()
            if answer == "y":
                if not install_ollama_linux():
                    print("[-] Automatic installation failed.")
                    print("    Please install manually from: https://ollama.com")
                    return 1
            else:
                print("    Please install Ollama from: https://ollama.com")
                return 1
        else:
            print("    Please install Ollama from: https://ollama.com")
            return 1

    print("[+] Ollama is installed.")

    # ── 2. Ensure Ollama server is running ────────────────────────
    if not check_ollama_running():
        proc = start_ollama()
        if proc is None:
            print("[-] Could not start Ollama. Exiting.")
            return 1
    else:
        print("[+] Ollama server is already running.")

    # ── 3. Show already-available models ─────────────────────────
    local_models = list_local_models()
    if local_models:
        print(f"\n[*] Locally available models: {', '.join(local_models)}")
    else:
        print("\n[*] No models found locally.")

    # ── 4. Pull required Hermes models ───────────────────────────
    models_to_pull = [m for m in DEFAULT_MODELS if m not in local_models]
    if not models_to_pull:
        print("[+] All required Hermes models are already available.")
    else:
        print(f"\n[*] Models to pull: {', '.join(models_to_pull)}")
        for model in models_to_pull:
            pull_model(model)

    # ── 5. Show info for first available model ────────────────────
    available = list_local_models()
    hermes_models = [m for m in available if "hermes" in m.lower()]
    if hermes_models:
        show_model_info(hermes_models[0])

    # ── 6. Update config ──────────────────────────────────────────
    write_config(OLLAMA_BASE_URL, hermes_models or available[:2])

    print("\n[+] Setup complete. Hermes Agent Desktop is ready to run.")
    print(f"    Available Hermes models: {hermes_models or available}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
