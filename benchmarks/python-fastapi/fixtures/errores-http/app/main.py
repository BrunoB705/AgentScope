from fastapi import FastAPI

app = FastAPI()

ITEMS = {"abc": {"id": "abc", "name": "Item A"}}


@app.get("/items/{item_id}")
def get_item(item_id: str):
    return ITEMS.get(item_id)
