import sys
from pathlib import Path

sys.path.append(str(Path(__file__).parent))
from migrations import run_migrations

if __name__ == "__main__":
    run_migrations()
