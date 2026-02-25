from sqlalchemy import Column, String, Text\nfrom sqlalchemy.ext.declarative import declarative_base\nfrom sqlalchemy.orm import Session

Base = declarative_base()

from database import metadata


class Strategy(Base):
    __tablename__ = "strategies"

    __table_args__ = {'extend_existing': True}

    symbol = Column(String(50), primary_key=True)
    timeframe = Column(String(20), primary_key=True)
    strategy = Column(Text, nullable=False)
