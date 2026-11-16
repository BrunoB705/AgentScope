Este componente de React duplica un valor derivado en el estado y lo sincroniza con un efecto.

```tsx
import { useEffect, useState } from 'react';

type Props = { items: { id: string; qty: number }[] };

export function ResumenCarrito({ items }: Props) {
  const [total, setTotal] = useState(0);

  useEffect(() => {
    setTotal(items.reduce((suma, item) => suma + item.qty, 0));
  }, [items]);

  return <p>Unidades: {total}</p>;
}
```

Devolvé el componente corregido, sin estado duplicado y con tipos explícitos. Respondé con el código del componente y una explicación breve de por qué el cambio evita el problema.
