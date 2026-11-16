using App;

var failures = new List<string>();

void Cumple(string nombre, bool condicion)
{
    if (!condicion) failures.Add(nombre);
}

Cumple("sin cliente no hay descuento", Pricing.ApplyDiscount(null, 100m) == 100m);
Cumple("descuento del 10 por ciento", Pricing.ApplyDiscount(new Customer("Ana", 0.10m), 100m) == 90m);
Cumple("importe cero no descuenta nada", Pricing.ApplyDiscount(new Customer("Ana", 0.10m), 0m) == 0m);

if (failures.Count > 0)
{
    foreach (var failure in failures) Console.Error.WriteLine($"FALLO: {failure}");
    return 1;
}

Console.WriteLine("ok");
return 0;
