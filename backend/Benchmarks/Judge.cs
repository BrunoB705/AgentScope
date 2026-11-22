using System.Text.Json;

public static class JudgePrompt
{
    public static string Build(string testPrompt, string[] rubric, string artifact, string language)
    {
        var criteria = rubric.Select((criterion, index) => $"{index + 1}. {criterion}");
        var languageLine = language == "en"
            ? "Escribí la justificación en inglés."
            : "Escribí la justificación en español.";
        return "ENUNCIADO\n" + testPrompt
            + "\n\nRÚBRICA\n" + string.Join('\n', criteria)
            + "\n\nARTEFACTO\n" + artifact
            + "\n\nRespondé sólo con un objeto JSON con la forma {\"score\": <entero de 1 a 5>, \"rationale\": \"<justificación breve>\"}."
            + "\nNo agregues texto fuera del JSON."
            + "\n" + languageLine;
    }
}

public sealed record JudgeScore(int Score, string Rationale);

public static class JudgeResponse
{
    public static JudgeScore? Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        try
        {
            using var document = JsonDocument.Parse(text);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("score", out var scoreElement) || !scoreElement.TryGetInt32(out var score)) return null;
            if (score < 1 || score > 5) return null;
            if (!root.TryGetProperty("rationale", out var rationaleElement) || rationaleElement.ValueKind != JsonValueKind.String) return null;
            var rationale = rationaleElement.GetString()?.Trim();
            if (string.IsNullOrWhiteSpace(rationale)) return null;
            return new(score, rationale);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
