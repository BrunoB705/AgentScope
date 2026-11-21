using System.ComponentModel;
using System.Diagnostics;
using System.Text;

public sealed class ProcessRunner : IProcessRunner
{
    private static readonly HashSet<string> ScrubbedEnvironmentKeys = new(StringComparer.OrdinalIgnoreCase)
    {
        "TELEMETRY_API_KEY",
        "Telemetry__ApiKey",
        "ConnectionStrings__Telemetry",
        "OPENCODE_OBSERVABILITY_KEY",
        "OPENCODE_OBSERVABILITY_URL",
    };

    public async Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = request.FileName,
            WorkingDirectory = request.WorkingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        foreach (var existingKey in startInfo.Environment.Keys.Where(ScrubbedEnvironmentKeys.Contains).ToArray())
            startInfo.Environment.Remove(existingKey);
        foreach (var argument in request.Arguments) startInfo.ArgumentList.Add(argument);
        if (request.Environment is not null)
            foreach (var pair in request.Environment) startInfo.Environment[pair.Key] = pair.Value;

        using var process = new Process { StartInfo = startInfo };
        var stopwatch = Stopwatch.StartNew();
        if (!process.Start())
            throw new InvalidOperationException($"No se pudo iniciar {request.FileName}.");

        var standardOutput = process.StandardOutput.ReadToEndAsync();
        var standardError = process.StandardError.ReadToEndAsync();

        using var timeout = new CancellationTokenSource(request.TimeoutMs);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            await process.WaitForExitAsync(linked.Token);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            Kill(process);
            throw;
        }
        catch (OperationCanceledException)
        {
            Kill(process);
            return new ProcessResult(-1, await standardOutput, await standardError, true, stopwatch.ElapsedMilliseconds);
        }

        return new ProcessResult(process.ExitCode, await standardOutput, await standardError, false, stopwatch.ElapsedMilliseconds);
    }

    private static void Kill(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
            // El proceso ya terminó entre la comprobación y el kill.
        }
        catch (Win32Exception)
        {
            // El handle ya no está disponible; se intenta el respaldo.
        }

        try
        {
            process.WaitForExit(5000);
        }
        catch (InvalidOperationException)
        {
            // Sin proceso que esperar.
        }
        catch (Win32Exception)
        {
            // Sin handle para esperar.
        }

        try
        {
            if (process.HasExited) return;
        }
        catch (InvalidOperationException)
        {
            return;
        }
        catch (Win32Exception)
        {
            return;
        }

        TryTaskkill(process);
    }

    private static void TryTaskkill(Process process)
    {
        try
        {
            var startInfo = new ProcessStartInfo("taskkill")
            {
                CreateNoWindow = true,
                UseShellExecute = false,
            };
            foreach (var argument in new[] { "/PID", process.Id.ToString(), "/T", "/F" })
                startInfo.ArgumentList.Add(argument);
            using var killer = Process.Start(startInfo);
            killer?.WaitForExit(5000);
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            // Si taskkill no está disponible, no hay más que hacer.
        }
    }
}
