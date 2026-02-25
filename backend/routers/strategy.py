from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from models.strategy import Strategy, Base
from database import engine, get_db
from pydantic import BaseModel
from datetime import datetime

router = APIRouter()


class StrategyCreate(BaseModel):
    name: str
    description: str


class StrategyResponse(BaseModel):
    id: int
    name: str
    description: str
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# Create database tables
Base.metadata.create_all(bind=engine)


@router.post("/strategies", response_model=StrategyResponse)
def create_strategy(strategy: StrategyCreate, db: Session = Depends(get_db)):
    db_strategy = Strategy(name=strategy.name, description=strategy.description)
    db.add(db_strategy)
    db.commit()
    db.refresh(db_strategy)
    return db_strategy


@router.get("/strategies", response_model=list[StrategyResponse])
def get_strategies(db: Session = Depends(get_db)):
    return db.query(Strategy).all()


@router.get("/strategies/{strategy_id}", response_model=StrategyResponse)
def get_strategy(strategy_id: int, db: Session = Depends(get_db)):
    db_strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if db_strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return db_strategy


@router.put("/strategies/{strategy_id}", response_model=StrategyResponse)
def update_strategy(
    strategy_id: int, strategy: StrategyCreate, db: Session = Depends(get_db)
):
    db_strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if db_strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    db_strategy.name = strategy.name
    db_strategy.description = strategy.description
    db.commit()
    db.refresh(db_strategy)
    return db_strategy


@router.delete("/strategies/{strategy_id}", response_model=StrategyResponse)
def delete_strategy(strategy_id: int, db: Session = Depends(get_db)):
    db_strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if db_strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    db.delete(db_strategy)
    db.commit()
    return db_strategy
