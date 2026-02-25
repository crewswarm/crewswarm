from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from src.database import get_db
from src.database import (
    create_strategy,
    get_strategies,
    get_strategy,
    update_strategy,
    delete_strategy,
)

router = APIRouter()


@router.post("/strategies")
def create_strategy_route(data: dict, db: Session = Depends(get_db)):
    return create_strategy(db, data)


@router.get("/strategies")
def get_strategies_route(db: Session = Depends(get_db)):
    return get_strategies(db)


@router.get("/strategies/{strategy_id}")
def get_strategy_route(strategy_id: int, db: Session = Depends(get_db)):
    return get_strategy(db, strategy_id)


@router.put("/strategies/{strategy_id}")
def update_strategy_route(strategy_id: int, data: dict, db: Session = Depends(get_db)):
    return update_strategy(db, strategy_id, data)


@router.delete("/strategies/{strategy_id}")
def delete_strategy_route(strategy_id: int, db: Session = Depends(get_db)):
    return delete_strategy(db, strategy_id)
