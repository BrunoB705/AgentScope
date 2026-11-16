Diseñá el endpoint `GET /items` de esta aplicación de FastAPI, que hoy no existe.

Requisitos:

- Acepta `page` y `pageSize` por query string, con valores por defecto y límites explícitos.
- Devuelve la página pedida junto con el total de ítems, para que el cliente pueda paginar.
- Si `page` queda fuera del rango disponible, responde una lista vacía y no un error.

Respondé con el código del endpoint y, en dos o tres líneas, por qué elegiste esos límites y ese contrato de respuesta. No escribas tests.
