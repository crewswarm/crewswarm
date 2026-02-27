from fastapi import APIRouter, Query
import sqlite3
from datetime import datetime, timedelta

router = APIRouter()


@router.get("/backtests")
def get_backtests(start_date: str = Query(...), end_date: str = Query(...)):
    conn = sqlite3.connect("database.db")
    cursor = conn.cursor()
    query = """
        SELECT * 
        FROM backtests
        WHERE created_at BETWEEN ? AND ?
        ORDER BY created_at
    """
    cursor.execute(query, (start_date, end_date))
    results = cursor.fetchall()
    conn.close()
    return {"data": results}
