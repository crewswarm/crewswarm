1: from fastapi import FastAPI, HTTPException, Depends, status
2: from pydantic import BaseModel
3: from typing import Optional, List
4: import json
5: from sqlalchemy.orm import Session
6: from sqlalchemy import create_engine
7: from datetime import datetime
8: 
9: from ..models import Strategy, get_db
10: 
11: app = FastAPI()
12: 
13: # In-memory store
14: in_memory_strategies = {}
15: 
16: def update_in_memory_strategies(db: Session):
17:     global in_memory_strategies
18:     strategies = db.query(Strategy).all()
19:     in_memory_strategies = {s.id: s for s in strategies}
20:     return in_memory_strategies
21: 
22: # Strategy Pydantic models
23: 
24: 
25: class StrategyCreate(BaseModel):
26:     user_id: int
27:     name: str
28:     code: str
29:     parameters: Optional[dict] = None
30:     metrics: Optional[dict] = None
31: 
32: 
33: class StrategyUpdate(BaseModel):
34:     name: Optional[str] = None
35:     code: Optional[str] = None
36:     parameters: Optional[dict] = None
37:     metrics: Optional[dict] = None
38: 
39: 
40: class StrategyResponse(BaseModel):
41:     id: int
42:     user_id: int
43:     name: str
44:     code: str
45:     parameters: Optional[dict] = None
46:     metrics: Optional[dict] = None
47:     created_at: datetime
48: 
49:     class Config:
50:         from_attributes = True
51: 
52: 
53: @app.post("/api/strategies", status_code=status.HTTP_201_CREATED")
54: def create_strategy(
55:     strategy: StrategyCreate, db: Session = Depends(get_db)
56: ) -> StrategyResponse:
57:     db_strategy = Strategy(**strategy.model_dump())
58:     db.add(db_strategy)
59:     db.commit()
60:     db.refresh(db_strategy)
61:     update_in_memory_strategies(db)
62:     return db_strategy
63: 
64: 
65: @app.get("/api/strategies/{strategy_id}", response_model=StrategyResponse)
66: def get_strategy(strategy_id: int, db: Session = Depends(get_db)) -> Strategy:
67:     strategy = db.get(Strategy, strategy_id)
68:     if not strategy:
69:         raise HTTPException(status_code=404, detail="Strategy not found")
70:     return strategy
71: 
72: 
73: @app.get("/api/strategies", response_model=List[StrategyResponse])
74: def get_strategies(user_id: int, db: Session = Depends(get_db)) -> List[Strategy]:
75:     return db.query(Strategy).filter(Strategy.user_id == user_id).all()
76: 
77: 
78: @app.put("/api/strategies/{strategy_id}", response_model=StrategyResponse)
79: def update_strategy(
80:     strategy_id: int, strategy_update: StrategyUpdate, db: Session = Depends(get_db)
81: ) -> Strategy:
82:     db_strategy = db.get(Strategy, strategy_id)
83:     if not db_strategy:
84:         raise HTTPException(status_code=404, detail="Strategy not found")
85:     
86:     update_data = strategy_update.model_dump(exclude_unset=True)
87:     for key, value in update_data.items():
88:         setattr(db_strategy, key, value)
89:     
90:     db.commit()
91:     db.refresh(db_strategy)
92:     update_in_memory_strategies(db)
93:     return db_strategy
94: 
95: 
96: @app.delete("/api/strategies/{strategy_id}", status_code=status.HTTP_204_NO_CONTENT)
97: def delete_strategy(strategy_id: int, db: Session = Depends(get_db)):
98:     db_strategy = db.get(Strategy, strategy_id)
99:     if not db_strategy:
100:         raise HTTPException(status_code=404, detail="Strategy not found")
101:     db.delete(db_strategy)
102:     db.commit()
103:     update_in_memory_strategies(db)
104:     return {"status": "deleted"}
105: 
106: 
107: @app.get("/api")
108: def read_root():
109:     return {"status": "polymarket backtests service"}
110: 
111: 
112: if __name__ == "__main__":
113:     import uvicorn
114:     
115:     uvicorn.run(app, host="0.0.0.0", port=8000)