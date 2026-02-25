from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from backend.database import get_db
from models import Strategy
from pydantic import BaseModel

router = APIRouter()


class StrategyCreate(BaseModel):
    name: str
    description: str
    parameters: dict


class StrategyRead(BaseModel):
    id: int
    name: str
    description: str
    parameters: dict


@router.post("/strategies", status_code=status.HTTP_201_CREATED)
def create_strategy(
    strategy: StrategyCreate, db: Session = Depends(get_db)
) -> StrategyRead:
    db_strategy = Strategy(**strategy.dict())
    db.add(db_strategy)
    db.commit()
    db.refresh(db_strategy)
    return StrategyRead.from_orm(db_strategy)


@router.get("/strategies/{strategy_id}")
def read_strategy(strategy_id: int, db: Session = Depends(get_db)) -> StrategyRead:
    db_strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if db_strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    return StrategyRead.from_orm(db_strategy)


@router.get("/strategies")
def list_strategies(db: Session = Depends(get_db)) -> list[StrategyRead]:
    strategies = db.query(Strategy).all()
    return [StrategyRead.from_orm(s) for s in strategies]


@router.put("/strategies/{strategy_id}")
def update_strategy(
    strategy_id: int, strategy: StrategyCreate, db: Session = Depends(get_db)
) -> StrategyRead:
    db_strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if db_strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    for key, value in strategy.dict().items():
        setattr(db_strategy, key, value)
    db.commit()
    db.refresh(db_strategy)
    return StrategyRead.from_orm(db_strategy)


@router.delete("/strategies/{strategy_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_strategy(strategy_id: int, db: Session = Depends(get_db)):
    db_strategy = db.query(Strategy).filter(Strategy.id == strategy_id).first()
    if db_strategy is None:
        raise HTTPException(status_code=404, detail="Strategy not found")
    db.delete(db_strategy)
    db.commit()
    return None
