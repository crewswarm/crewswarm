from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session
from models.strategy import Strategy
from database import get_db
from pydantic import BaseModel


class StrategyCreate(BaseModel):
    symbol: str
    timeframe: str
    strategy: str


router = APIRouter()


@router.post("/strategies", status_code=status.HTTP_201_CREATED)
def create_strategy(strategy_data: StrategyCreate, db: Session = Depends(get_db)):
    db_strategy = Strategy(**strategy_data.dict())
    db.add(db_strategy)
    db.commit()
    db.refresh(db_strategy)
    return db_strategy
