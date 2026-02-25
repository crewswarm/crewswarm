import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from src.api.routers.main import app, get_db
from src.models import Base, Strategy

# Setup test database
TEST_DATABASE_URL = "sqlite:///./test_strategies.db"
test_engine = create_engine(
    TEST_DATABASE_URL, connect_args={"check_same_thread": False}
)
TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=test_engine)


# Override get_db dependency to use test database
def override_get_db():
    db = TestSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db

client = TestClient(app)


@pytest.fixture(autouse=True)
def setup_database():
    # Create tables
    Base.metadata.create_all(bind=test_engine)
    # Run tests
    yield
    # Clean up database
    Base.metadata.drop_all(bind=test_engine)


def test_create_strategy():
    response = client.post(
        "/api/strategies",
        json={
            "user_id": 1,
            "name": "Test Strategy",
            "code": "print('Hello World')",
            "parameters": {"param1": 42},
            "metrics": {"accuracy": 0.9},
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Test Strategy"
    assert data["parameters"] == {"param1": 42}
    assert data["metrics"] == {"accuracy": 0.9}


def test_get_strategy():
    # First create a strategy
    create_response = client.post(
        "/api/strategies",
        json={"user_id": 1, "name": "Test Strategy", "code": "print('Hello World')"},
    )
    strategy_id = create_response.json()["id"]

    response = client.get(f"/api/strategies/{strategy_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Test Strategy"


def test_get_strategies():
    # Create multiple strategies
    client.post(
        "/api/strategies", json={"user_id": 1, "name": "Strategy 1", "code": "..."}
    )
    client.post(
        "/api/strategies", json={"user_id": 1, "name": "Strategy 2", "code": "..."}
    )

    response = client.get("/api/strategies?user_id=1")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2


def test_update_strategy():
    # Create strategy first
    create_response = client.post(
        "/api/strategies",
        json={"user_id": 1, "name": "Original Name", "code": "original code"},
    )
    strategy_id = create_response.json()["id"]

    response = client.put(
        f"/api/strategies/{strategy_id}",
        json={"name": "Updated Name", "code": "updated code"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Name"
    assert data["code"] == "updated code"


def test_delete_strategy():
    # Create strategy first
    create_response = client.post(
        "/api/strategies", json={"user_id": 1, "name": "ToDelete", "code": "delete me"}
    )
    strategy_id = create_response.json()["id"]

    response = client.delete(f"/api/strategies/{strategy_id}")
    assert response.status_code == 204

    # Verify it's deleted
    get_response = client.get(f"/api/strategies/{strategy_id}")
    assert get_response.status_code == 404
