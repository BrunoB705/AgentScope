public static class VerdictPrompt
{
    public static string Build(BenchmarkRunEntity run, IReadOnlyList<BenchmarkResultEntity> results, string language)
    {
        var languageLine = language == "en"
            ? "Escribí la recomendación en inglés."
            : "Escribí la recomendación en español.";

        var lines = results
            .GroupBy(result => result.Model)
            .Select(group =>
            {
                var passed = group.Count(result => result.TestType == "code"
                    ? result.VerifyPassed == true
                    : result.JudgeScore is >= 3);
                var scores = group.Where(result => result.JudgeScore.HasValue).Select(result => result.JudgeScore!.Value).ToArray();
                var average = scores.Length > 0 ? scores.Average() : (double?)null;
                var quota = group.Where(result => result.QuotaCostEstimate.HasValue).Sum(result => result.QuotaCostEstimate!.Value);
                var errors = group.Count(result => result.Status is "failed" or "timedout" || result.MetricsError is not null);
                return $"- {group.Key}: {passed}/{group.Count()} aprobadas; nota media {(average is null ? "sin dato" : average.Value.ToString("0.0"))}; {group.Sum(result => result.DurationMs ?? 0)} ms; {group.Sum(result => result.InputTokens + result.OutputTokens)} tokens; cuota Go US$ {quota:0.000000}; errores {errors}.";
            });

        return BenchmarkPrompt.Prefix
            + "Sos el juez final de una comparación de modelos. Recibís sólo métricas agregadas, no las respuestas de los modelos.\n\n"
            + $"SUITE\n{run.Suite}\n\nRESULTADOS\n{string.Join('\n', lines)}\n\n"
            + "Recomendá el modelo que parece mejor para esta suite y justificá en 3 a 6 líneas. "
            + "Tené en cuenta aprobadas, nota del juez, duración, tokens y cuota Go. "
            + "Si no hay datos suficientes, decilo. No inventes métricas. "
            + $"Encerrá tu recomendación entre una línea que diga exactamente {VerdictText.Start} y otra que diga exactamente {VerdictText.End}. "
            + "No escribas nada fuera de esas dos líneas. No narres tu proceso ni menciones instrucciones, habilidades o herramientas. "
            + languageLine;
    }
}

public static class VerdictText
{
    public const string Start = "---RECOMENDACION---";
    public const string End = "---FIN---";

    /// <summary>
    /// Devuelve sólo el contenido entre los marcadores. El juez tiende a narrar
    /// qué instrucciones siguió antes de recomendar, y ese preámbulo no se guarda
    /// ni se muestra. Si faltan los marcadores, se conserva el texto completo para
    /// no perder la recomendación.
    /// </summary>
    public static string Extract(string text)
    {
        var trimmed = text.Trim();
        var start = trimmed.IndexOf(Start, StringComparison.Ordinal);
        if (start < 0) return trimmed;
        var end = trimmed.IndexOf(End, start + Start.Length, StringComparison.Ordinal);
        if (end < 0) return trimmed;
        var inner = trimmed[(start + Start.Length)..end].Trim();
        return inner.Length == 0 ? trimmed : inner;
    }
}
