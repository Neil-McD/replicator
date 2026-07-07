from __future__ import annotations

from typing import Any, Dict, Iterable, Optional

ORDER_STATUSES = {
    "new",
    "visualizing",
    "await_image_pick",
    "materializing",
    "generating",
    "repairing",
    "slicing",
    "ready_to_pay",
    "paid",
    "dispatching",
    "printing",
    "done",
    "needs_review",
    "generate_failed",
    "repair_failed",
    "slice_failed",
    "dispatch_failed",
    "cancelled",
}

TRANSITION_AUTHORITIES = {"chat", "visualize", "materialize", "worker", "stripe", "operator", "user", "catalog"}

ORDER_TRANSITIONS = {
    ("materializing", "generating"): {"worker"},
    ("generating", "repairing"): {"worker"},
    ("generating", "generate_failed"): {"worker"},
    ("generating", "needs_review"): {"worker"},
    ("repairing", "slicing"): {"worker"},
    ("repairing", "repair_failed"): {"worker"},
    ("repairing", "needs_review"): {"worker"},
    ("slicing", "ready_to_pay"): {"worker"},
    ("slicing", "slice_failed"): {"worker"},
    ("paid", "dispatching"): {"worker", "operator"},
    ("dispatching", "printing"): {"worker", "operator"},
    ("printing", "done"): {"worker", "operator"},
}

TERMINAL_STATUSES = {"done", "cancelled"}


def can_transition(from_status: Optional[str], to_status: str, authority: str = "worker") -> bool:
    if to_status not in ORDER_STATUSES or authority not in TRANSITION_AUTHORITIES:
        return False
    if from_status and from_status not in ORDER_STATUSES:
        return False
    if from_status in TERMINAL_STATUSES and from_status != to_status:
        return False
    if from_status == to_status:
        return True
    if to_status == "cancelled" and authority in {"user", "operator"}:
        return True
    return authority in ORDER_TRANSITIONS.get((from_status, to_status), set())


def transition_payload(
    order_id: str,
    to_status: str,
    authority: str = "worker",
    expected_from: Optional[Iterable[str]] = None,
    idempotency_key: Optional[str] = None,
    meta_json: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    return {
        "p_order_id": order_id,
        "p_to_status": to_status,
        "p_authority": authority,
        "p_expected_from": list(expected_from) if expected_from else None,
        "p_idempotency_key": idempotency_key or f"{authority}:{order_id}:{to_status}",
        "p_meta_json": meta_json or {},
    }
