"""Server-only wrapper for the authoritative Supabase order lifecycle RPC."""

from typing import Any, Callable, Dict, Optional


STATUS_TRANSITIONS: Dict[str, str] = {
    "visualizing": "visualize_started",
    "await_image_pick": "visualize_candidates_ready",
    "materializing": "materialize_requested",
    "generating": "materialize_claimed",
    "fabrication_requested": "fabrication_requested",
    "repairing": "repair_started",
    "stl_ready": "stl_ready",
    "exporting": "export_requested",
    "slicing": "slice_requested",
    "paid": "payment_completed",
    "dispatching": "dispatch_requested",
    "printing": "printing_started",
    "done": "done",
    "generate_failed": "generate_failed",
    "repair_failed": "repair_failed",
    "slice_failed": "slice_failed",
    "dispatch_failed": "dispatch_failed",
    "needs_review": "needs_review",
    "cancelled": "cancelled",
}

TRANSITION_TARGETS: Dict[str, str] = {
    **{transition: status for status, transition in STATUS_TRANSITIONS.items()},
    "quote_ready": "ready_to_pay",
}


class LifecycleTransitionError(RuntimeError):
    def __init__(self, code: str, previous_status: Optional[str] = None):
        super().__init__(code)
        self.code = code
        self.previous_status = previous_status


def transition_order_lifecycle(
    rpc: Callable[[str, Dict[str, Any]], Any],
    order_id: str,
    transition: str,
    *,
    actor: str = "worker",
    event_phase: Optional[str] = None,
    event_message: Optional[str] = None,
    event_meta: Optional[Dict[str, Any]] = None,
    patch: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    target = TRANSITION_TARGETS.get(transition)
    if not target:
        raise LifecycleTransitionError("invalid_transition")

    result = rpc(
        "transition_order_lifecycle",
        {
            "p_order_id": order_id,
            "p_transition": transition,
            "p_expected_from": None,
            "p_to_status": target,
            "p_actor": actor,
            "p_idempotency_key": None,
            "p_event_phase": event_phase or transition,
            "p_event_message": event_message,
            "p_event_meta": event_meta or {},
            "p_patch": patch or {},
        },
    )
    if not isinstance(result, dict) or not result.get("ok"):
        payload = result if isinstance(result, dict) else {}
        raise LifecycleTransitionError(
            str(payload.get("error") or "lifecycle_transition_failed"),
            payload.get("previous_status"),
        )
    return result


def transition_status(
    rpc: Callable[[str, Dict[str, Any]], Any],
    order_id: str,
    status: str,
    **kwargs: Any,
) -> Dict[str, Any]:
    transition = STATUS_TRANSITIONS.get(str(status))
    if not transition:
        raise LifecycleTransitionError("invalid_transition")
    return transition_order_lifecycle(rpc, order_id, transition, **kwargs)


def transition_quote_ready(
    rpc: Callable[[str, Dict[str, Any]], Any],
    order_id: str,
    quote: Dict[str, Any],
) -> Dict[str, Any]:
    return transition_order_lifecycle(
        rpc,
        order_id,
        "quote_ready",
        event_phase="ready_to_pay",
        event_message="Quote ready",
        event_meta=quote,
        patch={"quote_json": quote},
    )
