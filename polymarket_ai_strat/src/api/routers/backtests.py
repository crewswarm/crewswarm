from fastapi import APIRouter, Query
import sqlite3
from datetime import datetime, timedelta

router = APIRouter()


@router.get("/backtests")
def get_backtests(start_date: str = Query(...), end_date: str = Query(...)):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    query = """
        SELECT id, created_at, strategy, result 
        FROM backtests
        WHERE created_at BETWEEN ? AND ?
        ORDER BY created_at
    """
    cursor.execute(query, (start_date, end_date))
    results = []
    while True:
        batch = cursor.fetchmany(1000)
        if not batch:
            break
        results.extend(
            [
                {
                    "id": row[0],
                    "created_at": row[1],
                    "strategy": row[2],
                    "result": row[3],
                }
                for row in batch
            ]
        )
    conn.close()
    return {"data": results}
