#!/usr/bin/env python3
import os
import sys
import time
from dotenv import load_dotenv

# Add debug logging
def debug_log(msg):
    print(f"[DEBUG] {msg}", flush=True)

debug_log("Starting test_worker_debug.py")
debug_log(f"Current directory: {os.getcwd()}")
debug_log(f"Python path: {sys.path}")

debug_log("Loading .env file...")
load_dotenv()

debug_log("Importing main module...")
try:
    # Import the worker functions
    from main import claim_next_order, WORKER_ID, SUPABASE_URL, SERVICE_KEY
    debug_log(f"Successfully imported main module")
    debug_log(f"WORKER_ID: {WORKER_ID}")
    debug_log(f"SUPABASE_URL: {SUPABASE_URL}")
    debug_log(f"SERVICE_KEY: {SERVICE_KEY[:20]}..." if SERVICE_KEY else "SERVICE_KEY: None")
except Exception as e:
    debug_log(f"Error importing main: {e}")
    import traceback
    traceback.print_exc()
    exit(1)

debug_log("Testing claim_next_order()...")
try:
    order = claim_next_order()
    if order:
        debug_log(f"Claimed order: {order['id']}, status: {order['status']}")
    else:
        debug_log("No orders to claim")
except Exception as e:
    debug_log(f"Error claiming order: {e}")
    import traceback
    traceback.print_exc()

debug_log("Test complete")