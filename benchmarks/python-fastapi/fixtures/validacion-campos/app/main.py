from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class OrderIn(BaseModel):
    sku: str
    quantity: int
    price: float


@app.post("/orders", status_code=201)
def create_order(order: OrderIn):
    return {"sku": order.sku, "quantity": order.quantity, "price": order.price}
