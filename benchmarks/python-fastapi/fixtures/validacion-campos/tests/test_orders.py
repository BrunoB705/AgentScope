from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_pedido_valido_devuelve_201():
    respuesta = client.post("/orders", json={"sku": "abc", "quantity": 2, "price": 9.5})

    assert respuesta.status_code == 201
    assert respuesta.json()["sku"] == "abc"


def test_cantidad_cero_es_invalida():
    respuesta = client.post("/orders", json={"sku": "abc", "quantity": 0, "price": 9.5})

    assert respuesta.status_code == 422


def test_precio_negativo_es_invalido():
    respuesta = client.post("/orders", json={"sku": "abc", "quantity": 2, "price": -1})

    assert respuesta.status_code == 422


def test_sku_vacio_es_invalido():
    respuesta = client.post("/orders", json={"sku": "", "quantity": 2, "price": 9.5})

    assert respuesta.status_code == 422
