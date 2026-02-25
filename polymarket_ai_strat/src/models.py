from sqlalchemy import Column, Integer, String, DateTime, create_engine, Float
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker


Base = declarative_base()


class Strategy(Base):
    __tablename__ = "strategies"
    id = Column(Integer, primary_key=True)
    name = Column(String, index=True)
    description = Column(String)
    created_at = Column(DateTime)


class PriceHistory(Base):
    __tablename__ = "price_history"
    id = Column(Integer, primary_key=True)
    market_id = Column(String, index=True)
    price = Column(Float)
    timestamp = Column(DateTime)
    created_at = Column(DateTime)


class Backtest(Base):
    __tablename__ = "backtests"

    id = Column(Integer, primary_key=True)
    created_at = Column(DateTime, index=True)  # Added index
    strategy = Column(String, index=True)  # Added index
    result = Column(String)


engine = create_engine("sqlite:///./trading.db")
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
