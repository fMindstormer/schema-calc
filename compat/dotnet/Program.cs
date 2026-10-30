// Runs one .NET validator over a corpus with its default options and prints the
// shared result format (see compat/README.md). Usage: compat <validator> <corpus.json> [first group]
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Json.Schema;

if (args.Length < 2 || args[0] != "JsonSchema.Net")
{
    Console.Error.WriteLine("usage: compat JsonSchema.Net <corpus.json> [first group]");
    return 2;
}
// The harness reads the corpus without a depth limit; the validator parses each schema
// and record itself, with its own defaults.
var unlimited = new JsonDocumentOptions { MaxDepth = 4096 };
var corpus = JsonNode.Parse(File.ReadAllText(args[1]), null, unlimited)!.AsArray();
var first = args.Length > 2 ? int.Parse(args[2]) : 0;
var assembly = typeof(JsonSchema).Assembly;
var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+')[0];
Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object?>
{
    ["validator"] = "JsonSchema.Net", ["version"] = version, ["language"] = "C#",
    ["runtime"] = $".NET {Environment.Version}",
}));
for (var index = first; index < corpus.Count; index++)
{
    var group = corpus[index]!;
    var cases = group["cases"]!.AsArray();
    int falseAccepts = 0, falseRejects = 0, caseErrors = 0;
    string? error = null, caseError = null;
    double? loadSeconds = null;
    var timer = Stopwatch.StartNew();
    try
    {
        var schema = JsonSchema.FromText(group["schema"]!.ToJsonString(), new BuildOptions { SchemaRegistry = new SchemaRegistry() });
        loadSeconds = timer.Elapsed.TotalSeconds;
        Heartbeat(index, 0);
        for (var done = 0; done < cases.Count; done++)
        {
            var item = cases[done];
            if (done > 0 && done % 100 == 0) Heartbeat(index, done);
            var expected = item!["expected"]!.GetValue<bool>();
            bool actual;
            try { actual = schema.Evaluate(JsonDocument.Parse(item["data"]?.ToJsonString() ?? "null").RootElement).IsValid; }
            catch (Exception e) { caseErrors++; caseError ??= Truncate(e.Message); continue; }
            if (actual && !expected) falseAccepts++;
            if (!actual && expected) falseRejects++;
        }
    }
    catch (Exception e) { error = Truncate(e.Message); }
    Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, object?>
    {
        ["index"] = index, ["name"] = group["name"]!.GetValue<string>(), ["cases"] = cases.Count,
        ["falseAccepts"] = falseAccepts, ["falseRejects"] = falseRejects, ["caseErrors"] = caseErrors, ["caseError"] = caseError,
        ["error"] = error, ["loadSeconds"] = loadSeconds, ["seconds"] = timer.Elapsed.TotalSeconds,
    }));
}
return 0;

static void Heartbeat(int index, int done) =>
    Console.WriteLine(JsonSerializer.Serialize(new Dictionary<string, int> { ["heartbeat"] = index, ["done"] = done }));

static string Truncate(string message) => message.Length > 300 ? message[..300] : message;
