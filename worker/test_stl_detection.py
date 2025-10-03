from pathlib import Path

from main import _looks_like_binary_stl, _guess_ext_from_content, _binary_stl_face_count


def _load_fixture_bytes(name: str) -> bytes:
    root = Path(__file__).resolve().parent.parent
    return (root / name).read_bytes()


def test_detects_binary_stl_even_when_mislabelled():
    data = _load_fixture_bytes("print-ready.stl")
    assert _looks_like_binary_stl(data)
    # Even if a caller hints OBJ, sniffing should promote STL.
    assert _guess_ext_from_content(data, fallback="obj") == "stl"
    assert _binary_stl_face_count(data) and _binary_stl_face_count(data) > 0


def test_does_not_flag_basic_glb_payload():
    # Minimal glb header: magic + version + total length.
    glb_stub = b"glTF" + (2).to_bytes(4, "little") + (20).to_bytes(4, "little") + b"\x00" * 8
    assert not _looks_like_binary_stl(glb_stub)
    assert _guess_ext_from_content(glb_stub, fallback="glb") != "stl"
