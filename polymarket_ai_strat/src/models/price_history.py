from pydantic import BaseModel


class PriceHistory(BaseModel):
    symbol: str
    price: float
    timestamp: int
