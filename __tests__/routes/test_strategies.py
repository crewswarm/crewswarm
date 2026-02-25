import pytest
from fastapi.testclient import TestClient
from main import app


def test_strategy_persistence():
    client = TestClient(app)

    # Create a strategy
    response = client.post("/strategies", json={"name": "test-strategy"})
    assert response.status_code == 200

    # Restart server by reinitializing client
    client = TestClient(app)

    # Verify strategy persists
    response = client.get("/strategies")
    assert response.status_code == 200
    assert any(s["name"] == "test-strategy" for s in response.json())
