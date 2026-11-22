using System.Text.Json;
using System.Text.RegularExpressions;

public sealed class BenchmarkCatalog
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
    private static readonly Regex IdPattern = new("^[a-z0-9][a-z0-9-]*$", RegexOptions.Compiled);
    private const int MinTimeoutMs = 10_000;
    private const int MaxTimeoutMs = 1_800_000;
    private const int DefaultModelTimeoutMs = 300_000;
    private const int DefaultVerifyTimeoutMs = 120_000;

    /// <summary>
    /// `verify.command` se ejecuta a través de `cmd.exe /c` o `/bin/sh -c`, así que
    /// cualquier metacaracter permitiría encadenar comandos arbitrarios. Las suites
    /// son archivos locales, pero la frontera de confianza tiene que estar en el
    /// código y no sólo en la convención del repo.
    /// </summary>
    private static readonly char[] ShellMetacharacters = { '&', '|', ';', '>', '<', '`', '$', '(', ')', '^', '%', '!', '\n', '\r' };

    private readonly string _rootPath;

    public BenchmarkCatalog(string rootPath) => _rootPath = Path.GetFullPath(rootPath);

    public BenchmarkCatalogList List()
    {
        if (!Directory.Exists(_rootPath))
            return new(Array.Empty<BenchmarkSuiteSummary>(), Array.Empty<BenchmarkCatalogError>());

        var suites = new List<BenchmarkSuiteSummary>();
        var errors = new List<BenchmarkCatalogError>();
        foreach (var directory in Directory.EnumerateDirectories(_rootPath).OrderBy(Path.GetFileName, StringComparer.Ordinal))
        {
            var id = Path.GetFileName(directory);
            if (!File.Exists(Path.Combine(directory, "suite.json"))) continue;
            try
            {
                suites.Add(ToSummary(Load(id, readPrompt: false)));
            }
            catch (BenchmarkValidationException ex)
            {
                errors.Add(new(id, ex.Message));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                errors.Add(new(id, $"No se pudo leer la suite: {ex.Message}"));
            }
        }
        return new(suites.ToArray(), errors.ToArray());
    }

    public BenchmarkSuite Load(string id) => Load(id, readPrompt: true);

    private BenchmarkSuite Load(string id, bool readPrompt)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 60 || !IdPattern.IsMatch(id))
            throw new BenchmarkValidationException($"La suite '{id}' tiene un id inválido.");

        var directory = Path.Combine(_rootPath, id);
        var file = Path.Combine(directory, "suite.json");
        if (!Directory.Exists(directory) || !File.Exists(file))
            throw new BenchmarkValidationException($"The suite '{id}' does not exist.");

        SuiteFile? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<SuiteFile>(File.ReadAllText(file), JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new BenchmarkValidationException($"No se pudo leer suite.json de '{id}': {ex.Message}");
        }
        if (parsed is null)
            throw new BenchmarkValidationException($"La suite '{id}' no tiene contenido válido.");

        var name = parsed.Name?.Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new BenchmarkValidationException($"La suite '{id}' requiere un name.");
        if (name.Length > 120)
            throw new BenchmarkValidationException($"El name de la suite '{id}' supera los 120 caracteres.");

        var modelTimeout = parsed.ModelTimeoutMs ?? DefaultModelTimeoutMs;
        if (modelTimeout < MinTimeoutMs || modelTimeout > MaxTimeoutMs)
            throw new BenchmarkValidationException($"El timeout de la suite '{id}' debe estar entre 10 segundos y 30 minutos.");

        var tests = parsed.Tests ?? Array.Empty<SuiteTestFile>();
        if (tests.Length == 0)
            throw new BenchmarkValidationException($"La suite '{id}' requiere al menos una prueba.");

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<BenchmarkTest>();
        foreach (var test in tests)
        {
            var testName = test.Name?.Trim();
            if (string.IsNullOrWhiteSpace(testName))
                throw new BenchmarkValidationException($"Una prueba de la suite '{id}' no tiene name.");
            if (testName.Length > 80)
                throw new BenchmarkValidationException($"La prueba '{testName}' supera los 80 caracteres.");
            if (!seen.Add(testName))
                throw new BenchmarkValidationException($"La prueba '{testName}' está duplicada en la suite '{id}'.");

            var type = test.Type?.Trim().ToLowerInvariant();
            if (type is not ("code" or "open"))
                throw new BenchmarkValidationException($"La prueba '{testName}' tiene un tipo inválido: '{test.Type}'.");

            if (string.IsNullOrWhiteSpace(test.PromptFile))
                throw new BenchmarkValidationException($"La prueba '{testName}' requiere promptFile.");
            var promptPath = ResolveInside(directory, test.PromptFile, testName);
            if (!File.Exists(promptPath))
                throw new BenchmarkValidationException($"La prueba '{testName}' apunta a un prompt que no existe.");
            var prompt = readPrompt ? File.ReadAllText(promptPath) : "";

            if (type == "open")
            {
                if (test.Judge == true)
                    throw new BenchmarkValidationException($"La prueba '{testName}' de tipo open no admite judge.");
                var rubric = (test.Rubric ?? Array.Empty<string>())
                    .Select(value => value?.Trim())
                    .Where(value => !string.IsNullOrWhiteSpace(value))
                    .ToArray();
                if (rubric.Length == 0)
                    throw new BenchmarkValidationException($"La prueba '{testName}' de tipo open requiere al menos un criterio en rubric.");
                result.Add(new(testName, "open", prompt, null, null, 0, rubric!, true));
                continue;
            }

            if (string.IsNullOrWhiteSpace(test.Fixture))
                throw new BenchmarkValidationException($"La prueba '{testName}' de tipo code requiere fixture y verify.command.");
            var fixturePath = ResolveInside(directory, test.Fixture, testName);
            if (!Directory.Exists(fixturePath))
                throw new BenchmarkValidationException($"La prueba '{testName}' apunta a un fixture que no existe.");
            if (string.IsNullOrWhiteSpace(test.Verify?.Command))
                throw new BenchmarkValidationException($"La prueba '{testName}' de tipo code requiere fixture y verify.command.");
            ValidateVerifyCommand(test.Verify!.Command, testName);
            var verifyTimeout = test.Verify!.TimeoutMs ?? DefaultVerifyTimeoutMs;
            if (verifyTimeout < MinTimeoutMs || verifyTimeout > MaxTimeoutMs)
                throw new BenchmarkValidationException($"El timeout de verify de '{testName}' debe estar entre 10 segundos y 30 minutos.");

            result.Add(new(testName, "code", prompt, fixturePath, test.Verify.Command, verifyTimeout, Array.Empty<string>(), test.Judge == true));
        }

        return new(id, name, parsed.Description, parsed.DefaultJudge, modelTimeout, result.ToArray());
    }

    private static void ValidateVerifyCommand(string command, string testName)
    {
        var offending = command.FirstOrDefault(character => ShellMetacharacters.Contains(character));
        if (offending != default)
            throw new BenchmarkValidationException(
                $"El comando verify de '{testName}' contiene el carácter de shell '{offending}'; no está permitido porque se ejecuta dentro de un shell.");
    }

    private string ResolveInside(string directory, string relative, string testName)
    {
        var full = Path.GetFullPath(Path.Combine(directory, relative));
        var prefix = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new BenchmarkValidationException($"La ruta '{relative}' de la prueba '{testName}' sale del directorio de la suite.");
        return full;
    }

    private static BenchmarkSuiteSummary ToSummary(BenchmarkSuite suite) => new(
        suite.Id,
        suite.Name,
        suite.Description,
        suite.DefaultJudge,
        suite.ModelTimeoutMs,
        suite.Tests.Select(test => new BenchmarkTestSummary(test.Name, test.Type, test.Rubric, test.Judge)).ToArray());
}
