from fastapi import FastAPI, HTTPException
from typing import Optional
import json
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

app = FastAPI()

# SQLite database setup
engine = create_engine("sqlite:///strategies.db")
Session = sessionmaker(bind=engine)
db = Session()

# Strategy model definition
from sqlalchemy import Column, Integer, String, Text, DateTime
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()


class Strategy(Base):
    __tablename__ = "strategies"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer)
    name = Column(String(255))
    code = Column(Text)
    parameters = Column(String(2048))
    metrics = Column(String(2048))
    created_at = Column(DateTime)


@app.get("/api/strategies/{strategy_id}")
def get_strategy(strategy_id: int):
    strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if not strategy:
        raise HTTPException(status_code=404, detail="Strategy not found")

    # Deserialize JSON fields if present
    if isinstance(strategy.parameters, str):
        strategy.parameters = json.loads(strategy.parameters)
    if isinstance(strategy.metrics, str):
        strategy.metrics = json.loads(strategy.metrics)

    return {
        "id": strategy.id,
        "user_id": strategy.user_id,
        "name": strategy.name,
        "code": strategy.code,
        "parameters": strategy.parameters,
        "metrics": strategy.metrics,
        "created_at": strategy.created_at,
    }


@app.get("/api/strategies")
def get_strategies(user_id: int, offset: int = 0, limit: int = 100):
    strategies = db.query(Strategy).filter(Strategy.user_id == user_id).all()
    result = []
    for strategy in strategies:
        # Deserialize JSON fields if present
        if isinstance(strategy.parameters, str):
            strategy.parameters = json.loads(strategy.parameters)
        if isinstance(strategy.metrics, str):
            strategy.metrics = json.loads(strategy.metrics)
        result.append(
            {
                "id": strategy.id,
                "name": strategy.name,
                "code": strategy.code,
                "parameters": strategy.parameters,
                "metrics": strategy.metrics,
                "created_at": strategy.created_at,
            }
        )
    return result


@app.get("/api")
def read_root():
    return {"status": "polymarket backtests service"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
