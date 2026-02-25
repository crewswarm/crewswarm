from fastapi import APIRouter
from src.models import PriceHistory, get_db
from sqlalchemy.orm import Session
from pydantic import BaseModel
from datetime import datetime

router = APIRouter()


class PriceCreate(BaseModel):
    symbol: str
    price: float


@router.post("/api/prices")
def create_price(price_data: PriceCreate, db: Session = Depends(get_db)):
    db_price = PriceHistory(
        symbol=price_data.symbol, price=price_data.price, timestamp=datetime.utcnow()
    )
    db.add(db_price)
    db.commit()
    db.refresh(db_price)
    return db_price
