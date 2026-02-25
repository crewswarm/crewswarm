from sqlalchemy import create_engine, MetaData

engine = create_engine("sqlite:///./trading.db")
metadata = MetaData()

Base = declarative_base()
