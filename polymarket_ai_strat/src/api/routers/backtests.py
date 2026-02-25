from fastapi import APIRouter, Query
import requests
from src.models.price_history import PriceHistory
from datetime import datetime, timedelta

router = APIRouter()


@router.post("/backtests")
def get_backtests(
    start_date: str = Query(...),
    end_date: str = Query(...),
    page: int = 1,
    page_size: int = 100,
):
    # Fetch paginated data from external API
    base_url = "https://api.example.com/backtests"
    params = {
        "start_date": start_date,
        "end_date": end_date,
        "page": page,
        "page_size": page_size,
    }

    all_results = []
    while True:
        start_time = datetime.now()
        response = requests.get(base_url, params=params)
        print(f"API request took: {datetime.now() - start_time}")
        data = response.json()
        if not data:
            break

        start_insert = datetime.now()
        PriceHistory.objects.bulk_create(PriceHistory(**item) for item in data)
        print(f"Bulk insert took: {datetime.now() - start_insert}")

        all_results.extend(data)

        # Update page for next iteration
        params["page"] = page + 1
        page += 1
    return {"data": all_results}
