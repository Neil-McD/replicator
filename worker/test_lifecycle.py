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


def test_worker_requests_slice_queue_and_lifecycle_in_one_rpc():
    calls = []

    def rpc(name, params):
        calls.append((name, params))
        return {
            "ok": True,
            "job_id": "slice-job-atomic",
            "job_status": "pending",
            "reused": False,
            "completed": False,
            "lifecycle": {"ok": True, "new_status": "slicing"},
        }

    result = lifecycle.request_order_job(rpc, "order-atomic", "slice", source="fabrication_requested")
    assert result["job_id"] == "slice-job-atomic"
    assert calls == [("request_order_job", {
        "p_order_id": "order-atomic",
        "p_job_type": "slice",
        "p_actor": "worker",
        "p_requested_by": None,
        "p_target_max_dim_mm": None,
        "p_target_tolerance_mm": 0.1,
        "p_transform_asset_id": None,
        "p_source": "fabrication_requested",
        "p_event_message": None,
    })]


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
    import pytest

    def cancelled(*_args, **_kwargs):
        raise lifecycle.LifecycleTransitionError("cancelled", "cancelled")

    monkeypatch.setattr(main, "transition_status", cancelled)
    monkeypatch.setattr(main, "supabase_patch", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("direct patch called")))
    with pytest.raises(lifecycle.LifecycleTransitionError, match="cancelled"):
        main.set_status("order-cancelled", "repairing")


def test_worker_set_status_raises_on_rpc_outage_without_fallback(monkeypatch):
    import main
    import pytest

    monkeypatch.delenv("LIFECYCLE_DIRECT_STATUS_FALLBACK", raising=False)
    monkeypatch.setattr(main, "transition_status", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("rpc unavailable")))
    monkeypatch.setattr(main, "supabase_patch", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("direct patch called")))

    with pytest.raises(RuntimeError, match="rpc unavailable"):
        main.set_status("order-outage", "slicing")


def test_slice_job_stops_before_slicing_when_transition_is_rejected(monkeypatch):
    import main

    updates = []
    monkeypatch.setattr(main, "_skip_if_cancelled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(main, "set_status", lambda *_args, **_kwargs: (_ for _ in ()).throw(lifecycle.LifecycleTransitionError("invalid_transition")))
    monkeypatch.setattr(main, "process_slicing", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("slicer executed")))
    monkeypatch.setattr(main, "mark_export_job", lambda _job_id, patch: updates.append(patch))
    monkeypatch.setattr(main, "record_order_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "supabase_insert", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "log", lambda *_args, **_kwargs: None)

    try:
        main._process_slice_job({"id": "slice-1", "order_id": "order-1", "meta_json": {}})
    except lifecycle.LifecycleTransitionError:
        pass

    assert updates[0]["status"] == "failed"


def test_auto_stabilize_stops_before_repair_when_lifecycle_is_unavailable(monkeypatch):
    import main
    import pytest

    operations = []
    monkeypatch.setattr(main, "_skip_if_cancelled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        main,
        "set_status",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("lifecycle unavailable")),
    )
    monkeypatch.setattr(main, "repair", lambda *_args, **_kwargs: operations.append("repair_executed"))
    monkeypatch.setattr(main, "supabase_insert", lambda *_args, **_kwargs: operations.append("insert_executed"))

    with pytest.raises(RuntimeError, match="lifecycle unavailable"):
        main.auto_stabilize_mesh(
            {"id": "order-stabilize", "status": "generating"},
            "raw_glb",
            "https://example.com/raw.glb",
        )

    assert operations == []


def test_auto_stabilize_propagates_repair_failure_transition_outage(monkeypatch):
    import main
    import pytest

    transitions = []

    def set_status(_order_id, status):
        transitions.append(status)
        if status == "repair_failed":
            raise RuntimeError("lifecycle unavailable")
        return {"ok": True}

    monkeypatch.setattr(main, "_skip_if_cancelled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(main, "set_status", set_status)
    monkeypatch.setattr(main, "repair", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(main, "supabase_insert", lambda *_args, **_kwargs: None)

    with pytest.raises(RuntimeError, match="lifecycle unavailable"):
        main.auto_stabilize_mesh(
            {"id": "order-repair-failed", "status": "generating"},
            "raw_glb",
            "https://example.com/raw.glb",
        )

    assert transitions == ["repairing", "repair_failed"]


def test_claim_requeues_task_and_returns_none_when_lifecycle_rpc_is_unavailable(monkeypatch):
    import main

    patches = []
    claimed = [{
        "order_data": {"id": "order-claim", "status": "materializing"},
        "task_data": {"id": "task-claim", "status": "running"},
    }]
    monkeypatch.setattr(main, "_claim_backoff_wait", lambda: None)
    monkeypatch.setattr(main, "_claim_backoff_register_failure", lambda _exc: None)
    monkeypatch.setattr(main, "supabase_rpc", lambda *_args, **_kwargs: claimed)
    monkeypatch.setattr(main, "set_status", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("rpc unavailable")))
    monkeypatch.setattr(main, "supabase_patch", lambda table, filters, patch: patches.append((table, filters, patch)))

    assert main.claim_next_order() is None
    assert any(table == "generation_tasks" and patch["status"] == "queued" for table, _filters, patch in patches)


def test_dispatch_emits_link_only_after_printing_transition_succeeds(monkeypatch):
    import main
    import pytest

    inserts = []
    monkeypatch.setattr(main, "claim_next_export_job", lambda: None)
    monkeypatch.setattr(main, "claim_next_order", lambda: {"id": "order-dispatch", "status": "dispatching"})
    monkeypatch.setattr(main, "_skip_if_cancelled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(main, "latest_asset", lambda *_args, **_kwargs: {"url": "https://example.com/plate.3mf"})
    monkeypatch.setattr(main, "set_status", lambda *_args, **_kwargs: (_ for _ in ()).throw(lifecycle.LifecycleTransitionError("invalid_transition")))
    monkeypatch.setattr(main, "supabase_insert", lambda table, payload: inserts.append((table, payload)))
    monkeypatch.setattr(main, "log", lambda *_args, **_kwargs: None)

    with pytest.raises(lifecycle.LifecycleTransitionError):
        main.loop_once()

    assert not any(table == "chat_messages" and "Open to print" in payload["content_json"]["text"] for table, payload in inserts)


def test_dispatch_transitions_to_printing_then_emits_bambu_link(monkeypatch):
    import main

    operations = []
    monkeypatch.setattr(main, "claim_next_export_job", lambda: None)
    monkeypatch.setattr(main, "claim_next_order", lambda: {"id": "order-dispatch-ok", "status": "dispatching"})
    monkeypatch.setattr(main, "_skip_if_cancelled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(main, "latest_asset", lambda *_args, **_kwargs: {"url": "https://example.com/plate.3mf"})
    monkeypatch.setattr(main, "set_status", lambda _order_id, status: operations.append(("status", status)) or {"ok": True})
    monkeypatch.setattr(main, "supabase_insert", lambda table, payload: operations.append((table, payload)))
    monkeypatch.setattr(main, "log", lambda *_args, **_kwargs: None)

    assert main.loop_once() is True

    printing_index = operations.index(("status", "printing"))
    link_index = next(
        index
        for index, (kind, payload) in enumerate(operations)
        if kind == "chat_messages" and "Open to print: bambu-connect://" in payload["content_json"]["text"]
    )
    assert printing_index < link_index


def test_worker_claims_dispatching_order_then_prints_and_emits_bambu_link(monkeypatch):
    import main

    operations = []
    rpc_calls = []

    def rpc(name, params):
        rpc_calls.append((name, params))
        if name == "claim_dispatching_order":
            return {"id": "order-dispatch-claimed", "status": "dispatching"}
        raise AssertionError(f"unexpected RPC: {name}")

    monkeypatch.setattr(main, "claim_next_export_job", lambda: None)
    monkeypatch.setattr(main, "_claim_backoff_wait", lambda: None)
    monkeypatch.setattr(main, "supabase_rpc", rpc)
    monkeypatch.setattr(main, "_skip_if_cancelled", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(main, "latest_asset", lambda *_args, **_kwargs: {"url": "https://example.com/plate.3mf"})
    monkeypatch.setattr(main, "set_status", lambda _order_id, status: operations.append(("status", status)) or {"ok": True})
    monkeypatch.setattr(main, "supabase_insert", lambda table, payload: operations.append((table, payload)))
    monkeypatch.setattr(main, "log", lambda *_args, **_kwargs: None)

    assert main.loop_once() is True
    assert rpc_calls == [("claim_dispatching_order", {"p_worker_id": main.WORKER_ID})]
    printing_index = operations.index(("status", "printing"))
    link_index = next(
        index
        for index, (kind, payload) in enumerate(operations)
        if kind == "chat_messages" and "Open to print: bambu-connect://" in payload["content_json"]["text"]
    )
    assert printing_index < link_index


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
