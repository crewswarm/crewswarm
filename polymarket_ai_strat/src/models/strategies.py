from sqlalchemy.orm import Session

from models.strategy import Strategy


def get_strategy_by_id(db: Session, symbol: str, timeframe: str) -> Strategy:
    """Query a strategy by symbol and timeframe"""
    strategy = db.query(Strategy).filter(\n        Strategy.symbol == symbol,\n        Strategy.timeframe == timeframe\n    ).first()

    if not strategy:
        raise ValueError(f"Strategy {symbol} ({timeframe}) not found")

    return strategy