#!/usr/bin/env python3
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SERVICE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

print(f"SUPABASE_URL: {SUPABASE_URL}")
print(f"SERVICE_KEY: {SERVICE_KEY[:20]}..." if SERVICE_KEY else "SERVICE_KEY: None")

if not SUPABASE_URL or not SERVICE_KEY:
    print("ERROR: Missing environment variables")
    exit(1)

REST_URL = f"{SUPABASE_URL}/rest/v1"

headers = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

print("\nTesting Supabase connection...")

try:
    # Test 1: Get orders
    with httpx.Client(timeout=10) as client:
        response = client.get(
            f"{REST_URL}/orders",
            headers=headers,
            params={"select": "*", "limit": "5", "order": "created_at.desc"}
        )
        print(f"\nGET /orders status: {response.status_code}")
        if response.status_code == 200:
            orders = response.json()
            print(f"Found {len(orders)} orders")
            for order in orders:
                print(f"  - {order['id']}: status={order['status']}, prompt='{order.get('prompt_text', '')[:30]}...'")
        else:
            print(f"Error: {response.text}")

    # Test 2: Check for 'new' orders specifically
    with httpx.Client(timeout=10) as client:
        response = client.get(
            f"{REST_URL}/orders",
            headers=headers,
            params={"select": "*", "status": "eq.new", "limit": "5"}
        )
        print(f"\nGET /orders?status=eq.new status: {response.status_code}")
        if response.status_code == 200:
            new_orders = response.json()
            print(f"Found {len(new_orders)} NEW orders")
            for order in new_orders:
                print(f"  - {order['id']}: created at {order['created_at']}")
        else:
            print(f"Error: {response.text}")

except Exception as e:
    print(f"\nConnection error: {e}")
    print(f"Error type: {type(e).__name__}")