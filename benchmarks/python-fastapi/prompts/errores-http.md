En esta aplicación de FastAPI, `GET /items/{item_id}` devuelve un ítem del catálogo.

Corregila para que, cuando el ítem no exista, responda 404 con la clave `detail` en el cuerpo. Un ítem existente tiene que seguir devolviendo 200 con sus datos.

No modifiques nada dentro de `tests/`.

Cuando termines, respondé con un resumen breve del cambio.
