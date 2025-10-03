#!/usr/bin/env python3
import os
from dotenv import load_dotenv

def debug_log(msg):
    print(f"[DEBUG] {msg}", flush=True)

load_dotenv()

debug_log("Testing generate function...")

from main import generate, _meshy_generate

# Test order
test_order = {
    "id": "test-123",
    "prompt_text": "small cube",
    "status": "new"
}

debug_log(f"Testing with order: {test_order}")

try:
    # Test Meshy generation directly
    debug_log("Testing _meshy_generate directly...")
    result = _meshy_generate("small cube")
    if result:
        ext, content = result
        debug_log(f"Meshy generated: {ext} file with {len(content)} bytes")
    else:
        debug_log("Meshy generation returned None")
        
    # Test full generate function
    debug_log("\nTesting full generate function...")
    gen_result = generate(test_order)
    if gen_result:
        kind, url = gen_result
        debug_log(f"Generated: {kind} at {url}")
    else:
        debug_log("Generate returned None")
        
except Exception as e:
    debug_log(f"Error: {e}")
    import traceback
    traceback.print_exc()