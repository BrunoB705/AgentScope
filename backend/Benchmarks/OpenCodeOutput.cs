using System.Text.Json;

public static class OpenCodeOutput
{
    public static string? ExtractFinalText(string stdout)
    {
        string? text = null;
        foreach (var element in Objects(stdout))
        {
            if (element.TryGetProperty("part", out var part) && part.ValueKind == JsonValueKind.Object
                && part.TryGetProperty("type", out var partType) && partType.GetString() == "text"
                && part.TryGetProperty("text", out var partText))
            {
                text = partText.GetString();
            }
            else if (element.TryGetProperty("text", out var direct) && direct.ValueKind == JsonValueKind.String)
            {
                text = direct.GetString();
            }
        }
        return text;
    }

    public static string? ExtractSessionId(string stdout)
    {
        string? id = null;
        foreach (var element in Objects(stdout))
        {
            if (element.TryGetProperty("sessionID", out var value) && value.ValueKind == JsonValueKind.String)
                id = value.GetString();
            else if (element.TryGetProperty("sessionId", out var camel) && camel.ValueKind == JsonValueKind.String)
                id = camel.GetString();
        }
        return id;
    }

    private static IEnumerable<JsonElement> Objects(string stdout)
    {
        var trimmed = stdout.Trim();
        if (trimmed.Length == 0) yield break;

        if (trimmed.StartsWith('{') && TryParse(trimmed, out var single))
        {
            yield return single;
            yield break;
        }

        foreach (var line in trimmed.Split('\n'))
        {
            var candidate = line.Trim();
            if (candidate.Length == 0) continue;
            if (TryParse(candidate, out var element)) yield return element;
        }
    }

    private static bool TryParse(string value, out JsonElement element)
    {
        try
        {
            using var document = JsonDocument.Parse(value);
            element = document.RootElement.Clone();
            return element.ValueKind == JsonValueKind.Object;
        }
        catch (JsonException)
        {
            element = default;
            return false;
        }
    }
}
