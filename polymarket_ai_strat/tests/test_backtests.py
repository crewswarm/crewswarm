import pytest
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).parent.parent))
from fastapi.testclient import TestClient
from src.main import app

client = TestClient(app)


def test_backtest_endpoint_use_live():
    response = client.post("/backtests", json={"use_live": True})
    assert response.status_code == 200
    assert "live_data" in response.json()


def test_backtest_endpoint_no_use_live():
    response = client.post("/backtests", json={"use_live": False})
    assert response.status_code == 200
    assert "historical_data" in response.json()
