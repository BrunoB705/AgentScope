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
                errors.Add(new(id, ex.Message, ex.Code, ex.Parameters));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                errors.Add(new(
                    id,
                    $"Could not read the suite: {ex.Message}",
                    "suite_unreadable",
                    Params(("suite", id), ("detail", ex.Message))));
            }
        }
        return new(suites.ToArray(), errors.ToArray());
    }

    public BenchmarkSuite Load(string id) => Load(id, readPrompt: true);

    private BenchmarkSuite Load(string id, bool readPrompt)
    {
        if (string.IsNullOrWhiteSpace(id) || id.Length > 60 || !IdPattern.IsMatch(id))
            throw new BenchmarkValidationException(
                $"The suite '{id}' has an invalid id.", "suite_id_invalid", Params(("suite", id)));

        var directory = Path.Combine(_rootPath, id);
        var file = Path.Combine(directory, "suite.json");
        if (!Directory.Exists(directory) || !File.Exists(file))
            throw new BenchmarkValidationException(
                $"The suite '{id}' does not exist.", "suite_not_found", Params(("suite", id)));

        SuiteFile? parsed;
        try
        {
            parsed = JsonSerializer.Deserialize<SuiteFile>(File.ReadAllText(file), JsonOptions);
        }
        catch (JsonException ex)
        {
            throw new BenchmarkValidationException(
                $"Could not read suite.json of '{id}': {ex.Message}",
                "suite_unreadable",
                Params(("suite", id), ("detail", ex.Message)));
        }
        if (parsed is null)
            throw new BenchmarkValidationException(
                $"The suite '{id}' has no valid content.", "suite_invalid", Params(("suite", id)));

        var name = parsed.Name?.Trim();
        if (string.IsNullOrWhiteSpace(name))
            throw new BenchmarkValidationException(
                $"The suite '{id}' requires a name.", "suite_name_missing", Params(("suite", id)));
        if (name.Length > 120)
            throw new BenchmarkValidationException(
                $"The name of suite '{id}' exceeds 120 characters.", "suite_name_too_long", Params(("suite", id)));

        var modelTimeout = parsed.ModelTimeoutMs ?? DefaultModelTimeoutMs;
        if (modelTimeout < MinTimeoutMs || modelTimeout > MaxTimeoutMs)
            throw new BenchmarkValidationException(
                $"The timeout of suite '{id}' must be between 10 seconds and 30 minutes.",
                "suite_timeout_out_of_range",
                Params(("suite", id)));

        var tests = parsed.Tests ?? Array.Empty<SuiteTestFile>();
        if (tests.Length == 0)
            throw new BenchmarkValidationException(
                $"The suite '{id}' requires at least one test.", "suite_tests_missing", Params(("suite", id)));

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<BenchmarkTest>();
        foreach (var test in tests)
        {
            var testName = test.Name?.Trim();
            if (string.IsNullOrWhiteSpace(testName))
                throw new BenchmarkValidationException(
                    $"A test in suite '{id}' has no name.", "test_name_missing", Params(("suite", id)));
            if (testName.Length > 80)
                throw new BenchmarkValidationException(
                    $"The test '{testName}' exceeds 80 characters.", "test_name_too_long", Params(("test", testName)));
            if (!seen.Add(testName))
                throw new BenchmarkValidationException(
                    $"The test '{testName}' is duplicated in suite '{id}'.",
                    "test_duplicated",
                    Params(("suite", id), ("test", testName)));

            var type = test.Type?.Trim().ToLowerInvariant();
            if (type is not ("code" or "open"))
                throw new BenchmarkValidationException(
                    $"The test '{testName}' has an invalid type: '{test.Type}'.",
                    "test_type_invalid",
                    Params(("test", testName), ("type", test.Type ?? "")));

            if (string.IsNullOrWhiteSpace(test.PromptFile))
                throw new BenchmarkValidationException(
                    $"The test '{testName}' requires promptFile.", "test_prompt_missing", Params(("test", testName)));
            var promptPath = ResolveInside(directory, test.PromptFile, testName);
            if (!File.Exists(promptPath))
                throw new BenchmarkValidationException(
                    $"The test '{testName}' points to a prompt that does not exist.",
                    "test_prompt_not_found",
                    Params(("test", testName)));
            var prompt = readPrompt ? File.ReadAllText(promptPath) : "";

            if (type == "open")
            {
                if (test.Judge == true)
                    throw new BenchmarkValidationException(
                        $"The open test '{testName}' does not allow judge.",
                        "open_test_judge_forbidden",
                        Params(("test", testName)));
                var rubric = (test.Rubric ?? Array.Empty<string>())
                    .Select(value => value?.Trim())
                    .Where(value => !string.IsNullOrWhiteSpace(value))
                    .ToArray();
                if (rubric.Length == 0)
                    throw new BenchmarkValidationException(
                        $"The open test '{testName}' requires at least one rubric criterion.",
                        "open_test_rubric_missing",
                        Params(("test", testName)));
                result.Add(new(testName, "open", prompt, null, null, 0, rubric!, true));
                continue;
            }

            if (string.IsNullOrWhiteSpace(test.Fixture))
                throw new BenchmarkValidationException(
                    $"The code test '{testName}' requires fixture and verify.command.",
                    "code_test_verify_missing",
                    Params(("test", testName)));
            var fixturePath = ResolveInside(directory, test.Fixture, testName);
            if (!Directory.Exists(fixturePath))
                throw new BenchmarkValidationException(
                    $"The test '{testName}' points to a fixture that does not exist.",
                    "test_fixture_not_found",
                    Params(("test", testName)));
            if (string.IsNullOrWhiteSpace(test.Verify?.Command))
                throw new BenchmarkValidationException(
                    $"The code test '{testName}' requires fixture and verify.command.",
                    "code_test_verify_missing",
                    Params(("test", testName)));
            ValidateVerifyCommand(test.Verify!.Command, testName);
            var verifyTimeout = test.Verify!.TimeoutMs ?? DefaultVerifyTimeoutMs;
            if (verifyTimeout < MinTimeoutMs || verifyTimeout > MaxTimeoutMs)
                throw new BenchmarkValidationException(
                    $"The verify timeout of '{testName}' must be between 10 seconds and 30 minutes.",
                    "verify_timeout_out_of_range",
                    Params(("test", testName)));

            result.Add(new(testName, "code", prompt, fixturePath, test.Verify.Command, verifyTimeout, Array.Empty<string>(), test.Judge == true));
        }

        return new(id, name, parsed.Description, parsed.DefaultJudge, modelTimeout, result.ToArray());
    }

    private static void ValidateVerifyCommand(string command, string testName)
    {
        var offending = command.FirstOrDefault(character => ShellMetacharacters.Contains(character));
        if (offending != default)
            throw new BenchmarkValidationException(
                $"The verify command of '{testName}' contains the shell character '{offending}', which is not allowed because it runs inside a shell.",
                "verify_command_unsafe",
                Params(("test", testName), ("character", offending.ToString())));
    }

    private string ResolveInside(string directory, string relative, string testName)
    {
        var full = Path.GetFullPath(Path.Combine(directory, relative));
        var prefix = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new BenchmarkValidationException(
                $"The path '{relative}' of test '{testName}' leaves the suite directory.",
                "path_outside_suite",
                Params(("test", testName), ("path", relative)));
        return full;
    }

    private static IReadOnlyDictionary<string, string> Params(params (string Key, string Value)[] values) =>
        values.ToDictionary(value => value.Key, value => value.Value);

    private static BenchmarkSuiteSummary ToSummary(BenchmarkSuite suite) => new(
        suite.Id,
        suite.Name,
        suite.Description,
        suite.DefaultJudge,
        suite.ModelTimeoutMs,
        suite.Tests.Select(test => new BenchmarkTestSummary(test.Name, test.Type, test.Rubric, test.Judge)).ToArray());
}
