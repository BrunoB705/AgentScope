from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_item_existente_devuelve_200():
    respuesta = client.get("/items/abc")

    assert respuesta.status_code == 200
    assert respuesta.json()["name"] == "Item A"


def test_item_inexistente_devuelve_404():
    respuesta = client.get("/items/zzz")

    assert respuesta.status_code == 404
    assert "detail" in respuesta.json()
