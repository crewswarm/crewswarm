from fastapi import FastAPI
from src.api.routers.backtests import router as backtest_router
from src.routers.strategy import router as strategies_router
from sqlalchemy import create_engine
from src.models import Base, Strategy, PriceHistory


engine = create_engine("sqlite:///strategies.db")

app = FastAPI()


@app.on_event("startup")
def create_tables():
    Base.metadata.create_all(engine)


app.include_router(backtest_router)
app.include_router(strategies_router)
