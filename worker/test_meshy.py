#!/usr/bin/env python3
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

MESHY_API_KEY = os.getenv("MESHY_API_KEY")
print(f"API Key: {MESHY_API_KEY[:10]}...")

# Try different payload formats
payloads = [
    # V2 format with mode
    {
        "mode": "preview",
        "prompt": "a small cube",
        "art_style": "realistic",
        "negative_prompt": ""
    },
    # Try refine mode
    {
        "mode": "refine",
        "prompt": "a small cube",
        "art_style": "realistic",
        "negative_prompt": ""
    },
    # Try different mode values
    {
        "mode": "text-to-3d",
        "prompt": "a small cube"
    }
]

headers = {
    "Authorization": f"Bearer {MESHY_API_KEY}",
    "Content-Type": "application/json"
}

for i, payload in enumerate(payloads):
    print(f"\nTrying payload {i+1}: {payload}")
    try:
        with httpx.Client() as client:
            response = client.post(
                "https://api.meshy.ai/v2/text-to-3d",
                headers=headers,
                json=payload
            )
            print(f"Status: {response.status_code}")
            print(f"Response: {response.text[:200]}...")
            if response.status_code == 200:
                print("SUCCESS!")
                break
    except Exception as e:
        print(f"Error: {e}")