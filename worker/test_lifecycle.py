import lifecycle


def test_transition_status_maps_repair_failure_to_authoritative_rpc():
    calls = []

    def rpc(name, params):
        calls.append((name, params))
        return {
            "ok": True,
            "previous_status": "repairing",
            "new_status": "repair_failed",
            "changed": True,
            "reused": False,
        }

    lifecycle.transition_status(rpc, "order-1", "repair_failed")
    assert calls[0][0] == "transition_order_lifecycle"
    assert calls[0][1]["p_transition"] == "repair_failed"
    assert calls[0][1]["p_to_status"] == "repair_failed"


def test_transition_status_maps_slice_and_dispatch_outcomes():
    transitions = []

    def rpc(_name, params):
        transitions.append(params["p_transition"])
        return {
            "ok": True,
            "previous_status": "slicing",
            "new_status": params["p_to_status"],
            "changed": True,
            "reused": False,
        }

    lifecycle.transition_status(rpc, "order-2", "slice_failed")
    lifecycle.transition_status(rpc, "order-2", "dispatching")
    lifecycle.transition_status(rpc, "order-2", "printing")
    lifecycle.transition_status(rpc, "order-2", "stl_ready")
    assert transitions == ["slice_failed", "dispatch_requested", "printing_started", "stl_ready"]


def test_quote_success_preserves_quote_in_atomic_patch():
    captured = {}
    quote = {"minutes": 73, "grams": 41, "total_cents": 1840}

    def rpc(_name, params):
        captured.update(params)
        return {
            "ok": True,
            "previous_status": "slicing",
            "new_status": "ready_to_pay",
            "changed": True,
            "reused": False,
        }

    lifecycle.transition_quote_ready(rpc, "order-3", quote)
    assert captured["p_transition"] == "quote_ready"
    assert captured["p_patch"]["quote_json"] == quote


def test_cancelled_result_is_not_treated_as_success():
    def rpc(_name, _params):
        return {"ok": False, "error": "cancelled", "previous_status": "cancelled"}

    try:
        lifecycle.transition_status(rpc, "order-4", "repairing")
    except lifecycle.LifecycleTransitionError as exc:
        assert exc.code == "cancelled"
        assert exc.previous_status == "cancelled"
    else:
        raise AssertionError("cancelled transition should fail")


def test_worker_set_status_does_not_overwrite_cancelled(monkeypatch):
    import main

    def cancelled(*_args, **_kwargs):
        raise lifecycle.LifecycleTransitionError("cancelled", "cancelled")

    monkeypatch.setattr(main, "transition_status", cancelled)
    monkeypatch.setattr(main, "supabase_patch", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("direct patch called")))
    main.set_status("order-cancelled", "repairing")


def test_export_completion_maps_to_stl_ready(monkeypatch):
    import main

    statuses = []
    monkeypatch.setattr(main, "mark_export_job", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "log", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "set_status", lambda order_id, status: statuses.append((order_id, status)))
    monkeypatch.setattr(main, "record_order_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "sign_or_direct", lambda *_args, **_kwargs: None)

    main.complete_export_job(
        {"id": "job-1", "order_id": "order-5", "meta_json": {}},
        {"id": "asset-1"},
        None,
        100.0,
        "sha",
        "supabase://artifacts/order-5/mesh.stl",
    )
    assert statuses == [("order-5", "stl_ready")]
