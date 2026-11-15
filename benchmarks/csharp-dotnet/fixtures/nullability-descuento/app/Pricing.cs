namespace App;

public sealed record Customer(string Name, decimal DiscountRate);

public static class Pricing
{
    public static decimal ApplyDiscount(Customer? customer, decimal amount)
        => amount - amount * customer.DiscountRate;
}
