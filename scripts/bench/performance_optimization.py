#!/usr/bin/env python3
"""
Minimal performance benchmark script (synthetic fallback mode).

When --force-synthetic is passed, skips real HTTP requests and emits
synthetic benchmark data. This allows the test suite to verify the
tooling pipeline without a running server.

Usage:
  python3 scripts/bench/performance_optimization.py \
    --url http://127.0.0.1:4319/api/health \
    --profile all \
    --force-synthetic
"""

import argparse
import json
import sys


def synthetic_baseline(url):
    return {
        "url": url,
        "mode": "synthetic-fallback",
        "fallback_reason": "synthetic mode requested via --force-synthetic",
        "latency_ms": 0.1,
        "status": 200,
    }


def synthetic_profile(name, url):
    return {
        "name": name,
        "url": url,
        "metrics": {
            "mode": "synthetic-fallback",
            "latency_p50_ms": 0.1,
            "latency_p99_ms": 0.5,
            "success_rate": 1.0,
            "requests": 10,
        },
        "recommendations": [
            f"Enable caching for {name} profile to reduce latency",
        ],
    }


PROFILE_NAMES = ["throughput", "latency", "reliability"]


def main():
    parser = argparse.ArgumentParser(description="CrewSwarm performance benchmark")
    parser.add_argument("--url", required=True, help="Target URL to benchmark")
    parser.add_argument("--profile", default="all", help="Profile to run (or 'all')")
    parser.add_argument(
        "--force-synthetic",
        action="store_true",
        help="Use synthetic data instead of real HTTP requests",
    )
    args = parser.parse_args()

    if not args.force_synthetic:
        print(
            "Error: live benchmarking not implemented yet. Use --force-synthetic.",
            file=sys.stderr,
        )
        sys.exit(1)

    profiles = PROFILE_NAMES if args.profile == "all" else [args.profile]

    result = {
        "baseline": synthetic_baseline(args.url),
        "profiles": [synthetic_profile(p, args.url) for p in profiles],
    }

    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
