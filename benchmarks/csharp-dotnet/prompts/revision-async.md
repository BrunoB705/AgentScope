Revisá este código C# y explicá qué está mal y cómo se corrige.

```csharp
public sealed class Buscador
{
    private readonly HttpClient _http = new();

    public string Descargar(string url)
    {
        var respuesta = _http.GetAsync(url).Result;
        respuesta.EnsureSuccessStatusCode();
        return respuesta.Content.ReadAsStringAsync().Result;
    }

    public async void AlTerminar(object? sender, EventArgs args)
    {
        var texto = await _http.GetStringAsync("https://example.com");
        Console.WriteLine(texto.Length);
    }
}
```

Respondé en español, en prosa. Nombra cada problema y la corrección concreta. No escribas un proyecto nuevo ni código completo: alcanza con los fragmentos que cambian.
