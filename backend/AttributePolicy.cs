using System.Globalization;
using System.Text;

/// <summary>
/// Filtra los atributos libres de la telemetría. Una clave se descarta cuando alguno de sus
/// tokens (separados por puntuación, camelCase o cambios letra/dígito) coincide exactamente con
/// un término sensible; así "filePath" o "api_key" se bloquean, pero "profile" o "compassion" no.
/// Se conservan como máximo <see cref="MaxAttributes"/> claves y el recorte queda registrado.
/// </summary>
public static class AttributePolicy
{
    public const int MaxAttributes = 32;
    public const int MaxKeyLength = 100;
    public const int MaxValueLength = 500;
    public const string TruncatedKey = "attributes_truncated";
    public const string DroppedKey = "attributes_dropped";

    public static readonly IReadOnlySet<string> BlockedTokens = new HashSet<string>(StringComparer.Ordinal)
    {
        "prompt", "prompts", "response", "responses", "content", "contents",
        "output", "outputs", "stdout", "stderr",
        "argument", "arguments", "arg", "args", "command", "commands", "cmd",
        "file", "files", "filename", "filepath", "path", "paths", "dir", "directory", "cwd",
        "body", "secret", "secrets", "token", "apikey", "key",
        "password", "passwd", "credential", "credentials", "authorization", "cookie",
    };

    public static bool IsBlockedKey(string key) => Tokenize(key).Any(BlockedTokens.Contains);

    public static IReadOnlyList<string> Tokenize(string key)
    {
        var tokens = new List<string>();
        var current = new StringBuilder();
        void Flush() { if (current.Length > 0) { tokens.Add(current.ToString().ToLowerInvariant()); current.Clear(); } }
        for (var i = 0; i < key.Length; i++)
        {
            var c = key[i];
            if (!char.IsLetterOrDigit(c)) { Flush(); continue; }
            if (current.Length > 0)
            {
                var previous = key[i - 1];
                var lowerToUpper = char.IsUpper(c) && (char.IsLower(previous) || char.IsDigit(previous));
                var acronymEnd = char.IsUpper(c) && char.IsUpper(previous) && i + 1 < key.Length && char.IsLower(key[i + 1]);
                var letterDigit = char.IsDigit(c) != char.IsDigit(previous);
                if (lowerToUpper || acronymEnd || letterDigit) Flush();
            }
            current.Append(c);
        }
        Flush();
        return tokens;
    }

    public static Dictionary<string, string> Sanitize(IReadOnlyDictionary<string, string>? input)
    {
        var result = new Dictionary<string, string>();
        if (input is null) return result;
        var truncated = input.TryGetValue(TruncatedKey, out var previousFlag) && previousFlag == "true";
        var dropped = input.TryGetValue(DroppedKey, out var previousDropped) && int.TryParse(previousDropped, NumberStyles.None, CultureInfo.InvariantCulture, out var parsed) ? parsed : 0;
        foreach (var (rawKey, rawValue) in input)
        {
            if (rawKey is TruncatedKey or DroppedKey || string.IsNullOrWhiteSpace(rawKey) || IsBlockedKey(rawKey)) continue;
            var key = rawKey[..Math.Min(rawKey.Length, MaxKeyLength)];
            if (result.ContainsKey(key)) continue;
            if (result.Count >= MaxAttributes) { truncated = true; dropped++; continue; }
            result[key] = string.IsNullOrWhiteSpace(rawValue) ? "" : rawValue[..Math.Min(rawValue.Length, MaxValueLength)];
        }
        if (truncated)
        {
            result[TruncatedKey] = "true";
            result[DroppedKey] = dropped.ToString(CultureInfo.InvariantCulture);
        }
        return result;
    }
}
