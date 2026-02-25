import os
import requests
from datetime import datetime
from models import PriceHistory
from sqlalchemy.orm import sessionmaker
from sqlalchemy import create_engine

# Validate API key is set
if not os.getenv("POLYMARKET_API_KEY"):
    raise ValueError("POLYMARKET_API_KEY must be set in environment")

# Configure database
engine = create_engine("sqlite:///./trading.db")
Session = sessionmaker(bind=engine)


def fetch_price_history(market_id, limit=100):
    url = f"https://api.polymarket.com/v1/markets/{market_id}/history"
    headers = {"Authorization": f"Bearer {os.getenv('POLYMARKET_API_KEY')}"}

    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status()

        data = response.json()

        with Session() as session:
            for entry in data["history"][:limit]:
                price = float(entry["price"])
                timestamp = datetime.fromisoformat(entry["timestamp"])

                session.add(
                    PriceHistory(market_id=market_id, price=price, timestamp=timestamp)
                )
            session.commit()

    except requests.exceptions.RequestException as e:
        raise Exception(f"History fetch failed: {str(e)}")
    except KeyError as e:
        raise Exception(f"Invalid history response format: missing {str(e)}")


def fetch_live_price_history(market_id, interval="1h", limit=100):
    url = f"https://api.polymarket.com/v1/markets/{market_id}/live-history"
    headers = {"Authorization": f"Bearer {os.getenv('POLYMARKET_API_KEY')}"}
    params = {"interval": interval, "limit": limit}

    try:
        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        data = response.json()

        return [
            {
                "timestamp": datetime.fromisoformat(entry["timestamp"]),
                "open": float(entry["open"]),
                "high": float(entry["high"]),
                "low": float(entry["low"]),
                "close": float(entry["close"]),
            }
            for entry in data.get("history", [])
        ]

    except requests.exceptions.RequestException as e:
        raise Exception(f"Live history fetch failed: {str(e)}")
    except KeyError as e:
        raise Exception(f"Invalid history response format: missing {str(e)}")


class MarketDataClient:
    def fetchLivePrice(self, market_id):
        url = f"https://api.polymarket.com/v1/markets/{market_id}/price"
        headers = {"Authorization": f"Bearer {os.getenv('POLYMARKET_API_KEY')}"}

        try:
            response = requests.get(url, headers=headers, timeout=30)
            response.raise_for_status()

            data = response.json()
            return {
                "price": float(data["price"]),
                "timestamp": datetime.fromisoformat(data["timestamp"]),
            }
        except requests.exceptions.RequestException as e:
            raise Exception(f"Live price fetch failed: {str(e)}")
        except KeyError as e:
            raise Exception(f"Invalid price response format: missing {str(e)}")
