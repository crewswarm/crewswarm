from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
import databases
from sqlalchemy import create_engine, MetaData
from typing import List, Dict
import asyncio
import json

# Database setup
database = databases.Database("sqlite:///./trading.db")
metadata = MetaData()


# LLM Integration
class LLMClient:
    def generate_strategy(self, backtest_data: Dict) -> Dict:
        # Placeholder for LLM strategy generation logic
        return {"strategy": "generated_from_backtest"}


# Technical Indicators
def calculate_sma(prices: List[float], window: int = 20) -> List[float]:
    return [sum(prices[i - window : i]) / window for i in range(window, len(prices))]


def calculate_rsi(prices: List[float], window: int = 14) -> List[float]:
    # Simplified RSI calculation
    deltas = [prices[i] - prices[i - 1] for i in range(1, len(prices))]
    seed = deltas[0 : window + 1]
    up = sum(x for x in seed if x >= 0) / window
    down = abs(sum(x for x in seed if x < 0)) / window
    rs = up / down
    rsi = [100 - (100 / (1 + rs))]

    for i in range(window, len(deltas)):
        delta = deltas[i]
        if delta > 0:
            up = (up * (window - 1) + delta) / window
            down = (down * (window - 1)) / window
        else:
            up = (up * (window - 1)) / window
            down = (down * (window - 1) + abs(delta)) / window

        rs = up / down
        rsi.append(100 - (100 / (1 + rs)))
    return rsi


# WebSocket Price Handler
class PriceWebSocketManager:
    def __init__(self):
        self.active_connections = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast_price(self, price_data: Dict):
        for connection in self.active_connections:
            await connection.send_json(price_data)


price_manager = PriceWebSocketManager()

# FastAPI App
app = FastAPI()


# Dependency to get database connection
async def get_db():
    return database


app.add_event_handler("startup", startup_db)
    await database.connect()


@app.on_event("shutdown")
async def shutdown_db():
    await database.disconnect()


# Health Check Endpoint
@app.get("/health")
async def health_check():
    return {"status": "healthy", "database": "connected"}


# Strategy Creation Endpoint
class BacktestRequest(BaseModel):
    backtest_data: Dict
    symbol: str
    timeframe: str


@app.post("/api/strategies/from-backtest")
async def create_strategy_from_backtest(
    request: BacktestRequest, db: databases.Database = Depends(get_db)
):
    # Generate strategy using LLM
    llm_client = LLMClient()
    strategy = llm_client.generate_strategy(request.backtest_data)

    # Save strategy to database (simplified)
    query = "INSERT INTO strategies (symbol, timeframe, strategy) VALUES (:symbol, :timeframe, :strategy)"
    await db.execute(
        query,
        values={
            "symbol": request.symbol,
            "timeframe": request.timeframe,
            "strategy": json.dumps(strategy),
        },
    )

    return {"status": "success", "strategy": strategy}


# WebSocket Price Endpoint
@app.websocket("/ws/price")
async def websocket_endpoint(websocket: WebSocket):
    await price_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            # Process and broadcast price data
            price_data = json.loads(data)
            await price_manager.broadcast_price(price_data)
    except WebSocketDisconnect:
        price_manager.disconnect(websocket)


# Create tables (simplified)
@app.on_event("startup")
async def create_tables():
    engine = create_engine("sqlite:///./trading.db")
    metadata.create_all(bind=engine)
