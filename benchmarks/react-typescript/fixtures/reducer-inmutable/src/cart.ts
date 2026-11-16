export type Item = { id: string; qty: number };
export type Cart = { items: Item[] };

export function addItem(cart: Cart, id: string): Cart {
  const found = cart.items.find((item) => item.id === id);
  if (found) {
    found.qty += 1;
    return cart;
  }
  cart.items.push({ id, qty: 1 });
  return cart;
}
