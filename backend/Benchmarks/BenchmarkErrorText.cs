using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

/// <summary>
/// Las columnas de error de benchmark son TEXT y guardan el código junto con sus
/// parámetros, no la prosa: así el texto persistido no queda atado a un idioma y
/// la API puede traducirlo al leer. Las filas históricas conservan la prosa vieja
/// y se devuelven tal cual, sin código.
/// </summary>
internal static class BenchmarkErrorText
{
    private static readonly Regex Placeholder = new("\\{([a-z]+)\\}", RegexOptions.Compiled);

    /// <summary>Código estable -> plantilla en inglés con placeholders `{test}` y `{detail}`.</summary>
    private static readonly Dictionary<string, string> Templates = new(StringComparer.Ordinal)
    {
        ["state_changed"] = "The run changed state while it was executing.",
        ["baseline_verify_failed"] = "Could not run the baseline verify: {detail}",
        ["baseline_verify_timeout"] = "The baseline verify of '{test}' timed out.",
        ["baseline_setup_failed"] = "Could not prepare the baseline: {detail}",
        ["test_missing"] = "The test no longer exists in the suite.",
        ["git_init_failed"] = "Could not initialize git in the fixture.",
        ["model_timeout"] = "The model timed out.",
        ["verify_timeout"] = "The verify step timed out.",
        ["judge_timeout"] = "The judge timed out.",
        ["judge_invalid_json"] = "The judge did not return valid JSON.",
        ["metrics_missing"] = "Session telemetry did not arrive.",
        ["verdict_timeout"] = "The final recommendation timed out.",
    };

    public static string Encode(string code, IReadOnlyDictionary<string, string>? parameters = null) =>
        JsonSerializer.Serialize(new ErrorPayload(
            code,
            parameters is { Count: > 0 } ? parameters : null,
            null));

    /// <summary>
    /// Variante para códigos sin plantilla: guarda además el mensaje humano como fallback,
    /// así un código todavía no traducido no se filtra a la API en snake_case.
    /// </summary>
    public static string Encode(
        string code,
        IReadOnlyDictionary<string, string>? parameters,
        string fallbackMessage) =>
        JsonSerializer.Serialize(new ErrorPayload(
            code,
            parameters is { Count: > 0 } ? parameters : null,
            string.IsNullOrWhiteSpace(fallbackMessage) ? null : fallbackMessage));

    public static (string Error, string? Code, IReadOnlyDictionary<string, string>? Parameters) Read(string? stored)
    {
        if (string.IsNullOrWhiteSpace(stored)) return (stored ?? "", null, null);

        string? code;
        string? message = null;
        IReadOnlyDictionary<string, string>? parameters = null;
        try
        {
            using var document = JsonDocument.Parse(stored);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return (stored, null, null);
            if (!root.TryGetProperty("code", out var codeElement) || codeElement.ValueKind != JsonValueKind.String)
                return (stored, null, null);
            code = codeElement.GetString();
            if (string.IsNullOrEmpty(code)) return (stored, null, null);

            if (root.TryGetProperty("message", out var messageElement) && messageElement.ValueKind == JsonValueKind.String)
            {
                var storedMessage = messageElement.GetString();
                if (!string.IsNullOrWhiteSpace(storedMessage)) message = storedMessage;
            }

            if (root.TryGetProperty("params", out var paramsElement) && paramsElement.ValueKind == JsonValueKind.Object)
            {
                var values = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var property in paramsElement.EnumerateObject())
                    if (property.Value.ValueKind == JsonValueKind.String)
                        values[property.Name] = property.Value.GetString()!;
                if (values.Count > 0) parameters = values;
            }
        }
        catch (JsonException)
        {
            return (stored, null, null);
        }

        if (Templates.TryGetValue(code, out var template))
            return (Render(template, parameters), code, parameters);
        return (message ?? code, code, parameters);
    }

    private static string Render(string template, IReadOnlyDictionary<string, string>? parameters) =>
        Placeholder.Replace(template, match =>
            parameters is not null && parameters.TryGetValue(match.Groups[1].Value, out var value)
                ? value
                : "");

    private sealed record ErrorPayload(
        [property: JsonPropertyName("code")] string Code,
        [property: JsonPropertyName("params")]
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        IReadOnlyDictionary<string, string>? Parameters,
        [property: JsonPropertyName("message")]
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        string? Message);
}
