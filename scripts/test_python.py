"""Run isolated Python suites from the repository root."""
import argparse
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
SUITES = {
    "flybird": "providers/flybird/tests",
    "leapvpn": "providers/leapvpn/tests",
    "server": "apps/subscription-server/tests",
    "tooling": "tests",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", choices=SUITES, help="Run only one affected component")
    args = parser.parse_args()
    selected = [args.suite] if args.suite else SUITES
    for name in selected:
        print(f"Python suite: {name}", flush=True)
        result = subprocess.run(
            [sys.executable, "-B", "-m", "unittest", "discover", "-s", SUITES[name], "-p", "test_*.py"],
            cwd=ROOT,
            check=False,
        )
        if result.returncode:
            return result.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
