from main import build_bambu_connect_link


def test_build_bambu_connect_link_simple():
    url = "https://example.com/path/model.3mf?token=abc"
    link = build_bambu_connect_link(url)
    assert link.startswith("bambu-connect://import-file?file=")
    # The encoded payload should contain the original URL percent-encoded
    assert "%3A%2F%2F" in link
    # Ensure raw HTTP scheme is not present in the encoded payload
    assert "https://" not in link


def test_build_bambu_connect_link_preserves_uniqueness():
    url1 = "https://host/a.3mf"
    url2 = "https://host/b.3mf"
    assert build_bambu_connect_link(url1) != build_bambu_connect_link(url2)
