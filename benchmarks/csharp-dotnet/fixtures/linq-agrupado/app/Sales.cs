namespace App;

public sealed record Sale(string Category, decimal Amount);

public static class Sales
{
    public static string? TopCategory(IEnumerable<Sale> sales)
        => sales.GroupBy(sale => sale.Category)
                .OrderByDescending(group => group.Sum(sale => sale.Amount))
                .First()
                .Key;
}
