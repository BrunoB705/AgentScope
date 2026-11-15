using App;

var failures = new List<string>();

void Cumple(string nombre, bool condicion)
{
    if (!condicion) failures.Add(nombre);
}

Cumple("sin ventas no hay categoria", Sales.TopCategory(Array.Empty<Sale>()) is null);
Cumple("una sola categoria", Sales.TopCategory(new[] { new Sale("gama", 3m) }) == "gama");
Cumple("empate gana la alfabeticamente menor", Sales.TopCategory(new[] { new Sale("beta", 10m), new Sale("alfa", 10m) }) == "alfa");
Cumple("gana la de mayor total", Sales.TopCategory(new[] { new Sale("beta", 5m), new Sale("alfa", 10m) }) == "alfa");

if (failures.Count > 0)
{
    foreach (var failure in failures) Console.Error.WriteLine($"FALLO: {failure}");
    return 1;
}

Console.WriteLine("ok");
return 0;
