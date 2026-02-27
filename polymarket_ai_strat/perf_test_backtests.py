import time
import requests

start_time = time.time()
response = requests.get(
    "http://localhost:8000/backtests",
    params={"start_date": "2023-01-01", "end_date": "2024-01-01"},
)
elapsed_time = time.time() - start_time

assert response.status_code == 200
assert elapsed_time < 10, f"Test failed: {elapsed_time:.2f}s > 10s"
print(f"Test passed in {elapsed_time:.2f} seconds")
