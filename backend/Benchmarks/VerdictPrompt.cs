public static class VerdictPrompt
{
    public static string Build(BenchmarkRunEntity run, IReadOnlyList<BenchmarkResultEntity> results)
    {
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
            + "Si no hay datos suficientes, decilo. No inventes métricas.";
    }
}
