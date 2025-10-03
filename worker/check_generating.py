#!/usr/bin/env python3
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
REST_URL = f"{SUPABASE_URL}/rest/v1"

headers = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}

print("Checking GENERATING orders...")

with httpx.Client(timeout=10) as client:
    response = client.get(
        f"{REST_URL}/orders",
        headers=headers,
        params={"select": "*", "status": "eq.generating"}
    )
    
    if response.status_code == 200:
        orders = response.json()
        print(f"Found {len(orders)} GENERATING orders:")
        for order in orders:
            print(f"  - {order['id']}: worker_id={order.get('worker_id')}, locked_at={order.get('locked_at')}")
            
        # Reset them to 'new' status
        if orders:
            print("\nResetting to 'new' status...")
            for order in orders:
                client.patch(
                    f"{REST_URL}/orders",
                    headers=headers,
                    params={"id": f"eq.{order['id']}"},
                    json={"status": "new", "worker_id": None, "locked_at": None}
                )
            print("Done!")
    else:
        print(f"Error: {response.text}")