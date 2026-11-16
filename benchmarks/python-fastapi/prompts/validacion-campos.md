En esta aplicación de FastAPI, `POST /orders` crea un pedido a partir del modelo `OrderIn`.

Corregila para que rechace los pedidos inválidos con un 422, aplicando estas restricciones:

- `quantity` tiene que ser mayor o igual a 1.
- `price` tiene que ser mayor que 0.
- `sku` no puede estar vacío.

Un pedido válido tiene que seguir devolviendo 201.

No modifiques nada dentro de `tests/`.

Cuando termines, respondé con un resumen breve del cambio.
